import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  articleGroups,
  articleSuppliers,
  articleUnits,
  articles,
  bomComponents,
  carriers,
  customerContacts,
  customerDeliveryAddresses,
  customerPrices,
  customers,
  deliveryTerms,
  paymentTerms,
  priceLists,
  productionGroups,
  routingOperations,
  supplierContacts,
  supplierDeliveryAddresses,
  suppliers,
  units,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import { getOrCreateFallbackLocation } from "../../stock/service/location-resolver.js";
import { recordStandardCostHistory } from "../../article/repository/article.repository.js";
import type { ArticleImportPlan, ExistingArticle } from "../service/articles.js";
import {
  assignRegisterCodes,
  generatePaymentTermCode,
  slugifyRegisterCode,
  type CustomerCreatePlan,
  type CustomerImportPlan,
} from "../service/customers.js";
import type { SupplierCreatePlan, SupplierImportPlan } from "../service/suppliers.js";
import type { BomImportPlan } from "../service/bom.js";
import type { BomEdge } from "../service/bom-cycle.js";
import type { RoutingImportPlan } from "../service/routing.js";
import type {
  CustomerContactImportPlan,
  ExistingCustomerContact,
} from "../service/customer-contacts.js";
import type {
  CustomerDeliveryAddressImportPlan,
  ExistingCustomerAddress,
  ExistingDeliveryAddress,
} from "../service/customer-delivery-addresses.js";
import type { ExistingSupplierContact, SupplierContactImportPlan } from "../service/supplier-contacts.js";
import type {
  ExistingSupplierAddress,
  ExistingSupplierDeliveryAddress,
  SupplierDeliveryAddressImportPlan,
} from "../service/supplier-delivery-addresses.js";
import { ImportRegisterConflictError } from "../service/import.service.js";
import type { ExistingWorkCenter, WorkCenterCreatePlan, WorkCenterImportPlan } from "../service/work-centers.js";
import type { LegoWorkCenterCreatePlan, LegoWorkCenterImportPlan } from "../service/lego-work-centers.js";
import type { ProductionGroupImportPlan } from "../service/production-groups.js";
import type { ArticleUnitImportPlan } from "../service/article-units.js";
import type { SupplierPriceImportPlan } from "../service/supplier-prices.js";
import type { CustomerPriceImportPlan } from "../service/customer-prices.js";
import { replacePriceBreaks } from "../../purchase/repository/price-breaks.js";

// Multi-row statements are chunked so a 10 000-row file never produces one
// statement with tens of thousands of bind parameters.
const CHUNK_SIZE = 500;

// The register step inserts { code, name: code } with onConflictDoNothing, so a
// pre-existing row with the SAME NAME under a different code silently swallows
// the insert and leaves the lookup empty. Without this the non-null assertion
// would blow up as a NOT NULL violation with no hint of the cause.
function resolveNewUnitId(unitIds: Map<string, string>, code: string): string {
  const id = unitIds.get(code.toLowerCase());
  if (id === undefined) {
    throw new ImportRegisterConflictError(
      `Enheten ${code} kunde inte skapas — det finns redan en enhet med benämningen ${code} under en annan kod`
    );
  }
  return id;
}

function chunk<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

// --- Customer import: the four register lookups (paymentTerm/deliveryTerm/
// carrier/priceList) ---

// The four registers share the exact same column shape (code/name/
// description), same as register.repository.ts's forTable — the cast at
// each call site is safe for the same reason.
type NamedRegisterTable = typeof deliveryTerms;

// Creates whatever names planCustomerImport's willCreate.<register> list
// still needs (case-insensitive misses against the register at plan time),
// inside the SAME transaction as the customer writes, and returns
// lowercased-name/lowercased-code -> id covering both the pre-existing and
// the newly-created rows. `created` is the names ACTUALLY inserted (may be
// fewer than `names` if a concurrent import raced this one to the same
// name — onConflictDoNothing is the race guard, same as executeArticlePlan's
// unit/group step).
//
// Codes are DERIVED from the name (codeFor), not the name itself (unlike
// units/articleGroups' code = name), so a generated code can collide with a
// pre-existing one — assignRegisterCodes resolves that with a numeric
// suffix before the insert ever runs.
async function resolveOrCreateRegister(
  tx: Tx,
  table: NamedRegisterTable,
  names: string[],
  codeFor: (name: string) => string,
  label: string
): Promise<{ idByKey: Map<string, string>; created: string[] }> {
  const created: string[] = [];
  if (names.length > 0) {
    const existingRows = await tx.select({ code: table.code }).from(table);
    const existingCodes = new Set(existingRows.map((row) => row.code.toUpperCase()));
    const codeByName = assignRegisterCodes(names, codeFor, existingCodes);
    for (const part of chunk(names)) {
      const rows = await tx
        .insert(table)
        .values(part.map((name) => ({ code: codeByName.get(name)!, name })))
        .onConflictDoNothing()
        .returning({ name: table.name });
      created.push(...rows.map((row) => row.name));
    }
  }
  const allRows = await tx.select({ id: table.id, code: table.code, name: table.name }).from(table);
  const idByKey = new Map<string, string>();
  for (const row of allRows) {
    idByKey.set(row.code.toLowerCase(), row.id);
    idByKey.set(row.name.toLowerCase(), row.id);
  }
  // Same "swallowed by a same-name-different-code conflict" guard as
  // resolveNewUnitId — every requested name must resolve after the insert.
  for (const name of names) {
    if (!idByKey.has(name.toLowerCase())) {
      throw new ImportRegisterConflictError(
        `${label} "${name}" kunde inte skapas — det finns redan en post med samma namn under en annan kod`
      );
    }
  }
  return { idByKey, created };
}

// A plan row carries EITHER the resolved id (register hit at plan time) OR
// the raw name (register miss — queued in willCreate); this looks the name
// up in the map the register step just built.
function resolveRegisterId(
  id: string | undefined,
  name: string | undefined,
  idByKey: Map<string, string>
): string | undefined {
  if (id !== undefined) return id;
  if (name !== undefined) return idByKey.get(name.toLowerCase());
  return undefined;
}

// customers columns the create/patch values below pass straight through —
// every CustomerCreatePlan field except customerNumber (always present,
// handled separately) and the register id/name pairs/discountPercent
// (resolved/stringified separately below). "name" IS in this list even
// though buildCustomerInsertValues also seeds it up front — a create row
// always carries a non-empty name (planCustomerImport enforces that), so the
// loop below just re-assigns the same value; on the PATCH side this is the
// only place patch.name is applied.
const CUSTOMER_PASSTHROUGH_FIELDS = [
  "name",
  "orgNumber",
  "vatNumber",
  "contactName",
  "email",
  "phone",
  "address",
  "postalCode",
  "city",
  "country",
  "invoiceName",
  "invoiceAddress",
  "invoicePostalCode",
  "invoiceCity",
  "invoiceCountry",
  "invoiceEmail",
  "ourSupplierNumber",
  "collectiveInvoicing",
  "privatePerson",
  "website",
] as const satisfies readonly (keyof CustomerCreatePlan)[];

type CustomerRegisterIds = {
  paymentTerm: Map<string, string>;
  deliveryTerm: Map<string, string>;
  carrier: Map<string, string>;
  priceList: Map<string, string>;
};

