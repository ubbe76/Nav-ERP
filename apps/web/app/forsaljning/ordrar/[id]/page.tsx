import { PalletCardButton } from "../../../../components/documents/PalletCardButton";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { SalesOrderDetail } from "../../../../components/sales/SalesOrderDetail";
import { MailSection, type SendButtonConfig } from "../../../../components/mail/MailSection";
import { AuditTrailSection } from "../../../../components/system/AuditTrailSection";
import { Table } from "../../../../components/ui/Table";
import { UndoDeliveryButton } from "../../../../components/sales/UndoDeliveryDialog";
import { BookTransportButton } from "../../../../components/shipping/BookTransportButton";
import { apiGet } from "../../../../lib/api";
import { countDrawings, getDefaultRecipient, getDocumentEmails } from "../../../../lib/mail";
import type {
  Customer,
  CustomerDeliveryAddress,
  RegisterEntry,
  SalesDelivery,
  SalesOrder,
  SalesOrderRow,
  StockLocation,
} from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";
import { SectionHeading } from "../../../../components/ui/SectionHeading";

// Ångra utleverans: a följesedel whose rows are all undone.
function isUndone(delivery: SalesDelivery) {
  return delivery.rowCount > 0 && delivery.undoneRowCount === delivery.rowCount;
}

