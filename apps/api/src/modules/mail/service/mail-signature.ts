import PDFDocument from "pdfkit";
import {
  DEFAULT_MAIL_SIGNATURE,
  MAIL_SIGNATURE_USER_FIELDS,
  mailSignatureSchema,
  type MailSignature,
  type MailSignatureCompanyField,
  type MailTemplateLanguage,
} from "@navet/shared";
import { documentTexts } from "./document-texts.js";
import { escapeHtml } from "./mail-html.js";

// E-postsignatur (2026-11-14): the block under a document mail — the
// sender's own details (chosen in Mina inställningar, stored as ONE user
// setting) and the company's (chosen by the admin in Företagsinfo, the
// system setting mailSignatureCompanyFields). ONE renderer gives both the
// text part and the HTML part, and the preview in Mina inställningar is the
// same HTML with the logo as a data: URL instead of the mail's cid: image.

export const MAIL_SIGNATURE_SETTING_KEY = "mail_signature";

// The inline logo's Content-ID in the mail (the HTML's cid: reference).
export const SIGNATURE_LOGO_CID = "signature-logo@nav-erp";

// The logo is scaled down (never up) to fit this box, in CSS pixels.
export const SIGNATURE_LOGO_MAX_WIDTH = 180;
export const SIGNATURE_LOGO_MAX_HEIGHT = 60;

// Inline styles only (mail clients drop <style>); fixed colours, since a
// mail is read on the client's white page whatever Nav's theme.
const FONT = "Arial, Helvetica, sans-serif";
const TEXT_COLOUR = "#1f2328";
const MUTED_COLOUR = "#57606a";
const LINK_COLOUR = "#0b5cad";
const RULE_COLOUR = "#d0d7de";

const LABELS: Record<MailTemplateLanguage, { phone: string; mobile: string; companyPhone: string }> = {
  sv: { phone: "Telefon", mobile: "Mobil", companyPhone: "Växel" },
  en: { phone: "Phone", mobile: "Mobile", companyPhone: "Phone" },
};

export interface SignatureUser {
  name: string;
  email: string;
}

export interface SignatureCompany {
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  companySeat: string | null;
}

export interface SignatureLogo {
  content: Buffer;
  contentType: "image/png" | "image/jpeg";
  filename: string;
  // The size the HTML shows it at.
  width: number;
  height: number;
}

export interface SignatureInput {
  user: SignatureUser;
  signature: MailSignature;
  company: SignatureCompany | null;
  companyFields: readonly MailSignatureCompanyField[];
  logo: SignatureLogo | null;
  language: MailTemplateLanguage;
}

export interface RenderedSignature {
  text: string;
  // The signature block; `logoSrc` is the image's URL (cid: in the mail,
  // data: in the preview). `spaced`: the gap above it, under a message.
  html: (logoSrc: string, spaced?: boolean) => string;
  // The logo the HTML shows, null = none.
  logo: SignatureLogo | null;
}

// The stored setting, read tolerantly: anything that no longer passes the
// schema reads as the default (off).
export function decodeMailSignature(raw: string | undefined): MailSignature {
  if (!raw) return { ...DEFAULT_MAIL_SIGNATURE, fields: [...DEFAULT_MAIL_SIGNATURE.fields] };
  try {
    const check = mailSignatureSchema.safeParse(JSON.parse(raw));
    if (check.success) return check.data;
  } catch {
    // fall through to the default
  }
  return { ...DEFAULT_MAIL_SIGNATURE, fields: [...DEFAULT_MAIL_SIGNATURE.fields] };
}

interface PdfImageOpener {
  openImage(src: Buffer): { width: number; height: number };
}

