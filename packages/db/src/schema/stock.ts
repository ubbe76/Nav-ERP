import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { articles } from "./article";
import { users } from "./auth";

export const stockTransactionTypeEnum = pgEnum("stock_transaction_type", [
  "purchase_receipt",
  "sales_delivery",
  "mo_consumption",
  "mo_receipt",
  "inventory_adjustment",
  // Lagerflytt — written as a pair of rows (one negative on the source
  // location, one positive on the target) sharing a generated reference_id.
  "stock_transfer",
]);

export const warehouses = pgTable("warehouses", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  active: boolean("active").notNull().default(true),
});

export const stockLocations = pgTable(
  "stock_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    active: boolean("active").notNull().default(true),
    // Fast lagerplats (migration 0179): a fixed location stays active (and
    // stays the articles' Lagerplats) when it is emptied; only a temporary
    // one (fixed = false) is deactivated by deactivateEmptyLocation. Every
    // location created before the column is fixed.
    fixed: boolean("fixed").notNull().default(true),
    // Etikettkod (#4): the label and a scan say LP + this number (LP0042) —
    // short, ASCII only (a name may hold å/ä/ö that Code 128 cannot encode)
    // and stable when the location is renamed. Existing rows got theirs when
    // the column was added.
    labelNumber: integer("label_number").generatedAlwaysAsIdentity().notNull().unique(),
    // Spärrad lagerplats (migration 0185, e.g. Karantän/Reklamation): the
    // balance there is still the company's stock and is valued as usual, but
    // it is not usable — the behovsberäkning, Materialbrist and the
    // Leveranstidskontroll leave it out (onHandByArticle) and Automatiskt
    // never draws from it. A property of the place, not a stock movement:
    // blocking writes no stock_transactions row. Set/cleared only through
    // POST /stock/locations/:id/block|unblock (or a location created blocked).
    blocked: boolean("blocked").notNull().default(false),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    blockedNote: varchar("blocked_note", { length: 200 }),
  },
  (table) => [
    unique().on(table.warehouseId, table.name),
    // Same shape as closed <=> closed_at: a blocked place says since when, an
    // open one carries neither a time nor a note.
    check(
      "stock_locations_blocked_consistent",
      sql`(${table.blocked} AND ${table.blockedAt} IS NOT NULL) OR (NOT ${table.blocked} AND ${table.blockedAt} IS NULL AND ${table.blockedNote} IS NULL)`
    ),
    // The remainder of an Automatiskt draw lands on "***" (withRemainder) —
    // a blocked "***" would put minus on a place that is not counted and so
    // overstate the usable balance.
    check("stock_locations_fallback_not_blocked", sql`NOT (${table.blocked} AND ${table.name} = '***')`),
  ]
);

// Alternativa lagerplatser (migration 0186): the article's places after its
// huvudplats (articles.default_location_id), in sort_order 1..20. The order
// huvudplats → alternatives is derived when read, never stored as a list.
// An inflow without a chosen place lands on the first active, open one of
// them (usableArticleLocations), and Automatiskt draws from them in that
// order before every other place (outflow-allocation.ts). Written only by
// PUT /articles/:id/locations (the whole set, under the article's row lock)
// and pruned by deactivateEmptyLocation when a temporary place is retired.
// Both FKs cascade: the row is only an assignment (places are never deleted
// anyway). The FK to articles is declared here, like default_location_id's,
// so the schema modules do not import each other in a circle.
export const articleAlternativeLocations = pgTable(
  "article_alternative_locations",
  {
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => stockLocations.id, { onDelete: "cascade" }),
    sortOrder: smallint("sort_order").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.locationId] }),
    unique("article_alternative_locations_article_sort_order_unique").on(table.articleId, table.sortOrder),
    // deactivateEmptyLocation deletes a retired place's assignments.
    index("idx_article_alternative_locations_location").on(table.locationId),
    check("article_alternative_locations_sort_order_range", sql`${table.sortOrder} BETWEEN 1 AND 20`),
  ]
);

