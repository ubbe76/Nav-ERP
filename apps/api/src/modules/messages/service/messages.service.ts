import {
  BOARD_DEFAULT_DAYS,
  BOARD_MAX_DAYS,
  effectivePermissions,
  messagePreview,
  satisfiesRule,
  type AcknowledgeEmployeeMessagesInput,
  type CreateConversationInput,
  type ListConversationsQuery,
  type Paged,
  type ParticipantKind,
  type Permission,
  type UserRole,
} from "@navet/shared";
import { addDays, stockholmToday } from "../../system/service/delivery-days.js";
import { isEmployeeAnonymizedViolation, isForeignKeyViolation } from "../../system/service/db-errors.js";
import type { MessageRow, MessagesRepository, NewParticipant, ParticipantRow } from "../repository/messages.repository.js";

// Meddelanden: conversations between users, with terminal accounts
// (anslagstavlan) and employees (shown after the anställningsnummer) as
// possible recipients. Rules in .claude/rules/messages.md.

// Not a participant, or no such conversation — the same 404 for both, so an
// id never tells whether a conversation exists.
export class ConversationNotFoundError extends Error {
  constructor(id: string) {
    super(`Conversation ${id} not found`);
    this.name = "ConversationNotFoundError";
  }
}

// A recipient that can not be chosen (inactive, removed, a plugin account,
// without access to Meddelanden or the terminal, the sender, an inactive or
// anonymized employee). 400 recipient-not-available.
export class RecipientNotAvailableError extends Error {
  constructor(readonly recipientId: string) {
    super(`Recipient ${recipientId} can not receive messages`);
    this.name = "RecipientNotAvailableError";
  }
}

// The terminal's slutdatum must be today … today + BOARD_MAX_DAYS
// (Stockholm days). 400 board-date-out-of-range.
export class BoardDateOutOfRangeError extends Error {
  constructor(
    readonly min: string,
    readonly max: string
  ) {
    super(`The terminal date must be between ${min} and ${max}`);
    this.name = "BoardDateOutOfRangeError";
  }
}

// Ta bort från terminalen is the sender's (the one who created the
// conversation). 403 conversation-not-owner.
export class ConversationNotOwnerError extends Error {
  constructor(id: string) {
    super(`Only the sender can remove conversation ${id} from the terminal`);
    this.name = "ConversationNotOwnerError";
  }
}

// POST …/read named a message that is not in the conversation. 404
// message-not-found.
export class MessageNotFoundError extends Error {
  constructor(id: string) {
    super(`Message ${id} not found in the conversation`);
    this.name = "MessageNotFoundError";
  }
}

export interface MessageUser {
  id: string;
  role: UserRole;
  permissions?: readonly Permission[];
}

export interface ParticipantView {
  kind: ParticipantKind;
  // The user's or the employee's id.
  id: string;
  name: string;
  employeeNumber: string | null;
  // Employees: when OK, läst was pressed (null = never) and whether
  // everything written since is acknowledged. Null for the other kinds —
  // a user's reading is their own business.
  lastReadAt: Date | null;
  read: boolean | null;
  // Terminals: shown through this day; null = removed from the terminal.
  boardUntil: string | null;
  // Terminals: still on the board today.
  onBoard: boolean | null;
}

// How many of a conversation's newest messages the anslagstavla shows.
export const BOARD_MESSAGES = 10;

// Which kind of recipient an account is: an office user reads the inbox, an
// account with the terminal permission but no menu is a terminal (the pure
// workshop profile); anything else can not read messages at all.
export function recipientKindOf(user: { role: UserRole; groupPermissions: readonly string[] | null }): "user" | "terminal" | null {
  const profile = { role: user.role, permissions: effectivePermissions(user.role, user.groupPermissions) };
  if (satisfiesRule(profile, ["office"])) return "user";
  if (satisfiesRule(profile, ["terminal"])) return "terminal";
  return null;
}

function toParticipant(row: ParticipantRow, lastMessageAt: Date, today: string): ParticipantView {
  const employee = row.kind === "employee";
  const terminal = row.kind === "terminal";
  return {
    kind: row.kind,
    id: (row.userId ?? row.employeeId)!,
    name: row.name,
    employeeNumber: row.employeeNumber,
    lastReadAt: employee ? row.lastReadAt : null,
    read: employee ? row.lastReadAt !== null && row.lastReadAt.getTime() >= lastMessageAt.getTime() : null,
    boardUntil: terminal ? row.boardUntil : null,
    onBoard: terminal ? row.boardUntil !== null && row.boardUntil >= today : null,
  };
}

