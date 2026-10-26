import type { MailAttachment } from "./mail-selection.js";

// Fakturaskanning — the letter's MIME, parsed with mailparser (spec §4). The
// only file that imports mailparser, lazily: the app and every test that
// never reads a letter skip loading it. The bodies are not needed (no
// HTML-to-text, no link detection, cid images left as links) — only the
// headers the inbox stores and the attachments with their filename, type,
// disposition and cid.

export interface ParsedInvoiceMail {
  messageId: string | null;
  // The sender's address (the first From), lower case.
  from: string | null;
  subject: string | null;
  date: Date | null;
  // The topmost Authentication-Results header as it stood (the receiving
  // server's verdict on SPF/DKIM/DMARC — avsändarregeln reads it), null
  // when the letter has none.
  authenticationResults: string | null;
  attachments: MailAttachment[];
}

// A letter mailparser cannot make sense of.
export class MailParseError extends Error {
  constructor() {
    super("The letter could not be parsed");
    this.name = "MailParseError";
  }
}

export async function parseInvoiceMail(source: Buffer): Promise<ParsedInvoiceMail> {
  const { simpleParser } = await import("mailparser");
  let parsed: Awaited<ReturnType<typeof simpleParser>>;
  try {
    parsed = await simpleParser(source, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
      skipTextLinks: true,
      keepCidLinks: true,
    });
  } catch {
    throw new MailParseError();
  }
  const from = parsed.from?.value?.find((a) => a.address)?.address ?? null;
  const date = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null;
  return {
    messageId: parsed.messageId?.trim() || null,
    from: from ? from.trim().toLowerCase().slice(0, 320) : null,
    subject: parsed.subject?.trim() ? parsed.subject.trim().slice(0, 998) : null,
    date,
    // headerLines keeps the header order: the first one is the topmost.
    authenticationResults: (parsed.headerLines ?? []).find((h) => h.key === "authentication-results")?.line ?? null,
    attachments: (parsed.attachments ?? []).map((a, index) => {
      const content = Buffer.isBuffer(a.content) ? a.content : Buffer.alloc(0);
      return {
        index,
        filename: a.filename ?? null,
        contentType: a.contentType ?? "application/octet-stream",
        size: content.length,
        content,
        contentDisposition: a.contentDisposition ?? null,
        cid: a.cid ?? null,
        related: a.related === true,
      };
    }),
  };
}
