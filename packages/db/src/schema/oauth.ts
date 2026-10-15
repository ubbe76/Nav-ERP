import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { customers } from "./sales";

// External integration credentials (e.g. the product configurator) for the
// OAuth2 client-credentials flow. `id` doubles as the public "client_id" —
// no separate column needed, same principle as users.id not being duplicated
// with its own "userId" field. What a client may call is its `scopes` list
// and optional `customer_id` (behörigheter per klient, alfaplanen 4.9).
export const apiClients = pgTable("api_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  clientSecretHash: varchar("client_secret_hash", { length: 255 }).notNull(),
  active: boolean("active").notNull().default(true),
  // Behörigheter per OAuth-klient — see packages/shared/src/oauth.ts.
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  // A client bound to a customer acts on that customer only (null = any).
  customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
