"use client";

import { ConfigurationLines } from "../configurator/ConfigurationLines";
import { VerificationRef } from "../economy/VerificationRef";
import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { openDocument } from "../../lib/tabNavigation";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { SectionHeading } from "../ui/SectionHeading";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { Modal } from "../ui/Modal";
import { CostCenterSelect, NO_OBJECT, ProjectSelect } from "../economy/DimensionSelect";
import { dimensionText, useDimensions } from "../../lib/dimensions";
import { apiFetch } from "../../lib/api";
import { isEInvoiceAutoSendProblem, type EInvoiceAutoSendOutcome } from "../../lib/einvoice";
import { formatMoney, formatUnitPrice } from "../../lib/format";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import { formatRate, SEK } from "../../lib/currency";
import { SekAmountsLine } from "../purchase/InvoiceRateField";
import { toBasePrice, toBaseQuantity, toUnitPrice, toUnitQuantity } from "../../lib/units";
import {
  buyerVatNumberProblemText,
  buyerVatNumberWarningText,
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
  type InvoiceLateInterestCharge,
  type InvoiceReminderEntry,
  type InvoiceRow,
  type RegisterEntry,
} from "../../lib/types";
import { Card } from "../ui/Card";
import { DocumentActionBar } from "../documents/DocumentActionBar";
import { GatedLink } from "../ui/GatedLink";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow, FormStack } from "../ui/Form";
import { mailAmount } from "../../lib/mailText";
import { useMailText } from "../mail/useMailText";
import { MailSignatureNote } from "../mail/MailSignatureNote";
import { documentLanguageOf } from "../../lib/documentLanguage";
import buttonStyles from "../ui/Button.module.css";
import fieldStyles from "../ui/Field.module.css";
import { formatStockholmDateTime } from "../../lib/date";

// A cancelled (makulerad) payment reads as struck through, like an undone
// receipt or report elsewhere — the Makulerad pill alone is just another colour.
const CANCELLED_TEXT = { color: "var(--color-text-muted)", textDecoration: "line-through" } as const;

type InvoiceHeaderValues = { paymentTermId: string; note: string; rate: string };

function invoiceHeaderOf(invoice: InvoiceDetail): InvoiceHeaderValues {
  return {
    paymentTermId: invoice.paymentTermId ?? "",
    note: invoice.note ?? "",
    // "" = automatic: the invoice date's rate is fetched at Utfärda.
    rate: invoice.exchangeRateManual && invoice.exchangeRate !== null ? String(Number(invoice.exchangeRate)) : "",
  };
}

type RowEditValues = {
  quantity: string;
  unitPrice: string;
  vatCodeId: string;
  deliveryDate: string;
  costCenterId: string;
  projectId: string;
};

