// Kopiera till kund / Kopiera till leverantör (packages/shared/src/partner-copy.ts):
// the card button's texts and how its dialog warns about a partner that
// already exists on the other side. The warning never stops the copy — the
// same company may on purpose be two customers (two sites).
export type PartnerSide = "customer" | "supplier";

interface CopyTarget {
  // The card the button is on copies TO the other side.
  buttonLabel: string;
  title: string;
  numberLabel: string;
  submitLabel: string;
  sourceNoun: string;
  targetNoun: string;
  listEndpoint: string;
  createEndpoint: string;
  cardHref: (id: string) => string;
}

// Keyed by the SOURCE card's side.
export const PARTNER_COPY_TARGET: Record<PartnerSide, CopyTarget> = {
  supplier: {
    buttonLabel: "Kopiera till kund",
    title: "Kopiera till kund",
    numberLabel: "Kundnummer",
    submitLabel: "Skapa kund",
    sourceNoun: "leverantörens",
    targetNoun: "kund",
    listEndpoint: "/api/v1/customers",
    createEndpoint: "/api/v1/customers/from-supplier",
    cardHref: (id) => `/kunder/${id}`,
  },
  customer: {
    buttonLabel: "Kopiera till leverantör",
    title: "Kopiera till leverantör",
    numberLabel: "Leverantörsnummer",
    submitLabel: "Skapa leverantör",
    sourceNoun: "kundens",
    targetNoun: "leverantör",
    listEndpoint: "/api/v1/suppliers",
    createEndpoint: "/api/v1/suppliers/from-customer",
    cardHref: (id) => `/leverantorer/${id}`,
  },
};

// The POST body: the source's id under its own name, the number only when typed.
export function partnerCopyBody(side: PartnerSide, sourceId: string, number: string) {
  const typed = number.trim() === "" ? {} : side === "supplier" ? { customerNumber: number.trim() } : { supplierNumber: number.trim() };
  return side === "supplier" ? { supplierId: sourceId, ...typed } : { customerId: sourceId, ...typed };
}

export interface PartnerIdentity {
  name: string;
  orgNumber: string | null;
}

export interface ExistingPartner extends PartnerIdentity {
  id: string;
  number: string;
}

const digits = (value: string | null) => (value ?? "").replace(/\D/g, "");
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLocaleLowerCase("sv") === b.trim().replace(/\s+/g, " ").toLocaleLowerCase("sv");

// The list searches the dialog runs: the organisationsnummer (the lists
// search it) and the name.
export function duplicateSearchTerms(source: PartnerIdentity): string[] {
  const terms = [source.orgNumber?.trim() ?? "", source.name.trim()].filter((t) => t !== "");
  return [...new Set(terms)];
}

// Who on the other side is probably the same company: the same
// organisationsnummer (digits only, 556000-0000 = 5560000000) or the same
// name (case and spaces aside). Each once, in the order found.
export function likelyDuplicates(source: PartnerIdentity, candidates: ExistingPartner[]): Array<ExistingPartner & { reason: "org" | "name" }> {
  const org = digits(source.orgNumber);
  const seen = new Set<string>();
  const result: Array<ExistingPartner & { reason: "org" | "name" }> = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    const reason = org !== "" && digits(c.orgNumber) === org ? "org" : sameName(c.name, source.name) ? "name" : null;
    if (reason === null) continue;
    seen.add(c.id);
    result.push({ ...c, reason });
  }
  return result;
}
