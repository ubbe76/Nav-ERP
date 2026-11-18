import {
  BOARD_DEFAULT_DAYS,
  BOARD_MAX_DAYS,
  effectivePermissions,
  messagePreview,
  satisfiesRule,
  type AcknowledgeEmployeeMessagesInput,
  type AddParticipantsInput,
  type CreateConversationInput,
  type EmployeeReplyInput,
  type ListConversationsQuery,
  type Paged,
  type ParticipantKind,
  type Permission,
  type UserRole,
} from "@navet/shared";
import { addDays, stockholmToday } from "../../system/service/delivery-days.js";
import { isEmployeeAnonymizedViolation, isForeignKeyViolation } from "../../system/service/db-errors.js";
import type { EventTargetRow, MessageRow, MessagesRepository, NewParticipant, ParticipantRow } from "../repository/messages.repository.js";

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

// Ta bort från terminalen and Ta bort (a participant) are the creator's
// (the one who started the conversation). 403 conversation-not-owner.
export class ConversationNotOwnerError extends Error {
  constructor(id: string) {
    super(`Only the one who started conversation ${id} can do that`);
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

// Lägg till deltagare named someone who already takes part. 409
// participant-already-added.
export class ParticipantAlreadyAddedError extends Error {
  constructor(readonly recipientId: string) {
    super(`${recipientId} already takes part in the conversation`);
    this.name = "ParticipantAlreadyAddedError";
  }
}

// Ta bort named a participant row that is not in the conversation. 404
// participant-not-found.
export class ParticipantNotFoundError extends Error {
  constructor(id: string) {
    super(`Participant ${id} not found in the conversation`);
    this.name = "ParticipantNotFoundError";
  }
}

// The creator can neither leave nor be removed — nobody else could then
// remove participants. Arkivera instead. 409
// conversation-creator-cannot-leave.
export class ConversationCreatorCannotLeaveError extends Error {
  constructor(id: string) {
    super(`The one who started conversation ${id} can not leave it`);
    this.name = "ConversationCreatorCannotLeaveError";
  }
}

// Radera is for one's own messages — not someone else's, not an employee's
// reply and not a händelserad. 403 message-not-own.
export class MessageNotOwnError extends Error {
  constructor(id: string) {
    super(`Message ${id} is not yours to delete`);
    this.name = "MessageNotOwnError";
  }
}

export interface MessageUser {
  id: string;
  role: UserRole;
  permissions?: readonly Permission[];
}

export interface ParticipantView {
  // The participant row (Ta bort names it).
  participantId: string;
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

// A sender who has been erased from the personnel register since.
export const ERASED_SENDER_NAME = "Borttagen anställd";

function toParticipant(row: ParticipantRow, today: string): ParticipantView {
  const employee = row.kind === "employee";
  const terminal = row.kind === "terminal";
  return {
    participantId: row.id,
    kind: row.kind,
    id: (row.userId ?? row.employeeId)!,
    name: row.name,
    employeeNumber: row.employeeNumber,
    lastReadAt: employee ? row.lastReadAt : null,
    read: employee ? row.lastReadAt !== null && !row.hasUnread : null,
    boardUntil: terminal ? row.boardUntil : null,
    onBoard: terminal ? row.boardUntil !== null && row.boardUntil >= today : null,
  };
}

// A thread row as the office sees it. A deleted message keeps its sender and
// time ("Meddelandet togs bort"); a händelserad carries who it is about,
// named now — `name: null` = erased since.
function toMessage(row: MessageRow, targets: EventTargetRow[]) {
  return {
    id: row.id,
    kind: row.kind,
    senderId: row.senderId,
    senderEmployeeId: row.senderEmployeeId,
    senderName: row.senderName ?? ERASED_SENDER_NAME,
    // Written by an employee at the stämpelterminal.
    viaTerminal: row.kind === "message" && row.senderId === null,
    body: row.body,
    deleted: row.deletedAt !== null,
    createdAt: row.createdAt,
    event:
      row.kind === "event" && row.eventType
        ? {
            type: row.eventType,
            targets: targets.map((t) => ({ kind: t.userId ? ("user" as const) : t.employeeId ? ("employee" as const) : null, name: t.name })),
          }
        : null,
  };
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

  // The recipients of a new conversation or Lägg till deltagare: the same
  // selection, and a terminal among them gets the slutdatum.
  async function resolveRecipients(
    user: MessageUser,
    input: { recipientUserIds: string[]; recipientEmployeeIds: string[]; boardUntil?: string }
  ): Promise<NewParticipant[]> {
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
    return recipients;
  }

  // An employee removed or anonymized between the check and the write.
  function asRecipientError(err: unknown, input: { recipientUserIds: string[]; recipientEmployeeIds: string[] }): unknown {
    if (isForeignKeyViolation(err) || isEmployeeAnonymizedViolation(err)) {
      return new RecipientNotAvailableError(input.recipientEmployeeIds[0] ?? input.recipientUserIds[0] ?? "");
    }
    return err;
  }

  async function detail(user: MessageUser, id: string) {
    const conversation = await repo.findForUser(user.id, id);
    if (!conversation) throw new ConversationNotFoundError(id);
    const [participants, thread, unread] = await Promise.all([
      repo.participantsOf([id]),
      repo.messagesOf([id]),
      repo.unreadCounts(user.id, [id]),
    ]);
    const targets = groupBy(await repo.eventTargetsOf(thread.filter((m) => m.kind === "event").map((m) => m.id)), (t) => t.messageId);
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
      participants: participants.map((p) => toParticipant(p, today)),
      messages: thread.map((m) => toMessage(m, targets.get(m.id) ?? [])),
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
            participants: (byConversation.get(row.id) ?? []).map((p) => toParticipant(p, today)),
            lastMessage: newest
              ? {
                  senderId: newest.senderId,
                  senderName: newest.senderName ?? ERASED_SENDER_NAME,
                  // A deleted message has no text left: the web writes "Meddelandet togs bort".
                  preview: newest.body === null ? "" : messagePreview(newest.body),
                  deleted: newest.deletedAt !== null,
                  createdAt: newest.createdAt,
                }
              : null,
          };
        }),
      };
    },

    getConversation: detail,

    async createConversation(user: MessageUser, input: CreateConversationInput) {
      const recipients = await resolveRecipients(user, input);
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
        throw asRecipientError(err, input);
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

    // Lägg till deltagare — any participant. The new ones see the whole
    // thread, all of it unread; a händelserad says who added whom.
    async addParticipants(user: MessageUser, conversationId: string, input: AddParticipantsInput) {
      // Not a participant ⇒ 404 before anything is said about the recipients.
      if (!(await repo.findForUser(user.id, conversationId))) throw new ConversationNotFoundError(conversationId);
      const recipients = await resolveRecipients(user, input);
      let result: Awaited<ReturnType<MessagesRepository["addParticipants"]>>;
      try {
        result = await repo.addParticipants(user.id, conversationId, recipients);
      } catch (err) {
        throw asRecipientError(err, input);
      }
      if (result === "not-participant") throw new ConversationNotFoundError(conversationId);
      if (result !== "ok") throw new ParticipantAlreadyAddedError(result.duplicate);
      return detail(user, conversationId);
    },

    // Ta bort — the creator only, and never the creator's own row.
    async removeParticipant(user: MessageUser, conversationId: string, participantId: string) {
      const result = await repo.removeParticipant(user.id, conversationId, participantId);
      if (result === "not-participant") throw new ConversationNotFoundError(conversationId);
      if (result === "not-owner") throw new ConversationNotOwnerError(conversationId);
      if (result === "no-participant") throw new ParticipantNotFoundError(participantId);
      if (result === "creator") throw new ConversationCreatorCannotLeaveError(conversationId);
      return detail(user, conversationId);
    },

    // Lämna konversationen. Answers the unread summary (the envelope).
    async leave(user: MessageUser, conversationId: string) {
      const result = await repo.leave(user.id, conversationId);
      if (result === "not-participant") throw new ConversationNotFoundError(conversationId);
      if (result === "creator") throw new ConversationCreatorCannotLeaveError(conversationId);
      return unread(user);
    },

    // Radera — one's own message. Deleting it again changes nothing.
    async deleteMessage(user: MessageUser, conversationId: string, messageId: string) {
      const result = await repo.deleteMessage(user.id, conversationId, messageId);
      if (result === "not-participant") throw new ConversationNotFoundError(conversationId);
      if (result === "no-message") throw new MessageNotFoundError(messageId);
      if (result === "not-own") throw new MessageNotOwnError(messageId);
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
      const thread = groupBy(await repo.messagesOf(rows.map((row) => row.id), { limit: BOARD_MESSAGES }), (m) => m.conversationId);
      return rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        boardUntil: row.boardUntil!,
        messages: (thread.get(row.id) ?? []).map((m) => ({
          id: m.id,
          senderName: m.senderName ?? ERASED_SENDER_NAME,
          body: m.body ?? "",
          createdAt: m.createdAt,
        })),
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
        group.messages.push({ id: row.id, senderName: row.senderName ?? ERASED_SENDER_NAME, body: row.body, createdAt: row.createdAt });
      }
      return out;
    },

    // Svara från terminalen: the employee's own reply, in a conversation the
    // employee takes part in — 404 otherwise, as for the office. An
    // anonymized employee is refused by the database (NV002 → 409
    // employee-anonymized in the global handler).
    async employeeReply(employeeId: string, conversationId: string, input: EmployeeReplyInput) {
      const id = await repo.addEmployeeMessage(employeeId, conversationId, input.body, input.messageIds);
      if (!id) throw new ConversationNotFoundError(conversationId);
      return { id };
    },

    // OK, läst.
    async acknowledgeEmployee(employeeId: string, input: AcknowledgeEmployeeMessagesInput) {
      return { acknowledged: await repo.acknowledgeEmployee(employeeId, input.messageIds) };
    },
  };
}

export type MessagesService = ReturnType<typeof createMessagesService>;
