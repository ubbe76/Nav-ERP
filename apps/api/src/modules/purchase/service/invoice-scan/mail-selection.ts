import { createHash } from "node:crypto";
import { INVOICE_SCAN_MAX_FILE_BYTES, type InvoiceScanMailOutcome } from "@navet/shared";
import { hasSignature } from "./file-signature.js";

// Fakturaskanning — which attachments of a letter become inbox scans (spec
// §4 punkt 2), the letter's outcome in Senast lästa brev and the synthetic
// Message-ID. Pure; the e-mail job applies it to what mail-mime.ts parsed.
//
// - Every PDF.
// - Images (JPEG/PNG) only when the letter has no PDF, the image is at least
//   30 kB and not inline (a cid that the HTML shows — signature logos).
// - XML (e-faktura, out of scope) and every other type: unsupported.
// - Over 20 MB (the underlag's cap): too_large.

// Smaller images are logos, icons and tracking pixels.
export const MAIL_IMAGE_MIN_BYTES = 30 * 1024;

export interface MailAttachment {
  // The attachment's place among ALL the letter's attachments — stable
  // between two reads of the same letter, half of the idempotency key.
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
  content: Buffer;
  contentDisposition: string | null;
  cid: string | null;
  // mailparser: the part sits in a multipart/related (an HTML body's image).
  related: boolean;
}

export type MailFileType = "application/pdf" | "image/jpeg" | "image/png";

export interface SelectedAttachment {
  index: number;
  filename: string;
  contentType: MailFileType;
  content: Buffer;
}

export type MailSkipReason = "inline_image" | "small_image" | "image_beside_pdf" | "unsupported" | "wrong_content" | "empty" | "too_large";

export interface SkippedAttachment {
  index: number;
  filename: string;
  reason: MailSkipReason;
}

export interface MailSelection {
  selected: SelectedAttachment[];
  skipped: SkippedAttachment[];
}

const EXTENSION_TYPES: Record<string, MailFileType> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
const TYPE_ALIASES: Record<string, MailFileType> = {
  "application/pdf": "application/pdf",
  "application/x-pdf": "application/pdf",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/png": "image/png",
};
// Types mail clients use when they do not know better: the extension decides.
const GENERIC_TYPES = new Set(["application/octet-stream", "application/binary", "binary/octet-stream", "application/download", "application/force-download"]);

const DEFAULT_EXTENSION: Record<MailFileType, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

function extensionOf(filename: string | null): string | null {
  const match = filename ? /\.([a-z0-9]+)$/i.exec(filename.trim()) : null;
  return match ? match[1]!.toLowerCase() : null;
}

// The attachment's type as the inbox knows it, or null for every other type.
export function mailFileType(attachment: Pick<MailAttachment, "contentType" | "filename">): MailFileType | null {
  const type = attachment.contentType.split(";")[0]!.trim().toLowerCase();
  if (TYPE_ALIASES[type]) return TYPE_ALIASES[type];
  if (GENERIC_TYPES.has(type) || type === "") {
    const ext = extensionOf(attachment.filename);
    return ext ? (EXTENSION_TYPES[ext] ?? null) : null;
  }
  return null;
}

function isInline(attachment: MailAttachment): boolean {
  if (!attachment.cid) return false;
  return attachment.related || (attachment.contentDisposition ?? "").toLowerCase() === "inline";
}

function displayName(attachment: MailAttachment, type: MailFileType | null): string {
  const name = attachment.filename?.trim();
  if (name) return name.slice(0, 255);
  return `bilaga-${attachment.index + 1}.${type ? DEFAULT_EXTENSION[type] : "bin"}`;
}

export function selectMailAttachments(attachments: MailAttachment[]): MailSelection {
  const typed = attachments.map((a) => ({ attachment: a, type: mailFileType(a) }));
  const hasPdf = typed.some((t) => t.type === "application/pdf");
  const selected: SelectedAttachment[] = [];
  const skipped: SkippedAttachment[] = [];
  for (const { attachment, type } of typed) {
    const filename = displayName(attachment, type);
    const skip = (reason: MailSkipReason) => skipped.push({ index: attachment.index, filename, reason });
    const size = attachment.content.length;
    if (type === null) {
      skip("unsupported");
      continue;
    }
    if (type !== "application/pdf") {
      if (isInline(attachment)) {
        skip("inline_image");
        continue;
      }
      if (hasPdf) {
        skip("image_beside_pdf");
        continue;
      }
      if (size > 0 && size < MAIL_IMAGE_MIN_BYTES) {
        skip("small_image");
        continue;
      }
    }
    if (size === 0) {
      skip("empty");
      continue;
    }
    if (size > INVOICE_SCAN_MAX_FILE_BYTES) {
      skip("too_large");
      continue;
    }
    if (!hasSignature(type, attachment.content)) {
      skip("wrong_content");
      continue;
    }
    selected.push({ index: attachment.index, filename, contentType: type, content: attachment.content });
  }
  return { selected, skipped };
}

// What Senast lästa brev says about a skipped attachment.
export const MAIL_SKIP_TEXTS: Record<MailSkipReason, string> = {
  inline_image: "inbäddad bild (t.ex. logotyp) hoppades över",
  small_image: "liten bild (under 30 kB) hoppades över",
  image_beside_pdf: "bilden hoppades över — brevet har en PDF",
  unsupported: "filtypen stöds inte",
  wrong_content: "innehållet är inte en PDF, JPEG eller PNG",
  empty: "tom fil",
  too_large: "större än 20 MB",
};

// The letter's one outcome: imported when at least one attachment became a
// scan; otherwise the most telling reason why none did.
export function mailOutcome(input: { created: number; duplicates: number; skipped: SkippedAttachment[] }): InvoiceScanMailOutcome {
  if (input.created > 0) return "imported";
  if (input.duplicates > 0) return "duplicate";
  if (input.skipped.some((s) => s.reason === "too_large")) return "too_large";
  if (input.skipped.some((s) => s.reason === "unsupported" || s.reason === "wrong_content" || s.reason === "empty")) return "unsupported";
  return "no_attachment";
}

// A letter without a Message-ID still needs a stable key for the
// idempotency index: sha256 over sender, date, subject and the attachments'
// own sha256 — the same letter read twice gives the same id.
export function syntheticMessageId(input: { from: string | null; date: Date | null; subject: string | null; attachments: Buffer[] }): string {
  const hash = createHash("sha256");
  hash.update(`from:${input.from ?? ""}\n`);
  hash.update(`date:${input.date && !Number.isNaN(input.date.getTime()) ? input.date.toISOString() : ""}\n`);
  hash.update(`subject:${input.subject ?? ""}\n`);
  for (const content of input.attachments) hash.update(`attachment:${createHash("sha256").update(content).digest("hex")}\n`);
  return `<nav-synthetic-${hash.digest("hex")}@navet.invalid>`;
}

// A Message-ID as the key column takes it (varchar 998): trimmed; a longer
// one (never in practice) is hashed so two long ids never collide on a
// truncation.
export function messageIdKey(messageId: string): string {
  const trimmed = messageId.trim();
  if (trimmed.length <= 998) return trimmed;
  return `<nav-long-${createHash("sha256").update(trimmed).digest("hex")}@navet.invalid>`;
}
