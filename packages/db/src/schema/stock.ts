import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  numeric,
  pgEnum,
  pgTable,
  pgView,
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
  },
  (table) => [unique().on(table.warehouseId, table.name)]
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
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("idx_stock_transactions_article_location").on(table.articleId, table.locationId),
    // Lagerloggen sorts and date-filters across all articles.
    index("idx_stock_transactions_created_at").on(table.createdAt),
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
  },
  (table) => [unique().on(table.sessionId, table.articleId)]
);
