"use client";

import { confirmDelete } from "../../lib/confirm";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { RowDeviationLink } from "../quality/RowDeviationLink";
import { useCan } from "../PermissionsProvider";
import { ArticleOverviewButton } from "../articles/ArticleOverviewButton";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Modal } from "../ui/Modal";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { DocumentHeaderCard } from "../documents/DocumentHeaderCard";
import { DocumentActionBar } from "../documents/DocumentActionBar";
import { ManualStatusChange } from "../documents/ManualStatusChange";
import { TermsFields, termsFrom, termsLabel, termsPayload, type TermsRegisters, type TermsValue } from "../documents/TermsFields";
import { toBaseQuantity, toUnitPrice, toUnitQuantity } from "../../lib/units";
import { requoteFor } from "../../lib/rowRequote";
import { formatMoney } from "../../lib/format";
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
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";

interface PurchaseOrderDetailProps {
  order: PurchaseOrder;
  rows: PurchaseOrderRow[];
  locations: StockLocation[];
  registers: TermsRegisters;
}

// Confirm / cancel / close — no body, just an action call.
type PurchaseAction = "confirm" | "cancel" | "close";

const ACTION_ENDPOINTS: Record<PurchaseAction, string> = {
  confirm: "confirm",
  cancel: "cancel",
  close: "close",
};

