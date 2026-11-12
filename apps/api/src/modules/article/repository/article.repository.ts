import { resolveDimensions, type DimensionInput, type ResolveDimensionsOptions } from "../../economy/service/dimension-check.js";
import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { pluginEvents } from "../../system/service/plugin-events.js";
import { currentArticleFileCondition, drawingFilesWithData, type DrawingFileRef } from "./drawing-files.js";
import {
  claimArticleNumber,
  findArticleNumberSeries,
  listArticleNumberSeries,
  previewArticleNumber,
} from "./article-number.js";
import {
  articleDrawingRevisions,
  articleDrawings,
  articleFiles,
  articleCodes,
  articleGroups,
  articleRevisions,
  articleSalesPriceHistory,
  articleStandardCostHistory,
  articles,
  articleUnits,
  bomComponents,
  configuratorTemplates,
  packageTypes,
  routingOperations,
  stockLocations,
  units,
  warehouses,
  type Db,
  type Tx,
} from "@navet/db";
import {
  ilikePattern,
  type ArticleType,
  type CreateArticleDrawingInput,
  type CreateArticleGroupInput,
  type CreateArticleInput,
  type CreateArticleRevisionInput,
  type CreateBomComponentInput,
  type UpdateBomComponentInput,
  type ListArticlesQuery,
  type UpdateArticleDrawingInput,
  type UpdateArticleGroupInput,
  type UpdateArticleInput,
  type UpdateArticleRevisionInput,
} from "@navet/shared";
import { getOrCreateFallbackLocation } from "../../stock/service/location-resolver.js";
import { articleHoldsStock } from "../../stock/service/stocked-article.js";
import { applyInformation, copyArticleParts, readCopySource } from "./article-copy.js";
import { articleVatRateSql } from "./article-vat-rate.js";
import { getOrCreateDefaultUnitId } from "./default-unit.js";
import { assertBarcodeFree } from "./article-barcode.js";
import { BOM_STRUCTURE_LOCK_SQL, bomReaches } from "./bom-write.js";
import { clearCopiedArticles, listCopiedArticleIds, listCopiedArticleRows, removeCopiedArticles, setCopiedArticles } from "./copied-articles.js";
import { articleNumberRangesCondition } from "../../costing/repository/pre-calculation-batch.repository.js";
import type { ArticleNumberRange } from "@navet/shared";

// Append-only write for article_standard_cost_history (D1) — called by the
// three standard-cost writers (create, updateStandardCost, CSV import) in
// the SAME transaction as the change that produced the new value, and only
// when the caller has already established the value actually changed. A
// plain Db | Tx function, same composable pattern as
// resolveStockLocation/getOrCreateFallbackLocation, so it works inside both
// this repository's own transactions and the import repository's. Exported
// for the import repository to reuse (import -> article is the existing
// dependency direction; the article module never imports from import).
//
// valid_from is never earlier than the article's latest row (migration 0190's
// rule for the trigger-written histories): now() is the transaction's START,
// so a transaction that began before another one changed and committed the
// cost would otherwise record its later change as the earlier one, and the
// history's latest value would not be the article's. The writers call this
// after their UPDATE of the article, whose row lock orders them.
export async function recordStandardCostHistory(
  db: Db | Tx,
  rows: { articleId: string; cost: number | string; createdBy?: string | null }[]
) {
  if (rows.length === 0) return;
  await db.insert(articleStandardCostHistory).values(
    rows.map((row) => ({
      articleId: row.articleId,
      // Costs arriving as strings (e.g. re-read from a numeric column) are
      // passed through as-is to avoid a number round-trip losing precision.
      cost: typeof row.cost === "string" ? row.cost : String(row.cost),
      createdBy: row.createdBy ?? null,
      validFrom: sql`greatest(now(), (select max(h.valid_from) from article_standard_cost_history h where h.article_id = ${row.articleId}) + interval '1 microsecond')`,
    }))
  );
}

// unitId is resolved by the service (explicit choice or the "st" default).
// The number is always settled by the time the article is inserted — the
// service issues it from a series when the caller left it out.
export type InsertArticleInput = Omit<CreateArticleInput, "articleNumber" | "numberSeriesKey"> & {
  articleNumber: string;
  unitId: string;
};

// The body of create() without the transaction — a Tx-only leaf so a caller
// that creates several articles in ONE transaction (the configurator's
// variant creation) composes it, same pattern as resolveStockLocation. A
// standard cost given at creation is a baseline value, written as the
// article's first history row alongside it. With copyFrom the chosen parts
// of the source are copied in the SAME transaction (article-copy.ts); the
// caller picks the isolation level (create() uses repeatable read so a BOM
// link always finds its copied operation). Returns null when the copy source
// does not exist.
export async function insertArticle(tx: Tx, input: InsertArticleInput): Promise<typeof articles.$inferSelect | null> {
  const copy = input.copyFrom;
  const source = copy ? await readCopySource(tx, copy.articleId) : null;
  if (copy && !source) return null;
  const values: typeof articles.$inferInsert = {
    articleNumber: input.articleNumber,
    name: input.name,
    type: input.type,
    isPhantom: input.isPhantom,
    unitId: input.unitId,
    purchaseUnitId: input.purchaseUnitId ?? null,
    salesUnitId: input.salesUnitId ?? null,
    standardCost: input.standardCost !== undefined ? String(input.standardCost) : undefined,
    salesPrice: input.salesPrice !== undefined ? String(input.salesPrice) : undefined,
    weight: input.weight !== undefined ? String(input.weight) : undefined,
    length: input.length !== undefined ? String(input.length) : undefined,
    width: input.width !== undefined ? String(input.width) : undefined,
    height: input.height !== undefined ? String(input.height) : undefined,
    quantityPerPackage: input.quantityPerPackage !== undefined ? String(input.quantityPerPackage) : undefined,
    reorderPoint: input.reorderPoint !== undefined ? String(input.reorderPoint) : undefined,
    orderQuantity: input.orderQuantity !== undefined ? String(input.orderQuantity) : undefined,
    rounding: input.rounding !== undefined ? String(input.rounding) : undefined,
    safetyStock: input.safetyStock ? String(input.safetyStock) : undefined,
    stockControlled: input.stockControlled ?? false,
    forecastControlled: input.forecastControlled ?? false,
    manufacturingLeadTimeDays: input.manufacturingLeadTimeDays ?? null,
    packageTypeId: input.packageTypeId,
    parcelKind: input.parcelKind ?? null,
    stackable: input.stackable ?? false,
    palletSpaces: input.palletSpaces !== undefined ? String(input.palletSpaces) : undefined,
    loadingMeters: input.loadingMeters !== undefined ? String(input.loadingMeters) : undefined,
    groupId: input.groupId,
    articleCodeId: input.articleCodeId,
    defaultLocationId: input.defaultLocationId,
    active: input.active,
    surfaceTreatment: input.surfaceTreatment ?? null,
    colour: input.colour ?? null,
    extraDescription: input.extraDescription ?? null,
    nameEn: input.nameEn ?? null,
    extraDescriptionEn: input.extraDescriptionEn ?? null,
    barcode: input.barcode ?? null,
  };
  const copyUnits = source !== null && source.unitId === input.unitId;
  if (copy && source && copy.parts.includes("information")) {
    applyInformation(values as Record<string, unknown>, input, source, copyUnits);
  }
  // Streckkod: the same GTIN in another form (UPC-A/EAN-13) is a duplicate too.
  if (input.barcode) await assertBarcodeFree(tx, input.barcode, null);
  const [row] = await tx.insert(articles).values(values).returning();
  if (input.standardCost !== undefined) {
    // No createdBy: the article routes don't thread a user id through this
    // call chain (unlike sales/purchase/manufacturing) — see the
    // updateStandardCost note in the repository.
    await recordStandardCostHistory(tx, [{ articleId: row!.id, cost: input.standardCost }]);
  }
  if (copy) await copyArticleParts(tx, copy.articleId, row!.id, copy.parts, { copyUnits });
  return row!;
}

