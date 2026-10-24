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
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import { documentRateSourceText, documentSekAmounts, formatRate, SEK } from "../../lib/currency";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import { useInvoiceRate } from "../../lib/useExchangeRate";
import {
  isVatCode,
  supplierVatCodeNote,
  vatCodeChargesNoVat,
  vatCodeEntry,
  vatCodeOptionLabel,
  vatCodesFor,
  type VatCodeView,
} from "../../lib/vatCodes";
import {
  SUPPLIER_INVOICE_STATUS_PILL,
  type Article,
  type Paged,
  type PriceHistoryEntry,
  type SupplierInvoiceDetail,
  type SupplierInvoicePaymentEntry,
  type SupplierInvoiceRow,
} from "../../lib/types";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow, FormStack } from "../ui/Form";
import buttonStyles from "../ui/Button.module.css";
import { AuditTrailSection } from "../system/AuditTrailSection";
import { PaymentReferenceSection } from "../banking/PaymentReferenceSection";
import { UnderlagSection } from "../documents/UnderlagSection";
import { InvoiceRateField, SekAmountsLine } from "./InvoiceRateField";

export function SupplierInvoiceCard({
  invoice,
  canOpenVerifications,
  vatCodes,
}: {
  invoice: SupplierInvoiceDetail;
  // Momskoder: the company's codes (GET /vat-codes) for the header's and the
  // rows' Momskod selects. Empty when the list could not be read — the
  // invoice's own codes still show.
  vatCodes: VatCodeView[];
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
  // Valuta: an invoice in another currency than SEK carries a rate and is
  // booked in SEK at it. "Riksbanken 2026-10-23. Källa: Sveriges Riksbank".
  const foreign = invoice.currency !== SEK;
  const rateSourceText = documentRateSourceText(invoice.exchangeRateSource, invoice.exchangeRateDate);
  const rateSourceLabel = rateSourceText
    ? invoice.exchangeRateSource === "riksbank"
      ? `${rateSourceText}. Källa: Sveriges Riksbank`
      : rateSourceText
    : null;
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
            {foreign && invoice.openAmountSek !== null && <> ({formatMoney(invoice.openAmountSek)} kr bokfört)</>}
          </span>
        )}
        {foreign && !invoice.exchangeRateMissing && (
          <span>
            Kurs: {formatRate(invoice.exchangeRate)}
            {rateSourceLabel && <> · {rateSourceLabel}</>}
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

      {/* Valuta: a foreign draft saved before rates existed and never given one
          cannot be approved. */}
      {foreign && invoice.exchangeRateMissing && invoice.status !== "cancelled" && (
        <FormNotice style={{ marginBottom: 20 }}>
          Fakturan är i {invoice.currency} men saknar kurs — ange Kurs och spara innan fakturan godkänns.
        </FormNotice>
      )}

      {/* The supplier charges VAT in the header but the code takes none —
          approving would be refused (supplier-invoice-vat-code). */}
      {editable && chargesNoVat(invoice) && Number(invoice.vatAmount) !== 0 && (
        <FormNotice style={{ marginBottom: 20 }}>
          Fakturan har momsbelopp, men momskoden {invoice.vatCode.name} tar ingen debiterad moms (omvänd moms,
          momsfritt eller import). Välj en svensk momskod eller ange momsbelopp 0.
        </FormNotice>
      )}

      {/* The API's own remarks (supplierInvoiceWarnings) — never a refusal. */}
      {invoice.status !== "cancelled" && invoice.warnings.length > 0 && (
        <FormNotice style={{ marginBottom: 20 }}>
          {invoice.warnings.length === 1 ? (
            invoice.warnings[0]
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {invoice.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </FormNotice>
      )}

      {/* Header — editable in draft, read-only otherwise. */}
      {editable ? (
        // Remounted when the saved rate changes (the API looked it up again for
        // a new date or currency), so the Kurs field and its source line show
        // what was stored.
        <HeaderForm
          key={`${invoice.supplierId}|${invoice.exchangeRate}|${invoice.exchangeRateSource}|${invoice.exchangeRateDate}`}
          invoice={invoice}
          vatCodes={vatCodes}
          onSaved={() => router.refresh()}
        />
      ) : (
        <Card maxWidth={520} style={{ marginBottom: 20 }}>
          <FormStack>
            <FormRow>
              <div><strong>Nettobelopp</strong><br />{formatMoney(invoice.netAmount)} {invoice.currency}</div>
              <div><strong>Momsbelopp</strong><br />{formatMoney(invoice.vatAmount)} {invoice.currency}</div>
            </FormRow>
            <div><strong>Bruttobelopp</strong><br />{formatMoney(invoice.grossAmount)} {invoice.currency}</div>
            {foreign && !invoice.exchangeRateMissing && (
              <>
                <FormRow>
                  <div><strong>Nettobelopp i SEK</strong><br />{formatMoney(invoice.sekAmounts.netAmount)} kr</div>
                  <div><strong>Momsbelopp i SEK</strong><br />{formatMoney(invoice.sekAmounts.vatAmount)} kr</div>
                </FormRow>
                <div>
                  <strong>Bruttobelopp i SEK</strong>
                  <br />
                  {formatMoney(invoice.grossAmountSek ?? invoice.sekAmounts.grossAmount)} kr
                </div>
                <FormHint>
                  Fakturan bokfördes i SEK med kursen {formatRate(invoice.exchangeRate)} — leverantörsskulden är
                  bruttobeloppet i SEK.
                </FormHint>
              </>
            )}
            <div><strong>Momskod</strong><br />{invoice.vatCode.name}</div>
            {invoice.note && <div><strong>Notering</strong><br />{invoice.note}</div>}
          </FormStack>
        </Card>
      )}

      <ReverseVatCard invoice={invoice} vatCodes={vatCodes} />

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
            { key: "unitPrice", label: foreign ? `À-pris (${invoice.currency})` : "À-pris", width: "110px", align: "right" },
            { key: "lineAmount", label: foreign ? `Belopp (${invoice.currency})` : "Belopp", width: "120px", align: "right" },
            { key: "vatCode", label: "Momskod", width: "minmax(170px, 1fr)" },
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
              case "vatCode":
                // null = the row follows the invoice's code.
                return row.vatCode ? row.vatCode.name : <span style={{ opacity: 0.7 }}>Följer fakturan</span>;
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
              // Valuta: the SEK each payment cleared of the booked debt.
              ...(foreign ? [{ key: "settledSek", label: "Avräknat i SEK", width: "140px", align: "right" as const }] : []),
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
                  return `${formatMoney(row.appliedAmount)} ${row.currency}`;
                case "writeOffAmount":
                  return Number(row.writeOffAmount) !== 0 ? `${formatMoney(row.writeOffAmount)} ${row.currency}` : "–";
                case "settledSek":
                  return `${formatMoney(Number(row.appliedAmountSek) + Number(row.writeOffAmountSek))} kr`;
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
            vatCodes={vatCodes}
            headerVatCodeName={invoice.vatCode.name}
            supplierName={invoice.supplierName}
            purchaseOrderNumber={invoice.purchaseOrderNumber ?? null}
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

// The picker only needs id + label; the invoice carries the supplier's name
// but not its number, so the initial value is shown by name alone.
type SupplierOption = { id: string; name: string; supplierNumber?: string };

function HeaderForm({
  invoice,
  vatCodes,
  onSaved,
}: {
  invoice: SupplierInvoiceDetail;
  vatCodes: VatCodeView[];
  onSaved: () => void;
}) {
  const [supplier, setSupplier] = useState<SupplierOption | null>({ id: invoice.supplierId, name: invoice.supplierName });
  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoiceNumber);
  const [invoiceDate, setInvoiceDate] = useState(invoice.invoiceDate);
  const [dueDate, setDueDate] = useState(invoice.dueDate ?? "");
  const [netAmount, setNetAmount] = useState(invoice.netAmount);
  const [vatAmount, setVatAmount] = useState(invoice.vatAmount);
  const [grossAmount, setGrossAmount] = useState(invoice.grossAmount);
  const [vatCodeId, setVatCodeId] = useState(invoice.vatCodeId);
  // What the picked code means for the VAT (omvänd moms, momsfritt, varor
  // utanför EU); null for a code with a rate.
  const pickedCode =
    vatCodes.find((code) => code.id === vatCodeId)?.code ??
    (vatCodeId === invoice.vatCodeId ? invoice.vatCode.code : undefined);
  const pickedNote = pickedCode !== undefined && isVatCode(pickedCode) ? supplierVatCodeNote(pickedCode) : null;
  const [note, setNote] = useState(invoice.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  // Valuta: the Kurs follows the lookup for the Fakturadatum until it is typed
  // in — a changed date looks it up again, but not over a rate that was typed
  // on the invoice earlier (source manual: the API leaves it alone on a date
  // change too). A foreign draft that never got a rate is looked up at once.
  // An untouched rate is not sent: the API does the same lookup on save and
  // records where the rate came from.
  const foreign = invoice.currency !== SEK;
  const invoiceRate = useInvoiceRate({
    currency: foreign ? invoice.currency : null,
    date: invoiceDate,
    lookupEnabled:
      foreign && (invoice.exchangeRateMissing || (invoiceDate !== invoice.invoiceDate && invoice.exchangeRateSource !== "manual")),
    initial: {
      rate: invoice.exchangeRateMissing ? "" : String(Number(invoice.exchangeRate)),
      source: invoice.exchangeRateSource,
      date: invoice.exchangeRateDate,
    },
  });
  const rateNumber = Number(invoiceRate.rate.replace(",", "."));
  const sekPreview =
    foreign && Number.isFinite(rateNumber) && rateNumber > 0
      ? documentSekAmounts({ rate: rateNumber, grossAmount: Number(grossAmount) || 0, vatAmount: Number(vatAmount) || 0, rows: [] })
      : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!supplier) {
      setError("Välj leverantören som fakturan ska betalas till");
      return;
    }
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/v1/supplier-invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          // Only sent when changed, so an ordinary save never logs a change.
          supplierId: supplier.id !== invoice.supplierId ? supplier.id : undefined,
          invoiceNumber,
          invoiceDate,
          dueDate: dueDate.trim() || null,
          netAmount: Number(netAmount),
          vatAmount: Number(vatAmount),
          grossAmount: Number(grossAmount),
          // Only sent when changed (the stored code may even be inactive now).
          vatCodeId: vatCodeId !== invoice.vatCodeId ? vatCodeId : undefined,
          // A rate typed in — or the looked-up one for a draft that had none
          // (the API only looks up again when the date or currency changes).
          exchangeRate:
            foreign &&
            supplier.id === invoice.supplierId &&
            invoiceRate.rate.trim() !== "" &&
            (invoiceRate.touched || invoice.exchangeRateMissing)
              ? rateNumber
              : undefined,
          note: note.trim() || null,
        }),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara fakturan"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth={520} style={{ marginBottom: 20 }}>
      <Form onSubmit={save}>
        <FormError>{error}</FormError>
        <Field label="Leverantör (betalas till)" htmlFor="hdrSupplier">
          <SearchPicker<SupplierOption>
            id="hdrSupplier"
            endpoint="/api/v1/suppliers"
            value={supplier}
            onChange={setSupplier}
            formatLabel={(s) => (s.supplierNumber ? `${s.supplierNumber} — ${s.name}` : s.name)}
            placeholder="Sök leverantörnummer eller namn…"
            emptyText="Inga leverantörer matchar sökningen"
          />
        </Field>
        {supplier && supplier.id !== invoice.supplierId && (
          <FormNotice>
            Fakturans valuta följer den nya leverantörens när du sparar, och kursen hämtas på nytt för fakturadatumet.
          </FormNotice>
        )}
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
          <Field label={`Nettobelopp${foreign ? ` (${invoice.currency})` : ""}`} htmlFor="hdrNet">
            <Input id="hdrNet" type="number" step="0.01" size="sm" value={netAmount} onChange={(e) => setNetAmount(e.target.value)} />
          </Field>
        </FormRow>
        {foreign && <InvoiceRateField id="hdrRate" currency={invoice.currency} invoiceRate={invoiceRate} />}
        <FormRow>
          <Field label={`Momsbelopp${foreign ? ` (${invoice.currency})` : ""}`} htmlFor="hdrVat">
            <Input id="hdrVat" type="number" step="0.01" size="sm" value={vatAmount} onChange={(e) => setVatAmount(e.target.value)} />
          </Field>
          <Field label={`Bruttobelopp${foreign ? ` (${invoice.currency})` : ""}`} htmlFor="hdrGross">
            <Input id="hdrGross" type="number" step="0.01" size="sm" value={grossAmount} onChange={(e) => setGrossAmount(e.target.value)} />
          </Field>
        </FormRow>
        {sekPreview && <SekAmountsLine amounts={sekPreview} label="I SEK vid godkännande" />}
        <Field label="Momskod" htmlFor="hdrVatCode">
          <Select id="hdrVatCode" value={vatCodeId} onChange={(e) => setVatCodeId(e.target.value)}>
            {vatCodesFor(vatCodes, "purchase", invoice.vatCodeId).map((code) => (
              <option key={code.id} value={code.id}>
                {vatCodeOptionLabel(code)}
              </option>
            ))}
            {/* The list could not be read — keep the invoice's own code. */}
            {!vatCodes.some((code) => code.id === invoice.vatCodeId) && (
              <option value={invoice.vatCodeId}>{invoice.vatCode.name}</option>
            )}
          </Select>
          <FormHint>
            Gäller alla rader utan egen momskod.
            {pickedNote ? ` Med den här momskoden ska Momsbelopp vara 0. ${pickedNote}` : ""}
          </FormHint>
        </Field>
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
// article (IO-matchning). The candidates are the invoice supplier's orders
// plus the invoice's own purchase order, which may be another supplier's
// when the invoice is paid to someone else. The API validates the match.
function AddRowForm({
  invoiceId,
  vatCodes,
  headerVatCodeName,
  supplierName,
  purchaseOrderNumber,
  onDone,
}: {
  invoiceId: string;
  vatCodes: VatCodeView[];
  headerVatCodeName: string;
  supplierName: string;
  purchaseOrderNumber: string | null;
  onDone: () => void;
}) {
  const [description, setDescription] = useState("");
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  // "" = the row follows the invoice's Momskod.
  const [vatCodeId, setVatCodeId] = useState("");
  const [poRowId, setPoRowId] = useState("");
  const [matchOptions, setMatchOptions] = useState<PriceHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Picking an article offers its purchase-order rows as match candidates (price-history rows carry the PO row id).
  async function handleArticleChange(next: Article | null) {
    setArticle(next);
    setPoRowId("");
    setMatchOptions([]);
    if (!next) return;
    try {
      const history = await apiFetch<Paged<PriceHistoryEntry>>(
        `/api/v1/price-history?articleId=${next.id}&limit=100`
      );
      setMatchOptions(
        history.rows.filter((r) => r.supplierName === supplierName || r.orderNumber === purchaseOrderNumber)
      );
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
          vatCodeId: vatCodeId || undefined,
          purchaseOrderRowId: poRowId || undefined,
        }),
      });
      setDescription("");
      setArticle(null);
      setQuantity("1");
      setUnitPrice("");
      setVatCodeId("");
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
        </FormRow>

        <Field label="Momskod" htmlFor="rowVatCode">
          <Select id="rowVatCode" value={vatCodeId} onChange={(e) => setVatCodeId(e.target.value)}>
            <option value="">Följer fakturan ({headerVatCodeName})</option>
            {vatCodesFor(vatCodes, "purchase").map((code) => (
              <option key={code.id} value={code.id}>
                {vatCodeOptionLabel(code)}
              </option>
            ))}
          </Select>
        </Field>

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

// True when the invoice's Momskod takes no VAT charged by the supplier —
// omvänd moms, momsfritt, goods from outside the EU, importmoms.
function chargesNoVat(invoice: SupplierInvoiceDetail): boolean {
  return isVatCode(invoice.vatCode.code) && vatCodeChargesNoVat(invoice.vatCode.code);
}

// Beräknad moms (omvänd): what approving books as both utgående and ingående
// moms per omvänd momskod — the invoice's own preview (reverseVatPreview, the
// function the poster books with), never calculated here.
function ReverseVatCard({ invoice, vatCodes }: { invoice: SupplierInvoiceDetail; vatCodes: VatCodeView[] }) {
  if (invoice.reverseVat.length === 0) return null;
  const total = invoice.reverseVat.reduce((sum, line) => sum + line.vat, 0);
  // Valuta: the base and the VAT are in SEK — the invoice's net at its rate,
  // exactly as the poster books them.
  const nameOf = (code: string) =>
    vatCodes.find((candidate) => candidate.code === code)?.name ?? (isVatCode(code) ? vatCodeEntry(code).label : code);
  return (
    <div style={{ marginBottom: 20 }}>
      <SectionHeading spaced>Beräknad moms (omvänd)</SectionHeading>
      <Table<SupplierInvoiceDetail["reverseVat"][number] & { id: string }>
        columns={[
          { key: "code", label: "Momskod", width: "minmax(220px, 1.6fr)" },
          { key: "base", label: "Underlag", width: "140px", align: "right" },
          { key: "vat", label: "Moms", width: "140px", align: "right" },
        ]}
        rows={invoice.reverseVat.map((line) => ({ ...line, id: line.code }))}
        footer={{
          code: <strong>Summa</strong>,
          vat: <strong>{formatMoney(total)} {SEK}</strong>,
        }}
        renderCell={(line, key) => {
          switch (key) {
            case "code":
              return `${line.code} · ${nameOf(line.code)}`;
            case "base":
              return `${formatMoney(line.base)} ${SEK}`;
            case "vat":
              return `${formatMoney(line.vat)} ${SEK}`;
            default:
              return null;
          }
        }}
      />
      <FormHint>
        Leverantören har inte debiterat någon moms. Nav beräknar den och bokför den som både utgående och ingående moms
        när fakturan godkänns — bruttobeloppet är det som ska betalas.
        {invoice.currency !== SEK &&
          ` Underlaget och momsen är i SEK: fakturans netto i ${invoice.currency} omräknat med kursen ${formatRate(invoice.exchangeRate)}.`}
      </FormHint>
    </div>
  );
}

function signed(value: string): string {
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${formatMoney(value)}`;
}