export function PurchaseOrderDetail({ order, rows, locations, registers }: PurchaseOrderDetailProps) {
  const router = useRouter();
  const pill = PURCHASE_ORDER_STATUS_PILL[order.status];
  // Rows stay editable until the order is fully received/closed/cancelled;
  // per-row guards (quantity ≥ received, no delete with receipts) are
  // enforced by the API and mirrored in the UI below.
  const rowsEditable = order.status === "draft" || order.status === "confirmed" || order.status === "partially_received";
  // Kvalitet: Avvikelse per orderrad on an order that has been placed.
  const canDeviate = useCan()(["kvalitet"]) && order.status !== "draft" && order.status !== "cancelled";
  const deviationLink = (row: PurchaseOrderRow) => (
    <RowDeviationLink
      label="Avvikelse"
      params={{
        type: "supplier",
        supplierId: order.supplierId,
        purchaseOrderId: order.id,
        purchaseOrderRowId: row.id,
        articleId: row.articleId,
      }}
    />
  );

  const [modal, setModal] = useState<"header" | "addRow" | "receive" | null>(null);
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
  const editUnitOptions = useUnitOptions(editArticle);
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
  const editPricedBaseQuantityRef = useRef(0);
  const editRequestSeq = useRef(0);
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
        if (seq !== editRequestSeq.current) return;
        // No catalog price, or a catalog currency other than the order's:
        // leave the field as it is rather than guess.
        if (!quote.price || quote.price.currency !== order.currency) return;
        setEditPrice(String(toUnitPrice(quote.price.unitPrice, factor)));
      })
      .catch(() => {});
  }, [editingRowId, editQuantity, editUnitId, editUnitOptions, editPriceTouched, rows, order.supplierId, order.currency]);

  const receivable = rows.filter((r) => Number(r.quantityReceived) < Number(r.quantityOrdered));
  // Quantity and price are both stored in the article's base unit, so the
  // line amount is the same number whichever unit the row is displayed in.
  // A lego row's ställpris is a one-off charge added once per row.
  const rowAmount = (r: PurchaseOrderRow) =>
    Number(r.quantityOrdered) * Number(r.unitPrice) + (r.setupPrice != null ? Number(r.setupPrice) : 0);
  const total = rows.reduce((sum, r) => sum + rowAmount(r), 0);

  function refresh() {
    setModal(null);
    router.refresh();
  }

  function startEditRow(row: PurchaseOrderRow) {
    setEditingRowId(row.id);
    setEditPriceTouched(false);
    editPricedBaseQuantityRef.current = Number(row.quantityOrdered);
    setEditQuantity(String(toUnitQuantity(Number(row.quantityOrdered), row.unitFactor)));
    setEditPrice(String(toUnitPrice(Number(row.unitPrice), row.unitFactor)));
    setEditUnitId(row.unitId ?? "");
    setEditSetupPrice(row.setupPrice != null ? String(Number(row.setupPrice)) : "");
    setEditDeliveryDate(row.expectedDeliveryDate ?? "");
    setEditConfirmedDate(row.confirmedDeliveryDate ?? "");
    setEditArticle(null);
    apiFetch<Article>(`/api/v1/articles/${row.articleId}`).then(setEditArticle).catch(() => {});
  }

  function switchEditUnit(option: UnitOption) {
    setEditQuantity((q) => convertQuantityInput(q, editFactor, option.factor));
    setEditPrice((p) => convertPriceInput(p, editFactor, option.factor));
    setEditUnitId(option.value);
  }

  async function saveRow(row: PurchaseOrderRow) {
    const bumpRevision = await askBumpRevision(order.revision);
    setRowError(null);
    setRowPending(true);
    try {
      await apiFetch(`/api/v1/purchase-orders/${order.id}/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          quantity: Number(editQuantity),
          unitPrice: Number(editPrice),
          unitId: editUnitId === "" ? null : editUnitId,
          setupPrice: editSetupPrice.trim() === "" ? null : Number(editSetupPrice),
          expectedDeliveryDate: editDeliveryDate || null,
          confirmedDeliveryDate: editConfirmedDate || null,
          bumpRevision,
        }),
      });
      setEditingRowId(null);
      router.refresh();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Kunde inte spara raden");
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
      setRowError(err instanceof Error ? err.message : "Kunde inte ta bort raden");
    } finally {
      setRowPending(false);
    }
  }

  async function runAction(action: PurchaseAction) {
    setActionError(null);
    setActionPending(action);
    try {
      await apiFetch(`/api/v1/purchase-orders/${order.id}/${ACTION_ENDPOINTS[action]}`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Åtgärden misslyckades");
    } finally {
      setActionPending(null);
    }
  }

  return (
    <div>
      <DocumentHeaderCard
        pill={pill}
        meta={`Rev ${order.revision} · ${order.currency}`}
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
        ]}
        note={order.note}
        onEdit={rowsEditable ? () => setModal("header") : undefined}
      />

      <FormError margin="below">{rowError}</FormError>

      {rows.length > 0 ? (
        <Table<PurchaseOrderRow>
          columns={[
            { key: "articleNumber", label: "Artikelnummer", width: "140px" },
            { key: "articleName", label: "Benämning", width: "1fr" },
            { key: "quantityOrdered", label: "Beställt", width: "110px", align: "right" },
            { key: "unitCode", label: "Enhet", width: "80px" },
            { key: "quantityReceived", label: "Mottaget", width: "100px", align: "right" },
            { key: "unitPrice", label: "Á-pris", width: "130px", align: "right" },
            { key: "lineAmount", label: "Belopp", width: "130px", align: "right" },
            ...(rowsEditable || canDeviate ? ([{ key: "id", label: "", width: "180px", align: "right" }] as const) : []),
          ]}
          rows={rows}
          footer={{ unitPrice: "Summa", lineAmount: `${formatMoney(total)} ${order.currency}` }}
          renderCell={(row, key) => {
            switch (key) {
              case "articleNumber":
                return (
                  <>
                    {row.articleNumber}
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
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    size="sm"
                    value={editPrice}
                    onChange={(e) => {
                      setEditPriceTouched(true);
                      setEditPrice(e.target.value);
                    }}
                  />
                ) : (
                  `${formatMoney(toUnitPrice(Number(row.unitPrice), row.unitFactor))} ${order.currency}`
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
                        {editingRowId !== row.id && row.setupPrice != null
                          ? ` — Ställpris ${formatMoney(Number(row.setupPrice))} ${order.currency}`
                          : ""}
                      </div>
                    )}
                    {showSetupPrice && editingRowId === row.id && (
                      <div style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6 }}>
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
                    {editingRowId !== row.id &&
                      row.confirmedDeliveryDate &&
                      row.confirmedDeliveryDate !== order.confirmedDeliveryDate && (
                        <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                          Bekräftat leveransdatum {row.confirmedDeliveryDate}
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
              case "lineAmount":
                return formatMoney(rowAmount(row));
              case "id":
                if (!rowsEditable) return deviationLink(row);
                return editingRowId === row.id ? (
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Button type="button" size="small" variant="primary" disabled={rowPending} onClick={() => saveRow(row)}>
                      Spara
                    </Button>
                    <Button type="button" size="small" variant="ghost" onClick={() => setEditingRowId(null)}>
                      Avbryt
                    </Button>
                  </span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Button type="button" size="small" variant="ghost" onClick={() => startEditRow(row)}>
                      Ändra
                    </Button>
                    {Number(row.quantityReceived) === 0 && (
                      <Button type="button" size="small" variant="danger" disabled={rowPending} onClick={() => removeRow(row)}>
                        Ta bort
                      </Button>
                    )}
                    {canDeviate && deviationLink(row)}
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

      <DocumentActionBar
        error={actionError}
        trailing={
          <ManualStatusChange
            endpoint={`/api/v1/purchase-orders/${order.id}`}
            statuses={PURCHASE_ORDER_STATUS_PILL}
            current={order.status}
            onDone={() => router.refresh()}
          />
        }
      >
        {rowsEditable && (
          <Button type="button" variant="secondary" onClick={() => setModal("addRow")}>
            Lägg till rad
          </Button>
        )}

        {order.status === "draft" && (
          <Button type="button" variant="primary" disabled={actionPending !== null} onClick={() => runAction("confirm")}>
            {actionPending === "confirm" ? "Arbetar…" : "Bekräfta"}
          </Button>
        )}

        {(order.status === "confirmed" || order.status === "partially_received") && (
          <>
            {receivable.length > 0 && (
              <Button type="button" variant="primary" onClick={() => setModal("receive")}>
                Ta emot leverans
              </Button>
            )}
            <Link href={`/inkop/inleverans?order=${order.id}`} className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Inleveransrutinen
            </Link>
          </>
        )}

        {order.status === "received" && (
          <Button type="button" variant="primary" disabled={actionPending !== null} onClick={() => runAction("close")}>
            {actionPending === "close" ? "Arbetar…" : "Stäng order"}
          </Button>
        )}

        {(order.status === "draft" || order.status === "confirmed") && (
          <Button type="button" variant="danger" disabled={actionPending !== null} onClick={() => runAction("cancel")}>
            {actionPending === "cancel" ? "Arbetar…" : "Avbryt order"}
          </Button>
        )}
      </DocumentActionBar>

      <Modal open={modal === "header"} onClose={() => setModal(null)} title="Ändra orderhuvud">
        <EditHeaderForm order={order} registers={registers} onDone={refresh} onCancel={() => setModal(null)} />
      </Modal>

      <Modal open={modal === "addRow"} onClose={() => setModal(null)} title="Lägg till rad">
        <AddRowForm
          orderId={order.id}
          supplierId={order.supplierId}
          currency={order.currency}
          revision={order.revision}
          orderDeliveryDate={order.expectedDeliveryDate}
          orderConfirmedDate={order.confirmedDeliveryDate}
          onDone={refresh}
          onCancel={() => setModal(null)}
        />
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

function EditHeaderForm({
  order,
  registers,
  onDone,
  onCancel,
}: {
  order: PurchaseOrder;
  registers: TermsRegisters;
  onDone: () => void;
  onCancel: () => void;
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

  async function save(e: FormEvent) {
    e.preventDefault();
    const bumpRevision = await askBumpRevision(order.revision);
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/purchase-orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedDeliveryDate: expectedDeliveryDate || null,
          confirmedDeliveryDate: confirmedDeliveryDate || null,
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
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={save}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Önskat leveransdatum" htmlFor="headerExpectedDeliveryDate">
          <Input
            id="headerExpectedDeliveryDate"
            type="date"
            size="sm"
            value={expectedDeliveryDate}
            onChange={(e) => setExpectedDeliveryDate(e.target.value)}
          />
          <DeliveryDateHint summary={dateHint.summary} warning={dateHint.warning} />
        </Field>
        <Field label="Bekräftat leveransdatum" htmlFor="headerConfirmedDeliveryDate">
          <Input
            id="headerConfirmedDeliveryDate"
            type="date"
            size="sm"
            value={confirmedDeliveryDate}
            onChange={(e) => setConfirmedDeliveryDate(e.target.value)}
          />
        </Field>
        <Field label="Växelkurs" htmlFor="headerExchangeRate">
          <Input
            id="headerExchangeRate"
            type="number"
            min="0"
            step="any"
            size="xs"
            required
            value={exchangeRate}
            onChange={(e) => setExchangeRate(e.target.value)}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Er referens" htmlFor="headerYourReference">
          <Input id="headerYourReference" maxLength={100} value={yourReference} onChange={(e) => setYourReference(e.target.value)} />
        </Field>
        <Field label="Vår referens" htmlFor="headerOurReference">
          <Input id="headerOurReference" maxLength={100} value={ourReference} onChange={(e) => setOurReference(e.target.value)} />
        </Field>
      </FormRow>

      <DimensionFields
        idPrefix="header"
        lists={dims}
        withCostCenter={false}
        costCenterId=""
        projectId={projectId}
        onCostCenterChange={() => {}}
        onProjectChange={setProjectId}
      />

      <TermsFields registers={registers} value={terms} onChange={setTerms} />

      <Field label="Frakt på vårt konto" htmlFor="headerFreightPaidByUs">
        <Toggle id="headerFreightPaidByUs" checked={freightPaidByUs} onChange={(e) => setFreightPaidByUs(e.target.checked)} />
      </Field>

      <Field label="Anteckning" htmlFor="headerNote">
        <Input id="headerNote" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

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
  orderId,
  supplierId,
  currency,
  revision,
  orderDeliveryDate,
  orderConfirmedDate,
  onDone,
  onCancel,
}: {
  orderId: string;
  supplierId: string;
  currency: string;
  revision: number;
  orderDeliveryDate: string | null;
  orderConfirmedDate: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0");
  const [unitId, setUnitId] = useState(""); // "" = the article's base unit
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
  const requestSeq = useRef(0);
  const articleId = article?.id ?? null;
  const parsedQuantity = Number(quantity);
  const baseQuantity =
    articleId && Number.isFinite(parsedQuantity) && parsedQuantity > 0
      ? toBaseQuantity(parsedQuantity, currentFactor)
      : null;

  useEffect(() => {
    if (priceTouched || !articleId || baseQuantity === null) return;
    const seq = ++requestSeq.current;
    apiFetch<SupplierPriceQuote>(
      `/api/v1/supplier-price-quote?supplierId=${supplierId}&articleId=${articleId}&quantity=${baseQuantity}`
    )
      .then((quote) => {
        if (seq !== requestSeq.current) return;
        // No catalog price, or a catalog currency other than the order's:
        // leave the field alone rather than guess.
        if (!quote.price || quote.price.currency !== currency) return;
        setUnitPrice(String(toUnitPrice(quote.price.unitPrice, currentFactor)));
      })
      .catch(() => {});
  }, [articleId, baseQuantity, supplierId, currency, priceTouched, currentFactor]);

  // Picking an article pre-selects its purchase unit; switching unit
  // re-expresses the entered quantity and price (500 kg ⇄ 100 st).
  function handleArticleChange(next: Article | null) {
    setArticle(next);
    setUnitId(next?.purchaseUnitId ?? "");
    // "Manuellt vinner" is per article — a new pick gets its own prefill.
    setPriceTouched(false);
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
      setError(err instanceof Error ? err.message : "Kunde inte lägga till raden");
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

      <FormRow columns={3}>
        <Field label="Antal" htmlFor="quantity">
          <Input id="quantity" type="number" min="0" step="any" size="sm" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Enhet" htmlFor="rowUnit">
          <UnitSelect id="rowUnit" options={unitOptions} value={unitId} onChange={handleUnitChange} />
        </Field>
        <Field label={unitCode ? `Á-pris (kr/${unitCode})` : "Á-pris"} htmlFor="unitPrice">
          <Input
            id="unitPrice"
            type="number"
            min="0"
            step="0.01"
            size="sm"
            required
            value={unitPrice}
            onChange={(e) => {
              setPriceTouched(true);
              setUnitPrice(e.target.value);
            }}
          />
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
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Lägger till…" : "Lägg till rad"}
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
  const [rowId, setRowId] = useState(rows[0]?.id ?? "");
  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Quantities are entered in the row's unit and converted to the base unit
  // before hitting the receive endpoint (stock is always base).
  const selectedRow = rows.find((r) => r.id === rowId) ?? rows[0];

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch<{ operationReport?: { ok: boolean; message?: string } }>(
          `/api/v1/purchase-orders/${orderId}/rows/${rowId}/receive`,
          {
            method: "POST",
            body: JSON.stringify({
              locationId: locationId || undefined,
              quantity: toBaseQuantity(Number(quantity), selectedRow?.unitFactor ?? null),
              allowMaterialShortage,
            }),
          }
        )
      );
      if (result === null) return;
      // Lego row: the receipt auto-reports the linked TO operation; a failed
      // report leaves the receipt standing, so warn instead of failing.
      if (result.operationReport && !result.operationReport.ok) {
        window.alert(
          `Inleveransen är bokförd, men legooperationen kunde inte avrapporteras: ${result.operationReport.message ?? "okänt fel"}`
        );
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
                  {l.warehouseName} — {l.name}
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
      </FormRow>

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
