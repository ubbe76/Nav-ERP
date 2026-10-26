import { asc, count, eq, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  articleCodes,
  articles,
  articleUnits,
  bomComponents,
  carriers,
  companyCarriers,
  costCalculationMaterialRows,
  customers,
  deliveryTerms,
  deviationEvents,
  deviationReasons,
  deviations,
  inquiries,
  inquiryRows,
  invoiceRows,
  invoices,
  moMaterialConsumptions,
  moOperationScrap,
  packageTypes,
  paymentTerms,
  purchaseOrderRows,
  purchaseOrders,
  quoteLossReasons,
  salesOrderRows,
  salesOrders,
  suppliers,
  units,
  type Db,
  type Tx,
} from "@navet/db";
import type {
  CreateRegisterEntryInput,
  DeviationReasonInput,
  PackageTypeFreightInput,
  QuoteLossReasonInput,
  UpdateRegisterEntryInput,
} from "@navet/shared";
import { isForeignKeyViolation } from "../../system/service/db-errors.js";
import { InvalidReplacementError, RegisterEntryInUseError, type RegisterUsage } from "../service/register.errors.js";

// The five terms-style registers share the exact same column shape, so one
// table-parameterized accessor serves all of them. The casts below are safe
// for the same reason — identical columns. quote_loss_reasons differs
// (active, no description): it reuses the id/code/name machinery and gets
// its own create/update below.
type RegisterTable = typeof deliveryTerms;

// One column somewhere in the schema that points at a register table — the
// reference map below is the single place that knows who uses a register
// entry, and it drives both the usage summary and the reassign-then-delete.
// EVERY new FK to a register table must be added here (the FK's onDelete:
// "restrict" still guards the database; a missing entry here just turns the
// friendly flow into a 409 at the final DELETE).
//
// `uniqueWith` marks a link table where (column, ...uniqueWith) is unique:
// moving such a row onto the replacement would collide when the replacement
// already has one for the same key, so those source rows are DROPPED instead
// (merge semantics) — company_carriers is unique on the carrier alone (empty
// uniqueWith), article_units on (article_id, unit_id).
interface RegisterReference {
  table: PgTable;
  tableName: string;
  // Swedish plural/singular for the UI's "Posten används av: 3 kunder" /
  // "1 kund" lines.
  label: string;
  labelOne: string;
  column: PgColumn;
  uniqueWith?: PgColumn[];
}

// `labels` is written "singular|plural" to keep the map readable.
function ref(table: PgTable, tableName: string, labels: string, column: PgColumn, uniqueWith?: PgColumn[]): RegisterReference {
  const [labelOne, label] = labels.split("|") as [string, string];
  return uniqueWith
    ? { table, tableName, label, labelOne, column, uniqueWith }
    : { table, tableName, label, labelOne, column };
}

const PARTNER_AND_DOCUMENT_REFERENCES = {
  deliveryTerm: [
    ref(customers, "customers", "kund|kunder", customers.deliveryTermId),
    ref(suppliers, "suppliers", "leverantör|leverantörer", suppliers.deliveryTermId),
    ref(salesOrders, "sales_orders", "kundorder|kundorder", salesOrders.deliveryTermId),
    ref(purchaseOrders, "purchase_orders", "inköpsorder|inköpsorder", purchaseOrders.deliveryTermId),
    ref(inquiries, "inquiries", "förfrågan|förfrågningar", inquiries.deliveryTermId),
  ],
  paymentTerm: [
    ref(customers, "customers", "kund|kunder", customers.paymentTermId),
    ref(suppliers, "suppliers", "leverantör|leverantörer", suppliers.paymentTermId),
    ref(salesOrders, "sales_orders", "kundorder|kundorder", salesOrders.paymentTermId),
    ref(purchaseOrders, "purchase_orders", "inköpsorder|inköpsorder", purchaseOrders.paymentTermId),
    ref(inquiries, "inquiries", "förfrågan|förfrågningar", inquiries.paymentTermId),
    // The invoice's printed term text is snapshotted (payment_term_code/name)
    // at issue — moving the FK never rewrites what an issued invoice says.
    ref(invoices, "invoices", "faktura|fakturor", invoices.paymentTermId),
  ],
  carrier: [
    ref(customers, "customers", "kund|kunder", customers.carrierId),
    ref(suppliers, "suppliers", "leverantör|leverantörer", suppliers.carrierId),
    ref(salesOrders, "sales_orders", "kundorder|kundorder", salesOrders.carrierId),
    ref(purchaseOrders, "purchase_orders", "inköpsorder|inköpsorder", purchaseOrders.carrierId),
    ref(inquiries, "inquiries", "förfrågan|förfrågningar", inquiries.carrierId),
    ref(companyCarriers, "company_carriers", "företagets speditörskonto|företagets speditörskonton", companyCarriers.carrierId, []),
  ],
} satisfies Record<string, RegisterReference[]>;