// The article UPDATE and its article.updated event (Tillägg), in the
// caller's transaction.
async function updateArticleRow(dbc: Db | Tx, id: string, input: UpdateArticleInput): Promise<typeof articles.$inferSelect | null> {
  // numeric(…) columns take strings — convert weight/dimensions/qty-per-kolli
  // (null clears) and salesPrice (null clears). packageTypeId
  // (uuid) passes through in ...rest.
  const {
    weight,
    length,
    width,
    height,
    quantityPerPackage,
    salesPrice,
    reorderPoint,
    orderQuantity,
    rounding,
    safetyStock,
    palletSpaces,
    loadingMeters,
    ...rest
  } = input;
  const numeric = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : String(v));
  // Streckkod: the same GTIN in another form on ANOTHER article is a duplicate.
  if (input.barcode) await assertBarcodeFree(dbc, input.barcode, id);
  const [row] = await dbc
    .update(articles)
    .set({
      ...rest,
      weight: numeric(weight),
      length: numeric(length),
      width: numeric(width),
      height: numeric(height),
      quantityPerPackage: numeric(quantityPerPackage),
      reorderPoint: numeric(reorderPoint),
      orderQuantity: numeric(orderQuantity),
      rounding: numeric(rounding),
      // 0 means none, like the reorder point's empty field.
      safetyStock: safetyStock === 0 ? null : numeric(safetyStock),
      palletSpaces: numeric(palletSpaces),
      loadingMeters: numeric(loadingMeters),
      salesPrice: numeric(salesPrice),
      updatedAt: new Date(),
    })
    .where(eq(articles.id, id))
    .returning();
  if (row) await pluginEvents.emit(dbc, { type: "article.updated", entityId: row.id, entityNumber: row.articleNumber });
  return row ?? null;
}

// A varugrupp's price markup (#16) for its numeric column: undefined =
// leave it (drizzle skips the key), null = inherit the company's again.
function markupColumn(value: number | null | undefined): string | null | undefined {
  return value === undefined || value === null ? value : String(value);
}

// The register's filters without paging — what the where is built from.
// GET /articles passes its full query; Kopierat's `query` has no limit/offset.
type ArticleListFilter = Omit<ListArticlesQuery, "limit" | "offset"> & {
  // The import exports' selection (#35, listIds only) — not part of the
  // list page's query: article number from/to in byte order (Förkalkylera
  // flera's condition, the ONE implementation) and active articles only.
  articleNumberRanges?: readonly ArticleNumberRange[];
  activeOnly?: boolean;
};

