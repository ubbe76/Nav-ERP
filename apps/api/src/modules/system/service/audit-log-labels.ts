// Swedish labels for the audit trail's entityType/action vocabulary (see
// CLAUDE.md's "Bindande konventioner" for G1). Deliberately NOT the
// authority on what values exist — every writer across the modules logs its
// own entityType/action strings, and this file only has to keep up well
// enough that the CSV export and (mirrored, see apps/web/lib/types.ts) the
// admin page read nicely. An entry missing here just falls back to its raw
// string — never a hard error — because a new writer landing in another
// module/branch must never break the CSV.
export const AUDIT_ENTITY_TYPE_LABELS: Record<string, string> = {
  // Payroll/timereport/economy (block A/B, the read side's original writers).
  absence: "Frånvaro",
  overtime_disposition: "Övertidsdisposition",
  payroll_period: "Löneperiod",
  payroll_attestation: "Löneattestering",
  attendance_session: "Stämpling",
  time_report: "Tidrapport",
  accounting_period: "Bokföringsperiod",
  verification: "Verifikat",
  // Sales/purchase (G1 Agent 1).
  sales_order: "Kundorder",
  sales_order_row: "Kundorderrad",
  invoice: "Faktura",
  delivery: "Följesedel",
  purchase_order: "Inköpsorder",
  purchase_order_row: "Inköpsorderrad",
  inquiry: "Förfrågan",
  supplier_invoice: "Leverantörsfaktura",
  supplier_payment: "Leverantörsbetalning",
  customer_payment: "Kundbetalning",
  price_list: "Prislista",
  customer_price: "Kundpris",
  // Manufacturing/stock-count/auth/system (G1 Agent 2).
  manufacturing_order: "Tillverkningsorder",
  stock_count_session: "Inventering",
  user: "Användare",
  system_settings: "Inställningar",
  company_info: "Företagsinformation",
  number_series: "Nummerserie",
  // Bankfiler (ISO 20022).
  payment_batch: "Betalfil",
  bank_file: "Bankfil",
  bank_settings: "Bankinställningar",
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  created: "Skapad",
  updated: "Ändrad",
  onboarding_number_series_reviewed: "Nummerserier granskade",
  deleted: "Borttagen",
  set: "Satt",
  cleared: "Rensad",
  attested: "Attesterad",
  unattested: "Attestering borttagen",
  locked: "Låst",
  unlocked: "Upplåst",
  booked: "Bokförd",
  reversal_created: "Omföring skapad",
  paxml_exported: "PAXml-export",
  confirmed: "Bekräftad",
  cancelled: "Avbruten",
  issued: "Utfärdad",
  released: "Frisläppt",
  started: "Startad",
  closed: "Stängd",
  completed: "Färdigrapporterad",
  posted: "Bokförd",
  delivered: "Levererad",
  row_added: "Rad tillagd",
  row_updated: "Rad ändrad",
  row_deleted: "Rad borttagen",
  file_added: "Underlag uppladdat",
  file_deleted: "Underlag borttaget",
  goods_received: "Gods mottaget",
  credit_created: "Kreditfaktura skapad",
  reminder_sent: "Påminnelse skickad",
  logo_updated: "Logotyp uppdaterad",
  sent: "Skickad",
  answered: "Besvarad",
  payment_reference_changed: "Betalningsreferens ändrad",
  exported: "Exporterad",
  items_added: "Poster tillagda",
  item_updated: "Post ändrad",
  item_removed: "Post borttagen",
  item_confirmed: "Post bekräftad",
  item_rejected: "Post avvisad",
  item_returned: "Post returnerad",
  uploaded: "Uppladdad",
  entry_booked: "Post bokförd",
  entry_ignored: "Post markerad som hanterad utanför Nav",
  entry_restored: "Post återställd",
};

export function auditEntityTypeLabel(entityType: string): string {
  return AUDIT_ENTITY_TYPE_LABELS[entityType] ?? entityType;
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}
