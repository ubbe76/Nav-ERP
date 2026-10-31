"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { QuoteExpiredBadge, isQuoteExpired } from "./QuoteExpiredBadge";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { DeliveryTimeCheckDialog } from "./DeliveryTimeCheckDialog";
import { FreightQuoteDialog } from "../shipping/FreightQuoteDialog";
import { formatSek } from "../../lib/shipping";
import Link from "next/link";
import { RowDeviationLink } from "../quality/RowDeviationLink";
import { ArticleOverviewButton } from "../articles/ArticleOverviewButton";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill } from "../ui/StatusPill";
import { useCan } from "../PermissionsProvider";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import fieldStyles from "../ui/Field.module.css";
import { Modal } from "../ui/Modal";
import { Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { ConfigureModal } from "../configurator/ConfigureModal";
import { ConfigurationLineList, ConfigurationLines } from "../configurator/ConfigurationLines";
import { selectionFromEntries, type ConfiguratorEvaluation, type ConfiguratorSelection, type ResolveVariantResult, type RowConfigurationDraft, type VariantOf } from "../../lib/configurator";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { DocumentHeaderCard } from "../documents/DocumentHeaderCard";
import { DocumentActionBar } from "../documents/DocumentActionBar";
import { ManualStatusChange } from "../documents/ManualStatusChange";
import { TermsFields, termsFrom, termsLabel, termsPayload, type TermsRegisters, type TermsValue } from "../documents/TermsFields";
import { formatStockholmDate, formatStockholmDateTime } from "../../lib/date";
import { configuredDeliveryWarning } from "../../lib/configuredDelivery";
import { toBaseQuantity, toBasePrice, toUnitPrice, toUnitQuantity } from "../../lib/units";
import { requoteFor } from "../../lib/rowRequote";
import { marginLabel, useArticleSelfCost, useConfiguredSelfCost } from "./useArticleMargin";
import { computeLineMargin, sumMargins } from "../../lib/margin";
import { formatMoney } from "../../lib/format";
import { currencyLabel, formatRate, SEK, toSek } from "../../lib/currency";
import { parseRate, priceQuotePath } from "../../lib/priceQuote";
import { useOrderRate } from "../../lib/useOrderRate";
import { CurrencyInput } from "../ui/CurrencyInput";
import { OrderRateField } from "./OrderRateField";
import { apiFetch } from "../../lib/api";
import { stashReleaseWarnings } from "../../lib/releaseWarnings";
import { apiErrorMessage } from "../../lib/errorMessages";
import { askBumpRevision } from "../../lib/revision";
import { headerDimensionFields, useDimensions } from "../../lib/dimensions";
import { DimensionFields } from "../economy/DimensionSelect";
import { salesDocumentKind } from "../../lib/salesDocumentKind";
import {
  MANUFACTURING_ORDER_STATUS_PILL,
  SALES_ORDER_STATUS_PILL,
  type Article,
  type CustomerDeliveryAddress,
  type ManufacturingOrder,
  type ManufacturingOrderStatus,
  type OrderFreight,
  type PriceQuote,
  type SalesOrder,
  type SalesOrderRow,
  type StockLocation,
} from "../../lib/types";
import {
  DeliveryAddressChoice,
  deliveryAddressPayload,
  emptyDeliveryAddressDraft,
  type DeliveryAddressDraft,
} from "./DeliveryAddressChoice";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { SuggestedDueDateField } from "../manufacturing/SuggestedDueDateField";

interface SalesOrderDetailProps {
  order: SalesOrder;
  rows: SalesOrderRow[];
  locations: StockLocation[];
  deliveryAddresses: CustomerDeliveryAddress[];
  registers: TermsRegisters;
  freightEnabled: boolean;
}

// Confirm / cancel / start-production — no body, just an action call.
// Fakturera is now a Link into the invoice module (Task 9), not an action call.
type SalesAction = "confirm" | "cancel" | "start-production" | "reopen";

export function SalesOrderDetail({ order, rows, locations, deliveryAddresses, registers, freightEnabled }: SalesOrderDetailProps) {
  const router = useRouter();
  const canSell = useCan()(["forsaljning"]);
  const [freightOpen, setFreightOpen] = useState(false);
  const dims = useDimensions();
  const [freight, setFreight] = useState<OrderFreight | null>(null);
  const reloadFreight = useCallback(() => {
    if (!freightEnabled) return;
    apiFetch<OrderFreight>(`/api/v1/sales-orders/${order.id}/freight`)
      .then(setFreight)
      .catch(() => setFreight(null));
  }, [freightEnabled, order.id]);
  useEffect(reloadFreight, [reloadFreight]);
  // "Skapa tillverkningsorder" posts to the manufacturing module, which only
  // Tillverkning may write — hidden for everyone else.
  const canCreateMo = useCan()(["tillverkning"]);
  // Kvalitet: Reklamera per orderrad, once the order is a confirmed order.
  const canReclaim =
    useCan()(["kvalitet"]) && ["confirmed", "in_production", "delivered", "invoiced"].includes(order.status);
  // Leveranstidskontroll is open to Försäljning and Tillverkning alike.
  const canCheckDelivery = useCan()(["forsaljning", "tillverkning"]);
  const [dtcOpen, setDtcOpen] = useState(false);
  const [dtcBusy, setDtcBusy] = useState(false);
  const [dtcError, setDtcError] = useState<string | null>(null);
  const pill = SALES_ORDER_STATUS_PILL[order.status];
  // Rows stay editable until the order is delivered/invoiced/cancelled;
  // per-row guards (quantity ≥ delivered, no delete with deliveries) are
  // enforced by the API and mirrored in the UI below.
  const rowsEditable = order.status === "quote" || order.status === "confirmed" || order.status === "in_production";

  const [modal, setModal] = useState<"header" | "addRow" | "deliver" | "createMo" | "lose" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowPending, setRowPending] = useState(false);
  // E3: the row "Skapa tillverkningsorder" was invoked for — read by the
  // createMo modal below.
  const [moRow, setMoRow] = useState<SalesOrderRow | null>(null);
  // Ändra konfiguration: the row being reconfigured, its template and the stored choices.
  const [reconfigure, setReconfigure] = useState<{
    row: SalesOrderRow;
    template: Article;
    initial: ConfiguratorSelection;
    notice: string | undefined;
  } | null>(null);
  const [configureKey, setConfigureKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<SalesAction | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editDiscountPercent, setEditDiscountPercent] = useState("0");
  const [editUnitId, setEditUnitId] = useState("");
  const [editDeliveryDate, setEditDeliveryDate] = useState("");
  // C3: mirrors AddRowForm's priceTouched — set once the operator types in
  // the price/discount field for the row being edited, so a quantity edit
  // afterwards never silently overwrites it ("manuellt vinner"). Reset
  // whenever edit mode is (re)opened.
  const [editPriceTouched, setEditPriceTouched] = useState(false);
  // The article behind the row being edited — fetched so the unit dropdown
  // knows the base unit + alternative units.
  const [editArticle, setEditArticle] = useState<Article | null>(null);
  const editUnitOptions = useUnitOptions(editArticle);
  const editFactor = editUnitOptions.find((o) => o.value === editUnitId)?.factor ?? 1;
  const editRequestSeq = useRef(0);
  // The touched flag as it is when a prefill response LANDS — the effect's
  // closure holds it as it was when the request left, so a price typed while
  // the request was in flight would otherwise be overwritten ("manuellt vinner").
  const editPriceTouchedNow = useRef(editPriceTouched);
  editPriceTouchedNow.current = editPriceTouched;
  // The base quantity the shown price belongs to — the row's own when Ändra
  // opens, then each quoted quantity (lib/rowRequote.ts: 10 → 100 → 10 comes
  // back to the 10-tier, a pure unit switch never reprices, and nothing is
  // asked before the article's units have loaded).
  const editPricedBaseQuantityRef = useRef(0);

  const deliverable = rows.filter((r) => Number(r.quantityDelivered) < Number(r.quantityOrdered));
  // Valuta: the order's prices are in its currency; the rate (SEK per 1 unit,
  // 1 for SEK) converts them to SEK for the täckningsbidrag (the self cost is
  // SEK) and the order value in SEK.
  const orderRate = Number(order.exchangeRate);
  const foreign = order.currency !== SEK;
  // Quantity and price are both stored in the article's base unit, so the
  // line amount is the same number whichever unit the row is displayed in.
  const total = rows.reduce(
    (sum, r) => sum + Number(r.quantityOrdered) * Number(r.unitPrice) * (1 - Number(r.discountPercent) / 100),
    0
  );
  // Täckningsbidrag for the order. Rows whose article has no saved
  // pre-calculation are counted separately rather than treated as costing
  // nothing — see lib/margin.ts.
  const orderMargin = sumMargins(
    rows.map((r) =>
      computeLineMargin({
        quantity: Number(r.quantityOrdered),
        // SEK: the price is converted with the order's rate before it is
        // measured against the (SEK) self cost.
        unitPrice: Number(r.unitPrice) * orderRate,
        discountPercent: Number(r.discountPercent),
        selfCostPerUnit: r.selfCostPerUnit,
      })
    )
  );

  const configuredCostDates = [
    ...new Set(
      rows
        .filter((r) => r.configuration && r.selfCostPerUnit !== null && r.selfCostCalculatedAt)
        .map((r) => formatStockholmDate(r.selfCostCalculatedAt))
    ),
  ].sort();
  // A configured row whose structure carries no cost (or whose förkalkyl
  // failed when the row was priced — never a reason to refuse the sale) is
  // named as such rather than folded into the generic count.
  const configuredWithoutCost = rows.filter((r) => r.configuration && r.selfCostPerUnit === null).length;

  // C3 price/discount prefill for the row being edited: when the quantity
  // changes and the operator hasn't touched price/discount themselves, ask
  // the price chain again (the article never changes in edit mode). Same
  // request-sequence race guard as AddRowForm/NewQuoteForm below.
  useEffect(() => {
    if (editingRowId === null || editPriceTouched || !editArticle) return;
    const requote = requoteFor({
      quantity: editQuantity,
      unitId: editUnitId,
      unitOptions: editUnitOptions,
      pricedBaseQuantity: editPricedBaseQuantityRef.current,
    });
    if (!requote) return;
    const { base: baseQuantity, factor } = requote;
    // Claimed up front so an answer without a price isn't re-asked on every
    // unrelated rerender; a later quantity change asks again.
    editPricedBaseQuantityRef.current = baseQuantity;
    const seq = ++editRequestSeq.current;
    const editedRow = rows.find((r) => r.id === editingRowId);
    if (editedRow?.configuration) {
      // A configured row is priced by the configurator (staffel at the new quantity), not the price chain.
      apiFetch<ConfiguratorEvaluation>(`/api/v1/configurator/${editedRow.articleId}/evaluate`, {
        method: "POST",
        body: JSON.stringify({
          selection: selectionFromEntries(editedRow.configuration.selection),
          customerId: order.customerId,
          quantity: baseQuantity,
          // Valuta: the order's currency and rate.
          currency: order.currency,
          ...(foreign ? { exchangeRate: orderRate } : {}),
        }),
      })
        .then((evaluation) => {
          if (seq !== editRequestSeq.current) return;
          // Said now rather than at Spara, where the server refuses the same
          // quantity change: choices the template no longer accepts, or a
          // template that resolves them to another configuration than the
          // row shows (a förval added since — its price would include it).
          if (!evaluation.valid) {
            setRowError(`Konfigurationen är inte längre giltig: ${evaluation.errors.join("; ") || "okänt fel"} — använd Ändra konfiguration.`);
            return;
          }
          if (evaluation.key !== editedRow.configuration?.key) {
            setRowError(apiErrorMessage({ code: "row-configuration-outdated" }, ""));
            return;
          }
          setRowError(null);
          if (evaluation.price.unitPrice === null || editPriceTouchedNow.current) return;
          setEditPrice(String(toUnitPrice(evaluation.price.unitPrice, factor)));
          setEditDiscountPercent(String(evaluation.price.discountPercent));
        })
        .catch((err) => {
          if (seq === editRequestSeq.current) setRowError(apiErrorMessage(err, "Konfigurationen kunde inte prissättas för det nya antalet"));
        });
      return;
    }
    apiFetch<PriceQuote>(
      // Valuta: salesOrderId — the order's own currency and rate decide.
      priceQuotePath({ customerId: order.customerId, articleId: editArticle.id, quantity: baseQuantity, salesOrderId: order.id })
    )
      .then((quote) => {
        if (seq !== editRequestSeq.current || editPriceTouchedNow.current) return;
        if (!quote.price) return;
        setEditPrice(String(toUnitPrice(quote.price.unitPrice, factor)));
        setEditDiscountPercent(String(quote.price.discountPercent));
      })
      .catch(() => {
        // Best-effort prefill — silently leave the fields untouched on error.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRowId, editQuantity, editUnitId, editUnitOptions, editPriceTouched, editArticle, order.customerId]);

  const deliveryText = order.deliveryAddress
    ? [
        order.deliveryAddressLabel,
        order.deliveryAddress,
        [order.deliveryPostalCode, order.deliveryCity].filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .join(", ")
    : null;

  function refresh() {
    setModal(null);
    router.refresh();
  }

  // Reklamera: Ny avvikelse prefilled from the row (RowDeviationLink hides itself without Kvalitet).
  function reclaimLink(row: SalesOrderRow) {
    return (
      <RowDeviationLink
        label="Reklamera"
        params={{
          type: "customer",
          customerId: order.customerId,
          salesOrderId: order.id,
          salesOrderRowId: row.id,
          articleId: row.articleId,
        }}
      />
    );
  }

  function startEditRow(row: SalesOrderRow) {
    const initialQuantity = String(toUnitQuantity(Number(row.quantityOrdered), row.unitFactor));
    setEditingRowId(row.id);
    setEditQuantity(initialQuantity);
    // quantityOrdered is already stored in the article's base unit — the
    // stored price belongs to it.
    editPricedBaseQuantityRef.current = Number(row.quantityOrdered);
    setEditPrice(String(toUnitPrice(Number(row.unitPrice), row.unitFactor)));
    setEditDiscountPercent(String(Number(row.discountPercent)));
    setEditPriceTouched(false);
    setEditUnitId(row.unitId ?? "");
    setEditDeliveryDate(row.expectedDeliveryDate ?? "");
    setEditArticle(null);
    apiFetch<Article>(`/api/v1/articles/${row.articleId}`).then(setEditArticle).catch(() => {});
  }

  function switchEditUnit(option: UnitOption) {
    setEditQuantity((q) => convertQuantityInput(q, editFactor, option.factor));
    setEditPrice((p) => convertPriceInput(p, editFactor, option.factor));
    setEditUnitId(option.value);
  }

  function openCreateMo(row: SalesOrderRow) {
    setMoRow(row);
    setModal("createMo");
  }

  async function openReconfigure(row: SalesOrderRow) {
    setActionError(null);
    try {
      if (row.configuration) {
        const template = await apiFetch<Article>(`/api/v1/articles/${row.configuration.templateArticleId}`);
        setReconfigure({
          row,
          template,
          initial: selectionFromEntries(row.configuration.selection),
          notice: "Ett handskrivet à-pris ersätts av konfigurationens pris.",
        });
      } else {
        const variantOf = await apiFetch<VariantOf>(`/api/v1/articles/${row.articleId}/variant-of`);
        const template = await apiFetch<Article>(`/api/v1/articles/${variantOf.templateArticleId}`);
        setReconfigure({ row, template, initial: selectionFromEntries(variantOf.selection), notice: undefined });
      }
      setConfigureKey((k) => k + 1);
    } catch (err) {
      setActionError(apiErrorMessage(err, "Kunde inte öppna konfigurationen"));
    }
  }

  // A failure is thrown back to ConfigureModal, which shows it and keeps the
  // dialog open with the choices (a 409 must not throw them away).
  async function saveReconfigure(draft: RowConfigurationDraft) {
    if (!reconfigure) return;
    const bumpRevision = await askBumpRevision(order.revision);
    await apiFetch(`/api/v1/sales-orders/${order.id}/rows/${reconfigure.row.id}/configuration`, {
      method: "PUT",
      body: JSON.stringify({ selection: draft.selection, bumpRevision }),
    });
    setReconfigure(null);
    router.refresh();
  }

  async function saveRow(row: SalesOrderRow) {
    const bumpRevision = await askBumpRevision(order.revision);
    setRowError(null);
    setRowPending(true);
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          quantity: Number(editQuantity),
          // Always sent explicitly — the web never relies on the server's
          // own price-chain resolution (that path is for the configurator).
          unitPrice: Number(editPrice),
          discountPercent: Number(editDiscountPercent),
          unitId: editUnitId === "" ? null : editUnitId,
          expectedDeliveryDate: editDeliveryDate || null,
          bumpRevision,
        }),
      });
      setEditingRowId(null);
      router.refresh();
    } catch (err) {
      setRowError(apiErrorMessage(err, "Kunde inte spara raden"));
    } finally {
      setRowPending(false);
    }
  }

  async function removeRow(row: SalesOrderRow) {
    const hasChargeRow = rows.some(
      (r) => r.setupForRowId === row.id && Number(r.quantityDelivered) === 0
    );
    if (
      !(await confirmDelete(
        `Ta bort ${row.articleNumber} ur ordern?${hasChargeRow ? " Den tillhörande ställkostnadsraden tas bort med den." : ""}`
      ))
    )
      return;
    const bumpRevision = await askBumpRevision(order.revision);
    setRowError(null);
    setRowPending(true);
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}/rows/${row.id}?bumpRevision=${bumpRevision}`, {
        method: "DELETE",
      });
      router.refresh();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Kunde inte ta bort raden");
    } finally {
      setRowPending(false);
    }
  }

  // "Använd datumet" in Leveranstidskontroll: sets the order's expected delivery date.
  async function useCheckedDate(date: string) {
    const bumpRevision = await askBumpRevision(order.revision);
    setDtcError(null);
    setDtcBusy(true);
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({ expectedDeliveryDate: date, bumpRevision }),
      });
      setDtcOpen(false);
      router.refresh();
    } catch (err) {
      setDtcError(apiErrorMessage(err, "Kunde inte sätta leveransdatumet"));
    } finally {
      setDtcBusy(false);
    }
  }

  // Öppna igen: a lost quote becomes a quote again (the loss registration is
  // cleared; the event log keeps the old reason).
  async function reopenQuote() {
    if (!(await confirmDialog(`Öppna ${order.orderNumber} igen? Förlustorsaken rensas och offerten blir en öppen offert.`, { confirmLabel: "Öppna igen" }))) return;
    setActionError(null);
    setActionPending("reopen");
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}/reopen`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setActionError(apiErrorMessage(err, "Kunde inte öppna offerten igen"));
    } finally {
      setActionPending(null);
    }
  }

  async function runAction(action: SalesAction) {
    setActionError(null);
    setActionPending(action);
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}/${action}`, { method: "POST" });
      // Bekräfta gives the offert its KO number — continue on the order card.
      if (action === "confirm") router.push(`/forsaljning/ordrar/${order.id}`);
      else router.refresh();
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
        meta={
          <>
            Rev {order.revision} · {order.currency}
            {order.invoiceNumber &&
              ` · Faktura ${order.invoiceNumber}${order.invoicedAt ? ` (${order.invoicedAt.slice(0, 10)})` : ""}`}
          </>
        }
        fields={[
          { label: "Kund", value: order.customerName, href: `/kunder/${order.customerId}` },
          ...customerNumberFields(order),
          { label: "Referens", value: order.customerReference },
          ...headerDimensionFields(order, dims),
          ...(foreign
            ? [{ label: "Kurs", value: `1 ${order.currency} = ${formatRate(order.exchangeRate)} kr` }]
            : []),
          { label: "Leveransdatum", value: order.expectedDeliveryDate },
          ...(order.status === "quote"
            ? [
                {
                  label: "Giltig t.o.m.",
                  value: order.quoteValidUntil ? (
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {order.quoteValidUntil}
                      {isQuoteExpired(order.status, order.quoteValidUntil) && <QuoteExpiredBadge />}
                    </span>
                  ) : null,
                },
              ]
            : []),
          ...(order.status === "lost"
            ? [
                {
                  label: "Förlustorsak",
                  value: order.lostReasonName
                    ? `${order.lostReasonCode ? `${order.lostReasonCode} · ` : ""}${order.lostReasonName}`
                    : "Ingen orsak angiven",
                },
                {
                  label: "Markerad förlorad",
                  value: order.lostAt
                    ? `${formatStockholmDateTime(order.lostAt)}${order.lostByName ? ` av ${order.lostByName}` : ""}`
                    : null,
                },
                { label: "Kommentar", value: order.lostNote, wide: true },
              ]
            : []),
          { label: "Leveransvillkor", value: termsLabel(order.deliveryTermCode, order.deliveryTermName) },
          { label: "Betalningsvillkor", value: termsLabel(order.paymentTermCode, order.paymentTermName) },
          { label: "Speditör", value: termsLabel(order.carrierCode, order.carrierName) },
          { label: "Leveransadress", value: deliveryText, wide: true },
        ]}
        note={order.note}
        onEdit={rowsEditable ? () => setModal("header") : undefined}
      />

      <FormError margin="below">{rowError}</FormError>

      {rows.length > 0 ? (
        <Table<SalesOrderRow>
          columns={[
            // Fixed tracks are what decide whether the table outgrows the
            // content column, so they are kept as tight as the cell contents
            // allow — the editable cells hold inputs, and an input wider than
            // its track would push the table straight back out. The name has
            // only a small floor (minmax(120px, 1fr)) and wraps its choice
            // lines inside the track; the action buttons wrap in their cell.
            // While a row is being edited the tracks that hold inputs widen
            // (the table then scrolls inside its card) so no input is clipped.
            { key: "articleNumber", label: "Artikelnummer", width: "110px" },
            { key: "articleName", label: "Benämning", width: editingRowId ? "minmax(170px, 1fr)" : "minmax(90px, 1fr)" },
            { key: "quantityOrdered", label: "Beställt", width: editingRowId ? "90px" : "66px", align: "right" },
            { key: "unitCode", label: "Enhet", width: editingRowId ? "84px" : "52px" },
            { key: "quantityDelivered", label: "Levererat", width: "66px", align: "right" },
            // E3: quantity already in production (non-cancelled linked TOs)
            // plus one line per TO — order number linking to the TO card and
            // its status — so a row that has its TO is obvious at a glance.
            // The pill sits under the number: a wider track pushes the table
            // past the content column.
            { key: "quantityInProduction", label: "I tillverkning", width: "84px" },
            { key: "unitPrice", label: "Á-pris", width: editingRowId ? "100px" : "84px", align: "right" },
            { key: "discountPercent", label: "Rabatt", width: editingRowId ? "70px" : "52px", align: "right" },
            { key: "lineAmount", label: "Belopp", width: "76px", align: "right" },
            ...(rowsEditable || canReclaim ? ([{ key: "id", label: "", width: "140px", align: "right" }] as const) : []),
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
              case "articleName":
                return (
                  <>
                    {row.articleName}
                    <ConfigurationLines configuration={row.configuration} />
                    {/* Ställkostnad: the charge row says which article row it belongs to
                        (nothing if that row is gone). */}
                    {row.setupForRowId &&
                      (() => {
                        const owner = rows.find((r) => r.id === row.setupForRowId);
                        return owner ? (
                          <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                            Ställkostnad för {owner.articleNumber}
                          </div>
                        ) : null;
                      })()}
                    {/* The row's own leveransdatum — only shown when it differs
                        from the order's (otherwise the row follows the header). */}
                    {editingRowId !== row.id &&
                      row.expectedDeliveryDate &&
                      row.expectedDeliveryDate !== order.expectedDeliveryDate && (
                        <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                          Leveransdatum {row.expectedDeliveryDate}
                        </div>
                      )}
                    {editingRowId === row.id && (
                      <div style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <label htmlFor={`deliveryDate-${row.id}`} style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                          Leveransdatum
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
                      </div>
                    )}
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
              case "quantityDelivered":
                return toUnitQuantity(Number(row.quantityDelivered), row.unitFactor);
              case "quantityInProduction":
                if (row.manufacturingOrders.length === 0) return null;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span>{toUnitQuantity(row.quantityInProduction, row.unitFactor)}</span>
                    {row.manufacturingOrders.map((mo) => {
                      const moPill = MANUFACTURING_ORDER_STATUS_PILL[mo.status as ManufacturingOrderStatus];
                      return (
                        <span key={mo.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                          <GatedLink href={`/tillverkning/ordrar/${mo.id}`}>{mo.orderNumber}</GatedLink>
                          {moPill && <StatusPill status={moPill.status} label={moPill.label} compact />}
                        </span>
                      );
                    })}
                  </div>
                );
              case "unitPrice":
                return editingRowId === row.id ? (
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    size="sm"
                    value={editPrice}
                    onChange={(e) => {
                      setEditPrice(e.target.value);
                      setEditPriceTouched(true);
                    }}
                  />
                ) : (
                  `${formatMoney(toUnitPrice(Number(row.unitPrice), row.unitFactor))} ${order.currency}`
                );
              case "discountPercent":
                return editingRowId === row.id ? (
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    size="xs"
                    value={editDiscountPercent}
                    onChange={(e) => {
                      setEditDiscountPercent(e.target.value);
                      setEditPriceTouched(true);
                    }}
                  />
                ) : Number(row.discountPercent) > 0 ? (
                  `${Number(row.discountPercent).toLocaleString("sv-SE")} %`
                ) : (
                  ""
                );
              case "lineAmount":
                return formatMoney(
                  Number(row.quantityOrdered) * Number(row.unitPrice) * (1 - Number(row.discountPercent) / 100)
                );
              case "id":
                if (!rowsEditable) return reclaimLink(row);
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
                  <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <Button type="button" size="small" variant="ghost" onClick={() => startEditRow(row)}>
                      Ändra
                    </Button>
                    {Number(row.quantityDelivered) === 0 && (
                      <Button type="button" size="small" variant="danger" disabled={rowPending} onClick={() => removeRow(row)}>
                        Ta bort
                      </Button>
                    )}
                    {/* E3: only manufactured articles, and only once the order
                        is confirmed/in_production — createFromSalesOrderRow
                        rejects quote (LinkedOrderStatusError). */}
                    {(row.configuration || row.variantTemplateArticleId) &&
                      Number(row.quantityDelivered) === 0 &&
                      row.manufacturingOrders.length === 0 && (
                        <Button type="button" size="small" variant="ghost" onClick={() => openReconfigure(row)}>
                          Ändra konfiguration
                        </Button>
                      )}
                    {canCreateMo &&
                      row.articleType === "manufactured" &&
                      (order.status === "confirmed" || order.status === "in_production") &&
                      moRemaining(row) > 0 &&
                      Number(row.quantityDelivered) < Number(row.quantityOrdered) && (
                        <Button type="button" size="small" variant="secondary" onClick={() => openCreateMo(row)}>
                          {/* Once the row has a TO the button only offers the
                              rest; a fully covered row has no button at all
                              (an extra TO goes via + Ny tillverkningsorder). */}
                          {row.manufacturingOrders.length === 0
                            ? "Skapa tillverkningsorder"
                            : `Skapa TO för resten (${toUnitQuantity(moRemaining(row), row.unitFactor)} ${row.unitCode})`}
                        </Button>
                      )}
                    {canReclaim && reclaimLink(row)}
                  </span>
                );
              default:
                // E3 added non-primitive row fields (manufacturingOrders); the
                // default fallback is only ever reached for plain string
                // columns (articleNumber/articleName), so String() keeps
                // those unchanged while widening the switch's return type to
                // something ReactNode-compatible.
                return String(row[key as keyof SalesOrderRow] ?? "");
            }
          }}
        />
      ) : (
        <p>Inga rader tillagda än.</p>
      )}

      {rows.length > 0 && foreign && (
        <FormHint>
          Ordervärde i SEK: {formatMoney(toSek(total, orderRate))} kr (kurs {formatRate(order.exchangeRate)}). Priserna står
          i {order.currency}; rapporterna räknar om dem till SEK med orderns kurs.
        </FormHint>
      )}

      {rows.length > 0 && (
        <FormHint>
          {orderMargin.contribution === null
            ? "Täckningsbidrag — ingen av raderna har en sparad förkalkyl att mäta mot."
            : `Täckningsbidrag ${formatMoney(orderMargin.contribution)} SEK${foreign ? " (räknat med orderns kurs)" : ""}${
                orderMargin.marginPercent === null
                  ? ""
                  : ` · täckningsgrad ${orderMargin.marginPercent.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`
              }${
                // Named rather than folded in: the figure covers only the rows
                // it has a cost for, and saying so is the difference between a
                // margin and an overstated one.
                orderMargin.linesWithoutCost > 0
                  ? ` (${orderMargin.linesWithoutCost} ${orderMargin.linesWithoutCost === 1 ? "rad saknar" : "rader saknar"} förkalkyl och ingår inte)`
                  : ""
              }${
                // Konfigurator 4c: a configured row is measured against the
                // förkalkyl of its own configuration, not the template's.
                configuredCostDates.length > 0
                  ? ` Förkalkyl för konfigurationen, ${configuredCostDates.join(", ")}.`
                  : ""
              }${
                configuredWithoutCost > 0
                  ? ` Förkalkyl saknas för konfigurationen på ${configuredWithoutCost} ${configuredWithoutCost === 1 ? "rad" : "rader"}.`
                  : ""
              }`}
        </FormHint>
      )}

      <ConfigureModal
        open={reconfigure !== null}
        openKey={configureKey}
        template={reconfigure?.template ?? null}
        customerId={order.customerId}
        showPrice
        currency={order.currency}
        exchangeRate={orderRate}
        quantity={reconfigure ? Number(reconfigure.row.quantityOrdered) : 1}
        initialSelection={reconfigure?.initial}
        title="Ändra konfiguration"
        notice={reconfigure?.notice}
        onConfigured={saveReconfigure}
        onCancel={() => setReconfigure(null)}
      />

      <DocumentActionBar
        error={actionError}
        trailing={
          <ManualStatusChange
            endpoint={`/api/v1/sales-orders/${order.id}`}
            statuses={SALES_ORDER_STATUS_PILL}
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

        {freightEnabled && canSell && rowsEditable && (
          <Button type="button" variant="secondary" onClick={() => setFreightOpen(true)}>
            Kontrollera fraktpris
          </Button>
        )}

        {canCheckDelivery && rowsEditable && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDtcError(null);
              setDtcOpen(true);
            }}
          >
            Leveranstidskontroll
          </Button>
        )}

        {order.status === "quote" && (
          <Button type="button" variant="primary" disabled={actionPending !== null} onClick={() => runAction("confirm")}>
            {actionPending === "confirm" ? "Arbetar…" : "Bekräfta"}
          </Button>
        )}

        {order.status === "confirmed" && (
          <Button
            type="button"
            variant="primary"
            disabled={actionPending !== null}
            onClick={() => runAction("start-production")}
          >
            {actionPending === "start-production" ? "Arbetar…" : "Starta tillverkning"}
          </Button>
        )}

        {order.status === "in_production" && (
          <>
            {deliverable.length > 0 && (
              <Button type="button" variant="primary" onClick={() => setModal("deliver")}>
                Leverera
              </Button>
            )}
            <Link
              href={`/forsaljning/utleverans?order=${order.id}`}
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            >
              Utleveransrutinen
            </Link>
          </>
        )}

        {order.status === "delivered" && (
          <Link
            href={
              order.customerCollectiveInvoicing
                ? `/forsaljning/samlingsfakturering?customerId=${order.customerId}`
                : `/forsaljning/fakturor?orderId=${order.id}`
            }
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Fakturera
          </Link>
        )}

        {order.status === "quote" && canSell && (
          <Button type="button" variant="secondary" disabled={actionPending !== null} onClick={() => setModal("lose")}>
            Förlorad…
          </Button>
        )}

        {order.status === "lost" && canSell && (
          <Button type="button" variant="primary" disabled={actionPending !== null} onClick={reopenQuote}>
            {actionPending === "reopen" ? "Arbetar…" : "Öppna igen"}
          </Button>
        )}

        {(order.status === "quote" || order.status === "confirmed") && (
          <Button type="button" variant="danger" disabled={actionPending !== null} onClick={() => runAction("cancel")}>
            {actionPending === "cancel" ? "Arbetar…" : "Avbryt order"}
          </Button>
        )}
      </DocumentActionBar>

      {freight?.freightProduct && (
        <FormHint>
          Fraktprodukt: {freight.freightProduct.carrierName} · {freight.freightProduct.productName}
          {freight.carrierPrice !== null ? ` (offererat ${formatSek(freight.carrierPrice)})` : ""}
        </FormHint>
      )}

      <DeliveryTimeCheckDialog
        open={dtcOpen}
        onClose={() => setDtcOpen(false)}
        request={{ salesOrderId: order.id }}
        withCustomer
        onUseDate={useCheckedDate}
        useDateBusy={dtcBusy}
        useDateError={dtcError}
        onApplied={() => router.refresh()}
        canCreateOrders={order.status === "confirmed" || order.status === "in_production"}
        rowsWithOwnDate={rows.filter((r) => r.expectedDeliveryDate).length}
      />

      <FreightQuoteDialog
        orderId={order.id}
        currency={order.currency}
        exchangeRate={order.exchangeRate}
        open={freightOpen}
        onClose={() => setFreightOpen(false)}
        onAdded={() => {
          router.refresh();
          reloadFreight();
        }}
      />

      <Modal open={modal === "header"} onClose={() => setModal(null)} title="Ändra orderhuvud">
        <EditHeaderForm
          order={order}
          rowCount={rows.length}
          deliveryAddresses={deliveryAddresses}
          registers={registers}
          onDone={refresh}
          onCancel={() => setModal(null)}
        />
      </Modal>

      <Modal open={modal === "lose"} onClose={() => setModal(null)} title="Markera offerten som förlorad">
        {modal === "lose" && <LoseQuoteForm orderId={order.id} onDone={refresh} onCancel={() => setModal(null)} />}
      </Modal>

      <Modal open={modal === "addRow"} onClose={() => setModal(null)} title="Lägg till rad">
        <AddRowForm
          orderId={order.id}
          customerId={order.customerId}
          currency={order.currency}
          exchangeRate={orderRate}
          revision={order.revision}
          orderDeliveryDate={order.expectedDeliveryDate}
          onDone={refresh}
          onCancel={() => setModal(null)}
        />
      </Modal>

      <Modal open={modal === "deliver"} onClose={() => setModal(null)} title="Leverera">
        <DeliverGoodsForm
          orderId={order.id}
          rows={deliverable}
          locations={locations}
          onDone={refresh}
          onCancel={() => setModal(null)}
        />
      </Modal>

      <Modal open={modal === "createMo"} onClose={() => setModal(null)} title="Skapa tillverkningsorder">
        {moRow && (
          <CreateMoForm orderId={order.id} row={moRow} onCancel={() => setModal(null)} />
        )}
      </Modal>
    </div>
  );
}

// --- Förlorad: the loss dialog (Orsak is required, Kommentar optional) ---

function LoseQuoteForm({ orderId, onDone, onCancel }: { orderId: string; onDone: () => void; onCancel: () => void }) {
  const [reasons, setReasons] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    apiFetch<{ id: string; code: string; name: string; active: boolean }[]>("/api/v1/quote-loss-reasons")
      .then((all) => setReasons(all.filter((r) => r.active)))
      .catch((err) => {
        setReasons([]);
        setError(apiErrorMessage(err, "Kunde inte hämta förlustorsakerna"));
      });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/sales-orders/${orderId}/lose`, {
        method: "POST",
        body: JSON.stringify({ lossReasonId: reasonId, lossNote: note.trim() || null }),
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte markera offerten som förlorad"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Orsak" htmlFor="lossReason">
        <Select id="lossReason" required value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
          <option value="">— Välj —</option>
          {(reasons ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} · {r.name}
            </option>
          ))}
        </Select>
      </Field>
      {reasons !== null && reasons.length === 0 && !error && (
        <FormHint>Det finns inga aktiva förlustorsaker — lägg till en under Grunddata.</FormHint>
      )}
      <Field label="Kommentar (valfritt)" htmlFor="lossNote">
        <textarea
          id="lossNote"
          rows={3}
          maxLength={1000}
          className={fieldStyles.input}
          style={{ resize: "vertical", fontFamily: "inherit" }}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !reasonId}>
          {pending ? "Sparar…" : "Markera som förlorad"}
        </Button>
      </FormActions>
    </Form>
  );
}