export function createArticleRepository(db: Db) {
  // The register's where — the ONE implementation behind list (page +
  // count) and listIds (Kopierat's query). A new filter goes here and
  // nowhere else.
  function listWhere(query: ArticleListFilter, opts: { onlyIds?: string[] }) {
    const conditions = [];
    if (opts.onlyIds) conditions.push(inArray(articles.id, opts.onlyIds));
    if (query.search) {
      const pattern = ilikePattern(query.search);
      conditions.push(or(ilike(articles.articleNumber, pattern), ilike(articles.name, pattern)));
    }
    if (query.type) conditions.push(eq(articles.type, query.type));
    if (query.groupId) conditions.push(eq(articles.groupId, query.groupId));
    if (query.articleCodeId) conditions.push(eq(articles.articleCodeId, query.articleCodeId));
    const numberRanges = articleNumberRangesCondition(query.articleNumberRanges);
    if (numberRanges) conditions.push(numberRanges);
    if (query.activeOnly) conditions.push(eq(articles.active, true));
    // ?orderable=true: the pickers on order forms — a template in EITHER mode
    // is excluded (variants: its variants are what gets ordered; to_order: it
    // needs a configuration, and purchase can never buy it) unless the form
    // can open Konfigurera on it (?configurable=true: the sales forms and
    // Ny tillverkningsorder). Without the parameter the list is unchanged.
    if (query.orderable && !query.configurable) {
      conditions.push(
        notExists(
          db
            .select({ one: sql`1` })
            .from(configuratorTemplates)
            .where(eq(configuratorTemplates.articleId, articles.id))
        )
      );
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  return {
    // New articles get the "***" fallback location unless one is chosen.
    async getOrCreateFallbackLocationId() {
      return getOrCreateFallbackLocation(db);
    },

    // A chosen Lagerplats: null = no such place (the service's 404 — the FK
    // violation was a 500); `blocked` (0185) may not be newly chosen.
    async findLocationFlags(locationId: string): Promise<{ blocked: boolean } | null> {
      const [row] = await db.select({ blocked: stockLocations.blocked }).from(stockLocations).where(eq(stockLocations.id, locationId));
      return row ?? null;
    },

    // Tjänster lagerförs inte: a type change to Tjänst is refused while the
    // article holds stock on any place (stock module's leaf, physical, a
    // blocked place too). Read in the transaction that holds the article
    // row FOR UPDATE (lockArticle).
    async articleHoldsStock(tx: Tx, articleId: string): Promise<boolean> {
      return articleHoldsStock(tx, articleId);
    },

    // Wrapped in a transaction around insertArticle. With copyFrom the source
    // is read from one snapshot (repeatable read). The transaction only
    // inserts new rows and never updates existing ones, which keeps
    // serialization failures unlikely; any error still rolls everything back.
    // Returns null when the copy source no longer exists.
    async create(input: InsertArticleInput) {
      return db.transaction(
        async (tx) => {
          const created = await insertArticle(tx, input);
          // Tillägg: article.created, in the article's own transaction.
          if (created) {
            await pluginEvents.emit(tx, { type: "article.created", entityId: created.id, entityNumber: created.articleNumber });
          }
          return created;
        },
        input.copyFrom ? { isolationLevel: "repeatable read" } : undefined
      );
    },

    // Exposed so the service can run a check and a write in ONE transaction
    // (updateArticle's type/phantom change) without importing the db itself.
    transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return db.transaction(fn);
    },

    // Produktkonfigurator: the article row FOR UPDATE — what a type/phantom
    // change holds while it checks the template's mode and writes. The
    // template writers (createTemplate/updateTemplate/createVariants) read the
    // same row FOR SHARE, so the two serialise; they never take the template
    // row from here, so the lock order (template → article) cannot invert.
    async lockArticle(tx: Tx, id: string): Promise<{ id: string; type: ArticleType; isPhantom: boolean } | null> {
      const [row] = await tx
        .select({ id: articles.id, type: articles.type, isPhantom: articles.isPhantom })
        .from(articles)
        .where(eq(articles.id, id))
        .for("update");
      return row ?? null;
    },

    // `ex` lets updateArticle write inside the transaction that holds the
    // article row (lockArticle); every other caller leaves it at db, and the
    // write then gets a transaction of its own — the change and its
    // article.updated event (Tillägg) commit together.
    async update(id: string, input: UpdateArticleInput, ex: Db | Tx = db): Promise<typeof articles.$inferSelect | null> {
      return ex === db ? db.transaction((tx) => updateArticleRow(tx, id, input)) : updateArticleRow(ex, id, input);
    },

    // Wrapped in a transaction: the "did it actually change" comparison must
    // read the current value inside the SAME transaction as the write, so a
    // history row is never written for a no-op update. No createdBy: the
    // article routes never thread a user id through this call chain — unlike
    // sales/purchase/manufacturing's writers, requireAuth's req.user is never
    // read here, and the task instructs not to add new plumbing for it.
    async updateStandardCost(id: string, standardCost: number) {
      return db.transaction(async (tx) => {
        // FOR NO KEY UPDATE (the UPDATE's own lock mode, so a TO or stock
        // row referencing the article is not held up): two concurrent
        // changes otherwise both compared against the value before either —
        // with the cost at 10, one setting 20 and one setting 10 left the
        // latter deciding "unchanged", and the history's latest row said 20
        // while the article said 10.
        const [current] = await tx
          .select({ standardCost: articles.standardCost })
          .from(articles)
          .where(eq(articles.id, id))
          .for("no key update");
        const [row] = await tx
          .update(articles)
          .set({ standardCost: String(standardCost), updatedAt: new Date() })
          .where(eq(articles.id, id))
          .returning();
        const previousCost = current?.standardCost ?? null;
        const changed = previousCost === null || Number(previousCost) !== standardCost;
        if (row && changed) {
          await recordStandardCostHistory(tx, [{ articleId: id, cost: standardCost }]);
          // Tillägg: article.updated only when the cost really changed.
          await pluginEvents.emit(tx, { type: "article.updated", entityId: row.id, entityNumber: row.articleNumber });
        }
        return row ?? null;
      });
    },

    // Produktkonfigurator: the template's mode, so updateArticle can refuse a
    // type/phantom change the mode does not allow (null = not a template).
    // Read with the transaction that holds the article row (lockArticle) so a
    // template created between the check and the write is impossible.
    async configuratorModeFor(articleId: string, ex: Db | Tx = db): Promise<"variants" | "to_order" | null> {
      const [row] = await ex
        .select({ mode: configuratorTemplates.mode })
        .from(configuratorTemplates)
        .where(eq(configuratorTemplates.articleId, articleId));
      return row?.mode ?? null;
    },

    // Etiketter (#4): what an article label prints, in the order asked for.
    async labelArticles(ids: string[]) {
      const rows = await db
        .select({ id: articles.id, articleNumber: articles.articleNumber, name: articles.name, barcode: articles.barcode })
        .from(articles)
        .where(inArray(articles.id, ids));
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    },

    async findById(id: string) {
      const purchaseUnits = alias(units, "purchase_units");
      const salesUnits = alias(units, "sales_units");
      const [row] = await db
        .select({
          ...getTableColumns(articles),
          // Base unit code keeps the pre-register field name `unit` so
          // existing consumers (web, PDFs) stay unchanged.
          unit: units.code,
          purchaseUnitCode: purchaseUnits.code,
          salesUnitCode: salesUnits.code,
          groupName: articleGroups.name,
          groupCode: articleGroups.code,
          // Varugrupp styr momsen: the group's rate (25 % without one).
          vatRate: articleVatRateSql,
          articleCodeCode: articleCodes.code,
          articleCodeName: articleCodes.name,
          packageTypeCode: packageTypes.code,
          packageTypeName: packageTypes.name,
          defaultLocationName: stockLocations.name,
          defaultWarehouseName: warehouses.name,
          // Spärrad lagerplats (0185): the Lagerplats may stay blocked — the
          // resolver skips it — but cannot be newly chosen.
          defaultLocationBlocked: stockLocations.blocked,
          // Produktkonfigurator: the template's mode (null = not a template).
          // What sales/purchase/manufacturing's getArticle readers feed
          // assertOrderableArticle — a template in mode variants is never
          // put on an order row, its variants are.
          configuratorMode: configuratorTemplates.mode,
        })
        .from(articles)
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(purchaseUnits, eq(purchaseUnits.id, articles.purchaseUnitId))
        .leftJoin(salesUnits, eq(salesUnits.id, articles.salesUnitId))
        .leftJoin(articleGroups, eq(articleGroups.id, articles.groupId))
        .leftJoin(articleCodes, eq(articleCodes.id, articles.articleCodeId))
        .leftJoin(packageTypes, eq(packageTypes.id, articles.packageTypeId))
        .leftJoin(stockLocations, eq(stockLocations.id, articles.defaultLocationId))
        .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .leftJoin(configuratorTemplates, eq(configuratorTemplates.articleId, articles.id))
        .where(eq(articles.id, id));
      return row ?? null;
    },

    // `onlyIds`: the ABC-klassning filter (#10) — the class is derived for
    // the whole register by the planning module, so the service passes the
    // matching ids and `total` follows the filter (the TO list's
    // component_late works the same way). Kopierat (#28) is passed the same
    // way. The where is built ONCE here for the page, the count and
    // listIds (Kopiera alla träffar) — never copy the conditions.
    async list(query: ListArticlesQuery, opts: { onlyIds?: string[] } = {}) {
      const where = listWhere(query, opts);

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            ...getTableColumns(articles),
            unit: units.code,
            groupName: articleGroups.name,
            vatRate: articleVatRateSql,
            articleCodeCode: articleCodes.code,
            articleCodeName: articleCodes.name,
            configuratorMode: configuratorTemplates.mode,
          })
          .from(articles)
          .innerJoin(units, eq(units.id, articles.unitId))
          .leftJoin(articleGroups, eq(articleGroups.id, articles.groupId))
          .leftJoin(articleCodes, eq(articleCodes.id, articles.articleCodeId))
          .leftJoin(configuratorTemplates, eq(configuratorTemplates.articleId, articles.id))
          .where(where)
          .orderBy(asc(articles.articleNumber))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ total: count() }).from(articles).where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // Every id the list would show for the query, in the list's order and
    // without paging — Kopierat's `query` (Kopiera alla träffar). Same where
    // as list, so the copied set is exactly the register's hits.
    async listIds(query: ArticleListFilter, opts: { onlyIds?: string[] } = {}): Promise<string[]> {
      const rows = await db.select({ id: articles.id }).from(articles).where(listWhere(query, opts)).orderBy(asc(articles.articleNumber));
      return rows.map((row) => row.id);
    },

    // --- Kopierat (#28, copied-articles.ts) ---
    listCopiedArticleIds: (userId: string) => listCopiedArticleIds(db, userId),
    listCopiedArticleRows: (userId: string) => listCopiedArticleRows(db, userId),
    setCopiedArticles: (userId: string, articleIds: readonly string[], mode: "add" | "replace") =>
      setCopiedArticles(db, userId, articleIds, mode),
    removeCopiedArticles: (userId: string, articleIds: readonly string[]) => removeCopiedArticles(db, userId, articleIds),
    clearCopiedArticles: (userId: string) => clearCopiedArticles(db, userId),

    // --- Units (enheter) ---

    // Fallback for new articles without an explicit base unit — mirrors the
    // "***" location: the st unit is created on first use (default-unit.ts).
    async getOrCreateDefaultUnitId() {
      return getOrCreateDefaultUnitId(db);
    },

    async findUnitById(id: string) {
      const [row] = await db.select().from(units).where(eq(units.id, id));
      return row ?? null;
    },

    async listArticleUnits(articleId: string) {
      return db
        .select({
          id: articleUnits.id,
          articleId: articleUnits.articleId,
          unitId: articleUnits.unitId,
          unitCode: units.code,
          unitName: units.name,
          quantityPerBase: articleUnits.quantityPerBase,
        })
        .from(articleUnits)
        .innerJoin(units, eq(units.id, articleUnits.unitId))
        .where(eq(articleUnits.articleId, articleId))
        .orderBy(asc(units.code));
    },

    async findArticleUnit(articleId: string, unitId: string) {
      const [row] = await db
        .select()
        .from(articleUnits)
        .where(and(eq(articleUnits.articleId, articleId), eq(articleUnits.unitId, unitId)));
      return row ?? null;
    },

    async addArticleUnit(articleId: string, unitId: string, quantityPerBase: number) {
      const [row] = await db
        .insert(articleUnits)
        .values({ articleId, unitId, quantityPerBase: String(quantityPerBase) })
        .returning();
      return row!;
    },

    // Scoped to the article so a row id from another article 404s.
    async updateArticleUnit(articleId: string, rowId: string, quantityPerBase: number) {
      const [row] = await db
        .update(articleUnits)
        .set({ quantityPerBase: String(quantityPerBase) })
        .where(and(eq(articleUnits.id, rowId), eq(articleUnits.articleId, articleId)))
        .returning();
      return row ?? null;
    },

    async findArticleUnitRow(articleId: string, rowId: string) {
      const [row] = await db
        .select()
        .from(articleUnits)
        .where(and(eq(articleUnits.id, rowId), eq(articleUnits.articleId, articleId)));
      return row ?? null;
    },

    async deleteArticleUnit(articleId: string, rowId: string) {
      const [row] = await db
        .delete(articleUnits)
        .where(and(eq(articleUnits.id, rowId), eq(articleUnits.articleId, articleId)))
        .returning();
      return row ?? null;
    },

    async countArticleUnits(articleId: string) {
      const [row] = await db
        .select({ total: count() })
        .from(articleUnits)
        .where(eq(articleUnits.articleId, articleId));
      return row!.total;
    },

    // Kostnadsställen och projekt: the group's Kostnadsställe (förval) must
    // exist and be active (the one rule, dimension-check.ts).
    async resolveDimensions(input: DimensionInput, opts: ResolveDimensionsOptions = {}) {
      return resolveDimensions(db, input, opts);
    },

    async createArticleGroup(input: CreateArticleGroupInput) {
      const { vatRate, generalMarkupPercent, materialMarkupPercent, ...rest } = input;
      const [row] = await db
        .insert(articleGroups)
        .values({
          ...rest,
          vatRate: vatRate !== undefined ? String(vatRate) : undefined,
          generalMarkupPercent: markupColumn(generalMarkupPercent),
          materialMarkupPercent: markupColumn(materialMarkupPercent),
        })
        .returning();
      return row!;
    },

    async updateArticleGroup(id: string, input: UpdateArticleGroupInput) {
      const { vatRate, generalMarkupPercent, materialMarkupPercent, ...rest } = input;
      const [row] = await db
        .update(articleGroups)
        .set({
          ...rest,
          vatRate: vatRate !== undefined ? String(vatRate) : undefined,
          generalMarkupPercent: markupColumn(generalMarkupPercent),
          materialMarkupPercent: markupColumn(materialMarkupPercent),
        })
        .where(eq(articleGroups.id, id))
        .returning();
      return row ?? null;
    },

    async listArticleGroups() {
      return db.select().from(articleGroups).orderBy(asc(articleGroups.code));
    },

    async findArticleGroupById(id: string) {
      const [row] = await db.select().from(articleGroups).where(eq(articleGroups.id, id));
      return row ?? null;
    },

    async findArticleGroupByCode(code: string) {
      const [row] = await db.select().from(articleGroups).where(eq(articleGroups.code, code));
      return row ?? null;
    },

    async findArticleGroupByName(name: string) {
      const [row] = await db.select().from(articleGroups).where(eq(articleGroups.name, name));
      return row ?? null;
    },

    async articleCodeExists(id: string) {
      const [row] = await db.select({ id: articleCodes.id }).from(articleCodes).where(eq(articleCodes.id, id));
      return row !== undefined;
    },

    async articleGroupExists(id: string) {
      const [row] = await db.select({ id: articleGroups.id }).from(articleGroups).where(eq(articleGroups.id, id));
      return row !== undefined;
    },

    // The group's article number series (null = the default), undefined =
    // no such group.
    async articleGroupNumberSeries(id: string) {
      const [row] = await db
        .select({ numberSeriesKey: articleGroups.numberSeriesKey })
        .from(articleGroups)
        .where(eq(articleGroups.id, id));
      return row ? row.numberSeriesKey : undefined;
    },

    // Artikelnummerserier (article-number.ts).
    listArticleNumberSeries: () => listArticleNumberSeries(db),
    findArticleNumberSeries: (key: string) => findArticleNumberSeries(db, key),
    previewArticleNumber: (series: Awaited<ReturnType<typeof listArticleNumberSeries>>[number]) =>
      previewArticleNumber(db, series),
    claimArticleNumber: (key: string) => claimArticleNumber(db, key),

    async packageTypeExists(id: string) {
      const [row] = await db.select({ id: packageTypes.id }).from(packageTypes).where(eq(packageTypes.id, id));
      return row !== undefined;
    },

    // quantity arrives already converted to the component's base unit; the
    // unit fields are the display snapshot (null = base unit). The cycle
    // check and the INSERT run in ONE transaction under the structure lock
    // (bom-write.ts), so two concurrent adds A → B and B → A cannot both
    // pass. null = the row would close a cycle (nothing is written).
    async addBomComponent(
      parentArticleId: string,
      input: Omit<CreateBomComponentInput, "unitId"> & { unitId: string | null; unitFactor: number | null }
    ) {
      return db.transaction(async (tx) => {
        await tx.execute(BOM_STRUCTURE_LOCK_SQL);
        if (await bomReaches(tx, input.componentArticleId, parentArticleId)) return null;
        const [row] = await tx
          .insert(bomComponents)
          .values({
            parentArticleId,
            componentArticleId: input.componentArticleId,
            quantity: String(input.quantity),
            unitId: input.unitId,
            unitFactor: input.unitFactor !== null ? String(input.unitFactor) : null,
            routingOperationId: input.routingOperationId ?? null,
            position: input.position ?? null,
            costingOnly: input.costingOnly ?? false,
          })
          .returning();
        return row!;
      });
    },

    // Is `targetArticleId` reachable walking down from `articleId`'s
    // structure (itself included)? Read without the lock — the configurator's
    // check of a configurator row (an advisory answer; the variants' rows go
    // to a new article, which nothing contains).
    async bomReaches(articleId: string, targetArticleId: string) {
      return bomReaches(db, articleId, targetArticleId);
    },

    async findBomComponentRow(parentArticleId: string, rowId: string) {
      const [row] = await db
        .select()
        .from(bomComponents)
        .where(and(eq(bomComponents.id, rowId), eq(bomComponents.parentArticleId, parentArticleId)));
      return row ?? null;
    },

    // Scoped to the parent so a row id from another article's BOM 404s.
    async updateBomComponent(
      parentArticleId: string,
      rowId: string,
      input: Omit<UpdateBomComponentInput, "unitId"> & { unitId?: string | null; unitFactor?: number | null }
    ) {
      const patch: {
        quantity?: string;
        unitId?: string | null;
        unitFactor?: string | null;
        routingOperationId?: string | null;
        position?: string | null;
        costingOnly?: boolean;
      } = {};
      if (input.quantity !== undefined) patch.quantity = String(input.quantity);
      if (input.unitId !== undefined) patch.unitId = input.unitId;
      if (input.unitFactor !== undefined) patch.unitFactor = input.unitFactor !== null ? String(input.unitFactor) : null;
      if (input.routingOperationId !== undefined) patch.routingOperationId = input.routingOperationId;
      if (input.position !== undefined) patch.position = input.position;
      if (input.costingOnly !== undefined) patch.costingOnly = input.costingOnly;
      const [row] = await db
        .update(bomComponents)
        .set(patch)
        .where(and(eq(bomComponents.id, rowId), eq(bomComponents.parentArticleId, parentArticleId)))
        .returning();
      return row ?? null;
    },

    async deleteBomComponent(parentArticleId: string, rowId: string) {
      const [row] = await db
        .delete(bomComponents)
        .where(and(eq(bomComponents.id, rowId), eq(bomComponents.parentArticleId, parentArticleId)))
        .returning();
      return row ?? null;
    },

    // Used to validate that a BOM row's operation link points at one of the
    // parent article's own routing operations.
    async findRoutingOperationById(operationId: string) {
      const [row] = await db.select().from(routingOperations).where(eq(routingOperations.id, operationId));
      return row ?? null;
    },

    async getBomComponents(parentArticleId: string) {
      const rowUnits = alias(units, "row_units");
      return db
        .select({
          id: bomComponents.id,
          parentArticleId: bomComponents.parentArticleId,
          componentArticleId: bomComponents.componentArticleId,
          quantity: bomComponents.quantity,
          componentArticleNumber: articles.articleNumber,
          componentName: articles.name,
          componentIsPhantom: articles.isPhantom,
          unitId: bomComponents.unitId,
          unitFactor: bomComponents.unitFactor,
          // The unit the row displays in: the entered unit, falling back to
          // the component's base unit.
          unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
          routingOperationId: bomComponents.routingOperationId,
          position: bomComponents.position,
          // "Kalkyl" — priced only, never on a TO, no demand.
          costingOnly: bomComponents.costingOnly,
          // Null when the row isn't linked (left join) — the UI shows "—".
          routingOperationSequenceNo: routingOperations.sequenceNo,
        })
        .from(bomComponents)
        .innerJoin(articles, eq(articles.id, bomComponents.componentArticleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(rowUnits, eq(rowUnits.id, bomComponents.unitId))
        .leftJoin(routingOperations, eq(routingOperations.id, bomComponents.routingOperationId))
        .where(eq(bomComponents.parentArticleId, parentArticleId))
        // Entry order, deterministic — the same component may be on several
        // rows (0176), and the import matches those rows in this order too.
        .orderBy(asc(bomComponents.createdAt), asc(bomComponents.id));
    },

    // --- Attached files (ritningar) ---

    // Never selects `data` (bytea) — binary data must not end up in JSON
    // responses. downloadFile() is the only reader that fetches the bytes.
    // With the drawing revision a file belongs to (null = a loose file):
    // the Filer tab shows which files are a drawing's and whether that
    // revision is the one in force.
    async listFiles(articleId: string) {
      return db
        .select({
          id: articleFiles.id,
          articleId: articleFiles.articleId,
          filename: articleFiles.filename,
          contentType: articleFiles.contentType,
          sizeBytes: articleFiles.sizeBytes,
          createdAt: articleFiles.createdAt,
          drawingRevisionId: articleFiles.drawingRevisionId,
          drawingNumber: articleDrawings.drawingNumber,
          revision: articleDrawingRevisions.revision,
          revisionActive: articleDrawingRevisions.isActive,
        })
        .from(articleFiles)
        .leftJoin(articleDrawingRevisions, eq(articleDrawingRevisions.id, articleFiles.drawingRevisionId))
        .leftJoin(articleDrawings, eq(articleDrawings.id, articleDrawingRevisions.drawingId))
        .where(eq(articleFiles.articleId, articleId))
        .orderBy(asc(articleFiles.filename), asc(articleFiles.id));
    },

    // drawingRevisionId: the file becomes that revision's — one per
    // revision, so a file it already had is deleted in the same transaction
    // (Byt fil). The caller has checked the revision is the article's.
    async addFile(input: {
      articleId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      data: Buffer;
      drawingRevisionId?: string | null;
    }) {
      return db.transaction(async (tx) => {
        if (input.drawingRevisionId) {
          await tx.delete(articleFiles).where(eq(articleFiles.drawingRevisionId, input.drawingRevisionId));
        }
        const [row] = await tx.insert(articleFiles).values(input).returning({
          id: articleFiles.id,
          articleId: articleFiles.articleId,
          filename: articleFiles.filename,
          contentType: articleFiles.contentType,
          sizeBytes: articleFiles.sizeBytes,
          createdAt: articleFiles.createdAt,
          drawingRevisionId: articleFiles.drawingRevisionId,
        });
        return row!;
      });
    },

    // Ritningsrevisionens fil from the article's loose files: the loose file
    // moves onto the revision and a file the revision had is deleted. The
    // file row is locked first, so two revisions can't take the same file.
    async linkFileToDrawingRevision(articleId: string, drawingRevisionId: string, fileId: string) {
      return db.transaction(async (tx) => {
        const [file] = await tx
          .select({ id: articleFiles.id, drawingRevisionId: articleFiles.drawingRevisionId })
          .from(articleFiles)
          .where(and(eq(articleFiles.id, fileId), eq(articleFiles.articleId, articleId)))
          .for("update");
        if (!file) return { kind: "not-found" as const };
        if (file.drawingRevisionId === drawingRevisionId) return { kind: "linked" as const };
        if (file.drawingRevisionId !== null) return { kind: "not-loose" as const };
        await tx.delete(articleFiles).where(eq(articleFiles.drawingRevisionId, drawingRevisionId));
        await tx.update(articleFiles).set({ drawingRevisionId }).where(eq(articleFiles.id, fileId));
        return { kind: "linked" as const };
      });
    },

    // The files in force for an order/operation (drawing-files.ts).
    async drawingFilesWithData(ref: DrawingFileRef) {
      return drawingFilesWithData(db, ref);
    },

    async findDrawingRevision(drawingId: string, revisionId: string) {
      const [row] = await db
        .select()
        .from(articleDrawingRevisions)
        .where(and(eq(articleDrawingRevisions.id, revisionId), eq(articleDrawingRevisions.drawingId, drawingId)));
      return row ?? null;
    },

    // The revision with its drawing, when it is the article's (upload with
    // ?drawingRevisionId=).
    async findArticleDrawingRevision(articleId: string, revisionId: string) {
      const [row] = await db
        .select({ id: articleDrawingRevisions.id, drawingId: articleDrawings.id })
        .from(articleDrawingRevisions)
        .innerJoin(articleDrawings, eq(articleDrawings.id, articleDrawingRevisions.drawingId))
        .where(and(eq(articleDrawingRevisions.id, revisionId), eq(articleDrawings.articleId, articleId)));
      return row ?? null;
    },

    async findFile(articleId: string, fileId: string) {
      const [row] = await db
        .select()
        .from(articleFiles)
        .where(and(eq(articleFiles.id, fileId), eq(articleFiles.articleId, articleId)));
      return row ?? null;
    },

    async deleteFile(articleId: string, fileId: string) {
      const [row] = await db
        .delete(articleFiles)
        .where(and(eq(articleFiles.id, fileId), eq(articleFiles.articleId, articleId)))
        .returning({ id: articleFiles.id });
      return row ?? null;
    },

    // Bytes included — for the order mails' attachments: the files in force
    // (loose ones and the drawings' active revisions'), never an older
    // revision's (drawing-files.ts).
    async filesWithData(articleIds: string[]) {
      if (articleIds.length === 0) return [];
      return db
        .select()
        .from(articleFiles)
        .where(and(inArray(articleFiles.articleId, articleIds), currentArticleFileCondition))
        .orderBy(asc(articleFiles.filename));
    },

    // --- Artikelrevisioner ---
    // At most one active per article (partial unique index); the switch runs
    // in a transaction like the customer contacts' primary flag. The first
    // revision created for an article becomes active automatically.

    // Prishistorik on the article card: the standard cost (D1) and the
    // försäljningspris (migration 0169), newest first.
    async listPriceHistory(articleId: string) {
      const [standardCost, salesPrice] = await Promise.all([
        db
          .select({ value: articleStandardCostHistory.cost, validFrom: articleStandardCostHistory.validFrom })
          .from(articleStandardCostHistory)
          .where(eq(articleStandardCostHistory.articleId, articleId))
          .orderBy(desc(articleStandardCostHistory.validFrom), desc(articleStandardCostHistory.id)),
        db
          .select({ value: articleSalesPriceHistory.price, validFrom: articleSalesPriceHistory.validFrom })
          .from(articleSalesPriceHistory)
          .where(eq(articleSalesPriceHistory.articleId, articleId))
          .orderBy(desc(articleSalesPriceHistory.validFrom)),
      ]);
      return { standardCost, salesPrice };
    },

    async listRevisions(articleId: string) {
      return db
        .select()
        .from(articleRevisions)
        .where(eq(articleRevisions.articleId, articleId))
        .orderBy(desc(articleRevisions.isActive), asc(articleRevisions.createdAt));
    },

    async createRevision(articleId: string, input: CreateArticleRevisionInput) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ value: count() })
          .from(articleRevisions)
          .where(eq(articleRevisions.articleId, articleId));
        const makeActive = input.isActive || existing!.value === 0;
        if (makeActive) {
          await tx
            .update(articleRevisions)
            .set({ isActive: false })
            .where(and(eq(articleRevisions.articleId, articleId), eq(articleRevisions.isActive, true)));
        }
        const [row] = await tx
          .insert(articleRevisions)
          .values({ articleId, revision: input.revision, comment: input.comment, isActive: makeActive })
          .returning();
        return row!;
      });
    },

    // The revision is locked (and found) FIRST: an id that is not this
    // article's must not get as far as deactivating the one in force — the
    // transaction committed that with nothing activated. FOR NO KEY UPDATE
    // (the UPDATE's own lock mode): a concurrent delete of it waits, while a
    // TO's revision snapshot (an FK's FOR KEY SHARE on drawing revisions) is
    // not held up.
    async updateRevision(articleId: string, revisionId: string, input: UpdateArticleRevisionInput) {
      return db.transaction(async (tx) => {
        const [target] = await tx
          .select({ id: articleRevisions.id })
          .from(articleRevisions)
          .where(and(eq(articleRevisions.id, revisionId), eq(articleRevisions.articleId, articleId)))
          .for("no key update");
        if (!target) return null;
        if (input.isActive === true) {
          await tx
            .update(articleRevisions)
            .set({ isActive: false })
            .where(and(eq(articleRevisions.articleId, articleId), eq(articleRevisions.isActive, true)));
        }
        const [row] = await tx
          .update(articleRevisions)
          .set(input)
          .where(and(eq(articleRevisions.id, revisionId), eq(articleRevisions.articleId, articleId)))
          .returning();
        return row ?? null;
      });
    },

    async deleteRevision(articleId: string, revisionId: string) {
      const [row] = await db
        .delete(articleRevisions)
        .where(and(eq(articleRevisions.id, revisionId), eq(articleRevisions.articleId, articleId)))
        .returning({ id: articleRevisions.id });
      return row ?? null;
    },

    // --- Ritningsnummer & ritningsrevisioner ---

    // Drawings with their revisions nested — two queries, grouped in code.
    async listDrawings(articleId: string) {
      const drawings = await db
        .select()
        .from(articleDrawings)
        .where(eq(articleDrawings.articleId, articleId))
        .orderBy(asc(articleDrawings.drawingNumber));
      if (drawings.length === 0) return [];
      const revisions = await db
        .select({
          ...getTableColumns(articleDrawingRevisions),
          fileId: articleFiles.id,
          fileName: articleFiles.filename,
          fileContentType: articleFiles.contentType,
          fileSizeBytes: articleFiles.sizeBytes,
        })
        .from(articleDrawingRevisions)
        .leftJoin(articleFiles, eq(articleFiles.drawingRevisionId, articleDrawingRevisions.id))
        .where(inArray(articleDrawingRevisions.drawingId, drawings.map((d) => d.id)))
        .orderBy(desc(articleDrawingRevisions.isActive), asc(articleDrawingRevisions.createdAt));
      // Each revision carries its file (one at most, 0200) — open/print it
      // on demand, also an older revision's.
      const withFile = revisions.map(({ fileId, fileName, fileContentType, fileSizeBytes, ...r }) => ({
        ...r,
        file:
          fileId === null
            ? null
            : { id: fileId, filename: fileName!, contentType: fileContentType!, sizeBytes: fileSizeBytes! },
      }));
      return drawings.map((d) => ({ ...d, revisions: withFile.filter((r) => r.drawingId === d.id) }));
    },

    async findDrawing(articleId: string, drawingId: string) {
      const [row] = await db
        .select()
        .from(articleDrawings)
        .where(and(eq(articleDrawings.id, drawingId), eq(articleDrawings.articleId, articleId)));
      return row ?? null;
    },

    async createDrawing(articleId: string, input: CreateArticleDrawingInput) {
      const [row] = await db
        .insert(articleDrawings)
        .values({ articleId, drawingNumber: input.drawingNumber })
        .returning();
      return row!;
    },

    async updateDrawing(articleId: string, drawingId: string, input: UpdateArticleDrawingInput) {
      const [row] = await db
        .update(articleDrawings)
        .set(input)
        .where(and(eq(articleDrawings.id, drawingId), eq(articleDrawings.articleId, articleId)))
        .returning();
      return row ?? null;
    },

    async deleteDrawing(articleId: string, drawingId: string) {
      const [row] = await db
        .delete(articleDrawings)
        .where(and(eq(articleDrawings.id, drawingId), eq(articleDrawings.articleId, articleId)))
        .returning({ id: articleDrawings.id });
      return row ?? null;
    },

    // Same active-switch semantics as the article revisions, scoped to the
    // drawing. The caller (service) has already verified the drawing belongs
    // to the article.
    async createDrawingRevision(drawingId: string, input: CreateArticleRevisionInput) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ value: count() })
          .from(articleDrawingRevisions)
          .where(eq(articleDrawingRevisions.drawingId, drawingId));
        const makeActive = input.isActive || existing!.value === 0;
        if (makeActive) {
          await tx
            .update(articleDrawingRevisions)
            .set({ isActive: false })
            .where(and(eq(articleDrawingRevisions.drawingId, drawingId), eq(articleDrawingRevisions.isActive, true)));
        }
        const [row] = await tx
          .insert(articleDrawingRevisions)
          .values({ drawingId, revision: input.revision, comment: input.comment, isActive: makeActive })
          .returning();
        return row!;
      });
    },

    // Like updateRevision: the revision is locked and found before the
    // drawing's active one is switched off.
    async updateDrawingRevision(drawingId: string, revisionId: string, input: UpdateArticleRevisionInput) {
      return db.transaction(async (tx) => {
        const [target] = await tx
          .select({ id: articleDrawingRevisions.id })
          .from(articleDrawingRevisions)
          .where(and(eq(articleDrawingRevisions.id, revisionId), eq(articleDrawingRevisions.drawingId, drawingId)))
          .for("no key update");
        if (!target) return null;
        if (input.isActive === true) {
          await tx
            .update(articleDrawingRevisions)
            .set({ isActive: false })
            .where(and(eq(articleDrawingRevisions.drawingId, drawingId), eq(articleDrawingRevisions.isActive, true)));
        }
        const [row] = await tx
          .update(articleDrawingRevisions)
          .set(input)
          .where(and(eq(articleDrawingRevisions.id, revisionId), eq(articleDrawingRevisions.drawingId, drawingId)))
          .returning();
        return row ?? null;
      });
    },

    async deleteDrawingRevision(drawingId: string, revisionId: string) {
      const [row] = await db
        .delete(articleDrawingRevisions)
        .where(and(eq(articleDrawingRevisions.id, revisionId), eq(articleDrawingRevisions.drawingId, drawingId)))
        .returning({ id: articleDrawingRevisions.id });
      return row ?? null;
    },

    // The articles' drawings with today's active revision and its file, in
    // drawing-number order (the structure rows in the Beredning).
    async currentDrawingsByArticle(articleIds: string[]) {
      const map = new Map<
        string,
        { drawingNumber: string; revision: string | null; fileId: string | null; filename: string | null }[]
      >();
      if (articleIds.length === 0) return map;
      const rows = await db
        .select({
          articleId: articleDrawings.articleId,
          drawingNumber: articleDrawings.drawingNumber,
          revision: articleDrawingRevisions.revision,
          fileId: articleFiles.id,
          filename: articleFiles.filename,
        })
        .from(articleDrawings)
        .leftJoin(
          articleDrawingRevisions,
          and(eq(articleDrawingRevisions.drawingId, articleDrawings.id), eq(articleDrawingRevisions.isActive, true))
        )
        .leftJoin(articleFiles, eq(articleFiles.drawingRevisionId, articleDrawingRevisions.id))
        .where(inArray(articleDrawings.articleId, articleIds))
        .orderBy(asc(articleDrawings.drawingNumber));
      for (const { articleId, ...drawing } of rows) {
        const list = map.get(articleId) ?? [];
        list.push(drawing);
        map.set(articleId, list);
      }
      return map;
    },

    // Active revision info for document printing: the active article
    // revision plus every drawing number with its active revision.
    async activeRevisionInfo(articleIds: string[]) {
      const map = new Map<
        string,
        { revision: string | null; drawings: { drawingNumber: string; revision: string | null }[] }
      >();
      if (articleIds.length === 0) return map;
      const activeRevs = await db
        .select()
        .from(articleRevisions)
        .where(and(inArray(articleRevisions.articleId, articleIds), eq(articleRevisions.isActive, true)));
      const drawings = await db
        .select({
          articleId: articleDrawings.articleId,
          drawingNumber: articleDrawings.drawingNumber,
          revision: articleDrawingRevisions.revision,
        })
        .from(articleDrawings)
        .leftJoin(
          articleDrawingRevisions,
          and(
            eq(articleDrawingRevisions.drawingId, articleDrawings.id),
            eq(articleDrawingRevisions.isActive, true)
          )
        )
        .where(inArray(articleDrawings.articleId, articleIds))
        .orderBy(asc(articleDrawings.drawingNumber));

      for (const id of articleIds) map.set(id, { revision: null, drawings: [] });
      for (const rev of activeRevs) map.get(rev.articleId)!.revision = rev.revision;
      for (const d of drawings)
        map.get(d.articleId)!.drawings.push({ drawingNumber: d.drawingNumber, revision: d.revision });
      return map;
    },
  };
}

export type ArticleRepository = ReturnType<typeof createArticleRepository>;
