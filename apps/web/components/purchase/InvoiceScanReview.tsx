"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Modal } from "../ui/Modal";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Select } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { GatedLink } from "../ui/GatedLink";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { DimensionFields } from "../economy/DimensionSelect";
import { InvoiceRateField, SekAmountsLine } from "./InvoiceRateField";
import { useCan } from "../PermissionsProvider";
import { API_URL, apiFetch } from "../../lib/api";
import { documentSekAmounts, SEK } from "../../lib/currency";
import { confirmDelete } from "../../lib/confirm";
import { formatStockholmDate, formatStockholmDateTime } from "../../lib/date";
import { useDimensions } from "../../lib/dimensions";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, round2 } from "../../lib/format";
import {
  fieldIsLow,
  invoiceScanDisplayStatus,
  isPendingScan,
  newSupplierHref,
  SCAN_SOURCE_LABELS,
  INVOICE_SCAN_SOURCE_LABELS,
  type InvoiceScanDetail,
  type InvoiceScanEngine,
  type InvoiceScanResult,
  type ScanConfidence,
  type ScanField,
} from "../../lib/invoiceScan";
import { fetchPurchaseOrderBasis, basisRowsSum, type BasisQuantity } from "../../lib/supplierInvoiceBasis";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import { useInvoiceRate } from "../../lib/useExchangeRate";
import { purchaseOrderFallbackRate } from "../../lib/purchaseOrderFallbackRate";
import { useVatCodes } from "../../lib/useVatCodes";
import {
  chargedVatRate,
  domesticVatCodeForRate,
  supplierDefaultVatCode,
  supplierVatCodeNote,
  vatCodeChargesNoVat,
  vatCodeOptionLabel,
  vatCodesFor,
  type VatCode,
  type VatRate,
} from "../../lib/vatCodes";
import {
  PURCHASE_ORDER_STATUS_PILL,
  VAT_RATES,
  type Paged,
  type PurchaseOrder,
  type Supplier,
  type SupplierInvoiceDetail,
} from "../../lib/types";
import styles from "./InvoiceScanReview.module.css";

// Granskningen: the interpretation's proposal beside the original. The form
// has the fields of Ny leverantörsfaktura and is prefilled from `result` with
// the "manuellt vinner" rule — a field the user has touched is never written
// by a (re)interpretation, and an answer that arrives late (Tolka med AI takes
// up to a minute) only fills the untouched ones. The supplier invoice is
// created by POST /invoice-scans/:id/convert, which takes the body of
// POST /supplier-invoices.

type ReviewRow = {
  key: string;
  description: string;
  articleId: string | null;
  purchaseOrderRowId: string | null;
  quantity: string;
  unitPrice: string;
  // null for a row the user typed or the order basis built.
  confidence: ScanConfidence | null;
  origin: "scan" | "order" | "manual";
};

type FieldKey =
  | "supplier"
  | "invoiceNumber"
  | "invoiceDate"
  | "dueDate"
  | "reference"
  | "order"
  | "net"
  | "vat"
  | "gross"
  | "vatRate"
  | "vatCode"
  | "rows"
  | "note"
  | "dimensions";

const numStr = (value: number | null | undefined): string => (value === null || value === undefined ? "" : String(value));
const isEmptyAmount = (value: string): boolean => value.trim() === "" || Number(value) === 0;
const isVatRate = (value: number | null | undefined): value is VatRate =>
  value !== null && value !== undefined && (VAT_RATES as readonly number[]).includes(value);

let rowSeq = 0;
const nextRowKey = () => `row-${(rowSeq += 1)}`;

function rowsFromResult(result: InvoiceScanResult): ReviewRow[] {
  return result.rows.map((row) => {
    const quantity = row.quantity ?? 1;
    const unitPrice = row.unitPrice ?? (row.lineAmount !== null && quantity !== 0 ? round2(row.lineAmount / quantity) : 0);
    return {
      key: nextRowKey(),
      description: row.description,
      articleId: row.articleId,
      purchaseOrderRowId: row.purchaseOrderRowId,
      quantity: String(quantity),
      unitPrice: String(unitPrice),
      confidence: row.confidence,
      origin: "scan" as const,
    };
  });
}

// The note under a field: where an uncertain/learned/AI value comes from. Not
// shown once the user has typed in the field.
function FieldNote({
  field,
  touched,
  required,
}: {
  field: ScanField<unknown> | undefined;
  touched: boolean;
  required?: boolean;
}) {
  if (!field || touched) return null;
  const found = field.value !== null;
  const source = found ? SCAN_SOURCE_LABELS[field.source] : undefined;
  const low = found && fieldIsLow(field);
  const missing = !found && required;
  if (!source && !low && !missing) return null;
  return (
    <div className={styles.fieldNote}>
      {source && <span className={styles.chip}>{source}</span>}
      {low && <span className={styles.lowChip}>Osäker — kontrollera mot originalet</span>}
      {missing && <span className={styles.missing}>Hittades inte — fyll i för hand</span>}
    </div>
  );
}