// Batch (#8, migration 0213): a named lot of ONE article — the supplier's
// batch number on an inleverans (empty = the IO number), the TO number for
// manufactured goods, a number typed on a justering or read by the
// saldoimport. A dimension on the stock log (stock_transactions.batch_id);
// a row WITHOUT a batch is "Okänd" — there is no Okänd row here, since the
// log is append-only and everything booked before the article became
// batchstyrd has none. Unique per article, case-insensitively (the IO number
// as the default makes a global number impossible). Never deleted (the log
// references it, restrict). created_at is the batch's AGE: Automatiskt draws
// Okänd first, then the oldest batch (compareBatches, outflow-allocation.ts).
// `origin` and the two order references say how the batch was CREATED —
// information; the trace reads the log.
export const stockBatchOriginEnum = pgEnum("stock_batch_origin", ["purchase_receipt", "manufacturing_order", "manual", "import"]);

export const stockBatches = pgTable(
  "stock_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    batchNumber: varchar("batch_number", { length: 50 }).notNull(),
    origin: stockBatchOriginEnum("origin").notNull(),
    // FKs (set null) declared by hand in the migration — purchase.ts and
    // manufacturing.ts import this file.
    purchaseOrderId: uuid("purchase_order_id"),
    manufacturingOrderId: uuid("manufacturing_order_id"),
    // Utgångsdatum (0214): the LAST usable day — the batch is utgången when
    // expires_on < the Stockholm day. Null = no date. Set at the batch's
    // first inflow (getOrCreateBatch), corrected with PATCH /stock/batches/:id
    // — this table is not part of the append-only log.
    expiresOn: date("expires_on"),
    // Batchdatum (0214): the batch's AGE when it is not the day the row was
    // created (saldoimporten). Null = created_at's Stockholm day.
    batchDate: date("batch_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("idx_stock_batches_expires_on")
      .on(table.expiresOn)
      .where(sql`${table.expiresOn} IS NOT NULL`),
    uniqueIndex("stock_batches_article_number_unique").on(table.articleId, sql`lower(${table.batchNumber})`),
    index("idx_stock_batches_manufacturing_order")
      .on(table.manufacturingOrderId)
      .where(sql`${table.manufacturingOrderId} IS NOT NULL`),
    // Spårbarhetssidans sökning: lower(batch_number) LIKE 'x%'.
    index("idx_stock_batches_number_search").on(sql`lower(${table.batchNumber}) text_pattern_ops`),
    check("stock_batches_number_trimmed", sql`${table.batchNumber} = btrim(${table.batchNumber}) AND ${table.batchNumber} <> ''`),
    // "Okänd" is what a row without a batch is called everywhere.
    check("stock_batches_number_not_reserved", sql`lower(${table.batchNumber}) <> 'okänd'`),
  ]
);

