"use client";

import { useEffect, useState } from "react";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { ArticlePicker } from "../ui/ArticlePicker";
import type { DeviationDraft, Ref } from "./deviationDraft";
import { FormHint, FormRow } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import {
  DEVIATION_DECISION_LABELS,
  DEVIATION_DECISIONS,
  reasonAppliesToType,
  type Deviation,
  type DeviationDecision,
  type DeviationReason,
  type DeviationType,
  type ResponsibleCandidate,
} from "../../lib/quality";
import type { Article, MOOperation, PurchaseOrderRow, SalesOrderRow } from "../../lib/types";

// A picked value is exactly { id, label }; a search hit is the whole record.
function isRef(item: Record<string, unknown>): item is Record<string, unknown> & Ref {
  const keys = Object.keys(item);
  return keys.length === 2 && typeof item.id === "string" && typeof item.label === "string";
}

// A SearchPicker over any list endpoint whose current value is only an id and
// a text (the card holds numbers and names, not the whole record).
export function RefPicker({
  id,
  endpoint,
  value,
  onChange,
  formatItem,
  placeholder,
  emptyText,
}: {
  id: string;
  endpoint: string;
  value: Ref | null;
  onChange: (ref: Ref | null, raw: Record<string, unknown> | null) => void;
  formatItem: (raw: Record<string, unknown>) => string;
  placeholder: string;
  emptyText: string;
}) {
  type Item = { id: string } & Record<string, unknown>;
  return (
    <SearchPicker<Item>
      id={id}
      endpoint={endpoint}
      value={value as unknown as Item | null}
      onChange={(item) => onChange(item ? { id: item.id, label: formatItem(item) } : null, item)}
      // A picked value is a Ref (it carries `label`); a search hit is the raw record.
      formatLabel={(item) => (isRef(item) ? item.label : formatItem(item))}
      placeholder={placeholder}
      emptyText={emptyText}
    />
  );
}

