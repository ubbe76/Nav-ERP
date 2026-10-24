"use client";

import { ConfigurationLines } from "../configurator/ConfigurationLines";
import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { SectionHeading } from "../ui/SectionHeading";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { Modal } from "../ui/Modal";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { toBasePrice, toBaseQuantity, toUnitPrice, toUnitQuantity } from "../../lib/units";
import {
  buyerVatNumberProblemText,
  salesRowIsGoods,
  salesVatCode,
  vatCodeOptionLabel,
  vatCodesFor,
  type SalesVatCustomer,
  type VatCodeView,
} from "../../lib/vatCodes";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  INVOICE_STATUS_PILL,
  INVOICE_TYPE_LABELS,
  type Article,
  type InvoiceDetail,
  type InvoicePaymentEntry,
  type InvoiceReminderEntry,
  type InvoiceRow,
  type RegisterEntry,
} from "../../lib/types";
import { Card } from "../ui/Card";
import { GatedLink } from "../ui/GatedLink";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow, FormStack } from "../ui/Form";
import buttonStyles from "../ui/Button.module.css";
import fieldStyles from "../ui/Field.module.css";

export function InvoiceCard({
  invoice,
  paymentTerms,
  creditedInvoiceNumber,
  canOpenVerifications,
  reminderDefaultTo,
  reminderFee,
  vatCodes,
  customerVat,
}: {
  invoice: InvoiceDetail;
  paymentTerms: RegisterEntry[];
  // The source invoice's own FA number for a credit note's "Krediterar
  // faktura FA-…" link — resolved server-side (the detail response only
  // carries the source's id, not its number). Null while it's still loading
  // or couldn't be fetched.
  creditedInvoiceNumber: string | null;
  // The whole /verifications surface (and the page behind the Verifikat
  // link) is admin-only in the API, so the link is only rendered for admins
  // — resolved server-side in page.tsx.
  canOpenVerifications: boolean;
  // Betalningspåminnelse (B3): the reminder dialog's prefilled "Mottagare"
  // (customer invoiceEmail ?? email, resolved server-side in page.tsx) and
  // the påminnelseavgift shown in its checkbox label (System → Inställningar
  // → Konteringsregler → Kundreskontra → Påminnelseavgift).
  reminderDefaultTo: string;
  reminderFee: number;
  // Momskoder: the company's codes (GET /vat-codes) for the rows' Momskod
  // select, and the customer's VAT facts so a row that has no code of its own
  // yet can show the one it will get (salesVatCode — the server derives the
  // same). null when the customer could not be read.
  vatCodes: VatCodeView[];
  customerVat: SalesVatCustomer | null;
}) {
  const router = useRouter();
  const pill = INVOICE_STATUS_PILL[invoice.status];
  // Header and rows are only editable in Utkast.
  const editable = invoice.status === "draft";
  const isCredit = invoice.type === "credit";
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editUnitPrice, setEditUnitPrice] = useState("");
  const [editVatCodeId, setEditVatCodeId] = useState("");
  const [editDeliveryDate, setEditDeliveryDate] = useState("");
  const [reminderOpen, setReminderOpen] = useState(false);

  const netAmount = invoice.rows.reduce((sum, r) => sum + Number(r.lineAmount), 0);
  const vatAmount = invoice.rows.reduce((sum, r) => sum + Number(r.vatAmount), 0);
  const grossAmount = netAmount + vatAmount;
  // A statutory påminnelseavgift may only ever be charged once per invoice
  // (invoice_reminders_one_fee) — mirrors invoice.service.ts's own
  // context.chargedFee > 0 check, derived client-side from the same history
  // the card already renders instead of a second round trip.
  const feeAlreadyCharged = invoice.reminders.some((r) => Number(r.fee) > 0);

  async function statusAction(action: "issue" | "cancel") {
    if (action === "issue" && !(await confirmDialog("Fakturan får nummer och låses. Fortsätta?"))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/invoices/${invoice.id}/${action}`, { method: "POST" });
      router.refresh();
    } catch (err) {
      // vat-number-required (409) carries its own sentence per reason — which
      // number is missing or in the wrong form — and apiErrorMessage keeps it.
      setError(apiErrorMessage(err, "Åtgärden misslyckades"));
    } finally {
      setPending(false);
    }
  }

  // Raises a draft credit note against this (issued/paid) invoice, prefilled
  // as a positive mirror of every row, then jumps straight to the new draft
  // so the user can trim it down before issuing.
  async function createCredit() {
    if (!(await confirmDialog("Skapa en kreditfaktura mot denna faktura?"))) return;
    setError(null);
    setPending(true);
    try {
      const credit = await apiFetch<InvoiceDetail>(`/api/v1/invoices/${invoice.id}/credit`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      router.push(`/forsaljning/fakturor/${credit.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa kreditfakturan");
      setPending(false);
    }
  }

  function startEditRow(row: InvoiceRow) {
    setEditingRowId(row.id);
    // Quantity/unitPrice are stored in the article's base unit — shown (and
    // edited) in the row's own display unit, same as the sales order card.
    setEditQuantity(String(toUnitQuantity(Number(row.quantity), row.unitFactor)));
    setEditUnitPrice(String(toUnitPrice(Number(row.unitPrice), row.unitFactor)));
    setEditVatCodeId(row.vatCodeId);
    setEditDeliveryDate(row.deliveryDate ?? "");
  }

  async function saveRow(row: InvoiceRow) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/invoices/${invoice.id}/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          // Convert back from the display unit to the stored base unit.
          quantity: toBaseQuantity(Number(editQuantity), row.unitFactor),
          unitPrice: toBasePrice(Number(editUnitPrice), row.unitFactor),
          // The momskod decides the VAT — never the bare rate, which would
          // give an EU customer svensk moms.
          vatCodeId: editVatCodeId,
          deliveryDate: editDeliveryDate.trim() || null,
        }),
      });
      setEditingRowId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara raden");
    } finally {
      setPending(false);
    }
  }

  async function removeRow(row: InvoiceRow) {
    if (!(await confirmDelete(`Ta bort raden "${row.description}"?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/invoices/${invoice.id}/rows/${row.id}`, { method: "DELETE" });
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
        <span>{INVOICE_TYPE_LABELS[invoice.type]}</span>
        <span>Kund: <strong>{invoice.customerName}</strong></span>
        {!editable && invoice.invoiceNumber && <span>Fakturanr: <strong>{invoice.invoiceNumber}</strong></span>}
        {invoice.invoiceDate && <span>Fakturadatum: {invoice.invoiceDate}</span>}
        {!editable && invoice.ocrNumber && <span>OCR-nummer: {invoice.ocrNumber}</span>}
        {!editable && invoice.dueDate && <span>Förfallodatum: {invoice.dueDate}</span>}
        {invoice.buyerVatNumber && <span>Köparens momsnr: {invoice.buyerVatNumber}</span>}
        {/* openAmount is meaningless for draft/cancelled (see InvoiceDetail's
            own comment) — issued/paid only, same gate as the FA-number/OCR/
            due-date fields above. */}
        {(invoice.status === "issued" || invoice.status === "paid") && (
          <span>
            Öppet belopp: {formatMoney(invoice.openAmount)} {invoice.currency}
          </span>
        )}
        {isCredit && invoice.creditedInvoiceId && (
          <span>
            Krediterar faktura{" "}
            <Link href={`/forsaljning/fakturor/${invoice.creditedInvoiceId}`}>
              {creditedInvoiceNumber ?? "–"}
            </Link>
          </span>
        )}
        {invoice.creditedBy.length > 0 && (
          <span>
            Krediterad av{" "}
            {invoice.creditedBy.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ", "}
                <Link href={`/forsaljning/fakturor/${c.id}`}>{c.invoiceNumber ?? "Utkast"}</Link>
              </span>
            ))}
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

      {/* Utfärda refuses an EU sale / omvänd betalningsskyldighet without the
          buyer's momsregistreringsnummer in the right form — warned about
          here, ahead of the click. */}
      {editable && invoice.vatNumberProblem && (
        <FormNotice style={{ marginBottom: 20 }}>
          {buyerVatNumberProblemText(invoice.vatNumberProblem)}{" "}
          <GatedLink href={`/kunder/${invoice.customerId}`}>Öppna kundkortet</GatedLink> och ange momsnumret under
          Villkor &amp; frakt.
        </FormNotice>
      )}

      {/* Header — editable in draft, read-only otherwise (snapshot address once issued). */}
      {editable ? (
        <HeaderForm invoice={invoice} paymentTerms={paymentTerms} onSaved={() => router.refresh()} />
      ) : (
        <Card maxWidth={520} style={{ marginBottom: 20 }}>
          <FormStack>
            <FormRow>
              <div>
                <strong>Fakturaadress</strong>
                <br />
                {invoice.customerName}
                <br />
                <span style={{ whiteSpace: "pre-line" }}>{invoice.invoiceAddress}</span>
                <br />
                {[invoice.invoicePostalCode, invoice.invoiceCity].filter(Boolean).join(" ")}
              </div>
              <div>
                <strong>Betalningsvillkor</strong>
                <br />
                {invoice.paymentTermName ?? "–"}
              </div>
            </FormRow>
            {invoice.note && (
              <div>
                <strong>Notering</strong>
                <br />
                {invoice.note}
              </div>
            )}
          </FormStack>
        </Card>
      )}

      <SectionHeading spaced>Rader</SectionHeading>
      {invoice.rows.length > 0 ? (
        <Table<InvoiceRow>
          columns={[
            { key: "description", label: "Beskrivning", width: "1.4fr" },
            { key: "articleNumber", label: "Artikel", width: "1fr" },
            { key: "quantity", label: "Antal", width: "90px", align: "right" },
            { key: "unitCode", label: "Enhet", width: "70px" },
            { key: "unitPrice", label: "À-pris", width: "110px", align: "right" },
            { key: "vatCode", label: "Momskod", width: "minmax(190px, 1fr)" },
            { key: "lineAmount", label: "Belopp", width: "120px", align: "right" },
            { key: "deliveryDate", label: "Leveransdatum", width: "140px" },
            { key: "salesOrderNumber", label: "Order", width: "110px" },
            ...(editable ? ([{ key: "id", label: "", width: "160px", align: "right" }] as const) : []),
          ]}
          rows={invoice.rows}
          renderCell={(row, key) => {
            const isEditing = editingRowId === row.id;
            switch (key) {
              case "description":
                return row.shipmentId ? (
                  <>
                    {row.description}
                    <ConfigurationLines configuration={row.configuration} />
                    <div>
                      Försändelse{" "}
                      <GatedLink href={`/forsaljning/forsandelser/${row.shipmentId}`}>
                        {row.shipmentNumber ?? "Visa"}
                      </GatedLink>
                    </div>
                  </>
                ) : (
                  <>
                    {row.description}
                    <ConfigurationLines configuration={row.configuration} />
                  </>
                );
              case "articleNumber":
                return row.articleNumber ? `${row.articleNumber} — ${row.articleName}` : "–";
              case "quantity":
                return isEditing && !row.shipmentId ? (
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    size="sm"
                    aria-label="Antal"
                    value={editQuantity}
                    onChange={(e) => setEditQuantity(e.target.value)}
                  />
                ) : (
                  toUnitQuantity(Number(row.quantity), row.unitFactor)
                );
              case "unitCode":
                return row.unitCode ?? "–";
              case "unitPrice":
                return isEditing ? (
                  <Input
                    type="number"
                    step="0.01"
                    size="sm"
                    aria-label="À-pris"
                    value={editUnitPrice}
                    onChange={(e) => setEditUnitPrice(e.target.value)}
                  />
                ) : (
                  formatMoney(toUnitPrice(Number(row.unitPrice), row.unitFactor))
                );
              case "vatCode":
                return isEditing ? (
                  <Select
                    aria-label="Momskod"
                    value={editVatCodeId}
                    onChange={(e) => setEditVatCodeId(e.target.value)}
                  >
                    {vatCodesFor(vatCodes, "sales", row.vatCodeId).map((code) => (
                      <option key={code.id} value={code.id}>
                        {vatCodeOptionLabel(code)}
                      </option>
                    ))}
                    {/* The list could not be read — keep the row's own code. */}
                    {!vatCodes.some((code) => code.id === row.vatCodeId) && (
                      <option value={row.vatCodeId}>{row.vatCode.name}</option>
                    )}
                  </Select>
                ) : (
                  row.vatCode.name
                );
              case "deliveryDate":
                return isEditing ? (
                  <Input
                    type="date"
                    size="sm"
                    aria-label="Leveransdatum"
                    value={editDeliveryDate}
                    onChange={(e) => setEditDeliveryDate(e.target.value)}
                  />
                ) : (
                  (row.deliveryDate ?? "–")
                );
              case "lineAmount":
                return formatMoney(row.lineAmount);
              case "salesOrderNumber":
                return row.salesOrderNumber ?? "–";
              case "id":
                if (!editable) return null;
                return isEditing ? (
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Button type="button" size="small" variant="primary" disabled={pending} onClick={() => saveRow(row)}>
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
                    <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => removeRow(row)}>
                      Ta bort
                    </Button>
                  </span>
                );
              default:
                return row[key as keyof InvoiceRow] as string;
            }
          }}
        />
      ) : (
        <p>Inga rader tillagda än.</p>
      )}

      <div style={{ display: "flex", gap: 24, marginTop: 12, flexWrap: "wrap" }}>
        <span>Nettobelopp: {formatMoney(netAmount)} {invoice.currency}</span>
        <span>Momsbelopp: {formatMoney(vatAmount)} {invoice.currency}</span>
        <span><strong>Bruttobelopp: {formatMoney(grossAmount)} {invoice.currency}</strong></span>
      </div>

      {invoice.payments.length > 0 && (
        <>
          <SectionHeading spaced>Betalningar</SectionHeading>
          <Table<InvoicePaymentEntry & { id: string }>
            columns={[
              { key: "paymentDate", label: "Datum", width: "130px" },
              { key: "paymentNumber", label: "Betalning", width: "160px" },
              { key: "appliedAmount", label: "Belopp", width: "130px", align: "right" },
              { key: "writeOffAmount", label: "Avskrivning", width: "140px", align: "right" },
              { key: "verificationId", label: "Verifikat", width: "130px" },
            ]}
            // Table requires a plain `id` — the wire shape only has
            // paymentId (see InvoicePaymentEntry's own comment).
            rows={invoice.payments.map((p) => ({ ...p, id: p.paymentId }))}
            renderCell={(row, key) => {
              switch (key) {
                case "paymentDate":
                  return row.paymentDate;
                case "paymentNumber":
                  return (
                    <Link href={`/forsaljning/betalningar/${row.paymentId}`}>
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

      {invoice.reminders.length > 0 && (
        <>
          <SectionHeading spaced>Påminnelser</SectionHeading>
          <Table<InvoiceReminderEntry>
            columns={[
              { key: "level", label: "Nivå", width: "80px" },
              { key: "sentAt", label: "Datum", width: "160px" },
              { key: "fee", label: "Avgift", width: "130px", align: "right" },
              { key: "feeVerificationId", label: "Verifikat", width: "130px" },
              { key: "documentId", label: "Dokument", width: "150px" },
            ]}
            rows={invoice.reminders}
            renderCell={(row, key) => {
              switch (key) {
                case "level":
                  return row.level;
                case "sentAt":
                  return new Date(row.sentAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
                case "fee":
                  return Number(row.fee) > 0 ? `${formatMoney(row.fee)} ${invoice.currency}` : "–";
                case "feeVerificationId":
                  if (row.feeVerificationId === null) return "–";
                  return canOpenVerifications ? (
                    <Link href={`/ekonomi/verifikat/${row.feeVerificationId}`}>
                      {row.feeVerificationDisplayNumber ?? "–"}
                    </Link>
                  ) : (
                    "–"
                  );
                case "documentId":
                  // The påminnelse exactly as it was sent (archived copy).
                  return row.documentId ? (
                    <a href={`/api/v1/invoices/${invoice.id}/reminders/${row.id}/pdf`} target="_blank" rel="noreferrer">
                      Påminnelse (PDF)
                    </a>
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
            customerVat={customerVat}
            onDone={() => router.refresh()}
          />
        )}

        <Card maxWidth={320}>
          <FormStack>
            <strong>Åtgärder</strong>
            {invoice.status === "draft" && (
              <Button type="button" variant="primary" disabled={pending} onClick={() => statusAction("issue")}>
                Utfärda
              </Button>
            )}
            {/* "Markera som betald" no longer exists (B3) — betald is set by
                registering a payment against the open amount instead. */}
            {invoice.status === "issued" && invoice.openAmount !== 0 && (
              <Link
                href={`/forsaljning/betalningar?invoice=${invoice.id}`}
                className={`${buttonStyles.button} ${buttonStyles.primary}`}
              >
                Registrera betalning
              </Link>
            )}
            {invoice.status === "issued" && invoice.openAmount > 0 && (
              <Button type="button" variant="secondary" disabled={pending} onClick={() => setReminderOpen(true)}>
                Skicka påminnelse
              </Button>
            )}
            {invoice.status === "draft" && (
              <Button type="button" variant="danger" disabled={pending} onClick={() => statusAction("cancel")}>
                Avbryt
              </Button>
            )}
            {/* A credit note may only be raised against an issued/paid ORIGINAL
                invoice — never against another credit note (no credit-of-credit,
                mirrors NotCreditableError in invoice.service.ts). */}
            {(invoice.status === "issued" || invoice.status === "paid") && !isCredit && (
              <Button type="button" variant="secondary" disabled={pending} onClick={createCredit}>
                Skapa kreditfaktura
              </Button>
            )}
            {(invoice.status === "paid" || invoice.status === "cancelled") && <span>Inga fler åtgärder tillgängliga.</span>}
          </FormStack>
        </Card>
      </div>

      {reminderOpen && (
        <ReminderDialog
          invoice={invoice}
          defaultTo={reminderDefaultTo}
          reminderFee={reminderFee}
          feeAlreadyCharged={feeAlreadyCharged}
          onClose={() => setReminderOpen(false)}
          onSent={() => {
            setReminderOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// Betalningspåminnelse (B3) — mirrors MailSection's own inline
// SendEmailModal (same Modal/Field/Form idiom), plus the withFee checkbox
// and a live PDF preview link that reflects the checkbox's current state.
function ReminderDialog({
  invoice,
  defaultTo,
  reminderFee,
  feeAlreadyCharged,
  onClose,
  onSent,
}: {
  invoice: InvoiceDetail;
  defaultTo: string;
  reminderFee: number;
  feeAlreadyCharged: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(`Betalningspåminnelse faktura ${invoice.invoiceNumber}`);
  const [message, setMessage] = useState(
    `Hej!\n\nVi har tyvärr ännu inte mottagit betalning för faktura ${invoice.invoiceNumber}. Se bifogad påminnelse.\n\nMed vänliga hälsningar`
  );
  // Never pre-checked — the fee is an explicit choice every time (mirrors
  // sendReminderSchema's own withFee default(false) in packages/shared),
  // and impossible to check at all once the statutory one-time fee is spent.
  const [withFee, setWithFee] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/invoices/${invoice.id}/reminders`, {
        method: "POST",
        body: JSON.stringify({ to, subject, message, withFee }),
      });
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Påminnelsen kunde inte skickas");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Skicka betalningspåminnelse för faktura ${invoice.invoiceNumber}`}>
      <Form onSubmit={submit}>
        <FormError>{error}</FormError>

        <Field label="Mottagare" htmlFor="remTo">
          <Input id="remTo" type="email" required value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>

        <Field label="Ämne" htmlFor="remSubject">
          <Input id="remSubject" required maxLength={255} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>

        <Field label="Meddelande" htmlFor="remMessage">
          <textarea
            id="remMessage"
            className={fieldStyles.input}
            rows={6}
            maxLength={5000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            style={{ resize: "vertical", fontFamily: "inherit" }}
          />
        </Field>

        <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>Påminnelsen bifogas som PDF.</p>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input
            type="checkbox"
            checked={withFee}
            disabled={feeAlreadyCharged}
            onChange={(e) => setWithFee(e.target.checked)}
          />
          Lägg till påminnelseavgift ({formatMoney(reminderFee)} kr)
        </label>
        {feeAlreadyCharged && (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>Avgift redan tillagd</p>
        )}

        {/* A snapshot at the moment it's opened — a later part-payment
            without a fresh preview does not change an already-printed PDF
            (same idiom as the öppna-poster-sidans egen kommentar om detta). */}
        <a
          href={`/api/v1/invoices/${invoice.id}/reminder-pdf?withFee=${withFee ? "true" : "false"}`}
          target="_blank"
          rel="noreferrer"
          className={`${buttonStyles.button} ${buttonStyles.ghost}`}
        >
          Påminnelse (PDF)
        </a>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Skickar…" : "Skicka"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
        </FormActions>
      </Form>
    </Modal>
  );
}

function HeaderForm({
  invoice,
  paymentTerms,
  onSaved,
}: {
  invoice: InvoiceDetail;
  paymentTerms: RegisterEntry[];
  onSaved: () => void;
}) {
  const [paymentTermId, setPaymentTermId] = useState(invoice.paymentTermId ?? "");
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
      await apiFetch(`/api/v1/invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          paymentTermId: paymentTermId || null,
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
        <Field label="Betalningsvillkor" htmlFor="hdrPaymentTerm">
          <Select id="hdrPaymentTerm" value={paymentTermId} onChange={(e) => setPaymentTermId(e.target.value)}>
            <option value="">— Ingen —</option>
            {paymentTerms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </Select>
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

// Adds a line — an article row (ArticlePicker) or a fri rad (no article).
function AddRowForm({
  invoiceId,
  vatCodes,
  customerVat,
  onDone,
}: {
  invoiceId: string;
  vatCodes: VatCodeView[];
  customerVat: SalesVatCustomer | null;
  onDone: () => void;
}) {
  const [description, setDescription] = useState("");
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  // "" = Automatisk: the API derives the code from the customer and the
  // article (salesVatCode) — what the first option names below. Picking one
  // sends that vatCodeId; the bare vatRate is never sent.
  const [vatCodeId, setVatCodeId] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function handleArticleChange(next: Article | null) {
    setArticle(next);
    if (next && !description.trim()) setDescription(`${next.articleNumber} — ${next.name}`);
  }

  // The code Automatisk gives this row: the picked article's rate and type
  // (a free row is goods at 25 %), against the customer's country and
  // momsnummer.
  const automaticCode = customerVat
    ? salesVatCode({
        customer: customerVat,
        isGoods: salesRowIsGoods({ articleId: article?.id ?? null, articleType: article?.type ?? null, freightArticleId: null }),
        articleRate: article ? Number(article.vatRate) : 25,
      })
    : null;
  const automaticName = automaticCode ? vatCodes.find((code) => code.code === automaticCode)?.name : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!description.trim()) {
      setError("Ange en beskrivning");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/invoices/${invoiceId}/rows`, {
        method: "POST",
        body: JSON.stringify({
          description: description.trim(),
          articleId: article?.id ?? undefined,
          quantity: Number(quantity),
          unitPrice: unitPrice.trim() ? Number(unitPrice) : 0,
          vatCodeId: vatCodeId || undefined,
          deliveryDate: deliveryDate.trim() || undefined,
        }),
      });
      setDescription("");
      setArticle(null);
      setQuantity("1");
      setUnitPrice("");
      setVatCodeId("");
      setDeliveryDate("");
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

        <Field label="Artikel (valfritt, fri rad annars)" htmlFor="rowArticle">
          <ArticlePicker id="rowArticle" value={article} onChange={handleArticleChange} />
        </Field>

        <Field label="Beskrivning" htmlFor="rowDescription">
          <Input id="rowDescription" required maxLength={255} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <FormRow>
          <Field label="Antal" htmlFor="rowQuantity">
            <Input id="rowQuantity" type="number" min="0" step="any" size="sm" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="À-pris" htmlFor="rowUnitPrice">
            <Input id="rowUnitPrice" type="number" step="0.01" size="sm" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Momskod" htmlFor="rowVatCode">
            <Select id="rowVatCode" value={vatCodeId} onChange={(e) => setVatCodeId(e.target.value)}>
              <option value="">{automaticName ? `Automatisk — ${automaticName}` : "Automatisk"}</option>
              {vatCodesFor(vatCodes, "sales").map((code) => (
                <option key={code.id} value={code.id}>
                  {vatCodeOptionLabel(code)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Leveransdatum (valfritt)" htmlFor="rowDeliveryDate">
            <Input id="rowDeliveryDate" type="date" size="sm" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
          </Field>
        </FormRow>
        <FormHint>
          Automatisk väljer momskod efter kundens land, momsnummer och artikeln. Leveransdatumet skrivs ut på fakturan
          när det skiljer sig från fakturadatumet.
        </FormHint>

        <FormActions>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Lägger till…" : "Lägg till rad"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}
