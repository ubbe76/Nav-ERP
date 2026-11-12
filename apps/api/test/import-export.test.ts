import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import {
  articleCodes,
  articleDrawingRevisions,
  articleDrawings,
  articleGroups,
  articleRevisions,
  articleSupplierPriceBreaks,
  articleSuppliers,
  articleUnits,
  articles,
  bomComponents,
  carriers,
  customerArticleNumbers,
  customerContacts,
  customerDeliveryAddresses,
  customerPrices,
  customers,
  db,
  deliveryTerms,
  paymentTerms,
  permissionGroups,
  priceLists,
  productionGroups,
  routingOperations,
  stockLocations,
  stockTransactions,
  supplierContacts,
  supplierDeliveryAddresses,
  suppliers,
  units,
  warehouses,
  workCenters,
} from "@navet/db";
import {
  CUSTOMER_IMPORT_ENTITY_ORDER,
  IMPORT_ENTITY_ORDER,
  SUPPLIER_IMPORT_ENTITY_ORDER,
  importEntitySchema,
  importExportQuerySchema,
  type ImportCommitInput,
  type ImportEntity,
  type ImportExportQuery,
} from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createImportRepository, runImportDryRun } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { createImportExportRepository } from "../src/modules/import/repository/import-export.repository.js";
import { createImportExportService } from "../src/modules/import/service/import-export.service.js";
import {
  NUMERIC_FIELDS,
  addressCells,
  bomQuantityCell,
  customerPriceExportBlocks,
  invertRounded,
  registerCellTexts,
  renderImportExport,
  routingTimeCells,
  splitImportExportBlocks,
  unitFactorCell,
  type ImportExportBlock,
} from "../src/modules/import/service/import-export.js";
import { IMPORT_FIELD_HELP } from "../src/modules/import/service/field-help.js";
import { IMPORT_TEMPLATES } from "../src/modules/import/service/import-template.js";
import { detectImportEntity } from "../src/modules/import/service/detect.js";
import { parseImportFile } from "../src/modules/import/service/parse-file.js";
import { readStoredZipEntries } from "../src/modules/system/service/xlsx-writer.js";
import { getOrCreateFallbackLocation } from "../src/modules/stock/service/location-resolver.js";
import { readXlsxRows } from "./helpers/read-xlsx.js";
import { testArticleService } from "./helpers/services.js";

// The registers as import files (#35, GET /imports/:entity/export). The
// invariant is the ROUND TRIP: an export read back through the import's own
// path (parse → suggested mapping → preview → commit) creates nothing, has
// no row errors and leaves every table exactly as it was — for each of the
// 16 entities, as CSV and as Excel. Then the article selection, the split
// into several files and the route's access.

const ENTITIES = importEntitySchema.options;

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const imports = createImportService(createImportRepository(db), { dryRun: (fn) => runImportDryRun(db, fn) });
const exportRepo = createImportExportRepository(db);
const exports = createImportExportService(exportRepo, testArticleService);

const TRUNCATE = sql`TRUNCATE article_standard_cost_history, article_supplier_price_history, work_center_rate_history, stock_count_sessions, stock_transactions, stock_locations, warehouses, customer_article_numbers,
  customer_prices, customer_contacts, customer_delivery_addresses, customers, article_supplier_price_breaks, article_suppliers,
  bom_components, routing_operations, work_centers, production_groups, article_units, article_drawing_revisions,
  article_drawings, article_revisions, user_copied_articles, articles, article_groups, supplier_contacts,
  supplier_delivery_addresses, suppliers, audit_log, user_settings, users CASCADE`;

// The shared registers keep their seeded rows — only this file's go.
async function cleanRegisters() {
  await db.delete(units).where(like(units.code, "zx%"));
  await db.delete(articleCodes).where(like(articleCodes.code, "ZX%"));
  await db.delete(paymentTerms).where(like(paymentTerms.code, "ZX%"));
  await db.delete(deliveryTerms).where(like(deliveryTerms.code, "ZX%"));
  await db.delete(carriers).where(like(carriers.code, "ZX%"));
  await db.delete(priceLists).where(like(priceLists.code, "ZX%"));
  await db.delete(permissionGroups).where(like(permissionGroups.code, "ZXEXP%"));
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await cleanRegisters();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await cleanRegisters();
});

// Every table an import could write to, as JSON — `updated_at` aside.
const WATCHED = [
  "articles",
  "article_units",
  "article_revisions",
  "article_drawings",
  "article_drawing_revisions",
  "article_suppliers",
  "article_groups",
  // The histories: a re-import of unchanged values must not write a row.
  "article_standard_cost_history",
  "article_supplier_price_history",
  "work_center_rate_history",
  "article_codes",
  "units",
  "routing_operations",
  "bom_components",
  "customer_prices",
  "customer_article_numbers",
  "stock_transactions",
  "stock_locations",
  "warehouses",
  "customers",
  "customer_contacts",
  "customer_delivery_addresses",
  "suppliers",
  "supplier_contacts",
  "supplier_delivery_addresses",
  "work_centers",
  "production_groups",
  "payment_terms",
  "delivery_terms",
  "carriers",
  "price_lists",
];

async function snapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const table of WATCHED) {
    const result = await db.execute(
      sql`select coalesce(jsonb_agg(to_jsonb(t) - 'updated_at' order by t.id), '[]'::jsonb) as rows from ${sql.identifier(table)} t`
    );
    out[table] = (result as unknown as { rows: unknown }[])[0]!.rows;
  }
  // The inköpspris import replaces a pair's steps as a set (delete + insert,
  // replacePriceBreaks), so their ids are new — the steps are compared.
  const steps = await db.execute(
    sql`select coalesce(jsonb_agg(to_jsonb(t) - 'id' - 'created_at' order by t.article_supplier_id, t.from_quantity), '[]'::jsonb) as rows from article_supplier_price_breaks t`
  );
  out["article_supplier_price_breaks"] = (steps as unknown as { rows: unknown }[])[0]!.rows;
  return out;
}

async function unitId(code: string, name: string) {
  await db.insert(units).values({ code, name }).onConflictDoNothing();
  const [unit] = await db.select({ id: units.id }).from(units).where(eq(units.code, code));
  return unit!.id;
}

