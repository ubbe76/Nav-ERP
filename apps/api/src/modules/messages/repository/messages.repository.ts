import { and, asc, desc, eq, exists, gte, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  conversationParticipants,
  conversations,
  employees,
  messageEventTargets,
  messages,
  permissionGroups,
  users,
  type Db,
  type Tx,
} from "@navet/db";
import { ilikePattern, type MessageEventType, type MessageKind, type ParticipantKind, type UserRole } from "@navet/shared";

// Meddelanden (migrations 0231, 0232). Invariants this file owns:
//
// - Olästa is derived: an undeleted MESSAGE (never a händelserad) from
//   someone else with created_at after the participant's last_read_at. last_read_at and archived_at are only ever
//   set to a MESSAGE's timestamp, in SQL (never now(), never through a JS
//   Date) — so a message committing at the same moment can not end up
//   "read" unseen.
// - A row (message or händelserad) is inserted under the conversation's row
//   lock (FOR UPDATE) with a timestamp strictly after the conversation's
//   last_entry_at, and last_entry_at is written in the same transaction: the
//   rows of one conversation are strictly ordered by commit. A message also
//   moves last_message_at; a händelserad never does (it must not bring an
//   archived conversation back). appendRow is the ONE place that does this.
// - Lock order: the conversation row first, then participants/messages.
//   Every write that changes participants or the thread takes it.
// - Arkiverad = archived_at >= last_message_at: a newer message shows the
//   conversation again without any write to the participant rows.

const me = alias(conversationParticipants, "me");
const senders = alias(users, "message_senders");
const senderEmployees = alias(employees, "message_sender_employees");

// A row that can be unread / shown on the terminal: a message, not deleted.
const visibleMessageSql = sql`(${messages.kind} = 'message' and ${messages.deletedAt} is null)`;

// Millisecond precision: the timestamps are compared with each other in SQL
// and also travel through JS Dates, which hold no more.
const nowMs = sql`date_trunc('milliseconds', clock_timestamp())`;

const archivedSql = sql<boolean>`(${me.archivedAt} is not null and ${me.archivedAt} >= ${conversations.lastMessageAt})`;

export interface ParticipantRow {
  // The participant row's own id (Ta bort names it).
  id: string;
  conversationId: string;
  kind: ParticipantKind;
  userId: string | null;
  employeeId: string | null;
  name: string;
  employeeNumber: string | null;
  lastReadAt: Date | null;
  boardUntil: string | null;
  // An undeleted message from someone else after last_read_at.
  hasUnread: boolean;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  kind: MessageKind;
  eventType: MessageEventType | null;
  // A user, an employee (a reply from the terminal) — or neither: the
  // employee has been erased, and the text with them.
  senderId: string | null;
  senderEmployeeId: string | null;
  senderName: string | null;
  body: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface EventTargetRow {
  messageId: string;
  userId: string | null;
  employeeId: string | null;
  // null = erased since.
  name: string | null;
}

// Locks the conversation row — the first thing every write does.
async function lockConversation(tx: Tx, conversationId: string) {
  const [locked] = await tx
    .select({ id: conversations.id, createdBy: conversations.createdBy })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for("update");
  return locked ?? null;
}

async function userParticipant(tx: Tx, conversationId: string, userId: string) {
  const [row] = await tx
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, userId)));
  return row ?? null;
}

// One new row of the thread, under the conversation's lock (the caller holds
// it): stamped strictly after the newest row. A message moves
// last_message_at too; a händelserad only last_entry_at.
async function appendRow(
  tx: Tx,
  conversationId: string,
  row:
    | { kind: "message"; senderId: string; body: string }
    | { kind: "message"; senderEmployeeId: string; body: string }
    | { kind: "event"; senderId: string; eventType: MessageEventType }
): Promise<string> {
  const [inserted] = await tx
    .insert(messages)
    .values({
      conversationId,
      ...row,
      createdAt: sql`(select greatest(${nowMs}, last_entry_at + interval '1 millisecond') from conversations where id = ${conversationId})`,
    })
    .returning({ id: messages.id });
  const at = sql`(select created_at from messages where id = ${inserted!.id})`;
  await tx
    .update(conversations)
    .set(row.kind === "message" ? { lastEntryAt: at, lastMessageAt: at } : { lastEntryAt: at })
    .where(eq(conversations.id, conversationId));
  return inserted!.id;
}