// Builds the insert row for one CustomerCreatePlan entry: passthrough
// fields as-is (undefined = column default), discountPercent stringified
// for the numeric column, and the four register fields resolved to ids.
// Returned as `typeof customers.$inferInsert` — built through a
// Record<string, unknown> because the fields are assigned in a loop (TS
// cannot track that against the table's literal insert type), but every key
// written is a real customers column.
function buildCustomerInsertValues(
  create: CustomerCreatePlan,
  regs: CustomerRegisterIds
): typeof customers.$inferInsert {
  const values: Record<string, unknown> = { customerNumber: create.customerNumber, name: create.name };
  for (const field of CUSTOMER_PASSTHROUGH_FIELDS) values[field] = create[field];
  values.discountPercent = create.discountPercent !== undefined ? String(create.discountPercent) : undefined;
  values.paymentTermId = resolveRegisterId(create.paymentTermId, create.paymentTermName, regs.paymentTerm);
  values.deliveryTermId = resolveRegisterId(create.deliveryTermId, create.deliveryTermName, regs.deliveryTerm);
  values.carrierId = resolveRegisterId(create.carrierId, create.carrierName, regs.carrier);
  values.priceListId = resolveRegisterId(create.priceListId, create.priceListName, regs.priceList);
  return values as typeof customers.$inferInsert;
}

// Builds the `.set()` payload for one CustomerUpdatePlan patch: only keys
// actually present in the patch are included — "leave untouched" (empty CSV
// cell) must never become "set to null/undefined" here, unlike the create
// path above where an undefined value simply omits the column.
function buildCustomerPatchValues(
  patch: CustomerImportPlan["updates"][number]["patch"],
  regs: CustomerRegisterIds
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const field of CUSTOMER_PASSTHROUGH_FIELDS) {
    if (patch[field] !== undefined) set[field] = patch[field];
  }
  if (patch.discountPercent !== undefined) set.discountPercent = String(patch.discountPercent);
  const paymentTermId = resolveRegisterId(patch.paymentTermId, patch.paymentTermName, regs.paymentTerm);
  if (paymentTermId !== undefined) set.paymentTermId = paymentTermId;
  const deliveryTermId = resolveRegisterId(patch.deliveryTermId, patch.deliveryTermName, regs.deliveryTerm);
  if (deliveryTermId !== undefined) set.deliveryTermId = deliveryTermId;
  const carrierId = resolveRegisterId(patch.carrierId, patch.carrierName, regs.carrier);
  if (carrierId !== undefined) set.carrierId = carrierId;
  const priceListId = resolveRegisterId(patch.priceListId, patch.priceListName, regs.priceList);
  if (priceListId !== undefined) set.priceListId = priceListId;
  return set;
}

// The supplier counterpart of CUSTOMER_PASSTHROUGH_FIELDS — every
// SupplierCreatePlan field except supplierNumber and the register id/name
// pairs. Same "name is in the list" note as above.
const SUPPLIER_PASSTHROUGH_FIELDS = [
  "name",
  "orgNumber",
  "vatNumber",
  "contactName",
  "email",
  "phone",
  "address",
  "postalCode",
  "city",
  "currency",
  "ourCustomerNumber",
  "carrierCustomerNumber",
] as const satisfies readonly (keyof SupplierCreatePlan)[];

// Suppliers have no price list — three registers, not four.
type SupplierRegisterIds = Omit<CustomerRegisterIds, "priceList">;

function buildSupplierInsertValues(
  create: SupplierCreatePlan,
  regs: SupplierRegisterIds
): typeof suppliers.$inferInsert {
  const values: Record<string, unknown> = { supplierNumber: create.supplierNumber, name: create.name };
  for (const field of SUPPLIER_PASSTHROUGH_FIELDS) values[field] = create[field];
  values.paymentTermId = resolveRegisterId(create.paymentTermId, create.paymentTermName, regs.paymentTerm);
  values.deliveryTermId = resolveRegisterId(create.deliveryTermId, create.deliveryTermName, regs.deliveryTerm);
  values.carrierId = resolveRegisterId(create.carrierId, create.carrierName, regs.carrier);
  return values as typeof suppliers.$inferInsert;
}

// Same "present keys only" rule as buildCustomerPatchValues.
function buildSupplierPatchValues(
  patch: SupplierImportPlan["updates"][number]["patch"],
  regs: SupplierRegisterIds
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const field of SUPPLIER_PASSTHROUGH_FIELDS) {
    if (patch[field] !== undefined) set[field] = patch[field];
  }
  const paymentTermId = resolveRegisterId(patch.paymentTermId, patch.paymentTermName, regs.paymentTerm);
  if (paymentTermId !== undefined) set.paymentTermId = paymentTermId;
  const deliveryTermId = resolveRegisterId(patch.deliveryTermId, patch.deliveryTermName, regs.deliveryTerm);
  if (deliveryTermId !== undefined) set.deliveryTermId = deliveryTermId;
  const carrierId = resolveRegisterId(patch.carrierId, patch.carrierName, regs.carrier);
  if (carrierId !== undefined) set.carrierId = carrierId;
  return set;
}

// --- Resource import value builders (NOTES.md #7) ---
// Numeric columns take strings; undefined stays undefined (DB default on
// insert, untouched on update).
function numericString(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function buildWorkCenterInsertValues(
  create: WorkCenterCreatePlan,
  resolveGroup: (id: string | undefined, code: string | undefined) => string | undefined
): typeof workCenters.$inferInsert {
  return {
    code: create.code,
    name: create.name,
    type: create.type ?? "machine",
    productionGroupId: resolveGroup(create.productionGroupId, create.productionGroupCode) ?? null,
    hourlyRate: numericString(create.hourlyRate),
    calcRate1: numericString(create.calcRate1),
    rateAppliesToSetup: create.rateAppliesToSetup,
    rateAppliesToRun: create.rateAppliesToRun,
    defaultSetupTime: numericString(create.defaultSetupTime),
    defaultOperationName: create.defaultOperationName,
  };
}

// Present keys only — an empty cell never overwrites a stored value.
function buildWorkCenterPatchValues(
  patch: WorkCenterImportPlan["updates"][number]["patch"],
  resolveGroup: (id: string | undefined, code: string | undefined) => string | undefined
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.type !== undefined) set.type = patch.type;
  const groupId = resolveGroup(patch.productionGroupId, patch.productionGroupCode);
  if (groupId !== undefined) set.productionGroupId = groupId;
  if (patch.hourlyRate !== undefined) set.hourlyRate = String(patch.hourlyRate);
  if (patch.calcRate1 !== undefined) set.calcRate1 = String(patch.calcRate1);
  if (patch.rateAppliesToSetup !== undefined) set.rateAppliesToSetup = patch.rateAppliesToSetup;
  if (patch.rateAppliesToRun !== undefined) set.rateAppliesToRun = patch.rateAppliesToRun;
  if (patch.defaultSetupTime !== undefined) set.defaultSetupTime = String(patch.defaultSetupTime);
  if (patch.defaultOperationName !== undefined) set.defaultOperationName = patch.defaultOperationName;
  return set;
}

function buildLegoWorkCenterInsertValues(create: LegoWorkCenterCreatePlan): typeof workCenters.$inferInsert {
  return {
    code: create.code,
    name: create.name,
    type: "subcontract",
    supplierId: create.supplierId ?? null,
    leadTimeDays: numericString(create.leadTimeDays),
    queueTimeDays: numericString(create.queueTimeDays),
    orderLeadTimeDays: numericString(create.orderLeadTimeDays),
  };
}

