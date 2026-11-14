"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { DocumentLanguage } from "../../lib/documentLanguage";
import { EMAIL_DOCUMENT_TYPE_LABELS, EMAIL_STATUS_PILL, type EmailLogEntry, type PartnerContact } from "../../lib/types";
import { formatRecipients, MAX_EMAIL_CC, parseCcAddresses } from "../../lib/mailCc";
import buttonStyles from "../ui/Button.module.css";
import fieldStyles from "../ui/Field.module.css";
import { Form, FormActions, FormError } from "../ui/Form";
import { formatStockholmDateTime } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { hasUnsavedDrafts } from "../../lib/unsavedGuard";
import type { MailTextRequest } from "../../lib/mailText";
import { useMailText } from "./useMailText";
import { MailSignatureNote } from "./MailSignatureNote";

export interface SendButtonConfig {
  label: string; // e.g. "Skicka via e-post", "Skicka offert"
  modalTitle: string;
  endpoint: string; // POST target, e.g. /api/v1/inquiries/:id/send-email
  // Ämne and Meddelande are filled from the user's e-mail template
  // (Mina inställningar) for this document when the dialog opens.
  mail: MailTextRequest;
  extraBody?: Record<string, unknown>; // e.g. { variant: "quote" }
  // Overrides the shared default recipient (e.g. the customer's invoice
  // email for "Skicka faktura").
  to?: string;
  // Kopia (förfrågan / inköpsorder): the supplier whose contacts (fliken
  // Kontakter) can be ticked as copy recipients; typed addresses too. Unset
  // = the dialog has no Kopia and sends no `cc`.
  ccSupplierId?: string;
  // Small note next to the button (e.g. "Kunden vill ha e-faktura").
  hint?: string;
  // Navigate here after a successful send instead of refreshing (a quote's
  // orderbekräftelse turns it into a kundorder with a new card URL).
  redirectTo?: string;
}

export interface PdfLinkConfig {
  label: string; // e.g. "Ladda ner PDF"
  href: string;
  // Append ?showConfigurationPrices= from the section's Visa tilläggspriser checkbox.
  configurationPrices?: boolean;
}

