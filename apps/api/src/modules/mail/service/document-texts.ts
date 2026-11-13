import type { DocumentLanguage } from "@navet/shared";

// Dokument på engelska (#7): every fixed text the customer- and supplier-
// facing documents print, one dictionary per language. Pure leaf — no DB
// imports — read by document-pdf.ts's renderers and by the services that
// compose document texts (the deviation report's labels, the lego reference,
// the generated invoice row texts, the configurator's "Ja").
//
// The SWEDISH dictionary reproduces the strings the documents printed before
// #7 byte for byte: the ~42 pdfText tests are the regression guard and must
// pass unchanged. Change a Swedish string here only when the document is
// MEANT to change. Internal documents (pick list, internal pallet card, TO
// printout, count sheet, reports, payroll) keep their own Swedish literals in
// document-pdf.ts — they never follow a counterparty's language.
//
// Adding a language: extend DOCUMENT_LANGUAGES (shared), the three CHECK
// constraints (customers/suppliers/invoices.language) and this record —
// TypeScript then insists on every key for the new language.

export interface DocumentTexts {
  // Intl locale for amounts/quantities on the document ("1 234,50" vs
  // "1,234.50"). Dates stay ISO in every language.
  locale: string;
  // The Rabatt cell: "10 %" (sv) / "10%" (en); `percent` is already formatted.
  discount: (percent: string) => string;

  titles: {
    quote: string;
    orderConfirmation: string;
    invoice: string;
    creditNote: string;
    inquiry: string;
    purchaseOrder: string;
    deliveryNote: string;
    paymentReminder: (level: number) => string;
  };
  // "<prefix>-<number>.pdf" — Swedish keeps the (partly ASCII-folded) prefixes
  // the routes always produced; the inquiry/PO had no prefix at all.
  filenames: {
    quote: (documentNumber: string) => string;
    orderConfirmation: (documentNumber: string) => string;
    invoice: (documentNumber: string) => string;
    creditNote: (documentNumber: string) => string;
    paymentReminder: (invoiceNumber: string) => string;
    deliveryNote: (deliveryNumber: string) => string;
    palletCard: (reference: string) => string;
    inquiry: (inquiryNumber: string) => string;
    purchaseOrder: (orderNumber: string) => string;
    deviation: (title: string, deviationNumber: string) => string;
  };

  // The grey block label above the address (drawn uppercased).
  partnerLabels: { customer: string; supplier: string; invoiceAddress: string };
  deliveryAddressLabel: string;

  // Meta lines under the title (render()).
  meta: {
    date: string;
    dueDate: string;
    orderNumber: string;
    ourQuote: string;
    customerNumber: string;
    buyerVatNumber: string;
    customerOrderNumber: string;
    customerInquiryNumber: string;
    yourReference: string;
    ourReference: string;
    requestedDeliveryDate: string;
    deliveryDate: string;
    quoteValidUntil: (date: string) => string;
    ourCustomerNumberAtSupplier: string;
    ourSupplierNumberAtCustomer: string;
    // Credit note: which invoice it credits. The Swedish line keeps the
    // "Ordernummer:" prefix the credit note always printed (it reused the
    // orderReference field) — the regression guard; English reads naturally.
    creditsInvoice: (invoiceNumber: string) => string;
  };
  terms: {
    deliveryTerm: string;
    paymentTerm: string;
    carrier: string;
    ourCarrierCustomerNumber: string;
  };
  pricesIncludeVat: string;

