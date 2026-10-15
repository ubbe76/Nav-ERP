import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { PurchaseOrderDetail } from "../../../../components/purchase/PurchaseOrderDetail";
import { ReceiptsSection } from "../../../../components/purchase/ReceiptsSection";
import { MailSection } from "../../../../components/mail/MailSection";
import { AuditTrailSection } from "../../../../components/system/AuditTrailSection";
import { apiGet } from "../../../../lib/api";
import { countDrawings, getDefaultRecipient, getDocumentEmails } from "../../../../lib/mail";
import type {
  PurchaseOrder,
  PurchaseOrderRow,
  PurchaseReceipt,
  RegisterEntry,
  StockLocation,
  Supplier,
} from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function PurchaseOrderDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const order = await apiGet<PurchaseOrder>(`/api/v1/purchase-orders/${params.id}`, cookieHeader).catch(() => null);
  if (!order) notFound();

  const [rows, receipts, locations, emails, supplier, deliveryTerms, paymentTerms, carriers] = await Promise.all([
    apiGet<PurchaseOrderRow[]>(`/api/v1/purchase-orders/${params.id}/rows`, cookieHeader),
    apiGet<PurchaseReceipt[]>(`/api/v1/purchase-orders/${params.id}/receipts`, cookieHeader),
    apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader),
    getDocumentEmails(order.id, cookieHeader),
    apiGet<Supplier>(`/api/v1/suppliers/${order.supplierId}`, cookieHeader).catch(() => null),
    apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
  ]);
  const defaultTo = await getDefaultRecipient("suppliers", order.supplierId, supplier?.email ?? null, cookieHeader);
  const drawingCount = await countDrawings(rows.map((r) => r.articleId), cookieHeader);
  const mailable = order.status !== "cancelled" && order.status !== "closed";

  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{order.orderNumber}</div>
          <div className={shellStyles.meta}>{order.supplierName}</div>
        </div>
        <HelpLink chapter="inkop" anchor="inkopsorder" label="Hjälp om inköpsorder" />
      </div>

      <PurchaseOrderDetail
        order={order}
        rows={rows}
        locations={locations}
        registers={{ deliveryTerms, paymentTerms, carriers }}
      />

      <ReceiptsSection orderId={order.id} orderStatus={order.status} receipts={receipts} rows={rows} />

      <MailSection
        emails={emails}
        defaultTo={defaultTo}
        sendButtons={
          mailable
            ? [
                {
                  label: "Skicka via e-post",
                  modalTitle: `Skicka ${order.orderNumber} via e-post`,
                  endpoint: `/api/v1/purchase-orders/${order.id}/send-email`,
                  subject: `Inköpsorder ${order.orderNumber}`,
                  message: `Hej!\n\nSe bifogad inköpsorder ${order.orderNumber}.\n\nMed vänliga hälsningar`,
                },
              ]
            : []
        }
        pdfLinks={[{ label: "Ladda ner PDF", href: `/api/v1/purchase-orders/${order.id}/pdf` }]}
        drawingCount={drawingCount}
      />

      <AuditTrailSection entityType="purchase_order" entityId={order.orderNumber} />
    </AppShell>
  );
}
