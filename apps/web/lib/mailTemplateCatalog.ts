// E-postmallar (Mina inställningar, 2026-11-13): every document mail's
// default subject and text, the placeholders each document type offers, and
// the one rule that checks and fills them. Pure and import-free on purpose:
// apps/web/lib/mailTemplateCatalog.ts is a byte-for-byte copy (the web cannot
// import @navet/shared), guarded by mail-templates.test.ts — change both.

export const MAIL_TEMPLATE_KINDS = [
  "quote",
  "orderConfirmation",
  "invoice",
  "creditNote",
  "paymentReminder",
  "inquiry",
  "purchaseOrder",
  "deviationCustomer",
  "deviationSupplier",
  "deviationInternal",
] as const;
export type MailTemplateKind = (typeof MAIL_TEMPLATE_KINDS)[number];

export const MAIL_TEMPLATE_KIND_LABELS: Record<MailTemplateKind, string> = {
  quote: "Offert",
  orderConfirmation: "Orderbekräftelse",
  invoice: "Faktura",
  creditNote: "Kreditfaktura",
  paymentReminder: "Betalningspåminnelse",
  inquiry: "Förfrågan",
  purchaseOrder: "Inköpsorder",
  deviationCustomer: "Reklamationsbesked",
  deviationSupplier: "Reklamation till leverantör",
  deviationInternal: "Avvikelserapport",
};

export const MAIL_TEMPLATE_LANGUAGES = ["sv", "en"] as const;
export type MailTemplateLanguage = (typeof MAIL_TEMPLATE_LANGUAGES)[number];
export const MAIL_TEMPLATE_LANGUAGE_LABELS: Record<MailTemplateLanguage, string> = { sv: "Svenska", en: "Engelska" };

// The placeholder names as the user writes them: {nummer}, {avsändare} …
export const MAIL_PLACEHOLDERS = [
  "nummer",
  "avsändare",
  "företag",
  "kund",
  "leverantör",
  "kontakt",
  "belopp",
  "förfallodatum",
  "giltig",
  "leveransdatum",
  "offertnummer",
] as const;
export type MailPlaceholder = (typeof MAIL_PLACEHOLDERS)[number];

export const MAIL_PLACEHOLDER_LABELS: Record<MailPlaceholder, string> = {
  nummer: "Dokumentets nummer",
  avsändare: "Ditt namn",
  företag: "Vårt företagsnamn",
  kund: "Kundens namn",
  leverantör: "Leverantörens namn",
  kontakt: "Er referens",
  belopp: "Belopp med valuta",
  förfallodatum: "Förfallodatum",
  giltig: "Offerten gäller t.o.m.",
  leveransdatum: "Leveransdatum",
  offertnummer: "Offertens nummer",
};

// Which placeholders a document type offers, in the order the editor lists
// them. A template may only use these (unknownMailPlaceholders).
export const MAIL_TEMPLATE_PLACEHOLDERS: Record<MailTemplateKind, readonly MailPlaceholder[]> = {
  quote: ["nummer", "avsändare", "företag", "kund", "kontakt", "belopp", "giltig"],
  orderConfirmation: ["nummer", "avsändare", "företag", "kund", "kontakt", "leveransdatum", "offertnummer"],
  invoice: ["nummer", "avsändare", "företag", "kund", "belopp", "förfallodatum"],
  creditNote: ["nummer", "avsändare", "företag", "kund", "belopp"],
  paymentReminder: ["nummer", "avsändare", "företag", "kund", "belopp", "förfallodatum"],
  inquiry: ["nummer", "avsändare", "företag", "leverantör", "leveransdatum"],
  purchaseOrder: ["nummer", "avsändare", "företag", "leverantör", "kontakt", "leveransdatum"],
  deviationCustomer: ["nummer", "avsändare", "företag", "kund"],
  deviationSupplier: ["nummer", "avsändare", "företag", "leverantör"],
  deviationInternal: ["nummer", "avsändare", "företag"],
};

export interface MailTemplate {
  subject: string;
  body: string;
}

// The send dialogs' limits (sendEmailSchema): Ämne 255, Meddelande 5000.
export const MAIL_SUBJECT_MAX = 255;
export const MAIL_BODY_MAX = 5000;

