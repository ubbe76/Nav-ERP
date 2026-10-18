"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { ConfigureModal } from "../configurator/ConfigureModal";
import { ConfigurationLineList } from "../configurator/ConfigurationLines";
import type { ConfiguratorEvaluation, ResolveVariantResult, RowConfigurationDraft } from "../../lib/configurator";
import { SearchPicker } from "../ui/SearchPicker";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { apiFetch } from "../../lib/api";
import { useCustomerDeliveryDateSuggestion } from "../../lib/useDeliveryDateSuggestion";
import { DeliveryDateHint } from "../ui/DeliveryDateHint";
import { DeliveryTimeCheckDialog } from "./DeliveryTimeCheckDialog";
import type { DeliveryTimeCheckRequest } from "../../lib/deliveryTimeCheck";
import { toBaseQuantity, toBasePrice, toUnitPrice } from "../../lib/units";
import { marginLabel, useArticleSelfCost, useConfiguredSelfCost } from "./useArticleMargin";
import type { Article, Customer, CustomerDeliveryAddress, PriceQuote, SalesOrder } from "../../lib/types";
import {
  DeliveryAddressChoice,
  deliveryAddressPayload,
  emptyDeliveryAddressDraft,
  type DeliveryAddressDraft,
} from "./DeliveryAddressChoice";
import { Form, FormActions, FormError, FormHint, FormLineRow, FormLineRowTop, FormRow } from "../ui/Form";

interface CreateQuoteResponse {
  order: SalesOrder;
}

interface QuoteRow {
  article: Article | null;
  quantity: string;
  unitPrice: string;
  // C3: row discount in percent, prefilled from the price chain alongside
  // unitPrice.
  discountPercent: string;
  unitId: string; // "" = the article's base unit
  // C3: set once the operator has typed in the price or discount field
  // themselves — the price-chain prefill never overwrites a touched field
  // ("manuellt vinner"). Reset when the article changes.
  priceTouched: boolean;
  // Set when the article came from Konfigurera (Varianten … skapades / fanns redan).
  variantInfo: { articleNumber: string; created: boolean } | null;
  // Beställningsvara (to_order): the template stays the row's article, the choices travel with the row.
  configuration: RowConfigurationDraft | null;
  // Base units per entered unit, reported up by the row's unit dropdown so the
  // parent can express the quantity in the base unit (Leveranstidskontroll).
  unitFactor: number;
}