function OriginalPanel({ scan, open, onToggle }: { scan: InvoiceScanDetail; open: boolean; onToggle: () => void }) {
  const [zoom, setZoom] = useState(1);
  const url = `${API_URL}/api/v1/invoice-scans/${scan.id}/file`;
  const isImage = scan.contentType.startsWith("image/");
  return (
    <section className={styles.original} aria-label="Originalet">
      <div className={styles.originalHead}>
        <div className={styles.originalTitle}>Originalet</div>
        <div className={styles.originalTools}>
          {open && isImage && (
            <>
              <Button type="button" variant="ghost" size="small" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z - 0.5))}>
                Förminska
              </Button>
              <Button type="button" variant="ghost" size="small" disabled={zoom >= 3} onClick={() => setZoom((z) => Math.min(3, z + 0.5))}>
                Förstora
              </Button>
            </>
          )}
          <a href={url} target="_blank" rel="noreferrer">
            Öppna i ny flik
          </a>
          <Button type="button" variant="secondary" size="small" aria-expanded={open} onClick={onToggle}>
            {open ? "Dölj originalet" : "Visa originalet"}
          </Button>
        </div>
      </div>
      {open && (
        <div className={styles.viewer}>
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.image} style={{ width: `${zoom * 100}%` }} src={url} alt={`Originalfaktura ${scan.filename}`} />
          ) : (
            <iframe className={styles.frame} src={url} title={`Originalfaktura ${scan.filename}`} />
          )}
        </div>
      )}
    </section>
  );
}

