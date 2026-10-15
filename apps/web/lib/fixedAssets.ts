// Mirror of @navet/shared's fixed-asset labels (the web cannot import
// @navet/shared — Turbopack vs .js-suffix imports). Kept in sync by
// apps/api/test/fixed-asset.shared.test.ts.
export type FixedAssetStatus = "active" | "disposed";
export type FixedAssetDisposalType = "sale" | "scrap";

export const FIXED_ASSET_STATUS_LABELS: Record<FixedAssetStatus, string> = {
  active: "Aktiv",
  disposed: "Avyttrad",
};

export const FIXED_ASSET_DISPOSAL_TYPE_LABELS: Record<FixedAssetDisposalType, string> = {
  sale: "Försäljning",
  scrap: "Utrangering",
};

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

// "2026-06" -> "Juni 2026" (same wording as Räkenskapsår's period table).
export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const name = MONTHS[Number(month) - 1] ?? month;
  return `${name!.charAt(0).toUpperCase()}${name!.slice(1)} ${year}`;
}

// Innevarande månad i Stockholm som "YYYY-MM" — the month input's max.
export function currentMonthKey(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date()).slice(0, 7);
}

// The register list's URL → API status filter: no parameter means the
// default view Aktiva, "all" means no filter, anything else passes through
// (the API's zod rejects unknown values). Kept out of page.tsx so the
// contract is testable (fixed-asset.shared.test.ts).
export function fixedAssetListStatus(param: string | string[] | undefined): string {
  if (param === undefined) return "active";
  if (param === "all") return "";
  return Array.isArray(param) ? (param[0] ?? "") : param;
}