// The company logo as the signature shows it: PNG or JPEG only (what mail
// clients and pdfkit both read — pdfkit's own parser gives the size), scaled
// into the box. Anything else (or a broken file) = no logo.
export function signatureLogo(content: Buffer | null | undefined): SignatureLogo | null {
  if (!content || content.length < 4) return null;
  const isPng = content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47;
  const isJpeg = content[0] === 0xff && content[1] === 0xd8;
  if (!isPng && !isJpeg) return null;
  let width: number;
  let height: number;
  try {
    // openImage is pdfkit's own (PNG/JPEG) parser, missing from its types.
    const doc = new PDFDocument({ autoFirstPage: false }) as unknown as PdfImageOpener;
    const image = doc.openImage(content);
    width = image.width;
    height = image.height;
  } catch {
    return null;
  }
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(1, SIGNATURE_LOGO_MAX_WIDTH / width, SIGNATURE_LOGO_MAX_HEIGHT / height);
  return {
    content,
    contentType: isPng ? "image/png" : "image/jpeg",
    filename: isPng ? "logo.png" : "logo.jpg",
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  return /\d/.test(digits) ? `tel:${digits}` : null;
}

function websiteHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

// One line of the signature: its text, and its HTML (escaped, maybe linked).
interface Line {
  text: string;
  html: string;
}

function plain(text: string, style = ""): Line {
  return { text, html: `<div${style ? ` style="${style}"` : ""}>${escapeHtml(text)}</div>` };
}

function link(label: string | null, value: string, href: string | null, style = ""): Line {
  const text = label ? `${label}: ${value}` : value;
  const prefix = label ? `${escapeHtml(label)}: ` : "";
  const shown = href
    ? `<a href="${escapeHtml(href)}" style="color:${LINK_COLOUR};text-decoration:none">${escapeHtml(value)}</a>`
    : escapeHtml(value);
  return { text, html: `<div${style ? ` style="${style}"` : ""}>${prefix}${shown}</div>` };
}

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// The signature, or null when nothing would be in it.
export function renderSignature(input: SignatureInput): RenderedSignature | null {
  const { user, signature, company, language } = input;
  const labels = LABELS[language];
  const footer = documentTexts(language).footer;
  const userFields = new Set(signature.fields);
  const companyFields = new Set(input.companyFields);

  const personal: Line[] = [];
  if (userFields.has("name") && present(user.name)) personal.push(plain(user.name.trim(), "font-size:15px;font-weight:bold"));
  if (userFields.has("title") && present(signature.title)) personal.push(plain(signature.title, `color:${MUTED_COLOUR}`));
  if (userFields.has("phone") && present(signature.phone)) personal.push(link(labels.phone, signature.phone, telHref(signature.phone)));
  if (userFields.has("mobile") && present(signature.mobile)) {
    personal.push(link(labels.mobile, signature.mobile, telHref(signature.mobile)));
  }
  if (userFields.has("email") && present(user.email)) personal.push(link(null, user.email, `mailto:${user.email}`));

  const companyLines: Line[] = [];
  if (company) {
    if (companyFields.has("name") && present(company.name)) companyLines.push(plain(company.name, "font-weight:bold"));
    if (companyFields.has("address")) {
      const place = [company.postalCode, company.city].filter(present).join(" ");
      const address = [company.address, place].filter(present).join(", ");
      if (address) companyLines.push(plain(address, `color:${MUTED_COLOUR}`));
    }
    if (companyFields.has("phone") && present(company.phone)) {
      companyLines.push(link(labels.companyPhone, company.phone, telHref(company.phone), `color:${MUTED_COLOUR}`));
    }
    if (companyFields.has("email") && present(company.email)) companyLines.push(link(null, company.email, `mailto:${company.email}`));
    if (companyFields.has("website") && present(company.website)) {
      companyLines.push(link(null, company.website, websiteHref(company.website.trim())));
    }
    const legal = [
      companyFields.has("orgNumber") && present(company.orgNumber) ? `${footer.orgNumber}: ${company.orgNumber}` : null,
      companyFields.has("vatNumber") && present(company.vatNumber) ? `${footer.vatNumber}: ${company.vatNumber}` : null,
      companyFields.has("companySeat") && present(company.companySeat) ? `${footer.companySeat}: ${company.companySeat}` : null,
    ].filter((part): part is string => part !== null);
    if (legal.length > 0) companyLines.push(plain(legal.join(" · "), `color:${MUTED_COLOUR};font-size:12px`));
  }
  const logo = company && companyFields.has("logo") ? input.logo : null;

  if (personal.length === 0 && companyLines.length === 0 && !logo) return null;

  const text = [personal.map((l) => l.text).join("\n"), companyLines.map((l) => l.text).join("\n")]
    .filter((block) => block !== "")
    .join("\n\n");

  const html = (logoSrc: string, spaced = true) => {
    const cells: string[] = [];
    if (personal.length > 0) {
      cells.push(`<tr><td style="padding:0 0 10px 0">${personal.map((l) => l.html).join("")}</td></tr>`);
    }
    if (companyLines.length > 0 || logo) {
      const rule = personal.length > 0 ? `border-top:2px solid ${RULE_COLOUR};padding:10px 0 0 0` : "padding:0";
      const image = logo
        ? `<img src="${escapeHtml(logoSrc)}" width="${logo.width}" height="${logo.height}" alt="${escapeHtml(company?.name ?? "")}" style="display:block;border:0;outline:none;width:${logo.width}px;height:${logo.height}px;margin:0 0 8px 0">`
        : "";
      cells.push(`<tr><td style="${rule}">${image}${companyLines.map((l) => l.html).join("")}</td></tr>`);
    }
    return (
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
      `style="border-collapse:collapse;margin:${spaced ? 18 : 0}px 0 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${TEXT_COLOUR}">` +
      `${cells.join("")}</table>`
    );
  };

  return { text, html, logo };
}

// The message as HTML: escaped, line breaks kept.
export function messageHtml(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => escapeHtml(line))
    .join("<br>");
}