export function InvoiceScanReview({ initial, supplierIdParam }: { initial: InvoiceScanDetail; supplierIdParam: string | null }) {
  const router = useRouter();
  const can = useCan();
  const canWrite = can(["inkop"]);
  const [scan, setScan] = useState(initial);
  const [originalOpen, setOriginalOpen] = useState(true);
  const [interpreting, setInterpreting] = useState<InvoiceScanEngine | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = isPendingScan(scan);

  return (
    <>
      <div className={styles.layout} data-original={originalOpen ? "open" : "hidden"}>
        <OriginalPanel scan={scan} open={originalOpen} onToggle={() => setOriginalOpen((v) => !v)} />
        <section className={styles.panel} aria-label="Förslag">
          <StatusLine scan={scan} />
          <FormError>{actionError}</FormError>

          {pending ? (
            <ReviewForm
              scan={scan}
              canWrite={canWrite}
              supplierIdParam={supplierIdParam}
              interpreting={interpreting}
              setInterpreting={setInterpreting}
              setScan={setScan}
              setActionError={setActionError}
              onReject={() => setRejectOpen(true)}
            />
          ) : scan.status === "converted" ? (
            <ConvertedView scan={scan} />
          ) : (
            <RejectedView
              scan={scan}
              canWrite={canWrite}
              busy={busy}
              onRestore={async () => {
                setActionError(null);
                setBusy(true);
                try {
                  setScan(await apiFetch<InvoiceScanDetail>(`/api/v1/invoice-scans/${scan.id}/restore`, { method: "POST" }));
                  router.refresh();
                } catch (err) {
                  setActionError(apiErrorMessage(err, "Kunde inte återställa fakturan"));
                } finally {
                  setBusy(false);
                }
              }}
              onDelete={async () => {
                if (!(await confirmDelete(`Radera ${scan.scanNumber} (${scan.filename}) för alltid? Filen tas bort.`))) return;
                setActionError(null);
                setBusy(true);
                try {
                  await apiFetch(`/api/v1/invoice-scans/${scan.id}`, { method: "DELETE" });
                  router.push("/inkop/fakturainkorg?status=rejected");
                } catch (err) {
                  setActionError(apiErrorMessage(err, "Kunde inte radera fakturan"));
                  setBusy(false);
                }
              }}
            />
          )}
        </section>
      </div>

      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title="Avvisa faktura" compact>
        <RejectForm
          scan={scan}
          onDone={(updated) => {
            setRejectOpen(false);
            setScan(updated);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

function StatusLine({ scan }: { scan: InvoiceScanDetail }) {
  const pill = invoiceScanDisplayStatus({ status: scan.status, uncertain: scan.uncertain });
  return (
    <div className={styles.statusLine}>
      <StatusPill status={pill.status} label={pill.label} />
      <span>{INVOICE_SCAN_SOURCE_LABELS[scan.source]}</span>
      {scan.source === "email" && scan.emailFrom && <span>från {scan.emailFrom}</span>}
      {scan.source === "email" && scan.emailSubject && <span>”{scan.emailSubject}”</span>}
      <span>Inkommen {formatStockholmDateTime(scan.emailReceivedAt ?? scan.createdAt)}</span>
      {scan.interpretedBy && <span>Tolkad av {scan.interpretedBy === "ai" ? "AI" : "reglerna"}</span>}
      {scan.pageCount !== null && <span>{scan.pageCount} {scan.pageCount === 1 ? "sida" : "sidor"}</span>}
    </div>
  );
}

function ConvertedView({ scan }: { scan: InvoiceScanDetail }) {
  // What was created (the values typed in on Skapa), else the proposal.
  const created = scan.createdInvoice ?? null;
  const invoiceNumber = created ? created.invoiceNumber : scan.result?.invoiceNumber.value;
  const invoiceDate = created ? created.invoiceDate : scan.result?.invoiceDate.value;
  const gross = created ? created.grossAmount : scan.result?.grossAmount.value;
  const currency = created ? created.currency : scan.result?.currency.value;
  return (
    <>
      <FormHint>
        Fakturan är skapad som leverantörsfaktura
        {scan.supplierInvoiceId && (
          <>
            {" "}
            <GatedLink href={`/inkop/leverantorsfakturor/${scan.supplierInvoiceId}`}>
              {scan.supplierInvoiceRegistrationNumber ?? "Öppna leverantörsfakturan"}
            </GatedLink>
          </>
        )}
        . Filen ligger nu som underlag på leverantörsfakturan, och därifrån attesteras fakturan som vanligt.
      </FormHint>
      <dl className={styles.readonlyList} style={{ marginTop: 16 }}>
        <dt>Filnamn</dt>
        <dd>{scan.filename}</dd>
        <dt>Leverantör</dt>
        <dd>{created?.supplierName ?? scan.supplierName ?? "–"}</dd>
        <dt>Fakturanummer</dt>
        <dd>{invoiceNumber ?? "–"}</dd>
        <dt>Fakturadatum</dt>
        <dd>{invoiceDate ?? "–"}</dd>
        <dt>Att betala</dt>
        <dd>{gross != null ? `${formatMoney(gross)} ${currency ?? ""}`.trim() : "–"}</dd>
      </dl>
    </>
  );
}

function RejectedView({
  scan,
  canWrite,
  busy,
  onRestore,
  onDelete,
}: {
  scan: InvoiceScanDetail;
  canWrite: boolean;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <FormNotice>
        Avvisad{scan.rejectedAt ? ` ${formatStockholmDate(scan.rejectedAt)}` : ""}
        {scan.rejectedByName ? ` av ${scan.rejectedByName}` : ""}
        {scan.rejectedReason ? `: ${scan.rejectedReason}` : "."}
      </FormNotice>
      <FormHint>
        En avvisad faktura räknas inte som att granska. <strong>Återställ</strong> lägger tillbaka den i inkorgen,{" "}
        <strong>Radera</strong> tar bort posten och filen för alltid.
      </FormHint>
      {canWrite && (
        <FormActions>
          <Button type="button" variant="primary" disabled={busy} onClick={onRestore}>
            Återställ
          </Button>
          <Button type="button" variant="danger" disabled={busy} onClick={onDelete}>
            Radera
          </Button>
        </FormActions>
      )}
    </>
  );
}

function RejectForm({ scan, onDone }: { scan: InvoiceScanDetail; onDone: (scan: InvoiceScanDetail) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Ange en orsak");
      return;
    }
    setError(null);
    setPending(true);
    try {
      onDone(
        await apiFetch<InvoiceScanDetail>(`/api/v1/invoice-scans/${scan.id}/reject`, {
          method: "POST",
          body: JSON.stringify({ reason: reason.trim() }),
        })
      );
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte avvisa fakturan"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <FormHint>
        {scan.scanNumber} flyttas till <strong>Avvisade</strong>. Den kan återställas eller raderas därifrån.
      </FormHint>
      <Field label="Orsak" htmlFor="rejectReason">
        <Input id="rejectReason" required maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="T.ex. Reklam, Dubblett, Fel mottagare" />
      </Field>
      <FormActions>
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "Avvisar…" : "Avvisa"}
        </Button>
      </FormActions>
    </Form>
  );
}

function ReviewForm({
  scan,
  canWrite,
  supplierIdParam,
  interpreting,
  setInterpreting,
  setScan,
  setActionError,
  onReject,
}: {
  scan: InvoiceScanDetail;
  canWrite: boolean;
  supplierIdParam: string | null;
  interpreting: InvoiceScanEngine | null;
  setInterpreting: (engine: InvoiceScanEngine | null) => void;
  setScan: (scan: InvoiceScanDetail) => void;
  setActionError: (error: string | null) => void;
  onReject: () => void;
}) {
  const router = useRouter();
  const result = scan.result;
  // Fields the user has typed in — a (re)interpretation never writes them.
  const touched = useRef(new Set<FieldKey>());
  const touch = (key: FieldKey) => {
    touched.current.add(key);
  };
  const isTouched = (key: FieldKey) => touched.current.has(key);

  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const supplierRef = useRef<Supplier | null>(null);
  supplierRef.current = supplier;
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [refKind, setRefKind] = useState<"ocr" | "message">("ocr");
  const [refValue, setRefValue] = useState("");
  const [orderId, setOrderId] = useState("");
  const [qtyBasis, setQtyBasis] = useState<BasisQuantity>("received");
  const [netAmount, setNetAmount] = useState("");
  const [vatAmount, setVatAmount] = useState("");
  const [grossAmount, setGrossAmount] = useState("");
  const [vatRate, setVatRate] = useState<number>(25);
  const [vatCodeId, setVatCodeId] = useState("");
  const [note, setNote] = useState("");
  const [costCenterId, setCostCenterId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, setNavigating] = useState(false);

  const dims = useDimensions();
  const { codes: vatCodes } = useVatCodes();

  // --- Supplier ---
  const supplierSeq = useRef(0);
  function loadSupplier(id: string | null) {
    const seq = (supplierSeq.current += 1);
    if (!id) {
      setSupplier(null);
      return;
    }
    apiFetch<Supplier>(`/api/v1/suppliers/${id}`)
      .then((s) => {
        // A later request (or a pick in the list) wins over a slow answer.
        if (seq === supplierSeq.current) setSupplier(s);
      })
      .catch(() => {
        if (seq === supplierSeq.current) setError("Kunde inte hämta den matchade leverantören");
      });
  }

  // --- Prefill from the result ---
  const scanRateRef = useRef<number | null>(null);
  const wantBasisRef = useRef<string | null>(null);
  const ordersRef = useRef<PurchaseOrder[]>([]);
  const netRef = useRef(netAmount);
  netRef.current = netAmount;
  const basisSeq = useRef(0);

  // Writes a new net/vat/gross triple the way the dialog derives them: VAT
  // follows net × rate and gross follows net + VAT, each until typed in.
  function deriveAmounts(next: { net: string; vat?: string; gross?: string; rate: number }) {
    const net = Number(next.net);
    const hasNet = next.net.trim() !== "" && Number.isFinite(net);
    let vat = Number(next.vat ?? vatAmount);
    if (!isTouched("vat")) {
      vat = hasNet ? round2((net * next.rate) / 100) : 0;
      setVatAmount(hasNet ? String(vat) : "");
    }
    if (!isTouched("gross")) {
      setGrossAmount(hasNet ? String(round2(net + (Number.isFinite(vat) ? vat : 0))) : "");
    }
  }

  async function loadBasis(forOrderId: string, quantity: BasisQuantity, auto: boolean) {
    const seq = (basisSeq.current += 1);
    try {
      const built = await fetchPurchaseOrderBasis(forOrderId, quantity);
      if (seq !== basisSeq.current) return;
      // An automatic proposal never overwrites rows the user has touched.
      if (auto && isTouched("rows")) return;
      setRows(
        built.map((row) => ({
          key: nextRowKey(),
          description: row.description,
          articleId: row.articleId,
          purchaseOrderRowId: row.purchaseOrderRowId ?? null,
          quantity: String(row.quantity),
          unitPrice: String(row.unitPrice),
          confidence: null,
          origin: "order" as const,
        }))
      );
      // Same as Hämta orderrader on Ny leverantörsfaktura: an empty net is
      // filled from the row sum, the VAT and gross follow from it.
      if (isEmptyAmount(netRef.current) && !isTouched("net")) {
        const sum = String(basisRowsSum(built));
        setNetAmount(sum);
        deriveAmounts({ net: sum, rate: vatRate });
      }
    } catch (err) {
      if (!auto && seq === basisSeq.current) setError(err instanceof Error ? err.message : "Kunde inte hämta orderraderna");
    }
  }

  function maybeLoadBasis() {
    const wanted = wantBasisRef.current;
    if (wanted && ordersRef.current.some((o) => o.id === wanted)) {
      wantBasisRef.current = null;
      void loadBasis(wanted, "received", true);
    }
  }

  function applyResult(next: InvoiceScanResult) {
    scanRateRef.current = next.vatRate.value;
    // A supplier picked by hand that is not the interpretation's: the
    // proposal's purchase order and its row links belong to another supplier.
    const otherSupplier = isTouched("supplier") && supplierRef.current?.id !== next.supplier.matchedSupplierId;
    if (!isTouched("supplier")) loadSupplier(next.supplier.matchedSupplierId);
    if (!isTouched("invoiceNumber")) setInvoiceNumber(next.invoiceNumber.value ?? "");
    if (!isTouched("invoiceDate")) setInvoiceDate(next.invoiceDate.value ?? "");
    if (!isTouched("dueDate")) setDueDate(next.dueDate.value ?? "");
    if (!isTouched("reference")) {
      setRefKind(next.paymentReference.value?.kind ?? "ocr");
      setRefValue(next.paymentReference.value?.value ?? "");
    }
    if (!isTouched("net")) setNetAmount(numStr(next.netAmount.value));
    if (!isTouched("vat")) setVatAmount(numStr(next.vatAmount.value));
    if (!isTouched("gross")) setGrossAmount(numStr(next.grossAmount.value));
    if (!isTouched("vatRate") && isVatRate(next.vatRate.value)) setVatRate(next.vatRate.value);
    if (!isTouched("order")) setOrderId(scan.poMatching && !otherSupplier ? (next.purchaseOrderId.value ?? "") : "");
    if (!isTouched("rows")) {
      if (next.rows.length > 0) {
        wantBasisRef.current = null;
        const proposed = rowsFromResult(next);
        setRows(otherSupplier ? proposed.map((row) => ({ ...row, purchaseOrderRowId: null })) : proposed);
      } else {
        setRows([]);
        // The purchase order is proposed without rows from the AI: build the
        // rows the way Hämta orderrader does, once the supplier's orders are
        // loaded.
        wantBasisRef.current = scan.poMatching && !otherSupplier ? next.purchaseOrderId.value : null;
        maybeLoadBasis();
      }
    }
  }

  // First fill, once. A supplier created via Skapa leverantör comes back as
  // ?supplierId= and counts as typed in.
  useEffect(() => {
    if (supplierIdParam) {
      touch("supplier");
      loadSupplier(supplierIdParam);
    }
    if (result) applyResult(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Purchase orders of the supplier ---
  const supplierId = supplier?.id ?? "";
  useEffect(() => {
    ordersRef.current = [];
    setOrders([]);
    if (!supplierId) return;
    let cancelled = false;
    apiFetch<Paged<PurchaseOrder>>(
      `/api/v1/purchase-orders?supplierId=${supplierId}&status=received,partially_received,closed&limit=1000`
    )
      .then((res) => {
        if (cancelled) return;
        ordersRef.current = res.rows;
        setOrders(res.rows);
        maybeLoadBasis();
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId]);

  // --- Momskod follows the supplier (as in Ny leverantörsfaktura) ---
  useEffect(() => {
    if (!supplier || vatCodes.length === 0) return;
    if (isTouched("vatCode")) return;
    const usable = vatCodesFor(vatCodes, "purchase");
    const own = supplier.defaultVatCodeId ? usable.find((code) => code.id === supplier.defaultVatCodeId) : undefined;
    let derivedCode: VatCode = supplierDefaultVatCode(supplier.country || "SE");
    // A Swedish supplier that charged 12 or 6 % gets the matching domestic code.
    const scanRate = scanRateRef.current;
    if (!own && derivedCode === "MP25" && isVatRate(scanRate)) derivedCode = domesticVatCodeForRate(scanRate);
    const next = own ?? usable.find((code) => code.code === derivedCode);
    setVatCodeId(next?.id ?? "");
    if (!isTouched("vatRate")) {
      if (next && vatCodeChargesNoVat(next.code)) setVatRate(0);
      else setVatRate(next ? chargedVatRate(next.code) : isVatRate(scanRate) ? scanRate : 25);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId, vatCodes]);

  // --- Valuta ---
  const invoiceCurrency = supplier?.currency.trim().toUpperCase() ?? SEK;
  const foreignCurrency = supplier !== null && invoiceCurrency !== SEK;
  // A chosen purchase order's rate is what the conversion falls back on.
  const invoiceRate = useInvoiceRate({
    currency: foreignCurrency ? invoiceCurrency : null,
    date: invoiceDate,
    fallbackRate: purchaseOrderFallbackRate(orders.find((o) => o.id === orderId) ?? null, foreignCurrency ? invoiceCurrency : null),
  });
  const scanCurrency = result?.currency.value?.trim().toUpperCase() ?? null;
  const currencyMismatch = supplier !== null && scanCurrency !== null && scanCurrency !== invoiceCurrency;

  const pickedVatCode = vatCodes.find((code) => code.id === vatCodeId);
  const vatRateLocked = pickedVatCode !== undefined && vatCodeChargesNoVat(pickedVatCode.code);
  const vatCodeNote = pickedVatCode ? supplierVatCodeNote(pickedVatCode.code) : null;

  const rateNumber = Number(invoiceRate.rate.replace(",", "."));
  const sekPreview =
    foreignCurrency && Number.isFinite(rateNumber) && rateNumber > 0 && grossAmount.trim() !== ""
      ? documentSekAmounts({
          rate: rateNumber,
          grossAmount: Number(grossAmount) || 0,
          vatAmount: Number(vatAmount) || 0,
          rows: [],
        })
      : null;

  const dirty = touched.current.size > 0 && !navigating;
  useUnsavedGuard(dirty);

  const busy = interpreting !== null || submitting;

  async function interpret(engine: InvoiceScanEngine) {
    setActionError(null);
    setError(null);
    setInterpreting(engine);
    try {
      const updated = await apiFetch<InvoiceScanDetail>(`/api/v1/invoice-scans/${scan.id}/interpret`, {
        method: "POST",
        body: JSON.stringify({ engine }),
      });
      setScan(updated);
      if (updated.result) applyResult(updated.result);
    } catch (err) {
      setActionError(apiErrorMessage(err, "Kunde inte tolka fakturan"));
    } finally {
      setInterpreting(null);
    }
  }

  function setRow(key: string, patch: Partial<ReviewRow>) {
    touch("rows");
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch, confidence: patch.confidence ?? r.confidence } : r)));
  }

  function addRow() {
    touch("rows");
    setRows((all) => [
      ...all,
      {
        key: nextRowKey(),
        description: "",
        articleId: null,
        purchaseOrderRowId: null,
        quantity: "1",
        unitPrice: "0",
        confidence: null,
        origin: "manual",
      },
    ]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!supplier) {
      setError("Välj en leverantör");
      return;
    }
    for (const [index, row] of rows.entries()) {
      if (!row.description.trim()) {
        setError(`Rad ${index + 1} saknar beskrivning`);
        return;
      }
      if (!(Number(row.quantity) > 0)) {
        setError(`Rad ${index + 1} måste ha ett antal över 0`);
        return;
      }
    }
    setError(null);
    setSubmitting(true);
    try {
      const invoice = await apiFetch<SupplierInvoiceDetail>(`/api/v1/invoice-scans/${scan.id}/convert`, {
        method: "POST",
        body: JSON.stringify({
          supplierId: supplier.id,
          invoiceNumber: invoiceNumber.trim(),
          invoiceDate,
          dueDate: dueDate.trim() || undefined,
          netAmount: netAmount.trim() ? Number(netAmount) : 0,
          vatAmount: vatAmount.trim() ? Number(vatAmount) : 0,
          grossAmount: grossAmount.trim() ? Number(grossAmount) : 0,
          note: note.trim() || undefined,
          paymentReference: refValue.trim() ? { kind: refKind, value: refValue.trim() } : undefined,
          // Only an order of this supplier's loaded list.
          purchaseOrderId: orderId && orders.some((o) => o.id === orderId) ? orderId : undefined,
          vatCodeId: vatCodeId || undefined,
          // Only a rate typed in; otherwise the API looks it up for the date.
          exchangeRate:
            foreignCurrency && invoiceRate.touched && invoiceRate.rate.trim() !== "" ? rateNumber : undefined,
          costCenterId: costCenterId || undefined,
          projectId: projectId || undefined,
          rows: rows.map((row) => ({
            description: row.description.trim(),
            articleId: row.articleId,
            purchaseOrderRowId: row.purchaseOrderRowId,
            quantity: Number(row.quantity),
            unitPrice: Number(row.unitPrice || 0),
          })),
        }),
      });
      setNavigating(true);
      router.push(`/inkop/leverantorsfakturor/${invoice.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa leverantörsfakturan"));
      setSubmitting(false);
    }
  }

  // Tolka igen only where the rules can read something: a PDF with a text
  // layer (or one whose text layer is not known yet). For an image or a
  // scanned PDF it would only repeat the check — the AI result stays anyway.
  const canRunRules = scan.resultOutdated || (scan.contentType === "application/pdf" && scan.hasTextLayer !== false);
  const checks = result?.checks ?? [];
  const noSupplierMatch = result !== null && supplier === null && !isTouched("supplier");

  return (
    <Form onSubmit={submit}>
      {/* --- What the interpretation says about itself --- */}
      <div className={styles.notices}>
        {scan.resultOutdated && (
          <FormNotice>Förslaget är sparat i ett äldre format och kan inte visas — tryck Tolka igen.</FormNotice>
        )}
        {scan.aiError && <FormNotice>AI-tolkningen misslyckades: {scan.aiError}</FormNotice>}
        {result?.duplicateOf && (
          <FormNotice>
            Leverantören har redan en faktura med det här fakturanumret:{" "}
            <GatedLink href={`/inkop/leverantorsfakturor/${result.duplicateOf.supplierInvoiceId}`}>
              {result.duplicateOf.registrationNumber}
            </GatedLink>
            . Är det en dubblett — välj Avvisa.
          </FormNotice>
        )}
        {checks.length > 0 && (
          <FormNotice>
            <ul className={styles.noticeList}>
              {checks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          </FormNotice>
        )}
        {scan.uncertain && (
          <FormNotice>
            Osäker — något av leverantör, fakturanummer, datum eller belopp är inte säkert tolkat. Kontrollera mot
            originalet innan du skapar fakturan.
          </FormNotice>
        )}
        {result?.isCreditNote.value && <FormNotice>Fakturan ser ut att vara en kreditnota — beloppen ska vara negativa.</FormNotice>}
      </div>

      {canWrite && (
        <div className={styles.toolbar}>
          {canRunRules && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void interpret("rules")}>
              {interpreting === "rules" ? "Tolkar…" : "Tolka igen"}
            </Button>
          )}
          {scan.aiAvailable && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void interpret("ai")}>
              {interpreting === "ai" ? "Tolkar…" : "Tolka med AI"}
            </Button>
          )}
          {interpreting === "ai" && (
            <FormHint>AI-tolkningen kan ta upp till en minut. Fälten du redan har ändrat rörs inte.</FormHint>
          )}
        </div>
      )}

      <FormError>{error}</FormError>

      {/* --- Leverantör --- */}
      <Field label="Leverantör" htmlFor="scanSupplier">
        <SearchPicker
          id="scanSupplier"
          endpoint="/api/v1/suppliers"
          value={supplier}
          onChange={(s) => {
            touch("supplier");
            supplierSeq.current += 1;
            if (s?.id !== supplier?.id) {
              // Another supplier: the purchase order and every link to its
              // rows belonged to the old one (as on Ny leverantörsfaktura).
              setOrderId("");
              wantBasisRef.current = null;
              basisSeq.current += 1;
              setRows((all) =>
                all.filter((row) => row.origin !== "order").map((row) => ({ ...row, purchaseOrderRowId: null }))
              );
            }
            setSupplier(s);
          }}
          formatLabel={(s) => `${s.supplierNumber} — ${s.name}`}
          placeholder="Sök leverantörnummer eller namn…"
          emptyText="Inga leverantörer matchar sökningen"
        />
        {result && !isTouched("supplier") && supplier && (
          <div className={styles.fieldNote}>
            {result.supplier.confidence === "low" ? (
              <span className={styles.lowChip}>Osäker — kontrollera leverantören mot originalet</span>
            ) : (
              <span className={styles.chip}>Matchad</span>
            )}
          </div>
        )}
      </Field>
      {noSupplierMatch && (
        <FormNotice>
          {result.supplier.candidates.length > 1
            ? "Flera leverantörer passar fakturan — välj rätt i listan ovan."
            : "Ingen leverantör matchade fakturan."}
          {result.supplier.name.value ? ` Fakturan är från ${result.supplier.name.value}.` : ""}{" "}
          {canWrite && (
            <Link
              href={newSupplierHref(result.supplier, `/inkop/fakturainkorg/${scan.id}`)}
              className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.small}`}
            >
              Skapa leverantör
            </Link>
          )}
        </FormNotice>
      )}
      {currencyMismatch && (
        <FormNotice>
          Fakturan anger valutan {scanCurrency}, men leverantören fakturerar i {invoiceCurrency} — kontrollera beloppen.
        </FormNotice>
      )}

      <FormRow>
        <Field label="Leverantörens fakturanummer" htmlFor="scanInvoiceNumber">
          <Input
            id="scanInvoiceNumber"
            size="md"
            required
            maxLength={50}
            value={invoiceNumber}
            onChange={(e) => {
              touch("invoiceNumber");
              setInvoiceNumber(e.target.value);
            }}
          />
          <FieldNote field={result?.invoiceNumber} touched={isTouched("invoiceNumber")} required />
        </Field>
        <Field label="Fakturadatum" htmlFor="scanInvoiceDate">
          <Input
            id="scanInvoiceDate"
            type="date"
            size="sm"
            required
            value={invoiceDate}
            onChange={(e) => {
              touch("invoiceDate");
              setInvoiceDate(e.target.value);
            }}
          />
          <FieldNote field={result?.invoiceDate} touched={isTouched("invoiceDate")} required />
        </Field>
      </FormRow>

      {foreignCurrency && (
        <>
          <FormHint>
            Leverantören fakturerar i {invoiceCurrency} — ange beloppen i {invoiceCurrency}. Kursen räknar om dem till
            SEK, och fakturan bokförs i SEK när den godkänns.
          </FormHint>
          <InvoiceRateField id="scanInvoiceRate" currency={invoiceCurrency} invoiceRate={invoiceRate} />
        </>
      )}

      <FormRow>
        <Field label="Förfallodatum" htmlFor="scanDueDate">
          <Input
            id="scanDueDate"
            type="date"
            size="sm"
            value={dueDate}
            onChange={(e) => {
              touch("dueDate");
              setDueDate(e.target.value);
            }}
          />
          <FieldNote field={result?.dueDate} touched={isTouched("dueDate")} />
        </Field>
        <Field label="Betalningsreferens" htmlFor="scanRefValue">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Select
              id="scanRefKind"
              size="sm"
              aria-label="Typ av betalningsreferens"
              value={refKind}
              onChange={(e) => {
                touch("reference");
                setRefKind(e.target.value as "ocr" | "message");
              }}
            >
              <option value="ocr">OCR</option>
              <option value="message">Meddelande</option>
            </Select>
            <Input
              id="scanRefValue"
              size="md"
              maxLength={140}
              value={refValue}
              onChange={(e) => {
                touch("reference");
                setRefValue(e.target.value);
              }}
            />
          </div>
          <FieldNote field={result?.paymentReference} touched={isTouched("reference")} />
        </Field>
      </FormRow>

      {/* --- Inköpsorder --- */}
      {supplierId && orders.length > 0 && (
        <>
          <FormRow>
            <Field label="Inköpsorder" htmlFor="scanOrder">
              <Select
                id="scanOrder"
                value={orderId}
                onChange={(e) => {
                  touch("order");
                  setOrderId(e.target.value);
                }}
              >
                <option value="">— Ingen —</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.orderNumber} · {PURCHASE_ORDER_STATUS_PILL[o.status].label}
                  </option>
                ))}
              </Select>
              <FieldNote field={result?.purchaseOrderId} touched={isTouched("order")} />
            </Field>
            <Field label="Antal" htmlFor="scanQtyBasis">
              <Select id="scanQtyBasis" value={qtyBasis} onChange={(e) => setQtyBasis(e.target.value as BasisQuantity)}>
                <option value="received">Mottaget antal</option>
                <option value="ordered">Beställt antal</option>
              </Select>
            </Field>
          </FormRow>
          <div>
            <Button
              type="button"
              variant="secondary"
              disabled={!orderId || busy}
              onClick={() => {
                touch("rows");
                void loadBasis(orderId, qtyBasis, false);
              }}
            >
              Hämta orderrader
            </Button>
          </div>
        </>
      )}
      {supplierId && orders.length === 0 && (
        <FormHint attached>Leverantören har inga inlevererade inköpsorder att hämta från.</FormHint>
      )}

      {/* --- Belopp --- */}
      <Field label="Momskod" htmlFor="scanVatCode">
        <Select
          id="scanVatCode"
          value={vatCodeId}
          onChange={(e) => {
            const picked = vatCodes.find((code) => code.id === e.target.value);
            touch("vatCode");
            setVatCodeId(e.target.value);
            if (picked) {
              const rate = chargedVatRate(picked.code);
              setVatRate(rate);
              touched.current.delete("vat");
              touched.current.delete("gross");
              deriveAmounts({ net: netAmount, rate });
            }
          }}
        >
          <option value="">Leverantörens förval</option>
          {vatCodesFor(vatCodes, "purchase", vatCodeId).map((code) => (
            <option key={code.id} value={code.id}>
              {vatCodeOptionLabel(code)}
            </option>
          ))}
        </Select>
        {vatCodeNote && <FormHint>{vatCodeNote}</FormHint>}
      </Field>

      <FormRow>
        <Field label={`Nettobelopp${foreignCurrency ? ` (${invoiceCurrency})` : ""}`} htmlFor="scanNet">
          <Input
            id="scanNet"
            type="number"
            step="0.01"
            size="sm"
            value={netAmount}
            onChange={(e) => {
              touch("net");
              setNetAmount(e.target.value);
              deriveAmounts({ net: e.target.value, rate: vatRateLocked ? 0 : vatRate });
            }}
          />
          <FieldNote field={result?.netAmount} touched={isTouched("net")} />
        </Field>
        <Field label="Momssats" htmlFor="scanVatRate">
          <Select
            id="scanVatRate"
            size="xs"
            value={String(vatRateLocked ? 0 : vatRate)}
            disabled={vatRateLocked}
            onChange={(e) => {
              const rate = Number(e.target.value);
              touch("vatRate");
              setVatRate(rate);
              touched.current.delete("vat");
              touched.current.delete("gross");
              deriveAmounts({ net: netAmount, rate });
            }}
          >
            {VAT_RATES.map((rate) => (
              <option key={rate} value={String(rate)}>
                {rate} %
              </option>
            ))}
          </Select>
          {vatRateLocked && <FormHint>Låst till 0 % — momskoden tar ingen debiterad moms.</FormHint>}
        </Field>
      </FormRow>

      <FormRow>
        <Field label={`Momsbelopp${foreignCurrency ? ` (${invoiceCurrency})` : ""}`} htmlFor="scanVat">
          <Input
            id="scanVat"
            type="number"
            step="0.01"
            size="sm"
            value={vatAmount}
            onChange={(e) => {
              touch("vat");
              setVatAmount(e.target.value);
              if (!isTouched("gross")) {
                const net = Number(netAmount);
                const vat = Number(e.target.value);
                if (netAmount.trim() !== "" && Number.isFinite(net)) {
                  setGrossAmount(String(round2(net + (Number.isFinite(vat) ? vat : 0))));
                }
              }
            }}
          />
          <FieldNote field={result?.vatAmount} touched={isTouched("vat")} />
        </Field>
        <Field label={`Bruttobelopp${foreignCurrency ? ` (${invoiceCurrency})` : ""}`} htmlFor="scanGross">
          <Input
            id="scanGross"
            type="number"
            step="0.01"
            size="sm"
            value={grossAmount}
            onChange={(e) => {
              touch("gross");
              setGrossAmount(e.target.value);
            }}
          />
          <FieldNote field={result?.grossAmount} touched={isTouched("gross")} required />
        </Field>
      </FormRow>

      {vatRateLocked && Number(vatAmount) !== 0 && vatAmount.trim() !== "" && (
        <FormNotice>
          Momsbelopp ska vara 0 med den här momskoden — fakturan kan annars inte godkännas. Välj en svensk momskod om
          leverantören har debiterat moms.
        </FormNotice>
      )}

      {sekPreview && <SekAmountsLine amounts={sekPreview} label="I SEK vid godkännande" />}

      <DimensionFields
        idPrefix="scan"
        lists={dims}
        costCenterId={costCenterId}
        projectId={projectId}
        onCostCenterChange={(id) => {
          touch("dimensions");
          setCostCenterId(id);
        }}
        onProjectChange={(id) => {
          touch("dimensions");
          setProjectId(id);
        }}
      />

      <Field label="Notering" htmlFor="scanNote">
        <Input
          id="scanNote"
          value={note}
          onChange={(e) => {
            touch("note");
            setNote(e.target.value);
          }}
        />
      </Field>

      {/* --- Rader --- */}
      <SectionHeading
        spaced
        actions={
          <Button type="button" variant="secondary" size="small" onClick={addRow}>
            + Rad
          </Button>
        }
      >
        Rader
      </SectionHeading>
      {rows.length === 0 && (
        <FormHint attached>
          Inga rader. Fakturan kan skapas utan rader — beloppen i huvudet är det som gäller — eller så läggs raderna
          till här eller på leverantörsfakturan.
        </FormHint>
      )}
      {rows.map((row, index) => (
        <div key={row.key} className={styles.rowCard}>
          <div className={styles.rowHead}>
            <span className={styles.rowTitle}>
              Rad {index + 1}
              {row.purchaseOrderRowId ? " · kopplad till inköpsorderrad" : ""}
            </span>
            <span className={styles.fieldNote} style={{ marginTop: 0 }}>
              {row.origin === "order" && <span className={styles.chip}>Från inköpsorder</span>}
              {row.origin === "scan" && row.confidence === "low" && <span className={styles.lowChip}>Osäker</span>}
              <Button
                type="button"
                variant="danger"
                size="small"
                onClick={() => {
                  touch("rows");
                  setRows((all) => all.filter((r) => r.key !== row.key));
                }}
              >
                Ta bort
              </Button>
            </span>
          </div>
          <Field label="Beskrivning" htmlFor={`scanRowDesc-${row.key}`}>
            <Input
              id={`scanRowDesc-${row.key}`}
              maxLength={255}
              value={row.description}
              onChange={(e) => setRow(row.key, { description: e.target.value })}
            />
          </Field>
          <FormRow columns={3}>
            <Field label="Antal" htmlFor={`scanRowQty-${row.key}`}>
              <Input
                id={`scanRowQty-${row.key}`}
                type="number"
                min="0"
                step="any"
                value={row.quantity}
                onChange={(e) => setRow(row.key, { quantity: e.target.value })}
              />
            </Field>
            <Field label="À-pris" htmlFor={`scanRowPrice-${row.key}`}>
              <Input
                id={`scanRowPrice-${row.key}`}
                type="number"
                step="0.01"
                value={row.unitPrice}
                onChange={(e) => setRow(row.key, { unitPrice: e.target.value })}
              />
            </Field>
            <Field label="Belopp" htmlFor={`scanRowAmount-${row.key}`}>
              <div id={`scanRowAmount-${row.key}`} className={styles.rowAmount}>
                {formatMoney(round2(Number(row.quantity || 0) * Number(row.unitPrice || 0)))}
              </div>
            </Field>
          </FormRow>
        </div>
      ))}

      {canWrite && (
        <FormActions>
          <Button type="submit" variant="primary" disabled={busy}>
            {submitting ? "Skapar…" : "Skapa leverantörsfaktura"}
          </Button>
          <Button type="button" variant="danger" disabled={busy} onClick={onReject}>
            Avvisa…
          </Button>
        </FormActions>
      )}
      <FormHint>
        Leverantörsfakturan skapas som utkast med filen som underlag. Den attesteras och bokförs som vanligt — inget
        sker automatiskt.
      </FormHint>
    </Form>
  );
}
