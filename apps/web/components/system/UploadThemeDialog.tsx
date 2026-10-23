"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatContrastFailure } from "../../lib/themeCore";
import type { ThemeIssue, ThemeValidationResult } from "../../lib/types";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { FormActions, FormError, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { ThemePreview } from "./ThemePreview";
import styles from "./ThemesPageClient.module.css";

interface UploadThemeDialogProps {
  upload: { result: ThemeValidationResult; fileName: string } | null;
  onClose: () => void;
  onInstalled: () => void | Promise<void>;
}

export function UploadThemeDialog({ upload, onClose, onInstalled }: UploadThemeDialogProps) {
  return (
    <Modal open={upload !== null} onClose={onClose} title="Ladda upp tema" wide>
      {upload && <UploadBody result={upload.result} onClose={onClose} onInstalled={onInstalled} />}
    </Modal>
  );
}

function UploadBody({
  result,
  onClose,
  onInstalled,
}: {
  result: ThemeValidationResult;
  onClose: () => void;
  onInstalled: () => void | Promise<void>;
}) {
  const [name, setName] = useState(result.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<string[]>([]);

  const scheme = result.scheme ?? "light";
  const canInstall = result.ok && name.trim().length > 0 && !pending;

  async function install() {
    setPending(true);
    setError(null);
    setServerIssues([]);
    try {
      await apiFetch("/api/v1/themes", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), scheme, tokens: result.tokens, source: result.source }),
      });
      await onInstalled();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte installera temat"));
      const body = (err as { body?: { errors?: ThemeIssue[] } }).body;
      setServerIssues((body?.errors ?? []).map((e) => e.message));
      setPending(false);
    }
  }

  return (
    <div className={styles.dialogBody}>
      <Field label="Namn" htmlFor="upload-theme-name">
        <Input id="upload-theme-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div>
        <strong>Typ:</strong> {scheme === "dark" ? "Mörkt" : "Ljust"}
      </div>

      {result.errors.length > 0 && (
        <FormError>
          <ul className={styles.issues}>
            {result.errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </FormError>
      )}
      {result.contrastFailures.length > 0 && (
        <FormError>
          Temat klarar inte kontrastkravet (4,5:1) och kan inte installeras:
          <ul className={styles.issues}>
            {result.contrastFailures.map((f, i) => (
              <li key={i}>{formatContrastFailure(f)}</li>
            ))}
          </ul>
        </FormError>
      )}
      {result.warnings.length > 0 && (
        <FormNotice>
          <ul className={styles.issues}>
            {result.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </FormNotice>
      )}

      <ThemePreview scheme={scheme} tokens={result.tokens} />

      {error && <FormError>{error}</FormError>}
      {serverIssues.length > 0 && (
        <FormError>
          <ul className={styles.issues}>
            {serverIssues.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </FormError>
      )}
      <FormActions>
        <Button type="button" onClick={install} disabled={!canInstall}>
          Installera
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </div>
  );
}
