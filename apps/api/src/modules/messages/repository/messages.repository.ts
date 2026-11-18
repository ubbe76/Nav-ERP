import { and, asc, desc, eq, exists, gte, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { conversationParticipants, conversations, employees, messages, permissionGroups, users, type Db } from "@navet/db";
import { ilikePattern, type ParticipantKind, type UserRole } from "@navet/shared";

// Meddelanden (migration 0231). Invariants this file owns:
//
// - Olästa is derived: a message from someone else with created_at after the
//   participant's last_read_at. last_read_at and archived_at are only ever
//   set to a MESSAGE's timestamp, in SQL (never now(), never through a JS
//   Date) — so a message committing at the same moment can not end up
//   "read" unseen.
// - A message is inserted under the conversation's row lock (FOR UPDATE)
//   with a timestamp strictly after the conversation's last_message_at, and
//   last_message_at is written in the same transaction: the messages of one
//   conversation are strictly ordered by commit.
// - Lock order: the conversation row first, then participants/messages.
// - Arkiverad = archived_at >= last_message_at: a newer message shows the
//   conversation again without any write to the participant rows.

const me = alias(conversationParticipants, "me");
const senders = alias(users, "message_senders");

// Millisecond precision: the timestamps are compared with each other in SQL
// and also travel through JS Dates, which hold no more.
const nowMs = sql`date_trunc('milliseconds', clock_timestamp())`;

const archivedSql = sql<boolean>`(${me.archivedAt} is not null and ${me.archivedAt} >= ${conversations.lastMessageAt})`;

export interface ParticipantRow {
  conversationId: string;
  kind: ParticipantKind;
  userId: string | null;
  employeeId: string | null;
  name: string;
  employeeNumber: string | null;
  lastReadAt: Date | null;
  boardUntil: string | null;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: Date;
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
        conversationId: conversationParticipants.conversationId,
        kind: conversationParticipants.kind,
        userId: conversationParticipants.userId,
        employeeId: conversationParticipants.employeeId,
        userName: users.name,
        employeeName: employees.name,
        employeeNumber: employees.employeeNumber,
        lastReadAt: conversationParticipants.lastReadAt,
        boardUntil: conversationParticipants.boardUntil,
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
      conversationId: row.conversationId,
      kind: row.kind as ParticipantKind,
      userId: row.userId,
      employeeId: row.employeeId,
      name: row.userName ?? row.employeeName ?? "",
      employeeNumber: row.employeeNumber,
      lastReadAt: row.lastReadAt,
      boardUntil: row.boardUntil,
    }));
  }

  const messageColumns = {
    id: messages.id,
    conversationId: messages.conversationId,
    senderId: messages.senderId,
    senderName: senders.name,
    body: messages.body,
    createdAt: messages.createdAt,
  };

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
          })
          .returning({ id: conversations.id });
        const id = conversation!.id;
        // One statement, so both timestamps are the same instant.
        await tx.execute(sql`
          with stamp as (
            update conversations set last_message_at = created_at where id = ${id} returning created_at
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

    // The newest message of each conversation.
    async lastMessages(conversationIds: string[]): Promise<MessageRow[]> {
      if (conversationIds.length === 0) return [];
      return db
        .selectDistinctOn([messages.conversationId], messageColumns)
        .from(messages)
        .innerJoin(senders, eq(senders.id, messages.senderId))
        .where(inArray(messages.conversationId, conversationIds))
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
        .where(
          and(
            ne(messages.senderId, userId),
            sql`(${me.lastReadAt} is null or ${messages.createdAt} > ${me.lastReadAt})`,
            conversationIds ? inArray(messages.conversationId, conversationIds) : undefined
          )
        )
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
          senderName: senders.name,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(me, and(eq(me.conversationId, messages.conversationId), eq(me.userId, userId)))
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(senders, eq(senders.id, messages.senderId))
        .where(and(ne(messages.senderId, userId), sql`(${me.lastReadAt} is null or ${messages.createdAt} > ${me.lastReadAt})`))
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

    async messagesOf(conversationIds: string[], limitPerConversation?: number): Promise<MessageRow[]> {
      if (conversationIds.length === 0) return [];
      const rows = await db
        .select({
          ...messageColumns,
          rank: sql<number>`row_number() over (partition by ${messages.conversationId} order by ${messages.createdAt} desc, ${messages.id} desc)::int`,
        })
        .from(messages)
        .innerJoin(senders, eq(senders.id, messages.senderId))
        .where(inArray(messages.conversationId, conversationIds))
        .orderBy(asc(messages.conversationId), asc(messages.createdAt), asc(messages.id));
      return rows.filter((row) => limitPerConversation === undefined || row.rank <= limitPerConversation).map(({ rank: _rank, ...row }) => row);
    },

    // A reply. Null when the user is not a participant. The conversation
    // row is locked first; the message's timestamp is strictly after the
    // previous one and becomes last_message_at in the same transaction.
    async addMessage(userId: string, conversationId: string, body: string): Promise<string | null> {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .for("update");
        if (!locked) return null;
        const [participant] = await tx
          .select({ id: conversationParticipants.id })
          .from(conversationParticipants)
          .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, userId)));
        if (!participant) return null;
        const [message] = await tx
          .insert(messages)
          .values({
            conversationId,
            senderId: userId,
            body,
            createdAt: sql`(select greatest(${nowMs}, last_message_at + interval '1 millisecond') from conversations where id = ${conversationId})`,
          })
          .returning({ id: messages.id });
        await tx
          .update(conversations)
          .set({ lastMessageAt: sql`(select created_at from messages where id = ${message!.id})` })
          .where(eq(conversations.id, conversationId));
        return message!.id;
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

    // What the employee has not acknowledged: every message after the
    // participant row's last_read_at, oldest first per conversation.
    async listEmployeeUnread(employeeId: string) {
      return db
        .select({
          id: messages.id,
          conversationId: conversations.id,
          subject: conversations.subject,
          senderName: senders.name,
          body: messages.body,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(
          conversationParticipants,
          and(eq(conversationParticipants.conversationId, messages.conversationId), eq(conversationParticipants.employeeId, employeeId))
        )
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(senders, eq(senders.id, messages.senderId))
        .where(sql`(${conversationParticipants.lastReadAt} is null or ${messages.createdAt} > ${conversationParticipants.lastReadAt})`)
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
