"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import { EINVOICE_STATUS_LABELS } from "../../lib/einvoice";
import { formatMoney, round2 } from "../../lib/format";
import {
  INVOICE_STATUS_PILL,
  INVOICE_TYPE_LABELS,
  type Customer,
  type InvoiceableShipment,
  type Invoice,
  type InvoiceableOrder,
  type InvoiceDetail,
  type Paged,
  type SalesOrder,
} from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import listStyles from "../../app/forsaljning/ordrar/page.module.css";
import { ConfigurationLines } from "../configurator/ConfigurationLines";
import type { OrderRowConfiguration } from "../../lib/configurator";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { toBasePrice, toBaseQuantity, toUnitPrice, toUnitQuantity } from "../../lib/units";
import {
  CUSTOMER_VAT_TREATMENT_LABELS,
  customerVatTreatment,
  salesVatCode,
  vatCodeOptionLabel,
  vatCodesFor,
} from "../../lib/vatCodes";
import { useVatCodes } from "../../lib/useVatCodes";

export function InvoicesPageClient({
  invoices,
  initialOrderId,
  pageSize,
}: {
  invoices: Paged<Invoice>;
  initialOrderId?: string;
  pageSize: number;
}) {
  // Opens straight into the create dialog when linked with ?orderId= (the
  // sales order's "Fakturera" action, Task 9).
  const [modalOpen, setModalOpen] = useState(Boolean(initialOrderId));

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Fakturor</div>
          <div className={shellStyles.meta}>{invoices.total.toLocaleString("sv-SE")} fakturor</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny faktura
          </Button>
          <HelpLink chapter="forsaljning" anchor="fakturor" label="Hjälp om fakturor" />
        </div>
      </div>

      <ListToolbar placeholder="Sök fakturanr eller kund…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(INVOICE_STATUS_PILL).map(([value, pill]) => ({ value, label: pill.label }))}
        />
        <ListExportLink endpoint="/api/v1/invoices/csv" />
      </ListToolbar>

      <Table<Invoice>
        columns={[
          { key: "invoiceNumber", label: "Nummer", width: "130px" },
          { key: "type", label: "Typ", width: "130px" },
          { key: "customerName", label: "Kund", width: "1.4fr" },
          { key: "invoiceDate", label: "Fakturadatum", width: "130px" },
          { key: "dueDate", label: "Förfallodatum", width: "130px" },
          { key: "netAmount", label: "Belopp", width: "140px", align: "right" },
          { key: "status", label: "Status", width: "130px" },
          { key: "einvoiceStatus", label: "E-faktura", width: "100px" },
        ]}
        rows={invoices.rows}
        emptyText="Inga fakturor matchar sökningen"
        renderCell={(invoice, key) => {
          switch (key) {
            case "invoiceNumber":
              return (
                <Link href={`/forsaljning/fakturor/${invoice.id}`} className={listStyles.rowLink}>
                  {invoice.invoiceNumber ?? (invoice.status === "cancelled" ? "–" : "Utkast")}
                </Link>
              );
            case "type":
              return INVOICE_TYPE_LABELS[invoice.type];
            case "customerName":
              return invoice.customerName;
            case "invoiceDate":
              return invoice.invoiceDate ?? "–";
            case "dueDate":
              return invoice.dueDate ?? "–";
            case "netAmount":
              // Belopp is the gross (incl. moms) — what's actually owed —
              // not the net sum alone, same as the AP list's grossAmount.
              return `${formatMoney(String(Number(invoice.netAmount) + Number(invoice.vatAmount)))} ${invoice.currency}`;
            case "status": {
              const pill = INVOICE_STATUS_PILL[invoice.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "einvoiceStatus":
              // A sandbox trial is never mistaken for a real send.
              return invoice.einvoiceStatus
                ? `${EINVOICE_STATUS_LABELS[invoice.einvoiceStatus]}${invoice.einvoiceEnvironment === "sandbox" ? " (sandbox)" : ""}`
                : "";
            default:
              return null;
          }
        }}
      />

      <Pagination total={invoices.total} pageSize={pageSize} />

      <Modal wide open={modalOpen} onClose={() => setModalOpen(false)} title="Ny faktura">
        <NewInvoiceForm initialOrderId={initialOrderId} />
      </Modal>
    </>
  );
}

// One previewed invoice row — either linked to a sales order row (from an
// invoiceable order, orderNumber set) or a free row (orderNumber null,
// articleId/salesOrderRowId null). Quantity/unitPrice are kept as
// strings while editing, same convention as the rest of the app's row forms
// (PurchaseOrderDetail's row-edit dialog etc.) — converted to numbers only
// at submit time. quantity/unitPrice are shown (and edited) in the row's own
// display unit, same as the sales order card — unitFactor is kept alongside
// so submit() can convert back to the API's base-unit values.
type PreviewRow = {
  id: string;
  orderNumber: string | null;
  // Frakt etapp 2: set on a freight row (quantity locked to 1).
  shipmentId: string | null;
  articleId: string | null;
  salesOrderRowId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  // C3: prefilled from the sales order row's discount (0 for free rows) —
  // percent, not unit-dependent, so no conversion needed either way.
  discountPercent: string;
  // Momskod: the id the API derived for an order/freight row (explicit, the
  // user may change it); "" = Automatisk — the API derives it on submit (free
  // rows, and anything it could not name). vatCodeName keeps the derived
  // code's name for the select while the code list is not loaded.
  vatCodeId: string;
  vatCodeName: string | null;
  unitFactor: string | null;
  unitCode: string | null;
  // Konfigurator 4b: the order row's choices, shown under the description (the server copies them on submit).
  configuration: OrderRowConfiguration | null;
};

function shipmentRow(s: InvoiceableShipment): PreviewRow {
  return {
    id: `ship-${s.shipmentId}`,
    orderNumber: null,
    shipmentId: s.shipmentId,
    articleId: s.articleId,
    salesOrderRowId: null,
    description: s.description,
    quantity: "1",
    unitPrice: String(Number(s.customerPrice)),
    discountPercent: "0",
    vatCodeId: s.vatCodeId ?? "",
    vatCodeName: s.vatCode?.name ?? null,
    unitFactor: null,
    unitCode: null,
    configuration: null,
  };
}

const ROW_COLUMNS = [
  { key: "description", label: "Beskrivning", width: "1.3fr" },
  { key: "quantity", label: "Antal", width: "90px", align: "right" as const },
  { key: "unitCode", label: "Enhet", width: "70px" },
  { key: "unitPrice", label: "À-pris", width: "110px", align: "right" as const },
  // C3: prefilled from the order row's discount, still editable here — same
  // "unitPrice is a prefilled starting point, not locked" treatment.
  { key: "discountPercent", label: "Rabatt %", width: "90px", align: "right" as const },
  { key: "vatCode", label: "Momskod", width: "minmax(190px, 1fr)" },
  { key: "lineAmount", label: "Belopp", width: "110px", align: "right" as const },
  { key: "id", label: "", width: "90px", align: "right" as const },
];

// Create dialog — rows come from checking off one or several of the
// customer's invoiceable orders (several = samlingsfaktura), plus any number
// of free rows without an article. initialOrderId prefills a single order
// (and, via the order's own customer, the customer select) when opened from
// a sales order's "Fakturera" link — that endpoint gives no customerId
// directly, so it's resolved with a GET /sales-orders/:id first.
export function NewInvoiceForm({
  initialOrderId,
}: {
  initialOrderId?: string;
}) {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const customerId = customer?.id ?? "";
  // Momskoder: the codes for each row's select, and what Automatisk gives a
  // free row for this customer (goods at 25 % — salesVatCode, the same
  // derivation the API runs when no code is sent).
  const { codes: vatCodes } = useVatCodes();
  const automaticCode = customer
    ? salesVatCode({
        customer: {
          country: customer.country,
          vatNumber: customer.vatNumber,
          privatePerson: customer.privatePerson,
          reverseChargeConstruction: customer.reverseChargeConstruction,
        },
        isGoods: true,
        articleRate: 25,
      })
    : null;
  const automaticName = automaticCode ? vatCodes.find((code) => code.code === automaticCode)?.name : undefined;
  const [orders, setOrders] = useState<InvoiceableOrder[]>([]);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [shipments, setShipments] = useState<InvoiceableShipment[]>([]);
  const [rowsByKey, setRowsByKey] = useState<Map<string, PreviewRow>>(new Map());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Consumed once the matching order shows up in the fetched invoiceable
  // orders (same "pending order" pattern as NewSupplierInvoiceForm).
  const pendingOrderRef = useRef<string | null>(initialOrderId ?? null);
  const freeRowSeqRef = useRef(0);

  // Resolve initialOrderId's customer once on mount — the invoiceable-orders
  // endpoint is keyed by customer, not order, so the order's own customerId
  // has to be fetched first (GET /sales-orders/:id), then the full Customer
  // (GET /customers/:id) to preselect the SearchPicker.
  useEffect(() => {
    if (!initialOrderId) return;
    apiFetch<SalesOrder>(`/api/v1/sales-orders/${initialOrderId}`)
      .then((order) => apiFetch<Customer>(`/api/v1/customers/${order.customerId}`))
      .then((c) => setCustomer(c))
      .catch(() => {
        pendingOrderRef.current = null;
        setError("Kunde inte hämta ordern att förifylla");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the customer's invoiceable orders whenever the customer changes.
  useEffect(() => {
    setOrders([]);
    setShipments([]);
    setSelectedOrderIds(new Set());
    setRowsByKey((prev) => {
      // Keep free rows (they don't belong to any customer's order list);
      // drop order-linked rows from the previous customer.
      const next = new Map<string, PreviewRow>();
      for (const [key, row] of prev) if (row.orderNumber === null && row.shipmentId === null) next.set(key, row);
      return next;
    });
    if (!customerId) return;
    let cancelled = false;
    apiFetch<InvoiceableOrder[]>(`/api/v1/invoiceable-orders?customerId=${customerId}`)
      .then((res) => {
        if (cancelled) return;
        setOrders(res);
        const pending = pendingOrderRef.current;
        if (pending) {
          const order = res.find((o) => o.orderId === pending);
          if (order) selectOrder(order);
        }
        pendingOrderRef.current = null;
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    // Billable freight: every booked, not-yet-invoiced shipment starts
    // ticked (own fetch/catch so a failure never hides the orders).
    apiFetch<InvoiceableShipment[]>(`/api/v1/invoiceable-shipments?customerId=${customerId}`)
      .then((res) => {
        if (cancelled) return;
        setShipments(res);
        setRowsByKey((prev) => {
          const next = new Map(prev);
          for (const s of res) next.set(`ship-${s.shipmentId}`, shipmentRow(s));
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) setShipments([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  function selectOrder(order: InvoiceableOrder) {
    setSelectedOrderIds((prev) => new Set(prev).add(order.orderId));
    setRowsByKey((prev) => {
      const next = new Map(prev);
      for (const r of order.rows) {
        next.set(r.salesOrderRowId, {
          id: r.salesOrderRowId,
          orderNumber: order.orderNumber,
          shipmentId: null,
          articleId: r.articleId,
          salesOrderRowId: r.salesOrderRowId,
          description: `${r.articleNumber} — ${r.articleName}`,
          // rest/unitPrice come from the API in the article's base unit —
          // shown here (and edited) in the row's own display unit, same as
          // the order card; submit() converts back to base.
          quantity: String(toUnitQuantity(r.rest, r.unitFactor)),
          // Normalized (numeric(…, 2) columns come back as "25.00"/"12.00")
          // so the vatRate <Select> below — whose options are plain "25"/
          // "12"/… — actually matches and shows the right selection.
          unitPrice: String(toUnitPrice(Number(r.unitPrice), r.unitFactor)),
          discountPercent: String(Number(r.discountPercent)),
          vatCodeId: r.vatCodeId ?? "",
          vatCodeName: r.vatCode?.name ?? null,
          unitFactor: r.unitFactor,
          unitCode: r.unitCode,
          configuration: r.configuration,
        });
      }
      return next;
    });
  }

  function deselectOrder(order: InvoiceableOrder) {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      next.delete(order.orderId);
      return next;
    });
    setRowsByKey((prev) => {
      const next = new Map(prev);
      for (const r of order.rows) next.delete(r.salesOrderRowId);
      return next;
    });
  }

  function toggleOrder(order: InvoiceableOrder) {
    if (selectedOrderIds.has(order.orderId)) deselectOrder(order);
    else selectOrder(order);
  }

  function toggleShipment(s: InvoiceableShipment) {
    const key = `ship-${s.shipmentId}`;
    setRowsByKey((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, shipmentRow(s));
      return next;
    });
  }

  function addFreeRow() {
    const key = `free-${freeRowSeqRef.current++}`;
    setRowsByKey((prev) => {
      const next = new Map(prev);
      next.set(key, {
        id: key,
        orderNumber: null,
        shipmentId: null,
        articleId: null,
        salesOrderRowId: null,
        description: "",
        quantity: "1",
        unitPrice: "0",
        discountPercent: "0",
        vatCodeId: "",
        vatCodeName: null,
        unitFactor: null,
        unitCode: null,
        configuration: null,
      });
      return next;
    });
  }

  function updateRow(key: string, patch: Partial<PreviewRow>) {
    setRowsByKey((prev) => {
      const row = prev.get(key);
      if (!row) return prev;
      const next = new Map(prev);
      next.set(key, { ...row, ...patch });
      return next;
    });
  }

  function removeRow(key: string) {
    setRowsByKey((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  function renderRowCell(row: PreviewRow, key: string) {
    switch (key) {
      case "description":
        return row.salesOrderRowId === null ? (
          <Input
            required
            aria-label="Beskrivning"
            value={row.description}
            onChange={(e) => updateRow(row.id, { description: e.target.value })}
          />
        ) : (
          <>
            {row.description}
            <ConfigurationLines configuration={row.configuration} />
          </>
        );
      case "quantity":
        // A freight row is always billed once — the API rejects any other quantity.
        if (row.shipmentId !== null) return "1";
        return (
          <Input
            type="number"
            min="0"
            step="any"
            size="sm"
            aria-label="Antal"
            value={row.quantity}
            onChange={(e) => updateRow(row.id, { quantity: e.target.value })}
          />
        );
      case "unitCode":
        return row.unitCode ?? "–";
      case "unitPrice":
        return (
          <Input
            type="number"
            step="0.01"
            size="sm"
            aria-label="À-pris"
            value={row.unitPrice}
            onChange={(e) => updateRow(row.id, { unitPrice: e.target.value })}
          />
        );
      case "discountPercent":
        return (
          <Input
            type="number"
            min="0"
            step="any"
            size="xs"
            aria-label="Rabatt %"
            value={row.discountPercent}
            onChange={(e) => updateRow(row.id, { discountPercent: e.target.value })}
          />
        );
      case "vatCode":
        return (
          <Select
            aria-label="Momskod"
            value={row.vatCodeId}
            onChange={(e) => {
              const picked = vatCodes.find((code) => code.id === e.target.value);
              updateRow(row.id, { vatCodeId: e.target.value, vatCodeName: picked?.name ?? null });
            }}
          >
            {/* The named default is only right for a free row — an order or
                freight row's code depends on its article. */}
            <option value="">
              {row.salesOrderRowId === null && row.shipmentId === null && automaticName
                ? `Automatisk — ${automaticName}`
                : "Automatisk"}
            </option>
            {vatCodesFor(vatCodes, "sales", row.vatCodeId).map((code) => (
              <option key={code.id} value={code.id}>
                {vatCodeOptionLabel(code)}
              </option>
            ))}
            {row.vatCodeId !== "" && !vatCodes.some((code) => code.id === row.vatCodeId) && (
              <option value={row.vatCodeId}>{row.vatCodeName ?? "Momskod"}</option>
            )}
          </Select>
        );
      case "lineAmount":
        // Mirrors invoice.service.ts's lineAmount formula exactly (quantity
        // × unitPrice × (1 − discount/100)) — the preview must match what
        // POST /invoices actually books, not just the pre-discount subtotal.
        return formatMoney(
          String(round2(Number(row.quantity) * Number(row.unitPrice) * (1 - Number(row.discountPercent) / 100)))
        );
      case "id":
        if (row.shipmentId !== null) return null; // removed via the Frakt checkbox above
        return (
          <Button type="button" size="small" variant="danger" onClick={() => removeRow(row.id)}>
            Ta bort
          </Button>
        );
      default:
        return null;
    }
  }

  const freeRows = [...rowsByKey.values()].filter((r) => r.orderNumber === null && r.shipmentId === null);
  const shipmentRows = [...rowsByKey.values()].filter((r) => r.shipmentId !== null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!customerId) {
      setError("Välj en kund");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const invoice = await apiFetch<InvoiceDetail>("/api/v1/invoices", {
        method: "POST",
        body: JSON.stringify({
          customerId,
          note: note.trim() || undefined,
          rows: [...rowsByKey.values()].map((r) => ({
            articleId: r.articleId,
            salesOrderRowId: r.salesOrderRowId,
            shipmentId: r.shipmentId ?? undefined,
            description: r.description,
            // The API stores quantity/unitPrice in the article's base unit —
            // convert back from the display unit shown/edited above (a no-op
            // for free rows, whose unitFactor is null).
            quantity: toBaseQuantity(Number(r.quantity), r.unitFactor),
            unitPrice: toBasePrice(Number(r.unitPrice), r.unitFactor),
            // Percent, not unit-dependent — sent verbatim.
            discountPercent: Number(r.discountPercent),
            // The momskod decides the VAT (never a bare vatRate, which would
            // give an EU customer svensk moms); Automatisk sends nothing and
            // the API derives it from the customer and the article.
            vatCodeId: r.vatCodeId || undefined,
          })),
        }),
      });
      router.push(`/forsaljning/fakturor/${invoice.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa fakturan");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      <Field label="Kund" htmlFor="invoiceCustomer">
        <SearchPicker
          id="invoiceCustomer"
          endpoint="/api/v1/customers"
          value={customer}
          onChange={setCustomer}
          formatLabel={(c) => `${c.customerNumber} — ${c.name}`}
          placeholder="Sök kundnummer eller namn…"
          emptyText="Inga kunder matchar sökningen"
        />
      </Field>

      {customer && (
        <FormHint attached>
          Momsbehandling:{" "}
          {
            CUSTOMER_VAT_TREATMENT_LABELS[
              customerVatTreatment({
                country: customer.country,
                vatNumber: customer.vatNumber,
                privatePerson: customer.privatePerson,
                reverseChargeConstruction: customer.reverseChargeConstruction,
              })
            ]
          }
        </FormHint>
      )}

      {customer?.collectiveInvoicing ? (
        <FormHint attached>
          Kunden faktureras med samlingsfaktura.{" "}
          <Link href={`/forsaljning/samlingsfakturering?customerId=${customer.id}`}>Öppna Samlingsfakturering</Link>
        </FormHint>
      ) : (
        <>
          {customerId && orders.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Ordrar att fakturera</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {orders.map((o) => (
                  <label key={o.orderId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Checkbox checked={selectedOrderIds.has(o.orderId)} onChange={() => toggleOrder(o)} />
                    {o.orderNumber} ({o.rows.length} rad{o.rows.length === 1 ? "" : "er"})
                  </label>
                ))}
              </div>
            </div>
          )}
          {customerId && orders.length === 0 && shipments.length === 0 && (
            <FormHint attached>Kunden har inga levererade orderrader att fakturera.</FormHint>
          )}

          {[...selectedOrderIds].map((orderId) => {
            const order = orders.find((o) => o.orderId === orderId);
            if (!order) return null;
            const groupRows = order.rows
              .map((r) => rowsByKey.get(r.salesOrderRowId))
              .filter((r): r is PreviewRow => r !== undefined);
            if (groupRows.length === 0) return null;
            return (
              <div key={orderId}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{order.orderNumber}</div>
                <Table<PreviewRow> columns={ROW_COLUMNS} rows={groupRows} renderCell={renderRowCell} />
              </div>
            );
          })}

          {shipments.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Frakt</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {shipments.map((s) => (
                  <label key={s.shipmentId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Checkbox checked={rowsByKey.has(`ship-${s.shipmentId}`)} onChange={() => toggleShipment(s)} />
                    {s.shipmentNumber} — {s.carrierName} {s.productName}
                    {s.deliveryNumbers.length > 0 ? ` · ${s.deliveryNumbers.join(", ")}` : ""}
                  </label>
                ))}
              </div>
              {shipmentRows.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Table<PreviewRow> columns={ROW_COLUMNS} rows={shipmentRows} renderCell={renderRowCell} />
                </div>
              )}
            </div>
          )}

          {freeRows.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Fria rader</div>
              <Table<PreviewRow> columns={ROW_COLUMNS} rows={freeRows} renderCell={renderRowCell} />
            </div>
          )}

          <div>
            <Button type="button" variant="secondary" onClick={addFreeRow}>
              Lägg till fri rad
            </Button>
          </div>
        </>
      )}

      <Field label="Notering" htmlFor="invoiceNote">
        <Input id="invoiceNote" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || Boolean(customer?.collectiveInvoicing)}>
          {pending ? "Skapar…" : "Skapa faktura"}
        </Button>
      </FormActions>
    </Form>
  );
}
