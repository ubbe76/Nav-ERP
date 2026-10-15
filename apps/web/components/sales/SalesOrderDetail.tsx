"use client";

import { confirmDelete } from "../../lib/confirm";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { FreightQuoteDialog } from "../shipping/FreightQuoteDialog";
import { formatSek } from "../../lib/shipping";
import Link from "next/link";
import { ArticleOverviewButton } from "../articles/ArticleOverviewButton";
import { GatedLink } from "../ui/GatedLink";
import { useCan } from "../PermissionsProvider";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
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
import { formatStockholmDate } from "../../lib/date";
import { configuredDeliveryWarning } from "../../lib/configuredDelivery";
import { toBaseQuantity, toBasePrice, toUnitPrice, toUnitQuantity } from "../../lib/units";
import { marginLabel, useArticleSelfCost, useConfiguredSelfCost } from "./useArticleMargin";
import { computeLineMargin, sumMargins } from "../../lib/margin";
import { formatMoney } from "../../lib/format";
import { apiFetch } from "../../lib/api";
import { stashReleaseWarnings } from "../../lib/releaseWarnings";
import { apiErrorMessage } from "../../lib/errorMessages";
import { askBumpRevision } from "../../lib/revision";
import {
  SALES_ORDER_STATUS_PILL,
  type Article,
  type CustomerDeliveryAddress,
  type ManufacturingOrder,
  type OrderFreight,
  type PriceQuote,
  type SalesOrder,
  type SalesOrderRow,
  type StockLocation,
} from "../../lib/types";
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
type SalesAction = "confirm" | "cancel" | "start-production";

