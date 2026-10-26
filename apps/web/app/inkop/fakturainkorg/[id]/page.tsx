import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { InvoiceScanReview } from "../../../../components/purchase/InvoiceScanReview";
import { HelpLink } from "../../../../components/ui/HelpLink";
import shellStyles from "../../../../components/AppShell.module.css";
import { apiGet } from "../../../../lib/api";
import type { InvoiceScanDetail } from "../../../../lib/invoiceScan";
import type { PageSearchParams } from "../../../../lib/listQuery";

export default async function InvoiceScanPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const scan = await apiGet<InvoiceScanDetail>(`/api/v1/invoice-scans/${params.id}`, cookieHeader).catch(() => null);
  if (!scan) notFound();

  // Set by Skapa leverantör: the supplier created for this scan.
  const supplierParam = searchParams.supplierId;
  const supplierId = typeof supplierParam === "string" && supplierParam !== "" ? supplierParam : null;

  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{scan.scanNumber}</div>
          <div className={shellStyles.meta}>Fakturainkorg · {scan.filename}</div>
        </div>
        <HelpLink chapter="inkop" anchor="granska-en-faktura" label="Hjälp om att granska en faktura" />
      </div>
      <InvoiceScanReview initial={scan} supplierIdParam={supplierId} />
    </AppShell>
  );
}
