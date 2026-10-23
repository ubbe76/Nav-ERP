"use client";

import { useRef, useState } from "react";
import { confirmDialog } from "../../lib/confirm";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Permission } from "../../lib/permissions";
import type { PluginInstallResult, PluginPreview } from "../../lib/plugins";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { SectionHeading } from "../ui/SectionHeading";
import { ManifestSummary } from "./ManifestSummary";
import { normalizePermissions, PermissionBoxes } from "./PermissionBoxes";
import { SecretsPanel } from "./SecretsPanel";
import styles from "./Plugins.module.css";

type Step =
  | { kind: "address" }
  | { kind: "review"; preview: PluginPreview }
  | { kind: "done"; result: PluginInstallResult };

export function InstallPluginDialog({
  open,
  onClose,
  onInstalled,
}: {
  open: boolean;
  onClose: () => void;
  // Called when the dialog closes after a finished install.
  onInstalled: (result: PluginInstallResult) => void;
}) {
  // Once the secrets are shown, closing without "Klar" asks first — they
  // cannot be shown again.
  const secretsShown = useRef(false);
  async function requestClose() {
    if (secretsShown.current && !(await confirmDialog("Nycklarna visas inte igen. Har du kopierat dem?", { confirmLabel: "Stäng" }))) return;
    secretsShown.current = false;
    onClose();
  }
  return (
    <Modal open={open} onClose={() => void requestClose()} title="Installera tillägg" wide>
      <InstallBody
        onClose={() => void requestClose()}
        onInstalled={(r) => {
          secretsShown.current = false;
          onInstalled(r);
        }}
        onSecretsShown={() => {
          secretsShown.current = true;
        }}
      />
    </Modal>
  );
}

function InstallBody({
  onClose,
  onInstalled,
  onSecretsShown,
}: {
  onClose: () => void;
  onInstalled: (r: PluginInstallResult) => void;
  onSecretsShown: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ kind: "address" });
  const [baseUrl, setBaseUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Set<Permission>>(new Set());
  const [readOnly, setReadOnly] = useState(false);

  function showPreview(preview: PluginPreview) {
    if (preview.ok && preview.manifest) {
      setPermissions(new Set(normalizePermissions(preview.manifest.permissions)));
      setReadOnly(preview.manifest.readOnly);
    }
    setStep({ kind: "review", preview });
  }

  async function fetchManifest() {
    setPending(true);
    setError(null);
    try {
      showPreview(
        await apiFetch<PluginPreview>("/api/v1/plugins/preview", { method: "POST", body: JSON.stringify({ baseUrl }) })
      );
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta manifestet"));
    }
    setPending(false);
  }

  async function uploadManifest(file: File) {
    setError(null);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await file.text());
    } catch {
      setError("Filen är inte giltig JSON.");
      return;
    }
    setPending(true);
    try {
      showPreview(
        await apiFetch<PluginPreview>("/api/v1/plugins/preview", {
          method: "POST",
          body: JSON.stringify({ baseUrl, manifest }),
        })
      );
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte läsa manifestet"));
    }
    setPending(false);
  }

  async function install(preview: PluginPreview) {
    if (!preview.manifest || !preview.baseUrl) return;
    setPending(true);
    setError(null);
    try {
      const result = await apiFetch<PluginInstallResult>("/api/v1/plugins", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: preview.baseUrl,
          manifest: preview.manifest,
          permissions: [...permissions],
          readOnly,
        }),
      });
      onSecretsShown();
      setStep({ kind: "done", result });
    } catch (err) {
      const body = (err as { body?: { errors?: string[] } }).body;
      setError([apiErrorMessage(err, "Kunde inte installera tillägget"), ...(body?.errors ?? [])].join(" "));
    }
    setPending(false);
  }

  if (step.kind === "done") {
    return (
      <div className={styles.body}>
        <p>
          <strong>{step.result.plugin.name}</strong> är installerat. Lägg in nycklarna i tillägget.
        </p>
        <SecretsPanel apiKey={step.result.apiKey} webhookSecret={step.result.webhookSecret} />
        <FormActions>
          <Button type="button" variant="primary" onClick={() => onInstalled(step.result)}>
            Klar
          </Button>
        </FormActions>
      </div>
    );
  }

  if (step.kind === "review") {
    const { preview } = step;
    const manifest = preview.manifest;
    return (
      <div className={styles.body}>
        <FormError>{error}</FormError>
        {!preview.ok && (
          <>
            <FormError>Manifestet kan inte installeras:</FormError>
            <ul className={styles.list}>
              {preview.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </>
        )}
        {preview.keyTaken && <FormError>Ett tillägg med samma nyckel är redan installerat.</FormError>}
        {preview.warnings.length > 0 && (
          <FormNotice>
            <ul className={styles.list}>
              {preview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </FormNotice>
        )}
        {preview.ok && manifest && (
          <>
            <div className={styles.mutedLine}>Adress: {preview.baseUrl}</div>
            <ManifestSummary manifest={manifest} />
            <SectionHeading>Rättigheter att ge tillägget</SectionHeading>
            <FormHint attached>
              Förifyllt med det tillägget begär. Du bestämmer — ändra gärna, och ändra senare på tilläggets kort.
            </FormHint>
            <PermissionBoxes value={permissions} onChange={setPermissions} idPrefix="install-perm" />
            <label className={styles.check}>
              <Checkbox checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
              Endast läsning
            </label>
            <FormHint attached>Med Endast läsning kan tillägget läsa men aldrig ändra något via API:t.</FormHint>
          </>
        )}
        <FormActions style={{ justifyContent: "space-between" }}>
          <Button type="button" variant="secondary" disabled={pending} onClick={() => setStep({ kind: "address" })}>
            Tillbaka
          </Button>
          <Button type="button" variant="primary" disabled={pending || !preview.ok || preview.keyTaken} onClick={() => install(preview)}>
            {pending ? "Installerar…" : "Installera"}
          </Button>
        </FormActions>
      </div>
    );
  }

  return (
    <form
      className={styles.body}
      onSubmit={(e) => {
        e.preventDefault();
        void fetchManifest();
      }}
    >
      <FormError>{error}</FormError>
      <Field label="Adress" htmlFor="install-plugin-url">
        <Input
          id="install-plugin-url"
          required
          type="url"
          placeholder="https://tillagg.example.se"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </Field>
      <FormHint attached>
        Tilläggets adress. Nav hämtar manifestet från adressen följt av /nav-plugin.json. Adressen måste skilja sig från Navs egen.
      </FormHint>
      <FormActions style={{ justifyContent: "space-between" }}>
        <Button type="button" variant="secondary" disabled={pending || baseUrl.trim() === ""} onClick={() => fileInput.current?.click()}>
          Ladda upp manifest…
        </Button>
        <Button type="submit" variant="primary" disabled={pending || baseUrl.trim() === ""}>
          {pending ? "Hämtar…" : "Hämta manifest"}
        </Button>
      </FormActions>
      <FormHint>Ladda upp manifest används när tillägget inte kan nås från Nav – ange ändå dess adress ovan.</FormHint>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className={styles.hidden}
        aria-label="Manifestfil"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void uploadManifest(file);
        }}
      />
      <FormActions>
        <Button type="button" variant="ghost" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </form>
  );
}