// Shared "E-post"-section for the document cards (förfrågan, inköpsorder,
// kundorder): send buttons with a prefilled dialog, PDF downloads, and the
// document's own send history from the email log.
export function MailSection({
  emails,
  defaultTo,
  sendButtons,
  pdfLinks,
  showDocumentColumn = false,
  drawingCount = 0,
  configurationPrices,
  documentLanguage,
}: {
  emails: EmailLogEntry[];
  defaultTo: string;
  sendButtons: SendButtonConfig[];
  pdfLinks: PdfLinkConfig[];
  showDocumentColumn?: boolean;
  // Number of drawings on the order's articles — the send dialog offers to
  // attach them when there are any.
  drawingCount?: number;
  // Set when the order has configured rows: shows Visa tilläggspriser (prefilled
  // from the customer's setting), which steers the PDF links and the send dialog.
  configurationPrices?: { defaultChecked: boolean };
  // Dokument på engelska (#7): "en" shows a note that the PDFs and mail
  // defaults are English; Swedish shows nothing.
  documentLanguage?: DocumentLanguage;
}) {
  const router = useRouter();
  const [active, setActive] = useState<SendButtonConfig | null>(null);
  const [showPrices, setShowPrices] = useState(configurationPrices?.defaultChecked ?? false);
  // The mail is rendered from the SAVED document on the server: with unsaved
  // changes on the card (a new Åtgärd on the avvikelse, an edited row) the
  // recipient got the old text. Asked when the button is clicked, since the
  // card's drafts are not this section's state.
  const [unsavedNotice, setUnsavedNotice] = useState(false);
  function openSend(btn: SendButtonConfig) {
    if (hasUnsavedDrafts()) {
      setUnsavedNotice(true);
      return;
    }
    setUnsavedNotice(false);
    setActive(btn);
  }

  return (
    <div style={{ marginTop: 28 }}>
      <strong>E-post</strong>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
        {sendButtons.map((btn) => (
          <span key={btn.label} style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" onClick={() => openSend(btn)}>
              {btn.label}
            </Button>
            {btn.hint && <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{btn.hint}</span>}
          </span>
        ))}
        {documentLanguage === "en" && (
          <span style={{ alignSelf: "center", fontSize: 13, color: "var(--color-text-secondary)" }}>
            Dokument på engelska
          </span>
        )}
        {pdfLinks.map((link) => {
          const href = link.configurationPrices
            ? `${link.href}${link.href.includes("?") ? "&" : "?"}showConfigurationPrices=${showPrices}`
            : link.href;
          return (
            <a key={link.href} href={href} className={`${buttonStyles.button} ${buttonStyles.ghost}`} download>
              {link.label}
            </a>
          );
        })}
      </div>
      {unsavedNotice && <FormError>Spara ändringarna innan du skickar — e-posten skapas av det sparade dokumentet.</FormError>}
      {configurationPrices && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginTop: 10 }}>
          <input type="checkbox" checked={showPrices} onChange={(e) => setShowPrices(e.target.checked)} />
          Visa tilläggspriser
        </label>
      )}

      {emails.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Table<EmailLogEntry>
            columns={[
              { key: "createdAt", label: "Tid", width: "150px" },
              ...(showDocumentColumn ? [{ key: "documentType" as const, label: "Dokument", width: "150px" }] : []),
              { key: "recipient", label: "Mottagare", width: "1fr" },
              { key: "subject", label: "Ämne", width: "1fr" },
              { key: "status", label: "Status", width: "130px" },
            ]}
            rows={emails}
            renderCell={(row, key) => {
              switch (key) {
                case "createdAt":
                  return formatStockholmDateTime(row.createdAt);
                case "documentType":
                  return EMAIL_DOCUMENT_TYPE_LABELS[row.documentType];
                case "status": {
                  const pill = EMAIL_STATUS_PILL[row.status];
                  return (
                    <span title={row.error ?? undefined}>
                      <StatusPill status={pill.status} label={pill.label} compact />
                    </span>
                  );
                }
                // Kopia follows the recipient: "a@x (kopia: b@x, c@x)".
                case "recipient":
                  return formatRecipients(row.recipient, row.cc);
                default:
                  return row[key as keyof EmailLogEntry] as string;
              }
            }}
          />
        </div>
      )}

      {active && (
        <SendEmailModal
          open
          onClose={() => setActive(null)}
          config={active}
          defaultTo={defaultTo}
          drawingCount={drawingCount}
          configurationPrices={configurationPrices ? showPrices : null}
          onSuccess={() => {
            setActive(null);
            if (active.redirectTo) router.push(active.redirectTo);
            else router.refresh();
          }}
        />
      )}
    </div>
  );
}

