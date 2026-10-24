import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { SupplierInvoiceCard } from "../../../../components/purchase/SupplierInvoiceCard";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { canOpen } from "../../../../lib/pageAccess";
import type { SupplierInvoiceDetail } from "../../../../lib/types";
import type { VatCodeView } from "../../../../lib/vatCodes";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function SupplierInvoiceDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const invoice = await apiGet<SupplierInvoiceDetail>(
    `/api/v1/supplier-invoices/${params.id}`,
    cookieHeader
  ).catch(() => null);
  if (!invoice) notFound();

  // The current user decides whether the Verifikat link is rendered at all —
  // /ekonomi/verifikat/… is admin-only, both as a page and in the API (same
  // idiom as the customer invoice card).
  const user = await getCurrentUser(cookieHeader);
  // Momskoder: the header's and the rows' Momskod selects. A failed read
  // leaves the invoice's own codes in place.
  const vatCodes = await apiGet<VatCodeView[]>("/api/v1/vat-codes", cookieHeader).catch(() => [] as VatCodeView[]);

  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{invoice.registrationNumber}</div>
          <div className={shellStyles.meta}>Leverantörsfaktura · {invoice.supplierName}</div>
        </div>
        <HelpLink chapter="inkop" anchor="leverantorsfakturor" label="Hjälp om leverantörsfakturor" />
      </div>

      <SupplierInvoiceCard
        invoice={invoice}
        canOpenVerifications={user ? canOpen(user, "/ekonomi/verifikat") : false}
        vatCodes={vatCodes}
      />
    </AppShell>
  );
}