  columns: {
    articleNumber: string;
    articleName: string;
    quantity: string;
    unit: string;
    unitPrice: string;
    discount: string;
    amount: string;
  };
  rowInfo: {
    customerArticleNumber: string;
    setupChargeFor: (articleNumber: string) => string;
    delivered: (date: string) => string;
    setupPrice: (amount: string, currency: string) => string;
    netWeight: (kg: string) => string;
    requestedDeliveryDate: string;
    deliveryDate: string;
    // Batch (#8): "Batch: A123 (10), B456 (5)" under a row.
    batch: string;
    // Etapp 2: before a batch's utgångsdatum — "L-778 utg. 2027-03-01 (6)".
    expires: string;
    // "Order KO… · Ert ordernr …" under an invoice row.
    orderReference: (orderNumber: string, customerOrderNumber: string | null) => string;
    // "Ytbehandling: … · Färg: …" and "Rev B · Ritn 4711 rev C".
    surfaceTreatment: string;
    colour: string;
    revision: (revision: string) => string;
    drawing: (drawingNumber: string, revision: string | null) => string;
    // Lego (inquiry/PO): "Lego för PO-2044 · Op 20 · Svetsning".
    legoReference: (orderNumber: string | null, sequenceNo: number, description: string | null) => string;
  };

  totals: {
    amountDue: (currency: string) => string;
    totalInclVat: (currency: string) => string;
    ofWhichVat: string;
    totalExclVat: (currency: string) => string;
    vat: (rate: number) => string;
    // The invoice's VAT line with its beskattningsunderlag: "Moms (25 %) på
    // 200,00" — `label` is vat(rate) or a 0 % code's name, `base` formatted.
    vatOn: (label: string, base: string) => string;
    totalExclUnpriced: (currency: string) => string;
    total: (currency: string) => string;
    vatInSek: (amount: string, rate: string) => string;
  };
  payment: {
    heading: string;
    ocrNumber: string;
    bankgiro: string;
    plusgiro: string;
    dueDate: string;
  };
  footer: {
    orgNumber: string;
    vatNumber: string;
    companySeat: string;
    fSkatt: string;
    bankgiro: string;
    plusgiro: string;
    bank: string;
    iban: string;
    bic: string;
  };
  pageOf: (page: number, pages: number) => string;

  reminder: {
    invoice: (invoiceNumber: string) => string;
    invoiceDate: string;
    dueDate: string;
    body: string;
    grossAmount: (currency: string) => string;
    settled: string;
    fee: string;
  };
  lateInterest: {
    // Under the terms on the invoice and in the reminder.
    terms: string;
    // "Upplupen dröjsmålsränta t.o.m. X: Y kr" (`amount` already formatted).
    accrued: (through: string, amount: string) => string;
    // Row texts on the räntefaktura (stored in invoice_rows.description).
    interestRow: (input: { invoiceNumber: string; from: string; to: string; days: number; rates: string }) => string;
    feeRow: (invoiceNumber: string) => string;
    // "12,00 %" / "10,00/12,00 %" — the distinct rates.
    rates: (rates: readonly number[]) => string;
  };
  // Frakt: "Frakt DHL Paket (FR-2026-12)" (stored in invoice_rows.description).
  freightRow: (name: string | null, shipmentNumber: string) => string;

  deliveryNote: {
    deliveryDate: string;
    undone: (dateTime: string) => string;
    orderNumber: string;
    customer: string;
    customerOrderNumber: string;
    customerReference: string;
    carrier: string;
    trackingNumber: string;
    deliveryAddress: string;
    columns: { article: string; articleName: string; delivered: string; unit: string; priorDelivered: string };
  };

  palletCard: {
    title: string;
    toCustomer: string;
    internal: string;
    articleNumber: string;
    articleName: string;
    quantity: string;
    parcel: (index: number, count: number) => string;
    customer: string;
    deliveryAddress: string;
    customerOrderNumber: string;
    ourOrderNumber: string;
    manufacturingOrder: string;
    nextOperation: string;
    // Pallkort till legoleverantör (kind "subcontract").
    toSubcontractor: string;
    subcontractor: string;
    surfaceTreatment: string;
    colour: string;
    purchaseOrder: string;
    deliverTo: string;
    // The subcontract card's footer names the user who dispatched.
    dispatchedBy: string;
    date: string;
    reportedBy: string;
    reference: string;
    // Batch (#8): the bottom row's last cell.
    batch: string;
  };

