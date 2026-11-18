import { describe, expect, it } from "vitest";
import * as shared from "@navet/shared";
// lib/messages.ts imports only ./date (pure), so vitest can load it directly.
import * as web from "../../web/lib/messages.js";

// Meddelanden — the web's mirror of the shared constants (the web can not
// import @navet/shared) and its pure rules: the link offered by Bifoga länk
// till sidan du står på, when the envelope shows a notice, and the texts
// beside an employee and a terminal.

describe("the mirror of packages/shared/src/messages.ts", () => {
  it("has the same limits", () => {
    expect(web.CONVERSATION_SUBJECT_MAX).toBe(shared.CONVERSATION_SUBJECT_MAX);
    expect(web.MESSAGE_BODY_MAX).toBe(shared.MESSAGE_BODY_MAX);
    expect(web.CONVERSATION_LINK_TITLE_MAX).toBe(shared.CONVERSATION_LINK_TITLE_MAX);
    expect(web.BOARD_DEFAULT_DAYS).toBe(shared.BOARD_DEFAULT_DAYS);
    expect(web.BOARD_MAX_DAYS).toBe(shared.BOARD_MAX_DAYS);
  });

  it("accepts exactly the hrefs the API's link schema accepts", () => {
    const hrefs = [
      "/forsaljning/ordrar",
      "/forsaljning/ordrar/0b0f6f0e-3c58-4a39-9d0c-0d5a5f0e7a11?flik=rader",
      "/",
      "//example.com",
      "/\\example.com",
      "https://example.com/",
      "javascript:alert(1)",
      "forsaljning",
      "/med blanksteg",
      "/back\\slash",
      "/kontroll\u0007tecken",
      "",
      `/${"x".repeat(web.CONVERSATION_LINK_HREF_MAX - 1)}`,
      `/${"x".repeat(web.CONVERSATION_LINK_HREF_MAX)}`,
    ];
    for (const href of hrefs) {
      const api = shared.conversationLinkSchema.safeParse({ href, title: "Sidan" }).success;
      expect([href, web.isInternalHref(href)]).toEqual([href, api]);
    }
  });
});

describe("pageLinkOffer — Bifoga länk till sidan du står på", () => {
  const id = "0b0f6f0e-3c58-4a39-9d0c-0d5a5f0e7a11";

  it("offers the page with its query, ticked from the start on a document", () => {
    expect(web.pageLinkOffer(`/forsaljning/ordrar/${id}`, "", "  KO-1042  \n Kund AB ")).toEqual({
      link: { href: `/forsaljning/ordrar/${id}`, title: "KO-1042 Kund AB" },
      document: true,
    });
    expect(web.pageLinkOffer("/forsaljning/ordrar", "?status=confirmed&search=pl%C3%A5t", "Kundorder")).toEqual({
      link: { href: "/forsaljning/ordrar?status=confirmed&search=pl%C3%A5t", title: "Kundorder" },
      document: false,
    });
    expect(web.pageLinkOffer("/", "", "")).toEqual({ link: { href: "/", title: "Sidan" }, document: false });
  });

  it("offers nothing on Meddelanden itself", () => {
    expect(web.pageLinkOffer("/meddelanden", "", "Meddelanden")).toBeNull();
    expect(web.pageLinkOffer(`/meddelanden/${id}`, "", "Ett ämne")).toBeNull();
    expect(web.pageLinkOffer("/meddelandenx", "", "Annan sida")).not.toBeNull();
  });

  it("drops a query that would make the address too long, and never offers what the API refuses", () => {
    const long = `?search=${"x".repeat(600)}`;
    expect(web.pageLinkOffer("/artiklar", long, "Artiklar")?.link.href).toBe("/artiklar");
    expect(web.pageLinkOffer("/artiklar", "?a=b c", "Artiklar")?.link.href).toBe("/artiklar");
    expect(web.pageLinkOffer(`/${"x".repeat(600)}`, "", "Lång")).toBeNull();
    const offer = web.pageLinkOffer("/artiklar", "?search=skruv", "T".repeat(500))!;
    expect(shared.conversationLinkSchema.safeParse(offer.link).success).toBe(true);
    expect(offer.link.title).toHaveLength(web.CONVERSATION_LINK_TITLE_MAX);
  });
});

describe("the envelope's notice", () => {
  it("is shown only when the count has grown since the last reading", () => {
    expect(web.unreadIncreased(null, 3)).toBe(false); // the first reading after a page load
    expect(web.unreadIncreased(0, 1)).toBe(true);
    expect(web.unreadIncreased(2, 3)).toBe(true);
    expect(web.unreadIncreased(3, 3)).toBe(false);
    expect(web.unreadIncreased(3, 1)).toBe(false);
  });
});

