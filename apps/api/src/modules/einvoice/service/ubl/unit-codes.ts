// Nav unit code (units.code, free text in the register) ⇒ UN/ECE Recommendation
// 20/21 unit code for InvoicedQuantity/@unitCode (BT-130). Peppol BIS 3 only
// accepts codes from that list (CEN BR-CL-23) — every code below was checked
// against the list in CEN-EN16931-UBL.sch (schematron 1.3.15, 2025-10-16).
//
// The seeded units (migration 0033) are st, kg, g, m, m2, m3, l, tim, förp;
// imports create whatever the source file has, so aliases cover the common
// spellings. Anything unknown — or no unit at all — is C62 ("one"/piece), the
// Peppol-safe default: a wrong but valid code is better than a refused
// document, and the quantity is still right.
export const DEFAULT_UNIT_CODE = "C62";

const UNIT_CODES: Record<string, string> = {
  // pieces
  st: "C62",
  styck: "C62",
  stk: "C62",
  pcs: "C62",
  pc: "C62",
  ea: "C62",
  // mass
  kg: "KGM",
  g: "GRM",
  gram: "GRM",
  ton: "TNE",
  t: "TNE",
  // length / area / volume
  mm: "MMT",
  cm: "CMT",
  m: "MTR",
  km: "KMT",
  m2: "MTK",
  "m²": "MTK",
  kvm: "MTK",
  m3: "MTQ",
  "m³": "MTQ",
  l: "LTR",
  lit: "LTR",
  liter: "LTR",
  ml: "MLT",
  // time
  tim: "HUR",
  h: "HUR",
  timme: "HUR",
  timmar: "HUR",
  min: "MIN",
  dag: "DAY",
  dagar: "DAY",
  // packaging (UN/ECE Rec 21, part of the same Peppol list)
  förp: "XPK",
  forp: "XPK",
  fp: "XPK",
  pkt: "XPK",
  paket: "XPK",
  krt: "XCT",
  kartong: "XCT",
  ctn: "XCT",
  låda: "XBX",
  lada: "XBX",
  box: "XBX",
  pall: "XPX",
  rulle: "XRO",
  rle: "XRO",
  säck: "XSA",
  sack: "XSA",
  par: "PR",
  sats: "SET",
  set: "SET",
  // energy (service rows)
  kwh: "KWH",
};

const normalize = (code: string) => code.trim().toLowerCase();

export function unitCodeFor(navUnit: string | null | undefined): string {
  if (!navUnit) return DEFAULT_UNIT_CODE;
  return UNIT_CODES[normalize(navUnit)] ?? DEFAULT_UNIT_CODE;
}

export function isKnownUnit(navUnit: string | null | undefined): boolean {
  return Boolean(navUnit) && Object.hasOwn(UNIT_CODES, normalize(navUnit!));
}