// One of everything the 16 imports can express — and the awkward values: a
// number that starts with a formula character, leading zeros, multi-line
// text, a phone number with +, every time unit, lego, a repeated component,
// a row in an alternative unit, stafflade prices in every shape.
async function seed() {
  // The "***" place every article import resolves (and creates) up front.
  await getOrCreateFallbackLocation(db);
  const st = await unitId("st", "Styck");
  const kartong = await unitId("zxkart", "ZX Kartong");
  const kg = await unitId("zxkg", "ZX Kilo");
  const [group] = await db.insert(articleGroups).values({ code: "9871", name: "ZX Exportgrupp" }).returning();
  const [articleCode] = await db.insert(articleCodes).values({ code: "ZX1", name: "ZX Artikelkod" }).returning();
  const [paymentTerm] = await db.insert(paymentTerms).values({ code: "ZX30", name: "ZX 30 dagar netto" }).returning();
  const [deliveryTerm] = await db.insert(deliveryTerms).values({ code: "ZXFCA", name: "ZX Fritt fraktföraren" }).returning();
  // A carrier whose NAME is another carrier's code: the name is ambiguous,
  // so the export names it by its code.
  const [carrier] = await db.insert(carriers).values({ code: "ZXA", name: "ZXB" }).returning();
  await db.insert(carriers).values({ code: "ZXB", name: "ZX Annan speditör" });
  const [priceList] = await db.insert(priceLists).values({ code: "ZXPL", name: "ZX Prislista" }).returning();

  const [s1, s2] = await db
    .insert(suppliers)
    .values([
      {
        supplierNumber: "9001",
        name: "Stålgrossisten AB",
        orgNumber: "556000-0001",
        vatNumber: "SE556000000101",
        contactName: "Sara Stål",
        email: "order@stal.example.com",
        phone: "+46 31 123 45",
        address: "Stålgatan 1\nPort 3",
        postalCode: "411 01",
        city: "Göteborg",
        country: "SE",
        currency: "SEK",
        language: "sv",
        ourCustomerNumber: "K-77",
        paymentTermId: paymentTerm!.id,
        deliveryTermId: deliveryTerm!.id,
        carrierId: carrier!.id,
        carrierCustomerNumber: "123456",
      },
      { supplierNumber: "9002", name: "Lego & Yta GmbH", country: "DE", currency: "EUR", language: "en", active: false },
    ])
    .returning();
  await db.insert(supplierContacts).values([
    { supplierId: s1!.id, name: "Sara Stål", isPrimary: true, phone: "+46 31 123 45", email: "sara@stal.example.com" },
    { supplierId: s1!.id, name: "Olle Order", mobile: "070-111 22 33", comment: "Bara förmiddagar · Fax 031-1" },
  ]);
  await db.insert(supplierDeliveryAddresses).values([
    { supplierId: s1!.id, label: "Hämtlager", address: "Lagervägen 9\nGrind B", postalCode: "411 02", city: "Göteborg", isDefault: true },
    { supplierId: s2!.id, label: "Werk 2", address: "Industriestraße 5", postalCode: "20095", city: "Hamburg" },
  ]);

  const inserted = await db
    .insert(articles)
    .values([
      {
        articleNumber: "EX-100",
        name: "Diskbänk 1200 mm; rostfri",
        type: "manufactured",
        unitId: st,
        groupId: group!.id,
        articleCodeId: articleCode!.id,
        standardCost: "1250.5000",
        weight: "18.500",
        surfaceTreatment: "Borstad",
        colour: "Rostfri",
        extraDescription: "Rad ett\nRad två",
        nameEn: 'Sink unit 48" stainless',
        extraDescriptionEn: "Line one\nLine two",
        barcode: "4006381333931",
        reorderPoint: "5.0000",
        orderQuantity: "10.0000",
        rounding: "2.500",
        safetyStock: "3.0000",
        stockControlled: true,
        forecastControlled: true,
        manufacturingLeadTimeDays: 7,
        quantityPerPackage: "12.0000",
      },
      { articleNumber: "EX-200", name: "Plåt 1,5 mm", type: "purchased", unitId: st, purchaseUnitId: kartong, standardCost: "10.3333" },
      { articleNumber: "EX-300", name: "Montering på plats", type: "service", unitId: st, active: false },
      { articleNumber: "EX-400", name: "Fantomsats", type: "manufactured", isPhantom: true, unitId: st },
      { articleNumber: "-EX-500", name: "=Formel + text", type: "purchased", unitId: st },
      { articleNumber: "007", name: "Skruv M6", type: "purchased", unitId: st, standardCost: "0.2500" },
    ])
    .returning({ id: articles.id, articleNumber: articles.articleNumber });
  const article = new Map(inserted.map((row) => [row.articleNumber, row.id]));
  const id = (number: string) => article.get(number)!;

  await db.insert(articleRevisions).values([
    { articleId: id("EX-100"), revision: "A" },
    { articleId: id("EX-100"), revision: "B", isActive: true },
  ]);
  const [drawing] = await db.insert(articleDrawings).values({ articleId: id("EX-100"), drawingNumber: "R-100" }).returning();
  await db.insert(articleDrawingRevisions).values([
    { drawingId: drawing!.id, revision: "1" },
    { drawingId: drawing!.id, revision: "2", isActive: true },
  ]);

  // 12 st per kartong (quantity_per_base 1/12, six decimals) and 0,4 st per kg.
  await db.insert(articleUnits).values([
    { articleId: id("EX-200"), unitId: kartong, quantityPerBase: "0.083333" },
    { articleId: id("EX-200"), unitId: kg, quantityPerBase: "2.500000" },
  ]);

  const [as1] = await db
    .insert(articleSuppliers)
    .values([
      { articleId: id("EX-200"), supplierId: s1!.id, supplierArticleNumber: "L-1", price: "10.5000", leadTimeDays: 14, isPrimary: true },
      { articleId: id("EX-200"), supplierId: s2!.id, currency: "EUR" },
      { articleId: id("007"), supplierId: s1!.id, price: "0.2000" },
    ])
    .returning();
  await db.insert(articleSupplierPriceBreaks).values([
    { articleSupplierId: as1!.id, fromQuantity: "100.0000", price: "8.2500" },
    { articleSupplierId: as1!.id, fromQuantity: "10.0000", price: "9.5000" },
  ]);

  const [avdelning] = await db.insert(productionGroups).values({ code: "ZXAVD", name: "Plåtverkstad", description: "Hall 2" }).returning();
  await db.insert(productionGroups).values({ code: "ZXTOM", name: "Utan resurser", active: false });
  const [wc110, wc120, wc910] = await db
    .insert(workCenters)
    .values([
      {
        code: "110",
        name: "Kantpress",
        type: "machine",
        productionGroupId: avdelning!.id,
        hourlyRate: "650.50",
        calcRate1: "700.00",
        calcRate2: "725.25",
        rateAppliesToSetup: true,
        rateAppliesToRun: false,
        defaultSetupTime: "12.50",
        defaultOperationName: "Kantpressning",
      },
      { code: "120", name: "Montering", type: "personnel", hourlyRate: "480.00", active: false },
      {
        code: "910",
        name: "Extern betning",
        type: "subcontract",
        supplierId: s2!.id,
        leadTimeDays: "5.0",
        queueTimeDays: "1.5",
        orderLeadTimeDays: "2.0",
      },
    ])
    .returning();

  const operations = await db
    .insert(routingOperations)
    .values([
      {
        articleId: id("EX-100"),
        sequenceNo: 10,
        workCenterId: wc110!.id,
        setupTime: "15.00",
        runTimePerUnit: "2.5000",
        cycleTimePerUnit: "1.2500",
        description: "Kantpressning",
        comment: "Kontrollera måtten\nmot ritningen",
        // The import's checkbox is off in the round trip — the setting must survive it.
        printOnWorkCard: true,
        packingInstructions: "Mellanlägg",
      },
      // 7 st/h = 8,5714 min/st; ställtid 0,2 h.
      { articleId: id("EX-100"), sequenceNo: 20, workCenterId: wc120!.id, setupTime: "12.00", runTimePerUnit: "8.5714", cycleTimePerUnit: "4.0000", timeUnit: "units_per_hour" },
      // 7 s = 0,1167 min/st.
      { articleId: id("EX-100"), sequenceNo: 30, workCenterId: wc110!.id, setupTime: "0.50", runTimePerUnit: "0.1167", cycleTimePerUnit: "0.0500", timeUnit: "seconds_per_unit" },
      {
        articleId: id("EX-100"),
        sequenceNo: 40,
        workCenterId: wc910!.id,
        setupTime: "0.00",
        runTimePerUnit: "0.0000",
        subcontractSupplierId: s2!.id,
        setupPrice: "500.00",
        unitPrice: "12.3456",
        transportPrice: "250.00",
        showNetWeight: true,
      },
      { articleId: id("EX-100"), sequenceNo: 50, workCenterId: wc110!.id, setupTime: "5.00", runTimePerUnit: "1.0000", costingOnly: true },
    ])
    .returning();
  const operation = (sequenceNo: number) => operations.find((op) => op.sequenceNo === sequenceNo)!.id;

  // Structure rows in a fixed order (created_at is the structure's order).
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
  await db.insert(bomComponents).values([
    // 2 kartonger (2 / 0,083333 = 24,0001 st), drawn at operation 10.
    { parentArticleId: id("EX-100"), componentArticleId: id("EX-200"), quantity: "24.0001", unitId: kartong, unitFactor: "0.083333", routingOperationId: operation(10), position: "1", createdAt: at(1) },
    { parentArticleId: id("EX-100"), componentArticleId: id("007"), quantity: "3.5000", createdAt: at(2) },
    // The same component again, without Pos.
    { parentArticleId: id("EX-100"), componentArticleId: id("EX-200"), quantity: "1.0000", createdAt: at(3) },
    { parentArticleId: id("EX-100"), componentArticleId: id("-EX-500"), quantity: "0.3333", costingOnly: true, routingOperationId: operation(50), position: "K", createdAt: at(4) },
    { parentArticleId: id("EX-400"), componentArticleId: id("007"), quantity: "2.0000", createdAt: at(5) },
  ]);

  const [c1, c2] = await db
    .insert(customers)
    .values([
      {
        customerNumber: "5001",
        name: "Storkök & Co AB",
        orgNumber: "556111-2222",
        vatNumber: "SE556111222201",
        contactName: "Karin Kök",
        email: "karin@storkok.example.com",
        phone: "+46 70 123 45 67",
        address: "Köksvägen 1\nBox 12\nHus C",
        postalCode: "123 45",
        city: "Stockholm",
        country: "SE",
        paymentTermId: paymentTerm!.id,
        deliveryTermId: deliveryTerm!.id,
        carrierId: carrier!.id,
        priceListId: priceList!.id,
        discountPercent: "7.50",
        invoiceName: "Storkök Fakturor",
        invoiceAddress: "Fakturagatan 2",
        invoicePostalCode: "123 46",
        invoiceCity: "Stockholm",
        invoiceCountry: "SE",
        invoiceEmail: "faktura@storkok.example.com",
        ourSupplierNumber: "L-900",
        collectiveInvoicing: true,
        invoiceOnHold: true,
        website: "https://storkok.example.com",
      },
      { customerNumber: "5002", name: "Pelle Privat", orgNumber: "19800101-1234", privatePerson: true, address: "Hemvägen 3" },
      { customerNumber: "5003", name: "Old Kitchen Ltd", country: "GB", currency: "EUR", language: "en", active: false },
    ])
    .returning();
  await db.insert(customerContacts).values([
    { customerId: c1!.id, name: "Karin Kök", isPrimary: true, phone: "+46 70 123 45 67", email: "karin@storkok.example.com" },
    { customerId: c1!.id, name: "Inköp", mobile: "-", comment: "Ring efter 13" },
    { customerId: c2!.id, name: "Pelle Privat" },
  ]);
  await db.insert(customerDeliveryAddresses).values([
    { customerId: c1!.id, label: "Lastkaj", address: "Kajvägen 4\nPort 2", postalCode: "123 47", city: "Stockholm", country: "SE", isDefault: true },
    { customerId: c1!.id, label: "Oslo", address: "Havnegata 1", postalCode: "0150", city: "Oslo", country: "NO" },
    { customerId: c1!.id, label: "Engång", address: "Tillfällig väg 9", city: "Solna", oneOff: true },
  ]);
  await db.insert(customerPrices).values([
    // A price at antal 1 with a ställpris.
    { customerId: c1!.id, articleId: id("EX-100"), unitPrice: "1500.0000", setupPrice: "200.0000" },
    // Price + two steps, all with the same ställpris.
    { customerId: c1!.id, articleId: id("007"), unitPrice: "5.0000", setupPrice: "50.0000" },
    { customerId: c1!.id, articleId: id("007"), fromQuantity: "100.0000", unitPrice: "4.0000", setupPrice: "50.0000" },
    { customerId: c1!.id, articleId: id("007"), fromQuantity: "10.0000", unitPrice: "4.5000", setupPrice: "50.0000" },
    // 0 kr at antal 1 beside a step — a Pris 0 would remove the rule.
    { customerId: c1!.id, articleId: id("EX-200"), unitPrice: "0.0000" },
    { customerId: c1!.id, articleId: id("EX-200"), fromQuantity: "50.0000", unitPrice: "9.0000", setupPrice: "25.0000" },
    // Steps only: no price below the first step.
    { customerId: c2!.id, articleId: id("EX-100"), fromQuantity: "10.0000", unitPrice: "1400.0000" },
    // A discount rule is not an import value.
    { customerId: c2!.id, articleId: id("EX-300"), discountPercent: "10.00" },
    { customerId: c2!.id, articleGroupId: group!.id, discountPercent: "5.00" },
  ]);
  await db.insert(customerArticleNumbers).values([
    { customerId: c1!.id, articleId: id("EX-100"), customerArticleNumber: "SK-1200" },
    // Only the customer's article number.
    { customerId: c2!.id, articleId: id("007"), customerArticleNumber: "0042" },
  ]);

  const [warehouse] = await db.insert(warehouses).values({ name: "ZX Lager" }).returning();
  const [a1, a2] = await db
    .insert(stockLocations)
    .values([
      { warehouseId: warehouse!.id, name: "A1" },
      { warehouseId: warehouse!.id, name: "A2" },
    ])
    .returning();
  await db.insert(stockTransactions).values([
    { articleId: id("EX-200"), locationId: a1!.id, quantityDelta: "10.0000", unitCost: "10.0000", transactionType: "inventory_adjustment" },
    { articleId: id("EX-200"), locationId: a1!.id, quantityDelta: "-2.5000", transactionType: "inventory_adjustment" },
    { articleId: id("007"), locationId: a2!.id, quantityDelta: "100.0000", unitCost: "0.2500", transactionType: "inventory_adjustment" },
    // In and out again: no balance, no row.
    { articleId: id("007"), locationId: a1!.id, quantityDelta: "3.0000", transactionType: "inventory_adjustment" },
    { articleId: id("007"), locationId: a1!.id, quantityDelta: "-3.0000", transactionType: "inventory_adjustment" },
  ]);

  return { id, group: group!, kartong };
}