function toMessage(row: MessageRow) {
  return { id: row.id, senderId: row.senderId, senderName: row.senderName, body: row.body, createdAt: row.createdAt };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(key(row));
    if (list) list.push(row);
    else out.set(key(row), [row]);
  }
  return out;
}

export function createMessagesService(repo: MessagesRepository) {
  async function candidates(user: MessageUser) {
    const [accounts, staff] = await Promise.all([repo.listUserCandidates(), repo.listEmployeeCandidates()]);
    const users: { id: string; name: string }[] = [];
    const terminals: { id: string; name: string }[] = [];
    for (const account of accounts) {
      if (account.id === user.id) continue;
      const kind = recipientKindOf(account);
      if (kind === "user") users.push({ id: account.id, name: account.name });
      else if (kind === "terminal") terminals.push({ id: account.id, name: account.name });
    }
    return { users, terminals, employees: staff };
  }

  async function detail(user: MessageUser, id: string) {
    const conversation = await repo.findForUser(user.id, id);
    if (!conversation) throw new ConversationNotFoundError(id);
    const [participants, thread, unread] = await Promise.all([
      repo.participantsOf([id]),
      repo.messagesOf([id]),
      repo.unreadCounts(user.id, [id]),
    ]);
    const today = stockholmToday();
    return {
      id: conversation.id,
      subject: conversation.subject,
      link: conversation.linkHref ? { href: conversation.linkHref, title: conversation.linkTitle! } : null,
      createdBy: conversation.createdBy,
      createdAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt,
      archived: conversation.archived,
      unreadCount: unread.get(id) ?? 0,
      // Ta bort från terminalen: the sender's, while something is shown.
      canRemoveFromBoard: conversation.createdBy === user.id,
      participants: participants.map((p) => toParticipant(p, conversation.lastMessageAt, today)),
      messages: thread.map(toMessage),
    };
  }

  // Kuvertet: how many unread messages, and the newest one for the notice.
  async function unread(user: MessageUser) {
    const [counts, latest] = await Promise.all([repo.unreadCounts(user.id), repo.latestUnread(user.id)]);
    let count = 0;
    for (const n of counts.values()) count += n;
    return { count, conversations: counts.size, latest };
  }

  return {
    // Mottagarurvalet: Användare / Terminaler / Anställda — ids and names
    // only (and the anställningsnummer), never the sender.
    recipients: candidates,

    async listConversations(user: MessageUser, query: ListConversationsQuery): Promise<Paged<unknown>> {
      const page = await repo.listConversations(user.id, query);
      const ids = page.rows.map((row) => row.id);
      const [participants, last, unread] = await Promise.all([
        repo.participantsOf(ids),
        repo.lastMessages(ids),
        repo.unreadCounts(user.id, ids),
      ]);
      const byConversation = groupBy(participants, (p) => p.conversationId);
      const lastById = new Map(last.map((m) => [m.conversationId, m]));
      const today = stockholmToday();
      return {
        total: page.total,
        rows: page.rows.map((row) => {
          const newest = lastById.get(row.id);
          return {
            id: row.id,
            subject: row.subject,
            hasLink: row.linkHref !== null,
            createdAt: row.createdAt,
            lastMessageAt: row.lastMessageAt,
            archived: row.archived,
            unreadCount: unread.get(row.id) ?? 0,
            participants: (byConversation.get(row.id) ?? []).map((p) => toParticipant(p, row.lastMessageAt, today)),
            lastMessage: newest
              ? { senderId: newest.senderId, senderName: newest.senderName, preview: messagePreview(newest.body), createdAt: newest.createdAt }
              : null,
          };
        }),
      };
    },

    getConversation: detail,

    async createConversation(user: MessageUser, input: CreateConversationInput) {
      const available = await candidates(user);
      const officeIds = new Set(available.users.map((u) => u.id));
      const terminalIds = new Set(available.terminals.map((u) => u.id));
      const employeeIds = new Set(available.employees.map((e) => e.id));

      const recipients: NewParticipant[] = [];
      for (const id of input.recipientUserIds) {
        if (officeIds.has(id)) recipients.push({ kind: "user", userId: id });
        else if (terminalIds.has(id)) recipients.push({ kind: "terminal", userId: id });
        else throw new RecipientNotAvailableError(id);
      }
      for (const id of input.recipientEmployeeIds) {
        if (!employeeIds.has(id)) throw new RecipientNotAvailableError(id);
        recipients.push({ kind: "employee", employeeId: id });
      }

      // The slutdatum only exists for terminals; without one among the
      // recipients a sent date is ignored.
      if (recipients.some((r) => r.kind === "terminal")) {
        const today = stockholmToday();
        const max = addDays(today, BOARD_MAX_DAYS);
        const until = input.boardUntil ?? addDays(today, BOARD_DEFAULT_DAYS);
        if (until < today || until > max) throw new BoardDateOutOfRangeError(today, max);
        for (const r of recipients) if (r.kind === "terminal") r.boardUntil = until;
      }

      let id: string;
      try {
        id = await repo.createConversation({
          subject: input.subject,
          link: input.link ?? null,
          createdBy: user.id,
          body: input.body,
          recipients,
        });
      } catch (err) {
        // An employee removed or anonymized between the check and the write.
        if (isForeignKeyViolation(err) || isEmployeeAnonymizedViolation(err)) {
          throw new RecipientNotAvailableError(input.recipientEmployeeIds[0] ?? input.recipientUserIds[0] ?? "");
        }
        throw err;
      }
      return detail(user, id);
    },

    async addMessage(user: MessageUser, conversationId: string, body: string) {
      const messageId = await repo.addMessage(user.id, conversationId, body);
      if (!messageId) throw new ConversationNotFoundError(conversationId);
      // The writer has seen their own message — and what stood above it.
      await repo.markRead(user.id, conversationId, messageId);
      return detail(user, conversationId);
    },

    async markRead(user: MessageUser, conversationId: string, messageId?: string) {
      const result = await repo.markRead(user.id, conversationId, messageId);
      if (result === "not-participant") throw new ConversationNotFoundError(conversationId);
      if (result === "no-message") throw new MessageNotFoundError(messageId ?? conversationId);
      return unread(user);
    },

    async setArchived(user: MessageUser, conversationId: string, archived: boolean) {
      if (!(await repo.setArchived(user.id, conversationId, archived))) throw new ConversationNotFoundError(conversationId);
      return detail(user, conversationId);
    },

    async removeFromBoard(user: MessageUser, conversationId: string) {
      const conversation = await repo.findForUser(user.id, conversationId);
      if (!conversation) throw new ConversationNotFoundError(conversationId);
      if (conversation.createdBy !== user.id) throw new ConversationNotOwnerError(conversationId);
      await repo.removeFromBoard(conversationId);
      return detail(user, conversationId);
    },

    unread,

    // Terminalens anslagstavla for the logged-in terminal account.
    async terminalBoard(user: MessageUser) {
      const rows = await repo.listBoard(user.id, stockholmToday());
      const thread = groupBy(await repo.messagesOf(rows.map((row) => row.id), BOARD_MESSAGES), (m) => m.conversationId);
      return rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        boardUntil: row.boardUntil!,
        messages: (thread.get(row.id) ?? []).map((m) => ({ id: m.id, senderName: m.senderName, body: m.body, createdAt: m.createdAt })),
      }));
    },

    // Terminalen, after the anställningsnummer: what the employee has not
    // acknowledged, grouped per conversation.
    async employeeUnread(employeeId: string) {
      const rows = await repo.listEmployeeUnread(employeeId);
      const out: { conversationId: string; subject: string; messages: { id: string; senderName: string; body: string; createdAt: Date }[] }[] = [];
      for (const row of rows) {
        let group = out.find((g) => g.conversationId === row.conversationId);
        if (!group) {
          group = { conversationId: row.conversationId, subject: row.subject, messages: [] };
          out.push(group);
        }
        group.messages.push({ id: row.id, senderName: row.senderName, body: row.body, createdAt: row.createdAt });
      }
      return out;
    },

    // OK, läst.
    async acknowledgeEmployee(employeeId: string, input: AcknowledgeEmployeeMessagesInput) {
      return { acknowledged: await repo.acknowledgeEmployee(employeeId, input.messageIds) };
    },
  };
}

export type MessagesService = ReturnType<typeof createMessagesService>;