function htmlDocument(body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>` +
    `<body style="margin:0;padding:0;background:#ffffff">${body}</body></html>`
  );
}

export interface SignedMail {
  text: string;
  html: string;
  // The inline logo to attach (cid: SIGNATURE_LOGO_CID), null = none.
  logo: SignatureLogo | null;
}

// The message with the signature under it: the text part (message, blank
// line, signature) and the HTML part with the logo as an inline cid: image.
export function signMail(message: string, signature: RenderedSignature): SignedMail {
  const text = message ? `${message}\n\n${signature.text}` : signature.text;
  const body =
    `<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${TEXT_COLOUR}">${messageHtml(message)}</div>` +
    signature.html(`cid:${SIGNATURE_LOGO_CID}`);
  return { text, html: htmlDocument(body), logo: signature.logo };
}

// Mina inställningar's Förhandsvisning: the signature alone, the logo as a
// data: URL so the page's sandboxed frame needs nothing else.
export function previewHtml(signature: RenderedSignature | null): string {
  if (!signature) return htmlDocument("");
  const logoSrc = signature.logo ? `data:${signature.logo.contentType};base64,${signature.logo.content.toString("base64")}` : "";
  return htmlDocument(`<div style="padding:10px 12px">${signature.html(logoSrc, false)}</div>`);
}

// Where the service reads what goes in.
export interface MailSignatureStore {
  get(userId: string, key: string): Promise<string | undefined>;
  upsert(userId: string, key: string, value: string): Promise<void>;
}

export interface MailSignatureSources {
  // The account behind a send (name and e-mail), null = gone or inactive.
  user(userId: string): Promise<SignatureUser | null>;
  company(): Promise<SignatureCompany | null>;
  logo(): Promise<Buffer | null>;
  companyFields(): Promise<MailSignatureCompanyField[]>;
}

export function createMailSignatureService(deps: { store: MailSignatureStore; sources: MailSignatureSources }) {
  const { store, sources } = deps;

  async function render(user: SignatureUser, signature: MailSignature, language: MailTemplateLanguage) {
    const [company, companyFields, logo] = await Promise.all([sources.company(), sources.companyFields(), sources.logo()]);
    return renderSignature({
      user,
      signature,
      company,
      companyFields,
      logo: companyFields.includes("logo") ? signatureLogo(logo) : null,
      language,
    });
  }

  return {
    async get(userId: string): Promise<MailSignature> {
      return decodeMailSignature(await store.get(userId, MAIL_SIGNATURE_SETTING_KEY));
    },

    async save(userId: string, signature: MailSignature): Promise<MailSignature> {
      const fields = new Set(signature.fields);
      const stored: MailSignature = {
        ...signature,
        // The catalog's order, without duplicates.
        fields: MAIL_SIGNATURE_USER_FIELDS.filter((field) => fields.has(field)),
      };
      await store.upsert(userId, MAIL_SIGNATURE_SETTING_KEY, JSON.stringify(stored));
      return stored;
    },

    // A signature not saved yet, as it would look (on or off).
    async preview(user: SignatureUser, signature: MailSignature, language: MailTemplateLanguage) {
      const rendered = await render(user, signature, language);
      return { html: previewHtml(rendered), text: rendered?.text ?? "" };
    },

    // The sender's signature for a send, or null (switched off, nothing in
    // it, or the account is gone).
    async forSending(userId: string, language: MailTemplateLanguage): Promise<RenderedSignature | null> {
      const signature = decodeMailSignature(await store.get(userId, MAIL_SIGNATURE_SETTING_KEY));
      if (!signature.enabled) return null;
      const user = await sources.user(userId);
      if (!user) return null;
      return render(user, signature, language);
    },
  };
}

export type MailSignatureService = ReturnType<typeof createMailSignatureService>;