const query = (input: Record<string, string> = {}): ImportExportQuery => importExportQuerySchema.parse(input);

const asBuffer = (content: string | Buffer) => (typeof content === "string" ? Buffer.from(content, "utf8") : content);

// The wizard's options for a file of rows that all exist: the two
// create-only imports with an update mode use it; the rest upsert or skip.
const OPTIONS: Partial<Record<ImportEntity, Partial<ImportCommitInput>>> = {
  routing: { updateExisting: true },
  bom: { updateExisting: true },
};

// The file through the import's own path, as the wizard does it.
async function importInput(entity: ImportEntity, file: Buffer): Promise<ImportCommitInput> {
  const parsed = await imports.parse(entity, file);
  // Every heading is recognised as its own field, in the template's order.
  expect(Object.values(parsed.suggestedMapping), `${entity}: mapping`).toEqual(IMPORT_FIELD_HELP[entity].map((f) => f.field));
  return { mapping: parsed.suggestedMapping, rows: parsed.rows, ...OPTIONS[entity] };
}

// Expected rows per entity in the seeded register — a test that exported
// nothing would pass the round trip trivially.
const SEEDED_ROWS: Record<ImportEntity, number> = {
  articles: 6,
  articleUnits: 3, // the base unit's row + two alternative units
  routing: 5,
  bom: 5,
  supplierPrices: 4, // EX-200/9001 with two steps = 2 rows, EX-200/9002, 007/9001
  customerPrices: 7,
  stockBalances: 2,
  customers: 3,
  customerContacts: 3,
  customerDeliveryAddresses: 2, // not the one-off address
  suppliers: 2,
  supplierContacts: 2,
  supplierDeliveryAddresses: 2,
  workCenters: 2,
  legoWorkCenters: 1,
  productionGroups: 2,
};