export function SalesOrderDetail({ order, rows, locations, deliveryAddresses, registers, freightEnabled }: SalesOrderDetailProps) {
  const router = useRouter();
  const canSell = useCan()(["forsaljning"]);
  const [freightOpen, setFreightOpen] = useState(false);
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
  const pill = SALES_ORDER_STATUS_PILL[order.status];
  // Rows stay editable until the order is delivered/invoiced/cancelled;
  // per-row guards (quantity ≥ delivered, no delete with deliveries) are
  // enforced by the API and mirrored in the UI below.
  const rowsEditable = order.status === "quote" || order.status === "confirmed" || order.status === "in_production";

  const [modal, setModal] = useState<"header" | "addRow" | "deliver" | "createMo" | null>(null);
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
  // The BASE quantity (article's base unit) editing started at — editArticle
  // resolves asynchronously (startEditRow fetches it after opening the row),
  // so the prefill effect below would otherwise fire once that fetch lands
  // even though nothing was actually edited yet, silently replacing the
  // row's already-correct stored price with a freshly re-resolved one.
  // Storing the BASE quantity (not the displayed unit string) keeps a pure
  // unit switch — switchEditUnit re-expresses the string in the new unit
  // without the underlying base quantity changing — from being mistaken for
  // an actual quantity edit; comparing against this keeps both "open edit,
  // change nothing, Spara" AND "open edit, switch unit only, Spara" no-ops.
  const editInitialBaseQuantityRef = useRef(0);

  const deliverable = rows.filter((r) => Number(r.quantityDelivered) < Number(r.quantityOrdered));
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
        unitPrice: Number(r.unitPrice),
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

  // C3 price/discount prefill for the row being edited: when the quantity
  // changes and the operator hasn't touched price/discount themselves, ask
  // the price chain again (the article never changes in edit mode). Same
  // request-sequence race guard as AddRowForm/NewQuoteForm below.
  useEffect(() => {
    if (editingRowId === null || editPriceTouched || !editArticle) return;
    const enteredQuantity = Number(editQuantity);
    if (!Number.isFinite(enteredQuantity) || enteredQuantity <= 0) return;
    const baseQuantity = toBaseQuantity(enteredQuantity, editFactor);
    // Nothing has actually changed since edit mode opened — compare the base
    // quantity (unit-invariant), not the displayed string, so a pure unit
    // switch (switchEditUnit re-expresses the same base quantity in a new
    // unit) never trips this and re-prices the row.
    if (baseQuantity === editInitialBaseQuantityRef.current) return;
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
        }),
      })
        .then((evaluation) => {
          if (seq !== editRequestSeq.current || evaluation.price.unitPrice === null) return;
          setEditPrice(String(toUnitPrice(evaluation.price.unitPrice, editFactor)));
          setEditDiscountPercent(String(evaluation.price.discountPercent));
        })
        .catch(() => {});
      return;
    }
    apiFetch<PriceQuote>(
      `/api/v1/price-quote?customerId=${order.customerId}&articleId=${editArticle.id}&quantity=${baseQuantity}`
    )
      .then((quote) => {
        if (seq !== editRequestSeq.current) return;
        if (!quote.price) return;
        setEditPrice(String(toUnitPrice(quote.price.unitPrice, editFactor)));
        setEditDiscountPercent(String(quote.price.discountPercent));
      })
      .catch(() => {
        // Best-effort prefill — silently leave the fields untouched on error.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRowId, editQuantity, editFactor, editPriceTouched, editArticle, order.customerId]);

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

  function startEditRow(row: SalesOrderRow) {
    const initialQuantity = String(toUnitQuantity(Number(row.quantityOrdered), row.unitFactor));
    setEditingRowId(row.id);
    setEditQuantity(initialQuantity);
    // quantityOrdered is already stored in the article's base unit — no
    // conversion needed here (contrast the prefill effect, which converts
    // the displayed editQuantity back to base via editFactor).
    editInitialBaseQuantityRef.current = Number(row.quantityOrdered);
    setEditPrice(String(toUnitPrice(Number(row.unitPrice), row.unitFactor)));
    setEditDiscountPercent(String(Number(row.discountPercent)));
    setEditPriceTouched(false);
    setEditUnitId(row.unitId ?? "");
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

  async function saveReconfigure(draft: RowConfigurationDraft) {
    if (!reconfigure) return;
    const bumpRevision = await askBumpRevision(order.revision);
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}/rows/${reconfigure.row.id}/configuration`, {
        method: "PUT",
        body: JSON.stringify({ selection: draft.selection, bumpRevision }),
      });
      setReconfigure(null);
      router.refresh();
    } catch (err) {
      setReconfigure(null);
      setActionError(apiErrorMessage(err, "Kunde inte ändra konfigurationen"));
    }
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

  async function removeRow(row: SalesOrderRow) {
    if (!(await confirmDelete(`Ta bort ${row.articleNumber} ur ordern?`))) return;
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

  async function runAction(action: SalesAction) {
    setActionError(null);
    setActionPending(action);
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}/${action}`, { method: "POST" });
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
        meta={
          <>
            Rev {order.revision} · SEK
            {order.invoiceNumber &&
              ` · Faktura ${order.invoiceNumber}${order.invoicedAt ? ` (${order.invoicedAt.slice(0, 10)})` : ""}`}
          </>
        }
        fields={[
          { label: "Kund", value: order.customerName, href: `/kunder/${order.customerId}` },
          { label: "Kundens ordernummer", value: order.customerOrderNumber },
          { label: "Referens", value: order.customerReference },
          { label: "Leveransdatum", value: order.expectedDeliveryDate },
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
            { key: "articleNumber", label: "Artikelnummer", width: "110px" },
            { key: "articleName", label: "Benämning", width: "minmax(120px, 1fr)" },
            { key: "quantityOrdered", label: "Beställt", width: "70px", align: "right" },
            { key: "unitCode", label: "Enhet", width: "60px" },
            { key: "quantityDelivered", label: "Levererat", width: "70px", align: "right" },
            // E3: quantity already in production (non-cancelled linked TOs)
            // plus their order numbers, linking to the TO card.
            { key: "quantityInProduction", label: "I tillverkning", width: "80px" },
            { key: "unitPrice", label: "Á-pris", width: "90px", align: "right" },
            { key: "discountPercent", label: "Rabatt", width: "60px", align: "right" },
            { key: "lineAmount", label: "Belopp", width: "90px", align: "right" },
            ...(rowsEditable ? ([{ key: "id", label: "", width: "220px", align: "right" }] as const) : []),
          ]}
          rows={rows}
          footer={{ unitPrice: "Summa", lineAmount: `${formatMoney(total)} SEK` }}
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
                if (row.quantityInProduction <= 0) return null;
                return (
                  <span>
                    {toUnitQuantity(row.quantityInProduction, row.unitFactor)}{" "}
                    {row.manufacturingOrders.map((mo, i) => (
                      <span key={mo.id}>
                        {i > 0 && ", "}
                        <GatedLink href={`/tillverkning/ordrar/${mo.id}`}>{mo.orderNumber}</GatedLink>
                      </span>
                    ))}
                  </span>
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
                  `${formatMoney(toUnitPrice(Number(row.unitPrice), row.unitFactor))} SEK`
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
                      (order.status === "confirmed" || order.status === "in_production") && (
                        <Button type="button" size="small" variant="secondary" onClick={() => openCreateMo(row)}>
                          Skapa tillverkningsorder
                        </Button>
                      )}
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

      {rows.length > 0 && (
        <FormHint>
          {orderMargin.contribution === null
            ? "Täckningsbidrag — ingen av raderna har en sparad förkalkyl att mäta mot."
            : `Täckningsbidrag ${formatMoney(orderMargin.contribution)} SEK${
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
              }`}
        </FormHint>
      )}

      <ConfigureModal
        open={reconfigure !== null}
        openKey={configureKey}
        template={reconfigure?.template ?? null}
        customerId={order.customerId}
        showPrice
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

      <FreightQuoteDialog
        orderId={order.id}
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
          deliveryAddresses={deliveryAddresses}
          registers={registers}
          onDone={refresh}
          onCancel={() => setModal(null)}
        />
      </Modal>

      <Modal open={modal === "addRow"} onClose={() => setModal(null)} title="Lägg till rad">
        <AddRowForm
          orderId={order.id}
          customerId={order.customerId}
          revision={order.revision}
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

// --- Order header (kundens ordernummer/referens/leveransadress/villkor) ---
// One PATCH /sales-orders/:id covers the whole header including the three
// terms, so the card asks about a new revision exactly once. Leveransdatum
// and anteckning are set when the quote is created and stay read-only.

function EditHeaderForm({
  order,
  deliveryAddresses,
  registers,
  onDone,
  onCancel,
}: {
  order: SalesOrder;
  deliveryAddresses: CustomerDeliveryAddress[];
  registers: TermsRegisters;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [customerOrderNumber, setCustomerOrderNumber] = useState(order.customerOrderNumber ?? "");
  const [customerReference, setCustomerReference] = useState(order.customerReference ?? "");
  const [deliveryAddressId, setDeliveryAddressId] = useState(order.deliveryAddressId ?? "");
  const [terms, setTerms] = useState<TermsValue>(termsFrom(order));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const bumpRevision = await askBumpRevision(order.revision);
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/sales-orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          customerOrderNumber: customerOrderNumber.trim() || null,
          customerReference: customerReference.trim() || null,
          deliveryAddressId: deliveryAddressId || null,
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
        <Field label="Kundens ordernummer" htmlFor="headerCustomerOrderNumber">
          <Input
            id="headerCustomerOrderNumber"
            size="md"
            maxLength={50}
            value={customerOrderNumber}
            onChange={(e) => setCustomerOrderNumber(e.target.value)}
          />
        </Field>
        <Field label="Referens" htmlFor="headerCustomerReference">
          <Input
            id="headerCustomerReference"
            maxLength={100}
            value={customerReference}
            onChange={(e) => setCustomerReference(e.target.value)}
          />
        </Field>
      </FormRow>

      <TermsFields registers={registers} value={terms} onChange={setTerms} />

      <Field label="Leveransadress" htmlFor="headerDeliveryAddressId">
        <Select
          id="headerDeliveryAddressId"
          value={deliveryAddressId}
          onChange={(e) => setDeliveryAddressId(e.target.value)}
        >
          <option value="">Ingen</option>
          {deliveryAddresses.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} — {[a.address, [a.postalCode, a.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
            </option>
          ))}
        </Select>
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
  customerId,
  revision,
  onDone,
  onCancel,
}: {
  orderId: string;
  customerId: string;
  revision: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0");
  const [discountPercent, setDiscountPercent] = useState("0");
  const [unitId, setUnitId] = useState(""); // "" = the article's base unit
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
      `/api/v1/price-quote?customerId=${customerId}&articleId=${articleId}&quantity=${baseQuantity}`
    )
      .then((quote) => {
        if (seq !== requestSeq.current) return;
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
      body: JSON.stringify({ selection: configuredSelection, customerId, quantity: baseQuantity }),
    })
      .then((evaluation) => {
        if (seq !== requestSeq.current) return;
        setRowConfiguration((c) => (c ? { ...c, evaluation } : c));
        if (!priceTouched && evaluation.price.unitPrice !== null) {
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
          ...(rowConfiguration ? { configuration: { selection: rowConfiguration.selection } } : {}),
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

      {/* Live against the fields, without a server round-trip per keystroke —
          the self cost is fetched once per article. */}
      <FormHint>
        {marginLabel(
          selfCostPerUnit,
          baseQuantity,
          toBasePrice(Number(unitPrice), currentFactor),
          Number(discountPercent)
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
    String(Math.max(0, toUnitQuantity(Number(row.quantityOrdered) - row.quantityInProduction, null)))
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