  deviation: {
    titles: { supplier: string; customer: string; internal: string };
    number: string;
    date: string;
    partnerLabels: { customer: string; supplier: string };
    references: {
      yourReference: string;
      salesOrder: string;
      customerOrderNumber: string;
      invoice: string;
      purchaseOrder: string;
      manufacturingOrder: string;
    };
    sections: {
      subject: string;
      article: string;
      quantity: string;
      reason: string;
      description: string;
      causeAnalysis: string;
      correctiveAction: string;
      preventiveAction: string;
      decision: string;
    };
    decisions: { accepted: string; rejected: string };
  };

  // Konfigurator: the boolean choice's value ("Ja" — Nej prints nothing).
  configurationYes: string;

  // Names for the countries that occur in the registers; anything else
  // prints as its ISO code. Sweden is never printed (domestic mail).
  countryNames: Record<string, string>;
}

const sv: DocumentTexts = {
  locale: "sv-SE",
  discount: (percent) => `${percent} %`,
  titles: {
    quote: "Offert",
    orderConfirmation: "Orderbekräftelse",
    invoice: "Faktura",
    creditNote: "Kreditfaktura",
    inquiry: "Förfrågan",
    purchaseOrder: "Inköpsorder",
    deliveryNote: "Följesedel",
    paymentReminder: (level) => `Betalningspåminnelse ${level}`,
  },
  filenames: {
    quote: (n) => `Offert-${n}.pdf`,
    orderConfirmation: (n) => `Orderbekraftelse-${n}.pdf`,
    invoice: (n) => `Faktura-${n}.pdf`,
    creditNote: (n) => `Kreditfaktura-${n}.pdf`,
    paymentReminder: (n) => `Betalningspåminnelse-${n}.pdf`,
    deliveryNote: (n) => `foljesedel-${n}.pdf`,
    palletCard: (ref) => `pallkort-${ref}.pdf`,
    inquiry: (n) => `${n}.pdf`,
    purchaseOrder: (n) => `${n}.pdf`,
    deviation: (title, n) => `${title}-${n}.pdf`,
  },
  partnerLabels: { customer: "Kund", supplier: "Leverantör", invoiceAddress: "Fakturaadress" },
  deliveryAddressLabel: "LEVERANSADRESS",
  meta: {
    date: "Datum",
    dueDate: "Förfallodatum",
    orderNumber: "Ordernummer",
    ourQuote: "Vår offert",
    customerNumber: "Kundnr",
    buyerVatNumber: "Ert momsreg.nr",
    customerOrderNumber: "Ert ordernummer",
    customerInquiryNumber: "Er förfrågan",
    yourReference: "Er referens",
    ourReference: "Vår referens",
    requestedDeliveryDate: "Önskat leveransdatum",
    deliveryDate: "Leveransdatum",
    quoteValidUntil: (date) => `Offerten gäller till och med ${date}.`,
    ourCustomerNumberAtSupplier: "Vårt kundnummer hos er",
    ourSupplierNumberAtCustomer: "Vårt leverantörsnr hos er",
    creditsInvoice: (n) => `Ordernummer: Krediterar faktura ${n}`,
  },
  terms: {
    deliveryTerm: "Leveransvillkor",
    paymentTerm: "Betalningsvillkor",
    carrier: "Speditör",
    ourCarrierCustomerNumber: "Vårt kundnr",
  },
  pricesIncludeVat: "Priser inklusive moms",
  columns: {
    articleNumber: "Artikelnummer",
    articleName: "Benämning",
    quantity: "Antal",
    unit: "Enhet",
    unitPrice: "À-pris",
    discount: "Rabatt",
    amount: "Summa",
  },
  rowInfo: {
    customerArticleNumber: "Ert art.nr",
    setupChargeFor: (n) => `Ställkostnad för ${n}`,
    delivered: (date) => `Levererad ${date}`,
    setupPrice: (amount, currency) => `Ställpris: ${amount} ${currency}`,
    netWeight: (kg) => `Nettovikt: ${kg} kg`,
    requestedDeliveryDate: "Önskat leveransdatum",
    deliveryDate: "Leveransdatum",
    batch: "Batch",
    expires: "utg.",
    orderReference: (orderNumber, customerOrderNumber) =>
      `Order ${orderNumber}${customerOrderNumber ? ` · Ert ordernr ${customerOrderNumber}` : ""}`,
    surfaceTreatment: "Ytbehandling",
    colour: "Färg",
    revision: (rev) => `Rev ${rev}`,
    drawing: (number, rev) => (rev ? `Ritn ${number} rev ${rev}` : `Ritn ${number}`),
    legoReference: (orderNumber, sequenceNo, description) => {
      const operation = description ? `Op ${sequenceNo} · ${description}` : `Op ${sequenceNo}`;
      return orderNumber ? `Lego för ${orderNumber} · ${operation}` : `Lego · ${operation}`;
    },
  },
  totals: {
    amountDue: (cur) => `Att betala ${cur}`,
    totalInclVat: (cur) => `Summa inkl. moms ${cur}`,
    ofWhichVat: "Varav moms",
    totalExclVat: (cur) => `Summa exkl. moms ${cur}`,
    vat: (rate) => `Moms (${rate} %)`,
    vatOn: (label, base) => `${label} på ${base}`,
    totalExclUnpriced: (cur) => `Summa (exkl. rader utan pris) ${cur}`,
    total: (cur) => `Summa ${cur}`,
    vatInSek: (amount, rate) => `Moms i SEK: ${amount} (kurs ${rate})`,
  },
  payment: {
    heading: "BETALNING",
    ocrNumber: "OCR-nummer",
    bankgiro: "Bankgiro",
    plusgiro: "Plusgiro",
    dueDate: "Förfallodatum",
  },
  footer: {
    orgNumber: "Org.nr",
    vatNumber: "VAT-nr",
    companySeat: "Säte",
    fSkatt: "Godkänd för F-skatt",
    bankgiro: "Bankgiro",
    plusgiro: "Plusgiro",
    bank: "Bank",
    iban: "IBAN",
    bic: "BIC",
  },
  pageOf: (page, pages) => `Sida ${page} av ${pages}`,
  reminder: {
    invoice: (n) => `Faktura ${n}`,
    invoiceDate: "Fakturadatum",
    dueDate: "Förfallodatum",
    body: "Vi kan inte se att nedanstående faktura har betalats. Vänligen betala snarast.",
    grossAmount: (cur) => `Fakturabelopp inkl. moms ${cur}`,
    settled: "Betalt/krediterat",
    fee: "Påminnelseavgift",
  },
  lateInterest: {
    terms: "Vid betalning efter förfallodagen debiteras dröjsmålsränta enligt räntelagen.",
    accrued: (through, amount) => `Upplupen dröjsmålsränta t.o.m. ${through}: ${amount} kr`,
    interestRow: ({ invoiceNumber, from, to, days, rates }) =>
      `Dröjsmålsränta ${invoiceNumber}, ${from}–${to} (${days} ${days === 1 ? "dag" : "dagar"}, ${rates})`,
    feeRow: (n) => `Förseningsersättning ${n}`,
    rates: (rates) => `${[...new Set(rates)].map((rate) => rate.toFixed(2).replace(".", ",")).join("/")} %`,
  },
  freightRow: (name, shipmentNumber) => `Frakt ${name ? `${name} ` : ""}(${shipmentNumber})`,
  deliveryNote: {
    deliveryDate: "Leveransdatum",
    undone: (dt) => `Ångrad ${dt}`,
    orderNumber: "Ordernummer",
    customer: "Kund",
    customerOrderNumber: "Ert ordernummer",
    customerReference: "Er referens",
    carrier: "Transportör",
    trackingNumber: "Fraktsedelsnr",
    deliveryAddress: "Leveransadress",
    columns: { article: "Artikel", articleName: "Benämning", delivered: "Levererat", unit: "Enhet", priorDelivered: "Tidigare levererat" },
  },
  palletCard: {
    title: "PALLKORT",
    toCustomer: "TILL KUND",
    internal: "INTERNT",
    articleNumber: "ARTIKELNUMMER",
    articleName: "BENÄMNING",
    quantity: "ANTAL",
    parcel: (index, count) => `Kolli ${index} av ${count}`,
    customer: "KUND",
    deliveryAddress: "LEVERANSADRESS",
    customerOrderNumber: "KUNDENS ORDERNUMMER",
    ourOrderNumber: "VÅRT KUNDORDERNUMMER",
    manufacturingOrder: "TILLVERKNINGSORDER",
    nextOperation: "NÄSTA OPERATION",
    toSubcontractor: "TILL LEGOLEVERANTÖR",
    subcontractor: "LEGOLEVERANTÖR",
    surfaceTreatment: "YTBEHANDLING",
    colour: "FÄRG",
    purchaseOrder: "INKÖPSORDER",
    deliverTo: "FÄRDIGT GODS LEVERERAS TILL",
    dispatchedBy: "SKICKAT AV",
    date: "DATUM",
    reportedBy: "RAPPORTERAD AV",
    reference: "REFERENS",
    batch: "BATCH",
  },
  deviation: {
    titles: { supplier: "Reklamation", customer: "Reklamationsbesked", internal: "Avvikelserapport" },
    number: "Nummer",
    date: "Datum",
    partnerLabels: { customer: "KUND", supplier: "LEVERANTÖR" },
    references: {
      yourReference: "Er referens",
      salesOrder: "Kundorder",
      customerOrderNumber: "Ert ordernr",
      invoice: "Faktura",
      purchaseOrder: "Inköpsorder",
      manufacturingOrder: "Tillverkningsorder",
    },
    sections: {
      subject: "Ärende",
      article: "Artikel",
      quantity: "Antal",
      reason: "Orsak",
      description: "Beskrivning",
      causeAnalysis: "Orsaksanalys",
      correctiveAction: "Åtgärd",
      preventiveAction: "Förebyggande åtgärd",
      decision: "Beslut",
    },
    decisions: { accepted: "Godkänd", rejected: "Avslagen" },
  },
  configurationYes: "Ja",
  countryNames: {
    DK: "Danmark",
    NO: "Norge",
    FI: "Finland",
    DE: "Tyskland",
    PL: "Polen",
    IT: "Italien",
    EE: "Estland",
    LV: "Lettland",
    LT: "Litauen",
    NL: "Nederländerna",
    BE: "Belgien",
    FR: "Frankrike",
    ES: "Spanien",
    GB: "Storbritannien",
    US: "USA",
  },
};

