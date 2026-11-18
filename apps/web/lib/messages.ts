import { formatStockholmDate, formatStockholmDateTime } from "./date";

// Meddelanden — the web's types for the messages module and its pure rules.
// The constants mirror packages/shared/src/messages.ts (the web can not
// import @navet/shared); web-messages.test.ts keeps them equal and tests the
// helpers. No React, Next or API client here: the API suite loads this file.
export const CONVERSATION_SUBJECT_MAX = 200;
export const MESSAGE_BODY_MAX = 5000;
export const CONVERSATION_LINK_TITLE_MAX = 200;
export const CONVERSATION_LINK_HREF_MAX = 500;
export const BOARD_DEFAULT_DAYS = 7;
export const BOARD_MAX_DAYS = 365;

// How often the envelope (and the stamp terminal) asks for new messages.
export const MESSAGES_REFRESH_MS = 60 * 1000;

export type ParticipantKind = "user" | "terminal" | "employee";

export interface ConversationParticipant {
  // The participant row — what Ta bort names.
  participantId: string;
  kind: ParticipantKind;
  id: string;
  name: string;
  employeeNumber: string | null;
  // Employees only: when OK, läst was pressed, and whether everything
  // written since is acknowledged.
  lastReadAt: string | null;
  read: boolean | null;
  // Terminals only.
  boardUntil: string | null;
  onBoard: boolean | null;
}

export type MessageEventType = "added" | "removed" | "left";

// One row of the thread: a message (deleted: no text left) or a händelserad
// (`event`: who added/removed whom, or who left — named when it is read;
// `name: null` = the person has been erased since).
export interface ConversationMessage {
  id: string;
  kind: "message" | "event";
  // null for an employee's reply from the stämpelterminal.
  senderId: string | null;
  senderEmployeeId: string | null;
  senderName: string;
  viaTerminal: boolean;
  body: string | null;
  deleted: boolean;
  createdAt: string;
  event: { type: MessageEventType; targets: { kind: "user" | "employee" | null; name: string | null }[] } | null;
}

export interface ConversationLink {
  href: string;
  title: string;
}

export interface ConversationListRow {
  id: string;
  subject: string;
  hasLink: boolean;
  createdAt: string;
  lastMessageAt: string;
  archived: boolean;
  unreadCount: number;
  participants: ConversationParticipant[];
  lastMessage: { senderId: string | null; senderName: string; preview: string; deleted: boolean; createdAt: string } | null;
}

export interface ConversationDetail {
  id: string;
  subject: string;
  link: ConversationLink | null;
  createdBy: string;
  createdAt: string;
  lastMessageAt: string;
  archived: boolean;
  unreadCount: number;
  canRemoveFromBoard: boolean;
  participants: ConversationParticipant[];
  messages: ConversationMessage[];
}

export interface UnreadSummary {
  count: number;
  conversations: number;
  latest: { conversationId: string; subject: string; messageId: string; senderName: string; createdAt: string } | null;
}

export interface MessageRecipients {
  users: { id: string; name: string }[];
  terminals: { id: string; name: string }[];
  employees: { id: string; employeeNumber: string; name: string }[];
}

// Stämpelterminalen.
export interface BoardConversation {
  id: string;
  subject: string;
  boardUntil: string;
  messages: { id: string; senderName: string; body: string; createdAt: string }[];
}
// What the employee has not acknowledged, per conversation — the employee
// can reply in each of them (Svara).
export interface EmployeeUnreadConversation {
  conversationId: string;
  subject: string;
  messages: { id: string; senderName: string; body: string; createdAt: string }[];
}

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i;
// The favourite's href rule (packages/shared user-settings.ts): a path
// inside Nav, never another site, no whitespace or control characters.
const INTERNAL_HREF = /^\/(?![/\\])[^\s\\\p{Cc}]*$/u;

export function isInternalHref(href: string): boolean {
  return href.length <= CONVERSATION_LINK_HREF_MAX && INTERNAL_HREF.test(href);
}

// Bifoga länk till sidan du står på: the page's address (with its query,
// dropped when the whole would be too long) under the page's own title.
// null where there is nothing to attach — Meddelanden itself, or an address
// the API would refuse. `document` = the page is a card (an order, an
// article …): the box is then ticked from the start.
export function pageLinkOffer(
  pathname: string,
  search: string,
  title: string
): { link: ConversationLink; document: boolean } | null {
  if (pathname === "/meddelanden" || pathname.startsWith("/meddelanden/")) return null;
  const query = search && search !== "?" ? (search.startsWith("?") ? search : `?${search}`) : "";
  const href = isInternalHref(`${pathname}${query}`) ? `${pathname}${query}` : pathname;
  if (!isInternalHref(href)) return null;
  const name = title.replace(/\s+/g, " ").trim().slice(0, CONVERSATION_LINK_TITLE_MAX) || "Sidan";
  return { link: { href, title: name }, document: UUID_SEGMENT.test(pathname) };
}

// The notice is shown when the count has GROWN since the last reading —
// never on the first reading after a page load (the badge says it).
export function unreadIncreased(previous: number | null, next: number): boolean {
  return previous !== null && next > previous;
}

export function participantLabel(p: Pick<ConversationParticipant, "kind" | "name" | "employeeNumber">): string {
  return p.kind === "employee" && p.employeeNumber ? `${p.employeeNumber} ${p.name}` : p.name;
}