describe("import exports — the round trip", () => {
  for (const format of ["csv", "xlsx"] as const) {
    for (const entity of ENTITIES) {
      it(`${entity} as ${format}: importing the export changes nothing`, async () => {
        await seed();
        const before = await snapshot();

        const file = await exports.exportFile(entity, query({ format }));
        expect(file.partCount).toBe(1);
        expect(file.rowCount).toBe(SEEDED_ROWS[entity]);
        expect(file.filename).toMatch(new RegExp(`^export-[a-z]+-\\d{4}-\\d{2}-\\d{2}\\.${format}$`));

        const input = await importInput(entity, asBuffer(file.content));
        expect(input.rows.length).toBe(SEEDED_ROWS[entity]);

        const preview = await imports.preview(entity, input);
        expect(
          preview.rows.filter((row) => row.errors.length > 0).map((row) => [row.rowNumber, row.errors]),
          `${entity}: row errors`
        ).toEqual([]);
        expect(preview.summary.create, `${entity}: rows that would be created`).toBe(0);
        expect(Object.values(preview.willCreate).flat(), `${entity}: registers that would be created`).toEqual([]);

        const result = await imports.commit(entity, input);
        expect(result.created).toBe(0);
        expect(await snapshot()).toEqual(before);

        // And the export after the import is the same file.
        const again = await exports.exportFile(entity, query({ format }));
        expect(asBuffer(again.content).equals(asBuffer(file.content))).toBe(true);
      });
    }
  }

  it("the Excel file carries the same rows as the CSV, numbers as numbers and codes as text", async () => {
    await seed();
    for (const entity of ENTITIES) {
      const csv = await parseImportFile(asBuffer((await exports.exportFile(entity, query({ format: "csv" }))).content));
      const xlsx = await parseImportFile(asBuffer((await exports.exportFile(entity, query({ format: "xlsx" }))).content));
      expect(xlsx.sheetName).toBe("Import");
      expect(xlsx.headers).toEqual(csv.headers);
      expect(xlsx.headers).toEqual(IMPORT_FIELD_HELP[entity].map((f) => f.header));
      // The same cells — a number is "2,5" in the CSV and 2.5 in Excel.
      expect(xlsx.rows.map((row) => row.map((cell) => cell.replace(".", ",")))).toEqual(
        csv.rows.map((row) => row.map((cell) => cell.replace(".", ",")))
      );
    }
    const rows = await readXlsxRows(asBuffer((await exports.exportFile("articles", query({ format: "xlsx" }))).content));
    const header = rows[0] as string[];
    const cell = (articleNumber: string, heading: string) =>
      rows.find((row) => row[0] === articleNumber)![header.indexOf(heading)];
    expect(cell("007", "Artikelnummer")).toBe("007");
    expect(cell("-EX-500", "Benämning")).toBe("=Formel + text");
    expect(cell("EX-100", "Standardpris")).toBe(1250.5);
    expect(cell("EX-100", "Avrundning")).toBe(2.5);
    expect(cell("EX-100", "EAN")).toBe("4006381333931");
    expect(cell("EX-100", "Varugrupp (kod)")).toBe("9871");
  });

  it("writes the values the way each importer reads them", async () => {
    await seed();
    const table = async (entity: ImportEntity) => {
      const parsed = await parseImportFile(asBuffer((await exports.exportFile(entity, query({ format: "csv" }))).content));
      return parsed.rows.map((row) => Object.fromEntries(parsed.headers.map((header, i) => [header, row[i] ?? ""])));
    };

    const articleRows = await table("articles");
    expect(articleRows.find((r) => r["Artikelnummer"] === "EX-100")).toMatchObject({
      Artikeltyp: "Tillverkad",
      Enhet: "st",
      "Varugrupp (kod)": "9871",
      Artikelkod: "ZX1",
      Standardpris: "1250,5",
      "Vikt (kg)": "18,5",
      "Extra benämning": "Rad ett\nRad två",
      Aktiv: "Ja",
      Orderkvantitet: "10",
      Partiformningsregel: "Fast orderstorlek",
      Styrning: "Lagerstyrd",
      Prognosstyrd: "Ja",
      "Ledtid (dagar)": "7",
      Artikelrevision: "B",
      Ritningsnummer: "R-100",
      Ritningsrevision: "2",
    });
    // A purchased article's lead time is its primary supplier's.
    expect(articleRows.find((r) => r["Artikelnummer"] === "EX-200")).toMatchObject({
      Artikeltyp: "Köpt",
      Leverantörsnummer: "9001",
      "Ledtid (dagar)": "14",
      Partiformningsregel: "",
      Styrning: "Orderstyrd",
    });
    expect(articleRows.find((r) => r["Artikelnummer"] === "EX-300")).toMatchObject({ Artikeltyp: "Tjänst", Aktiv: "Nej" });
    expect(articleRows.find((r) => r["Artikelnummer"] === "EX-400")).toMatchObject({ Artikeltyp: "Fiktiv" });

    // Omräkningsfaktor is base units per alternative unit.
    expect(await table("articleUnits")).toEqual([
      { Artikelnummer: "EX-200", Enhet: "st", Omräkningsfaktor: "1", Inköpsenhet: "Nej", Försäljningsenhet: "Ja" },
      { Artikelnummer: "EX-200", Enhet: "zxkart", Omräkningsfaktor: "12", Inköpsenhet: "Ja", Försäljningsenhet: "Nej" },
      { Artikelnummer: "EX-200", Enhet: "zxkg", Omräkningsfaktor: "0,4", Inköpsenhet: "Nej", Försäljningsenhet: "Nej" },
    ]);

    // Each operation in its own time unit; lego without times, with prices.
    const operations = await table("routing");
    expect(operations.map((r) => [r["Sekvensnr"], r["Resurs"], r["Ställtid"], r["Stycktid"], r["Tidsenhet"], r["Cykeltid"], r["Kalkyl"]])).toEqual([
      ["10", "110", "15", "2,5", "minuter/enhet", "1,25", "Nej"],
      ["20", "120", "0,2", "7", "antal/timme", "15", "Nej"],
      ["30", "110", "30", "7", "sekunder/enhet", "3", "Nej"],
      ["40", "910", "", "", "", "", "Nej"],
      ["50", "110", "5", "1", "minuter/enhet", "", "Ja"],
    ]);
    expect(operations[3]).toMatchObject({ Leverantör: "9002", Ställpris: "500", Styckpris: "12,3456", Transportkostnad: "250" });
    expect(operations[0]).toMatchObject({ Kommentar: "Kontrollera måtten\nmot ritningen", Beskrivning: "Kantpressning", Packinstruktion: "Mellanlägg" });

    // Antal in the row's unit, the rows in the structure's order.
    const structure = await table("bom");
    expect(structure.map((r) => [r["Artikelnummer"], r["Komponentnummer"], r["Antal"], r["Enhet"], r["Operation"], r["Pos."], r["Kalkyl"]])).toEqual([
      ["EX-100", "EX-200", "2", "zxkart", "10", "1", "Nej"],
      ["EX-100", "007", "3,5", "st", "", "", "Nej"],
      ["EX-100", "EX-200", "1", "st", "", "", "Nej"],
      ["EX-100", "-EX-500", "0,3333", "st", "50", "K", "Ja"],
      ["EX-400", "007", "2", "st", "", "", "Nej"],
    ]);
    expect(structure[1]).toMatchObject({ Komponentbenämning: "Skruv M6", Komponenttyp: "Köpt", "Komponentens standardpris": "0,25" });

    // The pair's first row carries the first step, the next step its own row.
    expect(await table("supplierPrices")).toEqual([
      { Artikelnummer: "007", Leverantörsnummer: "9001", "Leverantörens artikelnummer": "", Pris: "0,2", "Rabatt (%)": "", Huvudleverantör: "Nej", "Ledtid (dagar)": "", "Staffel: från antal": "", "Staffel: pris": "" },
      { Artikelnummer: "EX-200", Leverantörsnummer: "9001", "Leverantörens artikelnummer": "L-1", Pris: "10,5", "Rabatt (%)": "", Huvudleverantör: "Ja", "Ledtid (dagar)": "14", "Staffel: från antal": "10", "Staffel: pris": "9,5" },
      { Artikelnummer: "EX-200", Leverantörsnummer: "9001", "Leverantörens artikelnummer": "", Pris: "", "Rabatt (%)": "", Huvudleverantör: "", "Ledtid (dagar)": "", "Staffel: från antal": "100", "Staffel: pris": "8,25" },
      { Artikelnummer: "EX-200", Leverantörsnummer: "9002", "Leverantörens artikelnummer": "", Pris: "", "Rabatt (%)": "", Huvudleverantör: "Nej", "Ledtid (dagar)": "", "Staffel: från antal": "", "Staffel: pris": "" },
    ]);

    const prices = await table("customerPrices");
    expect(prices.map((r) => [r["Artikelnummer"], r["Kundnummer"], r["Pris"], r["Kundens artikelnummer"], r["Ställpris"], r["Staffel: från antal"], r["Staffel: pris"]])).toEqual([
      ["007", "5001", "5", "", "50", "10", "4,5"],
      ["007", "5001", "", "", "", "100", "4"],
      ["007", "5002", "", "0042", "", "", ""],
      ["EX-100", "5001", "1500", "SK-1200", "200", "", ""],
      // Steps only: Pris stays empty.
      ["EX-100", "5002", "", "", "", "10", "1400"],
      // 0 kr at antal 1 is the step at Gränsvärde 1; the ställpris differs
      // between the rules, so the cell is empty.
      ["EX-200", "5001", "", "", "", "1", "0"],
      ["EX-200", "5001", "", "", "", "50", "9"],
    ]);

    expect(await table("stockBalances")).toEqual([
      { Artikelnummer: "007", Lager: "ZX Lager", Lagerplats: "A2", Antal: "100", "À-pris": "" },
      { Artikelnummer: "EX-200", Lager: "ZX Lager", Lagerplats: "A1", Antal: "7,5", "À-pris": "" },
    ]);

    const customerRows = await table("customers");
    expect(customerRows[0]).toMatchObject({
      Kundnummer: "5001",
      Organisationsnummer: "556111-2222",
      Personnummer: "",
      Telefon: "+46 70 123 45 67",
      Adress: "Köksvägen 1",
      "Adressrad 2": "Box 12",
      "Adressrad 3": "Hus C",
      Betalningsvillkor: "ZX 30 dagar netto",
      // The name ZXB is also another carrier's code — the code names it.
      "Leveranssätt/speditör": "ZXA",
      Prislista: "ZX Prislista",
      "Kundrabatt (%)": "7,5",
      "Avvikande fakturaadress": "Ja",
      Samlingsfaktura: "Ja",
      "Faktura i vänteläge": "Ja",
      Privatperson: "Nej",
      Valuta: "SEK",
      Språk: "Svenska",
    });
    expect(customerRows[1]).toMatchObject({ Kundnummer: "5002", Organisationsnummer: "", Personnummer: "19800101-1234", Privatperson: "Ja", "Avvikande fakturaadress": "Nej" });
    expect(customerRows[2]).toMatchObject({ Land: "GB", Valuta: "EUR", Språk: "Engelska" });

    expect((await table("workCenters"))[0]).toMatchObject({
      Nummer: "110",
      Typ: "Maskin",
      Avdelning: "ZXAVD",
      "Avdelningens namn": "Plåtverkstad",
      Timkostnad: "650,5",
      "Kalkylpris 2": "725,25",
      "Gäller ställ": "Ja",
      "Gäller styck": "Nej",
      "Förvald ställtid": "12,5",
      Kostnadsrad: "Ordinarie",
    });
    expect(await table("legoWorkCenters")).toEqual([
      { Nummer: "910", Namn: "Extern betning", Leverantörsnummer: "9002", "Ledtid (dagar)": "5", "Kötid (dagar)": "1,5", "Ledtid beställning (dagar)": "2" },
    ]);
  });

  it("the create-only imports skip every exported row with Hoppa över", async () => {
    await seed();
    for (const entity of ["routing", "bom"] as const) {
      const file = await exports.exportFile(entity, query({ format: "csv" }));
      const input = await importInput(entity, asBuffer(file.content));
      const preview = await imports.preview(entity, { ...input, updateExisting: false, skipExisting: true });
      expect(preview.summary).toMatchObject({ skip: SEEDED_ROWS[entity], create: 0, update: 0, error: 0 });
    }
  });

  it("the article page's Alla filer recognises every export of its own", async () => {
    await seed();
    const pages: ImportEntity[][] = [IMPORT_ENTITY_ORDER, CUSTOMER_IMPORT_ENTITY_ORDER, SUPPLIER_IMPORT_ENTITY_ORDER];
    for (const entity of pages.flat()) {
      const headers = IMPORT_FIELD_HELP[entity].map((f) => f.header);
      expect(detectImportEntity(headers), entity).toBe(entity);
    }
  });

  it("a multi-file preview of all seven article exports changes nothing either", async () => {
    await seed();
    const files = [];
    for (const entity of IMPORT_ENTITY_ORDER) {
      const file = await exports.exportFile(entity, query({ format: "xlsx" }));
      files.push({ entity, ...(await importInput(entity, asBuffer(file.content))) });
    }
    const result = await imports.previewBatch(files);
    expect(result.files.map((file) => file.status)).toEqual(IMPORT_ENTITY_ORDER.map(() => "previewed"));
    for (const file of result.files) {
      if (file.status !== "previewed") continue;
      expect(file.summary).toMatchObject({ create: 0, error: 0 });
    }
  });
});

