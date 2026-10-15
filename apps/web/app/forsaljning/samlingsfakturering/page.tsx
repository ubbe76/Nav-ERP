import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { CollectiveInvoicingClient } from "../../../components/sales/CollectiveInvoicingClient";
import { apiGet } from "../../../lib/api";
import type { CollectiveInvoicingCandidate } from "../../../lib/types";

export default async function SamlingsfaktureringPage(props: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const candidates = await apiGet<CollectiveInvoicingCandidate[]>(
    "/api/v1/collective-invoicing/candidates",
    cookieHeader
  );
  const preselectCustomerId = typeof searchParams.customerId === "string" ? searchParams.customerId : undefined;

  return (
    <AppShell active="Försäljning">
      <CollectiveInvoicingClient initialCandidates={candidates} preselectCustomerId={preselectCustomerId} />
    </AppShell>
  );
}
