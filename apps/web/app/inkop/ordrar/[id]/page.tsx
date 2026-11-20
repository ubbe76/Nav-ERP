import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { SplitView } from "../../../../components/split/SplitView";
import { PurchaseOrderDetail } from "../../../../components/purchase/PurchaseOrderDetail";
import { DispatchesSection } from "../../../../components/purchase/DispatchesSection";
import { ReceiptsSection } from "../../../../components/purchase/ReceiptsSection";
import { MailSection } from "../../../../components/mail/MailSection";
import { DeviationsSection } from "../../../../components/quality/DeviationsSection";
import { AuditTrailSection } from "../../../../components/system/AuditTrailSection";
import { documentLanguageOf } from "../../../../lib/documentLanguage";
import { apiGet } from "../../../../lib/api";
import { countDrawings, getDocumentEmails } from "../../../../lib/mail";
import type {
  PurchaseDispatch,
  PurchaseOrder,
  PurchaseOrderRow,
  PurchaseReceipt,
  RegisterEntry,
  StockLocation,
} from "../../../../lib/types";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function PurchaseOrderDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const order = await apiGet<PurchaseOrder>(`/api/v1/purchase-orders/${params.id}`, cookieHeader).catch(() => null);
  if (!order) notFound();

  const [rows, receipts, dispatches, locations, emails, deliveryTerms, paymentTerms, carriers] = await Promise.all([
    apiGet<PurchaseOrderRow[]>(`/api/v1/purchase-orders/${params.id}/rows`, cookieHeader),
    apiGet<PurchaseReceipt[]>(`/api/v1/purchase-orders/${params.id}/receipts`, cookieHeader),
    apiGet<PurchaseDispatch[]>(`/api/v1/purchase-orders/${params.id}/dispatches`, cookieHeader),
    apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader),
    getDocumentEmails(order.id, cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
  ]);
  // The server's rule: E-post för inköpsorder, else the huvudkontakt's
  // address, else the supplier's E-post.
  const defaultTo = order.defaultRecipient ?? "";
  const drawingCount = await countDrawings(rows.map((r) => r.articleId), cookieHeader);
  const mailable = order.status !== "cancelled" && order.status !== "closed";

  return (
    <AppShell>
      {/* Lista och kort: the function's narrow list beside the card. */}
      <SplitView list="/inkop/ordrar" selectedId={params.id}>
        <PurchaseOrderDetail
          order={order}
          rows={rows}
          locations={locations}
          registers={{ deliveryTerms, paymentTerms, carriers }}
          pageTitle={`Inköpsorder ${order.orderNumber}`}
          help={<HelpLink chapter="inkop" anchor="inkopsorder" label="Hjälp om inköpsorder" />}
          tabs={[
            {
              key: "mottagning",
              label: "Mottagning",
              count: receipts.length || null,
              node:
                receipts.length > 0 ? (
                  <ReceiptsSection orderId={order.id} orderStatus={order.status} receipts={receipts} rows={rows} />
                ) : (
                  <p>Inga inleveranser än.</p>
                ),
            },
            // Avsändning lego: only on an order that has sent something or buys a lego operation.
            ...(dispatches.length > 0 || rows.some((r) => r.moOperationId !== null)
              ? [
                  {
                    key: "avsandning",
                    label: "Avsändning",
                    count: dispatches.length || null,
                    node:
                      dispatches.length > 0 ? (
                        <DispatchesSection orderId={order.id} dispatches={dispatches} />
                      ) : (
                        <p>Inget avsänt än.</p>
                      ),
                  },
                ]
              : []),
            {
              key: "dokument",
              label: "Dokument",
              node: (
        <MailSection
          documentLanguage={documentLanguageOf(order.supplierLanguage)}
          emails={emails}
          defaultTo={defaultTo}
          sendButtons={
            mailable
              ? [
                  {
                    label: "Skicka via e-post",
                    modalTitle: `Skicka ${order.orderNumber} via e-post`,
                    endpoint: `/api/v1/purchase-orders/${order.id}/send-email`,
                    ccSupplierId: order.supplierId,
                    mail: {
                      kind: "purchaseOrder",
                      language: documentLanguageOf(order.supplierLanguage),
                      values: {
                        number: order.orderNumber,
                        supplier: order.supplierName,
                        contact: order.yourReference,
                        deliveryDate: order.expectedDeliveryDate,
                      },
                    },
                  },
                ]
              : []
          }
          pdfLinks={[{ label: "Ladda ner PDF", href: `/api/v1/purchase-orders/${order.id}/pdf` }]}
          drawingCount={drawingCount}
        />
              ),
            },
            {
              key: "avvikelser",
              label: "Avvikelser",
              node: (
        <DeviationsSection
          filter={{ purchaseOrderId: order.id }}
          newDeviation={{ type: "supplier", supplierId: order.supplierId, purchaseOrderId: order.id }}
          buttonLabel="Ny avvikelse"
        />
              ),
            },
            {
              key: "historik",
              label: "Historik",
              node: <AuditTrailSection entityType="purchase_order" entityId={order.orderNumber} />,
            },
          ]}
        />
      </SplitView>
    </AppShell>
  );
}