describe("import exports — the row rules", () => {
  it("names every numeric field after a field the template has", () => {
    for (const entity of ENTITIES) {
      const fields = new Set(IMPORT_FIELD_HELP[entity].map((f) => f.field));
      for (const field of NUMERIC_FIELDS[entity]) expect(fields.has(field), `${entity}.${field}`).toBe(true);
    }
    expect(IMPORT_TEMPLATES.map((t) => t.entity).sort()).toEqual([...ENTITIES].sort());
  });

  it("inverts the importers' rounding with as few digits as it takes", () => {
    expect(invertRounded(0.083333, (f) => Math.round((1 / f) * 1e6) / 1e6, 1 / 0.083333)).toBe(12);
    expect(unitFactorCell(0.083333)).toBe(12);
    expect(unitFactorCell(2.5)).toBe(0.4);
    expect(unitFactorCell(0.333333)).toBe(3);
    expect(unitFactorCell(0.142857)).toBe(7);
    // 2 units of 12 are stored as 24,0001 st; 1 st in thirds is 3.
    expect(bomQuantityCell(24.0001, 0.083333)).toBe(2);
    expect(bomQuantityCell(1, 3)).toBe(3);
    expect(bomQuantityCell(7.5, null)).toBe(7.5);
    expect(routingTimeCells({ setupTime: 12, runTimePerUnit: 8.5714, cycleTimePerUnit: null, timeUnit: "units_per_hour" })).toEqual({
      setupTime: 0.2,
      runTimePerUnit: 7,
      cycleTimePerUnit: null,
      timeUnit: "antal/timme",
    });
    // No st/h value for 0 — minutes.
    expect(routingTimeCells({ setupTime: 12, runTimePerUnit: 0, cycleTimePerUnit: null, timeUnit: "units_per_hour" }).timeUnit).toBe("minuter/enhet");
    expect(routingTimeCells({ setupTime: 0.5, runTimePerUnit: 0.1167, cycleTimePerUnit: 0.05, timeUnit: "seconds_per_unit" })).toEqual({
      setupTime: 30,
      runTimePerUnit: 7,
      cycleTimePerUnit: 3,
      timeUnit: "sekunder/enhet",
    });
  });

  it("splits an address into the three columns only when they join back to it", () => {
    expect(addressCells("Gatan 1\nBox 2\nHus C\nPort 4")).toEqual(["Gatan 1", "Box 2", "Hus C\nPort 4"]);
    expect(addressCells("Gatan 1")).toEqual(["Gatan 1", null, null]);
    expect(addressCells("Gatan 1\n\nHus C")).toEqual(["Gatan 1\n\nHus C", null, null]);
    expect(addressCells(null)).toEqual([null, null, null]);
  });

  it("names a register row by its name, or its code when the name is another row's key", () => {
    const texts = registerCellTexts([
      { id: "a", code: "30", name: "30 dagar netto" },
      { id: "b", code: "X", name: "Y" },
      { id: "c", code: "Y", name: "Annat" },
    ]);
    expect([texts.get("a"), texts.get("b"), texts.get("c")]).toEqual(["30 dagar netto", "X", "Annat"]);
  });

  it("writes no customer price row for a pair with nothing the import can carry", () => {
    expect(customerPriceExportBlocks([{ articleNumber: "A", customerNumber: "1", customerArticleNumber: null, rules: [] }])).toEqual([[]]);
  });
});

