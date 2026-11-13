"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { confirmDialog } from "../../lib/confirm";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import {
  MAIL_BODY_MAX,
  MAIL_PLACEHOLDER_LABELS,
  MAIL_SUBJECT_MAX,
  MAIL_TEMPLATE_KINDS,
  MAIL_TEMPLATE_KIND_LABELS,
  MAIL_TEMPLATE_LANGUAGES,
  MAIL_TEMPLATE_LANGUAGE_LABELS,
  MAIL_TEMPLATE_PLACEHOLDERS,
  unknownMailPlaceholders,
  type MailTemplateKind,
  type MailTemplateLanguage,
} from "../../lib/mailTemplateCatalog";
import type { MailTextValues } from "../../lib/mailText";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormSaved } from "../ui/Form";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import fieldStyles from "../ui/Field.module.css";
import styles from "./MailTemplatesEditor.module.css";

export interface MailTemplateView {
  kind: MailTemplateKind;
  language: MailTemplateLanguage;
  subject: string;
  body: string;
  custom: boolean;
}

// Made-up values for the preview (Förhandsvisning) — the server adds your
// name and the company's, as in a real mail.
const SAMPLE_NUMBER: Record<MailTemplateKind, string> = {
  quote: "OF-1001",
  orderConfirmation: "KO-5001",
  invoice: "1001",
  creditNote: "1002",
  paymentReminder: "1001",
  inquiry: "FF-101",
  purchaseOrder: "IO-201",
  deviationCustomer: "AV-11",
  deviationSupplier: "AV-12",
  deviationInternal: "AV-13",
};
function sampleValues(kind: MailTemplateKind): MailTextValues {
  return {
    number: SAMPLE_NUMBER[kind],
    customer: "Exempelkunden AB",
    supplier: "Exempelleverantören AB",
    contact: "Eva Exempel",
    amount: { value: 12500, currency: "SEK" },
    dueDate: "2026-12-31",
    validUntil: "2026-12-31",
    deliveryDate: "2026-12-15",
    quoteNumber: "OF-1001",
  };
}

const key = (kind: MailTemplateKind, language: MailTemplateLanguage) => `${kind}/${language}`;