export function InvoiceCard({
  invoice,
  paymentTerms,
  creditedInvoiceNumber,
  canOpenVerifications,
  reminderDefaultTo,
  reminderFee,
  vatCodes,
  customerVat,
  customerOnHold = false,
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
  // Faktura i vänteläge on the customer card: a draft should be reviewed
  // before it is issued by hand.
  customerOnHold?: boolean;
}) {
  const router = useRouter();
  const pill = INVOICE_STATUS_PILL[invoice.status];
  // Header and rows are only editable in Utkast.
  const editable = invoice.status === "draft";
  const isCredit = invoice.type === "credit";
  // Valuta: an invoice in another currency than SEK carries a rate (SEK per 1
  // unit) and is booked in SEK — the SEK figures below are what was/will be
  // booked.
  const foreign = invoice.currency !== SEK;
  const [error, setError] = useState<string | null>(null);
  // Row Spara/Ta bort errors are shown under the row table, next to the
  // buttons (the action bar's error sits at the top of the card).
  const [rowError, setRowError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The header (Betalningsvillkor, Notering, Kurs) is state of the card so
  // Utfärda can save it first — before, Utfärda issued and booked the STORED
  // terms and rate while the form showed others, and only a credit note could
  // undo it (webbgranskningen 2026-11-11).
  const [header, setHeader] = useState<InvoiceHeaderValues>(() => invoiceHeaderOf(invoice));
  const [savedHeader, setSavedHeader] = useState<InvoiceHeaderValues>(() => invoiceHeaderOf(invoice));
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [headerSaved, setHeaderSaved] = useState(false);
  const headerDirty =
    editable &&
    (header.paymentTermId !== savedHeader.paymentTermId ||
      header.note.trim() !== savedHeader.note ||
      header.rate.trim() !== savedHeader.rate);
  // A row in Ändra with changes, or a filled-in row not yet added: Utfärda
  // waits for them (the issue would leave them out).
  const [addRowFilled, setAddRowFilled] = useState(false);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState<RowEditValues | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editUnitPrice, setEditUnitPrice] = useState("");
  const [editVatCodeId, setEditVatCodeId] = useState("");
  const [editDeliveryDate, setEditDeliveryDate] = useState("");
  const [editCostCenterId, setEditCostCenterId] = useState("");
  const [editProjectId, setEditProjectId] = useState("");
  const dims = useDimensions();
  // The column shows when objects exist or a row already carries one.
  const showObjects =
    dims.allCostCenters.length > 0 || dims.allProjects.length > 0 || invoice.rows.some((r) => r.costCenter || r.project);
  const [reminderOpen, setReminderOpen] = useState(false);
  // Skicka e-faktura automatiskt vid Utfärda: what the issue did with the
  // e-invoice (null = nothing to say).
  const [autoSend, setAutoSend] = useState<EInvoiceAutoSendOutcome | null>(null);

  const editValues: RowEditValues = {
    quantity: editQuantity,
    unitPrice: editUnitPrice,
    vatCodeId: editVatCodeId,
    deliveryDate: editDeliveryDate,
    costCenterId: editCostCenterId,
    projectId: editProjectId,
  };
  const rowEditDirty =
    editable && editingRowId !== null && editStart !== null && JSON.stringify(editValues) !== JSON.stringify(editStart);
  useUnsavedGuard(headerDirty || rowEditDirty || (editable && addRowFilled));
  const issueBlocker = rowEditDirty
    ? "Spara eller avbryt den ändrade raden först."
    : addRowFilled
      ? "Lägg till eller töm raden under tabellen först."
      : null;

  const netAmount = invoice.rows.reduce((sum, r) => sum + Number(r.lineAmount), 0);
  const vatAmount = invoice.rows.reduce((sum, r) => sum + Number(r.vatAmount), 0);
  const grossAmount = netAmount + vatAmount;
  // A statutory påminnelseavgift may only ever be charged once per invoice
  // (invoice_reminders_one_fee) — mirrors invoice.service.ts's own
  // context.chargedFee > 0 check, derived client-side from the same history
  // the card already renders instead of a second round trip.
  const feeAlreadyCharged = invoice.reminders.some((r) => Number(r.fee) > 0);
  // Dröjsmålsränta: an active förseningsersättning already covers a påminnelse-
  // avgift (409 reminder-fee-after-late-fee otherwise).
  const lateInterestCharges = invoice.lateInterestCharges ?? [];
  const lateFeeCharged = lateInterestCharges.some((c) => c.active && Number(c.fee) > 0);

  // PATCH the header; returns the error text, null when saved.
  async function saveHeader(): Promise<string | null> {
    const typedRate = header.rate.trim() === "" ? null : Number(header.rate.replace(",", "."));
    if (foreign && !isCredit && typedRate !== null && !(Number.isFinite(typedRate) && typedRate > 0)) {
      return "Kursen måste vara ett positivt tal";
    }
    setHeaderSaved(false);
    try {
      await apiFetch(`/api/v1/invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          paymentTermId: header.paymentTermId || null,
          note: header.note.trim() || null,
          // null = automatic again (the invoice date's rate at Utfärda).
          ...(foreign && !isCredit ? { exchangeRate: typedRate } : {}),
        }),
      });
      const sent = { paymentTermId: header.paymentTermId, note: header.note.trim(), rate: header.rate.trim() };
      setSavedHeader(sent);
      setHeader(sent);
      setHeaderSaved(true);
      router.refresh();
      return null;
    } catch (err) {
      return apiErrorMessage(err, "Kunde inte spara fakturan");
    }
  }

  async function runSaveHeader() {
    if (pending) return;
    setHeaderError(null);
    setPending(true);
    try {
      setHeaderError(await saveHeader());
    } finally {
      setPending(false);
    }
  }

  async function statusAction(action: "issue" | "cancel") {
    if (action === "issue") {
      if (issueBlocker) return setError(issueBlocker);
      // The rate the issue will use: the one typed in (saved first below),
      // else the invoice date's.
      const manualRate = headerDirty ? header.rate.trim() !== "" : invoice.exchangeRateManual;
      const rateNote =
        foreign && !manualRate && !isCredit ? ` Kursen sätts till fakturadatumets (dagens) kurs för ${invoice.currency}.` : "";
      const saveNote = headerDirty ? " Ändringarna i fakturahuvudet sparas först." : "";
      if (!(await confirmDialog(`Fakturan får nummer och låses.${rateNote}${saveNote} Fortsätta?`))) return;
    } else if (
      !(await confirmDialog("Avbryta fakturautkastet? En avbruten faktura kan inte öppnas igen.", {
        confirmLabel: "Avbryt faktura",
        danger: true,
      }))
    ) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (action === "issue" && headerDirty) {
        const failed = await saveHeader();
        if (failed) return setError(failed);
      }
      const result = await apiFetch<{ einvoiceAutoSend?: EInvoiceAutoSendOutcome | null } | null>(`/api/v1/invoices/${invoice.id}/${action}`, {
        method: "POST",
      });
      if (action === "issue") setAutoSend(result?.einvoiceAutoSend ?? null);
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
      if (openDocument(`/forsaljning/fakturor/${credit.id}`, (href) => router.push(href), "Kreditfaktura")) {
        setPending(false);
        router.refresh();
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa kreditfakturan"));
      setPending(false);
    }
  }

  async function startEditRow(row: InvoiceRow) {
    // Switching rows would drop the first row's changes without a word.
    if (rowEditDirty && !(await confirmDialog("Raden du ändrar har osparade ändringar. Släppa dem?"))) return;
    // Quantity/unitPrice are stored in the article's base unit — shown (and
    // edited) in the row's own display unit, same as the sales order card.
    const start: RowEditValues = {
      quantity: String(toUnitQuantity(Number(row.quantity), row.unitFactor)),
      unitPrice: String(toUnitPrice(Number(row.unitPrice), row.unitFactor)),
      vatCodeId: row.vatCodeId,
      deliveryDate: row.deliveryDate ?? "",
      costCenterId: row.costCenterId ?? row.costCenter?.id ?? "",
      projectId: row.projectId ?? row.project?.id ?? "",
    };
    setRowError(null);
    setEditingRowId(row.id);
    setEditStart(start);
    setEditQuantity(start.quantity);
    setEditUnitPrice(start.unitPrice);
    setEditVatCodeId(start.vatCodeId);
    setEditDeliveryDate(start.deliveryDate);
    setEditCostCenterId(start.costCenterId);
    setEditProjectId(start.projectId);
  }

  function cancelEditRow() {
    setEditingRowId(null);
    setEditStart(null);
    setRowError(null);
  }

  async function saveRow(row: InvoiceRow) {
    if (!editStart) return;
    // Only what was changed: the display-unit round trip is not exact
    // (12 st/förp: 24 st → 2 → 24,0001), so re-sending an untouched quantity
    // or price rewrote it — or gave a linked row 409 over-invoicing — when
    // only the momskod was changed.
    const body: Record<string, unknown> = {};
    // Convert back from the display unit to the stored base unit.
    if (editQuantity !== editStart.quantity) body.quantity = toBaseQuantity(Number(editQuantity), row.unitFactor);
    if (editUnitPrice !== editStart.unitPrice) body.unitPrice = toBasePrice(Number(editUnitPrice), row.unitFactor);
    // The momskod decides the VAT — never the bare rate, which would give an
    // EU customer svensk moms.
    if (editVatCodeId !== editStart.vatCodeId) body.vatCodeId = editVatCodeId;
    if (editDeliveryDate !== editStart.deliveryDate) body.deliveryDate = editDeliveryDate.trim() || null;
    if (editCostCenterId !== editStart.costCenterId) body.costCenterId = editCostCenterId || null;
    if (editProjectId !== editStart.projectId) body.projectId = editProjectId || null;
    if (Object.keys(body).length === 0) return cancelEditRow();
    setRowError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/invoices/${invoice.id}/rows/${row.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setEditingRowId(null);
      setEditStart(null);
      router.refresh();
    } catch (err) {
      setRowError(apiErrorMessage(err, "Kunde inte spara raden"));
    } finally {
      setPending(false);
    }
  }

  async function removeRow(row: InvoiceRow) {
    if (!(await confirmDelete(`Ta bort raden "${row.description}"?`))) return;
    setRowError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/invoices/${invoice.id}/rows/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setRowError(apiErrorMessage(err, "Kunde inte ta bort raden"));
    } finally {
      setPending(false);
    }
  }

  // The toolbar's buttons (Nav som program, punkt 3) — a paid or cancelled
  // invoice has none, and then there is no toolbar.
  const canIssue = invoice.status === "draft";
  // "Markera som betald" no longer exists (B3) — betald is set by registering
  // a payment against the open amount instead.
  const canRegisterPayment = invoice.status === "issued" && invoice.openAmount !== 0;
  const canRemind = invoice.status === "issued" && invoice.openAmount > 0;
  // A credit note may only be raised against an issued/paid ORIGINAL invoice
  // — never against another credit note (no credit-of-credit, mirrors
  // NotCreditableError in invoice.service.ts).
  const canCredit = (invoice.status === "issued" || invoice.status === "paid") && !isCredit;
  const hasActions = canIssue || canRegisterPayment || canRemind || canCredit;

  return (
    <div>
      {hasActions ? (
        <DocumentActionBar label={invoice.invoiceNumber ?? "Utkast"} pill={pill} error={error}>
          {canIssue && (
            <Button
              type="button"
              variant="primary"
              disabled={pending || issueBlocker !== null}
              title={issueBlocker ?? undefined}
              onClick={() => statusAction("issue")}
            >
              Utfärda
            </Button>
          )}
          {canRegisterPayment && (
            <Link
              href={`/forsaljning/betalningar?invoice=${invoice.id}`}
              className={`${buttonStyles.button} ${buttonStyles.primary}`}
            >
              Registrera betalning
            </Link>
          )}
          {canRemind && (
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setReminderOpen(true)}>
              Skicka påminnelse
            </Button>
          )}
          {canCredit && (
            <Button type="button" variant="secondary" disabled={pending} onClick={createCredit}>
              Skapa kreditfaktura
            </Button>
          )}
          {canIssue && (
            <Button type="button" variant="danger" disabled={pending} onClick={() => statusAction("cancel")}>
              Avbryt faktura
            </Button>
          )}
          {canIssue && issueBlocker && <span style={{ alignSelf: "center" }}>{issueBlocker}</span>}
        </DocumentActionBar>
      ) : (
        <FormError margin="below">{error}</FormError>
      )}

      <div style={{ display: "flex", gap: 24, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        <StatusPill status={pill.status} label={pill.label} />
        <span>{INVOICE_TYPE_LABELS[invoice.type]}</span>
        <span>Kund: <strong>{invoice.customerName}</strong></span>
        {!editable && invoice.invoiceNumber && <span>Fakturanr: <strong>{invoice.invoiceNumber}</strong></span>}
        {invoice.invoiceDate && <span>Fakturadatum: {invoice.invoiceDate}</span>}
        {!editable && invoice.ocrNumber && <span>OCR-nummer: {invoice.ocrNumber}</span>}
        {!editable && invoice.dueDate && <span>Förfallodatum: {invoice.dueDate}</span>}
        {invoice.buyerVatNumber && <span>Köparens momsnr: {invoice.buyerVatNumber}</span>}
        {foreign && (
          <span>
            Valuta: <strong>{invoice.currency}</strong>
          </span>
        )}
        {foreign && (
          <span>
            {invoice.exchangeRate === null
              ? "Kurs: sätts vid utfärdandet"
              : `Kurs: ${formatRate(invoice.exchangeRate)} (${
                  isCredit
                    ? "den krediterade fakturans"
                    : invoice.exchangeRateManual
                      ? "manuell"
                      : invoice.status === "draft"
                        ? "förhandsvisning"
                        : "fakturadatumets"
                })`}
          </span>
        )}
        {/* openAmount is meaningless for draft/cancelled (see InvoiceDetail's
            own comment) — issued/paid only, same gate as the FA-number/OCR/
            due-date fields above. */}
        {(invoice.status === "issued" || invoice.status === "paid") && (
          <span>
            Öppet belopp: {formatMoney(invoice.openAmount)} {invoice.currency}
            {foreign && invoice.openAmountSek !== null && ` (${formatMoney(invoice.openAmountSek)} kr bokfört)`}
          </span>
        )}
        {invoice.isLateInterestInvoice && <span>Räntefaktura</span>}
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
            <VerificationRef id={invoice.verificationId} displayNumber={invoice.verificationDisplayNumber} canOpen={canOpenVerifications} />
          </span>
        )}
      </div>

      {autoSend &&
        (isEInvoiceAutoSendProblem(autoSend) ? (
          <FormNotice style={{ marginBottom: 20 }}>{autoSend.message}</FormNotice>
        ) : (
          <FormHint role="status" style={{ marginBottom: 20 }}>
            {autoSend.message}
          </FormHint>
        ))}

      {editable && customerOnHold && (
        <FormNotice style={{ marginBottom: 20 }}>
          Kunden har Faktura i vänteläge — granska fakturan innan den utfärdas.
        </FormNotice>
      )}

      {/* Utfärda refuses an EU sale / omvänd betalningsskyldighet without the
          buyer's momsregistreringsnummer in the right form — warned about
          here, ahead of the click. */}
      {editable && invoice.vatNumberProblem && (
        <FormNotice style={{ marginBottom: 20 }}>
          {buyerVatNumberProblemText(invoice.vatNumberProblem)}{" "}
          {invoice.type === "credit" ? (
            <>
              En kreditfaktura använder momsnumret på fakturan den krediterar
              {creditedInvoiceNumber ? ` (${creditedInvoiceNumber})` : ""}, inte kundens nuvarande momsnummer.
            </>
          ) : (
            <>
              <GatedLink href={`/kunder/${invoice.customerId}`}>Öppna kundkortet</GatedLink> och ange momsnumret under
              Villkor &amp; frakt.
            </>
          )}
        </FormNotice>
      )}
      {/* An accepted EU sale whose number is another member state's than the
          customer's country: allowed (artikel 138), but worth a second look. */}
      {editable && invoice.vatNumberWarning && (
        <FormNotice style={{ marginBottom: 20 }}>
          {buyerVatNumberWarningText(invoice.vatNumberWarning)} Momsnummer på fakturan:{" "}
          <strong>{invoice.buyerVatNumber ?? "–"}</strong>.{" "}
          {invoice.type === "credit" ? (
            <>Kreditfakturan använder momsnumret på fakturan den krediterar.</>
          ) : (
            <>
              <GatedLink href={`/kunder/${invoice.customerId}`}>Öppna kundkortet</GatedLink> om numret ska rättas.
            </>
          )}
        </FormNotice>
      )}

      {/* Header — editable in draft, read-only otherwise (snapshot address once issued). */}
      {editable ? (
        <HeaderForm
          invoice={invoice}
          paymentTerms={paymentTerms}
          values={header}
          onChange={(next) => {
            setHeader(next);
            setHeaderSaved(false);
          }}
          onSave={() => void runSaveHeader()}
          pending={pending}
          dirty={headerDirty}
          saved={headerSaved && !headerDirty}
          error={headerError}
        />
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
            { key: "unitPrice", label: foreign ? `À-pris (${invoice.currency})` : "À-pris", width: "110px", align: "right" },
            { key: "vatCode", label: "Momskod", width: "minmax(190px, 1fr)" },
            { key: "lineAmount", label: foreign ? `Belopp (${invoice.currency})` : "Belopp", width: "120px", align: "right" },
            { key: "deliveryDate", label: "Leveransdatum", width: "140px" },
            ...(showObjects ? [{ key: "objects", label: "Kostnadsställe / projekt", width: "minmax(180px, 1fr)" }] : []),
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
                    {/* Räntefaktura: the account Räntefakturering booked the row to. */}
                    {row.revenueAccount && (
                      <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Konto {row.revenueAccount}</div>
                    )}
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
                    step="any"
                    size="sm"
                    aria-label="À-pris"
                    value={editUnitPrice}
                    onChange={(e) => setEditUnitPrice(e.target.value)}
                  />
                ) : (
                  formatUnitPrice(toUnitPrice(Number(row.unitPrice), row.unitFactor))
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
              case "objects":
                return isEditing ? (
                  <div style={{ display: "grid", gap: 6 }}>
                    <CostCenterSelect
                      aria-label="Kostnadsställe"
                      all={dims.allCostCenters}
                      value={editCostCenterId}
                      onChange={setEditCostCenterId}
                      emptyLabel="Kostnadsställe —"
                    />
                    <ProjectSelect
                      aria-label="Projekt"
                      all={dims.allProjects}
                      value={editProjectId}
                      onChange={setEditProjectId}
                      emptyLabel="Projekt —"
                    />
                  </div>
                ) : row.costCenter || row.project ? (
                  <>
                    <div>{dimensionText(row.costCenter)}</div>
                    <div>{dimensionText(row.project)}</div>
                  </>
                ) : (
                  "–"
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
                    <Button type="button" size="small" variant="ghost" onClick={cancelEditRow}>
                      Avbryt
                    </Button>
                  </span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => void startEditRow(row)}>
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
      <FormError>{rowError}</FormError>

      <div style={{ display: "flex", gap: 24, marginTop: 12, flexWrap: "wrap" }}>
        <span>Nettobelopp: {formatMoney(netAmount)} {invoice.currency}</span>
        <span>Momsbelopp: {formatMoney(vatAmount)} {invoice.currency}</span>
        <span><strong>Bruttobelopp: {formatMoney(grossAmount)} {invoice.currency}</strong></span>
      </div>
      {/* Valuta: what the invoice is (draft: would be) booked at in SEK. */}
      {foreign &&
        (invoice.sekAmounts ? (
          <SekAmountsLine
            amounts={invoice.sekAmounts}
            label={invoice.status === "draft" ? "I SEK med kursen (förhandsvisning)" : "Bokfört i SEK"}
          />
        ) : (
          <FormHint>
            SEK-värdena visas när kursen är satt — den sätts vid utfärdandet till fakturadatumets kurs, eller skriv in en
            egen kurs i utkastet.
          </FormHint>
        ))}

      {invoice.payments.length > 0 && (
        <>
          <SectionHeading spaced>Betalningar</SectionHeading>
          <Table<InvoicePaymentEntry & { id: string }>
            columns={[
              { key: "paymentDate", label: "Datum", width: "130px" },
              { key: "paymentNumber", label: "Betalning", width: "160px" },
              { key: "appliedAmount", label: "Belopp", width: "130px", align: "right" },
              { key: "writeOffAmount", label: "Avskrivning", width: "140px", align: "right" },
              // Valuta: what the row released of the booked receivable.
              ...(foreign ? [{ key: "settledSek", label: "Avräknat i SEK", width: "140px", align: "right" as const }] : []),
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
                    <Link style={row.cancelledAt !== null ? CANCELLED_TEXT : undefined} href={`/forsaljning/betalningar/${row.paymentId}`}>
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
                  return <span style={row.cancelledAt !== null ? CANCELLED_TEXT : undefined}>{`${formatMoney(row.appliedAmount)} ${invoice.currency}`}</span>;
                case "writeOffAmount":
                  return Number(row.writeOffAmount) !== 0 ? `${formatMoney(row.writeOffAmount)} ${invoice.currency}` : "–";
                case "settledSek":
                  return `${formatMoney(Number(row.appliedAmountSek) + Number(row.writeOffAmountSek))} kr`;
                case "verificationId":
                  if (row.verificationId === null) {
                    return <span title="Kvittning (inget verifikat)">– (kvittning)</span>;
                  }
                  return <VerificationRef id={row.verificationId} displayNumber={row.verificationDisplayNumber} canOpen={canOpenVerifications} />;
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
                  return formatStockholmDateTime(row.sentAt);
                case "fee":
                  return Number(row.fee) > 0 ? `${formatMoney(row.fee)} ${invoice.currency}` : "–";
                case "feeVerificationId":
                  if (row.feeVerificationId === null) return "–";
                  return (
                    <VerificationRef id={row.feeVerificationId} displayNumber={row.feeVerificationDisplayNumber} canOpen={canOpenVerifications} />
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

      {lateInterestCharges.length > 0 && (
        <>
          <SectionHeading spaced>Räntefakturerad</SectionHeading>
          <Table<InvoiceLateInterestCharge>
            columns={[
              { key: "period", label: "Period", width: "200px" },
              { key: "days", label: "Dagar", width: "70px", align: "right" },
              { key: "amount", label: "Ränta", width: "130px", align: "right" },
              { key: "fee", label: "Förseningsersättning", width: "190px", align: "right" },
              { key: "chargeInvoice", label: "Räntefaktura", width: "1fr" },
            ]}
            rows={lateInterestCharges}
            renderCell={(row, key) => {
              switch (key) {
                case "period":
                  return row.fromDate && row.toDate ? `${row.fromDate}–${row.toDate}` : "–";
                case "days":
                  return row.days > 0 ? row.days.toLocaleString("sv-SE") : "–";
                case "amount":
                  return Number(row.amount) > 0 ? `${formatMoney(row.amount)} kr` : "–";
                case "fee":
                  return Number(row.fee) > 0 ? `${formatMoney(row.fee)} kr` : "–";
                case "chargeInvoice":
                  return (
                    <>
                      <Link href={`/forsaljning/fakturor/${row.chargeInvoiceId}`}>{row.chargeInvoiceNumber ?? "Utkast"}</Link>
                      {!row.active && (
                        <>
                          {" "}
                          <StatusPill status="stopped" label="makulerad" compact />
                        </>
                      )}
                    </>
                  );
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      {editable && (
        <div style={{ marginTop: 20 }}>
          <AddRowForm
            invoiceId={invoice.id}
            currency={invoice.currency}
            vatCodes={vatCodes}
            customerVat={customerVat}
            onDone={() => router.refresh()}
            onFilledChange={setAddRowFilled}
          />
        </div>
      )}

      {reminderOpen && (
        <ReminderDialog
          invoice={invoice}
          defaultTo={reminderDefaultTo}
          reminderFee={reminderFee}
          feeAlreadyCharged={feeAlreadyCharged}
          lateFeeCharged={lateFeeCharged}
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
  lateFeeCharged,
  onClose,
  onSent,
}: {
  invoice: InvoiceDetail;
  defaultTo: string;
  reminderFee: number;
  feeAlreadyCharged: boolean;
  lateFeeCharged: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(defaultTo);
  // Dokument på engelska (#7): the reminder follows the invoice's stamped language.
  // E-postmallar: {belopp} is what is left to pay.
  const text = useMailText({
    kind: "paymentReminder",
    language: documentLanguageOf(invoice.language),
    values: {
      number: invoice.invoiceNumber ?? "",
      customer: invoice.customerName,
      amount: mailAmount(invoice.openAmount, invoice.currency),
      dueDate: invoice.dueDate,
    },
  });
  const { subject, setSubject, message, setMessage } = text;
  // Never pre-checked — the fee is an explicit choice every time (mirrors
  // sendReminderSchema's own withFee default(false) in packages/shared),
  // and impossible to check at all once the statutory one-time fee is spent.
  // Valuta: the fee is a Swedish statutory amount in kronor — only on SEK
  // invoices (409 reminder-fee-currency otherwise).
  const feeNotAllowed = invoice.currency !== SEK;
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
      setError(apiErrorMessage(err, "Påminnelsen kunde inte skickas"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Skicka betalningspåminnelse för faktura ${invoice.invoiceNumber}`}>
      <Form onSubmit={submit}>
        <FormError>{error ?? text.error}</FormError>

        <Field label="Mottagare" htmlFor="remTo">
          <Input id="remTo" type="email" required value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>

        <Field label="Ämne" htmlFor="remSubject">
          <Input
            id="remSubject"
            required
            maxLength={255}
            value={subject}
            disabled={text.loading}
            placeholder={text.loading ? "Hämtar…" : undefined}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>

        <Field label="Meddelande" htmlFor="remMessage">
          <textarea
            id="remMessage"
            className={fieldStyles.input}
            rows={6}
            maxLength={5000}
            value={message}
            disabled={text.loading}
            onChange={(e) => setMessage(e.target.value)}
            style={{ resize: "vertical", fontFamily: "inherit" }}
          />
        </Field>

        <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>Påminnelsen bifogas som PDF.</p>
        <MailSignatureNote />

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input
            type="checkbox"
            checked={withFee}
            disabled={feeAlreadyCharged || feeNotAllowed || lateFeeCharged}
            onChange={(e) => setWithFee(e.target.checked)}
          />
          Lägg till påminnelseavgift ({formatMoney(reminderFee)} kr)
        </label>
        {feeAlreadyCharged && (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>Avgift redan tillagd</p>
        )}
        {lateFeeCharged && (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
            Förseningsersättning är debiterad på fakturan — påminnelseavgiften ryms i ersättningen.
          </p>
        )}
        {feeNotAllowed && (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
            Påminnelseavgiften är ett belopp i kronor och kan bara tas ut på fakturor i SEK — fakturan är i{" "}
            {invoice.currency}.
          </p>
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
          <Button type="submit" variant="primary" disabled={pending || text.loading}>
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

// Controlled by the card (its header state is what Utfärda saves first and
// what the unsaved-changes guard watches).
function HeaderForm({
  invoice,
  paymentTerms,
  values,
  onChange,
  onSave,
  pending,
  dirty,
  saved,
  error,
}: {
  invoice: InvoiceDetail;
  paymentTerms: RegisterEntry[];
  values: InvoiceHeaderValues;
  onChange: (next: InvoiceHeaderValues) => void;
  onSave: () => void;
  pending: boolean;
  dirty: boolean;
  saved: boolean;
  error: string | null;
}) {
  // Valuta: a rate typed in on the draft ("" = automatic: the invoice date's
  // rate is fetched at Utfärda). A credit note has its source invoice's rate.
  const foreign = invoice.currency !== SEK;
  const isCredit = invoice.type === "credit";
  const rate = values.rate;

  function save(e: FormEvent) {
    e.preventDefault();
    onSave();
  }

  return (
    <Card maxWidth={520} style={{ marginBottom: 20 }}>
      <Form onSubmit={save}>
        <FormError>{error}</FormError>
        <Field label="Betalningsvillkor" htmlFor="hdrPaymentTerm">
          <Select id="hdrPaymentTerm" value={values.paymentTermId} onChange={(e) => onChange({ ...values, paymentTermId: e.target.value })}>
            <option value="">— Ingen —</option>
            {paymentTerms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notering" htmlFor="hdrNote">
          <Input id="hdrNote" value={values.note} onChange={(e) => onChange({ ...values, note: e.target.value })} />
        </Field>
        {foreign && !isCredit && (
          <>
            <Field label={`Kurs (SEK per 1 ${invoice.currency})`} htmlFor="hdrExchangeRate">
              <Input
                id="hdrExchangeRate"
                type="number"
                min="0"
                step="any"
                size="sm"
                placeholder="Automatisk"
                value={rate}
                onChange={(e) => onChange({ ...values, rate: e.target.value })}
              />
              <FormHint>
                {rate.trim() === ""
                  ? `Tomt = automatisk: kursen för fakturadatumet (dagens datum när du utfärdar) hämtas från Riksbanken eller Valutakurser.`
                  : "Din kurs gäller fakturan och bokföringen i SEK."}{" "}
                Momslagen kräver kursen när den beskattningsgrundande händelsen inträffar (oftast leveransen) — skriv in den
                kursen om leveransdagen skiljer sig från fakturadatumet.
              </FormHint>
            </Field>
            {rate.trim() !== "" && (
              <div>
                <Button type="button" variant="ghost" size="small" onClick={() => onChange({ ...values, rate: "" })}>
                  Använd automatisk kurs
                </Button>
              </div>
            )}
          </>
        )}
        {foreign && isCredit && (
          <Field label={`Kurs (SEK per 1 ${invoice.currency})`} htmlFor="hdrExchangeRate">
            <Input
              id="hdrExchangeRate"
              size="sm"
              disabled
              value={invoice.exchangeRate === null ? "–" : formatRate(invoice.exchangeRate)}
            />
            <FormHint>En kreditfaktura har alltid den krediterade fakturans kurs.</FormHint>
          </Field>
        )}
        <FormActions>
          <Button type="submit" variant="primary" disabled={pending || !dirty}>
            {pending ? "Sparar…" : "Spara faktura"}
          </Button>
          {dirty && <span style={{ alignSelf: "center" }}>Osparade ändringar</span>}
          {saved && <span style={{ alignSelf: "center" }}>Sparat</span>}
        </FormActions>
      </Form>
    </Card>
  );
}

// Adds a line — an article row (ArticlePicker) or a fri rad (no article).
function AddRowForm({
  invoiceId,
  currency,
  vatCodes,
  customerVat,
  onDone,
  onFilledChange,
}: {
  invoiceId: string;
  // Valuta: the invoice's currency — the unit price is typed in it.
  currency: string;
  vatCodes: VatCodeView[];
  customerVat: SalesVatCustomer | null;
  onDone: () => void;
  // Tells the card a row is being filled in (Utfärda waits for it).
  onFilledChange?: (filled: boolean) => void;
}) {
  const [description, setDescription] = useState("");
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  // Enhet: "" = the article's base unit. Antal and À-pris are typed in the
  // chosen unit and sent in the base unit (the API stores the row there);
  // unitId only sets how the row is shown and printed.
  const [unitId, setUnitId] = useState("");
  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const unitCode = unitOptions.find((o) => o.value === unitId)?.code;
  // "" = Automatisk: the API derives the code from the customer and the
  // article (salesVatCode) — what the first option names below. Picking one
  // sends that vatCodeId; the bare vatRate is never sent.
  const [vatCodeId, setVatCodeId] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [costCenterId, setCostCenterId] = useState("");
  const [projectId, setProjectId] = useState("");
  const dims = useDimensions();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const filled = description.trim() !== "" || article !== null || unitPrice.trim() !== "";
  useEffect(() => {
    onFilledChange?.(filled);
  }, [filled, onFilledChange]);

  function handleArticleChange(next: Article | null) {
    setArticle(next);
    // The article's Försäljningsenhet, as on the order row.
    setUnitId(next?.salesUnitId ?? "");
    if (next && !description.trim()) setDescription(`${next.articleNumber} — ${next.name}`);
  }

  // Switching unit re-expresses what is typed (10 st ⇄ 2 kg).
  function handleUnitChange(option: UnitOption) {
    setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
    setUnitPrice((p) => convertPriceInput(p, currentFactor, option.factor));
    setUnitId(option.value);
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
          quantity: toBaseQuantity(Number(quantity), currentFactor),
          unitPrice: unitPrice.trim() ? toBasePrice(Number(unitPrice), currentFactor) : 0,
          // A free row without an article has no unit of its own.
          ...(article ? { unitId: unitId || null } : {}),
          vatCodeId: vatCodeId || undefined,
          deliveryDate: deliveryDate.trim() || undefined,
          // Omitted = Förval (the order header's, else the article group's
          // cost center); null = Inget; an id = the row's own.
          costCenterId: costCenterId === NO_OBJECT ? null : costCenterId || undefined,
          projectId: projectId === NO_OBJECT ? null : projectId || undefined,
        }),
      });
      setCostCenterId("");
      setProjectId("");
      setDescription("");
      setArticle(null);
      setUnitId("");
      setQuantity("1");
      setUnitPrice("");
      setVatCodeId("");
      setDeliveryDate("");
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte lägga till raden"));
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

        <FormRow columns={article ? 3 : 2}>
          <Field label="Antal" htmlFor="rowQuantity">
            <Input id="rowQuantity" type="number" min="0" step="any" size="sm" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          {article && (
            <Field label="Enhet" htmlFor="rowUnit">
              <UnitSelect id="rowUnit" options={unitOptions} value={unitId} onChange={handleUnitChange} />
            </Field>
          )}
          <Field
            label={`${currency === SEK ? "À-pris" : `À-pris (${currency})`}${article && unitCode ? ` per ${unitCode}` : ""}`}
            htmlFor="rowUnitPrice"
          >
            <Input id="rowUnitPrice" type="number" step="any" size="sm" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
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

        {(dims.allCostCenters.length > 0 || dims.allProjects.length > 0) && (
          <>
            <FormRow>
              <Field label="Kostnadsställe (valfritt)" htmlFor="rowCostCenter">
                <CostCenterSelect id="rowCostCenter" all={dims.allCostCenters} value={costCenterId} onChange={setCostCenterId} emptyLabel="Förval" noneLabel="Inget" />
              </Field>
              <Field label="Projekt (valfritt)" htmlFor="rowProject">
                <ProjectSelect id="rowProject" all={dims.allProjects} value={projectId} onChange={setProjectId} emptyLabel="Förval" noneLabel="Inget" />
              </Field>
            </FormRow>
            <FormHint>
              Förval är kundorderns kostnadsställe, annars varugruppens, och kundorderns projekt; Inget ger raden inget
              objekt. Objekten bokförs på intäktsraden.
            </FormHint>
          </>
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
