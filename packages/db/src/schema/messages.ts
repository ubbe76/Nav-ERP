import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { employees } from "./timereport";

// Meddelanden (migration 0231): conversations between users inside Nav — a
// subject, the participants chosen when it is created, and the messages in
// one thread. Olästa is DERIVED (messages from others after the
// participant's last_read_at), never a stored counter.
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subject: varchar("subject", { length: 200 }).notNull(),
    // Bifogad länk: the page the writer stood on — a path inside Nav (the
    // same rule as a favourite's href, validated in the API layer) and the
    // title it is shown under. Both or neither.
    linkHref: varchar("link_href", { length: 500 }),
    linkTitle: varchar("link_title", { length: 200 }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // = the newest message's created_at, written in the same transaction as
    // the message (under the conversation's row lock).
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_conversations_last_message").on(table.lastMessageAt),
    check("conversations_link_both_or_neither", sql`(${table.linkHref} is null) = (${table.linkTitle} is null)`),
  ]
);

// A participant is a user OR an employee (personalregistret — often without
// a user account; reads at the stämpelterminal after the anställningsnummer).
// Exactly one of the two. `kind` is how the participant was addressed when
// the conversation was created: user (an office user's inbox), terminal (a
// terminal account — the anslagstavla on the stamp terminal) or employee.
export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 10 }).notNull(),
    // Anslagstavlan: the terminal shows the conversation through this
    // Stockholm day. Null on a terminal row = Ta bort från terminalen.
    boardUntil: date("board_until"),
    // Everything up to this instant is read; null = nothing read yet.
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    // Arkivera: hidden from the inbox while archived_at >= the
    // conversation's last_message_at — a newer message shows it again
    // without anything being written here. Återställ sets it to null.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("conversation_participants_user_unique").on(table.conversationId, table.userId).where(sql`${table.userId} is not null`),
    uniqueIndex("conversation_participants_employee_unique")
      .on(table.conversationId, table.employeeId)
      .where(sql`${table.employeeId} is not null`),
    index("idx_conversation_participants_user").on(table.userId).where(sql`${table.userId} is not null`),
    index("idx_conversation_participants_employee").on(table.employeeId).where(sql`${table.employeeId} is not null`),
    check("conversation_participants_one_party", sql`num_nonnulls(${table.userId}, ${table.employeeId}) = 1`),
    check("conversation_participants_kind", sql`${table.kind} in ('user', 'terminal', 'employee')`),
    check("conversation_participants_kind_party", sql`(${table.kind} = 'employee') = (${table.employeeId} is not null)`),
    check("conversation_participants_board_terminal", sql`${table.boardUntil} is null or ${table.kind} = 'terminal'`),
  ]
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    // clock_timestamp() taken under the conversation's row lock, so the
    // messages of one conversation are strictly ordered by commit.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_messages_conversation_created").on(table.conversationId, table.createdAt)]
);