describe("import exports — the article selection", () => {
  const numbers = async (entity: ImportEntity, input: Record<string, string>, userId?: string) => {
    const file = await exports.exportFile(entity, query({ format: "csv", ...input }), userId);
    const parsed = await parseImportFile(asBuffer(file.content));
    return parsed.rows.map((row) => row[0]!);
  };

  it("follows article number from/to in byte order, varugrupp, type and active only", async () => {
    const { group } = await seed();
    // Byte order: "-" < digits < letters.
    expect(await numbers("articles", {})).toEqual(["-EX-500", "007", "EX-100", "EX-200", "EX-300", "EX-400"]);
    expect(await numbers("articles", { articleNumberFrom: "EX-200", articleNumberTo: "EX-300" })).toEqual(["EX-200", "EX-300"]);
    expect(await numbers("articles", { articleNumberTo: "007" })).toEqual(["-EX-500", "007"]);
    expect(await numbers("articles", { groupId: group.id })).toEqual(["EX-100"]);
    expect(await numbers("articles", { type: "purchased" })).toEqual(["-EX-500", "007", "EX-200"]);
    expect(await numbers("articles", { activeOnly: "true" })).toEqual(["-EX-500", "007", "EX-100", "EX-200", "EX-400"]);
    expect(await numbers("articles", { type: "service", activeOnly: "true" })).toEqual([]);
  });

  it("restricts every article-bound export to the selected articles", async () => {
    await seed();
    const only = { articleNumberFrom: "EX-200", articleNumberTo: "EX-200" };
    for (const entity of IMPORT_ENTITY_ORDER) {
      const all = await numbers(entity, {});
      const selected = await numbers(entity, only);
      expect(selected, entity).toEqual(all.filter((number) => number === "EX-200"));
    }
    // The structure follows the PARENT: EX-200 is a component only.
    expect(await numbers("bom", only)).toEqual([]);
    expect(await numbers("bom", { articleNumberFrom: "EX-400" })).toEqual(["EX-400"]);
    expect(await numbers("stockBalances", only)).toEqual(["EX-200"]);
  });

  it("Kopierat is the user's own list", async () => {
    const { id } = await seed();
    const user = await authService.createUser({ email: `exp-${crypto.randomUUID()}@example.com`, password: "correcthorsebattery", name: "Exp", role: "admin" });
    const other = await authService.createUser({ email: `exp-${crypto.randomUUID()}@example.com`, password: "correcthorsebattery", name: "Annan", role: "admin" });
    await testArticleService.setCopiedArticles(user.id, { articleIds: [id("EX-400"), id("007")], mode: "replace" });

    expect(await numbers("articles", { copied: "true" }, user.id)).toEqual(["007", "EX-400"]);
    expect(await numbers("bom", { copied: "true" }, user.id)).toEqual(["EX-400"]);
    // Together with a filter: both.
    expect(await numbers("articles", { copied: "true", type: "purchased" }, user.id)).toEqual(["007"]);
    // Nobody else's, and nothing without a user.
    expect(await numbers("articles", { copied: "true" }, other.id)).toEqual([]);
    expect(await numbers("articles", { copied: "true" })).toEqual([]);
  });

  it("the partner and resource exports take active only", async () => {
    await seed();
    expect(await numbers("customers", { activeOnly: "true" })).toEqual(["5001", "5002"]);
    expect(await numbers("suppliers", { activeOnly: "true" })).toEqual(["9001"]);
    expect(await numbers("supplierDeliveryAddresses", { activeOnly: "true" })).toEqual(["9001"]);
    expect(await numbers("workCenters", { activeOnly: "true" })).toEqual(["110"]);
    expect(await numbers("productionGroups", { activeOnly: "true" })).toEqual(["ZXAVD"]);
    // An article selection means nothing to them.
    expect(await numbers("customers", { type: "service" })).toEqual(["5001", "5002", "5003"]);
  });
});