export const REGISTER_REFERENCES: Record<
  | "deliveryTerms"
  | "paymentTerms"
  | "carriers"
  | "units"
  | "packageTypes"
  | "quoteLossReasons"
  | "deviationReasons"
  | "articleCodes",
  RegisterReference[]
> = {
  deliveryTerms: PARTNER_AND_DOCUMENT_REFERENCES.deliveryTerm,
  paymentTerms: PARTNER_AND_DOCUMENT_REFERENCES.paymentTerm,
  carriers: PARTNER_AND_DOCUMENT_REFERENCES.carrier,
  // Units: rows keep their own unit_factor snapshot — a reassignment only
  // swaps the unit reference, which is exactly right for merging duplicates
  // ("ST" → "st") and wrong for merging different units; the manual says so.
  units: [
    ref(articles, "articles", "artikel (grundenhet)|artiklar (grundenhet)", articles.unitId),
    ref(articles, "articles", "artikel (inköpsenhet)|artiklar (inköpsenhet)", articles.purchaseUnitId),
    ref(articles, "articles", "artikel (försäljningsenhet)|artiklar (försäljningsenhet)", articles.salesUnitId),
    ref(articleUnits, "article_units", "artikelenhet|artikelenheter", articleUnits.unitId, [articleUnits.articleId]),
    ref(bomComponents, "bom_components", "strukturrad|strukturrader", bomComponents.unitId),
    ref(moMaterialConsumptions, "mo_material_consumptions", "materialuttag|materialuttag", moMaterialConsumptions.unitId),
    ref(purchaseOrderRows, "purchase_order_rows", "inköpsorderrad|inköpsorderrader", purchaseOrderRows.unitId),
    ref(inquiryRows, "inquiry_rows", "förfrågningsrad|förfrågningsrader", inquiryRows.unitId),
    ref(salesOrderRows, "sales_order_rows", "kundorderrad|kundorderrader", salesOrderRows.unitId),
    ref(invoiceRows, "invoice_rows", "fakturarad|fakturarader", invoiceRows.unitId),
    ref(costCalculationMaterialRows, "cost_calculation_material_rows", "kalkylrad|kalkylrader", costCalculationMaterialRows.unitId),
  ],
  packageTypes: [ref(articles, "articles", "artikel|artiklar", articles.packageTypeId)],
  // Artikelkoder: the articles carrying the code (selection/grouping only).
  articleCodes: [ref(articles, "articles", "artikel|artiklar", articles.articleCodeId)],
  // Förlustorsaker: the lost quotes carrying the reason (reopen clears it).
  quoteLossReasons: [ref(salesOrders, "sales_orders", "förlorad offert|förlorade offerter", salesOrders.lostReasonId)],
  // Avvikelseorsaker (Kvalitet): the cases and the scrap rows carrying it.
  deviationReasons: [
    ref(deviations, "deviations", "avvikelse|avvikelser", deviations.reasonId),
    ref(moOperationScrap, "mo_operation_scrap", "kassationsrad|kassationsrader", moOperationScrap.reasonId),
  ],
};

// A register's own step inside the delete transaction, before the
// referencing rows move: refuse a replacement that cannot carry them, and
// write what the move needs besides the UPDATE (history rows).
type BeforeReassign = (tx: Tx, id: string, replacementId: string, userId: string | null) => Promise<void>;

