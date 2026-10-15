import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { LegoWorkCentersPageClient } from "../../../components/manufacturing/LegoWorkCentersPageClient";
import { apiGet } from "../../../lib/api";
import type { Paged, Supplier, WorkCenter } from "../../../lib/types";

export default async function LegoWorkCentersPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [workCenters, allWorkCenters, suppliers] = await Promise.all([
    apiGet<WorkCenter[]>("/api/v1/work-centers?type=subcontract", cookieHeader),
    // Unfiltered: the 3-digit code series is shared with machines and
    // personnel, so the form's number hint has to list them all.
    apiGet<WorkCenter[]>("/api/v1/work-centers", cookieHeader),
    // Form dropdown — same ?limit=1000 convention as the order forms.
    apiGet<Paged<Supplier>>("/api/v1/suppliers?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Tillverkning">
      <LegoWorkCentersPageClient workCenters={workCenters} allWorkCenters={allWorkCenters} suppliers={suppliers.rows} />
    </AppShell>
  );
}
