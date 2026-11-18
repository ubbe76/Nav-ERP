import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { employees } from "./timereport";

// Meddelanden (migrations 0231 and 0232): conversations between users inside
// Nav — a subject, the participants (chosen when it is created; added,
// removed and leaving since 0232), and the rows of one thread: messages and
// händelserader. Olästa is DERIVED (others' undeleted messages after the
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
    // = the newest ROW's created_at — a message or a händelserad (0232). A
    // new row is stamped strictly after it, so the thread stays ordered by
    // commit; a händelserad moves only this one, never last_message_at (it
    // must not bring an archived conversation back or make anything unread).
    lastEntryAt: timestamp("last_entry_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_conversations_last_message").on(table.lastMessageAt),
    check("conversations_link_both_or_neither", sql`(${table.linkHref} is null) = (${table.linkTitle} is null)`),
  ]
);

// A participant is a user OR an employee (personalregistret — often without
// a user account; reads at the stämpelterminal after the anställningsnummer).
// Exactly one of the two. `kind` is how the participant was addressed when
// the conversation was created or the participant added: user (an office user's inbox), terminal (a
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

// One row of the thread. kind "message": written by a user (sender_id) OR by
// an employee at the stämpelterminal (sender_employee_id) — exactly one, or
// none once the employee has been erased (then the text is gone too). Radera
// empties body and sets deleted_at; the row stays ("Meddelandet togs bort").
// kind "event" (händelserad): someone added or removed participants, or
// left. The actor is sender_id; the persons it is about are REFERENCES in
// message_event_targets — never a copy of a name, so erasing or anonymizing
// an employee needs nothing done here (names are rendered at read).
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id").references(() => users.id, { onDelete: "restrict" }),
    senderEmployeeId: uuid("sender_employee_id").references(() => employees.id, { onDelete: "set null" }),
    kind: varchar("kind", { length: 10 }).notNull().default("message"),
    eventType: varchar("event_type", { length: 10 }),
    body: text("body"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // clock_timestamp() taken under the conversation's row lock, strictly
    // after the conversation's last_entry_at: the rows of one conversation
    // are strictly ordered by commit.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_messages_conversation_created").on(table.conversationId, table.createdAt),
    index("idx_messages_sender_employee").on(table.senderEmployeeId).where(sql`${table.senderEmployeeId} is not null`),
    check("messages_kind", sql`${table.kind} in ('message', 'event')`),
    check("messages_one_sender", sql`num_nonnulls(${table.senderId}, ${table.senderEmployeeId}) <= 1`),
    // A message has its text until it is deleted, and a sender unless it is
    // deleted (an erased employee's reply).
    check(
      "messages_message_shape",
      sql`${table.kind} <> 'message' or (${table.eventType} is null and (${table.body} is null) = (${table.deletedAt} is not null) and (${table.deletedAt} is not null or num_nonnulls(${table.senderId}, ${table.senderEmployeeId}) = 1))`
    ),
    check(
      "messages_event_shape",
      sql`${table.kind} <> 'event' or (${table.eventType} in ('added', 'removed', 'left') and ${table.body} is null and ${table.deletedAt} is null and ${table.senderId} is not null)`
    ),
  ]
);

// Who a händelserad is about (added / removed). A reference to the user or
// the employee; both null = the person has been erased since ("en borttagen
// deltagare").
export const messageEventTargets = pgTable(
  "message_event_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
  },
  (table) => [
    index("idx_message_event_targets_message").on(table.messageId),
    index("idx_message_event_targets_employee").on(table.employeeId).where(sql`${table.employeeId} is not null`),
    check("message_event_targets_one_party", sql`num_nonnulls(${table.userId}, ${table.employeeId}) <= 1`),
  ]
);
