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
  const base = { employeeNumber: null, lastReadAt: null, read: null, boardUntil: null, onBoard: null };
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
