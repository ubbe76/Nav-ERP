"use client";

import { useRouter } from "next/navigation";
import { ScanPanel } from "../ui/ScanInput";
import { useScanFeedback, useScanQueue } from "../ui/useOrderScan";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { resolveCountScan } from "../../lib/countScan";
import type { Paged, ScanMatch, StockCountSession } from "../../lib/types";

type LocationMatch = Extract<ScanMatch, { kind: "location" }>;

// Where a scanned lagerplats leads: its open count, or Ny inventering with
// the place chosen (spärr and anteckning are picked there, as without a
// scanner). An inactive place holds nothing to count — null, the caller
// says so.
export async function locationCountHref(location: LocationMatch): Promise<string | null> {
  const open = await apiFetch<Paged<StockCountSession>>(
    `/api/v1/stock-counts?locationId=${location.id}&status=open&limit=1`
  );
  if (open.rows[0]) return `/lager/inventering/${open.rows[0].id}`;
  return location.active ? `/lager/inventering/ny?location=${location.id}` : null;
}

export const ORDER_KIND_LABEL: Record<string, string> = {
  purchaseOrder: "en inköpsorder",
  salesOrder: "en kundorder",
  manufacturingOrder: "en tillverkningsorder",
};

// Lager → Inventering (#4, etapp 4): scan a lagerplats label to open — or
// start — that place's count.
export function StockCountScanPanel() {
  const router = useRouter();
  const { feedback, ok, warn } = useScanFeedback();

  const onScan = useScanQueue(async (code, matches) => {
    const intent = resolveCountScan(matches, null);
    switch (intent.kind) {
      case "thisLocation":
      case "otherLocation": {
        const m = intent.match;
        let href: string | null;
        try {
          href = await locationCountHref(m);
        } catch (err) {
          warn(apiErrorMessage(err, "Kunde inte hämta inventeringarna"));
          return;
        }
        if (!href) {
          warn(`${m.warehouseName} — ${m.name} är inaktiv och har inget saldo att inventera`);
          return;
        }
        ok(`${m.warehouseName} — ${m.name}`);
        router.push(href);
        return;
      }
      case "articleNotCounting":
      case "row":
      case "addArticle":
        warn(`Skanna lagerplatsens etikett först — ${code} är en artikel`);
        return;
      case "order":
        warn(`${code} är ${ORDER_KIND_LABEL[intent.match.kind]} — skanna lagerplatsens etikett`);
        return;
      case "unknown":
        warn(`Ingen träff för ${code}`);
        return;
    }
  }, warn);

  return <ScanPanel placeholder="Skanna lagerplatsens etikett…" onScan={onScan} feedback={feedback} />;
}
