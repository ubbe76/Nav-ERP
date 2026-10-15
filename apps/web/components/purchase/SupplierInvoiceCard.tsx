"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Table } from "../ui/Table";
import { SectionHeading } from "../ui/SectionHeading";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import {
  SUPPLIER_INVOICE_STATUS_PILL,
  VAT_RATES,
  type Article,
  type Paged,
  type PriceHistoryEntry,
  type SupplierInvoiceDetail,
  type SupplierInvoicePaymentEntry,
  type SupplierInvoiceRow,
} from "../../lib/types";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormRow, FormStack } from "../ui/Form";
import buttonStyles from "../ui/Button.module.css";
import { AuditTrailSection } from "../system/AuditTrailSection";
import { PaymentReferenceSection } from "../banking/PaymentReferenceSection";
import { UnderlagSection } from "../documents/UnderlagSection";

export function SupplierInvoiceCard({
  invoice,
  canOpenVerifications,
}: {
  invoice: SupplierInvoiceDetail;
  // The whole /verifications surface (and the page behind the Verifikat
  // link) is admin-only in the API, so the link is only rendered for admins
  // — resolved server-side in page.tsx.
  canOpenVerifications: boolean;
}) {
  const router = useRouter();
  // Set by the Ny leverantörsfaktura dialog when the invoice was created but
  // an underlag upload failed.
  const uploadFailed = useSearchParams().get("underlag") === "fel";
  const pill = SUPPLIER_INVOICE_STATUS_PILL[invoice.status];
  // Header and rows are only editable in Utkast.
  const editable = invoice.status === "draft";
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function statusAction(action: "approve" | "cancel") {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/supplier-invoices/${invoice.id}/${action}`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Åtgärden misslyckades");
    } finally {
      setPending(false);
    }
  }

  async function removeRow(row: SupplierInvoiceRow) {
    if (!(await confirmDelete(`Ta bort raden "${row.description}"?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/supplier-invoices/${invoice.id}/rows/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort raden");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 24, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        <StatusPill status={pill.status} label={pill.label} />
        <span>Leverantörens fakturanr: <strong>{invoice.invoiceNumber}</strong></span>
        <span>Fakturadatum: {invoice.invoiceDate}</span>
        {invoice.dueDate && <span>Förfaller: {invoice.dueDate}</span>}
        {invoice.purchaseOrderNumber && <span>Inköpsorder: {invoice.purchaseOrderNumber}</span>}
        {/* openAmount is meaningless for draft/cancelled (see
            SupplierInvoiceDetail's own comment) — approved/paid only, same
            gate as the AR mirror InvoiceCard's own Öppet belopp. */}
        {(invoice.status === "approved" || invoice.status === "paid") && (
          <span>
            Öppet belopp: {formatMoney(invoice.openAmount)} {invoice.currency}
          </span>
        )}
        {invoice.verificationId && (
          <span>
            Verifikat{" "}
            {canOpenVerifications ? (
              <Link href={`/ekonomi/verifikat/${invoice.verificationId}`}>
                {invoice.verificationDisplayNumber ?? "–"}
              </Link>
            ) : (
              invoice.verificationDisplayNumber ?? "–"
            )}
          </span>
        )}
      </div>

      <FormError>{error}</FormError>

      {/* Header — editable in draft, read-only otherwise. */}
      {editable ? (
        <HeaderForm invoice={invoice} onSaved={() => router.refresh()} />
      ) : (
        <Card maxWidth={520} style={{ marginBottom: 20 }}>
          <FormStack>
            <FormRow>
              <div><strong>Nettobelopp</strong><br />{formatMoney(invoice.netAmount)} {invoice.currency}</div>
              <div><strong>Momsbelopp</strong><br />{formatMoney(invoice.vatAmount)} {invoice.currency}</div>
            </FormRow>
            <div><strong>Bruttobelopp</strong><br />{formatMoney(invoice.grossAmount)} {invoice.currency}</div>
            {invoice.note && <div><strong>Notering</strong><br />{invoice.note}</div>}
          </FormStack>
        </Card>
      )}

      {invoice.status !== "cancelled" && <PaymentReferenceSection key={`${invoice.paymentReferenceKind}-${invoice.paymentReference}-${invoice.status}-${invoice.paymentBatches.map((b) => `${b.endToEndId}:${b.itemStatus}`).join(",")}`} invoice={invoice} />}
      <UnderlagSection
        filesUrl={`/api/v1/supplier-invoices/${invoice.id}/files`}
        files={invoice.files}
        removable={invoice.status === "draft"}
        lockedBy="attest"
        description="Leverantörens faktura som"
        initialError={uploadFailed ? "Fakturan skapades, men underlaget kunde inte laddas upp — försök igen här." : null}
      />

      <SectionHeading spaced>Rader</SectionHeading>
      {invoice.rows.length > 0 ? (
        <Table<SupplierInvoiceRow>
          columns={[
            { key: "description", label: "Beskrivning", width: "1.4fr" },
            { key: "articleNumber", label: "Artikel", width: "1fr" },
            { key: "quantity", label: "Antal", width: "90px", align: "right" },
            { key: "unitPrice", label: "À-pris", width: "110px", align: "right" },
            { key: "lineAmount", label: "Belopp", width: "120px", align: "right" },
            { key: "poOrderNumber", label: "IO-matchning", width: "1fr" },
            { key: "id", label: "", width: "110px", align: "right" },
          ]}
          rows={invoice.rows}
          renderCell={(row, key) => {
            switch (key) {
              case "articleNumber":
                return row.articleNumber ? `${row.articleNumber} — ${row.articleName}` : "–";
              case "quantity":
                return Number(row.quantity);
              case "unitPrice":
                return formatMoney(row.unitPrice);
              case "lineAmount":
                return formatMoney(row.lineAmount);
              case "poOrderNumber":
                return <MatchCell row={row} />;
              case "id":
                if (!editable) return null;
                return (
                  <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => removeRow(row)}>
                    Ta bort
                  </Button>
                );
              default:
                return row[key as keyof SupplierInvoiceRow] as string;
            }
          }}
        />
      ) : (
        <p>Inga rader tillagda än.</p>
      )}

      {invoice.payments.length > 0 && (
        <>
          <SectionHeading spaced>Betalningar</SectionHeading>
          <Table<SupplierInvoicePaymentEntry & { id: string }>
            columns={[
              { key: "paymentDate", label: "Datum", width: "130px" },
              { key: "paymentNumber", label: "Betalning", width: "160px" },
              { key: "appliedAmount", label: "Belopp", width: "130px", align: "right" },
              { key: "writeOffAmount", label: "Avskrivning", width: "140px", align: "right" },
              { key: "verificationId", label: "Verifikat", width: "130px" },
            ]}
            // Table requires a plain `id` — the wire shape only has
            // paymentId (see SupplierInvoicePaymentEntry's own comment).
            rows={invoice.payments.map((p) => ({ ...p, id: p.paymentId }))}
            renderCell={(row, key) => {
              switch (key) {
                case "paymentDate":
                  return row.paymentDate;
                case "paymentNumber":
                  return (
                    <Link href={`/inkop/betalningar/${row.paymentId}`}>
                      {row.paymentNumber}
                      {row.cancelledAt !== null && (
                        <>
                          {" "}
                          <StatusPill status="stopped" label="Makulerad" compact />
                        </>
                      )}
                    </Link>
                  );
                case "appliedAmount":
                  return `${formatMoney(row.appliedAmount)} ${invoice.currency}`;
                case "writeOffAmount":
                  return Number(row.writeOffAmount) !== 0 ? `${formatMoney(row.writeOffAmount)} ${invoice.currency}` : "–";
                case "verificationId":
                  if (row.verificationId === null) {
                    return <span title="Kvittning (inget verifikat)">– (kvittning)</span>;
                  }
                  return canOpenVerifications ? (
                    <Link href={`/ekonomi/verifikat/${row.verificationId}`}>{row.verificationDisplayNumber ?? "–"}</Link>
                  ) : (
                    "–"
                  );
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      <div style={{ marginTop: 20, display: "flex", gap: 16, flexWrap: "wrap" }}>
        {editable && (
          <AddRowForm
            invoiceId={invoice.id}
            supplierName={invoice.supplierName}
            onDone={() => router.refresh()}
          />
        )}

        <Card maxWidth={320}>
          <FormStack>
            <strong>Åtgärder</strong>
            {invoice.status === "draft" && (
              <Button type="button" variant="primary" disabled={pending} onClick={() => statusAction("approve")}>
                Godkänn
              </Button>
            )}
            {/* "Betala" no longer exists (B4) — betald is set by registering
                a payment against the open amount instead. */}
            {invoice.status === "approved" && invoice.openAmount !== 0 && (
              <Link
                href={`/inkop/betalningar?invoice=${invoice.id}`}
                className={`${buttonStyles.button} ${buttonStyles.primary}`}
              >
                Registrera betalning
              </Link>
            )}
            {(invoice.status === "draft" || invoice.status === "approved") && (
              <Button type="button" variant="danger" disabled={pending} onClick={() => statusAction("cancel")}>
                Avbryt
              </Button>
            )}
            {(invoice.status === "paid" || invoice.status === "cancelled") && <span>Inga åtgärder tillgängliga.</span>}
          </FormStack>
        </Card>
      </div>

      <AuditTrailSection entityType="supplier_invoice" entityId={invoice.registrationNumber} />
    </div>
  );
}

// Matched PO row + computed price/quantity deviation.
function MatchCell({ row }: { row: SupplierInvoiceRow }) {
  if (!row.poOrderNumber) return <>–</>;
  const parts: string[] = [];
  if (row.priceVariance != null && Number(row.priceVariance) !== 0) parts.push(`pris ${signed(row.priceVariance)}`);
  if (row.quantityVariance != null && Number(row.quantityVariance) !== 0) parts.push(`antal ${signed(row.quantityVariance)}`);
  return (
    <span>
      {row.poOrderNumber}
      {parts.length > 0 && <span style={{ color: "var(--status-stopped-text)" }}> · {parts.join(", ")}</span>}
    </span>
  );
}

function HeaderForm({ invoice, onSaved }: { invoice: SupplierInvoiceDetail; onSaved: () => void }) {
  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoiceNumber);
  const [invoiceDate, setInvoiceDate] = useState(invoice.invoiceDate);
  const [dueDate, setDueDate] = useState(invoice.dueDate ?? "");
  const [netAmount, setNetAmount] = useState(invoice.netAmount);
  const [vatAmount, setVatAmount] = useState(invoice.vatAmount);
  const [grossAmount, setGrossAmount] = useState(invoice.grossAmount);
  const [note, setNote] = useState(invoice.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/v1/supplier-invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          invoiceNumber,
          invoiceDate,
          dueDate: dueDate.trim() || null,
          netAmount: Number(netAmount),
          vatAmount: Number(vatAmount),
          grossAmount: Number(grossAmount),
          note: note.trim() || null,
        }),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara fakturan");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth={520} style={{ marginBottom: 20 }}>
      <Form onSubmit={save}>
        <FormError>{error}</FormError>
        <FormRow>
          <Field label="Leverantörens fakturanummer" htmlFor="hdrInvoiceNumber">
            <Input id="hdrInvoiceNumber" size="md" required maxLength={50} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
          </Field>
          <Field label="Fakturadatum" htmlFor="hdrInvoiceDate">
            <Input id="hdrInvoiceDate" type="date" size="sm" required value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Förfallodatum" htmlFor="hdrDueDate">
            <Input id="hdrDueDate" type="date" size="sm" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Nettobelopp" htmlFor="hdrNet">
            <Input id="hdrNet" type="number" step="0.01" size="sm" value={netAmount} onChange={(e) => setNetAmount(e.target.value)} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Momsbelopp" htmlFor="hdrVat">
            <Input id="hdrVat" type="number" step="0.01" size="sm" value={vatAmount} onChange={(e) => setVatAmount(e.target.value)} />
          </Field>
          <Field label="Bruttobelopp" htmlFor="hdrGross">
            <Input id="hdrGross" type="number" step="0.01" size="sm" value={grossAmount} onChange={(e) => setGrossAmount(e.target.value)} />
          </Field>
        </FormRow>
        <Field label="Notering" htmlFor="hdrNote">
          <Input id="hdrNote" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara faktura"}
          </Button>
          {saved && <span style={{ alignSelf: "center" }}>Sparat</span>}
        </FormActions>
      </Form>
    </Card>
  );
}

// Adds a line — with an optional link to a purchase-order row for the same
// supplier + article (IO-matchning). The API validates the match.
function AddRowForm({
  invoiceId,
  supplierName,
  onDone,
}: {
  invoiceId: string;
  supplierName: string;
  onDone: () => void;
}) {
  const [description, setDescription] = useState("");
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [vatRate, setVatRate] = useState("");
  const [poRowId, setPoRowId] = useState("");
  const [matchOptions, setMatchOptions] = useState<PriceHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Picking an article offers its purchase-order rows for this supplier as
  // match candidates (price-history rows carry the PO row id).
  async function handleArticleChange(next: Article | null) {
    setArticle(next);
    setPoRowId("");
    setMatchOptions([]);
    if (!next) return;
    try {
      const history = await apiFetch<Paged<PriceHistoryEntry>>(
        `/api/v1/price-history?articleId=${next.id}&limit=100`
      );
      setMatchOptions(history.rows.filter((r) => r.supplierName === supplierName));
    } catch {
      // Non-fatal — matching just won't be offered.
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!description.trim()) {
      setError("Ange en beskrivning");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/supplier-invoices/${invoiceId}/rows`, {
        method: "POST",
        body: JSON.stringify({
          description: description.trim(),
          articleId: article?.id ?? undefined,
          quantity: Number(quantity),
          unitPrice: unitPrice.trim() ? Number(unitPrice) : 0,
          vatRate: vatRate.trim() ? Number(vatRate) : undefined,
          purchaseOrderRowId: poRowId || undefined,
        }),
      });
      setDescription("");
      setArticle(null);
      setQuantity("1");
      setUnitPrice("");
      setVatRate("");
      setPoRowId("");
      setMatchOptions([]);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte lägga till raden");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth={460}>
      <Form onSubmit={submit}>
        <strong>Lägg till rad</strong>
        <FormError>{error}</FormError>

        <Field label="Beskrivning" htmlFor="rowDescription">
          <Input id="rowDescription" required maxLength={255} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <Field label="Artikel (valfritt)" htmlFor="rowArticle">
          <ArticlePicker id="rowArticle" value={article} onChange={handleArticleChange} />
        </Field>

        <FormRow>
          <Field label="Antal" htmlFor="rowQuantity">
            <Input id="rowQuantity" type="number" min="0" step="any" size="sm" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="À-pris" htmlFor="rowUnitPrice">
            <Input id="rowUnitPrice" type="number" step="0.01" size="sm" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
          </Field>
          <Field label="Moms %" htmlFor="rowVatRate">
            {/* Enum-locked to the Swedish set since B5 (same Select as the
                customer invoice's rows); empty = no rate on the row. */}
            <Select id="rowVatRate" size="xs" value={vatRate} onChange={(e) => setVatRate(e.target.value)}>
              <option value="">— Ingen —</option>
              {VAT_RATES.map((rate) => (
                <option key={rate} value={String(rate)}>
                  {rate} %
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>

        {article && matchOptions.length > 0 && (
          <Field label="Koppla till inköpsorderrad (valfritt)" htmlFor="rowPoMatch">
            <Select id="rowPoMatch" value={poRowId} onChange={(e) => setPoRowId(e.target.value)}>
              <option value="">— Ingen matchning —</option>
              {matchOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.orderNumber} · {formatMoney(o.unitPrice)} {o.currency}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <FormActions>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Lägger till…" : "Lägg till rad"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}

function signed(value: string): string {
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${formatMoney(value)}`;
}
