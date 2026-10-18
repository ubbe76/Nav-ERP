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
import { formatMoney, round2 } from "../../lib/format";
import {
  PURCHASE_ORDER_STATUS_PILL,
  SUPPLIER_INVOICE_STATUS_PILL,
  VAT_RATES,
  type Paged,
  type PurchaseOrder,
  type PurchaseOrderRow,
  type Supplier,
  type SupplierInvoice,
  type SupplierInvoiceDetail,
} from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import listStyles from "../../app/inkop/ordrar/page.module.css";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { UNDERLAG_ACCEPT, uploadUnderlag } from "../documents/UnderlagSection";

export function SupplierInvoicesPageClient({
  invoices,
  pageSize,
}: {
  invoices: Paged<SupplierInvoice>;
  pageSize: number;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Leverantörsfakturor</div>
          <div className={shellStyles.meta}>{invoices.total.toLocaleString("sv-SE")} fakturor</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny leverantörsfaktura
          </Button>
          <HelpLink chapter="inkop" anchor="leverantorsfakturor" label="Hjälp om leverantörsfakturor" />
        </div>
      </div>

      <ListToolbar placeholder="Sök reg.nr, fakturanr eller leverantör…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(SUPPLIER_INVOICE_STATUS_PILL).map(([value, pill]) => ({ value, label: pill.label }))}
        />
        <ListExportLink endpoint="/api/v1/supplier-invoices/csv" />
      </ListToolbar>

      <Table<SupplierInvoice>
        columns={[
          { key: "registrationNumber", label: "Reg.nr", width: "120px" },
          { key: "invoiceNumber", label: "Leverantörens fakturanr", width: "1fr" },
          { key: "supplierName", label: "Leverantör", width: "1.4fr" },
          { key: "invoiceDate", label: "Fakturadatum", width: "130px" },
          { key: "status", label: "Status", width: "140px" },
          { key: "grossAmount", label: "Belopp", width: "140px", align: "right" },
        ]}
        rows={invoices.rows}
        emptyText="Inga leverantörsfakturor matchar sökningen"
        renderCell={(invoice, key) => {
          switch (key) {
            case "registrationNumber":
              return (
                <Link href={`/inkop/leverantorsfakturor/${invoice.id}`} className={listStyles.rowLink}>
                  {invoice.registrationNumber}
                </Link>
              );
            case "invoiceNumber":
              return invoice.invoiceNumber;
            case "supplierName":
              return invoice.supplierName;
            case "invoiceDate":
              return invoice.invoiceDate;
            case "status": {
              const pill = SUPPLIER_INVOICE_STATUS_PILL[invoice.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "grossAmount":
              return `${formatMoney(invoice.grossAmount)} ${invoice.currency}`;
            default:
              return null;
          }
        }}
      />

      <Pagination total={invoices.total} pageSize={pageSize} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny leverantörsfaktura">
        <NewSupplierInvoiceForm />
      </Modal>
    </>
  );
}

// One previewed line built from a purchase-order row (invoice basis).
// articleId is null and purchaseOrderRowId absent on a lego row's ställpris
// line — a fee line, not goods, and PO-row matching compares unit prices.
type PreviewRow = {
  id: string;
  description: string;
  articleId: string | null;
  quantity: number;
  unitPrice: number;
  purchaseOrderRowId?: string;
};

// Create dialog — the rows (and PO-matching) can be pulled from a received
// purchase order, or left empty and built by hand on the invoice card.
// initialSupplierId/initialOrderId prefill it when opened from the
// Fakturaunderlag worklist (auto-fetches that order's rows).
export function NewSupplierInvoiceForm({
  initialSupplierId,
  initialOrderId,
}: {
  initialSupplierId?: string;
  initialOrderId?: string;
}) {
  const router = useRouter();
  // The supplier the goods were ordered from — it picks the purchase orders
  // to pull the invoice basis from. The invoice is paid to the same supplier
  // unless Betalas till en annan leverantör is ticked (a factoring company,
  // a parent company); the rows stay matched against the order either way.
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const supplierId = supplier?.id ?? "";
  const [otherPayee, setOtherPayee] = useState(false);
  const [payee, setPayee] = useState<Supplier | null>(null);
  const invoiceSupplier = otherPayee ? payee : supplier;
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [netAmount, setNetAmount] = useState("");
  const [vatAmount, setVatAmount] = useState("");
  const [grossAmount, setGrossAmount] = useState("");
  // Momsen förifylls: Momsbelopp = Nettobelopp × Momssats and Bruttobelopp =
  // netto + moms, until the field is typed in by hand (manuellt vinner).
  // Picking another Momssats is an explicit request, so it recomputes the
  // VAT again. Foreign-currency suppliers start at 0 % — they invoice
  // without Swedish VAT.
  const [vatRate, setVatRate] = useState<number>(25);
  const [vatTouched, setVatTouched] = useState(false);
  const [grossTouched, setGrossTouched] = useState(false);
  const [note, setNote] = useState("");
  // Underlag — the supplier's invoice as PDF/scan, uploaded right after the
  // invoice is created (the file needs the new LF's id).
  const [files, setFiles] = useState<File[]>([]);
  // Invoice basis pulled from a received purchase order (fakturaunderlag).
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [qtyBasis, setQtyBasis] = useState<"received" | "ordered">("received");
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // An order id to auto-select + auto-fetch once its supplier's orders load
  // (set when the dialog is opened from the Fakturaunderlag worklist).
  const pendingOrderRef = useRef<string | null>(initialOrderId ?? null);

  // Resolve initialSupplierId once on mount — the Fakturaunderlag worklist
  // only has the id, so the full Supplier is fetched to preselect the picker.
  useEffect(() => {
    if (!initialSupplierId) return;
    apiFetch<Supplier>(`/api/v1/suppliers/${initialSupplierId}`)
      .then((s) => setSupplier(s))
      .catch(() => setError("Kunde inte hämta leverantören att förifylla"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invoiceCurrency = invoiceSupplier?.currency;
  useEffect(() => {
    if (!invoiceCurrency) return;
    setVatRate(invoiceCurrency === "SEK" ? 25 : 0);
    setVatTouched(false);
  }, [invoiceCurrency]);

  useEffect(() => {
    const net = Number(netAmount);
    const hasNet = netAmount.trim() !== "" && Number.isFinite(net);
    let vat = Number(vatAmount);
    if (!vatTouched) {
      vat = hasNet ? round2((net * vatRate) / 100) : 0;
      setVatAmount(hasNet ? String(vat) : "");
    }
    if (!grossTouched) {
      setGrossAmount(hasNet ? String(round2(net + (Number.isFinite(vat) ? vat : 0))) : "");
    }
  }, [netAmount, vatAmount, vatRate, vatTouched, grossTouched]);

  // Load the supplier's inlevererade orders whenever the supplier changes.
  useEffect(() => {
    setSelectedOrderId("");
    setPreviewRows([]);
    setOrders([]);
    if (!supplierId) return;
    let cancelled = false;
    apiFetch<Paged<PurchaseOrder>>(
      `/api/v1/purchase-orders?supplierId=${supplierId}&status=received,partially_received,closed&limit=1000`
    )
      .then((res) => {
        if (cancelled) return;
        setOrders(res.rows);
        // Prefill flow: select + fetch the passed-in order once, if present.
        const pending = pendingOrderRef.current;
        if (pending && res.rows.some((o) => o.id === pending)) {
          setSelectedOrderId(pending);
          void fetchBasis(pending);
        }
        pendingOrderRef.current = null;
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId]);

  // Pull the selected order's rows as invoice lines. Mottaget = only received
  // rows, at the received quantity; Beställt = all rows, ordered quantity.
  async function fetchBasis(orderId = selectedOrderId) {
    if (!orderId) return;
    setError(null);
    try {
      const rows = await apiFetch<PurchaseOrderRow[]>(`/api/v1/purchase-orders/${orderId}/rows`);
      const built: PreviewRow[] = [];
      for (const r of rows) {
        if (qtyBasis === "received" ? Number(r.quantityReceived) === 0 : Number(r.quantityOrdered) === 0) continue;
        built.push({
          id: r.id,
          description: `${r.articleNumber} — ${r.articleName}`,
          articleId: r.articleId,
          quantity: qtyBasis === "received" ? Number(r.quantityReceived) : Number(r.quantityOrdered),
          unitPrice: Number(r.unitPrice),
          purchaseOrderRowId: r.id,
        });
        // Lego row: the one-off ställpris is part of what the subcontractor
        // invoices — its own fee line (it is not per unit, so it cannot ride
        // in unitPrice), without article/PO-row match.
        if (r.setupPrice != null && Number(r.setupPrice) > 0) {
          built.push({
            id: `${r.id}-setup`,
            description: `Ställpris — ${r.articleNumber}`,
            articleId: null,
            quantity: 1,
            unitPrice: Number(r.setupPrice),
          });
        }
      }
      setPreviewRows(built);
      // Fill the net amount from the row sum when it is still empty — the
      // VAT and gross follow from it (see the prefill effect above).
      const sum = round2(built.reduce((acc, r) => acc + r.quantity * r.unitPrice, 0));
      if (isEmptyAmount(netAmount)) setNetAmount(String(sum));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte hämta orderraderna");
    }
  }

  function removePreviewRow(id: string) {
    setPreviewRows((rows) => rows.filter((r) => r.id !== id));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!supplierId) {
      setError("Välj en leverantör");
      return;
    }
    if (!invoiceSupplier) {
      setError("Välj leverantören som fakturan ska betalas till");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const invoice = await apiFetch<SupplierInvoiceDetail>("/api/v1/supplier-invoices", {
        method: "POST",
        body: JSON.stringify({
          supplierId: invoiceSupplier.id,
          invoiceNumber,
          invoiceDate,
          dueDate: dueDate.trim() || undefined,
          netAmount: netAmount.trim() ? Number(netAmount) : 0,
          vatAmount: vatAmount.trim() ? Number(vatAmount) : 0,
          grossAmount: grossAmount.trim() ? Number(grossAmount) : 0,
          note: note.trim() || undefined,
          purchaseOrderId: previewRows.length > 0 ? selectedOrderId : undefined,
          rows: previewRows.map((r) => ({
            description: r.description,
            articleId: r.articleId,
            quantity: r.quantity,
            unitPrice: r.unitPrice,
            // The row's rate only steers the konteringsregel lookup; the
            // header's Momsbelopp is what is booked.
            vatRate,
            purchaseOrderRowId: r.purchaseOrderRowId,
          })),
        }),
      });
      // The invoice exists now — a failed upload must not keep the dialog
      // open (a resubmit would hit the duplicate-number check). The card
      // shows the problem and has its own upload.
      let uploadFailed = false;
      for (const file of files) {
        try {
          await uploadUnderlag(`/api/v1/supplier-invoices/${invoice.id}/files`, file);
        } catch {
          uploadFailed = true;
        }
      }
      router.push(`/inkop/leverantorsfakturor/${invoice.id}${uploadFailed ? "?underlag=fel" : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa fakturan");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      <Field label="Leverantör" htmlFor="invoiceSupplier">
        <SearchPicker
          id="invoiceSupplier"
          endpoint="/api/v1/suppliers"
          value={supplier}
          onChange={setSupplier}
          formatLabel={(s) => `${s.supplierNumber} — ${s.name}`}
          placeholder="Sök leverantörnummer eller namn…"
          emptyText="Inga leverantörer matchar sökningen"
        />
      </Field>

      {/* Hämta fakturaunderlag från en inlevererad inköpsorder */}
      {supplierId && orders.length > 0 && (
        <>
          <FormRow>
            <Field label="Hämta underlag från inköpsorder" htmlFor="invoiceOrder">
              <Select id="invoiceOrder" value={selectedOrderId} onChange={(e) => setSelectedOrderId(e.target.value)}>
                <option value="">— Ingen —</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.orderNumber} · {PURCHASE_ORDER_STATUS_PILL[o.status].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Antal" htmlFor="invoiceQtyBasis">
              <Select
                id="invoiceQtyBasis"
                value={qtyBasis}
                onChange={(e) => setQtyBasis(e.target.value as "received" | "ordered")}
              >
                <option value="received">Mottaget antal</option>
                <option value="ordered">Beställt antal</option>
              </Select>
            </Field>
          </FormRow>
          <div>
            <Button type="button" variant="secondary" disabled={!selectedOrderId} onClick={() => fetchBasis()}>
              Hämta orderrader
            </Button>
          </div>
        </>
      )}
      {supplierId && orders.length === 0 && (
        <FormHint attached>Leverantören har inga inlevererade inköpsorder att hämta från.</FormHint>
      )}

      {supplierId && (
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Checkbox checked={otherPayee} onChange={(e) => setOtherPayee(e.target.checked)} />
          <span>Betalas till en annan leverantör</span>
        </label>
      )}
      {supplierId && otherPayee && (
        <Field label="Betalas till" htmlFor="invoicePayee">
          <SearchPicker
            id="invoicePayee"
            endpoint="/api/v1/suppliers"
            value={payee}
            onChange={setPayee}
            formatLabel={(s) => `${s.supplierNumber} — ${s.name}`}
            placeholder="Sök leverantörnummer eller namn…"
            emptyText="Inga leverantörer matchar sökningen"
          />
          <FormHint>Raderna förblir matchade mot inköpsordern.</FormHint>
        </Field>
      )}

      {previewRows.length > 0 && (
        <Table<PreviewRow>
          columns={[
            { key: "description", label: "Beskrivning", width: "1.4fr" },
            { key: "quantity", label: "Antal", width: "90px", align: "right" },
            { key: "unitPrice", label: "À-pris", width: "110px", align: "right" },
            { key: "lineAmount", label: "Belopp", width: "120px", align: "right" },
            { key: "id", label: "", width: "90px", align: "right" },
          ]}
          rows={previewRows}
          renderCell={(row, key) => {
            switch (key) {
              case "quantity":
                return row.quantity;
              case "unitPrice":
                return formatMoney(String(row.unitPrice));
              case "lineAmount":
                return formatMoney(String(round2(row.quantity * row.unitPrice)));
              case "id":
                return (
                  <Button type="button" size="small" variant="danger" onClick={() => removePreviewRow(row.id)}>
                    Ta bort
                  </Button>
                );
              default:
                return row[key as keyof PreviewRow] as string;
            }
          }}
        />
      )}

      <FormRow>
        <Field label="Leverantörens fakturanummer" htmlFor="invoiceNumber">
          <Input
            id="invoiceNumber"
            size="md"
            required
            maxLength={50}
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
          />
        </Field>
        <Field label="Fakturadatum" htmlFor="invoiceDate">
          <Input id="invoiceDate" type="date" size="sm" required value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Förfallodatum" htmlFor="dueDate">
          <Input id="dueDate" type="date" size="sm" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Nettobelopp" htmlFor="netAmount">
          <Input id="netAmount" type="number" step="0.01" size="sm" value={netAmount} onChange={(e) => setNetAmount(e.target.value)} />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Momssats" htmlFor="vatRate">
          <Select
            id="vatRate"
            size="xs"
            value={String(vatRate)}
            onChange={(e) => {
              setVatRate(Number(e.target.value));
              setVatTouched(false);
            }}
          >
            {VAT_RATES.map((rate) => (
              <option key={rate} value={String(rate)}>
                {rate} %
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Momsbelopp" htmlFor="vatAmount">
          <Input
            id="vatAmount"
            type="number"
            step="0.01"
            size="sm"
            value={vatAmount}
            onChange={(e) => {
              setVatTouched(true);
              setVatAmount(e.target.value);
            }}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Bruttobelopp" htmlFor="grossAmount">
          <Input
            id="grossAmount"
            type="number"
            step="0.01"
            size="sm"
            value={grossAmount}
            onChange={(e) => {
              setGrossTouched(true);
              setGrossAmount(e.target.value);
            }}
          />
        </Field>
      </FormRow>

      <Field label="Notering" htmlFor="invoiceNote">
        <Input id="invoiceNote" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      <Field label="Underlag — leverantörens faktura (PDF/bild)" htmlFor="invoiceFiles">
        <input
          id="invoiceFiles"
          type="file"
          multiple
          accept={UNDERLAG_ACCEPT}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        {/* Not `attached`: that offset is sized for text inputs and overlaps
            the browser's taller native file picker. */}
        <FormHint>PDF, JPEG eller PNG, max 20 MB per fil. Sparas som räkenskapsinformation på fakturan.</FormHint>
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa faktura"}
        </Button>
      </FormActions>
    </Form>
  );
}

function isEmptyAmount(value: string): boolean {
  return value.trim() === "" || Number(value) === 0;
}