// Append-only händelselogg. Aktuellt saldo ska ALDRIG skrivas via UPDATE —
// bara härledas ur SUM(quantity_delta) via stock_balances-vyn.
export const stockTransactions = pgTable(
  "stock_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    // Mandatory — a movement without an explicit location resolves to the
    // article's default location or the auto-created "***" location before
    // it reaches the database (see location-resolver.ts).
    locationId: uuid("location_id")
      .notNull()
      .references(() => stockLocations.id, { onDelete: "restrict" }),
    quantityDelta: numeric("quantity_delta", { precision: 14, scale: 4 }).notNull(),
    // Styckkostnad i SEK — stämplas bara på INFLÖDEN (D0), så loggen blir
    // facit även för lagervärdet och inte bara för kvantiteten. Utflöden
    // bär inget eget pris utan förbrukar till gällande snitt, och
    // lagerflytt är ingen värderingshändelse — båda lämnas null.
    // Nullable även för inflöden: rader skrivna före D0 har ingen kostnad
    // att hämta, och att gissa en i efterhand vore att uppfinna data.
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }),
    transactionType: stockTransactionTypeEnum("transaction_type").notNull(),
    referenceId: uuid("reference_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Värderingsdatum (#26, migration 0180): the moment the row counts in
    // everything "as of a date" (lagervärdering, bokslutets Lagerförändring,
    // the moving-average replay, lagerloggens datum och löpande saldo). NULL
    // = the same as created_at — only a stock count registered "per
    // underlagets datum" sets it (to the session's freeze time). created_at
    // never changes, so the log still shows when the row was registered.
    // Every reader goes through stockValuedAt (stock/repository/valued-at.ts).
    valuedAt: timestamp("valued_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    // Batch (#8, migration 0213). NULL = Okänd: every row of an article that
    // is not batchstyrd, everything booked before it became one, and the
    // remainder of an Automatiskt draw. Every writer sets it explicitly; a
    // row that reverses another (Ångra) carries the SAME batch_id as the row
    // it reverses, whatever the article's flag says now. The append-only
    // trigger compares the whole row, so it can never be changed afterwards.
    batchId: uuid("batch_id").references(() => stockBatches.id, { onDelete: "restrict" }),
  },
  (table) => [
    index("idx_stock_transactions_article_location").on(table.articleId, table.locationId),
    // Spårningen per batch; partial, so rows without a batch cost nothing.
    index("idx_stock_transactions_batch")
      .on(table.batchId)
      .where(sql`${table.batchId} IS NOT NULL`),
    // Per place (0185): the lagerplatsregister's sums, locationHoldsStock,
    // the stock count's freeze and the block response's counts.
    index("idx_stock_transactions_location_article").on(table.locationId, table.articleId),
    // Lagerloggen sorts and date-filters across all articles.
    index("idx_stock_transactions_created_at").on(table.createdAt),
    // …on the värderingsdatum since #26 — the same expression as stockValuedAt.
    index("idx_stock_transactions_valued_at").on(sql`coalesce(${table.valuedAt}, ${table.createdAt})`),
    // Källa resolves rows by reference_id.
    index("idx_stock_transactions_reference_id").on(table.referenceId),
  ]
);

export const stockBalances = pgView("stock_balances").as((qb) =>
  qb
    .select({
      articleId: stockTransactions.articleId,
      locationId: stockTransactions.locationId,
      quantityOnHand: sql<string>`sum(${stockTransactions.quantityDelta})`.as("quantity_on_hand"),
    })
    .from(stockTransactions)
    .groupBy(stockTransactions.articleId, stockTransactions.locationId)
);

export const stockCountStatusEnum = pgEnum("stock_count_status", ["open", "posted", "cancelled"]);

// Inventeringssession (D2): freezes a location's booked balances into count
// rows, collects counted quantities, and posts the differences as
// inventory_adjustment rows. The diff (counted - snapshot) is always derived,
// never stored — same "the log is the truth" principle as stock_balances.
export const stockCountSessions = pgTable(
  "stock_count_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    countNumber: varchar("count_number", { length: 20 }).notNull().unique(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => stockLocations.id, { onDelete: "restrict" }),
    status: stockCountStatusEnum("status").notNull().default("open"),
    // Monitor-style per-session choice: when true, every stock_transactions
    // writer refuses the whole location while the session is open (see
    // count-guard.ts). When false, movements are allowed and flagged.
    blocksTransactions: boolean("blocks_transactions").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (table) => [
    // One open session per location — two would double-book the differences.
    // Same partial-unique pattern as customer_contacts' primary contact.
    uniqueIndex("uq_stock_count_open_location")
      .on(table.locationId)
      .where(sql`${table.status} = 'open'`),
  ]
);

export const stockCountRows = pgTable(
  "stock_count_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => stockCountSessions.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    // Booked balance at freeze (or add) time. counted_quantity null = not
    // counted yet — skipped at posting, never treated as zero.
    snapshotQuantity: numeric("snapshot_quantity", { precision: 14, scale: 4 }).notNull(),
    countedQuantity: numeric("counted_quantity", { precision: 14, scale: 4 }),
    note: text("note"),
    // Batch (#8, migration 0213): a batchstyrd article is counted per batch
    // — one row per (article, batch), NULL = Okänd. Every other article has
    // its one row without a batch, as before.
    batchId: uuid("batch_id").references(() => stockBatches.id, { onDelete: "restrict" }),
  },
  // NULLS NOT DISTINCT (PG15+): still one Okänd row per article.
  (table) => [unique("stock_count_rows_session_article_batch_unique").on(table.sessionId, table.articleId, table.batchId).nullsNotDistinct()]
);