// The inbox row's "with whom": everyone but the reader.
export function otherParticipants(participants: readonly ConversationParticipant[], selfId: string): string {
  const others = participants.filter((p) => !(p.kind !== "employee" && p.id === selfId));
  return others.map(participantLabel).join(", ");
}

// "Anna", "Anna och Bo", "Anna, Bo och Terminal Verkstad".
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} och ${names.at(-1)}`;
}

export const DELETED_MESSAGE_TEXT = "Meddelandet togs bort";
const ERASED_TARGET = "en borttagen deltagare";

// The händelserad's text: "Anna lade till Bo och Terminal Verkstad", "Anna
// tog bort Bo", "Bo lämnade konversationen" — "Du" for the reader. The names
// come from the API as they are NOW (an anonymized employee already has the
// neutral name; an erased one has none).
export function eventText(message: Pick<ConversationMessage, "senderId" | "senderName" | "event">, selfId: string): string {
  const actor = message.senderId === selfId ? "Du" : message.senderName;
  const event = message.event;
  if (!event) return "";
  if (event.type === "left") return `${actor} lämnade konversationen`;
  const named = event.targets.map((t) => t.name).filter((name): name is string => name !== null);
  const erased = event.targets.length - named.length;
  const targets = joinNames([...named, ...(erased === 1 ? [ERASED_TARGET] : erased > 1 ? [`${erased} borttagna deltagare`] : [])]) || ERASED_TARGET;
  return event.type === "added" ? `${actor} lade till ${targets}` : `${actor} tog bort ${targets}`;
}

// Lägg till deltagare: the recipient selection without those already in the
// conversation.
export function recipientsToAdd(all: MessageRecipients, participants: readonly ConversationParticipant[]): MessageRecipients {
  const userIds = new Set(participants.filter((p) => p.kind !== "employee").map((p) => p.id));
  const employeeIds = new Set(participants.filter((p) => p.kind === "employee").map((p) => p.id));
  return {
    users: all.users.filter((u) => !userIds.has(u.id)),
    terminals: all.terminals.filter((u) => !userIds.has(u.id)),
    employees: all.employees.filter((e) => !employeeIds.has(e.id)),
  };
}

// --- Stämpelterminalen: the employee's reply ---

// Snabbsvar: a tap fills the field, Skicka sends.
export const TERMINAL_QUICK_REPLIES = ["OK", "Tack!", "Jag kommer", "Ring mig"] as const;

// Skärmtangentbordet: QWERTY with å, ä and ö. The control keys are named.
export const TERMINAL_KEYBOARD_ROWS: readonly (readonly string[])[] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "å"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "ö", "ä"],
  ["shift", "z", "x", "c", "v", "b", "n", "m", ",", ".", "backspace"],
  ["?", "!", "space", "-", "enter"],
];

// What one key of the skärmtangentbord does to the text. Shift is one-shot:
// it capitalises the next letter and lets go. A new text (and one after . !
// ? or a new line) starts with a capital on its own.
export function terminalKeyboardShiftDefault(text: string): boolean {
  return /(^|[.!?]\s+|\n)$/.test(text);
}
export function applyTerminalKey(text: string, key: string, shift: boolean, max: number = MESSAGE_BODY_MAX): string {
  if (key === "backspace") return [...text].slice(0, -1).join("");
  if (key === "shift") return text;
  const typed = key === "space" ? " " : key === "enter" ? "\n" : shift ? key.toLocaleUpperCase("sv-SE") : key;
  return text.length + typed.length > max ? text : text + typed;
}

// Which keyboard the terminal uses for the reply: its own skärmtangentbord
// (the default — the textarea then gets inputMode="none" so the tablet's
// keyboard does not cover it) or the device's. Remembered per terminal
// (browser) in localStorage.
export type TerminalKeyboardMode = "screen" | "device";
export const TERMINAL_KEYBOARD_STORAGE_KEY = "nav.terminal.replyKeyboard";
export function terminalKeyboardModeOf(stored: string | null | undefined): TerminalKeyboardMode {
  return stored === "device" ? "device" : "screen";
}

// A time in Swedish time: only the clock for today, the date too otherwise.
export function messageTime(iso: string, today: string): string {
  const full = formatStockholmDateTime(iso);
  return formatStockholmDate(iso) === today ? full.slice(-5) : full;
}

// What the office sees beside an employee ("Läst 14:32" / "Oläst") or a
// terminal ("Visas på terminalen t.o.m. 2026-11-25"); null for a user.
export function participantStatus(p: ConversationParticipant, today: string): string | null {
  if (p.kind === "employee") return p.read && p.lastReadAt ? `Läst ${messageTime(p.lastReadAt, today)}` : "Oläst";
  if (p.kind === "terminal") {
    if (p.boardUntil === null) return "Borttagen från terminalen";
    return p.onBoard ? `Visas på terminalen t.o.m. ${p.boardUntil}` : `Visades på terminalen t.o.m. ${p.boardUntil}`;
  }
  return null;
}

// The recipient picker's search: every word somewhere in the name (or the
// anställningsnummer), case and å/ä/ö folded like the command palette.
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
export function matchesRecipient(label: string, query: string): boolean {
  const hay = fold(label);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}
