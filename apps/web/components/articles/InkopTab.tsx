"use client";

import { confirmDelete } from "../../lib/confirm";
import { useEffect, useState, type FormEvent } from "react";
import { GatedLink } from "../ui/GatedLink";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { SectionHeading } from "../ui/SectionHeading";
import { Modal } from "../ui/Modal";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Toggle } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import { formatMoney, formatQuantity } from "../../lib/format";
import {
  SUPPLIER_INVOICE_STATUS_PILL,
  type ArticleSupplier,
  type GoodsReceiptLogEntry,
  type Paged,
  type PriceHistoryEntry,
  type Supplier,
  type SupplierInvoice,
} from "../../lib/types";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";

// Inköp-fliken (Monitor G5 "Inköp"-flik): one tab, four stacked sections —
// the editable leverantörskatalog on top, then the read-only inleverans-,
// pris- and leverantörsfakturaloggar. Only shown for köpta/tjänsteartiklar.
export function InkopTab({ articleId }: { articleId: string }) {
  const [catalog, setCatalog] = useState<ArticleSupplier[]>([]);
  const [receipts, setReceipts] = useState<GoodsReceiptLogEntry[]>([]);
  const [prices, setPrices] = useState<PriceHistoryEntry[]>([]);
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ArticleSupplier | null>(null);

  async function load() {
    setError(null);
    try {
      const [cat, rec, price, inv] = await Promise.all([
        apiFetch<ArticleSupplier[]>(`/api/v1/articles/${articleId}/suppliers`),
        apiFetch<Paged<GoodsReceiptLogEntry>>(`/api/v1/goods-receipts?articleId=${articleId}&limit=100`),
        apiFetch<Paged<PriceHistoryEntry>>(`/api/v1/price-history?articleId=${articleId}&limit=100`),
        apiFetch<Paged<SupplierInvoice>>(`/api/v1/supplier-invoices?articleId=${articleId}&limit=100`),
      ]);
      setCatalog(cat);
      setReceipts(rec.rows);
      setPrices(price.rows);
      setInvoices(inv.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte hämta inköpsdata");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  async function removeCatalogRow(row: ArticleSupplier) {
    if (!(await confirmDelete(`Ta bort ${row.supplierName} från leverantörslistan?`))) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/suppliers/${row.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort leverantören");
    }
  }

  return (
    <div>
      <FormError>{error}</FormError>

      {/* --- Leverantörer (redigerbar katalog) --- */}
      <SectionHeading
        actions={
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            + Ny leverantör
          </Button>
        }
      >
        Leverantörer
      </SectionHeading>

      <Table<ArticleSupplier>
        columns={[
          { key: "supplierName", label: "Leverantör", width: "1.4fr" },
          { key: "supplierArticleNumber", label: "Leverantörens artikelnr", width: "1fr" },
          { key: "price", label: "Pris", width: "110px", align: "right" },
          { key: "currency", label: "Valuta", width: "90px" },
          { key: "leadTimeDays", label: "Ledtid (dagar)", width: "120px", align: "right" },
          { key: "isPrimary", label: "Huvudleverantör", width: "150px" },
          { key: "id", label: "", width: "160px", align: "right" },
        ]}
        rows={catalog}
        emptyText="Inga leverantörer registrerade"
        renderCell={(row, key) => {
          switch (key) {
            case "supplierName":
              return <strong>{row.supplierName}</strong>;
            case "supplierArticleNumber":
              return row.supplierArticleNumber ?? "–";
            case "price":
              return (
                <>
                  {row.price !== null ? formatMoney(row.price) : "–"}
                  {row.priceBreaks.length > 0 && (
                    <span
                      style={{ color: "var(--color-text-muted)", fontSize: 12, marginLeft: 6, whiteSpace: "nowrap" }}
                      title={row.priceBreaks
                        .map((b) => `Från ${b.fromQuantity.toLocaleString("sv-SE")}: ${formatMoney(b.price)}`)
                        .join(" · ")}
                    >
                      · {row.priceBreaks.length} staffelsteg
                    </span>
                  )}
                </>
              );
            case "currency":
              return row.currency;
            case "leadTimeDays":
              return row.leadTimeDays ?? "–";
            case "isPrimary":
              return row.isPrimary ? <StatusPill status="running" label="Huvudleverantör" compact /> : "";
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setEditing(row);
                      setModalOpen(true);
                    }}
                  >
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => removeCatalogRow(row)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      {/* --- Inleveranslogg --- */}
      <SectionHeading spaced>Inleveranslogg</SectionHeading>
      <Table<GoodsReceiptLogEntry>
        columns={[
          { key: "date", label: "Datum", width: "120px" },
          { key: "orderNumber", label: "IO-nummer", width: "1fr" },
          { key: "supplierName", label: "Leverantör", width: "1.4fr" },
          { key: "quantity", label: "Antal", width: "110px", align: "right" },
          { key: "unitPrice", label: "À-pris", width: "120px", align: "right" },
          { key: "locationName", label: "Lagerplats", width: "130px" },
        ]}
        rows={receipts}
        emptyText="Inga inleveranser registrerade"
        renderCell={(row, key) => {
          switch (key) {
            case "date":
              return formatDate(row.date);
            case "quantity":
              return formatQuantity(row.quantity);
            case "unitPrice":
              return `${formatMoney(row.unitPrice)} ${row.currency}`;
            case "locationName":
              return row.locationName ?? "–";
            default:
              return row[key as keyof GoodsReceiptLogEntry] as string;
          }
        }}
      />

      {/* --- Prislogg --- */}
      <SectionHeading spaced>Prislogg</SectionHeading>
      <Table<PriceHistoryEntry>
        columns={[
          { key: "date", label: "Datum", width: "120px" },
          { key: "orderNumber", label: "IO-nummer", width: "1fr" },
          { key: "supplierName", label: "Leverantör", width: "1.4fr" },
          { key: "unitPrice", label: "À-pris", width: "120px", align: "right" },
          { key: "currency", label: "Valuta", width: "90px" },
          { key: "quantity", label: "Antal", width: "110px", align: "right" },
        ]}
        rows={prices}
        emptyText="Ingen prishistorik"
        renderCell={(row, key) => {
          switch (key) {
            case "date":
              return formatDate(row.date);
            case "unitPrice":
              return formatMoney(row.unitPrice);
            case "quantity":
              return formatQuantity(row.quantity);
            default:
              return row[key as keyof PriceHistoryEntry] as string;
          }
        }}
      />

      {/* --- Leverantörsfakturor --- */}
      <SectionHeading spaced>Leverantörsfakturor</SectionHeading>
      <Table<SupplierInvoice>
        columns={[
          { key: "invoiceDate", label: "Fakturadatum", width: "130px" },
          { key: "registrationNumber", label: "Reg.nr", width: "120px" },
          { key: "invoiceNumber", label: "Leverantörens fakturanr", width: "1fr" },
          { key: "supplierName", label: "Leverantör", width: "1.4fr" },
          { key: "status", label: "Status", width: "130px" },
          { key: "grossAmount", label: "Belopp", width: "130px", align: "right" },
        ]}
        rows={invoices}
        emptyText="Inga leverantörsfakturor"
        renderCell={(row, key) => {
          switch (key) {
            case "invoiceDate":
              return formatDate(row.invoiceDate);
            case "registrationNumber":
              return (
                <GatedLink href={`/inkop/leverantorsfakturor/${row.id}`} style={{ color: "var(--accent-fg)" }}>
                  {row.registrationNumber}
                </GatedLink>
              );
            case "status": {
              const pill = SUPPLIER_INVOICE_STATUS_PILL[row.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "grossAmount":
              return `${formatMoney(row.grossAmount)} ${row.currency}`;
            default:
              return row[key as keyof SupplierInvoice] as string;
          }
        }}
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Redigera ${editing.supplierName}` : "Ny leverantör"}
      >
        <ArticleSupplierForm
          articleId={articleId}
          existing={editing}
          onSuccess={() => {
            setModalOpen(false);
            void load();
          }}
        />
      </Modal>
    </div>
  );
}

// Creates a catalog row, or edits one when `existing` is passed. The supplier
// link is fixed on edit (change = remove + add).
function ArticleSupplierForm({
  articleId,
  existing,
  onSuccess,
}: {
  articleId: string;
  existing: ArticleSupplier | null;
  onSuccess: () => void;
}) {
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [supplierArticleNumber, setSupplierArticleNumber] = useState(existing?.supplierArticleNumber ?? "");
  const [price, setPrice] = useState(existing?.price ?? "");
  const [currency, setCurrency] = useState(existing?.currency ?? "SEK");
  const [leadTimeDays, setLeadTimeDays] = useState(existing?.leadTimeDays != null ? String(existing.leadTimeDays) : "");
  const [isPrimary, setIsPrimary] = useState(existing?.isPrimary ?? false);
  // Staffelsteg — edited as strings, validated on submit, sent as the whole
  // set (the API replaces the stored set; [] clears it).
  const [breaks, setBreaks] = useState<{ fromQuantity: string; price: string }[]>(
    existing?.priceBreaks.map((b) => ({ fromQuantity: String(b.fromQuantity), price: String(b.price) })) ?? []
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Default the currency to the chosen supplier's currency.
  function handleSupplierChange(s: Supplier | null) {
    setSupplier(s);
    if (s) setCurrency(s.currency);
  }

  function updateBreak(index: number, patch: Partial<{ fromQuantity: string; price: string }>) {
    setBreaks((list) => list.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  // Quantity 1 is the Pris field itself, so a step must start above 1 and
  // the quantities must be distinct — the same rules the API enforces.
  function parseBreaks(): { fromQuantity: number; price: number }[] | null {
    // A row added with + Lägg till steg and left blank is simply dropped.
    const parsed = breaks
      .filter((b) => b.fromQuantity.trim() !== "" || b.price.trim() !== "")
      .map((b) => ({ fromQuantity: Number(b.fromQuantity), price: Number(b.price) }));
    const quantities = new Set<number>();
    for (const b of parsed) {
      if (!Number.isFinite(b.fromQuantity) || b.fromQuantity <= 1 || quantities.has(b.fromQuantity)) return null;
      if (!Number.isFinite(b.price) || b.price < 0) return null;
      quantities.add(b.fromQuantity);
    }
    return parsed;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!existing && !supplier) {
      setError("Välj en leverantör");
      return;
    }
    const priceBreaks = parseBreaks();
    if (!priceBreaks) {
      setError("Från antal i staffeln måste vara större än 1 och unikt, och priset ett tal");
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (existing) {
        await apiFetch(`/api/v1/articles/${articleId}/suppliers/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            supplierArticleNumber: supplierArticleNumber.trim() || null,
            price: price.trim() ? Number(price) : null,
            currency,
            leadTimeDays: leadTimeDays.trim() ? Number(leadTimeDays) : null,
            isPrimary,
            priceBreaks,
          }),
        });
      } else {
        await apiFetch(`/api/v1/articles/${articleId}/suppliers`, {
          method: "POST",
          body: JSON.stringify({
            supplierId: supplier!.id,
            supplierArticleNumber: supplierArticleNumber.trim() || undefined,
            price: price.trim() ? Number(price) : undefined,
            currency,
            leadTimeDays: leadTimeDays.trim() ? Number(leadTimeDays) : undefined,
            isPrimary,
            priceBreaks: priceBreaks.length > 0 ? priceBreaks : undefined,
          }),
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara leverantören");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      {existing ? (
        <Field label="Leverantör">
          <Input value={existing.supplierName} disabled />
        </Field>
      ) : (
        <Field label="Leverantör" htmlFor="articleSupplierSupplier">
          <SearchPicker
            id="articleSupplierSupplier"
            endpoint="/api/v1/suppliers"
            value={supplier}
            onChange={handleSupplierChange}
            formatLabel={(s) => `${s.supplierNumber} — ${s.name}`}
            placeholder="Sök leverantörnummer eller namn…"
            emptyText="Inga leverantörer matchar sökningen"
          />
        </Field>
      )}

      <Field label="Leverantörens artikelnummer" htmlFor="articleSupplierNumber">
        <Input
          id="articleSupplierNumber"
          maxLength={100}
          value={supplierArticleNumber}
          onChange={(e) => setSupplierArticleNumber(e.target.value)}
        />
      </Field>

      <FormRow>
        <Field label="Pris" htmlFor="articleSupplierPrice">
          <Input
            id="articleSupplierPrice"
            type="number"
            size="sm"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <Field label="Valuta" htmlFor="articleSupplierCurrency">
          <Input
            id="articleSupplierCurrency"
            size="xs"
            maxLength={3}
            pattern="[A-Z]{3}"
            title="3 stora bokstäver, t.ex. SEK"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </Field>
      </FormRow>

      {/* Stafflade priser: Pris above is the price for quantity 1; each step
          is the price from its quantity upwards. Fluid columns — the modal
          body is ~496 px, so no fixed px grid here. */}
      <Field label="Staffel (pris från antal)">
        <div style={{ display: "grid", gap: 8 }}>
          {breaks.map((b, index) => (
            <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center" }}>
              <Input
                type="number"
                min="0"
                step="any"
                size="sm"
                placeholder="Från antal"
                aria-label="Från antal"
                value={b.fromQuantity}
                onChange={(e) => updateBreak(index, { fromQuantity: e.target.value })}
              />
              <Input
                type="number"
                min="0"
                step="0.01"
                size="sm"
                placeholder="Pris"
                aria-label="Pris"
                value={b.price}
                onChange={(e) => updateBreak(index, { price: e.target.value })}
              />
              <Button
                type="button"
                size="small"
                variant="ghost"
                onClick={() => setBreaks((list) => list.filter((_, i) => i !== index))}
              >
                Ta bort
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              size="small"
              variant="ghost"
              onClick={() => setBreaks((list) => [...list, { fromQuantity: "", price: "" }])}
            >
              + Lägg till steg
            </Button>
          </div>
        </div>
      </Field>

      <FormRow>
        <Field label="Ledtid (dagar)" htmlFor="articleSupplierLeadTime">
          <Input
            id="articleSupplierLeadTime"
            type="number"
            size="sm"
            min="0"
            step="1"
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.target.value)}
          />
        </Field>
        <Field label="Huvudleverantör" htmlFor="articleSupplierPrimary">
          <Toggle
            id="articleSupplierPrimary"
            checked={isPrimary}
            onChange={(e) => setIsPrimary(e.target.checked)}
          />
        </Field>
      </FormRow>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : existing ? "Spara" : "Lägg till"}
        </Button>
      </FormActions>
    </Form>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("sv-SE");
}