describe("participants", () => {
  const base = { participantId: "p1", employeeNumber: null, lastReadAt: null, read: null, boardUntil: null, onBoard: null };
  const stina: web.ConversationParticipant = { ...base, kind: "user", id: "u1", name: "Stina Säljare" };
  const ivar: web.ConversationParticipant = { ...base, kind: "user", id: "u2", name: "Ivar Inköpare" };
  const terminal: web.ConversationParticipant = { ...base, kind: "terminal", id: "u3", name: "Terminal Svets", boardUntil: "2026-11-25", onBoard: true };
  const anna: web.ConversationParticipant = { ...base, kind: "employee", id: "e1", name: "Anna Andersson", employeeNumber: "107", read: false };

  it("lists everyone but the reader, employees with their number", () => {
    expect(web.otherParticipants([stina, ivar, terminal, anna], "u1")).toBe("Ivar Inköpare, Terminal Svets, 107 Anna Andersson");
    expect(web.otherParticipants([stina], "u1")).toBe("");
    // An employee is never "me", whatever the id.
    expect(web.otherParticipants([{ ...anna, id: "u1" }], "u1")).toBe("107 Anna Andersson");
  });

  it("says Läst with the time or Oläst for an employee, and the terminal's slutdatum", () => {
    const today = "2026-11-18";
    expect(web.participantStatus(stina, today)).toBeNull();
    expect(web.participantStatus(anna, today)).toBe("Oläst");
    // Stockholm time, whatever zone the process runs in: 13:32 UTC is 14:32.
    expect(web.participantStatus({ ...anna, read: true, lastReadAt: "2026-11-18T13:32:00.000Z" }, today)).toBe("Läst 14:32");
    expect(web.participantStatus({ ...anna, read: true, lastReadAt: "2026-11-17T13:32:00.000Z" }, today)).toBe("Läst 2026-11-17 14:32");
    // Acknowledged once, but something has been written since.
    expect(web.participantStatus({ ...anna, read: false, lastReadAt: "2026-11-17T13:32:00.000Z" }, today)).toBe("Oläst");
    expect(web.participantStatus(terminal, today)).toBe("Visas på terminalen t.o.m. 2026-11-25");
    expect(web.participantStatus({ ...terminal, boardUntil: "2026-11-10", onBoard: false }, today)).toBe("Visades på terminalen t.o.m. 2026-11-10");
    expect(web.participantStatus({ ...terminal, boardUntil: null, onBoard: false }, today)).toBe("Borttagen från terminalen");
  });

  it("shows only the clock for today — the Stockholm day, also just after midnight", () => {
    // 23:30 UTC on the 17th is 00:30 on the 18th in Stockholm.
    expect(web.messageTime("2026-11-17T23:30:00.000Z", "2026-11-18")).toBe("00:30");
    expect(web.messageTime("2026-11-17T22:30:00.000Z", "2026-11-18")).toBe("2026-11-17 23:30");
  });

  it("finds a recipient by every word, folding case and å/ä/ö", () => {
    expect(web.matchesRecipient("107 Anna Andersson", "anna 107")).toBe(true);
    expect(web.matchesRecipient("Stina Säljare", "saljare")).toBe(true);
    expect(web.matchesRecipient("Stina Säljare", "stina ink")).toBe(false);
    expect(web.matchesRecipient("Terminal Svets", "  ")).toBe(true);
  });
});

