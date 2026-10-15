"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { SearchPicker } from "../ui/SearchPicker";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { apiFetch } from "../../lib/api";
import type { Article, Inquiry, Supplier } from "../../lib/types";
import { Form, FormActions, FormError, FormLineRow, FormLineRowTop, FormRow } from "../ui/Form";

interface InquiryFormRow {
  article: Article | null;
  quantity: string;
  unitPrice: string; // empty = no price yet
  unitId: string; // "" = the article's base unit
}

interface CreateInquiryResponse {
  inquiry: Inquiry;
}

// Creates a förfrågan (RFQ). Pass `lockedSupplier` (e.g. from the supplier
// card) to skip the supplier picker.
export function NewInquiryForm({
  lockedSupplier,
}: {
  lockedSupplier?: Supplier;
}) {
  const router = useRouter();
  const [supplier, setSupplier] = useState<Supplier | null>(lockedSupplier ?? null);
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<InquiryFormRow[]>([{ article: null, quantity: "1", unitPrice: "", unitId: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateRow(index: number, patch: Partial<InquiryFormRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((prev) => [...prev, { article: null, quantity: "1", unitPrice: "", unitId: "" }]);
  }

  function removeRow(index: number) {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!supplier) {
      setError("Välj en leverantör");
      return;
    }
    if (rows.some((r) => r.article === null)) {
      setError("Välj artikel på alla rader");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<CreateInquiryResponse>("/api/v1/inquiries", {
        method: "POST",
        body: JSON.stringify({
          supplierId: supplier.id,
          expectedDeliveryDate: expectedDeliveryDate || undefined,
          note: note || undefined,
          rows: rows.map((r) => ({
            articleId: r.article!.id,
            quantity: Number(r.quantity),
            unitPrice: r.unitPrice.trim() === "" ? undefined : Number(r.unitPrice),
            unitId: r.unitId === "" ? null : r.unitId,
          })),
        }),
      });
      router.push(`/inkop/forfragningar/${result.inquiry.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa förfrågan");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      {lockedSupplier ? (
        <Field label="Leverantör" htmlFor="inquirySupplierId">
          <Input id="inquirySupplierId" value={`${lockedSupplier.name} (${lockedSupplier.currency})`} disabled />
        </Field>
      ) : (
        <Field label="Leverantör" htmlFor="inquirySupplierId">
          <SearchPicker
            id="inquirySupplierId"
            endpoint="/api/v1/suppliers"
            value={supplier}
            onChange={setSupplier}
            formatLabel={(s) => `${s.supplierNumber} — ${s.name} (${s.currency})`}
            placeholder="Sök leverantörnummer eller namn…"
            emptyText="Inga leverantörer matchar sökningen"
          />
        </Field>
      )}

      <FormRow>
        <Field label="Önskat leveransdatum (valfritt)" htmlFor="inquiryDeliveryDate">
          <Input
            id="inquiryDeliveryDate"
            type="date"
            size="sm"
            value={expectedDeliveryDate}
            onChange={(e) => setExpectedDeliveryDate(e.target.value)}
          />
        </Field>
        <Field label="Anteckning (valfritt)" htmlFor="inquiryNote">
          <Input id="inquiryNote" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </FormRow>

      <div>
        <RowLabel>Rader</RowLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
          {rows.map((row, index) => (
            <InquiryRowFields
              key={index}
              index={index}
              row={row}
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
          {pending ? "Skapar…" : "Skapa förfrågan"}
        </Button>
      </FormActions>
    </Form>
  );
}

// One inquiry row: article + quantity/price with a unit dropdown. Picking an
// article pre-selects its purchase unit; switching unit re-expresses the
// entered quantity and price in the new unit (500 kg ⇄ 100 st).
function InquiryRowFields({
  index,
  row,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  row: InquiryFormRow;
  canRemove: boolean;
  onChange: (patch: Partial<InquiryFormRow>) => void;
  onRemove: () => void;
}) {
  const unitOptions = useUnitOptions(row.article);
  const currentFactor = unitOptions.find((o) => o.value === row.unitId)?.factor ?? 1;

  function handleArticleChange(article: Article | null) {
    onChange({ article, unitId: article?.purchaseUnitId ?? "" });
  }

  function handleUnitChange(option: UnitOption) {
    onChange({
      unitId: option.value,
      quantity: convertQuantityInput(row.quantity, currentFactor, option.factor),
      unitPrice: convertPriceInput(row.unitPrice, currentFactor, option.factor),
    });
  }

  const unitCode = unitOptions.find((o) => o.value === row.unitId)?.code;

  return (
    <FormLineRow>
      <FormLineRowTop>
        <Field label="Artikel" htmlFor={`inquiryArticle-${index}`}>
          <ArticlePicker orderable id={`inquiryArticle-${index}`} value={row.article} onChange={handleArticleChange} />
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
      <FormRow columns={3}>
        <Field label="Antal" htmlFor={`inquiryQuantity-${index}`}>
          <Input
            id={`inquiryQuantity-${index}`}
            type="number"
            min="0"
            step="any"
            size="sm"
            required
            value={row.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
        </Field>
        <Field label="Enhet" htmlFor={`inquiryUnit-${index}`}>
          <UnitSelect
            id={`inquiryUnit-${index}`}
            options={unitOptions}
            value={row.unitId}
            onChange={handleUnitChange}
          />
        </Field>
        <Field label={unitCode ? `Á-pris (kr/${unitCode})` : "Á-pris (valfritt)"} htmlFor={`inquiryPrice-${index}`}>
          <Input
            id={`inquiryPrice-${index}`}
            type="number"
            min="0"
            step="0.01"
            size="sm"
            value={row.unitPrice}
            onChange={(e) => onChange({ unitPrice: e.target.value })}
          />
        </Field>
      </FormRow>
    </FormLineRow>
  );
}

function RowLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
      {children}
    </div>
  );
}
