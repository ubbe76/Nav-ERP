import { PalletCardButton } from "../documents/PalletCardButton";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../AppShell";
import { SalesOrderDetail } from "./SalesOrderDetail";
import { MailSection, type SendButtonConfig } from "../mail/MailSection";
import { AuditTrailSection } from "../system/AuditTrailSection";
import { Table } from "../ui/Table";
import { UndoDeliveryButton } from "../sales/UndoDeliveryDialog";
import { BookTransportButton } from "../shipping/BookTransportButton";
import { apiGet } from "../../lib/api";
import { salesDocumentKind, salesDocumentPath, type SalesDocumentKind } from "../../lib/salesDocumentKind";
import { countDrawings, getDefaultRecipient, getDocumentEmails } from "../../lib/mail";
import type {
  Customer,
  CustomerDeliveryAddress,
  RegisterEntry,
  SalesDelivery,
  SalesOrder,
  SalesOrderRow,
  StockLocation,
} from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import Link from "next/link";
import buttonStyles from "../ui/Button.module.css";
import { HelpLink } from "../ui/HelpLink";
import { SectionHeading } from "../ui/SectionHeading";

// Ångra utleverans: a följesedel whose rows are all undone.
function isUndone(delivery: SalesDelivery) {
  return delivery.rowCount > 0 && delivery.undoneRowCount === delivery.rowCount;
}

// The kundorder card and the offert card are the same component on two routes
// (/forsaljning/offerter/:id, /forsaljning/ordrar/:id); a record opened on the
// wrong route is redirected to the right one before anything else is fetched.
export async function SalesOrderCardPage({ id, route }: { id: string; route: SalesDocumentKind }) {
  const params = { id };
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const order = await apiGet<SalesOrder>(`/api/v1/sales-orders/${params.id}`, cookieHeader).catch(() => null);
  if (!order) notFound();
  const kind = order.documentKind ?? salesDocumentKind(order);
  if (kind !== route) redirect(salesDocumentPath(kind, order.id));
  // Offertnumret (OF-…) is the document number of a quote; after Bekräfta the
  // order has its own KO number and the OF number is a reference.
  const quoteNumber = order.quoteNumber ?? null;
  const fromQuote = kind === "order" && quoteNumber !== null && quoteNumber !== order.orderNumber ? quoteNumber : null;
  const docLabel = kind === "quote" ? "Offert" : "Kundorder";

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
  // An OF-numbered quote gets its KO number when the confirmation is sent, so
  // the default texts name the quote rather than a number it doesn't have yet.
  const confirmsQuote = order.status === "quote" && !!quoteNumber && quoteNumber === order.orderNumber;
  if (order.status === "quote") {
    sendButtons.push({
      label: "Skicka offert",
      modalTitle: `Skicka offert ${quoteNumber ?? order.orderNumber} via e-post`,
      endpoint: `/api/v1/sales-orders/${order.id}/send-email`,
      subject: `Offert ${quoteNumber ?? order.orderNumber}`,
      message: `Hej!\n\nSe bifogad offert ${quoteNumber ?? order.orderNumber}.\n\nMed vänliga hälsningar`,
      extraBody: { variant: "quote" },
    });
  }
  if (order.status !== "cancelled" && order.status !== "lost") {
    sendButtons.push({
      label: "Skicka orderbekräftelse",
      modalTitle: confirmsQuote
        ? `Skicka orderbekräftelse för offert ${quoteNumber} via e-post`
        : `Skicka orderbekräftelse ${order.orderNumber} via e-post`,
      endpoint: `/api/v1/sales-orders/${order.id}/send-email`,
      subject: confirmsQuote ? `Orderbekräftelse för offert ${quoteNumber}` : `Orderbekräftelse ${order.orderNumber}`,
      message: confirmsQuote
        ? `Hej!\n\nTack för er order. Se bifogad orderbekräftelse för vår offert ${quoteNumber}.\n\nMed vänliga hälsningar`
        : `Hej!\n\nTack för er order. Se bifogad orderbekräftelse ${order.orderNumber}.\n\nMed vänliga hälsningar`,
      extraBody: { variant: "confirmation" },
      // Confirming a quote gives it a KO number — land on the order card.
      ...(order.status === "quote" ? { redirectTo: `/forsaljning/ordrar/${order.id}` } : {}),
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
          <div className={shellStyles.title}>
            {docLabel} {kind === "quote" ? (quoteNumber ?? order.orderNumber) : order.orderNumber}
          </div>
          <div className={shellStyles.meta}>
            {order.customerName}
            {fromQuote && ` · Från offert ${fromQuote}`}
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href={kind === "quote" ? "/forsaljning/offerter" : "/forsaljning/ordrar"} className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            {kind === "quote" ? "Offerter" : "Kundorder"}
          </Link>
          <HelpLink
            chapter="forsaljning"
            anchor={kind === "quote" ? "offerter" : "kundorder"}
            label={kind === "quote" ? "Hjälp om offerter" : "Hjälp om kundorder"}
          />
        </div>
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
        pdfLinks={
          order.status === "lost"
            ? []
            : [
          { label: "Offert (PDF)", href: `/api/v1/sales-orders/${order.id}/pdf?variant=quote`, configurationPrices: true },
          // An OF-numbered quote has no KO number yet — its confirmation is
          // only made by Skicka orderbekräftelse, which gives it one.
          ...(confirmsQuote
            ? []
            : [
                {
                  label: "Orderbekräftelse (PDF)",
                  href: `/api/v1/sales-orders/${order.id}/pdf?variant=confirmation`,
                  configurationPrices: true,
                },
              ]),
          { label: "Plocklista (PDF)", href: `/api/v1/sales-orders/${order.id}/pick-list` },
          ...(order.status === "invoiced" && order.invoiceNumber
            ? [{ label: "Faktura (PDF)", href: `/api/v1/sales-orders/${order.id}/invoice-pdf` }]
            : []),
        ]}
        showDocumentColumn
        drawingCount={drawingCount}
      />

      <AuditTrailSection
        entityType="sales_order"
        entityId={order.orderNumber}
        alsoEntityId={quoteNumber && quoteNumber !== order.orderNumber ? quoteNumber : undefined}
      />
    </AppShell>
  );
}
