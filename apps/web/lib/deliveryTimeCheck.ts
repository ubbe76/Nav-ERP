import { apiFetch } from "./api";
import type { DeliveryTimeCheckResult, DtcStep } from "./types";

export interface DeliveryTimeCheckRequest {
  customerId?: string;
  salesOrderId?: string;
  rows?: {
    articleId: string;
    quantity: number;
    configuration?: { selection: Record<string, string | number | boolean | null> };
  }[];
}

export function runDeliveryTimeCheck(body: DeliveryTimeCheckRequest): Promise<DeliveryTimeCheckResult> {
  return apiFetch<DeliveryTimeCheckResult>("/api/v1/delivery-time-check", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ISO 8601 week number of a YYYY-MM-DD date (the API sends Mondays). Pure
// UTC arithmetic so the browser's timezone never shifts the day.
export function isoWeekNumber(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  // Thursday of the same week decides the ISO year.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

const QUANTITY = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 4 });
export const formatDtcQuantity = (value: number): string => QUANTITY.format(value);

// The chain step as one line of text. The wording is quoted verbatim by the
// manual (Leveranstidskontroll) — change both together.
export function formatDtcStep(step: DtcStep): string {
  switch (step.kind) {
    case "stock":
      return `Lagersaldo — ${formatDtcQuantity(step.quantity)} st ${step.articleNumber}`;
    case "supply": {
      const flags = [step.late ? "försenad" : null, step.isDraft ? "utkast" : null].filter(Boolean);
      const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      return `${step.articleNumber}: ${step.documentNumber} ${step.undated ? "(utan datum)" : step.date}${suffix}`;
    }
    case "purchase": {
      const supplier = step.supplierName ?? "ingen huvudleverantör";
      const lead = step.leadTimeDays === null ? "" : `, ledtid ${step.leadTimeDays} dagar`;
      return `Köps ${formatDtcQuantity(step.quantity)} ${step.articleNumber} — ankomst ${step.date} (${supplier}${lead})`;
    }
    case "operation": {
      const from = isoWeekNumber(step.fromWeek);
      const to = isoWeekNumber(step.toWeek);
      const weeks = step.fromWeek === step.toWeek ? `vecka ${from}` : `vecka ${from}–${to}`;
      return `${step.articleNumber} op ${step.sequenceNo}${step.description ? ` ${step.description}` : ""} — ${step.workCenterName} (${step.workCenterCode}), ${weeks}, klar ${step.date}`;
    }
    case "subcontract": {
      const days = step.leadTimeDays === null ? "" : ` ${step.leadTimeDays} dagar,`;
      return `${step.articleNumber} op ${step.sequenceNo}${step.description ? ` ${step.description}` : ""} — lego ${step.workCenterName} (${step.workCenterCode}),${days} klar ${step.date}`;
    }
  }
}
