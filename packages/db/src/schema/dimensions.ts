import { boolean, date, pgEnum, pgTable, timestamp, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { customers } from "./sales";

// Kostnadsställen och projekt (bokföringsgranskningen etapp 5 del A,
// migration 0149): the two fixed SIE dimensions — 1 Kostnadsställe and 6
// Projekt. No free dimensions in v1 (the same "fast katalog" line as the
// momskoder). Both are small registers under Ekonomi with the base-data
// register behaviour (delete with reassignment through the register module's
// reference map); `code` is the SIE object code (#OBJEKT), unique per
// dimension. Every referencing column (verification_rows, invoice_rows,
// supplier_invoice_rows, headers, defaults) is nullable with ON DELETE
// restrict, so a dimension that is still booked on can never vanish.
//
// This file imports `customers` from sales.ts while sales.ts imports the two
// tables below — the same lazy-reference cycle sales.ts ↔ shipping.ts already
// lives with: nothing here dereferences the other module at evaluation time.

export const costCenters = pgTable("cost_centers", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  // Inactive = cannot be picked on new rows; the rows that carry it stay.
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A closed project cannot be picked on new rows (400 project-closed); the
// rows already booked on it stay, and the project report keeps reading them.
export const projectStatusEnum = pgEnum("project_status", ["open", "closed"]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  active: boolean("active").notNull().default(true),
  status: projectStatusEnum("status").notNull().default("open"),
  // The customer the project is run for (optional): the project report
  // lists the customer's orders that point at the project.
  customerId: uuid("customer_id").references((): AnyPgColumn => customers.id, { onDelete: "set null" }),
  startDate: date("start_date"),
  endDate: date("end_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