// E-postmallar on Mina inställningar: pick the document type and language,
// edit Ämne and Meddelande, click a placeholder in to place it where the
// cursor is, see the mail filled in below. Spara keeps it for you only;
// Återställ förval goes back to Nav's text.
export function MailTemplatesEditor({ initial }: { initial: MailTemplateView[] }) {
  const [templates, setTemplates] = useState(() => new Map(initial.map((t) => [key(t.kind, t.language), t])));
  const [kind, setKind] = useState<MailTemplateKind>("quote");
  const [language, setLanguage] = useState<MailTemplateLanguage>("sv");
  const current = templates.get(key(kind, language))!;
  const [subject, setSubject] = useState(current.subject);
  const [body, setBody] = useState(current.body);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = subject !== current.subject || body !== current.body;
  useUnsavedGuard(dirty);

  // Where a clicked placeholder goes: the field that last had the focus.
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<"subject" | "body">("body");

  const unknown = unknownMailPlaceholders(kind, `${subject}\n${body}`);
  const offered = MAIL_TEMPLATE_PLACEHOLDERS[kind];

  // Förhandsvisning: the server fills the draft (your name, the company's,
  // the amount on the language) — 300 ms after the last keystroke; a late
  // answer for an older draft is dropped.
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewSeq = useRef(0);
  useEffect(() => {
    const seq = ++previewSeq.current;
    if (unknown.length > 0 || subject.trim() === "") {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<{ subject: string; body: string }>("/api/v1/me/mail-text", {
        method: "POST",
        body: JSON.stringify({ kind, language, values: sampleValues(kind), template: { subject, body } }),
      })
        .then((text) => {
          if (seq !== previewSeq.current) return;
          setPreview(text);
          setPreviewError(null);
        })
        .catch((err) => {
          if (seq !== previewSeq.current) return;
          setPreview(null);
          setPreviewError(apiErrorMessage(err, "Förhandsvisningen kunde inte visas"));
        });
    }, 300);
    return () => clearTimeout(timer);
    // `unknown` is derived from kind, subject and body.
  }, [kind, language, subject, body, unknown.length]);

  async function choose(nextKind: MailTemplateKind, nextLanguage: MailTemplateLanguage) {
    if (nextKind === kind && nextLanguage === language) return;
    if (
      dirty &&
      !(await confirmDialog("Mallen har ändringar som inte är sparade. Byta mall ändå?", {
        confirmLabel: "Byt utan att spara",
        danger: true,
      }))
    ) {
      return;
    }
    const next = templates.get(key(nextKind, nextLanguage))!;
    setKind(nextKind);
    setLanguage(nextLanguage);
    setSubject(next.subject);
    setBody(next.body);
    setError(null);
    setSaved(null);
  }

  function insert(name: string) {
    const token = `{${name}}`;
    const field = lastField.current === "subject" ? subjectRef.current : bodyRef.current;
    const value = lastField.current === "subject" ? subject : body;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    const nextValue = value.slice(0, start) + token + value.slice(end);
    if (lastField.current === "subject") setSubject(nextValue);
    else setBody(nextValue);
    // Put the cursor after the placeholder once React has written the value.
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function store(view: MailTemplateView) {
    setTemplates((prev) => new Map(prev).set(key(view.kind, view.language), view));
    setSubject(view.subject);
    setBody(view.body);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);
    setPending(true);
    try {
      store(
        await apiFetch<MailTemplateView>(`/api/v1/me/mail-templates/${kind}/${language}`, {
          method: "PUT",
          body: JSON.stringify({ subject, body }),
        })
      );
      setSaved("Mallen är sparad.");
    } catch (err) {
      setError(apiErrorMessage(err, "Mallen kunde inte sparas"));
    } finally {
      setPending(false);
    }
  }

  async function reset() {
    if (!(await confirmDialog("Återställa Navs förvalda text för den här mallen? Din egen text tas bort.", { confirmLabel: "Återställ" }))) {
      return;
    }
    setError(null);
    setSaved(null);
    setPending(true);
    try {
      store(await apiFetch<MailTemplateView>(`/api/v1/me/mail-templates/${kind}/${language}`, { method: "DELETE" }));
      setSaved("Förvald text återställd.");
    } catch (err) {
      setError(apiErrorMessage(err, "Mallen kunde inte återställas"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={save}>
      <div className={styles.pickers}>
        <Field label="Dokument" htmlFor="mail-template-kind">
          <Select
            id="mail-template-kind"
            value={kind}
            onChange={(e) => void choose(e.target.value as MailTemplateKind, language)}
          >
            {MAIL_TEMPLATE_KINDS.map((k) => {
              const own = MAIL_TEMPLATE_LANGUAGES.some((l) => templates.get(key(k, l))?.custom);
              return (
                <option key={k} value={k}>
                  {MAIL_TEMPLATE_KIND_LABELS[k]}
                  {own ? " (egen)" : ""}
                </option>
              );
            })}
          </Select>
        </Field>
        <Field label="Språk">
          <SegmentedToggle
            ariaLabel="Språk"
            value={language}
            options={MAIL_TEMPLATE_LANGUAGES.map((l) => ({
              value: l,
              label: `${MAIL_TEMPLATE_LANGUAGE_LABELS[l]}${templates.get(key(kind, l))?.custom ? " (egen)" : ""}`,
            }))}
            onChange={(l) => void choose(kind, l)}
          />
        </Field>
      </div>
      <FormHint>
        {current.custom ? "Din egen text." : "Navs förvalda text."} Mallen gäller bara dig. Texten kan fortfarande
        ändras i varje utskick.
      </FormHint>

      <FormError>{error}</FormError>

      <Field label="Ämne" htmlFor="mail-template-subject">
        <Input
          ref={subjectRef}
          id="mail-template-subject"
          required
          maxLength={MAIL_SUBJECT_MAX}
          value={subject}
          onFocus={() => (lastField.current = "subject")}
          onChange={(e) => setSubject(e.target.value)}
        />
      </Field>
      <Field label="Meddelande" htmlFor="mail-template-body">
        <textarea
          ref={bodyRef}
          id="mail-template-body"
          className={fieldStyles.input}
          rows={9}
          maxLength={MAIL_BODY_MAX}
          value={body}
          onFocus={() => (lastField.current = "body")}
          onChange={(e) => setBody(e.target.value)}
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
      </Field>

      <div className={styles.placeholders}>
        <span className={styles.placeholdersLabel}>Infoga</span>
        {offered.map((name) => (
          <button
            key={name}
            type="button"
            className={styles.chip}
            title={MAIL_PLACEHOLDER_LABELS[name]}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(name)}
          >
            {`{${name}}`}
            <span className={styles.chipLabel}>{MAIL_PLACEHOLDER_LABELS[name]}</span>
          </button>
        ))}
      </div>
      {unknown.length > 0 && (
        <FormError>
          {unknown.length === 1 ? "Platshållaren" : "Platshållarna"} {unknown.map((u) => `{${u}}`).join(", ")} finns inte för{" "}
          {MAIL_TEMPLATE_KIND_LABELS[kind].toLowerCase()}.
        </FormError>
      )}

      <div className={styles.preview} aria-live="polite">
        <div className={styles.previewLabel}>Förhandsvisning med exempeluppgifter</div>
        {previewError ? (
          <FormError>{previewError}</FormError>
        ) : preview ? (
          <>
            <div className={styles.previewSubject}>{preview.subject}</div>
            <pre className={styles.previewBody}>{preview.body}</pre>
          </>
        ) : (
          <div className={styles.previewEmpty}>…</div>
        )}
      </div>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || unknown.length > 0 || !dirty}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        {current.custom && (
          <Button type="button" variant="secondary" disabled={pending} onClick={() => void reset()}>
            Återställ förval
          </Button>
        )}
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setSubject(current.subject);
              setBody(current.body);
            }}
          >
            Ångra ändringarna
          </Button>
        )}
        {saved && !dirty && <FormSaved>{saved}</FormSaved>}
      </FormActions>
    </Form>
  );
}
