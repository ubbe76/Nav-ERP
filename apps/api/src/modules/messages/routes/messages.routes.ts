import type { FastifyInstance, FastifyReply } from "fastify";
import {
  acknowledgeEmployeeMessagesSchema,
  addParticipantsSchema,
  createConversationSchema,
  createMessageSchema,
  employeeReplySchema,
  listConversationsQuerySchema,
  markConversationReadSchema,
} from "@navet/shared";
import { EMPLOYEE_MESSAGES, TERMINAL_READ } from "../../auth/middleware/access-rules.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  BoardDateOutOfRangeError,
  ConversationCreatorCannotLeaveError,
  ConversationNotFoundError,
  ConversationNotOwnerError,
  MessageNotFoundError,
  MessageNotOwnError,
  ParticipantAlreadyAddedError,
  ParticipantNotFoundError,
  RecipientNotAvailableError,
  type MessagesService,
} from "../service/messages.service.js";

// Meddelanden. The module is registered { read: office, write: office }: any
// user with a menu reads and writes their own conversations. What a user
// sees is decided per conversation (participants only — 404 otherwise, never
// 403, so an id tells nothing).
//
// The writes are readOnlySafe ON PURPOSE: a read-only account's messages
// are the account's own communication, not business data (the same
// reasoning as PATCH /me/settings; read-only-account.test.ts pins the list).
//
// The terminal's four routes follow the stamp terminal's rules instead and
// its trust model: whoever stands at the terminal gives the
// anställningsnummer. The board is TERMINAL_READ (it only ever answers the
// caller's own account); an employee's messages need the terminal
// permission itself (EMPLOYEE_MESSAGES) — also the read, which is personal
// and not an office read. The acknowledgement and the employee's reply are
// NOT readOnlySafe — like stamping, they are refused for a read-only account.
export async function messagesRoutes(app: FastifyInstance, opts: { service: MessagesService }) {
  const { service } = opts;
  type IdParams = { Params: { id: string } };
  const ownWrite = { config: { readOnlySafe: true } } as const;

  function messagesError(err: unknown, reply: FastifyReply) {
    if (err instanceof ConversationNotFoundError || err instanceof MessageNotFoundError || err instanceof ParticipantNotFoundError) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof ParticipantAlreadyAddedError) return reply.code(409).send({ ...errorBody(err), recipientId: err.recipientId });
    if (err instanceof ConversationCreatorCannotLeaveError) return reply.code(409).send(errorBody(err));
    if (err instanceof MessageNotOwnError) return reply.code(403).send(errorBody(err));
    if (err instanceof RecipientNotAvailableError) return reply.code(400).send({ ...errorBody(err), recipientId: err.recipientId });
    if (err instanceof BoardDateOutOfRangeError) return reply.code(400).send({ ...errorBody(err), min: err.min, max: err.max });
    if (err instanceof ConversationNotOwnerError) return reply.code(403).send(errorBody(err));
    throw err;
  }

  app.get("/conversations", async (req) => service.listConversations(req.user!, listConversationsQuerySchema.parse(req.query)));

  app.post("/conversations", ownWrite, async (req, reply) => {
    const input = createConversationSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createConversation(req.user!, input));
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  app.get<IdParams>("/conversations/:id", async (req, reply) => {
    try {
      return await service.getConversation(req.user!, req.params.id);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  app.post<IdParams>("/conversations/:id/messages", ownWrite, async (req, reply) => {
    const input = createMessageSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.addMessage(req.user!, req.params.id, input.body));
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  // Answers the new unread summary, so the envelope follows at once.
  app.post<IdParams>("/conversations/:id/read", ownWrite, async (req, reply) => {
    const input = markConversationReadSchema.parse(req.body ?? {});
    try {
      return await service.markRead(req.user!, req.params.id, input.messageId);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  app.post<IdParams>("/conversations/:id/archive", ownWrite, async (req, reply) => {
    try {
      return await service.setArchived(req.user!, req.params.id, true);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  app.post<IdParams>("/conversations/:id/unarchive", ownWrite, async (req, reply) => {
    try {
      return await service.setArchived(req.user!, req.params.id, false);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  // Ta bort från terminalen — the sender only.
  app.post<IdParams>("/conversations/:id/remove-from-board", ownWrite, async (req, reply) => {
    try {
      return await service.removeFromBoard(req.user!, req.params.id);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  // Lägg till deltagare — any participant.
  app.post<IdParams>("/conversations/:id/participants", ownWrite, async (req, reply) => {
    const input = addParticipantsSchema.parse(req.body);
    try {
      return await service.addParticipants(req.user!, req.params.id, input);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  // Ta bort — the one who started the conversation only.
  app.delete<{ Params: { id: string; participantId: string } }>("/conversations/:id/participants/:participantId", ownWrite, async (req, reply) => {
    try {
      return await service.removeParticipant(req.user!, req.params.id, req.params.participantId);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  // Lämna konversationen — everyone but the one who started it.
  app.post<IdParams>("/conversations/:id/leave", ownWrite, async (req, reply) => {
    try {
      return await service.leave(req.user!, req.params.id);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  // Radera — one's own message.
  app.delete<{ Params: { id: string; messageId: string } }>("/conversations/:id/messages/:messageId", ownWrite, async (req, reply) => {
    try {
      return await service.deleteMessage(req.user!, req.params.id, req.params.messageId);
    } catch (err) {
      return messagesError(err, reply);
    }
  });

  app.get("/messages/unread", async (req) => service.unread(req.user!));

  app.get("/messages/recipients", async (req) => service.recipients(req.user!));

  // Stämpelterminalen: the anslagstavla of the logged-in terminal account.
  app.get("/messages/terminal-board", { config: { access: TERMINAL_READ } }, async (req) => service.terminalBoard(req.user!));

  // … what an employee has not acknowledged (after the anställningsnummer) …
  app.get<{ Params: { employeeId: string } }>(
    "/messages/employees/:employeeId/unread",
    { config: { access: EMPLOYEE_MESSAGES } },
    async (req) => service.employeeUnread(req.params.employeeId)
  );

  // … the employee's reply in one of their own conversations …
  app.post<{ Params: { employeeId: string; conversationId: string } }>(
    "/messages/employees/:employeeId/conversations/:conversationId/messages",
    { config: { access: EMPLOYEE_MESSAGES } },
    async (req, reply) => {
      const input = employeeReplySchema.parse(req.body);
      try {
        return reply.code(201).send(await service.employeeReply(req.params.employeeId, req.params.conversationId, input));
      } catch (err) {
        return messagesError(err, reply);
      }
    }
  );

  // … and OK, läst.
  app.post<{ Params: { employeeId: string } }>(
    "/messages/employees/:employeeId/read",
    { config: { access: EMPLOYEE_MESSAGES } },
    async (req) => service.acknowledgeEmployee(req.params.employeeId, acknowledgeEmployeeMessagesSchema.parse(req.body))
  );
}
