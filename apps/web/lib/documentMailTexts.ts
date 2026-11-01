import type { DocumentLanguage } from "./documentLanguage";

// Dokument på engelska (#7): the default subject and body of every document
// mail, on the document's language. Pure — no DOM, no fetch. The Swedish
// output is exactly what the pages used to hard-code (the regression guard);
// English is the same wording.
export type DocumentMailKind =
  | { kind: "quote"; number: string }
  // quoteNumber set = the confirmation of a quote that has no KO number yet
  // ("… for quotation OF100").
  | { kind: "orderConfirmation"; number: string; quoteNumber?: string | null }
  | { kind: "legacyInvoice"; number: string }
  | { kind: "invoice"; number: string }
  | { kind: "creditNote"; number: string }
  | { kind: "paymentReminder"; number: string }
  | { kind: "inquiry"; number: string }
  | { kind: "purchaseOrder"; number: string }
  | { kind: "deviation"; number: string; deviationType: "customer" | "supplier" | "internal" };

export interface DocumentMailTexts {
  subject: string;
  body: string;
}

const SV_DEVIATION_TITLE = { customer: "Reklamationsbesked", supplier: "Reklamation", internal: "Avvikelserapport" } as const;
const EN_DEVIATION_TITLE = { customer: "Complaint notice", supplier: "Complaint", internal: "Deviation report" } as const;

function swedish(doc: DocumentMailKind): DocumentMailTexts {
  const wrap = (text: string) => `Hej!\n\n${text}\n\nMed vänliga hälsningar`;
  const attached = (noun: string, number: string) => wrap(`Se bifogad ${noun} ${number}.`);
  switch (doc.kind) {
    case "quote":
      return { subject: `Offert ${doc.number}`, body: attached("offert", doc.number) };
    case "orderConfirmation":
      return doc.quoteNumber
        ? {
            subject: `Orderbekräftelse för offert ${doc.quoteNumber}`,
            body: wrap(`Tack för er order. Se bifogad orderbekräftelse för vår offert ${doc.quoteNumber}.`),
          }
        : {
            subject: `Orderbekräftelse ${doc.number}`,
            body: wrap(`Tack för er order. Se bifogad orderbekräftelse ${doc.number}.`),
          };
    case "legacyInvoice":
    case "invoice":
      return { subject: `Faktura ${doc.number}`, body: attached("faktura", doc.number) };
    case "creditNote":
      return { subject: `Kreditfaktura ${doc.number}`, body: attached("kreditfaktura", doc.number) };
    case "paymentReminder":
      return {
        subject: `Betalningspåminnelse faktura ${doc.number}`,
        body: wrap(`Vi har tyvärr ännu inte mottagit betalning för faktura ${doc.number}. Se bifogad påminnelse.`),
      };
    case "inquiry":
      return { subject: `Förfrågan ${doc.number}`, body: attached("förfrågan", doc.number) };
    case "purchaseOrder":
      return { subject: `Inköpsorder ${doc.number}`, body: attached("inköpsorder", doc.number) };
    case "deviation": {
      const title = SV_DEVIATION_TITLE[doc.deviationType];
      return { subject: `${title} ${doc.number}`, body: wrap(`Se bifogat ${title.toLowerCase()} ${doc.number}.`) };
    }
  }
}

function english(doc: DocumentMailKind): DocumentMailTexts {
  const wrap = (text: string) => `Hello,\n\n${text}\n\nBest regards`;
  const attached = (noun: string, number: string) => wrap(`Please find attached ${noun} ${number}.`);
  switch (doc.kind) {
    case "quote":
      return { subject: `Quotation ${doc.number}`, body: attached("quotation", doc.number) };
    case "orderConfirmation":
      return doc.quoteNumber
        ? {
            subject: `Order confirmation for quotation ${doc.quoteNumber}`,
            body: wrap(`Thank you for your order. Please find attached the order confirmation for our quotation ${doc.quoteNumber}.`),
          }
        : {
            subject: `Order confirmation ${doc.number}`,
            body: wrap(`Thank you for your order. Please find attached order confirmation ${doc.number}.`),
          };
    case "legacyInvoice":
    case "invoice":
      return { subject: `Invoice ${doc.number}`, body: attached("invoice", doc.number) };
    case "creditNote":
      return { subject: `Credit note ${doc.number}`, body: attached("credit note", doc.number) };
    case "paymentReminder":
      return {
        subject: `Payment reminder for invoice ${doc.number}`,
        body: wrap(`We have unfortunately not yet received payment for invoice ${doc.number}. Please find the reminder attached.`),
      };
    case "inquiry":
      return { subject: `Request for quotation ${doc.number}`, body: attached("request for quotation", doc.number) };
    case "purchaseOrder":
      return { subject: `Purchase order ${doc.number}`, body: attached("purchase order", doc.number) };
    case "deviation": {
      const title = EN_DEVIATION_TITLE[doc.deviationType];
      return { subject: `${title} ${doc.number}`, body: attached(title.toLowerCase(), doc.number) };
    }
  }
}

export function documentMailTexts(doc: DocumentMailKind, language: DocumentLanguage): DocumentMailTexts {
  return language === "en" ? english(doc) : swedish(doc);
}
