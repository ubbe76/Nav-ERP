"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { hasUnsavedDrafts, useUnsavedGuard } from "../../lib/unsavedGuard";
import { notify } from "../../lib/notice";
import { usePlaceLabels } from "../stock/WarehouseMode";
import { useMemo, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { RowDeviationLink } from "../quality/RowDeviationLink";
import { newDeviationHref, type NewDeviationParams } from "../../lib/quality";
import { RowMenu } from "../ui/RowMenu";
import { DeliveryAddressForm, formatDeliveryAddress } from "./DeliveryAddressForm";
import { ChangeSupplierDialog, type SupplierChangePreview } from "./ChangeSupplierDialog";
import { useCan } from "../PermissionsProvider";
import { ArticleOverviewButton } from "../articles/ArticleOverviewButton";
import { ArticleLink } from "../articles/ArticleLink";
import { useRouter } from "next/navigation";
import { Table, shareTrack } from "../ui/Table";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Modal } from "../ui/Modal";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { UnitSelect, convertPriceInput, convertQuantityInput, convertStoredPriceInput, convertStoredQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { DocumentHeaderCard } from "../documents/DocumentHeaderCard";
import { DocumentActionBar } from "../documents/DocumentActionBar";
import { ManualStatusChange } from "../documents/ManualStatusChange";
import { TermsFields, termsFrom, termsLabel, termsPayload, type TermsRegisters, type TermsValue } from "../documents/TermsFields";
import { toBaseQuantity, toUnitPrice, toUnitQuantity } from "../../lib/units";
import { requoteFor } from "../../lib/rowRequote";
import { formatMoney, formatUnitPrice, formatQuantity, round2 } from "../../lib/format";
import { currencyLabel } from "../../lib/currency";
import { apiFetch } from "../../lib/api";
import { useSupplierDeliveryDateSuggestion } from "../../lib/useDeliveryDateSuggestion";
import { DeliveryDateHint } from "../ui/DeliveryDateHint";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { askBumpRevision } from "../../lib/revision";
import { headerDimensionFields, useDimensions } from "../../lib/dimensions";
import { DimensionFields } from "../economy/DimensionSelect";
import {
  PURCHASE_ORDER_STATUS_PILL,
  type Article,
  type PurchaseOrder,
  type PurchaseOrderRow,
  type StockLocation,
  type SupplierPriceQuote,
} from "../../lib/types";
import { alreadyOnDocumentText } from "../../lib/orderRowDuplicates";
import { DocumentIdentity } from "../documents/DocumentIdentity";
import { StatusStepper } from "../documents/StatusStepper";
import { CardTabs, type CardTab } from "../documents/CardTabs";
import { HeaderCell, HeaderEditor, HeaderValue } from "../documents/HeaderEditor";
import { DocumentTotals } from "../documents/DocumentTotals";
import { usePurchaseRowEntry } from "./PurchaseRowEntry";
import { SEK } from "../../lib/currency";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { stockholmToday } from "../../lib/date";
import {
  confirmableRows,
  fillWithWantedDates,
  initialConfirmationEntries,
  rowConfirmationCell,
  rowConfirmationPatches,
  rowsFollowQuestion,
  rowsKeepingOwnConfirmedDate,
  rowWantedDate,
} from "../../lib/purchaseRowConfirmation";

interface PurchaseOrderDetailProps {
  order: PurchaseOrder;
  rows: PurchaseOrderRow[];
  locations: StockLocation[];
  registers: TermsRegisters;
  // Programramen steg 3: the card's head and its other tabs, from the page.
  pageTitle: string;
  help?: ReactNode;
  tabs?: CardTab[];
}

// The status steps (Programramen steg 3); Avbruten stands outside the flow.
// Skickad (2026-11-23) is the mailed Utkast — a step on every order, also
// one confirmed without being mailed.
// The last receipt closes the order (Stängd automatiskt, 2026-11-21), so
// Mottagen is a step only on an order that holds it (an older one, or one
// set by Ändra status manuellt — Stäng order closes it).
const PURCHASE_STEPS = ["draft", "sent", "confirmed", "partially_received", "received", "closed"] as const;

function purchaseSteps(order: PurchaseOrder) {
  const pill = PURCHASE_ORDER_STATUS_PILL[order.status];
  if (order.status === "cancelled") return { steps: [], current: null, outside: { status: pill.status, label: pill.label } };
  return {
    steps: PURCHASE_STEPS.filter((key) => key !== "received" || order.status === "received").map((key) => ({
      key,
      label: PURCHASE_ORDER_STATUS_PILL[key].label,
    })),
    current: order.status,
    outside: null,
  };
}

// Confirm / cancel / close — no body, just an action call.
type PurchaseAction = "confirm" | "cancel" | "close";

const ACTION_ENDPOINTS: Record<PurchaseAction, string> = {
  confirm: "confirm",
  cancel: "cancel",
  close: "close",
};

export function PurchaseOrderDetail({ order, rows, locations, registers, pageTitle, help, tabs = [] }: PurchaseOrderDetailProps) {
  const router = useRouter();
  const pill = PURCHASE_ORDER_STATUS_PILL[order.status];
  // Rows stay editable until the order is fully received/closed/cancelled;
  // per-row guards (quantity ≥ received, no delete with receipts) are
  // enforced by the API and mirrored in the UI below.
  const rowsEditable =
    order.status === "draft" || order.status === "sent" || order.status === "confirmed" || order.status === "partially_received";
  // Kvalitet: Avvikelse per orderrad on an order that has been placed — a
  // button of its own on a row that cannot be edited any more, an item in the
  // row's ⋯ menu otherwise (RowDeviationLink hides itself without Kvalitet).
  const canDeviate = useCan()(["kvalitet"]) && order.status !== "draft" && order.status !== "cancelled";
  const deviationParams = (row: PurchaseOrderRow): NewDeviationParams => ({
    type: "supplier",
    supplierId: order.supplierId,
    purchaseOrderId: order.id,
    purchaseOrderRowId: row.id,
    articleId: row.articleId,
  });

  // Ångra ändringar in the header: mounts the editor afresh from the order.
  const [headerReset, setHeaderReset] = useState(0);
  const [addRowInitial, setAddRowInitial] = useState<{ article: Article | null; quantity: string }>({ article: null, quantity: "1" });
  const [modal, setModal] = useState<"deliveryAddress" | "addRow" | "receive" | "changeSupplier" | "confirmRows" | null>(null);
  // Byt leverantör: what the last change did — the reminder to tell the old
  // supplier and the rows whose price needs a look. Shown until dismissed;
  // not stored (the händelselogg has the change).
  const [supplierChange, setSupplierChange] = useState<SupplierChangePreview | null>(null);
  const dims = useDimensions();
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowPending, setRowPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<PurchaseAction | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editUnitId, setEditUnitId] = useState("");
  // Ställpris — only meaningful on lego rows (moOperationId set) or a row
  // that already has one, see the articleName cell below. Empty = null.
  const [editSetupPrice, setEditSetupPrice] = useState("");
  // "" = the row follows the order's Önskat leveransdatum.
  const [editDeliveryDate, setEditDeliveryDate] = useState("");
  const [editConfirmedDate, setEditConfirmedDate] = useState("");
  // The article behind the row being edited — fetched so the unit dropdown
  // knows the base unit + alternative units.
  const [editArticle, setEditArticle] = useState<Article | null>(null);
  // Osparade ändringar: the row's values when Ändra was opened (price
  // counts through editPriceTouched — the catalog may refill it).
  const [editStart, setEditStart] = useState<{ quantity: string; unitId: string; price: string; setup: string; date: string; confirmed: string } | null>(null);
  const rawEditUnitOptions = useUnitOptions(editArticle);
  // The row's own unit counts with the factor SAVED on the row until the
  // unit is switched (webbgranskningen 2026-11-11): the article's factor may
  // have changed since (kg 5 → 4), and re-expressing the row with the new one
  // re-quoted the price on opening Ändra and, on Spara, turned 100 kg = 20 st
  // into 25 st — the same as the kundorder card.
  const savedRowFactor = rows.find((r) => r.id === editingRowId)?.unitFactor ?? null;
  const savedRowUnitId = editStart?.unitId ?? null;
  const editUnitOptions = useMemo(
    () =>
      savedRowUnitId === null
        ? rawEditUnitOptions
        : rawEditUnitOptions.map((o) =>
            o.value === savedRowUnitId ? { ...o, factor: savedRowFactor != null ? Number(savedRowFactor) : 1 } : o
          ),
    [rawEditUnitOptions, savedRowUnitId, savedRowFactor]
  );
  const editFactor = editUnitOptions.find((o) => o.value === editUnitId)?.factor ?? 1;
  // Stafflat leverantörspris ("manuellt vinner", as on the sales order card):
  // a quantity change re-fetches the order supplier's catalog price for the
  // new base quantity unless the operator has typed a price themselves. The
  // base quantity the shown price belongs to is remembered (the row's own
  // quantity at first, then each quoted quantity) so a pure unit switch —
  // same base quantity, re-expressed — never reprices, while 10 → 100 → 10
  // does come back to the 10-tier. A sequence counter drops out-of-order
  // responses.
  const [editPriceTouched, setEditPriceTouched] = useState(false);
  // The staffel step behind a re-quoted price (Från antal, base unit) —
  // null for the row's own price and for a grundpris.
  const [editPriceTier, setEditPriceTier] = useState<number | null>(null);
  const rowEditDirty =
    editingRowId !== null &&
    editStart !== null &&
    (editPriceTouched ||
      editQuantity !== editStart.quantity ||
      editUnitId !== editStart.unitId ||
      editSetupPrice !== editStart.setup ||
      editDeliveryDate !== editStart.date ||
      editConfirmedDate !== editStart.confirmed);
  useUnsavedGuard(rowEditDirty);
  // A row open in Ändra blocks the flow buttons, as on the kundorder card —
  // Bekräfta then Skicka via e-post sent the supplier the SAVED quantity, and
  // a receipt that closed the order left the row's fields stranded.
  const rowEditOpen = editingRowId !== null;
  const rowEditTitle = rowEditOpen ? "Spara eller avbryt raden du ändrar först" : undefined;
  useEffect(() => {
    if (!rowsEditable) {
      setEditingRowId(null);
      setEditStart(null);
    }
  }, [rowsEditable]);
  const editPricedBaseQuantityRef = useRef(0);
  // The row's stored base quantity and price while Ändra is open.
  const editStoredRef = useRef({ quantity: 0, price: 0 });
  const editRequestSeq = useRef(0);
  // The touched flag as it is when a prefill response LANDS — the effect's
  // closure holds it as it was when the request left, so a price typed while
  // the request was in flight would otherwise be overwritten ("manuellt vinner").
  const editPriceTouchedNow = useRef(editPriceTouched);
  editPriceTouchedNow.current = editPriceTouched;
  // Fasta leveransdagar: only the warning for the row's date while editing —
  // an existing row's date is never prefilled.
  const editDateHint = useSupplierDeliveryDateSuggestion({
    supplierId: editingRowId !== null ? order.supplierId : null,
    articleId: rows.find((r) => r.id === editingRowId)?.articleId ?? null,
    date: editDeliveryDate,
    suggest: false,
  });

  useEffect(() => {
    if (editingRowId === null || editPriceTouched) return;
    const row = rows.find((r) => r.id === editingRowId);
    if (!row) return;
    // lib/rowRequote.ts — the same rule as the sales order card.
    const requote = requoteFor({
      quantity: editQuantity,
      unitId: editUnitId,
      unitOptions: editUnitOptions,
      pricedBaseQuantity: editPricedBaseQuantityRef.current,
    });
    if (!requote) return;
    const { base: baseQuantity, factor } = requote;
    // Claimed up front so a null/foreign-currency answer isn't re-asked on
    // every unrelated rerender; a later quantity change asks again.
    editPricedBaseQuantityRef.current = baseQuantity;
    const seq = ++editRequestSeq.current;
    apiFetch<SupplierPriceQuote>(
      `/api/v1/supplier-price-quote?supplierId=${order.supplierId}&articleId=${row.articleId}&quantity=${baseQuantity}`
    )
      .then((quote) => {
        if (seq !== editRequestSeq.current || editPriceTouchedNow.current) return;
        // No catalog price, or a catalog currency other than the order's:
        // leave the field as it is rather than guess.
        if (!quote.price || quote.price.currency !== order.currency) {
          setEditPriceTier(null);
          return;
        }
        setEditPrice(String(toUnitPrice(quote.price.unitPrice, factor)));
        setEditPriceTier(quote.price.source === "break" ? quote.price.fromQuantity : null);
      })
      .catch(() => {});
  }, [editingRowId, editQuantity, editUnitId, editUnitOptions, editPriceTouched, rows, order.supplierId, order.currency]);

  const canInkop = useCan()(["inkop"]);
  // + Ny rad straight in the rows table (Programramen steg 3); Fler fält…
  // opens Lägg till rad with the article chosen.
  const entryEnabled = rowsEditable && canInkop;
  const entry = usePurchaseRowEntry({
    orderId: order.id,
    supplierId: order.supplierId,
    currency: order.currency,
    revision: order.revision,
    orderDeliveryDate: order.expectedDeliveryDate,
    disabled: rowEditOpen,
    onDialog: (article, quantity) => {
      setAddRowInitial({ article, quantity });
      setModal("addRow");
    },
  });
  const entryAlready = alreadyOnDocumentText(rows, entry.article?.id, "ordern");
  const hasLego = rows.some((r) => r.moOperationId !== null);
  const receivable = rows.filter((r) => Number(r.quantityReceived) < Number(r.quantityOrdered));
  // Quantity and price are both stored in the article's base unit, so the
  // line amount is the same number whichever unit the row is displayed in.
  // A lego row's ställpris is a one-off charge added once per row.
  const rowAmount = (r: PurchaseOrderRow) =>
    Number(r.quantityOrdered) * Number(r.unitPrice) + (r.setupPrice != null ? Number(r.setupPrice) : 0);
  const total = rows.reduce((sum, r) => sum + rowAmount(r), 0);
  // Rounded to öre like the PDF's printed figure.
  const vatAmount = order.vat ? round2((total * order.vat.rate) / 100) : 0;

  function refresh() {
    setModal(null);
    router.refresh();
  }

  async function startEditRow(row: PurchaseOrderRow) {
    // Switching rows dropped the first row's changes without a word.
    if (rowEditDirty && !(await confirmDialog("Raden du ändrar har osparade ändringar. Släppa dem?"))) return;
    setRowError(null);
    setEditingRowId(row.id);
    setEditPriceTouched(false);
    setEditPriceTier(null);
    editPricedBaseQuantityRef.current = Number(row.quantityOrdered);
    editStoredRef.current = { quantity: Number(row.quantityOrdered), price: Number(row.unitPrice) };
    setEditQuantity(String(toUnitQuantity(Number(row.quantityOrdered), row.unitFactor)));
    setEditPrice(String(toUnitPrice(Number(row.unitPrice), row.unitFactor)));
    setEditUnitId(row.unitId ?? "");
    setEditSetupPrice(row.setupPrice != null ? String(Number(row.setupPrice)) : "");
    setEditDeliveryDate(row.expectedDeliveryDate ?? "");
    setEditConfirmedDate(row.confirmedDeliveryDate ?? "");
    setEditStart({
      quantity: String(toUnitQuantity(Number(row.quantityOrdered), row.unitFactor)),
      unitId: row.unitId ?? "",
      price: String(toUnitPrice(Number(row.unitPrice), row.unitFactor)),
      setup: row.setupPrice != null ? String(Number(row.setupPrice)) : "",
      date: row.expectedDeliveryDate ?? "",
      confirmed: row.confirmedDeliveryDate ?? "",
    });
    setEditArticle(null);
    apiFetch<Article>(`/api/v1/articles/${row.articleId}`).then(setEditArticle).catch(() => {});
  }

  // From the stored row while the entry still shows it, so switching units
  // never moves the quantity or price by a rounding (convertStored…).
  function switchEditUnit(option: UnitOption) {
    const stored = editStoredRef.current;
    setEditQuantity((q) => convertStoredQuantityInput(q, editFactor, option.factor, stored.quantity));
    setEditPrice((p) => convertStoredPriceInput(p, editFactor, option.factor, stored.price));
    setEditUnitId(option.value);
  }

  async function saveRow(row: PurchaseOrderRow) {
    if (!editStart) return;
    // Only what was changed: an untouched quantity, unit or price is never
    // re-sent, so the server never re-expresses it with the article's
    // current factor (a removed unit gave every Ändra 400 invalid-unit, a
    // raised factor 409 over-receipt). A price the catalog re-quoted for a new
    // quantity is a change and goes along.
    const unitChanged = editUnitId !== editStart.unitId;
    const body: Record<string, unknown> = {};
    if (unitChanged || editQuantity !== editStart.quantity) body.quantity = Number(editQuantity);
    if (unitChanged) body.unitId = editUnitId === "" ? null : editUnitId;
    if (unitChanged || editPriceTouched || editPrice !== editStart.price) body.unitPrice = Number(editPrice);
    if (editSetupPrice !== editStart.setup) body.setupPrice = editSetupPrice.trim() === "" ? null : Number(editSetupPrice);
    if (editDeliveryDate !== editStart.date) body.expectedDeliveryDate = editDeliveryDate || null;
    if (editConfirmedDate !== editStart.confirmed) body.confirmedDeliveryDate = editConfirmedDate || null;
    if (Object.keys(body).length === 0) {
      setEditingRowId(null);
      setEditStart(null);
      return;
    }
    const bumpRevision = await askBumpRevision(order.revision);
    setRowError(null);
    setRowPending(true);
    try {
      await apiFetch(`/api/v1/purchase-orders/${order.id}/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, bumpRevision }),
      });
      setEditingRowId(null);
      setEditStart(null);
      router.refresh();
    } catch (err) {
      setRowError(apiErrorMessage(err, "Kunde inte spara raden"));
    } finally {
      setRowPending(false);
    }
  }

  async function removeRow(row: PurchaseOrderRow) {
    if (!(await confirmDelete(`Ta bort ${row.articleNumber} ur ordern?`))) return;
    const bumpRevision = await askBumpRevision(order.revision);
    setRowError(null);
    setRowPending(true);
    try {
      await apiFetch(`/api/v1/purchase-orders/${order.id}/rows/${row.id}?bumpRevision=${bumpRevision}`, {
        method: "DELETE",
      });
      router.refresh();
    } catch (err) {
      setRowError(apiErrorMessage(err, "Kunde inte ta bort raden"));
    } finally {
      setRowPending(false);
    }
  }

  async function runAction(action: PurchaseAction) {
    if (
      action === "cancel" &&
      !(await confirmDialog(`Avbryta ${order.orderNumber}? En avbruten inköpsorder tas inte emot och skickas inte.`, {
        confirmLabel: "Avbryt order",
        danger: true,
      }))
    ) {
      return;
    }
    // Bekräfta fills Bekräftat leveransdatum from the SAVED Önskat (the
    // server's confirm), and the header editor starts over on the new date —
    // an unsaved header would be confirmed on the old date and then lost.
    if (action === "confirm" && hasUnsavedDrafts()) {
      setActionError("Spara eller ångra ändringarna först — Bekräfta fyller i bekräftat leveransdatum ur det sparade önskade datumet.");
      return;
    }
    setActionError(null);
    setActionPending(action);
    try {
      await apiFetch(`/api/v1/purchase-orders/${order.id}/${ACTION_ENDPOINTS[action]}`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setActionError(apiErrorMessage(err, "Åtgärden misslyckades"));
    } finally {
      setActionPending(null);
    }
  }

  return (
    <div>
      <DocumentActionBar
        label={order.orderNumber}
        pill={pill}
        error={actionError}
        trailing={
          <ManualStatusChange
            endpoint={`/api/v1/purchase-orders/${order.id}`}
            statuses={PURCHASE_ORDER_STATUS_PILL}
            current={order.status}
            onDone={() => router.refresh()}
            disabled={rowEditOpen}
            title={rowEditTitle}
          />
        }
      >
        {(order.status === "draft" || order.status === "sent") && (
          <Button type="button" variant="primary" disabled={actionPending !== null || rowEditOpen} title={rowEditTitle} onClick={() => runAction("confirm")}>
            {actionPending === "confirm" ? "Arbetar…" : "Bekräfta"}
          </Button>
        )}

        {hasLego && rowsEditable && canInkop && (
          <Link href={`/inkop/avsandning?order=${order.id}`} className={`${buttonStyles.button} ${buttonStyles.secondary}`}>
            Avsändning
          </Link>
        )}

        {(order.status === "sent" || order.status === "confirmed" || order.status === "partially_received") && (
          <>
            {/* The supplier's Bekräftat leveransdatum row by row — only once
                the order is placed (an Utkast has its own Bekräfta, the
                status; a Skickad order has both). Goods can come on a
                Skickad order too (PURCHASE_ORDER_RECEIVABLE_STATUSES). */}
            {receivable.length > 0 && (
              <Button type="button" variant="secondary" disabled={rowEditOpen} title={rowEditTitle} onClick={() => setModal("confirmRows")}>
                Bekräfta rader…
              </Button>
            )}
            {receivable.length > 0 && (
              <Button type="button" variant="primary" disabled={rowEditOpen} title={rowEditTitle} onClick={() => setModal("receive")}>
                Ta emot leverans
              </Button>
            )}
            <Link href={`/inkop/inleverans?order=${order.id}`} className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Inleveransrutinen
            </Link>
          </>
        )}

        {(order.status === "draft" || order.status === "sent" || order.status === "confirmed") && canInkop && (
          <Button type="button" variant="secondary" disabled={actionPending !== null || rowEditOpen} title={rowEditTitle} onClick={() => setModal("changeSupplier")}>
            Byt leverantör…
          </Button>
        )}

        {order.status === "received" && (
          <Button type="button" variant="primary" disabled={actionPending !== null} onClick={() => runAction("close")}>
            {actionPending === "close" ? "Arbetar…" : "Stäng order"}
          </Button>
        )}

        {(order.status === "draft" || order.status === "sent" || order.status === "confirmed") && (
          <Button type="button" variant="danger" disabled={actionPending !== null || rowEditOpen} title={rowEditTitle} onClick={() => runAction("cancel")}>
            {actionPending === "cancel" ? "Arbetar…" : "Avbryt order"}
          </Button>
        )}
      </DocumentActionBar>

      <DocumentIdentity
        pageTitle={pageTitle}
        number={order.orderNumber}
        pill={pill}
        note={`Rev ${order.revision} · ${order.currency}`}
        help={help}
        title={order.supplierName}
        titleHref={`/leverantorer/${order.supplierId}`}
        steps={<StatusStepper {...purchaseSteps(order)} />}
      />

      {supplierChange && (
        <FormNotice style={{ marginBottom: 12 }}>
          Leverantören är bytt till {supplierChange.to.supplierName}.
          {supplierChange.revertsToDraft &&
            ` Ordern är tillbaka i Utkast — meddela ${supplierChange.from.supplierName} att ordern inte gäller längre.`}
          {supplierChange.rows.some((r) => r.review) &&
            ` Se över priset på ${supplierChange.rows
              .filter((r) => r.review)
              .map((r) => r.articleNumber)
              .join(", ")}.`}{" "}
          <Button type="button" size="small" variant="ghost" onClick={() => setSupplierChange(null)}>
            Stäng
          </Button>
        </FormNotice>
      )}

      {rowsEditable && canInkop ? (
        <PurchaseHeaderEditor
          key={`${purchaseHeaderSignature(order)}|${headerReset}`}
          order={order}
          rows={rows}
          registers={registers}
          onDone={() => router.refresh()}
          onReset={() => setHeaderReset((n) => n + 1)}
          onEditAddress={() => setModal("deliveryAddress")}
        />
      ) : (
        <DocumentHeaderCard
          fields={[
            { label: "Leverantör", value: order.supplierName, href: `/leverantorer/${order.supplierId}` },
            { label: "Önskat leveransdatum", value: order.expectedDeliveryDate },
            { label: "Bekräftat leveransdatum", value: order.confirmedDeliveryDate },
            { label: "Växelkurs", value: order.exchangeRate },
            { label: "Er referens", value: order.yourReference },
            { label: "Vår referens", value: order.ourReference },
            ...headerDimensionFields(order, dims, { costCenter: false }),
            { label: "Frakt på vårt konto", value: order.freightPaidByUs ? "Ja" : "Nej" },
            { label: "Leveransvillkor", value: termsLabel(order.deliveryTermCode, order.deliveryTermName) },
            { label: "Betalningsvillkor", value: termsLabel(order.paymentTermCode, order.paymentTermName) },
            { label: "Speditör", value: termsLabel(order.carrierCode, order.carrierName) },
            {
              label: "Leveransadress",
              wide: true,
              value: (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                  {formatDeliveryAddress(order.deliveryAddress)}
                  {rowsEditable && (
                    <Button type="button" size="small" variant="ghost" onClick={() => setModal("deliveryAddress")}>
                      Ändra
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
          note={order.note}
        />
      )}

      <CardTabs
        label="Orderns delar"
        tabs={[
          {
            key: "rader",
            label: "Rader",
            count: rows.length,
            node: (
              <>

      {rows.length > 0 || entryEnabled ? (
        <Table<PurchaseOrderRow>
          columns={[
            // Same layout as the kundorder card: floors as tight as the cell
            // contents allow (they decide whether the table outgrows the
            // content column), the spare width shared out (Benämning 3fr, the
            // figure columns 1fr each) so a wide screen spreads the figures
            // over the row, Enhet fixed next to the quantity, and Ändra + the
            // ⋯ menu on one line. While a row is being edited the tracks that
            // hold inputs widen so no input is clipped.
            { key: "articleNumber", label: "Artikelnummer", width: "110px" },
            { key: "articleName", label: "Benämning", width: editingRowId ? "minmax(160px, 3fr)" : "minmax(120px, 3fr)" },
            { key: "quantityOrdered", label: "Beställt", width: shareTrack(editingRowId ? 90 : 66), align: "right" },
            { key: "unitCode", label: "Enhet", width: editingRowId ? "84px" : "52px" },
            { key: "quantityReceived", label: "Mottaget", width: shareTrack(70), align: "right" },
            // The supplier's confirmation per row (its own date, else the
            // order's) — Nej marked while the row still has a rest to come.
            { key: "confirmedDeliveryDate", label: "Bekräftat", width: shareTrack(84) },
            { key: "unitPrice", label: "Á-pris", width: shareTrack(editingRowId ? 100 : 84), align: "right" },
            // Wide enough for the footer's "69 600,00 SEK" on one line.
            { key: "lineAmount", label: "Belopp", width: shareTrack(96), align: "right" },
            ...(rowsEditable || canDeviate
              ? // max-content: Ändra + ⋯, Spara + Avbryt and + Ny rad's Lägg till
                // each get the room they need (a fixed track let Lägg till
                // cover Belopp).
                ([{ key: "id", label: "", width: "max-content", align: "right" }] as const)
              : []),
          ]}
          rows={rows}
          entryRow={entryEnabled ? { cells: entry.cells, span: entry.span } : undefined}
          // The totals box under the table carries the sum when the order has VAT.
          footer={order.vat ? undefined : { unitPrice: "Summa", lineAmount: `${formatMoney(total)} ${order.currency}` }}
          renderCell={(row, key) => {
            switch (key) {
              case "articleNumber":
                return (
                  <>
                    <ArticleLink articleId={row.articleId}>{row.articleNumber}</ArticleLink>
                    <ArticleOverviewButton articleId={row.articleId} articleNumber={row.articleNumber} />
                  </>
                );
              case "quantityOrdered":
                // Quantities/prices display in the row's unit — stored values
                // are always in the article's base unit.
                return editingRowId === row.id ? (
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    size="sm"
                    value={editQuantity}
                    onChange={(e) => setEditQuantity(e.target.value)}
                    autoFocus
                  />
                ) : (
                  toUnitQuantity(Number(row.quantityOrdered), row.unitFactor)
                );
              case "unitCode":
                return editingRowId === row.id ? (
                  <UnitSelect id={`rowUnit-${row.id}`} options={editUnitOptions} value={editUnitId} onChange={switchEditUnit} />
                ) : (
                  row.unitCode
                );
              case "quantityReceived":
                return toUnitQuantity(Number(row.quantityReceived), row.unitFactor);
              case "unitPrice":
                return editingRowId === row.id ? (
                  <>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      size="sm"
                      value={editPrice}
                      onChange={(e) => {
                        setEditPriceTouched(true);
                        setEditPrice(e.target.value);
                      }}
                    />
                    {editPriceTier !== null && !editPriceTouched && (
                      <FormHint attached>
                        Staffel från {formatQuantity(editPriceTier)} {editArticle?.unit}
                      </FormHint>
                    )}
                  </>
                ) : (
                  `${formatUnitPrice(toUnitPrice(Number(row.unitPrice), row.unitFactor))} ${order.currency}`
                );
              case "articleName": {
                // Ställpris is a lego concept (a one-off charge for the
                // operation the row buys) — the editor only shows on rows
                // linked to an operation, or one that already carries a
                // value (e.g. edited in, then the row's link was otherwise
                // cleared). Plain purchase rows never get the field.
                const showSetupPrice = row.moOperationId !== null || row.setupPrice != null;
                return (
                  <>
                    {row.articleName}
                    {row.moOperationId !== null && row.moOrderNumber !== null && (
                      // Lego row: which TO operation it buys. Receiving the
                      // row reports the operation.
                      <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                        Lego för {row.moOrderNumber} · Op {row.moOperationSequenceNo}
                        {row.moOperationDescription ? ` · ${row.moOperationDescription}` : ""}
                        {Number(row.quantityDispatched) > 0
                          ? ` — Skickat ${formatQuantity(toUnitQuantity(Number(row.quantityDispatched), row.unitFactor))} ${row.unitCode}`
                          : ""}
                        {editingRowId !== row.id && row.setupPrice != null
                          ? ` — Ställpris ${formatMoney(Number(row.setupPrice))} ${order.currency}`
                          : ""}
                      </div>
                    )}
                    {showSetupPrice && editingRowId === row.id && (
                      // Wraps like the date fields below: in the narrow
                      // Benämning track (1280 px) the label takes its own
                      // line instead of squeezing the input.
                      <div style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <label htmlFor={`setupPrice-${row.id}`} style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                          Ställpris
                        </label>
                        <Input
                          id={`setupPrice-${row.id}`}
                          type="number"
                          min="0"
                          step="0.01"
                          size="sm"
                          value={editSetupPrice}
                          onChange={(e) => setEditSetupPrice(e.target.value)}
                        />
                        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{order.currency}</span>
                      </div>
                    )}
                    {/* The row's own Önskat leveransdatum — only shown when it
                        differs from the order's (otherwise the row simply
                        follows the header, like on the PDF). */}
                    {editingRowId !== row.id &&
                      row.expectedDeliveryDate &&
                      row.expectedDeliveryDate !== order.expectedDeliveryDate && (
                        <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                          Önskat leveransdatum {row.expectedDeliveryDate}
                        </div>
                      )}
                    {editingRowId === row.id && (
                      <div style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <label htmlFor={`deliveryDate-${row.id}`} style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                          Önskat leveransdatum
                        </label>
                        <Input
                          id={`deliveryDate-${row.id}`}
                          type="date"
                          size="sm"
                          value={editDeliveryDate}
                          onChange={(e) => setEditDeliveryDate(e.target.value)}
                        />
                        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                          Tomt = som ordern{order.expectedDeliveryDate ? ` (${order.expectedDeliveryDate})` : ""}
                        </span>
                        <div style={{ flexBasis: "100%" }}>
                          <DeliveryDateHint warning={editDateHint.warning} />
                        </div>
                        <label htmlFor={`confirmedDate-${row.id}`} style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                          Bekräftat leveransdatum
                        </label>
                        <Input
                          id={`confirmedDate-${row.id}`}
                          type="date"
                          size="sm"
                          value={editConfirmedDate}
                          onChange={(e) => setEditConfirmedDate(e.target.value)}
                        />
                        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                          Tomt = som ordern{order.confirmedDeliveryDate ? ` (${order.confirmedDeliveryDate})` : ""}
                        </span>
                      </div>
                    )}
                  </>
                );
              }
              case "confirmedDeliveryDate": {
                const cell = rowConfirmationCell(row, order);
                if (cell.kind === "date") return cell.date;
                if (cell.kind === "missing")
                  return <span style={{ fontWeight: 600, color: "var(--status-delayed-text)" }}>Nej</span>;
                return "–";
              }
              case "lineAmount":
                return formatMoney(rowAmount(row));
              case "id":
                if (!rowsEditable) return <RowDeviationLink label="Avvikelse" params={deviationParams(row)} />;
                return editingRowId === row.id ? (
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Button type="button" size="small" variant="primary" disabled={rowPending} onClick={() => saveRow(row)}>
                      Spara
                    </Button>
                    <Button type="button" size="small" variant="ghost" onClick={() => { setEditingRowId(null); setEditStart(null); setRowError(null); }}>
                      Avbryt
                    </Button>
                  </span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 4, alignItems: "center", justifyContent: "flex-end" }}>
                    <Button type="button" size="small" variant="ghost" onClick={() => void startEditRow(row)}>
                      Ändra
                    </Button>
                    <RowMenu
                      label={`Fler åtgärder för ${row.articleNumber}`}
                      items={[
                        canDeviate && { label: "Avvikelse", href: newDeviationHref(deviationParams(row)) },
                        Number(row.quantityReceived) === 0 && {
                          label: "Ta bort",
                          danger: true,
                          disabled: rowPending,
                          onSelect: () => removeRow(row),
                        },
                      ]}
                    />
                  </span>
                );
              default:
                return row[key as keyof PurchaseOrderRow];
            }
          }}
        />
      ) : (
        <p>Inga rader tillagda än.</p>
      )}
      {/* Under the table, next to the rows' Spara and Ta bort. */}
      <FormError>{rowError}</FormError>
      {/* Moms på inköpsordern: the supplier's Momskod (förval) — live, the
          same rate the PDF prints. A code without charged VAT (EU, omvänd
          moms, momsfritt) shows 0 and says why. */}
      <FormError>{entry.error}</FormError>
      {entryAlready && <FormNotice>{entryAlready}</FormNotice>}
      {entry.priceTier !== null && (
        <FormHint>
          Staffelpris från {formatQuantity(entry.priceTier)} {entry.article?.unit}
        </FormHint>
      )}
      {entry.suggestedDate && (
        <FormHint>
          Raden får önskat leveransdatum {entry.suggestedDate} (artikelns ledtid hos leverantören).
        </FormHint>
      )}
      {rows.length > 0 && order.vat && (
        <DocumentTotals
          currency={order.currency}
          lines={[
            { key: "net", label: "Netto", amount: total },
            { key: "vat", label: `Moms ${order.vat.rate.toLocaleString("sv-SE")} %`, amount: vatAmount },
            { key: "total", label: "Totalt", amount: total + vatAmount, total: true },
          ]}
          notes={
            <FormHint>
              Momskod {order.vat.code} · {order.vat.name}
              {order.vat.derived ? " (härledd ur leverantörens land)" : " (leverantörens förval)"}
              {order.vat.rate === 0 ? " — leverantören debiterar ingen moms." : ""}
            </FormHint>
          }
        />
      )}
              </>
            ),
          },
          ...tabs,
        ]}
      />

      <Modal open={modal === "changeSupplier"} onClose={() => setModal(null)} title="Byt leverantör">
        {modal === "changeSupplier" && (
          <ChangeSupplierDialog
            order={order}
            onCancel={() => setModal(null)}
            onDone={(change) => {
              setSupplierChange(change);
              refresh();
            }}
          />
        )}
      </Modal>

      <Modal open={modal === "deliveryAddress"} onClose={() => setModal(null)} title="Leveransadress">
        <DeliveryAddressForm order={order} onDone={refresh} onCancel={() => setModal(null)} />
      </Modal>

      <Modal open={modal === "addRow"} onClose={() => setModal(null)} title="Lägg till rad">
        <AddRowForm
          initialArticle={addRowInitial.article}
          initialQuantity={addRowInitial.quantity}
          orderId={order.id}
          supplierId={order.supplierId}
          currency={order.currency}
          revision={order.revision}
          orderDeliveryDate={order.expectedDeliveryDate}
          orderConfirmedDate={order.confirmedDeliveryDate}
          existingRows={rows}
          onDone={refresh}
          onCancel={() => setModal(null)}
        />
      </Modal>

      <Modal open={modal === "confirmRows"} onClose={() => setModal(null)} title="Bekräfta rader">
        {modal === "confirmRows" && <ConfirmRowsForm order={order} rows={rows} onDone={refresh} onCancel={() => setModal(null)} />}
      </Modal>

      <Modal open={modal === "receive"} onClose={() => setModal(null)} title="Ta emot leverans">
        <ReceiveGoodsForm
          orderId={order.id}
          rows={receivable}
          locations={locations}
          onDone={refresh}
          onCancel={() => setModal(null)}
        />
      </Modal>
    </div>
  );
}

// --- Order header (leveransdatum/växelkurs/referenser/frakt/villkor/notering) ---
// One PATCH /purchase-orders/:id covers the whole header including the three
// terms, so the card asks about a new revision exactly once. The currency
// stays locked to the snapshot taken from the supplier.

function PurchaseHeaderEditor({
  order,
  rows,
  registers,
  onDone,
  onReset,
  onEditAddress,
}: {
  order: PurchaseOrder;
  // For the question whether rows with their own Bekräftat leveransdatum
  // follow a new one in the header.
  rows: PurchaseOrderRow[];
  registers: TermsRegisters;
  onDone: () => void;
  onReset: () => void;
  // Leveransadress keeps its own dialog (and its own PATCH): it is a
  // five-field address with Hämta från kundorder.
  onEditAddress: () => void;
}) {
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(order.expectedDeliveryDate ?? "");
  const [confirmedDeliveryDate, setConfirmedDeliveryDate] = useState(order.confirmedDeliveryDate ?? "");
  const [exchangeRate, setExchangeRate] = useState(order.exchangeRate);
  const [yourReference, setYourReference] = useState(order.yourReference ?? "");
  const [ourReference, setOurReference] = useState(order.ourReference ?? "");
  const dims = useDimensions();
  const [projectId, setProjectId] = useState(order.projectId ?? order.project?.id ?? "");
  const [note, setNote] = useState(order.note ?? "");
  const [freightPaidByUs, setFreightPaidByUs] = useState(order.freightPaidByUs);
  const [terms, setTerms] = useState<TermsValue>(termsFrom(order));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dateHint = useSupplierDeliveryDateSuggestion({
    supplierId: order.supplierId,
    date: expectedDeliveryDate,
    suggest: true,
  });
  const foreign = order.currency !== SEK;

  // What the header holds now against what it held when mounted (or saved).
  const snapshot = JSON.stringify({
    expectedDeliveryDate,
    confirmedDeliveryDate,
    exchangeRate,
    yourReference,
    ourReference,
    projectId,
    note,
    freightPaidByUs,
    terms,
  });
  const [baseline, setBaseline] = useState(snapshot);
  const dirty = snapshot !== baseline;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || pending) return;
    // A new Bekräftat leveransdatum: rows confirmed earlier keep their own
    // dates unless they are told to follow (lib/purchaseRowConfirmation.ts).
    const newConfirmed = confirmedDeliveryDate || null;
    const keeping = rowsKeepingOwnConfirmedDate(rows, order.confirmedDeliveryDate, newConfirmed);
    const rowsFollowConfirmed =
      keeping.length > 0 && (await confirmDialog(rowsFollowQuestion(keeping, newConfirmed!), { confirmLabel: "Uppdatera raderna" }));
    const bumpRevision = await askBumpRevision(order.revision);
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/purchase-orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedDeliveryDate: expectedDeliveryDate || null,
          confirmedDeliveryDate: newConfirmed,
          ...(rowsFollowConfirmed ? { rowsFollowConfirmed: true } : {}),
          exchangeRate: Number(exchangeRate),
          yourReference: yourReference.trim() || null,
          ourReference: ourReference.trim() || null,
          projectId: projectId || null,
          note: note.trim() || null,
          freightPaidByUs,
          ...termsPayload(terms),
          bumpRevision,
        }),
      });
      setBaseline(snapshot);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara"));
    } finally {
      setPending(false);
    }
  }

  const hasProject = dims.allProjects.length > 0 || projectId !== "";

  return (
    <HeaderEditor
      label="Orderhuvud"
      dirty={dirty}
      pending={pending}
      error={error}
      onSubmit={save}
      onReset={onReset}
      moreOpen={foreign || projectId !== ""}
      more={
        foreign || hasProject ? (
          <>
            {foreign && (
              <HeaderCell>
                <Field label="Växelkurs" htmlFor="headerExchangeRate">
                  <Input
                    id="headerExchangeRate"
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={exchangeRate}
                    onChange={(e) => setExchangeRate(e.target.value)}
                  />
                </Field>
              </HeaderCell>
            )}
            <DimensionFields
              idPrefix="header"
              lists={dims}
              withCostCenter={false}
              costCenterId=""
              projectId={projectId}
              onCostCenterChange={() => {}}
              onProjectChange={setProjectId}
              cells
            />
          </>
        ) : undefined
      }
    >
      <HeaderValue label="Leverantör" value={order.supplierName} href={`/leverantorer/${order.supplierId}`} />
      <HeaderCell>
        <Field label="Önskat leveransdatum" htmlFor="headerExpectedDeliveryDate">
          <Input
            id="headerExpectedDeliveryDate"
            type="date"
            value={expectedDeliveryDate}
            onChange={(e) => setExpectedDeliveryDate(e.target.value)}
          />
          <DeliveryDateHint summary={dateHint.summary} warning={dateHint.warning} />
        </Field>
      </HeaderCell>
      <HeaderCell>
        <Field label="Bekräftat leveransdatum" htmlFor="headerConfirmedDeliveryDate">
          <Input
            id="headerConfirmedDeliveryDate"
            type="date"
            value={confirmedDeliveryDate}
            onChange={(e) => setConfirmedDeliveryDate(e.target.value)}
          />
        </Field>
      </HeaderCell>
      <HeaderCell>
        <Field label="Er referens" htmlFor="headerYourReference">
          <Input id="headerYourReference" maxLength={100} value={yourReference} onChange={(e) => setYourReference(e.target.value)} />
        </Field>
      </HeaderCell>
      <HeaderCell>
        <Field label="Vår referens" htmlFor="headerOurReference">
          <Input id="headerOurReference" maxLength={100} value={ourReference} onChange={(e) => setOurReference(e.target.value)} />
        </Field>
      </HeaderCell>
      <HeaderCell>
        <Field label="Frakt på vårt konto" htmlFor="headerFreightPaidByUs">
          <Toggle id="headerFreightPaidByUs" checked={freightPaidByUs} onChange={(e) => setFreightPaidByUs(e.target.checked)} />
        </Field>
      </HeaderCell>

      <TermsFields registers={registers} value={terms} onChange={setTerms} cells />

      <HeaderValue
        label="Leveransadress"
        wide
        value={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {formatDeliveryAddress(order.deliveryAddress)}
            <Button type="button" size="small" variant="ghost" onClick={onEditAddress}>
              Ändra
            </Button>
          </span>
        }
      />
      <HeaderCell wide>
        <Field label="Anteckning" htmlFor="headerNote">
          <Input id="headerNote" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </HeaderCell>
    </HeaderEditor>
  );
}

// The header fields the editor starts from (see headerSignature on the
// kundorder card): a save or Byt leverantör mounts it afresh, a new row or a
// status change leaves typed changes alone.
function purchaseHeaderSignature(order: PurchaseOrder): string {
  return JSON.stringify([
    order.supplierId,
    order.expectedDeliveryDate,
    order.confirmedDeliveryDate,
    order.exchangeRate,
    order.yourReference,
    order.ourReference,
    order.projectId ?? order.project?.id,
    order.note,
    order.freightPaidByUs,
    order.deliveryTermId,
    order.paymentTermId,
    order.carrierId,
  ]);
}

// --- Bekräfta rader: the supplier's Bekräftat leveransdatum per row ---
// One PATCH per changed row (as the inleverans routine loops its rows) and
// never a new revision: the confirmed date is the supplier's answer and is
// not printed on the IO PDF. The entries start at each row's own date, so
// "" means the row follows the order's date (as in Ändra) and an untouched
// row is never written (lib/purchaseRowConfirmation.ts).

function ConfirmRowsForm({
  order,
  rows,
  onDone,
  onCancel,
}: {
  order: PurchaseOrder;
  rows: PurchaseOrderRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const listed = useMemo(() => confirmableRows(rows), [rows]);
  const [entries, setEntries] = useState<Record<string, string>>(() => initialConfirmationEntries(listed));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const anyWanted = listed.some((r) => rowWantedDate(r, order) !== null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const patches = rowConfirmationPatches(listed, entries);
    if (patches.length === 0) {
      onCancel();
      return;
    }
    setError(null);
    setPending(true);
    let saved = 0;
    try {
      for (const patch of patches) {
        await apiFetch(`/api/v1/purchase-orders/${order.id}/rows/${patch.rowId}`, {
          method: "PATCH",
          body: JSON.stringify({ confirmedDeliveryDate: patch.confirmedDeliveryDate, bumpRevision: false }),
        });
        saved++;
      }
      onDone();
    } catch (err) {
      const failed = listed.find((r) => r.id === patches[saved]?.rowId);
      setError(
        `${failed ? `${failed.articleNumber}: ` : ""}${apiErrorMessage(err, "Kunde inte spara raden")}` +
          (saved > 0 ? " Raderna före den är sparade." : "")
      );
      // The saved rows now carry their entry, so Spara again only sends the rest.
      if (saved > 0) router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={save}>
      <FormError>{error}</FormError>
      <FormHint>
        Fyll i leverantörens bekräftade leveransdatum per rad. Tomt = som ordern
        {order.confirmedDeliveryDate ? ` (${order.confirmedDeliveryDate})` : ", som inte har något bekräftat datum"}.
      </FormHint>
      {anyWanted && (
        <div>
          <Button type="button" size="small" variant="secondary" onClick={() => setEntries((e) => fillWithWantedDates(listed, order, e))}>
            Alla som önskat
          </Button>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {listed.map((row) => {
          const wanted = rowWantedDate(row, order);
          const rest = toUnitQuantity(Number(row.quantityOrdered) - Number(row.quantityReceived), row.unitFactor);
          const entry = entries[row.id] ?? "";
          return (
            <div
              key={row.id}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "10px 0",
                borderBottom: "1px solid var(--color-divider)",
              }}
            >
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <strong>{row.articleNumber}</strong> {row.articleName}
                <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                  Rest {formatQuantity(rest)} {row.unitCode} · Önskat {wanted ?? "–"}
                </div>
              </div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Input
                  type="date"
                  size="sm"
                  aria-label={`Bekräftat leveransdatum för ${row.articleNumber}`}
                  value={entry}
                  onChange={(e) => setEntries((prev) => ({ ...prev, [row.id]: e.target.value }))}
                />
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  disabled={!wanted || entry === wanted}
                  onClick={() => wanted && setEntries((prev) => ({ ...prev, [row.id]: wanted }))}
                  style={{ whiteSpace: "nowrap" }}
                >
                  Som önskat
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

// --- Add row ---

function AddRowForm({
  initialArticle = null,
  initialQuantity = "1",
  orderId,
  supplierId,
  currency,
  revision,
  orderDeliveryDate,
  orderConfirmedDate,
  existingRows,
  onDone,
  onCancel,
}: {
  // From + Ny rad in the table: the article and the quantity typed there.
  initialArticle?: Article | null;
  initialQuantity?: string;
  orderId: string;
  supplierId: string;
  currency: string;
  existingRows: PurchaseOrderRow[];
  revision: number;
  orderDeliveryDate: string | null;
  orderConfirmedDate: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [article, setArticle] = useState<Article | null>(initialArticle);
  const alreadyOnDocument = alreadyOnDocumentText(existingRows, article?.id, "ordern");
  const [quantity, setQuantity] = useState(initialQuantity);
  const [unitPrice, setUnitPrice] = useState("0");
  const [unitId, setUnitId] = useState(initialArticle?.purchaseUnitId ?? ""); // "" = the article's base unit
  const [deliveryDate, setDeliveryDate] = useState(""); // "" = the order's
  const [confirmedDate, setConfirmedDate] = useState(""); // "" = the order's
  // Fasta leveransdagar: the row suggestion prefills the row's own date only
  // when it falls after the order's date (or the order has none) — otherwise
  // the row simply follows the order. "Manuellt vinner", per article.
  const [dateTouched, setDateTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const unitCode = unitOptions.find((o) => o.value === unitId)?.code;
  const { suggestion: dateSuggestion, warning: dateWarning } = useSupplierDeliveryDateSuggestion({
    supplierId,
    articleId: article?.id ?? null,
    date: deliveryDate,
    // No row suggestion is fetched or prefilled until an article is picked
    // (without one the hook would return the header's suggestion); the warning
    // for a typed date still works.
    suggest: article !== null,
  });
  useEffect(() => {
    if (dateTouched) return;
    const suggested = dateSuggestion?.date ?? null;
    setDeliveryDate(suggested && (!orderDeliveryDate || suggested > orderDeliveryDate) ? suggested : "");
  }, [dateSuggestion, dateTouched, orderDeliveryDate]);

  // Stafflat leverantörspris prefill from the order supplier's catalog for
  // the entered quantity — "manuellt vinner": once the operator types a
  // price it is never overwritten. Same shape as the sales order card's
  // /price-quote prefill (touched flag + request sequence).
  const [priceTouched, setPriceTouched] = useState(false);
  // The staffel step behind the prefilled à-pris (its Från antal, base unit),
  // null when the price is the catalog's grundpris or none was found.
  const [priceTier, setPriceTier] = useState<number | null>(null);
  const requestSeq = useRef(0);
  // The touched flag as it is when a prefill response LANDS — the effect's
  // closure holds it as it was when the request left, so a price typed while
  // the request was in flight would otherwise be overwritten ("manuellt vinner").
  const priceTouchedNow = useRef(priceTouched);
  priceTouchedNow.current = priceTouched;
  const articleId = article?.id ?? null;
  const parsedQuantity = Number(quantity);
  const baseQuantity =
    articleId && Number.isFinite(parsedQuantity) && parsedQuantity > 0
      ? toBaseQuantity(parsedQuantity, currentFactor)
      : null;

  // A catalog suggestion is on its way: Lägg till rad waits for it, or the
  // row went in with the field's old value (webbgranskningen 2026-11-11).
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    if (priceTouched || !articleId || baseQuantity === null) {
      setQuoting(false);
      return;
    }
    const seq = ++requestSeq.current;
    setQuoting(true);
    apiFetch<SupplierPriceQuote>(
      `/api/v1/supplier-price-quote?supplierId=${supplierId}&articleId=${articleId}&quantity=${baseQuantity}`
    )
      .then((quote) => {
        if (seq !== requestSeq.current || priceTouchedNow.current) return;
        // No catalog price, or a catalog currency other than the order's:
        // leave the field alone rather than guess.
        if (!quote.price || quote.price.currency !== currency) {
          setPriceTier(null);
          return;
        }
        setUnitPrice(String(toUnitPrice(quote.price.unitPrice, currentFactor)));
        setPriceTier(quote.price.source === "break" ? quote.price.fromQuantity : null);
      })
      .catch(() => {})
      .finally(() => {
        if (seq === requestSeq.current) setQuoting(false);
      });
  }, [articleId, baseQuantity, supplierId, currency, priceTouched, currentFactor]);

  // Picking an article pre-selects its purchase unit; switching unit
  // re-expresses the entered quantity and price (500 kg ⇄ 100 st).
  function handleArticleChange(next: Article | null) {
    setArticle(next);
    setUnitId(next?.purchaseUnitId ?? "");
    // An untouched price starts over: the previous article's catalog price
    // stood in the field and was saved on an article without one.
    if (!priceTouchedNow.current) setUnitPrice("0");
    // "Manuellt vinner" is per article — a new pick gets its own prefill.
    setPriceTouched(false);
    setPriceTier(null);
    setDateTouched(false);
  }

  function handleUnitChange(option: UnitOption) {
    setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
    setUnitPrice((p) => convertPriceInput(p, currentFactor, option.factor));
    setUnitId(option.value);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!article) {
      setError("Välj en artikel");
      return;
    }
    const bumpRevision = await askBumpRevision(revision);
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/purchase-orders/${orderId}/rows`, {
        method: "POST",
        body: JSON.stringify({
          articleId: article.id,
          quantity: Number(quantity),
          unitPrice: Number(unitPrice),
          unitId: unitId === "" ? null : unitId,
          expectedDeliveryDate: deliveryDate || null,
          ...(confirmedDate ? { confirmedDeliveryDate: confirmedDate } : {}),
          bumpRevision,
        }),
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte lägga till raden"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Artikel" htmlFor="articleId">
        <ArticlePicker orderable id="articleId" value={article} onChange={handleArticleChange} />
      </Field>
      {alreadyOnDocument && <FormNotice>{alreadyOnDocument}</FormNotice>}

      <FormRow columns={3}>
        <Field label="Antal" htmlFor="quantity">
          <Input id="quantity" type="number" min="0" step="any" size="sm" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Enhet" htmlFor="rowUnit">
          <UnitSelect id="rowUnit" options={unitOptions} value={unitId} onChange={handleUnitChange} />
        </Field>
        <Field label={unitCode ? `Á-pris (${currencyLabel(currency)}/${unitCode})` : `Á-pris (${currencyLabel(currency)})`} htmlFor="unitPrice">
          <Input
            id="unitPrice"
            type="number"
            min="0"
            step="any"
            size="sm"
            required
            value={unitPrice}
            onChange={(e) => {
              setPriceTouched(true);
              setUnitPrice(e.target.value);
            }}
          />
          {/* The step's quantity is in the article's base unit, like the staffel itself. */}
          {priceTier !== null && !priceTouched && (
            <FormHint attached>
              Staffelpris från {formatQuantity(priceTier)} {article?.unit}
            </FormHint>
          )}
        </Field>
      </FormRow>

      <Field label="Önskat leveransdatum (valfritt)" htmlFor="rowDeliveryDate">
        <Input
          id="rowDeliveryDate"
          type="date"
          size="sm"
          value={deliveryDate}
          onChange={(e) => {
            setDateTouched(true);
            setDeliveryDate(e.target.value);
          }}
        />
        <FormHint attached>
          Tomt = samma som ordern{orderDeliveryDate ? ` (${orderDeliveryDate})` : ""}.
        </FormHint>
        <DeliveryDateHint warning={dateWarning} />
      </Field>

      <Field label="Bekräftat leveransdatum (valfritt)" htmlFor="rowConfirmedDate">
        <Input
          id="rowConfirmedDate"
          type="date"
          size="sm"
          value={confirmedDate}
          onChange={(e) => setConfirmedDate(e.target.value)}
        />
        <FormHint attached>
          Tomt = samma som ordern{orderConfirmedDate ? ` (${orderConfirmedDate})` : ""}.
        </FormHint>
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || quoting}>
          {pending ? "Lägger till…" : quoting ? "Hämtar pris…" : "Lägg till rad"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

// --- Receive goods (confirmed / partially_received only) ---

function ReceiveGoodsForm({
  orderId,
  rows,
  locations,
  onDone,
  onCancel,
}: {
  orderId: string;
  // Only the rows with something left to receive.
  rows: PurchaseOrderRow[];
  locations: StockLocation[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const placeLabels = usePlaceLabels();
  const router = useRouter();
  const [rowId, setRowId] = useState(rows[0]?.id ?? "");
  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Quantities are entered in the row's unit and converted to the base unit
  // before hitting the receive endpoint (stock is always base).
  const selectedRow = rows.find((r) => r.id === rowId) ?? rows[0];
  // Bokför per (#19): the day the goods arrived. A lego row reports its TO
  // operation now, so it is always received per today.
  const [today] = useState(stockholmToday);
  const [receivedOn, setReceivedOn] = useState(today);
  const legoRow = selectedRow?.moOperationId != null;
  const backdated = !legoRow && receivedOn !== "" && receivedOn !== today;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch<{ operationReport?: { ok: boolean; message?: string }; receiptId?: string }>(
          `/api/v1/purchase-orders/${orderId}/rows/${rowId}/receive`,
          {
            method: "POST",
            body: JSON.stringify({
              locationId: locationId || undefined,
              quantity: toBaseQuantity(Number(quantity), selectedRow?.unitFactor ?? null),
              ...(backdated ? { receivedOn } : {}),
              allowMaterialShortage,
            }),
          }
        )
      );
      if (result === null) return;
      // Återkoppling (punkt 7): what was received, with Ångra on exactly this
      // receipt. A lego row's failed TO report leaves the receipt standing —
      // said in a notice of its own.
      const receiptId = result.receiptId;
      notify({
        message: `Inlevererat ${quantity} ${selectedRow?.unitCode ?? ""} ${selectedRow?.articleNumber ?? ""}.`.replace(/\s+\./, "."),
        action: receiptId
          ? {
              label: "Ångra",
              run: async () => {
                await apiFetch(`/api/v1/purchase-orders/${orderId}/receipts/${receiptId}/undo`, { method: "POST" });
                router.refresh();
                return "Inleveransen är ångrad.";
              },
            }
          : undefined,
      });
      if (result.operationReport && !result.operationReport.ok) {
        notify({
          tone: "error",
          message: `Inleveransen är bokförd, men legooperationen kunde inte avrapporteras: ${result.operationReport.message ?? "okänt fel"}`,
        });
      }
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta emot leveransen"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Rad" htmlFor="rowId">
        <Select id="rowId" value={rowId} onChange={(e) => setRowId(e.target.value)}>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.articleNumber} — {r.articleName} ({toUnitQuantity(Number(r.quantityReceived), r.unitFactor)}/
              {toUnitQuantity(Number(r.quantityOrdered), r.unitFactor)} {r.unitCode})
            </option>
          ))}
        </Select>
      </Field>

      <FormRow>
        {/* Stock locations are optional — the select only appears when some exist. */}
        {locations.length > 0 && (
          <Field label="Lagerplats" htmlFor="locationId">
            <Select id="locationId" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Artikelns lagerplats</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {placeLabels.option(l)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={selectedRow ? `Antal (${selectedRow.unitCode})` : "Antal"} htmlFor="receiveQuantity">
          <Input
            id="receiveQuantity"
            type="number"
            min="0"
            step="any"
            size="sm"
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        <Field label="Bokför per" htmlFor="receiveDate">
          <Input
            id="receiveDate"
            type="date"
            size="sm"
            required
            max={today}
            value={legoRow ? today : receivedOn}
            disabled={legoRow}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </Field>
      </FormRow>
      {(legoRow || backdated) && (
        <FormHint>
          {legoRow
            ? "En legorad inlevereras alltid per i dag — inleveransen rapporterar TO-operationen."
            : `Godset räknas in i lagervärderingen och leveransprecisionen per ${receivedOn}.`}
        </FormHint>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Tar emot…" : "Ta emot"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