const en: DocumentTexts = {
  locale: "en-GB",
  discount: (percent) => `${percent}%`,
  titles: {
    quote: "Quotation",
    orderConfirmation: "Order confirmation",
    invoice: "Invoice",
    creditNote: "Credit note",
    inquiry: "Request for quotation",
    purchaseOrder: "Purchase order",
    deliveryNote: "Delivery note",
    paymentReminder: (level) => `Payment reminder ${level}`,
  },
  filenames: {
    quote: (n) => `Quotation-${n}.pdf`,
    orderConfirmation: (n) => `Order-confirmation-${n}.pdf`,
    invoice: (n) => `Invoice-${n}.pdf`,
    creditNote: (n) => `Credit-note-${n}.pdf`,
    paymentReminder: (n) => `Payment-reminder-${n}.pdf`,
    deliveryNote: (n) => `Delivery-note-${n}.pdf`,
    palletCard: (ref) => `Pallet-card-${ref}.pdf`,
    inquiry: (n) => `Request-for-quotation-${n}.pdf`,
    purchaseOrder: (n) => `Purchase-order-${n}.pdf`,
    deviation: (title, n) => `${title.replace(/ /g, "-")}-${n}.pdf`,
  },
  partnerLabels: { customer: "Customer", supplier: "Supplier", invoiceAddress: "Invoice address" },
  deliveryAddressLabel: "DELIVERY ADDRESS",
  meta: {
    date: "Date",
    dueDate: "Due date",
    orderNumber: "Order number",
    ourQuote: "Our quotation",
    customerNumber: "Customer no.",
    buyerVatNumber: "Your VAT no.",
    customerOrderNumber: "Your order number",
    customerInquiryNumber: "Your inquiry",
    yourReference: "Your reference",
    ourReference: "Our reference",
    requestedDeliveryDate: "Requested delivery date",
    deliveryDate: "Delivery date",
    quoteValidUntil: (date) => `This quotation is valid until ${date}.`,
    ourCustomerNumberAtSupplier: "Our customer number with you",
    ourSupplierNumberAtCustomer: "Our supplier number with you",
    creditsInvoice: (n) => `Credit note for invoice ${n}`,
  },
  terms: {
    deliveryTerm: "Delivery terms",
    paymentTerm: "Payment terms",
    carrier: "Carrier",
    ourCarrierCustomerNumber: "Our customer no.",
  },
  pricesIncludeVat: "Prices include VAT",
  columns: {
    articleNumber: "Item no.",
    articleName: "Description",
    quantity: "Qty",
    unit: "Unit",
    unitPrice: "Unit price",
    discount: "Discount",
    amount: "Amount",
  },
  rowInfo: {
    customerArticleNumber: "Your item no.",
    setupChargeFor: (n) => `Setup charge for ${n}`,
    delivered: (date) => `Delivered ${date}`,
    setupPrice: (amount, currency) => `Setup price: ${amount} ${currency}`,
    netWeight: (kg) => `Net weight: ${kg} kg`,
    requestedDeliveryDate: "Requested delivery date",
    deliveryDate: "Delivery date",
    batch: "Batch",
    expires: "exp.",
    orderReference: (orderNumber, customerOrderNumber) =>
      `Order ${orderNumber}${customerOrderNumber ? ` · Your order no. ${customerOrderNumber}` : ""}`,
    surfaceTreatment: "Surface treatment",
    colour: "Colour",
    revision: (rev) => `Rev ${rev}`,
    drawing: (number, rev) => (rev ? `Drawing ${number} rev ${rev}` : `Drawing ${number}`),
    legoReference: (orderNumber, sequenceNo, description) => {
      const operation = description ? `Op ${sequenceNo} · ${description}` : `Op ${sequenceNo}`;
      return orderNumber ? `Subcontracting for ${orderNumber} · ${operation}` : `Subcontracting · ${operation}`;
    },
  },
  totals: {
    amountDue: (cur) => `Amount due ${cur}`,
    totalInclVat: (cur) => `Total incl. VAT ${cur}`,
    ofWhichVat: "Of which VAT",
    totalExclVat: (cur) => `Total excl. VAT ${cur}`,
    vat: (rate) => `VAT (${rate}%)`,
    vatOn: (label, base) => `${label} on ${base}`,
    totalExclUnpriced: (cur) => `Total (excl. unpriced rows) ${cur}`,
    total: (cur) => `Total ${cur}`,
    vatInSek: (amount, rate) => `VAT in SEK: ${amount} (rate ${rate})`,
  },
  payment: {
    heading: "PAYMENT",
    ocrNumber: "OCR number",
    bankgiro: "Bankgiro",
    plusgiro: "Plusgiro",
    dueDate: "Due date",
  },
  footer: {
    orgNumber: "Reg. no",
    vatNumber: "VAT no",
    companySeat: "Registered office",
    fSkatt: "Approved for F-tax",
    bankgiro: "Bankgiro",
    plusgiro: "Plusgiro",
    bank: "Bank",
    iban: "IBAN",
    bic: "BIC",
  },
  pageOf: (page, pages) => `Page ${page} of ${pages}`,
  reminder: {
    invoice: (n) => `Invoice ${n}`,
    invoiceDate: "Invoice date",
    dueDate: "Due date",
    body: "According to our records, the invoice below has not been paid. Please pay at your earliest convenience.",
    grossAmount: (cur) => `Invoice amount incl. VAT ${cur}`,
    settled: "Paid/credited",
    fee: "Reminder fee",
  },
  lateInterest: {
    terms: "Interest on late payment is charged in accordance with the Swedish Interest Act (räntelagen).",
    accrued: (through, amount) => `Accrued interest on late payment through ${through}: ${amount} SEK`,
    interestRow: ({ invoiceNumber, from, to, days, rates }) =>
      `Interest on late payment ${invoiceNumber}, ${from}–${to} (${days} ${days === 1 ? "day" : "days"}, ${rates})`,
    feeRow: (n) => `Late payment compensation ${n}`,
    rates: (rates) => `${[...new Set(rates)].map((rate) => rate.toFixed(2)).join("/")}%`,
  },
  freightRow: (name, shipmentNumber) => `Freight ${name ? `${name} ` : ""}(${shipmentNumber})`,
  deliveryNote: {
    deliveryDate: "Delivery date",
    undone: (dt) => `Reversed ${dt}`,
    orderNumber: "Order number",
    customer: "Customer",
    customerOrderNumber: "Your order number",
    customerReference: "Your reference",
    carrier: "Carrier",
    trackingNumber: "Tracking no.",
    deliveryAddress: "Delivery address",
    columns: { article: "Item", articleName: "Description", delivered: "Delivered", unit: "Unit", priorDelivered: "Prev. delivered" },
  },
  palletCard: {
    title: "PALLET CARD",
    toCustomer: "TO CUSTOMER",
    internal: "INTERNAL",
    articleNumber: "ITEM NO.",
    articleName: "DESCRIPTION",
    quantity: "QUANTITY",
    parcel: (index, count) => `Parcel ${index} of ${count}`,
    customer: "CUSTOMER",
    deliveryAddress: "DELIVERY ADDRESS",
    customerOrderNumber: "CUSTOMER'S ORDER NUMBER",
    ourOrderNumber: "OUR ORDER NUMBER",
    manufacturingOrder: "MANUFACTURING ORDER",
    nextOperation: "NEXT OPERATION",
    toSubcontractor: "TO SUBCONTRACTOR",
    subcontractor: "SUBCONTRACTOR",
    surfaceTreatment: "SURFACE TREATMENT",
    colour: "COLOUR",
    purchaseOrder: "PURCHASE ORDER",
    deliverTo: "DELIVER FINISHED GOODS TO",
    dispatchedBy: "DISPATCHED BY",
    date: "DATE",
    reportedBy: "REPORTED BY",
    reference: "REFERENCE",
    batch: "BATCH NO.",
  },
  deviation: {
    titles: { supplier: "Complaint", customer: "Complaint notice", internal: "Deviation report" },
    number: "Number",
    date: "Date",
    partnerLabels: { customer: "CUSTOMER", supplier: "SUPPLIER" },
    references: {
      yourReference: "Your reference",
      salesOrder: "Sales order",
      customerOrderNumber: "Your order no.",
      invoice: "Invoice",
      purchaseOrder: "Purchase order",
      manufacturingOrder: "Manufacturing order",
    },
    sections: {
      subject: "Subject",
      article: "Item",
      quantity: "Quantity",
      reason: "Reason",
      description: "Description",
      causeAnalysis: "Root cause analysis",
      correctiveAction: "Corrective action",
      preventiveAction: "Preventive action",
      decision: "Decision",
    },
    decisions: { accepted: "Accepted", rejected: "Rejected" },
  },
  configurationYes: "Yes",
  countryNames: {
    DK: "Denmark",
    NO: "Norway",
    FI: "Finland",
    DE: "Germany",
    PL: "Poland",
    IT: "Italy",
    EE: "Estonia",
    LV: "Latvia",
    LT: "Lithuania",
    NL: "Netherlands",
    BE: "Belgium",
    FR: "France",
    ES: "Spain",
    GB: "United Kingdom",
    US: "USA",
  },
};

export const DOCUMENT_TEXTS: Record<DocumentLanguage, DocumentTexts> = { sv, en };

// The dictionary of a document — `language` is the counterparty's/invoice's
// language already resolved through documentLanguageOf (never a raw column).
export function documentTexts(language: DocumentLanguage): DocumentTexts {
  return DOCUMENT_TEXTS[language];
}
