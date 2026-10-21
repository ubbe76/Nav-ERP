import { date, integer, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { emailLog } from "./mail";

// Aviseringar — the alerts themselves are derived at every read and never
// stored. The one thing the digest job persists is this log: one row per
// recipient and Stockholm day, so no user can ever get the daily
// sammanställning twice. The row is CLAIMED (INSERT … ON CONFLICT DO NOTHING)
// before anything is sent — the unique constraint is the reservation that
// keeps two processes or two ticks from both sending — and then becomes
// sent, empty (nothing to report, no mail) or failed (the mail did not go
// out; it is not retried that day, the e-mail log shows why).
export const alertDigestRuns = pgTable(
  "alert_digest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The Stockholm day the digest is for.
    digestDate: date("digest_date").notNull(),
    // claimed | sent | empty | failed
    status: varchar("status", { length: 16 }).notNull(),
    alertCount: integer("alert_count").notNull().default(0),
    emailLogId: uuid("email_log_id").references(() => emailLog.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("alert_digest_runs_user_id_digest_date_unique").on(table.userId, table.digestDate)]
);