describe("import exports — several files", () => {
  const block = (key: string, rows: number): ImportExportBlock =>
    Array.from({ length: rows }, (_, i) => ({ articleNumber: key, sequenceNo: (i + 1) * 10, workCenterCode: "110" }));

  it("never splits a block, and fills each file as far as whole blocks go", () => {
    const parts = splitImportExportBlocks([block("A", 2), block("B", 2), block("C", 3), block("D", 1), block("E", 5)], 4);
    expect(parts.map((part) => part.map((row) => row["articleNumber"]).join(""))).toEqual(["AABB", "CCCD", "EEEEE"]);
    // Nothing at all is still one (empty) file.
    expect(splitImportExportBlocks([], 4)).toEqual([[]]);
  });

  it("at the limit one file, one row more a zip of complete import files", async () => {
    const one = renderImportExport("routing", [block("A", 2), block("B", 2)], "csv", "2026-11-12", 4);
    expect(one).toMatchObject({ filename: "export-operationer-2026-11-12.csv", partCount: 1, rowCount: 4 });

    for (const format of ["csv", "xlsx"] as const) {
      const zip = renderImportExport("routing", [block("A", 2), block("B", 2), block("C", 1)], format, "2026-11-12", 4);
      expect(zip).toMatchObject({ filename: "export-operationer-2026-11-12.zip", contentType: "application/zip", partCount: 2, rowCount: 5 });
      const entries = readStoredZipEntries(asBuffer(zip.content));
      expect([...entries.keys()]).toEqual([`export-operationer-2026-11-12-del-1.${format}`, `export-operationer-2026-11-12-del-2.${format}`]);
      const files = await Promise.all([...entries.values()].map((data) => parseImportFile(data)));
      // Each part has the heading row and its own rows.
      for (const file of files) expect(file.headers).toEqual(IMPORT_FIELD_HELP.routing.map((f) => f.header));
      expect(files.map((file) => file.rows.map((row) => row[0]))).toEqual([["A", "A", "B", "B"], ["C"]]);
    }
  });

  it("keeps an article's operations and a parent's structure in one file, and each part reads back unchanged", async () => {
    const { id } = await seed();
    const [wc] = await db.select({ id: workCenters.id }).from(workCenters).where(eq(workCenters.code, "110"));
    await db.insert(routingOperations).values({ articleId: id("EX-400"), sequenceNo: 10, workCenterId: wc!.id, setupTime: "1.00", runTimePerUnit: "1.0000" });
    const before = await snapshot();
    // Three rows per file: EX-100 has five operations and four structure rows.
    const small = createImportExportService(exportRepo, testArticleService, { maxRows: 3 });

    for (const entity of ["routing", "bom"] as const) {
      const zip = await small.exportFile(entity, query({ format: "xlsx" }));
      expect(zip.filename).toMatch(/\.zip$/);
      const parts = [...readStoredZipEntries(asBuffer(zip.content)).values()];
      const keys: string[][] = [];
      for (const part of parts) {
        const input = await importInput(entity, part);
        keys.push([...new Set(input.rows.map((row) => row[0]!))]);
        const preview = await imports.preview(entity, input);
        expect(preview.summary).toMatchObject({ create: 0, error: 0 });
        await imports.commit(entity, input);
      }
      // No article in two files.
      expect(keys.flat().length).toBe(new Set(keys.flat()).size);
      expect(keys).toEqual([["EX-100"], ["EX-400"]]);
    }
    expect(await snapshot()).toEqual(before);

    // The other article files split between articles too.
    const articlesZip = await small.exportFile("articles", query({ format: "csv" }));
    expect(articlesZip).toMatchObject({ partCount: 2, rowCount: 6 });
    const pricesZip = await small.exportFile("customerPrices", query({ format: "csv" }));
    const priceParts = await Promise.all([...readStoredZipEntries(asBuffer(pricesZip.content)).values()].map((data) => parseImportFile(data)));
    expect(priceParts.map((file) => [...new Set(file.rows.map((row) => row[0]))])).toEqual([["007"], ["EX-100"], ["EX-200"]]);
  });
});