// Pass `lockedCustomer` (e.g. from the customer card) to skip the customer
// picker and create the quote for that customer directly. mode "order"
// creates a confirmed kundorder instead of a quote (confirm: true).
export function NewQuoteForm({
  lockedCustomer,
  mode = "quote",
}: {
  lockedCustomer?: Customer;
  mode?: "quote" | "order";
}) {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(lockedCustomer ?? null);
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  // Fasta leveransdagar: the customer's earliest delivery date prefills the
  // field unless the operator has touched it ("manuellt vinner"); an
  // untouched field follows the suggestion, also back to empty.
  const [dateTouched, setDateTouched] = useState(false);
  const { suggestion, summary, warning } = useCustomerDeliveryDateSuggestion({
    customerId: customer?.id ?? null,
    date: expectedDeliveryDate,
  });
  useEffect(() => {
    if (dateTouched) return;
    setExpectedDeliveryDate(suggestion?.date ?? "");
  }, [suggestion, dateTouched]);
  const [note, setNote] = useState("");
  const [customerOrderNumber, setCustomerOrderNumber] = useState("");
  const [customerReference, setCustomerReference] = useState("");
  const [deliveryAddressId, setDeliveryAddressId] = useState("");
  const [deliveryAddresses, setDeliveryAddresses] = useState<CustomerDeliveryAddress[]>([]);
  const [newDeliveryAddress, setNewDeliveryAddress] = useState<DeliveryAddressDraft>(emptyDeliveryAddressDraft());
  const [rows, setRows] = useState<QuoteRow[]>([
    { article: null, quantity: "1", unitPrice: "0", discountPercent: "0", unitId: "", priceTouched: false, variantInfo: null, configuration: null, unitFactor: 1 },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The delivery-address choices belong to the selected customer; the
  // default address is preselected whenever the customer changes.
  useEffect(() => {
    if (!customer) {
      setDeliveryAddresses([]);
      setDeliveryAddressId("");
      return;
    }
    const customerId = customer.id;
    let cancelled = false;
    apiFetch<CustomerDeliveryAddress[]>(`/api/v1/customers/${customerId}/delivery-addresses`)
      .then((addresses) => {
        if (cancelled) return;
        setDeliveryAddresses(addresses);
        setDeliveryAddressId(addresses.find((a) => a.isDefault)?.id ?? "");
      })
      .catch(() => {
        if (!cancelled) setDeliveryAddresses([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customer]);

  const [dtcOpen, setDtcOpen] = useState(false);
  // Rows the check can use: an article and a positive quantity (in base units).
  const checkRows = rows.flatMap((r) => {
    const quantity = Number(r.quantity);
    if (!r.article || !Number.isFinite(quantity) || quantity <= 0) return [];
    return [
      {
        articleId: r.article.id,
        quantity: toBaseQuantity(quantity, r.unitFactor),
        ...(r.configuration ? { configuration: { selection: r.configuration.selection } } : {}),
      },
    ];
  });
  const checkRequest: DeliveryTimeCheckRequest = {
    ...(customer ? { customerId: customer.id } : {}),
    rows: checkRows,
  };

  const nounSingular = mode === "order" ? "kundorder" : "offert";

  function updateRow(index: number, patch: Partial<QuoteRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      { article: null, quantity: "1", unitPrice: "0", discountPercent: "0", unitId: "", priceTouched: false, variantInfo: null, configuration: null, unitFactor: 1 },
    ]);
  }

  function removeRow(index: number) {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!customer) {
      setError("Välj kund");
      return;
    }
    if (rows.some((r) => r.article === null)) {
      setError("Välj artikel på alla rader");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<CreateQuoteResponse>("/api/v1/quotes", {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.id,
          expectedDeliveryDate: expectedDeliveryDate || undefined,
          note: note || undefined,
          customerOrderNumber: customerOrderNumber.trim() || undefined,
          customerReference: customerReference.trim() || undefined,
          ...deliveryAddressPayload(deliveryAddressId, newDeliveryAddress, undefined),
          confirm: mode === "order",
          rows: rows.map((r) => ({
            articleId: r.article!.id,
            quantity: Number(r.quantity),
            // Always sent explicitly — the web never relies on the server's
            // own price-chain resolution (that path is for the configurator).
            unitPrice: Number(r.unitPrice),
            discountPercent: Number(r.discountPercent),
            unitId: r.unitId === "" ? null : r.unitId,
            configuration: r.configuration ? { selection: r.configuration.selection } : undefined,
          })),
        }),
      });
      router.push(`/forsaljning/ordrar/${result.order.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Kunde inte skapa ${nounSingular}en`);
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      {lockedCustomer ? (
        <Field label="Kund" htmlFor="customerId">
          <Input id="customerId" value={lockedCustomer.name} disabled />
        </Field>
      ) : (
        <Field label="Kund" htmlFor="customerId">
          <SearchPicker
            id="customerId"
            endpoint="/api/v1/customers"
            value={customer}
            onChange={setCustomer}
            formatLabel={(c) => `${c.customerNumber} — ${c.name}`}
            placeholder="Sök kundnummer eller namn…"
            emptyText="Inga kunder matchar sökningen"
          />
        </Field>
      )}

      <FormRow>
        <Field label="Förväntat leveransdatum (valfritt)" htmlFor="expectedDeliveryDate">
          <Input
            id="expectedDeliveryDate"
            type="date"
            size="sm"
            value={expectedDeliveryDate}
            onChange={(e) => {
              setDateTouched(true);
              setExpectedDeliveryDate(e.target.value);
            }}
          />
          <DeliveryDateHint summary={summary} warning={warning} />
          <div style={{ marginTop: 8 }}>
            <Button type="button" variant="secondary" size="small" disabled={checkRows.length === 0} onClick={() => setDtcOpen(true)}>
              Leveranstidskontroll
            </Button>
          </div>
        </Field>
        <Field label="Anteckning (valfritt)" htmlFor="note">
          <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Kundens ordernummer (valfritt)" htmlFor="customerOrderNumber">
          <Input
            id="customerOrderNumber"
            size="md"
            maxLength={50}
            value={customerOrderNumber}
            onChange={(e) => setCustomerOrderNumber(e.target.value)}
          />
        </Field>
        <Field label="Referens (valfritt)" htmlFor="customerReference">
          <Input
            id="customerReference"
            maxLength={100}
            value={customerReference}
            onChange={(e) => setCustomerReference(e.target.value)}
          />
        </Field>
      </FormRow>

      {customer && (
        <DeliveryAddressChoice
          idPrefix="quote"
          addresses={deliveryAddresses}
          value={deliveryAddressId}
          onChange={setDeliveryAddressId}
          draft={newDeliveryAddress}
          onDraftChange={setNewDeliveryAddress}
        />
      )}

      <div>
        <Label>Rader</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
          {rows.map((row, index) => (
            <QuoteRowFields
              key={index}
              index={index}
              row={row}
              customerId={customer?.id ?? null}
              canRemove={rows.length > 1}
              onChange={(patch) => updateRow(index, patch)}
              onRemove={() => removeRow(index)}
            />
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <Button type="button" variant="secondary" size="small" onClick={addRow}>
            + Lägg till rad
          </Button>
        </div>
      </div>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : mode === "order" ? "Skapa kundorder" : "Skapa offert"}
        </Button>
      </FormActions>

      <DeliveryTimeCheckDialog
        open={dtcOpen}
        onClose={() => setDtcOpen(false)}
        request={checkRequest}
        withCustomer={customer !== null}
        onUseDate={(date) => {
          // A date taken from the check counts as typed by hand: the customer's
          // delivery-day suggestion no longer overwrites it.
          setDateTouched(true);
          setExpectedDeliveryDate(date);
          setDtcOpen(false);
        }}
      />
    </Form>
  );
}

// One quote/order row: article + quantity/price with a unit dropdown.
// Picking an article pre-selects its sales unit; switching unit re-expresses
// the entered quantity and price in the new unit (500 kg ⇄ 100 st).
//
// C3 price/discount prefill: whenever the article or the (unit-invariant)
// base quantity changes, and the operator hasn't typed in the price/discount
// fields themselves this session (row.priceTouched), a GET /price-quote
// fills unitPrice + discountPercent from the price chain. Race-guarded with
// a per-row request-sequence counter (same pattern as SearchPicker's
// debounced search) so a stale response from an earlier quantity edit can
// never clobber a later one.
function QuoteRowFields({
  index,
  row,
  customerId,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  row: QuoteRow;
  customerId: string | null;
  canRemove: boolean;
  onChange: (patch: Partial<QuoteRow>) => void;
  onRemove: () => void;
}) {
  const unitOptions = useUnitOptions(row.article);
  const currentFactor = unitOptions.find((o) => o.value === row.unitId)?.factor ?? 1;
  const unitCode = unitOptions.find((o) => o.value === row.unitId)?.code;
  const requestSeq = useRef(0);

  // Report the unit factor up so the form can send base-unit quantities to the check.
  useEffect(() => {
    if (row.unitFactor !== currentFactor) onChange({ unitFactor: currentFactor });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFactor, row.unitFactor]);

  const [configureTemplate, setConfigureTemplate] = useState<Article | null>(null);
  const [configureKey, setConfigureKey] = useState(0);
  const [configureMode, setConfigureMode] = useState<"variants" | "to_order">("variants");

  function handleArticleChange(article: Article | null) {
    if (article?.configuratorMode === "variants" || article?.configuratorMode === "to_order") {
      // variants: Konfigurera hands back the variant article; to_order: the template stays and the choices go on the row.
      onChange({
        article: article.configuratorMode === "to_order" ? article : null,
        unitId: article.salesUnitId ?? "",
        priceTouched: false,
        variantInfo: null,
        configuration: null,
      });
      setConfigureMode(article.configuratorMode);
      setConfigureTemplate(article);
      setConfigureKey((k) => k + 1);
      return;
    }
    onChange({ article, unitId: article?.salesUnitId ?? "", priceTouched: false, variantInfo: null, configuration: null });
  }

  function handleConfigured(draft: RowConfigurationDraft) {
    setConfigureTemplate(null);
    if (!row.priceTouched && draft.evaluation.price.unitPrice !== null) {
      onChange({
        configuration: draft,
        unitPrice: String(toUnitPrice(draft.evaluation.price.unitPrice, currentFactor)),
        discountPercent: String(draft.evaluation.price.discountPercent),
      });
    } else {
      onChange({ configuration: draft });
    }
  }

  function handleResolved({ article: variant, created }: ResolveVariantResult) {
    setConfigureTemplate(null);
    onChange({
      article: variant,
      unitId: variant.salesUnitId ?? "",
      priceTouched: false, // the price-quote effect now prices the variant through its chain
      variantInfo: { articleNumber: variant.articleNumber, created },
    });
  }

  function handleUnitChange(option: UnitOption) {
    onChange({
      unitId: option.value,
      quantity: convertQuantityInput(row.quantity, currentFactor, option.factor),
      unitPrice: convertPriceInput(row.unitPrice, currentFactor, option.factor),
    });
  }

  const articleId = row.article?.id ?? null;
  const enteredQuantity = Number(row.quantity);
  const baseQuantity =
    Number.isFinite(enteredQuantity) && enteredQuantity > 0 ? toBaseQuantity(enteredQuantity, currentFactor) : null;

  // A configured row's cost is its own derived structure's, at the row's quantity.
  const templateSelfCost = useArticleSelfCost(row.configuration ? null : articleId);
  const configuredSelfCost = useConfiguredSelfCost(
    row.configuration ? articleId : null,
    (row.configuration?.selection as Record<string, unknown> | undefined) ?? null,
    baseQuantity
  );
  const selfCostPerUnit = row.configuration ? configuredSelfCost : templateSelfCost;

  useEffect(() => {
    if (row.priceTouched || !articleId || !customerId || baseQuantity === null || row.configuration) return;
    const seq = ++requestSeq.current;
    apiFetch<PriceQuote>(
      `/api/v1/price-quote?customerId=${customerId}&articleId=${articleId}&quantity=${baseQuantity}`
    )
      .then((quote) => {
        if (seq !== requestSeq.current) return; // superseded by a newer article/quantity edit
        if (!quote.price) return; // no chain match — leave the fields as they are, no error shown
        onChange({
          unitPrice: String(toUnitPrice(quote.price.unitPrice, currentFactor)),
          discountPercent: String(quote.price.discountPercent),
        });
      })
      .catch(() => {
        // Best-effort prefill — silently leave the fields untouched on error.
      });
    // currentFactor is a dep too — a unit switch mid-flight must bump seq so
    // a response computed for the OLD factor never lands in a field now
    // displayed in the new unit (toUnitPrice divides by whatever factor is
    // captured in this closure).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, baseQuantity, customerId, row.priceTouched, currentFactor, row.configuration !== null]);

  // A configured row is priced by the configurator: re-evaluate when the quantity or the customer changes
  // (staffel / customer price), unless the price was typed by hand.
  const configuredSelection = row.configuration?.selection ?? null;
  useEffect(() => {
    if (!configuredSelection || !articleId || baseQuantity === null) return;
    const seq = ++requestSeq.current;
    apiFetch<ConfiguratorEvaluation>(`/api/v1/configurator/${articleId}/evaluate`, {
      method: "POST",
      body: JSON.stringify({ selection: configuredSelection, ...(customerId ? { customerId } : {}), quantity: baseQuantity }),
    })
      .then((evaluation) => {
        if (seq !== requestSeq.current) return;
        if (row.priceTouched || evaluation.price.unitPrice === null) return;
        onChange({
          unitPrice: String(toUnitPrice(evaluation.price.unitPrice, currentFactor)),
          discountPercent: String(evaluation.price.discountPercent),
        });
      })
      .catch(() => {
        // Best-effort, like the price-quote prefill.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configuredSelection, articleId, baseQuantity, customerId, row.priceTouched, currentFactor]);

  return (
    <FormLineRow>
      <FormLineRowTop>
        <Field label="Artikel" htmlFor={`articleId-${index}`}>
          <ArticlePicker orderable configurable id={`articleId-${index}`} value={row.article} onChange={handleArticleChange} />
        </Field>
        <Button
          type="button"
          variant="ghost"
          size="small"
          aria-label="Ta bort rad"
          disabled={!canRemove}
          onClick={onRemove}
        >
          ✕
        </Button>
      </FormLineRowTop>
      {row.variantInfo && (
        <FormHint>
          Varianten <strong>{row.variantInfo.articleNumber}</strong> {row.variantInfo.created ? "skapades" : "fanns redan"}
        </FormHint>
      )}
      {row.configuration && (
        <>
          <ConfigurationLineList lines={row.configuration.lines} />
          <Button
            type="button"
            size="small"
            variant="ghost"
            onClick={() => {
              setConfigureKey((k) => k + 1);
              setConfigureTemplate(row.article);
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
        initialSelection={row.configuration?.selection}
        onConfigured={configureMode === "to_order" ? handleConfigured : undefined}
        onResolved={configureMode === "variants" ? handleResolved : undefined}
        onCancel={() => {
          setConfigureTemplate(null);
          if (configureMode === "to_order" && !row.configuration) onChange({ article: null });
        }}
      />
      <FormRow columns={4}>
        <Field label="Antal" htmlFor={`quantity-${index}`}>
          <Input
            id={`quantity-${index}`}
            type="number"
            min="0"
            step="any"
            size="sm"
            required
            value={row.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
        </Field>
        <Field label="Enhet" htmlFor={`unit-${index}`}>
          <UnitSelect id={`unit-${index}`} options={unitOptions} value={row.unitId} onChange={handleUnitChange} />
        </Field>
        <Field label={unitCode ? `Á-pris (kr/${unitCode})` : "Á-pris"} htmlFor={`unitPrice-${index}`}>
          <Input
            id={`unitPrice-${index}`}
            type="number"
            min="0"
            step="0.01"
            size="sm"
            required
            value={row.unitPrice}
            onChange={(e) => onChange({ unitPrice: e.target.value, priceTouched: true })}
          />
        </Field>
        <Field label="Rabatt (%)" htmlFor={`discountPercent-${index}`}>
          <Input
            id={`discountPercent-${index}`}
            type="number"
            min="0"
            step="any"
            size="xs"
            value={row.discountPercent}
            onChange={(e) => onChange({ discountPercent: e.target.value, priceTouched: true })}
          />
        </Field>
      </FormRow>
      {/* Täckningsbidrag against the article's latest saved pre-calculation,
          recomputed locally as the price is typed. */}
      <FormHint>
        {marginLabel(selfCostPerUnit, baseQuantity, toBasePrice(Number(row.unitPrice), currentFactor), Number(row.discountPercent)) ??
          "TB —"}
      </FormHint>
    </FormLineRow>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{children}</div>;
}