// Rows of a picked order, fetched when the order changes.
function useFetchedList<T>(url: string | null): T[] {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    if (!url) {
      setList([]);
      return;
    }
    let cancelled = false;
    apiFetch<T[]>(url)
      .then((result) => {
        if (!cancelled) setList(result);
      })
      .catch(() => {
        if (!cancelled) setList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return list;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function DeviationFields({
  draft,
  onChange,
  reasons,
  responsible,
  mode,
}: {
  draft: DeviationDraft;
  onChange: (patch: Partial<DeviationDraft>) => void;
  reasons: DeviationReason[];
  responsible: ResponsibleCandidate[];
  mode: "create" | "edit";
}) {
  const { type } = draft;
  const salesRows = useFetchedList<SalesOrderRow>(draft.salesOrder ? `/api/v1/sales-orders/${draft.salesOrder.id}/rows` : null);
  const purchaseRows = useFetchedList<PurchaseOrderRow>(
    draft.purchaseOrder ? `/api/v1/purchase-orders/${draft.purchaseOrder.id}/rows` : null
  );
  const operations = useFetchedList<MOOperation>(
    draft.manufacturingOrder ? `/api/v1/manufacturing-orders/${draft.manufacturingOrder.id}/operations` : null
  );

  // The reasons offered: active ones that apply to this type, plus the one
  // already on the case (kept even if it was inactivated since).
  const offered = reasons.filter((r) => (r.active && reasonAppliesToType(r, type)) || r.id === draft.reasonId);
  const counterpartLabel = type === "customer" ? "Kundens referens (valfritt)" : "Leverantörens referens (valfritt)";

  // The article follows the row or TO that implies it: choosing one sets its
  // article, clearing/changing it clears the article (the API refuses an
  // article that is not the row's or the TO's).
  function articleOf(articleId: string, articleNumber: string, name: string): Partial<DeviationDraft> {
    return { article: { id: articleId, articleNumber, name }, articleUnit: "" };
  }
  const noArticle: Partial<DeviationDraft> = { article: null, articleUnit: "" };

  return (
    <>
      <FormRow>
        <Field label="Rubrik" htmlFor="devTitle">
          <Input id="devTitle" required maxLength={200} value={draft.title} onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
        <Field label="Datum" htmlFor="devReported">
          <Input id="devReported" type="date" size="sm" required value={draft.reportedDate} onChange={(e) => onChange({ reportedDate: e.target.value })} />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Orsak" htmlFor="devReason">
          <Select id="devReason" value={draft.reasonId} onChange={(e) => onChange({ reasonId: e.target.value })}>
            <option value="">— Ingen —</option>
            {offered.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} · {r.name}
                {r.active ? "" : " (inaktiv)"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ansvarig" htmlFor="devResponsible">
          <Select id="devResponsible" value={draft.responsibleUserId} onChange={(e) => onChange({ responsibleUserId: e.target.value })}>
            <option value="">— Ingen —</option>
            {responsible.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Åtgärd senast" htmlFor="devDue">
          <Input id="devDue" type="date" size="sm" value={draft.dueDate} onChange={(e) => onChange({ dueDate: e.target.value })} />
        </Field>
      </FormRow>
      {mode === "create" && offered.length === 0 && (
        <FormHint attached>Det finns inga orsaker för den här typen — lägg till dem under Kvalitetsorsaker.</FormHint>
      )}

      {type !== "internal" && (
        <>
          <SectionHeading spaced>{type === "customer" ? "Kund" : "Leverantör"}</SectionHeading>
          <FormRow>
            <Field label={type === "customer" ? "Kund" : "Leverantör"} htmlFor="devCounterparty">
              {type === "customer" ? (
                <RefPicker
                  id="devCounterparty"
                  endpoint="/api/v1/customers"
                  value={draft.customer}
                  onChange={(ref) => onChange({ customer: ref })}
                  formatItem={(c) => `${str(c.customerNumber)} — ${str(c.name)}`}
                  placeholder="Sök kundnummer eller namn…"
                  emptyText="Inga kunder matchar sökningen"
                />
              ) : (
                <RefPicker
                  id="devCounterparty"
                  endpoint="/api/v1/suppliers"
                  value={draft.supplier}
                  onChange={(ref) => onChange({ supplier: ref })}
                  formatItem={(s) => `${str(s.supplierNumber)} — ${str(s.name)}`}
                  placeholder="Sök leverantörsnummer eller namn…"
                  emptyText="Inga leverantörer matchar sökningen"
                />
              )}
            </Field>
            <Field label={counterpartLabel} htmlFor="devCounterpartyRef">
              <Input
                id="devCounterpartyRef"
                maxLength={100}
                value={draft.counterpartyReference}
                onChange={(e) => onChange({ counterpartyReference: e.target.value })}
              />
            </Field>
          </FormRow>
        </>
      )}

      <SectionHeading spaced>Gäller</SectionHeading>
      {type === "customer" && (
        <>
          <FormRow>
            <Field label="Kundorder" htmlFor="devSalesOrder">
              <RefPicker
                id="devSalesOrder"
                endpoint="/api/v1/sales-orders?kind=order"
                value={draft.salesOrder}
                onChange={(ref, raw) =>
                  onChange({
                    salesOrder: ref,
                    salesOrderRowId: "",
                    ...(draft.salesOrderRowId !== "" ? noArticle : {}),
                    ...(ref && raw && !draft.customer && typeof raw.customerId === "string"
                      ? { customer: { id: raw.customerId, label: str(raw.customerName) } }
                      : {}),
                  })
                }
                formatItem={(o) => `${str(o.orderNumber)} — ${str(o.customerName)}`}
                placeholder="Sök ordernummer eller kund…"
                emptyText="Inga kundorder matchar sökningen"
              />
            </Field>
            <Field label="Orderrad" htmlFor="devSalesRow">
              <Select
                id="devSalesRow"
                value={draft.salesOrderRowId}
                disabled={!draft.salesOrder}
                onChange={(e) => {
                  const row = salesRows.find((r) => r.id === e.target.value);
                  onChange({
                    salesOrderRowId: e.target.value,
                    ...(row ? articleOf(row.articleId, row.articleNumber, row.articleName) : noArticle),
                  });
                }}
              >
                <option value="">— Ingen rad —</option>
                {salesRows.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    Rad {i + 1}: {r.articleNumber} — {r.articleName} ({Number(r.quantityOrdered).toLocaleString("sv-SE")} {r.unitCode})
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <Field label="Faktura" htmlFor="devInvoice">
            <RefPicker
              id="devInvoice"
              endpoint={draft.customer ? `/api/v1/invoices?type=invoice&customerId=${draft.customer.id}` : "/api/v1/invoices?type=invoice"}
              value={draft.invoice}
              onChange={(ref, raw) =>
                onChange({
                  invoice: ref,
                  ...(ref && raw && !draft.customer && typeof raw.customerId === "string"
                    ? { customer: { id: raw.customerId, label: str(raw.customerName) } }
                    : {}),
                })
              }
              formatItem={(i) => `${str(i.invoiceNumber) || "Utkast"} — ${str(i.customerName)}`}
              placeholder="Sök fakturanummer eller kund…"
              emptyText="Inga fakturor matchar sökningen"
            />
          </Field>
        </>
      )}

      {type === "supplier" && (
        <FormRow>
          <Field label="Inköpsorder" htmlFor="devPurchaseOrder">
            <RefPicker
              id="devPurchaseOrder"
              endpoint={draft.supplier ? `/api/v1/purchase-orders?supplierId=${draft.supplier.id}` : "/api/v1/purchase-orders"}
              value={draft.purchaseOrder}
              onChange={(ref, raw) =>
                onChange({
                  purchaseOrder: ref,
                  purchaseOrderRowId: "",
                  ...(draft.purchaseOrderRowId !== "" ? noArticle : {}),
                  ...(ref && raw && !draft.supplier && typeof raw.supplierId === "string"
                    ? { supplier: { id: raw.supplierId, label: str(raw.supplierName) } }
                    : {}),
                })
              }
              formatItem={(o) => `${str(o.orderNumber)} — ${str(o.supplierName)}`}
              placeholder="Sök ordernummer eller leverantör…"
              emptyText="Inga inköpsorder matchar sökningen"
            />
          </Field>
          <Field label="Orderrad" htmlFor="devPurchaseRow">
            <Select
              id="devPurchaseRow"
              value={draft.purchaseOrderRowId}
              disabled={!draft.purchaseOrder}
              onChange={(e) => {
                const row = purchaseRows.find((r) => r.id === e.target.value);
                onChange({
                  purchaseOrderRowId: e.target.value,
                  ...(row ? articleOf(row.articleId, row.articleNumber, row.articleName) : noArticle),
                });
              }}
            >
              <option value="">— Ingen rad —</option>
              {purchaseRows.map((r, i) => (
                <option key={r.id} value={r.id}>
                  Rad {i + 1}: {r.articleNumber} — {r.articleName} ({Number(r.quantityOrdered).toLocaleString("sv-SE")} {r.unitCode})
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>
      )}

      <FormRow>
        <Field label="Tillverkningsorder" htmlFor="devMo">
          <RefPicker
            id="devMo"
            endpoint="/api/v1/manufacturing-orders"
            value={draft.manufacturingOrder}
            onChange={(ref, raw) =>
              onChange({
                manufacturingOrder: ref,
                moOperationId: "",
                ...(ref && raw && typeof raw.articleId === "string"
                  ? articleOf(raw.articleId, str(raw.articleNumber), str(raw.articleName))
                  : noArticle),
              })
            }
            formatItem={(o) => `${str(o.orderNumber)} — ${str(o.articleNumber)} ${str(o.articleName)}`}
            placeholder="Sök TO-nummer eller artikel…"
            emptyText="Inga tillverkningsorder matchar sökningen"
          />
        </Field>
        <Field label="Operation" htmlFor="devOperation">
          <Select
            id="devOperation"
            value={draft.moOperationId}
            disabled={!draft.manufacturingOrder}
            onChange={(e) => onChange({ moOperationId: e.target.value })}
          >
            <option value="">— Ingen operation —</option>
            {operations.map((op) => (
              <option key={op.id} value={op.id}>
                Op {op.sequenceNo} · {op.workCenterName}
                {op.description ? ` — ${op.description}` : ""}
              </option>
            ))}
          </Select>
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Artikel" htmlFor="devArticle">
          <ArticlePicker
            id="devArticle"
            value={draft.article}
            onChange={(a: Article | null) => onChange({ article: a, articleUnit: a?.unit ?? "" })}
          />
        </Field>
        <Field label={draft.articleUnit ? `Antal (${draft.articleUnit})` : "Antal"} htmlFor="devQuantity">
          <Input
            id="devQuantity"
            type="number"
            min="0"
            step="any"
            size="sm"
            value={draft.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
        </Field>
      </FormRow>
      <FormHint attached>Antalet anges i artikelns lagerenhet.</FormHint>

      <SectionHeading spaced>Beskrivning och utredning</SectionHeading>
      <Field label="Beskrivning" htmlFor="devDescription">
        <Textarea id="devDescription" rows={3} maxLength={10000} value={draft.description} onChange={(e) => onChange({ description: e.target.value })} />
      </Field>
      <Field label="Orsaksanalys" htmlFor="devCause">
        <Textarea id="devCause" rows={3} maxLength={10000} value={draft.causeAnalysis} onChange={(e) => onChange({ causeAnalysis: e.target.value })} />
      </Field>
      <Field label="Åtgärd" htmlFor="devCorrective">
        <Textarea id="devCorrective" rows={3} maxLength={10000} value={draft.correctiveAction} onChange={(e) => onChange({ correctiveAction: e.target.value })} />
      </Field>
      <Field label="Förebyggande åtgärd" htmlFor="devPreventive">
        <Textarea id="devPreventive" rows={3} maxLength={10000} value={draft.preventiveAction} onChange={(e) => onChange({ preventiveAction: e.target.value })} />
      </Field>

      {mode === "edit" && type !== "internal" && (
        <Field label="Beslut" htmlFor="devDecision">
          <Select id="devDecision" size="md" value={draft.decision} onChange={(e) => onChange({ decision: e.target.value as "" | DeviationDecision })}>
            <option value="">— Inte beslutat —</option>
            {DEVIATION_DECISIONS.map((d) => (
              <option key={d} value={d}>
                {DEVIATION_DECISION_LABELS[d]}
              </option>
            ))}
          </Select>
          <FormHint>
            {type === "customer"
              ? "Godkänd betyder att vi godkänner kundens reklamation. Beslutet krävs för att avsluta."
              : "Godkänd betyder att leverantören har godkänt vår reklamation. Beslutet krävs för att avsluta."}
          </FormHint>
        </Field>
      )}
    </>
  );
}
