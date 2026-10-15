import { boolean, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";

// External integration credentials (e.g. the product configurator) for the
// OAuth2 client-credentials flow. `id` doubles as the public "client_id" —
// no separate column needed, same principle as users.id not being duplicated
// with its own "userId" field. No `scope` column: access is fixed to the
// configurator endpoints for every client (see modules/oauth/routes/configurator.routes.ts),
// not a configurable permission system.
export const apiClients = pgTable("api_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  clientSecretHash: varchar("client_secret_hash", { length: 255 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