// Kundens förfrågan / Kundens ordernummer in the header view: a quote shows
// the inquiry it answers (and an order number only when an older quote has
// one), an order its PO number (and the inquiry only when it has one).
function customerNumberFields(order: SalesOrder) {
  const inquiry = { label: "Kundens förfrågan", value: order.customerInquiryNumber };
  const orderNumber = { label: "Kundens ordernummer", value: order.customerOrderNumber };
  if (salesDocumentKind(order) === "quote") return order.customerOrderNumber ? [inquiry, orderNumber] : [inquiry];
  return order.customerInquiryNumber ? [orderNumber, inquiry] : [orderNumber];
}

// --- Order header (kundens ordernummer/förfrågan/referens/leveransadress/villkor) ---
// One PATCH /sales-orders/:id covers the whole header including the three
// terms, so the card asks about a new revision exactly once. Leveransdatum
// and anteckning are set when the quote is created and stay read-only.

function EditHeaderForm({
  order,
  rowCount,
  deliveryAddresses,
  registers,
  onDone,
  onCancel,
}: {
  order: SalesOrder;
  rowCount: number;
  deliveryAddresses: CustomerDeliveryAddress[];
  registers: TermsRegisters;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [customerOrderNumber, setCustomerOrderNumber] = useState(order.customerOrderNumber ?? "");
  const [customerInquiryNumber, setCustomerInquiryNumber] = useState(order.customerInquiryNumber ?? "");
  // A quote edits Kundens förfrågan; Kundens ordernummer only when an older
  // quote already has one (so it can be corrected or cleared). An order
  // edits both.
  const isQuote = salesDocumentKind(order) === "quote";
  const showOrderNumber = !isQuote || Boolean(order.customerOrderNumber);
  const [customerReference, setCustomerReference] = useState(order.customerReference ?? "");
  const dims = useDimensions();
  const [costCenterId, setCostCenterId] = useState(order.costCenterId ?? order.costCenter?.id ?? "");
  const [projectId, setProjectId] = useState(order.projectId ?? order.project?.id ?? "");
  const [deliveryAddressId, setDeliveryAddressId] = useState(order.deliveryAddressId ?? "");
  const [newDeliveryAddress, setNewDeliveryAddress] = useState<DeliveryAddressDraft>(emptyDeliveryAddressDraft());
  // The order's engångsadress is not in the customer's list — offered as its
  // own choice so saving the header keeps it.
  const oneOff =
    order.deliveryAddressOneOff && order.deliveryAddressId && order.deliveryAddress
      ? {
          id: order.deliveryAddressId,
          label: order.deliveryAddressLabel ?? "",
          address: order.deliveryAddress,
          postalCode: order.deliveryPostalCode ?? null,
          city: order.deliveryCity ?? null,
        }
      : null;
  const [terms, setTerms] = useState<TermsValue>(termsFrom(order));
  const [quoteValidUntil, setQuoteValidUntil] = useState(order.quoteValidUntil ?? "");
  // Valuta and Kurs: changeable as a quote or a confirmed order (the API
  // refuses it under tillverkning); another currency only while the order has
  // no rows (their prices would stand in the wrong currency).
  const canChangeCurrency = order.status === "quote" || order.status === "confirmed";
  const [currency, setCurrency] = useState(order.currency);
  const headerCurrency = currency.trim().toUpperCase();
  const headerForeign = /^[A-Z]{3}$/.test(headerCurrency) && headerCurrency !== SEK;
  const headerRate = useOrderRate({
    currency: headerCurrency,
    initial: { currency: order.currency, rate: order.currency === SEK ? "" : String(Number(order.exchangeRate)) },
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    // Valuta/Kurs: only what changed is sent — a new currency (the API takes
    // today's rate unless one is sent; the shown one is sent) and/or another
    // rate on the same currency.
    const currencyChanged = canChangeCurrency && headerCurrency !== order.currency;
    const newRate = headerForeign ? parseRate(headerRate.rate) : 1;
    if (canChangeCurrency && !/^[A-Z]{3}$/.test(headerCurrency)) {
      setError("Ange valutan som tre bokstäver, t.ex. SEK eller EUR");
      return;
    }
    if (canChangeCurrency && headerForeign && newRate === null) {
      setError(`Ange kursen för ${headerCurrency} — ingen kurs hittades för dagen`);
      return;
    }
    const rateChanged = canChangeCurrency && headerForeign && newRate !== null && newRate !== Number(order.exchangeRate);
    const bumpRevision = await askBumpRevision(order.revision);
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(currencyChanged ? { currency: headerCurrency } : {}),
          ...(headerForeign && (currencyChanged || rateChanged) ? { exchangeRate: newRate } : {}),
          ...(showOrderNumber ? { customerOrderNumber: customerOrderNumber.trim() || null } : {}),
          customerInquiryNumber: customerInquiryNumber.trim() || null,
          customerReference: customerReference.trim() || null,
          costCenterId: costCenterId || null,
          projectId: projectId || null,
          ...deliveryAddressPayload(deliveryAddressId, newDeliveryAddress, null),
          ...termsPayload(terms),
          // Giltig t.o.m. only exists on a quote (the API refuses it otherwise).
          ...(order.status === "quote" ? { quoteValidUntil: quoteValidUntil || null } : {}),
          bumpRevision,
        }),
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara"));
    } finally {
      setPending(false);
    }
  }

  const inquiryField = (
    <Field label="Kundens förfrågan" htmlFor="headerCustomerInquiryNumber">
      <Input
        id="headerCustomerInquiryNumber"
        size="md"
        maxLength={50}
        value={customerInquiryNumber}
        onChange={(e) => setCustomerInquiryNumber(e.target.value)}
      />
    </Field>
  );

  return (
    <Form onSubmit={save}>
      <FormError>{error}</FormError>

      {/* Two or three fields: the grid wraps the third onto a new line (one column on phones). */}
      <FormRow>
        {isQuote && inquiryField}
        {showOrderNumber && (
          <Field label="Kundens ordernummer" htmlFor="headerCustomerOrderNumber">
            <Input
              id="headerCustomerOrderNumber"
              size="md"
              maxLength={50}
              value={customerOrderNumber}
              onChange={(e) => setCustomerOrderNumber(e.target.value)}
            />
          </Field>
        )}
        {!isQuote && inquiryField}
        <Field label="Referens" htmlFor="headerCustomerReference">
          <Input
            id="headerCustomerReference"
            maxLength={100}
            value={customerReference}
            onChange={(e) => setCustomerReference(e.target.value)}
          />
        </Field>
      </FormRow>

      <DimensionFields
        idPrefix="header"
        lists={dims}
        costCenterId={costCenterId}
        projectId={projectId}
        onCostCenterChange={setCostCenterId}
        onProjectChange={setProjectId}
      />

      {canChangeCurrency && (
        <>
          <FormRow>
            <Field label="Valuta" htmlFor="headerCurrency">
              <CurrencyInput
                id="headerCurrency"
                required
                disabled={rowCount > 0}
                value={currency}
                onValueChange={setCurrency}
              />
            </Field>
            {headerForeign && (
              <OrderRateField
                id="headerExchangeRate"
                currency={headerCurrency}
                orderRate={headerRate}
                quote={order.status === "quote"}
              />
            )}
          </FormRow>
          {rowCount > 0 && (
            <FormHint attached>
              Valutan kan inte ändras när {order.status === "quote" ? "offerten" : "ordern"} har rader — ta bort raderna
              först. Kursen kan ändras; raderna behåller sina priser.
            </FormHint>
          )}
        </>
      )}

      {order.status === "quote" && (
        <Field label="Giltig t.o.m." htmlFor="headerQuoteValidUntil">
          <Input
            id="headerQuoteValidUntil"
            type="date"
            size="sm"
            value={quoteValidUntil}
            onChange={(e) => setQuoteValidUntil(e.target.value)}
          />
        </Field>
      )}

      <TermsFields registers={registers} value={terms} onChange={setTerms} />

      <DeliveryAddressChoice
        idPrefix="header"
        addresses={deliveryAddresses}
        oneOff={oneOff}
        value={deliveryAddressId}
        onChange={setDeliveryAddressId}
        draft={newDeliveryAddress}
        onDraftChange={setNewDeliveryAddress}
      />

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
  customerId,
  currency,
  exchangeRate,
  revision,
  orderDeliveryDate,
  onDone,
  onCancel,
}: {
  orderId: string;
  customerId: string;
  // Valuta: the order's currency and rate — the row is priced in it.
  currency: string;
  exchangeRate: number;
  revision: number;
  orderDeliveryDate: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0");
  const [discountPercent, setDiscountPercent] = useState("0");
  const [unitId, setUnitId] = useState(""); // "" = the article's base unit
  const [deliveryDate, setDeliveryDate] = useState(""); // "" = the order's
  // C3: set once the operator types in the price/discount field themselves —
  // the price-chain prefill below never overwrites a touched field
  // ("manuellt vinner"). Reset when the article changes.
  const [priceTouched, setPriceTouched] = useState(false);
  const [configureTemplate, setConfigureTemplate] = useState<Article | null>(null);
  const [configureKey, setConfigureKey] = useState(0);
  const [variantInfo, setVariantInfo] = useState<{ articleNumber: string; created: boolean } | null>(null);
  // Beställningsvara (to_order): the template stays the row's article and the choices travel with the row.
  const [rowConfiguration, setRowConfiguration] = useState<RowConfigurationDraft | null>(null);
  const [configureMode, setConfigureMode] = useState<"variants" | "to_order">("variants");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const unitCode = unitOptions.find((o) => o.value === unitId)?.code;
  const requestSeq = useRef(0);
  // The touched flag as it is when a prefill response LANDS — the effect's
  // closure holds it as it was when the request left, so a price typed while
  // the request was in flight would otherwise be overwritten ("manuellt vinner").
  const priceTouchedNow = useRef(priceTouched);
  priceTouchedNow.current = priceTouched;

  // Picking an article pre-selects its sales unit; switching unit
  // re-expresses the entered quantity and price (500 kg ⇄ 100 st).
  function handleArticleChange(next: Article | null) {
    setVariantInfo(null);
    setRowConfiguration(null);
    if (next?.configuratorMode === "variants" || next?.configuratorMode === "to_order") {
      // variants: Konfigurera hands back the variant article; to_order: the template stays and the choices go on the row.
      setArticle(next.configuratorMode === "to_order" ? next : null);
      setUnitId(next.salesUnitId ?? "");
      setPriceTouched(false);
      setConfigureMode(next.configuratorMode);
      setConfigureTemplate(next);
      setConfigureKey((k) => k + 1);
      return;
    }
    setArticle(next);
    setUnitId(next?.salesUnitId ?? "");
    setPriceTouched(false);
  }

  function handleConfigured(draft: RowConfigurationDraft) {
    setConfigureTemplate(null);
    setRowConfiguration(draft);
    if (!priceTouched && draft.evaluation.price.unitPrice !== null) {
      setUnitPrice(String(toUnitPrice(draft.evaluation.price.unitPrice, currentFactor)));
      setDiscountPercent(String(draft.evaluation.price.discountPercent));
    }
  }

  function handleResolved({ article: variant, created }: ResolveVariantResult) {
    setConfigureTemplate(null);
    setArticle(variant);
    setUnitId(variant.salesUnitId ?? "");
    setPriceTouched(false); // the price-quote effect now prices the variant through its chain
    setVariantInfo({ articleNumber: variant.articleNumber, created });
  }

  function handleUnitChange(option: UnitOption) {
    setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
    setUnitPrice((p) => convertPriceInput(p, currentFactor, option.factor));
    setUnitId(option.value);
  }

  // C3 price/discount prefill: whenever the article or the (unit-invariant)
  // base quantity changes, and the operator hasn't touched price/discount
  // themselves, ask the price chain and fill both fields. Race-guarded with
  // a request-sequence counter (same pattern as SearchPicker's debounced
  // search) so a stale response from an earlier edit can't clobber a later
  // one; price: null (no chain match) leaves the fields untouched, no error.
  const articleId = article?.id ?? null;
  const enteredQuantity = Number(quantity);
  const baseQuantity =
    Number.isFinite(enteredQuantity) && enteredQuantity > 0 ? toBaseQuantity(enteredQuantity, currentFactor) : null;

  // A configured row's cost is its own derived structure's, at the row's quantity.
  const templateSelfCost = useArticleSelfCost(rowConfiguration ? null : articleId);
  const configuredSelfCost = useConfiguredSelfCost(
    rowConfiguration ? articleId : null,
    (rowConfiguration?.selection as Record<string, unknown> | undefined) ?? null,
    baseQuantity
  );
  const selfCostPerUnit = rowConfiguration ? configuredSelfCost : templateSelfCost;

  useEffect(() => {
    if (priceTouched || !articleId || baseQuantity === null || rowConfiguration) return;
    const seq = ++requestSeq.current;
    apiFetch<PriceQuote>(
      // Valuta: salesOrderId — the order's own currency and rate decide.
      priceQuotePath({ customerId, articleId, quantity: baseQuantity, salesOrderId: orderId })
    )
      .then((quote) => {
        if (seq !== requestSeq.current || priceTouchedNow.current) return;
        if (!quote.price) return;
        setUnitPrice(String(toUnitPrice(quote.price.unitPrice, currentFactor)));
        setDiscountPercent(String(quote.price.discountPercent));
      })
      .catch(() => {
        // Best-effort prefill — silently leave the fields untouched on error.
      });
    // currentFactor is a dep too — a unit switch mid-flight must bump seq so
    // a response computed for the OLD factor never lands in a field now
    // displayed in the new unit (toUnitPrice divides by whatever factor is
    // captured in this closure).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, baseQuantity, customerId, priceTouched, currentFactor, rowConfiguration !== null]);

  // A configured row is priced by the configurator: re-evaluate at the entered quantity (staffel).
  const configuredSelection = rowConfiguration?.selection ?? null;
  useEffect(() => {
    if (!configuredSelection || !articleId || baseQuantity === null) return;
    const seq = ++requestSeq.current;
    apiFetch<ConfiguratorEvaluation>(`/api/v1/configurator/${articleId}/evaluate`, {
      method: "POST",
      body: JSON.stringify({
        selection: configuredSelection,
        customerId,
        quantity: baseQuantity,
        // Valuta: the order's currency (SEK too) and rate.
        currency,
        ...(currency !== SEK ? { exchangeRate } : {}),
      }),
    })
      .then((evaluation) => {
        if (seq !== requestSeq.current) return;
        setRowConfiguration((c) => (c ? { ...c, evaluation } : c));
        if (!priceTouchedNow.current && evaluation.price.unitPrice !== null) {
          setUnitPrice(String(toUnitPrice(evaluation.price.unitPrice, currentFactor)));
          setDiscountPercent(String(evaluation.price.discountPercent));
        }
      })
      .catch(() => {
        // Best-effort, like the price-quote prefill.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configuredSelection, articleId, baseQuantity, customerId, currentFactor]);

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
      await apiFetch(`/api/v1/sales-orders/${orderId}/rows`, {
        method: "POST",
        body: JSON.stringify({
          articleId: article.id,
          quantity: Number(quantity),
          // Always sent explicitly — the web never relies on the server's
          // own price-chain resolution (that path is for the configurator).
          unitPrice: Number(unitPrice),
          discountPercent: Number(discountPercent),
          unitId: unitId === "" ? null : unitId,
          ...(deliveryDate ? { expectedDeliveryDate: deliveryDate } : {}),
          ...(rowConfiguration ? { configuration: { selection: rowConfiguration.selection } } : {}),
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
        <ArticlePicker orderable configurable id="articleId" value={article} onChange={handleArticleChange} />
      </Field>
      {variantInfo && (
        <FormHint>
          Varianten <strong>{variantInfo.articleNumber}</strong> {variantInfo.created ? "skapades" : "fanns redan"}
        </FormHint>
      )}
      {rowConfiguration && (
        <>
          <ConfigurationLineList lines={rowConfiguration.lines} />
          <Button
            type="button"
            size="small"
            variant="ghost"
            onClick={() => {
              setConfigureKey((k) => k + 1);
              setConfigureTemplate(article);
            }}
          >
            Konfigurera om
          </Button>
        </>
      )}
      <ConfigureModal
        open={configureTemplate !== null}
        openKey={configureKey}
        template={configureTemplate}
        customerId={customerId}
        showPrice
        currency={currency}
        exchangeRate={exchangeRate}
        quantity={baseQuantity ?? 1}
        initialSelection={rowConfiguration?.selection}
        onConfigured={configureMode === "to_order" ? handleConfigured : undefined}
        onResolved={configureMode === "variants" ? handleResolved : undefined}
        onCancel={() => {
          setConfigureTemplate(null);
          if (configureMode === "to_order" && !rowConfiguration) setArticle(null);
        }}
      />

      <FormRow columns={4}>
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
            step="0.01"
            size="sm"
            required
            value={unitPrice}
            onChange={(e) => {
              setUnitPrice(e.target.value);
              setPriceTouched(true);
            }}
          />
        </Field>
        <Field label="Rabatt (%)" htmlFor="discountPercent">
          <Input
            id="discountPercent"
            type="number"
            min="0"
            step="any"
            size="xs"
            value={discountPercent}
            onChange={(e) => {
              setDiscountPercent(e.target.value);
              setPriceTouched(true);
            }}
          />
        </Field>
      </FormRow>

      <Field label="Leveransdatum (valfritt)" htmlFor="rowDeliveryDate">
        <Input
          id="rowDeliveryDate"
          type="date"
          size="sm"
          value={deliveryDate}
          onChange={(e) => setDeliveryDate(e.target.value)}
        />
        <FormHint attached>
          Tomt = samma som ordern{orderDeliveryDate ? ` (${orderDeliveryDate})` : ""}.
        </FormHint>
      </Field>

      {/* Live against the fields, without a server round-trip per keystroke —
          the self cost is fetched once per article. */}
      <FormHint>
        {marginLabel(
          selfCostPerUnit,
          baseQuantity,
          toBasePrice(Number(unitPrice), currentFactor),
          Number(discountPercent),
          exchangeRate
        ) ?? "TB —"}
      </FormHint>

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

// --- E3: Skapa tillverkningsorder från kundorderraden ---

// What is left of the row to manufacture, in base quantity: ordered minus what
// non-cancelled linked TOs already cover. Rounded so float noise never shows a
// "rest" of 0.0000001.
function moRemaining(row: SalesOrderRow): number {
  return toUnitQuantity(Number(row.quantityOrdered) - row.quantityInProduction, null);
}
// Mirrors NewManufacturingOrderForm's "Antal"-only shape — an MO carries no
// unit of its own, so the field (and the POST body) work directly in the
// row's base quantity, same as quantityOrdered/quantityInProduction already
// do. Antal defaults to what's left of the row (quantityOrdered minus what's
// already covered by non-cancelled linked TOs), clamped at 0 — the server
// only rejects a ≤0 DEFAULT (NothingLeftToManufactureError), an explicit
// quantity is always accepted, so nothing stops the operator from raising it.

function CreateMoForm({
  orderId,
  row,
  onCancel,
}: {
  orderId: string;
  row: SalesOrderRow;
  onCancel: () => void;
}) {
  const router = useRouter();
  // toUnitQuantity(diff, null) is exactly round4(diff) (factor null → ×1) —
  // avoids prefilling a float-noise remainder like "3.1999999999999993".
  const [quantity, setQuantity] = useState(
    String(Math.max(0, moRemaining(row)))
  );
  // Prefilled with the working day before this row's delivery date.
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (Number(quantity) <= 0) {
      setError("Ange ett antal större än 0 — raden är redan täckt av tillverkningsorder.");
      return;
    }
    setPending(true);
    try {
      const mo = await apiFetch<ManufacturingOrder>(`/api/v1/sales-orders/${orderId}/rows/${row.id}/manufacturing-order`, {
        method: "POST",
        body: JSON.stringify({ quantity: Number(quantity), dueDate: dueDate || undefined }),
      });
      stashReleaseWarnings(mo.id, mo.releaseWarnings);
      router.push(`/tillverkning/ordrar/${mo.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa tillverkningsordern");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <p>
        {row.articleNumber} — {row.articleName}
      </p>
      <ConfigurationLines configuration={row.configuration} />

      {/* The field works in the article's BASE quantity (see the comment above
          CreateMoForm), so it may only be labelled with unitCode when the row
          was entered in the base unit too — unitFactor null means exactly
          that. On a row entered in a packaging unit (10 KRT of 10 ST) the
          payload carries no base unit code, and labelling the base quantity
          "Antal (KRT)" would invite the operator to divide it down. */}
      <Field label={row.unitCode && row.unitFactor === null ? `Antal (${row.unitCode})` : "Antal"} htmlFor="moQuantity">
        <Input
          id="moQuantity"
          type="number"
          min="0"
          step="any"
          size="sm"
          required
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          autoFocus
        />
      </Field>

      <SuggestedDueDateField
        id="moDueDate"
        articleId={row.articleId}
        salesOrderRowId={row.id}
        value={dueDate}
        onChange={setDueDate}
      />

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa tillverkningsorder"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

// --- Deliver goods (in_production only) ---

function DeliverGoodsForm({
  orderId,
  rows,
  locations,
  onDone,
  onCancel,
}: {
  orderId: string;
  // Only the rows with something left to deliver.
  rows: SalesOrderRow[];
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
  // before hitting the deliver endpoint (stock is always base).
  const selectedRow = rows.find((r) => r.id === rowId) ?? rows[0];
  // Konfigurator 4c: delivering a configured row beyond its finished TOs warns, never blocks.
  const deliveryWarning = selectedRow
    ? configuredDeliveryWarning(selectedRow, toBaseQuantity(Number(quantity), selectedRow.unitFactor))
    : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      // Same batch endpoint the utleveransrutinen uses (C2's
      // POST .../deliver), just with a single row — one code path, one
      // delivery-occasion/följesedel record either way.
      await apiFetch(`/api/v1/sales-orders/${orderId}/deliver`, {
        method: "POST",
        body: JSON.stringify({
          locationId: locationId || undefined,
          rows: [{ rowId, quantity: toBaseQuantity(Number(quantity), selectedRow?.unitFactor ?? null) }],
        }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte leverera");
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
              {r.articleNumber} — {r.articleName} ({toUnitQuantity(Number(r.quantityDelivered), r.unitFactor)}/
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
        <Field label={selectedRow ? `Antal (${selectedRow.unitCode})` : "Antal"} htmlFor="deliverQuantity">
          <Input
            id="deliverQuantity"
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

      {selectedRow && deliveryWarning && <FormNotice>{deliveryWarning}</FormNotice>}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Levererar…" : "Leverera"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