async function appendEvent(
  tx: Tx,
  conversationId: string,
  actorId: string,
  eventType: MessageEventType,
  targets: { userId?: string | null; employeeId?: string | null }[]
) {
  const id = await appendRow(tx, conversationId, { kind: "event", senderId: actorId, eventType });
  if (targets.length > 0) {
    await tx
      .insert(messageEventTargets)
      .values(targets.map((t) => ({ messageId: id, userId: t.userId ?? null, employeeId: t.employeeId ?? null })));
  }
}

export interface NewParticipant {
  kind: ParticipantKind;
  userId?: string;
  employeeId?: string;
  boardUntil?: string | null;
}

export function createMessagesRepository(db: Db) {
  async function participantsOf(conversationIds: string[]): Promise<ParticipantRow[]> {
    if (conversationIds.length === 0) return [];
    const rows = await db
      .select({
        id: conversationParticipants.id,
        conversationId: conversationParticipants.conversationId,
        kind: conversationParticipants.kind,
        userId: conversationParticipants.userId,
        employeeId: conversationParticipants.employeeId,
        userName: users.name,
        employeeName: employees.name,
        employeeNumber: employees.employeeNumber,
        lastReadAt: conversationParticipants.lastReadAt,
        boardUntil: conversationParticipants.boardUntil,
        hasUnread: sql<boolean>`exists (
          select 1 from messages m
          where m.conversation_id = ${conversationParticipants.conversationId}
            and m.kind = 'message' and m.deleted_at is null
            and (${conversationParticipants.userId} is null or m.sender_id is distinct from ${conversationParticipants.userId})
            and (${conversationParticipants.employeeId} is null or m.sender_employee_id is distinct from ${conversationParticipants.employeeId})
            and (${conversationParticipants.lastReadAt} is null or m.created_at > ${conversationParticipants.lastReadAt}))`,
      })
      .from(conversationParticipants)
      .leftJoin(users, eq(users.id, conversationParticipants.userId))
      .leftJoin(employees, eq(employees.id, conversationParticipants.employeeId))
      .where(inArray(conversationParticipants.conversationId, conversationIds))
      .orderBy(
        asc(conversationParticipants.conversationId),
        sql`case ${conversationParticipants.kind} when 'user' then 0 when 'terminal' then 1 else 2 end`,
        asc(sql`coalesce(${users.name}, ${employees.name})`),
        asc(conversationParticipants.id)
      );
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      kind: row.kind as ParticipantKind,
      userId: row.userId,
      employeeId: row.employeeId,
      name: row.userName ?? row.employeeName ?? "",
      employeeNumber: row.employeeNumber,
      lastReadAt: row.lastReadAt,
      boardUntil: row.boardUntil,
      hasUnread: row.hasUnread,
    }));
  }

  const messageColumns = {
    id: messages.id,
    conversationId: messages.conversationId,
    kind: sql<MessageKind>`${messages.kind}`,
    eventType: sql<MessageEventType | null>`${messages.eventType}`,
    senderId: messages.senderId,
    senderEmployeeId: messages.senderEmployeeId,
    // Rendered at read: an anonymized employee's row already carries the
    // neutral name, an erased one has no sender left.
    senderName: sql<string | null>`coalesce(${senders.name}, ${senderEmployees.name})`,
    body: messages.body,
    deletedAt: messages.deletedAt,
    createdAt: messages.createdAt,
  };
  // Others' undeleted messages after the reader's last_read_at.
  const unreadFor = (userId: string) =>
    and(
      visibleMessageSql,
      sql`${messages.senderId} is distinct from ${userId}`,
      sql`(${me.lastReadAt} is null or ${messages.createdAt} > ${me.lastReadAt})`
    );

  return {
    participantsOf,

    // Every person account that could be a recipient, with what the service
    // needs to classify it (office user / terminal account / neither).
    async listUserCandidates(): Promise<{ id: string; name: string; role: UserRole; groupPermissions: string[] | null }[]> {
      return db
        .select({ id: users.id, name: users.name, role: users.role, groupPermissions: permissionGroups.permissions })
        .from(users)
        .leftJoin(permissionGroups, eq(permissionGroups.id, users.permissionGroupId))
        .where(and(eq(users.active, true), isNull(users.deletedAt), eq(users.kind, "person")))
        .orderBy(asc(users.name), asc(users.id));
    },

    // Active employees — anställningsnummer and name only, like
    // GET /employees/directory (never widen: any office user reads this).
    async listEmployeeCandidates(): Promise<{ id: string; employeeNumber: string; name: string }[]> {
      return db
        .select({ id: employees.id, employeeNumber: employees.employeeNumber, name: employees.name })
        .from(employees)
        .where(and(eq(employees.active, true), isNull(employees.anonymizedAt)))
        .orderBy(asc(employees.employeeNumber), asc(employees.id));
    },

    // The conversation, its first message and every participant in one
    // transaction. The creator is a participant who has read their own
    // message.
    async createConversation(input: {
      subject: string;
      link: { href: string; title: string } | null;
      createdBy: string;
      body: string;
      recipients: NewParticipant[];
    }): Promise<string> {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .insert(conversations)
          .values({
            subject: input.subject,
            linkHref: input.link?.href ?? null,
            linkTitle: input.link?.title ?? null,
            createdBy: input.createdBy,
            createdAt: nowMs,
            lastMessageAt: nowMs,
            lastEntryAt: nowMs,
          })
          .returning({ id: conversations.id });
        const id = conversation!.id;
        // One statement, so both timestamps are the same instant.
        await tx.execute(sql`
          with stamp as (
            update conversations set last_message_at = created_at, last_entry_at = created_at where id = ${id} returning created_at
          )
          insert into messages (conversation_id, sender_id, body, created_at)
          select ${id}, ${input.createdBy}, ${input.body}, created_at from stamp`);
        await tx.insert(conversationParticipants).values([
          {
            conversationId: id,
            userId: input.createdBy,
            kind: "user",
            lastReadAt: sql`(select created_at from conversations where id = ${id})`,
          },
          ...input.recipients.map((r) => ({
            conversationId: id,
            userId: r.userId ?? null,
            employeeId: r.employeeId ?? null,
            kind: r.kind,
            boardUntil: r.boardUntil ?? null,
          })),
        ]);
        return id;
      });
    },

    // The inbox: the conversations the user takes part in, newest message
    // first. Rows and count share one where.
    async listConversations(userId: string, query: { search?: string; archived: boolean; limit: number; offset: number }) {
      const conditions: SQL[] = [eq(me.userId, userId), query.archived ? archivedSql : sql`not ${archivedSql}`];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(
          or(
            ilike(conversations.subject, pattern),
            exists(
              db
                .select({ one: sql`1` })
                .from(messages)
                .where(and(eq(messages.conversationId, conversations.id), ilike(messages.body, pattern)))
            )
          )!
        );
      }
      const where = and(...conditions);
      const [rows, [count]] = await Promise.all([
        db
          .select({
            id: conversations.id,
            subject: conversations.subject,
            linkHref: conversations.linkHref,
            linkTitle: conversations.linkTitle,
            createdBy: conversations.createdBy,
            createdAt: conversations.createdAt,
            lastMessageAt: conversations.lastMessageAt,
            archived: archivedSql,
          })
          .from(conversations)
          .innerJoin(me, eq(me.conversationId, conversations.id))
          .where(where)
          .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(conversations)
          .innerJoin(me, eq(me.conversationId, conversations.id))
          .where(where),
      ]);
      return { rows, total: count?.n ?? 0 };
    },

    // The newest message of each conversation (a deleted one included — the
    // inbox says so; never a händelserad).
    async lastMessages(conversationIds: string[]): Promise<MessageRow[]> {
      if (conversationIds.length === 0) return [];
      return db
        .selectDistinctOn([messages.conversationId], messageColumns)
        .from(messages)
        .leftJoin(senders, eq(senders.id, messages.senderId))
        .leftJoin(senderEmployees, eq(senderEmployees.id, messages.senderEmployeeId))
        .where(and(inArray(messages.conversationId, conversationIds), eq(messages.kind, "message")))
        .orderBy(asc(messages.conversationId), desc(messages.createdAt), desc(messages.id));
    },

    // Unread messages per conversation for the user (others' messages after
    // last_read_at). Without ids: every conversation the user takes part in.
    async unreadCounts(userId: string, conversationIds?: string[]): Promise<Map<string, number>> {
      if (conversationIds && conversationIds.length === 0) return new Map();
      const rows = await db
        .select({ conversationId: messages.conversationId, n: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(me, and(eq(me.conversationId, messages.conversationId), eq(me.userId, userId)))
        .where(and(unreadFor(userId), conversationIds ? inArray(messages.conversationId, conversationIds) : undefined))
        .groupBy(messages.conversationId);
      return new Map(rows.map((row) => [row.conversationId, row.n]));
    },

    // The newest unread message for the user, with its conversation.
    async latestUnread(userId: string) {
      const [row] = await db
        .select({
          conversationId: conversations.id,
          subject: conversations.subject,
          messageId: messages.id,
          senderName: messageColumns.senderName,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(me, and(eq(me.conversationId, messages.conversationId), eq(me.userId, userId)))
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .leftJoin(senders, eq(senders.id, messages.senderId))
        .leftJoin(senderEmployees, eq(senderEmployees.id, messages.senderEmployeeId))
        .where(unreadFor(userId))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);
      return row ?? null;
    },

    // The conversation as the user sees it; null when the user is not a
    // participant (or it does not exist — the caller can not tell).
    async findForUser(userId: string, id: string) {
      const [row] = await db
        .select({
          id: conversations.id,
          subject: conversations.subject,
          linkHref: conversations.linkHref,
          linkTitle: conversations.linkTitle,
          createdBy: conversations.createdBy,
          createdAt: conversations.createdAt,
          lastMessageAt: conversations.lastMessageAt,
          archived: archivedSql,
        })
        .from(conversations)
        .innerJoin(me, eq(me.conversationId, conversations.id))
        .where(and(eq(conversations.id, id), eq(me.userId, userId)));
      return row ?? null;
    },

    // The thread, oldest first. `board`: only what the terminal shows —
    // undeleted messages, the newest `limit` per conversation.
    async messagesOf(conversationIds: string[], board?: { limit: number }): Promise<MessageRow[]> {
      const limitPerConversation = board?.limit;
      if (conversationIds.length === 0) return [];
      const rows = await db
        .select({
          ...messageColumns,
          rank: sql<number>`row_number() over (partition by ${messages.conversationId} order by ${messages.createdAt} desc, ${messages.id} desc)::int`,
        })
        .from(messages)
        .leftJoin(senders, eq(senders.id, messages.senderId))
        .leftJoin(senderEmployees, eq(senderEmployees.id, messages.senderEmployeeId))
        .where(and(inArray(messages.conversationId, conversationIds), board ? visibleMessageSql : undefined))
        .orderBy(asc(messages.conversationId), asc(messages.createdAt), asc(messages.id));
      return rows.filter((row) => limitPerConversation === undefined || row.rank <= limitPerConversation).map(({ rank: _rank, ...row }) => row);
    },

    // Who the händelserader are about — references, named at read.
    async eventTargetsOf(messageIds: string[]): Promise<EventTargetRow[]> {
      if (messageIds.length === 0) return [];
      return db
        .select({
          messageId: messageEventTargets.messageId,
          userId: messageEventTargets.userId,
          employeeId: messageEventTargets.employeeId,
          name: sql<string | null>`coalesce(${users.name}, ${employees.name})`,
        })
        .from(messageEventTargets)
        .leftJoin(users, eq(users.id, messageEventTargets.userId))
        .leftJoin(employees, eq(employees.id, messageEventTargets.employeeId))
        .where(inArray(messageEventTargets.messageId, messageIds))
        .orderBy(asc(messageEventTargets.messageId), asc(sql`coalesce(${users.name}, ${employees.name})`), asc(messageEventTargets.id));
    },

    // A reply. Null when the user is not a participant. The conversation
    // row is locked first; the message's timestamp is strictly after the
    // previous row and becomes last_message_at in the same transaction.
    async addMessage(userId: string, conversationId: string, body: string): Promise<string | null> {
      return db.transaction(async (tx) => {
        if (!(await lockConversation(tx, conversationId))) return null;
        if (!(await userParticipant(tx, conversationId, userId))) return null;
        return appendRow(tx, conversationId, { kind: "message", senderId: userId, body });
      });
    },

    // The employee's reply from the terminal, in a conversation the employee
    // takes part in (null otherwise). The reply also reads: up to the newest
    // of the messages the employee had on screen (`seenMessageIds`, of this
    // conversation) — or, without them, up to the reply itself. An
    // anonymized employee is refused by the database (NV002).
    async addEmployeeMessage(employeeId: string, conversationId: string, body: string, seenMessageIds?: string[]): Promise<string | null> {
      return db.transaction(async (tx) => {
        if (!(await lockConversation(tx, conversationId))) return null;
        const [participant] = await tx
          .select({ id: conversationParticipants.id })
          .from(conversationParticipants)
          .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.employeeId, employeeId)));
        if (!participant) return null;
        const id = await appendRow(tx, conversationId, { kind: "message", senderEmployeeId: employeeId, body });
        const upTo = seenMessageIds
          ? sql`(select max(created_at) from messages where conversation_id = ${conversationId} and ${inArray(messages.id, seenMessageIds)})`
          : sql`(select created_at from messages where id = ${id})`;
        await tx.execute(sql`
          update conversation_participants p
          set last_read_at = greatest(coalesce(p.last_read_at, '-infinity'::timestamptz), target.at)
          from (select ${upTo} as at) target
          where p.id = ${participant.id} and target.at is not null`);
        return id;
      });
    },

    // Lägg till deltagare. "not-participant" when the actor is not in the
    // conversation; { duplicate } names someone who already is.
    async addParticipants(
      actorId: string,
      conversationId: string,
      recipients: NewParticipant[]
    ): Promise<"ok" | "not-participant" | { duplicate: string }> {
      return db.transaction(async (tx) => {
        if (!(await lockConversation(tx, conversationId))) return "not-participant";
        if (!(await userParticipant(tx, conversationId, actorId))) return "not-participant";
        const existing = await tx
          .select({ userId: conversationParticipants.userId, employeeId: conversationParticipants.employeeId })
          .from(conversationParticipants)
          .where(eq(conversationParticipants.conversationId, conversationId));
        const taken = new Set(existing.map((row) => row.userId ?? row.employeeId));
        const duplicate = recipients.find((r) => taken.has(r.userId ?? r.employeeId ?? null));
        if (duplicate) return { duplicate: (duplicate.userId ?? duplicate.employeeId)! };
        // last_read_at stays null: the whole thread is unread for the new one.
        await tx.insert(conversationParticipants).values(
          recipients.map((r) => ({
            conversationId,
            userId: r.userId ?? null,
            employeeId: r.employeeId ?? null,
            kind: r.kind,
            boardUntil: r.boardUntil ?? null,
          }))
        );
        await appendEvent(tx, conversationId, actorId, "added", recipients);
        return "ok";
      });
    },

    // Ta bort en deltagare — the creator's, never the creator's own row.
    async removeParticipant(
      actorId: string,
      conversationId: string,
      participantId: string
    ): Promise<"ok" | "not-participant" | "not-owner" | "no-participant" | "creator"> {
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(tx, conversationId);
        if (!conversation || !(await userParticipant(tx, conversationId, actorId))) return "not-participant";
        if (conversation.createdBy !== actorId) return "not-owner";
        const [target] = await tx
          .delete(conversationParticipants)
          .where(
            and(
              eq(conversationParticipants.id, participantId),
              eq(conversationParticipants.conversationId, conversationId),
              sql`${conversationParticipants.userId} is distinct from ${actorId}`
            )
          )
          .returning({ userId: conversationParticipants.userId, employeeId: conversationParticipants.employeeId });
        if (!target) {
          const [own] = await tx
            .select({ id: conversationParticipants.id })
            .from(conversationParticipants)
            .where(and(eq(conversationParticipants.id, participantId), eq(conversationParticipants.conversationId, conversationId)));
          return own ? "creator" : "no-participant";
        }
        await appendEvent(tx, conversationId, actorId, "removed", [target]);
        return "ok";
      });
    },

    // Lämna konversationen — anyone but the creator.
    async leave(actorId: string, conversationId: string): Promise<"ok" | "not-participant" | "creator"> {
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(tx, conversationId);
        if (!conversation) return "not-participant";
        const participant = await userParticipant(tx, conversationId, actorId);
        if (!participant) return "not-participant";
        if (conversation.createdBy === actorId) return "creator";
        await tx.delete(conversationParticipants).where(eq(conversationParticipants.id, participant.id));
        await appendEvent(tx, conversationId, actorId, "left", []);
        return "ok";
      });
    },

    // Radera: the text leaves the database, the row stays. Only the user's
    // own message — never a händelserad, never an employee's reply.
    async deleteMessage(
      userId: string,
      conversationId: string,
      messageId: string
    ): Promise<"ok" | "not-participant" | "no-message" | "not-own"> {
      return db.transaction(async (tx) => {
        if (!(await lockConversation(tx, conversationId))) return "not-participant";
        if (!(await userParticipant(tx, conversationId, userId))) return "not-participant";
        const [row] = await tx
          .select({ kind: messages.kind, senderId: messages.senderId })
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)));
        if (!row) return "no-message";
        if (row.kind !== "message" || row.senderId !== userId) return "not-own";
        await tx
          .update(messages)
          .set({ body: null, deletedAt: sql`now()` })
          .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)));
        return "ok";
      });
    },

    // Read up to a message of the conversation (default: its newest).
    // "not-participant" | "no-message" | "ok". last_read_at never moves back.
    async markRead(userId: string, conversationId: string, messageId?: string): Promise<"ok" | "not-participant" | "no-message"> {
      const upTo = messageId
        ? sql`(select created_at from messages where id = ${messageId} and conversation_id = ${conversationId})`
        : sql`(select last_message_at from conversations where id = ${conversationId})`;
      const [row] = (await db.execute(sql`
        with target as (select ${upTo} as at),
        updated as (
          update conversation_participants p
          set last_read_at = greatest(coalesce(p.last_read_at, '-infinity'::timestamptz), target.at)
          from target
          where p.conversation_id = ${conversationId} and p.user_id = ${userId} and target.at is not null
          returning p.id
        )
        select
          exists (select 1 from conversation_participants where conversation_id = ${conversationId} and user_id = ${userId}) as participant,
          (select count(*)::int from updated) as updated`)) as unknown as { participant: boolean; updated: number }[];
      if (!row!.participant) return "not-participant";
      return row!.updated > 0 ? "ok" : "no-message";
    },

    // Arkivera: hidden until a newer message arrives — and read. Both are
    // set to the conversation's committed last_message_at.
    async setArchived(userId: string, conversationId: string, archived: boolean): Promise<boolean> {
      const rows = await db
        .update(conversationParticipants)
        .set(
          archived
            ? {
                archivedAt: sql`(select last_message_at from conversations where id = ${conversationId})`,
                lastReadAt: sql`greatest(coalesce(${conversationParticipants.lastReadAt}, '-infinity'::timestamptz), (select last_message_at from conversations where id = ${conversationId}))`,
              }
            : { archivedAt: null }
        )
        .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, userId)))
        .returning({ id: conversationParticipants.id });
      return rows.length > 0;
    },

    // Ta bort från terminalen: every terminal row of the conversation.
    async removeFromBoard(conversationId: string): Promise<number> {
      const rows = await db
        .update(conversationParticipants)
        .set({ boardUntil: null })
        .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.kind, "terminal")))
        .returning({ id: conversationParticipants.id });
      return rows.length;
    },

    // Anslagstavlan of one terminal account: the conversations addressed to
    // it whose slutdatum has not passed, newest message first.
    async listBoard(userId: string, today: string) {
      return db
        .select({
          id: conversations.id,
          subject: conversations.subject,
          createdBy: conversations.createdBy,
          lastMessageAt: conversations.lastMessageAt,
          boardUntil: me.boardUntil,
        })
        .from(conversations)
        .innerJoin(me, eq(me.conversationId, conversations.id))
        .where(and(eq(me.userId, userId), eq(me.kind, "terminal"), gte(me.boardUntil, today)))
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id));
    },

    // What the employee has not acknowledged: every undeleted message after the
    // participant row's last_read_at, oldest first per conversation.
    async listEmployeeUnread(employeeId: string) {
      return db
        .select({
          id: messages.id,
          conversationId: conversations.id,
          subject: conversations.subject,
          senderName: messageColumns.senderName,
          body: sql<string>`${messages.body}`,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(
          conversationParticipants,
          and(eq(conversationParticipants.conversationId, messages.conversationId), eq(conversationParticipants.employeeId, employeeId))
        )
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .leftJoin(senders, eq(senders.id, messages.senderId))
        .leftJoin(senderEmployees, eq(senderEmployees.id, messages.senderEmployeeId))
        .where(
          and(
            visibleMessageSql,
            // Never the employee's own reply from the terminal.
            sql`${messages.senderEmployeeId} is distinct from ${employeeId}`,
            sql`(${conversationParticipants.lastReadAt} is null or ${messages.createdAt} > ${conversationParticipants.lastReadAt})`
          )
        )
        .orderBy(asc(conversations.lastMessageAt), asc(conversations.id), asc(messages.createdAt), asc(messages.id));
    },

    // OK, läst: per conversation, read up to the newest of the given
    // messages. Messages of conversations the employee is not in are
    // ignored. Returns how many conversations were acknowledged.
    async acknowledgeEmployee(employeeId: string, messageIds: string[]): Promise<number> {
      const seen = db
        .select({ conversationId: messages.conversationId, at: sql<Date>`max(${messages.createdAt})`.as("at") })
        .from(messages)
        .where(inArray(messages.id, messageIds))
        .groupBy(messages.conversationId)
        .as("seen");
      const rows = await db
        .update(conversationParticipants)
        .set({ lastReadAt: sql`greatest(coalesce(${conversationParticipants.lastReadAt}, '-infinity'::timestamptz), ${seen.at})` })
        .from(seen)
        .where(and(eq(conversationParticipants.conversationId, seen.conversationId), eq(conversationParticipants.employeeId, employeeId)))
        .returning({ id: conversationParticipants.id });
      return rows.length;
    },
  };
}

export type MessagesRepository = ReturnType<typeof createMessagesRepository>;
