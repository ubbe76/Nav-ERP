"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { EMAIL_DOCUMENT_TYPE_LABELS, EMAIL_STATUS_PILL, type EmailLogEntry } from "../../lib/types";
import buttonStyles from "../ui/Button.module.css";
import fieldStyles from "../ui/Field.module.css";
import { Form, FormActions, FormError } from "../ui/Form";

export interface SendButtonConfig {
  label: string; // e.g. "Skicka via e-post", "Skicka offert"
  modalTitle: string;
  endpoint: string; // POST target, e.g. /api/v1/inquiries/:id/send-email
  subject: string; // prefilled Ämne
  message: string; // prefilled Meddelande
  extraBody?: Record<string, unknown>; // e.g. { variant: "quote" }
  // Overrides the shared default recipient (e.g. the customer's invoice
  // email for "Skicka faktura").
  to?: string;
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
}) {
  const router = useRouter();
  const [active, setActive] = useState<SendButtonConfig | null>(null);
  const [showPrices, setShowPrices] = useState(configurationPrices?.defaultChecked ?? false);

  return (
    <div style={{ marginTop: 28 }}>
      <strong>E-post</strong>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
        {sendButtons.map((btn) => (
          <Button key={btn.label} type="button" variant="secondary" onClick={() => setActive(btn)}>
            {btn.label}
          </Button>
        ))}
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
                  return new Date(row.createdAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
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
            router.refresh();
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
  const [subject, setSubject] = useState(config.subject);
  const [message, setMessage] = useState(config.message);
  // Prechecked when the order's articles have drawings — easy to opt out of.
  const [attachDrawings, setAttachDrawings] = useState(drawingCount > 0);
  const [showPrices, setShowPrices] = useState(configurationPrices ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(config.endpoint, {
        method: "POST",
        body: JSON.stringify({
          to,
          subject,
          message,
          attachDrawings,
          ...(configurationPrices !== null ? { showConfigurationPrices: showPrices } : {}),
          ...config.extraBody,
        }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mejlet kunde inte skickas");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={config.modalTitle}>
      <Form onSubmit={handleSubmit}>
        <FormError>{error}</FormError>

        <Field label="Mottagare" htmlFor="mailTo">
          <Input id="mailTo" type="email" required value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>

        <Field label="Ämne" htmlFor="mailSubject">
          <Input id="mailSubject" required maxLength={255} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>

        <Field label="Meddelande" htmlFor="mailMessage">
          <textarea
            id="mailMessage"
            className={fieldStyles.input}
            rows={6}
            maxLength={5000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            style={{ resize: "vertical", fontFamily: "inherit" }}
          />
        </Field>

        <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>Dokumentet bifogas som PDF.</p>

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