export function createRegisterRepository(db: Db) {
  function forTable(table: RegisterTable, references: RegisterReference[], beforeReassign?: BeforeReassign) {
    async function countReferences(executor: Db, id: string): Promise<RegisterUsage> {
      const found: RegisterUsage["references"] = [];
      for (const r of references) {
        const [row] = await executor.select({ n: count() }).from(r.table).where(eq(r.column, id));
        const n = Number(row?.n ?? 0);
        if (n > 0) found.push({ table: r.tableName, label: r.label, labelOne: r.labelOne, count: n });
      }
      return { total: found.reduce((sum, r) => sum + r.count, 0), references: found };
    }

    return {
      async list() {
        return db.select().from(table).orderBy(asc(table.code));
      },

      async findById(id: string) {
        const [row] = await db.select().from(table).where(eq(table.id, id));
        return row ?? null;
      },

      async findByCode(code: string) {
        const [row] = await db.select().from(table).where(eq(table.code, code));
        return row ?? null;
      },

      async findByName(name: string) {
        const [row] = await db.select().from(table).where(eq(table.name, name));
        return row ?? null;
      },

      async create(input: CreateRegisterEntryInput) {
        const [row] = await db.insert(table).values(input).returning();
        return row!;
      },

      async update(id: string, input: UpdateRegisterEntryInput) {
        const [row] = await db.update(table).set(input).where(eq(table.id, id)).returning();
        return row ?? null;
      },

      // Seed helper: inserts the entry unless its code or name already
      // exists (any conflict skips — existing entries are never touched).
      // Returns true when a row was actually created.
      async createIfMissing(input: CreateRegisterEntryInput) {
        const rows = await db.insert(table).values(input).onConflictDoNothing().returning();
        return rows.length > 0;
      },

      async exists(id: string) {
        const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id));
        return row !== undefined;
      },

      // What still points at the entry, per referencing column (count > 0 only).
      async countReferences(id: string) {
        return countReferences(db, id);
      },

      // Moves every referencing row to `replacementId` (when given) and then
      // deletes the entry — one transaction, so a failure anywhere leaves
      // both the references and the entry exactly as they were. Unique link
      // tables get merge semantics (see RegisterReference.uniqueWith). The
      // final DELETE's FK violation is the race guard: a row linked to the
      // entry after its reassignment (or with no replacement given) makes
      // Postgres refuse, and that surfaces as RegisterEntryInUseError.
      async deleteWithReassign(id: string, replacementId: string | null, userId: string | null = null) {
        const entry = await this.findById(id);
        if (!entry) return null;
        try {
          return await db.transaction(async (tx) => {
            const moved: { table: string; count: number }[] = [];
            if (replacementId) {
              if (beforeReassign) await beforeReassign(tx, id, replacementId, userId);
              for (const r of references) {
                const column = sql.identifier(r.column.name);
                if (r.uniqueWith !== undefined) {
                  // Drop the source rows whose key the replacement already
                  // holds — moving them would violate the unique constraint.
                  const sameKey = r.uniqueWith.map(
                    (k) => sql`dst.${sql.identifier(k.name)} = src.${sql.identifier(k.name)}`
                  );
                  const keyMatch = sameKey.length > 0 ? sql` AND ${sql.join(sameKey, sql` AND `)}` : sql``;
                  await tx.execute(
                    sql`DELETE FROM ${r.table} AS src WHERE src.${column} = ${id} AND EXISTS (SELECT 1 FROM ${r.table} AS dst WHERE dst.${column} = ${replacementId}${keyMatch})`
                  );
                }
                const [before] = await tx.select({ n: count() }).from(r.table).where(eq(r.column, id));
                const n = Number(before?.n ?? 0);
                if (n === 0) continue;
                await tx.execute(sql`UPDATE ${r.table} SET ${column} = ${replacementId} WHERE ${column} = ${id}`);
                moved.push({ table: r.tableName, count: n });
              }
            }
            await tx.delete(table).where(eq(table.id, id));
            return { moved };
          });
        } catch (err) {
          if (isForeignKeyViolation(err)) {
            throw new RegisterEntryInUseError(entry.code, await countReferences(db, id));
          }
          throw err;
        }
      },
    };
  }

  // Förlustorsaker: the generic id/code/name accessor (list, lookups, usage,
  // delete with reassign) with create/update on the register's own shape.
  const lossReasonsBase = forTable(quoteLossReasons as unknown as RegisterTable, REGISTER_REFERENCES.quoteLossReasons);
  const lossReasons = {
    ...lossReasonsBase,
    async list() {
      return db.select().from(quoteLossReasons).orderBy(asc(quoteLossReasons.code));
    },
    async findById(id: string) {
      const [row] = await db.select().from(quoteLossReasons).where(eq(quoteLossReasons.id, id));
      return row ?? null;
    },
    async findByCode(code: string) {
      const [row] = await db.select().from(quoteLossReasons).where(eq(quoteLossReasons.code, code));
      return row ?? null;
    },
    async findByName(name: string) {
      const [row] = await db.select().from(quoteLossReasons).where(eq(quoteLossReasons.name, name));
      return row ?? null;
    },
    async create(input: QuoteLossReasonInput) {
      const [row] = await db.insert(quoteLossReasons).values(input).returning();
      return row!;
    },
    async update(id: string, input: QuoteLossReasonInput) {
      const [row] = await db
        .update(quoteLossReasons)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(quoteLossReasons.id, id))
        .returning();
      return row ?? null;
    },
  };

  // Avvikelseorsaker: the same generic machinery with the register's own
  // shape (the four "applies to" flags + active).
  // The replacement must be able to carry what moves: active, and applying
  // to every case type among the moved cases (and to Kassation when scrap
  // rows move) — otherwise a customer case would end up with a scrap-only
  // or inactive reason the case card itself refuses. The replacement is
  // locked FOR SHARE so its flags cannot change before the commit. Every
  // moved case — closed and cancelled included, the reason has to go — gets
  // an `updated` history row like a PATCH (via: "register-replace").
  const beforeDeviationReasonReassign: BeforeReassign = async (tx, id, replacementId, userId) => {
    const [replacement] = await tx.select().from(deviationReasons).where(eq(deviationReasons.id, replacementId)).for("share");
    if (!replacement) throw new InvalidReplacementError("unknown");
    const moved = await tx
      .select({ id: deviations.id, type: deviations.type })
      .from(deviations)
      .where(eq(deviations.reasonId, id))
      .for("update");
    const [scrap] = await tx.select({ n: count() }).from(moOperationScrap).where(eq(moOperationScrap.reasonId, id));
    const scrapMoves = Number(scrap?.n ?? 0) > 0;
    if (moved.length === 0 && !scrapMoves) return;
    if (!replacement.active) throw new InvalidReplacementError("inactive", `Ersättaren ${replacement.name} är inaktiv`);
    const missing: string[] = [];
    const types = new Set(moved.map((m) => m.type));
    if (types.has("customer") && !replacement.appliesCustomer) missing.push("kundreklamationer");
    if (types.has("supplier") && !replacement.appliesSupplier) missing.push("leverantörsavvikelser");
    if (types.has("internal") && !replacement.appliesInternal) missing.push("interna avvikelser");
    if (scrapMoves && !replacement.appliesScrap) missing.push("kassation");
    if (missing.length > 0) {
      const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} och ${missing.at(-1)}`;
      throw new InvalidReplacementError("not-applicable", `Ersättaren ${replacement.name} gäller inte ${list}`);
    }
    if (moved.length === 0) return;
    await tx.insert(deviationEvents).values(
      moved.map((m) => ({
        deviationId: m.id,
        event: "updated" as const,
        detail: { changes: { reasonId: { before: id, after: replacementId } }, via: "register-replace" },
        userId,
      }))
    );
    await tx
      .update(deviations)
      .set({ updatedAt: sql`now()` })
      .where(eq(deviations.reasonId, id));
  };
  const deviationReasonsBase = forTable(
    deviationReasons as unknown as RegisterTable,
    REGISTER_REFERENCES.deviationReasons,
    beforeDeviationReasonReassign
  );
  const deviationReasonEntries = {
    ...deviationReasonsBase,
    async list() {
      return db.select().from(deviationReasons).orderBy(asc(deviationReasons.code));
    },
    async findById(id: string) {
      const [row] = await db.select().from(deviationReasons).where(eq(deviationReasons.id, id));
      return row ?? null;
    },
    async findByCode(code: string) {
      const [row] = await db.select().from(deviationReasons).where(eq(deviationReasons.code, code));
      return row ?? null;
    },
    async findByName(name: string) {
      const [row] = await db.select().from(deviationReasons).where(eq(deviationReasons.name, name));
      return row ?? null;
    },
    async create(input: DeviationReasonInput) {
      const [row] = await db.insert(deviationReasons).values(input).returning();
      return row!;
    },
    async update(id: string, input: DeviationReasonInput) {
      const [row] = await db
        .update(deviationReasons)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(deviationReasons.id, id))
        .returning();
      return row ?? null;
    },
  };

  return {
    deliveryTerms: forTable(deliveryTerms, REGISTER_REFERENCES.deliveryTerms),
    paymentTerms: forTable(paymentTerms as unknown as RegisterTable, REGISTER_REFERENCES.paymentTerms),
    carriers: forTable(carriers as unknown as RegisterTable, REGISTER_REFERENCES.carriers),
    units: forTable(units as unknown as RegisterTable, REGISTER_REFERENCES.units),
    packageTypes: forTable(packageTypes as unknown as RegisterTable, REGISTER_REFERENCES.packageTypes),
    articleCodes: forTable(articleCodes as unknown as RegisterTable, REGISTER_REFERENCES.articleCodes),
    quoteLossReasons: lossReasons,
    deviationReasons: deviationReasonEntries,
    // Kollitypens fraktfält (frakt) — outside the generic code/name register.
    async updatePackageTypeFreight(id: string, input: PackageTypeFreightInput) {
      const num = (v: number | null) => (v === null ? null : String(v));
      const [row] = await db
        .update(packageTypes)
        .set({
          parcelKind: input.parcelKind,
          lengthMm: num(input.lengthMm),
          widthMm: num(input.widthMm),
          heightMm: num(input.heightMm),
          tareWeight: num(input.tareWeight),
          stackable: input.stackable,
          loadingMeters: num(input.loadingMeters),
        })
        .where(eq(packageTypes.id, id))
        .returning();
      return row ?? null;
    },
  };
}

export type RegisterRepository = ReturnType<typeof createRegisterRepository>;