describe("GET /imports/:entity/export", () => {
  const PASSWORD = "correcthorsebattery";
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    app = buildApp(db, { importExportMaxRows: 3 });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function session(role: "admin" | "user", extra: Record<string, unknown> = {}) {
    const email = `exp-${crypto.randomUUID()}@example.com`;
    const user = await authService.createUser({ email, password: PASSWORD, name: "Exp", role, ...extra } as never);
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return { user, cookie: `session=${res.cookies.find((c) => c.name === "session")!.value}` };
  }

  it("serves each format as an attachment, and a zip beyond the limit", async () => {
    await seed();
    const { cookie } = await session("admin");
    const day = "\\d{4}-\\d{2}-\\d{2}";

    const csv = await app.inject({ method: "GET", url: "/api/v1/imports/customers/export?format=csv", headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toMatch(new RegExp(`export-kunder-${day}\\.csv`));
    expect((await parseImportFile(csv.rawPayload)).rows.map((row) => row[0])).toEqual(["5001", "5002", "5003"]);

    // Excel is the default format.
    const xlsx = await app.inject({ method: "GET", url: "/api/v1/imports/legoWorkCenters/export", headers: { cookie } });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.headers["content-disposition"]).toMatch(new RegExp(`export-legoresurser-${day}\\.xlsx`));
    expect((await parseImportFile(xlsx.rawPayload)).rows).toEqual([["910", "Extern betning", "9002", "5", "1.5", "2"]]);

    // Six articles, three rows per file.
    const zip = await app.inject({ method: "GET", url: "/api/v1/imports/articles/export?format=csv", headers: { cookie } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(zip.headers["content-disposition"]).toMatch(new RegExp(`export-artiklar-${day}\\.zip`));
    expect([...readStoredZipEntries(zip.rawPayload).keys()].map((name) => name.replace(/\d{4}-\d{2}-\d{2}/, "D"))).toEqual([
      "export-artiklar-D-del-1.csv",
      "export-artiklar-D-del-2.csv",
    ]);

    // The selection, and the session user's Kopierat.
    const selected = await app.inject({
      method: "GET",
      url: "/api/v1/imports/articles/export?format=csv&articleNumberFrom=EX-300&type=service",
      headers: { cookie },
    });
    expect((await parseImportFile(selected.rawPayload)).rows.map((row) => row[0])).toEqual(["EX-300"]);
    const copied = await app.inject({ method: "GET", url: "/api/v1/imports/articles/export?format=csv&copied=true", headers: { cookie } });
    expect(copied.statusCode).toBe(200);
    expect(copied.rawPayload.toString("utf8").trim().split("\r\n").length).toBe(1);
  });

  it("answers 404 for an unknown entity and 400 for an unknown parameter or format", async () => {
    const { cookie } = await session("admin");
    const get = (url: string) => app.inject({ method: "GET", url: `/api/v1/imports/${url}`, headers: { cookie } });
    expect((await get("orders/export")).statusCode).toBe(404);
    expect((await get("articles/export?format=pdf")).statusCode).toBe(400);
    expect((await get("articles/export?search=x")).statusCode).toBe(400);
    expect((await get("articles/export?groupId=inte-ett-id")).statusCode).toBe(400);
  });

  it("is the import's own: admin only — an office user and a read-only account are refused", async () => {
    await seed();
    expect((await app.inject({ method: "GET", url: "/api/v1/imports/articles/export" })).statusCode).toBe(401);

    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `ZXEXP${crypto.randomUUID().slice(0, 6)}`, name: `Export ${crypto.randomUUID().slice(0, 6)}`, permissions: ["artiklar", "inkop", "forsaljning", "tillverkning", "lager"] })
      .returning();
    const office = await session("user", { permissionGroupId: group!.id });
    const readOnly = await session("user", { permissionGroupId: group!.id, readOnly: true });
    for (const { cookie } of [office, readOnly]) {
      for (const entity of ["articles", "customers", "workCenters"]) {
        const res = await app.inject({ method: "GET", url: `/api/v1/imports/${entity}/export?format=csv`, headers: { cookie } });
        expect(res.statusCode, entity).toBe(403);
      }
    }
    // The export writes nothing: every table is as the seed left it.
    const before = await snapshot();
    const { cookie } = await session("admin");
    for (const entity of ENTITIES) {
      const res = await app.inject({ method: "GET", url: `/api/v1/imports/${entity}/export?format=xlsx`, headers: { cookie } });
      expect(res.statusCode, entity).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  });
});
