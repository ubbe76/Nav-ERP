import { z } from "zod";
import { businessDateSchema } from "./business-date.js";
import { listQuerySchema } from "./list.js";
import { favoriteHrefSchema } from "./user-settings.js";

// Meddelanden: conversations between users inside Nav (messages module,
// migrations 0231 and 0232). Web mirror of the constants and pure helpers:
// apps/web/lib/messages.ts (web-messages.test.ts keeps them equal).
export const CONVERSATION_SUBJECT_MAX = 200;
export const MESSAGE_BODY_MAX = 5000;
export const CONVERSATION_LINK_TITLE_MAX = 200;
export const MAX_USER_RECIPIENTS = 100;
export const MAX_EMPLOYEE_RECIPIENTS = 500;

// Terminalens anslagstavla: a conversation sent to a terminal account shows
// on that terminal through this Stockholm day (inclusive). Default today + 7,
// at most today + 365.
export const BOARD_DEFAULT_DAYS = 7;
export const BOARD_MAX_DAYS = 365;

// A thread row is a message or a händelserad (someone added or removed
// participants, or left).
export const MESSAGE_KINDS = ["message", "event"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const MESSAGE_EVENT_TYPES = ["added", "removed", "left"] as const;
export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[number];

// How a participant was addressed when the conversation was created (or the
// participant added):
// user = an office user (inbox), terminal = a terminal account (anslagstavla),
// employee = someone in the personnel register (shown after the
// anställningsnummer at the terminal, acknowledged with OK, läst).
export const PARTICIPANT_KINDS = ["user", "terminal", "employee"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

// Bifogad länk: a page inside Nav — the href follows the favourite's rule
// (one leading slash, never another site).
export const conversationLinkSchema = z
  .object({
    href: favoriteHrefSchema,
    title: z.string().trim().min(1).max(CONVERSATION_LINK_TITLE_MAX),
  })
  .strict();
export type ConversationLink = z.infer<typeof conversationLinkSchema>;

const messageBodySchema = z.string().trim().min(1).max(MESSAGE_BODY_MAX);

const uniqueIds = (max: number) =>
  z
    .array(z.string().uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Samma mottagare kan bara väljas en gång" });

// POST /conversations. recipientUserIds holds office users AND terminal
// accounts — the server decides which is which from the account's
// permissions. boardUntil only matters when a terminal is among them
// (default today + BOARD_DEFAULT_DAYS; its range is checked in the service,
// which knows the Stockholm day).
export const createConversationSchema = z
  .object({
    subject: z.string().trim().min(1).max(CONVERSATION_SUBJECT_MAX),
    body: messageBodySchema,
    recipientUserIds: uniqueIds(MAX_USER_RECIPIENTS).default([]),
    recipientEmployeeIds: uniqueIds(MAX_EMPLOYEE_RECIPIENTS).default([]),
    link: conversationLinkSchema.nullable().optional(),
    boardUntil: businessDateSchema.optional(),
  })
  .strict()
  .refine((input) => input.recipientUserIds.length + input.recipientEmployeeIds.length > 0, {
    message: "Välj minst en mottagare",
    path: ["recipientUserIds"],
  });
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

// POST /conversations/:id/participants — Lägg till deltagare: the same
// selection and rules as the recipients of a new conversation.
export const addParticipantsSchema = z
  .object({
    recipientUserIds: uniqueIds(MAX_USER_RECIPIENTS).default([]),
    recipientEmployeeIds: uniqueIds(MAX_EMPLOYEE_RECIPIENTS).default([]),
    boardUntil: businessDateSchema.optional(),
  })
  .strict()
  .refine((input) => input.recipientUserIds.length + input.recipientEmployeeIds.length > 0, {
    message: "Välj minst en deltagare",
    path: ["recipientUserIds"],
  });
export type AddParticipantsInput = z.infer<typeof addParticipantsSchema>;

export const createMessageSchema = z.object({ body: messageBodySchema }).strict();
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

// POST /conversations/:id/read — messageId = the newest message the reader
// has on screen (everything up to it is read); without it, the newest one.
export const markConversationReadSchema = z.object({ messageId: z.string().uuid().optional() }).strict();
export type MarkConversationReadInput = z.infer<typeof markConversationReadSchema>;

// GET /conversations: the list pattern plus ?archived=true (Arkiverade).
export const listConversationsQuerySchema = listQuerySchema.extend({
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

// Terminalen: OK, läst — the messages the employee had on screen.
export const acknowledgeEmployeeMessagesSchema = z
  .object({ messageIds: z.array(z.string().uuid()).min(1).max(500) })
  .strict();
export type AcknowledgeEmployeeMessagesInput = z.infer<typeof acknowledgeEmployeeMessagesSchema>;

// Terminalen: the employee's reply in one of their own conversations.
// messageIds = the conversation's messages the employee had on screen — the
// reply reads up to the newest of them (without them: up to the reply).
export const employeeReplySchema = z
  .object({ body: messageBodySchema, messageIds: z.array(z.string().uuid()).min(1).max(500).optional() })
  .strict();
export type EmployeeReplyInput = z.infer<typeof employeeReplySchema>;

// The inbox row's "senaste meddelandets början".
export const MESSAGE_PREVIEW_LENGTH = 140;
export function messagePreview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= MESSAGE_PREVIEW_LENGTH ? flat : `${flat.slice(0, MESSAGE_PREVIEW_LENGTH - 1).trimEnd()}…`;
}
