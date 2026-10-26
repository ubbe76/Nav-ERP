import { headers } from "next/headers";
import { apiGet } from "../../lib/api";
import {
  newDeviationHref,
  type DeviationListRow,
  type NewDeviationParams,
} from "../../lib/quality";
import type { Paged } from "../../lib/types";
import { DeviationsSectionView } from "./DeviationsSectionView";

// The filters GET /deviations accepts that a document or partner card uses.
export type DeviationsSectionFilter = Partial<
  Record<"salesOrderId" | "invoiceId" | "purchaseOrderId" | "manufacturingOrderId" | "customerId" | "supplierId", string>
>;

// "Avvikelser" on a document/partner card: the cases pointing at it (through
// the case's own columns) and the button that opens Ny avvikelse prefilled
// from the card. Renders nothing for a user who can neither see nor add one.
export async function DeviationsSection({
  filter,
  newDeviation,
  buttonLabel,
}: {
  filter: DeviationsSectionFilter;
  // What Ny avvikelse is prefilled with (type + the document's ids).
  newDeviation: NewDeviationParams;
  // "Ny reklamation" on customer documents, "Ny avvikelse" elsewhere.
  buttonLabel: string;
}) {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const qs = new URLSearchParams({ status: "all", limit: "10", ...filter });
  const list = await apiGet<Paged<DeviationListRow>>(`/api/v1/deviations?${qs.toString()}`, cookieHeader).catch(() => null);
  if (!list) return null;
  const allQs = new URLSearchParams({ status: "all", ...filter });

  return (
    <DeviationsSectionView
      rows={list.rows}
      total={list.total}
      newHref={newDeviationHref(newDeviation)}
      buttonLabel={buttonLabel}
      allHref={`/kvalitet/avvikelser?${allQs.toString()}`}
    />
  );
}