// Exported for callers that own the trigger themselves — the behovsberäkning
// offers "Maila" per created order, outside any MailSection.
export function SendEmailModal({
  open,
  onClose,
  config,
  defaultTo,
  drawingCount,
  configurationPrices = null,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  config: SendButtonConfig;
  defaultTo: string;
  drawingCount: number;
  // Not null ⇒ the document has configured rows: offer Visa tilläggspriser, initialised from this value.
  configurationPrices?: boolean | null;
  onSuccess: () => void;
}) {
  const [to, setTo] = useState(config.to ?? defaultTo);
  const text = useMailText(config.mail);
  const { subject, setSubject, message, setMessage } = text;
  // Prechecked when the order's articles have drawings — easy to opt out of.
  const [attachDrawings, setAttachDrawings] = useState(drawingCount > 0);
  const [showPrices, setShowPrices] = useState(configurationPrices ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Kopia: the supplier's contacts with an address (ticked ones) plus typed
  // addresses. A failed lookup just leaves the typed field.
  const ccSupplierId = config.ccSupplierId;
  const [ccContacts, setCcContacts] = useState<PartnerContact[]>([]);
  const [ccChecked, setCcChecked] = useState<string[]>([]);
  const [ccText, setCcText] = useState("");
  useEffect(() => {
    if (!ccSupplierId) return;
    let cancelled = false;
    apiFetch<PartnerContact[]>(`/api/v1/suppliers/${ccSupplierId}/contacts`)
      .then((contacts) => {
        if (!cancelled) setCcContacts(contacts.filter((c) => c.email));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ccSupplierId]);
  // The recipient itself is not offered as a copy.
  const offeredContacts = ccContacts.filter((c) => c.email!.trim().toLowerCase() !== to.trim().toLowerCase());

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let cc: string[] | null = null;
    if (ccSupplierId) {
      const ticked = offeredContacts.filter((c) => ccChecked.includes(c.id)).map((c) => c.email!);
      const parsed = parseCcAddresses(ticked, ccText, to);
      if (!parsed.ok) {
        setError(parsed.message);
        return;
      }
      cc = parsed.addresses;
    }
    setPending(true);
    try {
      await apiFetch(config.endpoint, {
        method: "POST",
        body: JSON.stringify({
          to,
          subject,
          message,
          attachDrawings,
          ...(cc !== null ? { cc } : {}),
          ...(configurationPrices !== null ? { showConfigurationPrices: showPrices } : {}),
          ...config.extraBody,
        }),
      });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Mejlet kunde inte skickas"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={config.modalTitle}>
      <Form onSubmit={handleSubmit}>
        <FormError>{error ?? text.error}</FormError>

        <Field label="Mottagare" htmlFor="mailTo">
          <Input id="mailTo" type="email" required value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>

        {ccSupplierId && (
          <Field label="Kopia" htmlFor="mailCc">
            {offeredContacts.map((contact) => (
              <label key={contact.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginBottom: 6 }}>
                <input
                  type="checkbox"
                  checked={ccChecked.includes(contact.id)}
                  onChange={(e) =>
                    setCcChecked((prev) => (e.target.checked ? [...prev, contact.id] : prev.filter((id) => id !== contact.id)))
                  }
                />
                {contact.name} ({contact.email})
              </label>
            ))}
            <Input
              id="mailCc"
              placeholder="Fler adresser, åtskilda med kommatecken"
              value={ccText}
              onChange={(e) => setCcText(e.target.value)}
            />
            <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
              Kryssa i leverantörens kontakter eller skriv adresser — högst {MAX_EMAIL_CC}.
            </span>
          </Field>
        )}

        <Field label="Ämne" htmlFor="mailSubject">
          <Input
            id="mailSubject"
            required
            maxLength={255}
            value={subject}
            disabled={text.loading}
            placeholder={text.loading ? "Hämtar…" : undefined}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>

        <Field label="Meddelande" htmlFor="mailMessage">
          <textarea
            id="mailMessage"
            className={fieldStyles.input}
            rows={6}
            maxLength={5000}
            value={message}
            disabled={text.loading}
            onChange={(e) => setMessage(e.target.value)}
            style={{ resize: "vertical", fontFamily: "inherit" }}
          />
        </Field>

        <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>Dokumentet bifogas som PDF.</p>
        <MailSignatureNote />

        {drawingCount > 0 && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input
              type="checkbox"
              checked={attachDrawings}
              onChange={(e) => setAttachDrawings(e.target.checked)}
            />
            Bifoga ritningar ({drawingCount} {drawingCount === 1 ? "fil" : "filer"})
          </label>
        )}

        {configurationPrices !== null && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={showPrices} onChange={(e) => setShowPrices(e.target.checked)} />
            Visa tilläggspriser
          </label>
        )}

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