describe("messagePreview (shared)", () => {
  it("flattens whitespace and cuts with an ellipsis", () => {
    expect(shared.messagePreview("Hej!\n\nKommer   godset?")).toBe("Hej! Kommer godset?");
    const long = shared.messagePreview("ord ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(shared.MESSAGE_PREVIEW_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("händelserader — eventText", () => {
  const row = (senderId: string, senderName: string, type: web.MessageEventType, names: (string | null)[]) => ({
    senderId,
    senderName,
    event: { type, targets: names.map((name) => ({ kind: name === null ? null : ("user" as const), name })) },
  });

  it("says who added, removed or left — Du for the reader", () => {
    expect(web.eventText(row("a", "Anna", "added", ["Bo", "Terminal Verkstad"]), "x")).toBe("Anna lade till Bo och Terminal Verkstad");
    expect(web.eventText(row("a", "Anna", "added", ["Bo", "Cia", "Dan"]), "x")).toBe("Anna lade till Bo, Cia och Dan");
    expect(web.eventText(row("a", "Anna", "removed", ["Bo"]), "x")).toBe("Anna tog bort Bo");
    expect(web.eventText(row("b", "Bo", "left", []), "x")).toBe("Bo lämnade konversationen");
    expect(web.eventText(row("a", "Anna", "removed", ["Bo"]), "a")).toBe("Du tog bort Bo");
    expect(web.eventText({ senderId: "a", senderName: "Anna", event: null }, "x")).toBe("");
  });

  it("names an erased person neutrally", () => {
    expect(web.eventText(row("a", "Anna", "added", [null]), "x")).toBe("Anna lade till en borttagen deltagare");
    expect(web.eventText(row("a", "Anna", "added", ["Bo", null]), "x")).toBe("Anna lade till Bo och en borttagen deltagare");
    expect(web.eventText(row("a", "Anna", "removed", [null, null]), "x")).toBe("Anna tog bort 2 borttagna deltagare");
    expect(web.eventText(row("a", "Anna", "added", []), "x")).toBe("Anna lade till en borttagen deltagare");
  });
});

describe("recipientsToAdd — Lägg till deltagare", () => {
  it("leaves out those already in the conversation, per kind", () => {
    const all = {
      users: [
        { id: "u1", name: "Anna" },
        { id: "u2", name: "Bo" },
      ],
      terminals: [
        { id: "t1", name: "Terminal Svets" },
        { id: "t2", name: "Terminal Lager" },
      ],
      employees: [
        { id: "u1", employeeNumber: "101", name: "Samma id som en användare" },
        { id: "e2", employeeNumber: "102", name: "Cia" },
      ],
    };
    const p = (kind: web.ParticipantKind, id: string) =>
      ({ participantId: `p-${id}`, kind, id, name: "", employeeNumber: null, lastReadAt: null, read: null, boardUntil: null, onBoard: null }) satisfies web.ConversationParticipant;
    expect(web.recipientsToAdd(all, [p("user", "u1"), p("terminal", "t2"), p("employee", "e2")])).toEqual({
      users: [{ id: "u2", name: "Bo" }],
      terminals: [{ id: "t1", name: "Terminal Svets" }],
      employees: [{ id: "u1", employeeNumber: "101", name: "Samma id som en användare" }],
    });
  });
});

describe("terminalens skärmtangentbord", () => {
  it("has every Swedish letter once, the digits, and the named keys", () => {
    const keys = web.TERMINAL_KEYBOARD_ROWS.flat();
    expect(new Set(keys).size).toBe(keys.length);
    for (const letter of "abcdefghijklmnopqrstuvwxyzåäö0123456789") expect(keys).toContain(letter);
    for (const named of ["shift", "backspace", "space", "enter"]) expect(keys).toContain(named);
    // A phone's width: no row longer than the eleven keys the layout is sized for.
    expect(Math.max(...web.TERMINAL_KEYBOARD_ROWS.map((row) => row.length))).toBeLessThanOrEqual(11);
  });

  it("types, capitalises with shift (å ä ö too), erases and stops at the limit", () => {
    expect(web.applyTerminalKey("he", "j", false)).toBe("hej");
    expect(web.applyTerminalKey("", "å", true)).toBe("Å");
    expect(web.applyTerminalKey("", "ö", true)).toBe("Ö");
    expect(web.applyTerminalKey("1", "2", true)).toBe("12");
    expect(web.applyTerminalKey("Jag", "space", true)).toBe("Jag ");
    expect(web.applyTerminalKey("rad", "enter", false)).toBe("rad\n");
    expect(web.applyTerminalKey("hej", "backspace", false)).toBe("he");
    expect(web.applyTerminalKey("", "backspace", false)).toBe("");
    expect(web.applyTerminalKey("ok 👍", "backspace", false)).toBe("ok ");
    expect(web.applyTerminalKey("hej", "shift", true)).toBe("hej");
    expect(web.applyTerminalKey("abc", "d", false, 3)).toBe("abc");
    expect(web.applyTerminalKey("x".repeat(shared.MESSAGE_BODY_MAX), "y", false)).toHaveLength(shared.MESSAGE_BODY_MAX);
  });

  it("starts a text and a sentence with a capital", () => {
    expect(web.terminalKeyboardShiftDefault("")).toBe(true);
    expect(web.terminalKeyboardShiftDefault("Hej. ")).toBe(true);
    expect(web.terminalKeyboardShiftDefault("Va? ")).toBe(true);
    expect(web.terminalKeyboardShiftDefault("Rad\n")).toBe(true);
    expect(web.terminalKeyboardShiftDefault("Hej")).toBe(false);
    expect(web.terminalKeyboardShiftDefault("Hej ")).toBe(false);
    expect(web.terminalKeyboardShiftDefault("kl. 7.")).toBe(false);
  });

  it("uses the skärmtangentbord unless the terminal chose the device's", () => {
    expect(web.terminalKeyboardModeOf(null)).toBe("screen");
    expect(web.terminalKeyboardModeOf(undefined)).toBe("screen");
    expect(web.terminalKeyboardModeOf("något annat")).toBe("screen");
    expect(web.terminalKeyboardModeOf("screen")).toBe("screen");
    expect(web.terminalKeyboardModeOf("device")).toBe("device");
  });

  it("has quick replies that fit a message", () => {
    expect(web.TERMINAL_QUICK_REPLIES).toEqual(["OK", "Tack!", "Jag kommer", "Ring mig"]);
    for (const text of web.TERMINAL_QUICK_REPLIES) expect(shared.employeeReplySchema.safeParse({ body: text }).success).toBe(true);
  });
});