const sv = (subject: string, text: string): MailTemplate => ({
  subject,
  body: `Hej!\n\n${text}\n\nMed vänliga hälsningar\n{avsändare}`,
});
const en = (subject: string, text: string): MailTemplate => ({
  subject,
  body: `Hello,\n\n${text}\n\nBest regards\n{avsändare}`,
});

// The texts the dialogs had before the templates, with the sender's name
// after the greeting. Used whenever the user has not saved their own.
export const DEFAULT_MAIL_TEMPLATES: Record<MailTemplateKind, Record<MailTemplateLanguage, MailTemplate>> = {
  quote: {
    sv: sv("Offert {nummer}", "Se bifogad offert {nummer}."),
    en: en("Quotation {nummer}", "Please find attached quotation {nummer}."),
  },
  orderConfirmation: {
    sv: sv("Orderbekräftelse {nummer}", "Tack för er order. Se bifogad orderbekräftelse {nummer}."),
    en: en("Order confirmation {nummer}", "Thank you for your order. Please find attached order confirmation {nummer}."),
  },
  invoice: {
    sv: sv("Faktura {nummer}", "Se bifogad faktura {nummer}."),
    en: en("Invoice {nummer}", "Please find attached invoice {nummer}."),
  },
  creditNote: {
    sv: sv("Kreditfaktura {nummer}", "Se bifogad kreditfaktura {nummer}."),
    en: en("Credit note {nummer}", "Please find attached credit note {nummer}."),
  },
  paymentReminder: {
    sv: sv(
      "Betalningspåminnelse faktura {nummer}",
      "Vi har tyvärr ännu inte mottagit betalning för faktura {nummer}. Se bifogad påminnelse."
    ),
    en: en(
      "Payment reminder for invoice {nummer}",
      "We have unfortunately not yet received payment for invoice {nummer}. Please find the reminder attached."
    ),
  },
  inquiry: {
    sv: sv("Förfrågan {nummer}", "Se bifogad förfrågan {nummer}."),
    en: en("Request for quotation {nummer}", "Please find attached request for quotation {nummer}."),
  },
  purchaseOrder: {
    sv: sv("Inköpsorder {nummer}", "Se bifogad inköpsorder {nummer}."),
    en: en("Purchase order {nummer}", "Please find attached purchase order {nummer}."),
  },
  deviationCustomer: {
    sv: sv("Reklamationsbesked {nummer}", "Se bifogat reklamationsbesked {nummer}."),
    en: en("Complaint notice {nummer}", "Please find attached complaint notice {nummer}."),
  },
  deviationSupplier: {
    sv: sv("Reklamation {nummer}", "Se bifogad reklamation {nummer}."),
    en: en("Complaint {nummer}", "Please find attached complaint {nummer}."),
  },
  deviationInternal: {
    sv: sv("Avvikelserapport {nummer}", "Se bifogad avvikelserapport {nummer}."),
    en: en("Deviation report {nummer}", "Please find attached deviation report {nummer}."),
  },
};

// A placeholder as written: {name}, one line, at most 40 characters inside.
const PLACEHOLDER_TOKEN = /\{([^{}\n]{1,40})\}/g;

// The {names} in a text that the document type does not offer, each once in
// the order written — a misspelt {nummmer} is caught when the template is
// saved, never in a sent mail.
export function unknownMailPlaceholders(kind: MailTemplateKind, text: string): string[] {
  const allowed: readonly string[] = MAIL_TEMPLATE_PLACEHOLDERS[kind];
  const unknown: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
    const name = match[1]!;
    if (!allowed.includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

// Fills every known placeholder; a value that is missing or empty becomes
// empty text. A {name} that is not a placeholder at all stays as written.
export function renderMailTemplate(text: string, values: Partial<Record<MailPlaceholder, string | null>>): string {
  const known: readonly string[] = MAIL_PLACEHOLDERS;
  return text.replace(PLACEHOLDER_TOKEN, (token, name: string) =>
    known.includes(name) ? (values[name as MailPlaceholder] ?? "") : token
  );
}
