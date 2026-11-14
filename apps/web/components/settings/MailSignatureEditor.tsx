"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import {
  MAIL_SIGNATURE_USER_FIELDS,
  MAIL_SIGNATURE_USER_FIELD_LABELS,
  type MailSignatureUserField,
  type MailSignatureView,
} from "../../lib/mailSignature";
import { Button } from "../ui/Button";
import { Checkbox, Input, Toggle } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormSaved } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import styles from "./MailSignatureEditor.module.css";

type Language = "sv" | "en";
type Draft = Pick<MailSignatureView, "enabled" | "fields" | "title" | "phone" | "mobile">;

// The details the user writes here; name and e-mail come from the account.
const WRITTEN: Partial<Record<MailSignatureUserField, { key: "title" | "phone" | "mobile"; max: number; type: string; autoComplete: string }>> = {
  title: { key: "title", max: 100, type: "text", autoComplete: "organization-title" },
  phone: { key: "phone", max: 50, type: "tel", autoComplete: "tel" },
  mobile: { key: "mobile", max: 50, type: "tel", autoComplete: "tel" },
};

function draftOf(view: MailSignatureView): Draft {
  return { enabled: view.enabled, fields: view.fields, title: view.title, phone: view.phone, mobile: view.mobile };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.enabled === b.enabled &&
    (a.title ?? "") === (b.title ?? "") &&
    (a.phone ?? "") === (b.phone ?? "") &&
    (a.mobile ?? "") === (b.mobile ?? "") &&
    MAIL_SIGNATURE_USER_FIELDS.every((field) => a.fields.includes(field) === b.fields.includes(field))
  );
}

// E-postsignatur on Mina inställningar: switch it on, tick which of your
// details go in, see the signature as the recipient will (the server's own
// HTML in a frame without scripts). The company part is the admin's choice
// in Företagsinformation.
export function MailSignatureEditor({ initial }: { initial: MailSignatureView }) {
  const [saved, setSaved] = useState<Draft>(() => draftOf(initial));
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [language, setLanguage] = useState<Language>("sv");
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [pending, setPending] = useState(false);
  const dirty = !sameDraft(draft, saved);
  useUnsavedGuard(dirty);

  function change(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setSavedNotice(false);
  }
  function toggleField(field: MailSignatureUserField, on: boolean) {
    change({ fields: on ? [...draft.fields, field] : draft.fields.filter((f) => f !== field) });
  }

  // Förhandsvisning, 300 ms after the last change; a late answer for an
  // older draft is dropped.
  const [preview, setPreview] = useState<{ html: string; text: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewSeq = useRef(0);
  const previewKey = JSON.stringify({ ...draft, language });
  useEffect(() => {
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      apiFetch<{ html: string; text: string }>("/api/v1/me/mail-signature/preview", { method: "POST", body: previewKey })
        .then((result) => {
          if (seq !== previewSeq.current) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((err) => {
          if (seq !== previewSeq.current) return;
          setPreview(null);
          setPreviewError(apiErrorMessage(err, "Förhandsvisningen kunde inte visas"));
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [previewKey]);

  // The frame grows with its content (same origin, no scripts in it).
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(120);
  function measureFrame() {
    const body = frameRef.current?.contentDocument?.body;
    if (body) setFrameHeight(Math.max(40, body.scrollHeight + 4));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const view = await apiFetch<MailSignatureView>("/api/v1/me/mail-signature", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setSaved(draftOf(view));
      setDraft(draftOf(view));
      setSavedNotice(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Signaturen kunde inte sparas"));
    } finally {
      setPending(false);
    }
  }

  const empty = preview !== null && preview.text === "";

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      <label className={styles.switch}>
        <Toggle checked={draft.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
        <span>Lägg till signaturen i mejlen jag skickar</span>
      </label>
      <FormHint attached>
        Signaturen hamnar under meddelandet när du skickar offerter, orderbekräftelser, fakturor, påminnelser, förfrågningar,
        inköpsorder och reklamationer.
      </FormHint>

      <div className={styles.heading}>Ta med</div>
      <div className={styles.rows}>
        {MAIL_SIGNATURE_USER_FIELDS.map((field) => {
          const id = `signature-${field}`;
          const written = WRITTEN[field];
          return (
            <div key={field} className={styles.row}>
              <Checkbox
                id={`${id}-on`}
                checked={draft.fields.includes(field)}
                onChange={(e) => toggleField(field, e.target.checked)}
                aria-label={`Ta med ${MAIL_SIGNATURE_USER_FIELD_LABELS[field].toLowerCase()}`}
              />
              <label htmlFor={written ? id : `${id}-on`} className={styles.label}>
                {MAIL_SIGNATURE_USER_FIELD_LABELS[field]}
              </label>
              {written ? (
                <Input
                  id={id}
                  type={written.type}
                  autoComplete={written.autoComplete}
                  maxLength={written.max}
                  value={draft[written.key] ?? ""}
                  onChange={(e) => change({ [written.key]: e.target.value })}
                />
              ) : (
                <span className={styles.accountValue}>{field === "name" ? initial.name : initial.email}</span>
              )}
            </div>
          );
        })}
      </div>
      <FormHint>
        Namn och e-post kommer från ditt konto. Mallarna skriver redan ditt namn under hälsningen ({"{avsändare}"}), så kryssa
        bara i Namn om du har tagit bort det där.
      </FormHint>
      <FormHint>
        Företagets uppgifter och logotyp väljer en administratör under{" "}
        <GatedLink href="/system/foretagsinfo">Företagsinformation</GatedLink>.
      </FormHint>

      <div className={styles.previewHead}>
        <span className={styles.heading}>Förhandsvisning</span>
        <SegmentedToggle
          size="small"
          ariaLabel="Språk i förhandsvisningen"
          value={language}
          onChange={setLanguage}
          options={[
            { value: "sv", label: "Svenska" },
            { value: "en", label: "Engelska" },
          ]}
        />
      </div>
      {previewError ? (
        <FormHint>{previewError}</FormHint>
      ) : empty ? (
        <FormHint>Signaturen är tom — kryssa i något att ta med.</FormHint>
      ) : (
        <iframe
          ref={frameRef}
          className={styles.frame}
          title="Förhandsvisning av e-postsignaturen"
          sandbox="allow-same-origin"
          srcDoc={preview?.html ?? ""}
          onLoad={measureFrame}
          style={{ height: frameHeight }}
        />
      )}
      <FormHint attached>
        {draft.enabled ? "" : "Signaturen är avstängd — så här skulle den se ut. "}
        Mejl med dokument på engelska får signaturen på engelska.
      </FormHint>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || !dirty}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        {savedNotice && !dirty && <FormSaved>Signaturen är sparad.</FormSaved>}
      </FormActions>
    </Form>
  );
}