function buildLegoWorkCenterPatchValues(
  patch: LegoWorkCenterImportPlan["updates"][number]["patch"]
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.supplierId !== undefined) set.supplierId = patch.supplierId;
  if (patch.leadTimeDays !== undefined) set.leadTimeDays = String(patch.leadTimeDays);
  if (patch.queueTimeDays !== undefined) set.queueTimeDays = String(patch.queueTimeDays);
  if (patch.orderLeadTimeDays !== undefined) set.orderLeadTimeDays = String(patch.orderLeadTimeDays);
  return set;
}

export function createImportRepository(db: Db) {
  return {
    // Everything the plan builder needs about the numbers that occur in the
    // file. Chunked like the inserts — the file may hold 10 000 numbers.
    async articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>> {
      const map = new Map<string, ExistingArticle>();
      for (const part of chunk([...new Set(numbers)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            id: articles.id,
            articleNumber: articles.articleNumber,
            name: articles.name,
            type: articles.type,
            unitCode: units.code,
            unitId: articles.unitId,
            isPhantom: articles.isPhantom,
            groupCode: articleGroups.code,
            standardCost: articles.standardCost,
            weight: articles.weight,
            surfaceTreatment: articles.surfaceTreatment,
            colour: articles.colour,
            active: articles.active,
          })
          .from(articles)
          .innerJoin(units, eq(units.id, articles.unitId))
          .leftJoin(articleGroups, eq(articleGroups.id, articles.groupId))
          .where(inArray(articles.articleNumber, part));
        for (const row of rows) map.set(row.articleNumber, row);
      }
      return map;
    },

    // Keyed by LOWERCASED code so "ST" in a CSV finds the "st" unit instead
    // of creating a case-variant duplicate (units.code is case-sensitive).
    async unitsByCode(): Promise<Map<string, { id: string; code: string }>> {
      const rows = await db.select({ id: units.id, code: units.code }).from(units);
      return new Map(rows.map((row) => [row.code.toLowerCase(), row]));
    },

    // Group codes are 3-4 digits — exact keys.
    async groupsByCode(): Promise<Map<string, string>> {
      const rows = await db.select({ id: articleGroups.id, code: articleGroups.code }).from(articleGroups);
      return new Map(rows.map((row) => [row.code, row.id]));
    },

    // The same fallbacks createArticle resolves per article, resolved ONCE
    // per import: the "st" unit and the "***" location, both created on
    // first use (mirrors article.repository's getOrCreateDefaultUnitId).
    async resolveDefaults(): Promise<{ unitId: string; locationId: string }> {
      await db.insert(units).values({ code: "st", name: "Styck" }).onConflictDoNothing();
      const [st] = await db.select({ id: units.id }).from(units).where(eq(units.code, "st"));
      const locationId = await getOrCreateFallbackLocation(db);
      return { unitId: st!.id, locationId };
    },

    // The whole import is ONE transaction: register auto-creation, creates
    // and updates — any failure rolls everything back. onConflictDoNothing
    // makes the register step race-safe against a concurrent manual create.
    async executeArticlePlan(plan: ArticleImportPlan) {
      return db.transaction(async (tx) => {
        const createdUnits: string[] = [];
        for (const part of chunk(plan.willCreate.units)) {
          if (part.length === 0) continue;
          const rows = await tx
            .insert(units)
            .values(part.map((code) => ({ code, name: code }))) // code = name = the code
            .onConflictDoNothing()
            .returning({ code: units.code });
          createdUnits.push(...rows.map((row) => row.code));
        }

        const createdGroups: string[] = [];
        for (const part of chunk(plan.willCreate.articleGroups)) {
          if (part.length === 0) continue;
          const rows = await tx
            .insert(articleGroups)
            .values(part.map((code) => ({ code, name: code }))) // name = code
            .onConflictDoNothing()
            .returning({ code: articleGroups.code });
          createdGroups.push(...rows.map((row) => row.code));
        }

        // Re-read code -> id INSIDE the tx so the just-created registers
        // resolve. Same lowercased keying as unitsByCode.
        const unitRows = await tx.select({ id: units.id, code: units.code }).from(units);
        const unitIds = new Map(unitRows.map((row) => [row.code.toLowerCase(), row.id]));
        const groupRows = await tx.select({ id: articleGroups.id, code: articleGroups.code }).from(articleGroups);
        const groupIds = new Map(groupRows.map((row) => [row.code, row.id]));

        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          // RETURNING id + articleNumber (not just id) so the history rows
          // below can be matched back to their plan entry by the unique
          // article number — Postgres doesn't guarantee RETURNING preserves
          // VALUES order. Already chunked at the same size as the insert, so
          // no separate chunking pass is needed for the history insert.
          const inserted = await tx
            .insert(articles)
            .values(
              part.map((create) => ({
                articleNumber: create.articleNumber,
                name: create.name,
                type: create.type,
                isPhantom: create.isPhantom,
                unitId: create.unitCode ? resolveNewUnitId(unitIds, create.unitCode) : plan.fallbackUnitId,
                groupId: create.groupCode ? groupIds.get(create.groupCode)! : null,
                standardCost: create.standardCost !== null ? String(create.standardCost) : undefined,
                weight: create.weight !== null ? String(create.weight) : undefined,
                surfaceTreatment: create.surfaceTreatment,
                colour: create.colour,
                defaultLocationId: plan.fallbackLocationId,
                active: create.active,
                // != null: the bom import's own article creates (and older
                // callers) don't carry the planning fields at all.
                reorderPoint: create.reorderPoint != null ? String(create.reorderPoint) : undefined,
                orderQuantity: create.orderQuantity != null ? String(create.orderQuantity) : undefined,
                rounding: create.rounding != null ? String(create.rounding) : undefined,
              }))
            )
            .returning({ id: articles.id, articleNumber: articles.articleNumber });
          const idByNumber = new Map(inserted.map((row) => [row.articleNumber, row.id]));
          const historyRows = part
            .filter((create) => create.standardCost !== null)
            .map((create) => ({ articleId: idByNumber.get(create.articleNumber)!, cost: create.standardCost! }));
          await recordStandardCostHistory(tx, historyRows);
        }

        // Updates run row by row (each patch differs); an empty patch still
        // counts as "updated" so created+updated always equals the number of
        // clean rows the preview showed. planArticleImport only stages
        // patch.standardCost when it differs from the article's current
        // value (re-importing the same file stages no patch at all), so a
        // present patch.standardCost always means a real change here — no
        // second read-and-compare needed.
        let updated = 0;
        const costHistoryRows: { articleId: string; cost: number }[] = [];
        for (const update of plan.updates) {
          updated++;
          if (Object.keys(update.patch).length === 0) continue;
          if (update.patch.standardCost !== undefined) {
            costHistoryRows.push({ articleId: update.id, cost: update.patch.standardCost });
          }
          await tx
            .update(articles)
            .set({
              ...(update.patch.name !== undefined ? { name: update.patch.name } : {}),
              ...(update.patch.groupCode !== undefined ? { groupId: groupIds.get(update.patch.groupCode)! } : {}),
              ...(update.patch.standardCost !== undefined ? { standardCost: String(update.patch.standardCost) } : {}),
              ...(update.patch.weight !== undefined ? { weight: String(update.patch.weight) } : {}),
              ...(update.patch.surfaceTreatment !== undefined
                ? { surfaceTreatment: update.patch.surfaceTreatment }
                : {}),
              ...(update.patch.colour !== undefined ? { colour: update.patch.colour } : {}),
              ...(update.patch.active !== undefined ? { active: update.patch.active } : {}),
              ...(update.patch.reorderPoint !== undefined
                ? { reorderPoint: update.patch.reorderPoint === null ? null : String(update.patch.reorderPoint) }
                : {}),
              ...(update.patch.orderQuantity !== undefined
                ? { orderQuantity: update.patch.orderQuantity === null ? null : String(update.patch.orderQuantity) }
                : {}),
              ...(update.patch.rounding !== undefined
                ? { rounding: update.patch.rounding === null ? null : String(update.patch.rounding) }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(articles.id, update.id));
        }
        for (const part of chunk(costHistoryRows)) {
          await recordStandardCostHistory(tx, part);
        }

        return {
          created: plan.creates.length,
          updated,
          registersCreated: { units: createdUnits, articleGroups: createdGroups },
        };
      });
    },

    // Everything the customer planner needs about the numbers in the file.
    // Chunked like the inserts — the file may hold 10 000 numbers.
    async customersByNumber(numbers: string[]): Promise<Map<string, { id: string }>> {
      const map = new Map<string, { id: string }>();
      for (const part of chunk([...new Set(numbers)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({ id: customers.id, customerNumber: customers.customerNumber })
          .from(customers)
          .where(inArray(customers.customerNumber, part));
        for (const row of rows) map.set(row.customerNumber, { id: row.id });
      }
      return map;
    },

    // Register lookups for the four cells (paymentTerm/deliveryTerm/carrier/
    // priceList): lowercased code AND lowercased name -> id, so a cell that
    // names either resolves. One query per register — all four are small.
    async paymentTermsByNameOrCode(): Promise<Map<string, string>> {
      const rows = await db
        .select({ id: paymentTerms.id, code: paymentTerms.code, name: paymentTerms.name })
        .from(paymentTerms);
      const map = new Map<string, string>();
      for (const row of rows) {
        map.set(row.code.toLowerCase(), row.id);
        map.set(row.name.toLowerCase(), row.id);
      }
      return map;
    },
    async deliveryTermsByNameOrCode(): Promise<Map<string, string>> {
      const rows = await db
        .select({ id: deliveryTerms.id, code: deliveryTerms.code, name: deliveryTerms.name })
        .from(deliveryTerms);
      const map = new Map<string, string>();
      for (const row of rows) {
        map.set(row.code.toLowerCase(), row.id);
        map.set(row.name.toLowerCase(), row.id);
      }
      return map;
    },
    async carriersByNameOrCode(): Promise<Map<string, string>> {
      const rows = await db.select({ id: carriers.id, code: carriers.code, name: carriers.name }).from(carriers);
      const map = new Map<string, string>();
      for (const row of rows) {
        map.set(row.code.toLowerCase(), row.id);
        map.set(row.name.toLowerCase(), row.id);
      }
      return map;
    },
    async priceListsByNameOrCode(): Promise<Map<string, string>> {
      const rows = await db
        .select({ id: priceLists.id, code: priceLists.code, name: priceLists.name })
        .from(priceLists);
      const map = new Map<string, string>();
      for (const row of rows) {
        map.set(row.code.toLowerCase(), row.id);
        map.set(row.name.toLowerCase(), row.id);
      }
      return map;
    },

    // The whole import is ONE transaction: the four registers FIRST (so
    // their ids exist for the customer writes), then creates (chunked at
    // 500), updates and — LAST — the series bump. GREATEST never lowers a
    // series that already stands higher than the imported numbers.
    async executeCustomerPlan(plan: CustomerImportPlan) {
      return db.transaction(async (tx) => {
        const paymentTermReg = await resolveOrCreateRegister(
          tx,
          paymentTerms as unknown as NamedRegisterTable,
          plan.willCreate.paymentTerms,
          generatePaymentTermCode,
          "Betalningsvillkoret"
        );
        const deliveryTermReg = await resolveOrCreateRegister(
          tx,
          deliveryTerms,
          plan.willCreate.deliveryTerms,
          slugifyRegisterCode,
          "Leveransvillkoret"
        );
        const carrierReg = await resolveOrCreateRegister(
          tx,
          carriers as unknown as NamedRegisterTable,
          plan.willCreate.carriers,
          slugifyRegisterCode,
          "Speditören"
        );
        const priceListReg = await resolveOrCreateRegister(
          tx,
          priceLists as unknown as NamedRegisterTable,
          plan.willCreate.priceLists,
          slugifyRegisterCode,
          "Prislistan"
        );
        const regs: CustomerRegisterIds = {
          paymentTerm: paymentTermReg.idByKey,
          deliveryTerm: deliveryTermReg.idByKey,
          carrier: carrierReg.idByKey,
          priceList: priceListReg.idByKey,
        };

        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(customers).values(part.map((create) => buildCustomerInsertValues(create, regs)));
        }

        // Updates run row by row (each patch differs); an empty resolved
        // patch still counts as "updated" so created+updated always equals
        // the number of clean rows the preview showed.
        let updated = 0;
        for (const update of plan.updates) {
          updated++;
          const set = buildCustomerPatchValues(update.patch, regs);
          if (Object.keys(set).length === 0) continue;
          await tx.update(customers).set(set).where(eq(customers.id, update.id));
        }

        if (plan.maxNumericNumber !== null) {
          await tx.execute(sql`
            UPDATE number_series
            SET next_number = GREATEST(next_number, ${plan.maxNumericNumber + 1})
            WHERE key = 'customer'
          `);
        }

        return {
          created: plan.creates.length,
          updated,
          registersCreated: {
            units: [] as string[],
            articleGroups: [] as string[],
            paymentTerms: paymentTermReg.created,
            deliveryTerms: deliveryTermReg.created,
            carriers: carrierReg.created,
            priceLists: priceListReg.created,
          },
        };
      });
    },

    // Everything the supplier planner needs about the numbers in the file.
    // Chunked like the inserts — the file may hold 10 000 numbers.
    async suppliersByNumber(numbers: string[]): Promise<Map<string, { id: string }>> {
      const map = new Map<string, { id: string }>();
      for (const part of chunk([...new Set(numbers)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({ id: suppliers.id, supplierNumber: suppliers.supplierNumber })
          .from(suppliers)
          .where(inArray(suppliers.supplierNumber, part));
        for (const row of rows) map.set(row.supplierNumber, { id: row.id });
      }
      return map;
    },

    // The whole import is ONE transaction: the three registers FIRST (so
    // their ids exist for the supplier writes), then creates (chunked at
    // 500), updates and — LAST — the series bump. GREATEST never lowers a
    // series that already stands higher than the imported numbers. Same
    // shape as executeCustomerPlan minus the price list.
    async executeSupplierPlan(plan: SupplierImportPlan) {
      return db.transaction(async (tx) => {
        const paymentTermReg = await resolveOrCreateRegister(
          tx,
          paymentTerms as unknown as NamedRegisterTable,
          plan.willCreate.paymentTerms,
          generatePaymentTermCode,
          "Betalningsvillkoret"
        );
        const deliveryTermReg = await resolveOrCreateRegister(
          tx,
          deliveryTerms,
          plan.willCreate.deliveryTerms,
          slugifyRegisterCode,
          "Leveransvillkoret"
        );
        const carrierReg = await resolveOrCreateRegister(
          tx,
          carriers as unknown as NamedRegisterTable,
          plan.willCreate.carriers,
          slugifyRegisterCode,
          "Speditören"
        );
        const regs: SupplierRegisterIds = {
          paymentTerm: paymentTermReg.idByKey,
          deliveryTerm: deliveryTermReg.idByKey,
          carrier: carrierReg.idByKey,
        };

        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(suppliers).values(part.map((create) => buildSupplierInsertValues(create, regs)));
        }

        // Updates run row by row (each patch differs); an empty resolved
        // patch still counts as "updated" so created+updated always equals
        // the number of clean rows the preview showed.
        let updated = 0;
        for (const update of plan.updates) {
          updated++;
          const set = buildSupplierPatchValues(update.patch, regs);
          if (Object.keys(set).length === 0) continue;
          await tx.update(suppliers).set(set).where(eq(suppliers.id, update.id));
        }

        if (plan.maxNumericNumber !== null) {
          await tx.execute(sql`
            UPDATE number_series
            SET next_number = GREATEST(next_number, ${plan.maxNumericNumber + 1})
            WHERE key = 'supplier'
          `);
        }

        return {
          created: plan.creates.length,
          updated,
          registersCreated: {
            units: [] as string[],
            articleGroups: [] as string[],
            paymentTerms: paymentTermReg.created,
            deliveryTerms: deliveryTermReg.created,
            carriers: carrierReg.created,
          },
        };
      });
    },

    // --- Resource / lego / production-group imports (NOTES.md #7) ---

    // Same register as workCentersByCode below, plus the type — the resource
    // and lego planners refuse a number that belongs to the other kind.
    async workCentersByCodeDetailed(): Promise<Map<string, ExistingWorkCenter>> {
      const rows = await db
        .select({ id: workCenters.id, code: workCenters.code, type: workCenters.type })
        .from(workCenters);
      return new Map(rows.map((row) => [row.code, row]));
    },

    // Lowercased code -> group. production_groups.code is unique but free
    // text, hence the case folding (Monitor codes are digits anyway).
    async productionGroupsByCode(): Promise<Map<string, { id: string; name: string }>> {
      const rows = await db
        .select({ id: productionGroups.id, code: productionGroups.code, name: productionGroups.name })
        .from(productionGroups);
      return new Map(rows.map((row) => [row.code.toLowerCase(), { id: row.id, name: row.name }]));
    },

    // One transaction: the missing avdelningar FIRST (onConflictDoNothing —
    // a concurrent import may have created the same code), then chunked
    // creates and row-by-row updates. No number series to bump: resource
    // numbers come from the file.
    async executeWorkCenterPlan(plan: WorkCenterImportPlan) {
      return db.transaction(async (tx) => {
        const createdGroups: string[] = [];
        if (plan.newProductionGroups.length > 0) {
          for (const part of chunk(plan.newProductionGroups)) {
            const inserted = await tx
              .insert(productionGroups)
              .values(part.map((g) => ({ code: g.code, name: g.name })))
              .onConflictDoNothing()
              .returning({ code: productionGroups.code });
            createdGroups.push(...inserted.map((row) => row.code));
          }
        }
        const groupRows = await tx.select({ id: productionGroups.id, code: productionGroups.code }).from(productionGroups);
        const groupIdByCode = new Map(groupRows.map((row) => [row.code.toLowerCase(), row.id]));
        const resolveGroup = (id: string | undefined, code: string | undefined): string | undefined => {
          if (id !== undefined) return id;
          if (code === undefined) return undefined;
          const resolved = groupIdByCode.get(code.toLowerCase());
          if (resolved === undefined) {
            throw new ImportRegisterConflictError(
              `Produktionsgruppen "${code}" kunde inte skapas — det finns redan en post med samma namn under en annan kod`
            );
          }
          return resolved;
        };

        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(workCenters).values(part.map((create) => buildWorkCenterInsertValues(create, resolveGroup)));
        }

        let updated = 0;
        for (const update of plan.updates) {
          updated++;
          const set = buildWorkCenterPatchValues(update.patch, resolveGroup);
          if (Object.keys(set).length === 0) continue;
          await tx.update(workCenters).set(set).where(eq(workCenters.id, update.id));
        }

        return {
          created: plan.creates.length,
          updated,
          registersCreated: { units: [] as string[], articleGroups: [] as string[], productionGroups: createdGroups },
        };
      });
    },

    async executeLegoWorkCenterPlan(plan: LegoWorkCenterImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(workCenters).values(part.map(buildLegoWorkCenterInsertValues));
        }
        let updated = 0;
        for (const update of plan.updates) {
          updated++;
          const set = buildLegoWorkCenterPatchValues(update.patch);
          if (Object.keys(set).length === 0) continue;
          await tx.update(workCenters).set(set).where(eq(workCenters.id, update.id));
        }
        return {
          created: plan.creates.length,
          updated,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },

    async executeProductionGroupPlan(plan: ProductionGroupImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(productionGroups).values(
            part.map((create) => ({ code: create.code, name: create.name, description: create.description ?? null }))
          );
        }
        let updated = 0;
        for (const update of plan.updates) {
          updated++;
          const set: Record<string, unknown> = {};
          if (update.patch.name !== undefined) set.name = update.patch.name;
          if (update.patch.description !== undefined) set.description = update.patch.description;
          if (Object.keys(set).length === 0) continue;
          await tx.update(productionGroups).set(set).where(eq(productionGroups.id, update.id));
        }
        return {
          created: plan.creates.length,
          updated,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },

    // --- Structure and routing imports (TODO2 #15) ---

    // work_centers.code is exactly three digits and unique, so no case
    // folding is needed and the whole register fits in one query. `type`
    // rides along so the routing planner can tell a legoresurs apart.
    async workCentersByCode(): Promise<Map<string, { id: string; code: string; type: string }>> {
      const rows = await db
        .select({ id: workCenters.id, code: workCenters.code, type: workCenters.type })
        .from(workCenters);
      return new Map(rows.map((row) => [row.code, row]));
    },

    // articleId -> sequenceNo -> operation. Shared by both importers: the
    // routing import checks for duplicates, the BOM import resolves the
    // Operation column (and rejects Kalkyl operations).
    async routingOperationsByArticle(
      articleIds: string[]
    ): Promise<Map<string, Map<number, { id: string; costingOnly: boolean }>>> {
      const map = new Map<string, Map<number, { id: string; costingOnly: boolean }>>();
      for (const part of chunk([...new Set(articleIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            id: routingOperations.id,
            articleId: routingOperations.articleId,
            sequenceNo: routingOperations.sequenceNo,
            costingOnly: routingOperations.costingOnly,
          })
          .from(routingOperations)
          .where(inArray(routingOperations.articleId, part));
        for (const row of rows) {
          const perArticle = map.get(row.articleId) ?? new Map<number, { id: string; costingOnly: boolean }>();
          perArticle.set(row.sequenceNo, { id: row.id, costingOnly: row.costingOnly });
          map.set(row.articleId, perArticle);
        }
      }
      return map;
    },

    // articleId -> unitId -> quantity_per_base. Only ALTERNATIVE units live
    // in article_units; the base unit is articles.unit_id and needs no
    // factor, which is why the BOM planner compares against unitId first.
    async articleUnitFactors(articleIds: string[]): Promise<Map<string, Map<string, number>>> {
      const map = new Map<string, Map<string, number>>();
      for (const part of chunk([...new Set(articleIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            articleId: articleUnits.articleId,
            unitId: articleUnits.unitId,
            quantityPerBase: articleUnits.quantityPerBase,
          })
          .from(articleUnits)
          .where(inArray(articleUnits.articleId, part));
        for (const row of rows) {
          const perArticle = map.get(row.articleId) ?? new Map<string, number>();
          perArticle.set(row.unitId, Number(row.quantityPerBase));
          map.set(row.articleId, perArticle);
        }
      }
      return map;
    },

    // --- Alternative-unit import (articleUnits) ---
    // Units first (onConflictDoNothing, same race guard as executeArticlePlan),
    // then the article_units rows, factor updates and the articles' default
    // purchase/sales units — ONE transaction.
    async executeArticleUnitPlan(plan: ArticleUnitImportPlan) {
      return db.transaction(async (tx) => {
        const createdUnits: string[] = [];
        for (const part of chunk(plan.willCreate.units)) {
          if (part.length === 0) continue;
          const rows = await tx
            .insert(units)
            .values(part.map((code) => ({ code, name: code })))
            .onConflictDoNothing()
            .returning({ code: units.code });
          createdUnits.push(...rows.map((row) => row.code));
        }
        const unitRows = await tx.select({ id: units.id, code: units.code }).from(units);
        const unitIds = new Map(unitRows.map((row) => [row.code.toLowerCase(), row.id]));

        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(articleUnits).values(
            part.map((create) => ({
              articleId: create.articleId,
              unitId: resolveNewUnitId(unitIds, create.unitCode),
              quantityPerBase: String(create.quantityPerBase),
            }))
          );
        }
        for (const update of plan.updates) {
          await tx
            .update(articleUnits)
            .set({ quantityPerBase: String(update.quantityPerBase) })
            .where(and(eq(articleUnits.articleId, update.articleId), eq(articleUnits.unitId, update.unitId)));
        }
        for (const defaults of plan.articleDefaults) {
          await tx
            .update(articles)
            .set({
              ...(defaults.purchaseUnitCode !== undefined
                ? { purchaseUnitId: resolveNewUnitId(unitIds, defaults.purchaseUnitCode) }
                : {}),
              ...(defaults.salesUnitCode !== undefined
                ? { salesUnitId: resolveNewUnitId(unitIds, defaults.salesUnitCode) }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(articles.id, defaults.articleId));
        }
        return {
          created: plan.creates.length,
          updated: plan.updates.length,
          registersCreated: { units: createdUnits, articleGroups: [] as string[] },
        };
      });
    },

    // --- Supplier price import (supplierPrices) ---
    // articleId -> supplierId -> the existing catalog row.
    async articleSuppliersByArticle(
      articleIds: string[]
    ): Promise<Map<string, Map<string, { id: string; isPrimary: boolean }>>> {
      const map = new Map<string, Map<string, { id: string; isPrimary: boolean }>>();
      for (const part of chunk([...new Set(articleIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            id: articleSuppliers.id,
            articleId: articleSuppliers.articleId,
            supplierId: articleSuppliers.supplierId,
            isPrimary: articleSuppliers.isPrimary,
          })
          .from(articleSuppliers)
          .where(inArray(articleSuppliers.articleId, part));
        for (const row of rows) {
          const perArticle = map.get(row.articleId) ?? new Map<string, { id: string; isPrimary: boolean }>();
          perArticle.set(row.supplierId, { id: row.id, isPrimary: row.isPrimary });
          map.set(row.articleId, perArticle);
        }
      }
      return map;
    },

    // Primary demotion FIRST (the partial unique index article_suppliers_one_
    // primary allows one per article — same order as createArticleSupplier),
    // then creates, updates and — when the file carried the break column —
    // the whole staffel replaced per catalog row. ONE transaction.
    async executeSupplierPricePlan(plan: SupplierPriceImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.primaryArticleIds)) {
          if (part.length === 0) continue;
          await tx
            .update(articleSuppliers)
            .set({ isPrimary: false })
            .where(and(inArray(articleSuppliers.articleId, part), eq(articleSuppliers.isPrimary, true)));
        }

        // A new catalog row takes the supplier's currency, as the catalog
        // dialog does; existing rows keep theirs (the price column is in the
        // row's currency).
        const currencyBySupplier = new Map<string, string>();
        for (const part of chunk([...new Set(plan.creates.map((create) => create.supplierId))])) {
          if (part.length === 0) continue;
          const rows = await tx
            .select({ id: suppliers.id, currency: suppliers.currency })
            .from(suppliers)
            .where(inArray(suppliers.id, part));
          for (const row of rows) currencyBySupplier.set(row.id, row.currency);
        }

        const createdIds: { id: string; breaks: SupplierPriceImportPlan["creates"][number]["breaks"] }[] = [];
        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          const inserted = await tx
            .insert(articleSuppliers)
            .values(
              part.map((create) => ({
                articleId: create.articleId,
                supplierId: create.supplierId,
                supplierArticleNumber: create.supplierArticleNumber,
                price: create.price !== null ? String(create.price) : null,
                currency: currencyBySupplier.get(create.supplierId) ?? "SEK",
                isPrimary: create.isPrimary,
              }))
            )
            .returning({ id: articleSuppliers.id, articleId: articleSuppliers.articleId, supplierId: articleSuppliers.supplierId });
          // RETURNING order is not guaranteed — match back on the unique pair.
          const byPair = new Map(inserted.map((row) => [`${row.articleId}#${row.supplierId}`, row.id]));
          for (const create of part) {
            createdIds.push({ id: byPair.get(`${create.articleId}#${create.supplierId}`)!, breaks: create.breaks });
          }
        }

        for (const update of plan.updates) {
          const set: { supplierArticleNumber?: string; price?: string; isPrimary?: boolean } = {};
          if (update.patch.supplierArticleNumber !== undefined) set.supplierArticleNumber = update.patch.supplierArticleNumber;
          if (update.patch.price !== undefined) set.price = String(update.patch.price);
          if (update.patch.isPrimary !== undefined) set.isPrimary = update.patch.isPrimary;
          if (Object.keys(set).length > 0) {
            await tx.update(articleSuppliers).set(set).where(eq(articleSuppliers.id, update.id));
          }
        }

        if (plan.breaksMapped) {
          for (const { id, breaks } of createdIds) await replacePriceBreaks(tx, id, breaks);
          for (const update of plan.updates) await replacePriceBreaks(tx, update.id, update.breaks);
        }

        return {
          created: plan.creates.length,
          updated: plan.updates.length,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },

    // --- Customer price import (customerPrices) ---
    // "<customerId>#<articleId>" -> the existing article rule at antal 1.
    async customerArticlePrices(customerIds: string[]): Promise<Map<string, { id: string }>> {
      const map = new Map<string, { id: string }>();
      for (const part of chunk([...new Set(customerIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({ id: customerPrices.id, customerId: customerPrices.customerId, articleId: customerPrices.articleId })
          .from(customerPrices)
          .where(
            and(
              inArray(customerPrices.customerId, part),
              isNotNull(customerPrices.articleId),
              eq(customerPrices.fromQuantity, "1")
            )
          );
        for (const row of rows) map.set(`${row.customerId}#${row.articleId}`, { id: row.id });
      }
      return map;
    },

    // Creates + updates in ONE transaction. An update clears discount_percent
    // so customer_prices_value_check (price XOR discount) holds whatever form
    // the stored rule had.
    async executeCustomerPricePlan(plan: CustomerPriceImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(customerPrices).values(
            part.map((create) => ({
              customerId: create.customerId,
              articleId: create.articleId,
              fromQuantity: "1",
              unitPrice: String(create.unitPrice),
              discountPercent: null,
            }))
          );
        }
        for (const update of plan.updates) {
          await tx
            .update(customerPrices)
            .set({ unitPrice: String(update.unitPrice), discountPercent: null })
            .where(eq(customerPrices.id, update.id));
        }
        return {
          created: plan.creates.length,
          updated: plan.updates.length,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },

    // The WHOLE bom_components table as edges. One query answers both the
    // "does this pair already exist" check and the cycle check, which needs
    // reachability in both directions — a recursive CTE per direction would
    // be substantially more code for the same answer. Two uuids per row, so
    // ~10 MB at 200 000 structure rows, once per (rare, admin-only) import.
    // A recursive CTE is the right upgrade if that table ever grows large.
    async allBomEdges(): Promise<BomEdge[]> {
      return db
        .select({ parentId: bomComponents.parentArticleId, componentId: bomComponents.componentArticleId })
        .from(bomComponents);
    },

    // No register step; creates plus the opt-in updates (updateExisting) in
    // ONE transaction, so a failure halfway leaves nothing behind. Updates
    // rewrite routing_operations only — a released order's mo_operations
    // snapshot is never touched (same rule as updateRoutingOperation).
    async executeRoutingPlan(plan: RoutingImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.creates)) {
          await tx.insert(routingOperations).values(
            part.map((row) => ({
              articleId: row.articleId,
              sequenceNo: row.sequenceNo,
              workCenterId: row.workCenterId,
              setupTime: String(row.setupTime),
              runTimePerUnit: String(row.runTimePerUnit),
              timeUnit: row.timeUnit,
              costingOnly: row.costingOnly,
              comment: row.comment,
              printOnWorkCard: row.printOnWorkCard,
              description: row.description,
              packingInstructions: row.packingInstructions,
            }))
          );
        }
        for (const update of plan.updates) {
          const { setupTime, runTimePerUnit, ...rest } = update.patch;
          await tx
            .update(routingOperations)
            .set({
              ...rest,
              setupTime: String(setupTime),
              runTimePerUnit: String(runTimePerUnit),
            })
            .where(eq(routingOperations.id, update.id));
        }
        return {
          created: plan.creates.length,
          updated: plan.updates.length,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },

    // The whole import is ONE transaction: units, the missing component
    // articles and the structure rows — any failure rolls all three back.
    async executeBomPlan(plan: BomImportPlan) {
      return db.transaction(async (tx) => {
        // 1. Units for the new components. Same race-safe onConflictDoNothing
        //    as executeArticlePlan.
        const createdUnits: string[] = [];
        for (const part of chunk(plan.willCreate.units)) {
          if (part.length === 0) continue;
          const rows = await tx
            .insert(units)
            .values(part.map((code) => ({ code, name: code }))) // code = name = the code
            .onConflictDoNothing()
            .returning({ code: units.code });
          createdUnits.push(...rows.map((row) => row.code));
        }

        // 2. The missing components. RETURNING carries articleNumber because
        //    Postgres does not guarantee RETURNING preserves VALUES order.
        const createdArticles: string[] = [];
        const idByNumber = new Map<string, string>();
        if (plan.articleCreates.length > 0) {
          const unitRows = await tx.select({ id: units.id, code: units.code }).from(units);
          const unitIds = new Map(unitRows.map((row) => [row.code.toLowerCase(), row.id]));
          for (const part of chunk(plan.articleCreates)) {
            const inserted = await tx
              .insert(articles)
              .values(
                part.map((create) => ({
                  articleNumber: create.articleNumber,
                  name: create.name,
                  type: create.type,
                  isPhantom: create.isPhantom,
                  unitId: create.unitCode
                    ? resolveNewUnitId(unitIds, create.unitCode)
                    : plan.fallbackUnitId!,
                  standardCost: create.standardCost !== null ? String(create.standardCost) : undefined,
                  // Same fallback as createArticle and the article import.
                  defaultLocationId: plan.fallbackLocationId!,
                }))
              )
              .returning({ id: articles.id, articleNumber: articles.articleNumber });
            for (const row of inserted) {
              idByNumber.set(row.articleNumber, row.id);
              createdArticles.push(row.articleNumber);
            }
            // The price log must be complete for imported components too.
            await recordStandardCostHistory(
              tx,
              part
                .filter((create) => create.standardCost !== null)
                .map((create) => ({
                  articleId: idByNumber.get(create.articleNumber)!,
                  cost: create.standardCost!,
                }))
            );
          }
        }

        // 3. The structure rows — componentArticleId === null resolves now.
        for (const part of chunk(plan.creates)) {
          await tx.insert(bomComponents).values(
            part.map((row) => ({
              parentArticleId: row.parentArticleId,
              componentArticleId: row.componentArticleId ?? idByNumber.get(row.componentNumber)!,
              quantity: String(row.quantity),
              unitId: row.unitId,
              unitFactor: row.unitFactor === null ? null : String(row.unitFactor),
              routingOperationId: row.routingOperationId,
            }))
          );
        }
        return {
          // Structure rows only. Folding the new articles in here would turn
          // "975 skapade" into "1154 skapade" and make the result unreadable —
          // they are reported under registersCreated.articles instead.
          created: plan.creates.length,
          updated: 0,
          registersCreated: {
            units: createdUnits,
            articleGroups: [] as string[],
            articles: createdArticles,
          },
        };
      });
    },

    // --- Customer contact and delivery address imports ---

    // Everything the contact planner needs about contacts already on record
    // — loaded once per customer id that occurs in the file. Chunked like
    // the other by-id lookups.
    async contactsByCustomer(customerIds: string[]): Promise<Map<string, ExistingCustomerContact[]>> {
      const map = new Map<string, ExistingCustomerContact[]>();
      for (const part of chunk([...new Set(customerIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            customerId: customerContacts.customerId,
            id: customerContacts.id,
            name: customerContacts.name,
            isPrimary: customerContacts.isPrimary,
          })
          .from(customerContacts)
          .where(inArray(customerContacts.customerId, part));
        for (const row of rows) {
          const list = map.get(row.customerId) ?? [];
          list.push({ id: row.id, name: row.name, isPrimary: row.isPrimary });
          map.set(row.customerId, list);
        }
      }
      return map;
    },

    // Create-only, so there is no update pass and no register step — but
    // still ONE transaction, so a failure halfway leaves nothing behind. The
    // partial unique index (customer_contacts_one_primary) is never hit:
    // the planner already guarantees at most one isPrimary per customer
    // across the whole file, DB state included.
    async executeCustomerContactPlan(plan: CustomerContactImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(customerContacts).values(
            part.map((row) => ({
              customerId: row.customerId,
              name: row.name,
              isPrimary: row.isPrimary,
              phone: row.phone,
              mobile: row.mobile,
              email: row.email,
              comment: row.comment,
            }))
          );
        }
        return {
          created: plan.creates.length,
          updated: 0,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },

    // Everything the delivery-address planner needs about the customer's
    // OWN address — the skip rule ("same as the customer's address") reads
    // it, so unlike customersByNumber this carries the address fields too.
    async customerAddressesByNumber(numbers: string[]): Promise<Map<string, ExistingCustomerAddress>> {
      const map = new Map<string, ExistingCustomerAddress>();
      for (const part of chunk([...new Set(numbers)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            customerNumber: customers.customerNumber,
            id: customers.id,
            address: customers.address,
            postalCode: customers.postalCode,
            city: customers.city,
            country: customers.country,
          })
          .from(customers)
          .where(inArray(customers.customerNumber, part));
        for (const row of rows) {
          map.set(row.customerNumber, {
            id: row.id,
            address: row.address,
            postalCode: row.postalCode,
            city: row.city,
            country: row.country,
          });
        }
      }
      return map;
    },

    // Everything the delivery-address planner needs about delivery
    // addresses already on record — loaded once per customer id that
    // occurs in the file.
    async deliveryAddressesByCustomer(
      customerIds: string[]
    ): Promise<Map<string, ExistingDeliveryAddress[]>> {
      const map = new Map<string, ExistingDeliveryAddress[]>();
      for (const part of chunk([...new Set(customerIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            customerId: customerDeliveryAddresses.customerId,
            address: customerDeliveryAddresses.address,
            postalCode: customerDeliveryAddresses.postalCode,
            city: customerDeliveryAddresses.city,
            country: customerDeliveryAddresses.country,
            isDefault: customerDeliveryAddresses.isDefault,
          })
          .from(customerDeliveryAddresses)
          // An order's engångsadress is not one of the customer's addresses.
          .where(and(inArray(customerDeliveryAddresses.customerId, part), eq(customerDeliveryAddresses.oneOff, false)));
        for (const row of rows) {
          const list = map.get(row.customerId) ?? [];
          list.push({
            address: row.address,
            postalCode: row.postalCode,
            city: row.city,
            country: row.country,
            isDefault: row.isDefault,
          });
          map.set(row.customerId, list);
        }
      }
      return map;
    },

    // Create-only, so there is no update pass and no register step — but
    // still ONE transaction, so a failure halfway leaves nothing behind. The
    // partial unique index (customer_delivery_addresses_one_default) is
    // never hit: the planner already guarantees at most one isDefault per
    // customer across the whole file, DB state included.
    async executeCustomerDeliveryAddressPlan(plan: CustomerDeliveryAddressImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(customerDeliveryAddresses).values(
            part.map((row) => ({
              customerId: row.customerId,
              label: row.label,
              address: row.address,
              postalCode: row.postalCode,
              city: row.city,
              country: row.country,
              isDefault: row.isDefault,
            }))
          );
        }
        return {
          created: plan.creates.length,
          updated: 0,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },

    // --- Supplier contact and delivery address imports — mirrors of the
    // customer methods above against supplier_contacts /
    // supplier_delivery_addresses (no country column on either side) ---

    async contactsBySupplier(supplierIds: string[]): Promise<Map<string, ExistingSupplierContact[]>> {
      const map = new Map<string, ExistingSupplierContact[]>();
      for (const part of chunk([...new Set(supplierIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            supplierId: supplierContacts.supplierId,
            id: supplierContacts.id,
            name: supplierContacts.name,
            isPrimary: supplierContacts.isPrimary,
          })
          .from(supplierContacts)
          .where(inArray(supplierContacts.supplierId, part));
        for (const row of rows) {
          const list = map.get(row.supplierId) ?? [];
          list.push({ id: row.id, name: row.name, isPrimary: row.isPrimary });
          map.set(row.supplierId, list);
        }
      }
      return map;
    },

    // Create-only, ONE transaction; the partial unique index
    // (supplier_contacts_one_primary) is never hit because the planner
    // guarantees at most one isPrimary per supplier, DB state included.
    async executeSupplierContactPlan(plan: SupplierContactImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(supplierContacts).values(
            part.map((row) => ({
              supplierId: row.supplierId,
              name: row.name,
              isPrimary: row.isPrimary,
              phone: row.phone,
              mobile: row.mobile,
              email: row.email,
              comment: row.comment,
            }))
          );
        }
        return {
          created: plan.creates.length,
          updated: 0,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },

    // The supplier's OWN address — the skip rule ("same as the supplier's
    // address") reads it, so unlike suppliersByNumber this carries the
    // address fields too.
    async supplierAddressesByNumber(numbers: string[]): Promise<Map<string, ExistingSupplierAddress>> {
      const map = new Map<string, ExistingSupplierAddress>();
      for (const part of chunk([...new Set(numbers)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            supplierNumber: suppliers.supplierNumber,
            id: suppliers.id,
            address: suppliers.address,
            postalCode: suppliers.postalCode,
            city: suppliers.city,
          })
          .from(suppliers)
          .where(inArray(suppliers.supplierNumber, part));
        for (const row of rows) {
          map.set(row.supplierNumber, {
            id: row.id,
            address: row.address,
            postalCode: row.postalCode,
            city: row.city,
          });
        }
      }
      return map;
    },

    async deliveryAddressesBySupplier(
      supplierIds: string[]
    ): Promise<Map<string, ExistingSupplierDeliveryAddress[]>> {
      const map = new Map<string, ExistingSupplierDeliveryAddress[]>();
      for (const part of chunk([...new Set(supplierIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            supplierId: supplierDeliveryAddresses.supplierId,
            address: supplierDeliveryAddresses.address,
            postalCode: supplierDeliveryAddresses.postalCode,
            city: supplierDeliveryAddresses.city,
            isDefault: supplierDeliveryAddresses.isDefault,
          })
          .from(supplierDeliveryAddresses)
          .where(inArray(supplierDeliveryAddresses.supplierId, part));
        for (const row of rows) {
          const list = map.get(row.supplierId) ?? [];
          list.push({
            address: row.address,
            postalCode: row.postalCode,
            city: row.city,
            isDefault: row.isDefault,
          });
          map.set(row.supplierId, list);
        }
      }
      return map;
    },

    // Create-only, ONE transaction; the partial unique index
    // (supplier_delivery_addresses_one_default) is never hit because the
    // planner guarantees at most one isDefault per supplier across the
    // whole file, DB state included.
    async executeSupplierDeliveryAddressPlan(plan: SupplierDeliveryAddressImportPlan) {
      return db.transaction(async (tx) => {
        for (const part of chunk(plan.creates)) {
          if (part.length === 0) continue;
          await tx.insert(supplierDeliveryAddresses).values(
            part.map((row) => ({
              supplierId: row.supplierId,
              label: row.label,
              address: row.address,
              postalCode: row.postalCode,
              city: row.city,
              isDefault: row.isDefault,
            }))
          );
        }
        return {
          created: plan.creates.length,
          updated: 0,
          registersCreated: { units: [] as string[], articleGroups: [] as string[] },
        };
      });
    },
  };
}

export type ImportRepository = ReturnType<typeof createImportRepository>;