export default async function SalesOrderDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const order = await apiGet<SalesOrder>(`/api/v1/sales-orders/${params.id}`, cookieHeader).catch(() => null);
  if (!order) notFound();

  const [rows, locations, emails, customer, deliveryAddresses, deliveries, freightStatus] = await Promise.all([
    apiGet<SalesOrderRow[]>(`/api/v1/sales-orders/${params.id}/rows`, cookieHeader),
    apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader),
    getDocumentEmails(order.id, cookieHeader),
    apiGet<Customer>(`/api/v1/customers/${order.customerId}`, cookieHeader).catch(() => null),
    apiGet<CustomerDeliveryAddress[]>(`/api/v1/customers/${order.customerId}/delivery-addresses`, cookieHeader).catch(
      () => [] as CustomerDeliveryAddress[]
    ),
    apiGet<SalesDelivery[]>(`/api/v1/sales-orders/${params.id}/deliveries`, cookieHeader),
    // Frakt: "Boka transport" per följesedel only when freight is enabled.
    apiGet<{ enabled: boolean }>("/api/v1/freight-settings/status", cookieHeader).catch(() => ({ enabled: false })),
  ]);
  const [deliveryTerms, paymentTerms, carriers] = await Promise.all([
    apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
  ]);
  const defaultTo = await getDefaultRecipient("customers", order.customerId, customer?.email ?? null, cookieHeader);
  const drawingCount = await countDrawings(rows.map((r) => r.articleId), cookieHeader);

  // "Skicka orderbekräftelse" on a quote is what confirms it; on later
  // statuses it's a resend. The quote itself is only sent while it IS a quote.
  const sendButtons: SendButtonConfig[] = [];
  if (order.status === "quote") {
    sendButtons.push({
      label: "Skicka offert",
      modalTitle: `Skicka offert ${order.orderNumber} via e-post`,
      endpoint: `/api/v1/sales-orders/${order.id}/send-email`,
      subject: `Offert ${order.orderNumber}`,
      message: `Hej!\n\nSe bifogad offert ${order.orderNumber}.\n\nMed vänliga hälsningar`,
      extraBody: { variant: "quote" },
    });
  }
  if (order.status !== "cancelled") {
    sendButtons.push({
      label: "Skicka orderbekräftelse",
      modalTitle: `Skicka orderbekräftelse ${order.orderNumber} via e-post`,
      endpoint: `/api/v1/sales-orders/${order.id}/send-email`,
      subject: `Orderbekräftelse ${order.orderNumber}`,
      message: `Hej!\n\nTack för er order. Se bifogad orderbekräftelse ${order.orderNumber}.\n\nMed vänliga hälsningar`,
      extraBody: { variant: "confirmation" },
    });
  }
  // The invoice exists once the order is invoiced. Its email goes to the
  // customer's invoice email when one is set.
  if (order.status === "invoiced" && order.invoiceNumber) {
    sendButtons.push({
      label: "Skicka faktura",
      modalTitle: `Skicka faktura ${order.invoiceNumber} via e-post`,
      endpoint: `/api/v1/sales-orders/${order.id}/send-invoice-email`,
      subject: `Faktura ${order.invoiceNumber}`,
      message: `Hej!\n\nSe bifogad faktura ${order.invoiceNumber}.\n\nMed vänliga hälsningar`,
      to: customer?.invoiceEmail ?? undefined,
    });
  }

  return (
    <AppShell active="Försäljning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{order.orderNumber}</div>
          <div className={shellStyles.meta}>{order.customerName}</div>
        </div>
        <HelpLink chapter="forsaljning" anchor="offert-och-kundorder" label="Hjälp om offert och kundorder" />
      </div>

      <SalesOrderDetail
        order={order}
        rows={rows}
        locations={locations}
        deliveryAddresses={deliveryAddresses}
        registers={{ deliveryTerms, paymentTerms, carriers }}
        freightEnabled={freightStatus.enabled}
      />

      {deliveries.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <SectionHeading>Följesedlar</SectionHeading>
          <Table<SalesDelivery>
            columns={[
              { key: "deliveryNumber", label: "Följesedel", width: "160px" },
              { key: "deliveredAt", label: "Datum", width: "180px" },
              { key: "rowCount", label: "Rader", width: "100px", align: "right" },
              { key: "shipment", label: "Frakt", width: "1.4fr" },
              { key: "id", label: "", width: "1fr", align: "right" },
            ]}
            rows={deliveries}
            renderCell={(row, key) => {
              switch (key) {
                case "deliveryNumber":
                  return isUndone(row) ? (
                    <span>
                      {row.deliveryNumber}{" "}
                      <span style={{ background: "var(--status-stopped-bg)", color: "var(--status-stopped-text)", padding: "1px 8px", borderRadius: "var(--radius-control-sm)", fontSize: 12, fontWeight: 600 }}>
                        Ångrad
                      </span>
                    </span>
                  ) : (
                    row.deliveryNumber
                  );
                case "deliveredAt":
                  return new Date(row.deliveredAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
                case "rowCount":
                  return row.rowCount;
                case "shipment":
                  return isUndone(row) ? null : <BookTransportButton deliveryId={row.id} shipment={row.shipment} enabled={freightStatus.enabled} />;
                case "id":
                  return (
                    <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
                      <a href={`/api/v1/deliveries/${row.id}/pdf`} target="_blank" rel="noopener noreferrer">
                        PDF
                      </a>
                      {!(isUndone(row)) && <PalletCardButton deliveryId={row.id} />}
                      {!(isUndone(row)) && (
                        <UndoDeliveryButton orderId={order.id} deliveryId={row.id} orderStatus={order.status} />
                      )}
                    </span>
                  );
                default:
                  return null;
              }
            }}
          />
        </div>
      )}

      <MailSection
        emails={emails}
        defaultTo={defaultTo}
        sendButtons={sendButtons}
        configurationPrices={
          rows.some((r) => r.configuration !== null)
            ? { defaultChecked: customer?.showConfigurationPrices ?? false }
            : undefined
        }
        pdfLinks={[
          { label: "Offert (PDF)", href: `/api/v1/sales-orders/${order.id}/pdf?variant=quote`, configurationPrices: true },
          {
            label: "Orderbekräftelse (PDF)",
            href: `/api/v1/sales-orders/${order.id}/pdf?variant=confirmation`,
            configurationPrices: true,
          },
          { label: "Plocklista (PDF)", href: `/api/v1/sales-orders/${order.id}/pick-list` },
          ...(order.status === "invoiced" && order.invoiceNumber
            ? [{ label: "Faktura (PDF)", href: `/api/v1/sales-orders/${order.id}/invoice-pdf` }]
            : []),
        ]}
        showDocumentColumn
        drawingCount={drawingCount}
      />

      <AuditTrailSection entityType="sales_order" entityId={order.orderNumber} />
    </AppShell>
  );
}
