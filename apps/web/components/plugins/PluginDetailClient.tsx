"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { formatStockholmDateTime } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { PERMISSION_LABELS, type Permission } from "../../lib/permissions";
import {
  PLUGIN_DELIVERY_STATUS_LABELS,
  PLUGIN_STATUS_LABELS,
  pluginEventLabel,
  type PluginDeliveryRow,
  type PluginDetail,
  type PluginInstallResult,
  type PluginManifest,
  type PluginPreview,
  type PluginTestEventResult,
} from "../../lib/plugins";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { ManifestSummary } from "./ManifestSummary";
import { normalizePermissions, PermissionBoxes } from "./PermissionBoxes";
import { effectivePermissionsOf } from "./effective";
import { SecretsPanel } from "./SecretsPanel";
import styles from "./Plugins.module.css";

const DELIVERY_STATUS: Record<PluginDeliveryRow["status"], "done" | "draft" | "stopped"> = {
  delivered: "done",
  pending: "draft",
  failed: "stopped",
};

// Differences between the installed manifest and a fetched one, as lines.
function manifestDiff(current: PluginManifest, next: PluginManifest): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const compare = (label: string, a: string[], b: string[]) => {
    for (const x of b) if (!a.includes(x)) added.push(`${label}: ${x}`);
    for (const x of a) if (!b.includes(x)) removed.push(`${label}: ${x}`);
  };
  compare("Begärd rättighet", effectivePermissionsOf(current.permissions).map((p) => PERMISSION_LABELS[p]), effectivePermissionsOf(next.permissions).map((p) => PERMISSION_LABELS[p]));
  compare("Händelse", (current.webhook?.events ?? []).map(pluginEventLabel), (next.webhook?.events ?? []).map(pluginEventLabel));
  compare("Sida", current.pages.map((p) => p.title), next.pages.map((p) => p.title));
  compare("Flik", current.tabs.map((t) => t.title), next.tabs.map((t) => t.title));
  if (current.readOnly !== next.readOnly) {
    (next.readOnly ? added : removed).push("Begär Endast läsning");
  }
  return { added, removed };
}

export function PluginDetailClient({
  initialPlugin,
  initialDeliveries,
}: {
  initialPlugin: PluginDetail;
  initialDeliveries: PluginDeliveryRow[];
}) {
  const router = useRouter();
  const [plugin, setPlugin] = useState(initialPlugin);
  const [deliveries, setDeliveries] = useState(initialDeliveries);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<Set<Permission>>(new Set(normalizePermissions(initialPlugin.permissions)));
  const [readOnly, setReadOnly] = useState(initialPlugin.readOnly);
  const [secrets, setSecrets] = useState<{ apiKey?: string; webhookSecret?: string } | null>(null);
  const [testResult, setTestResult] = useState<PluginTestEventResult | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);

  const permissionsDirty = useMemo(() => {
    const saved = new Set(normalizePermissions(plugin.permissions));
    return readOnly !== plugin.readOnly || saved.size !== permissions.size || [...permissions].some((p) => !saved.has(p));
  }, [plugin, permissions, readOnly]);

  // Requested by the manifest but not granted – shown as a hint, never added silently.
  const notGranted = useMemo(() => {
    const granted = new Set(plugin.effectivePermissions);
    return effectivePermissionsOf(plugin.manifest.permissions).filter((p) => !granted.has(p));
  }, [plugin]);

  async function run<T>(action: () => Promise<T>, fallback: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      return await action();
    } catch (err) {
      setError(apiErrorMessage(err, fallback));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function adopt(next: PluginDetail) {
    setPlugin(next);
    setPermissions(new Set(normalizePermissions(next.permissions)));
    setReadOnly(next.readOnly);
    router.refresh();
  }

  async function reloadDeliveries() {
    setDeliveries(await apiFetch<PluginDeliveryRow[]>(`/api/v1/plugins/${plugin.id}/deliveries`));
    setPlugin(await apiFetch<PluginDetail>(`/api/v1/plugins/${plugin.id}`));
  }

  async function patch(body: Record<string, unknown>, fallback: string) {
    const next = await run(() => apiFetch<PluginDetail>(`/api/v1/plugins/${plugin.id}`, { method: "PATCH", body: JSON.stringify(body) }), fallback);
    if (next) {
      adopt(next);
      setSaved(true);
    }
    return next;
  }

  async function toggleStatus() {
    await patch({ status: plugin.status === "active" ? "paused" : "active" }, "Kunde inte ändra status");
  }

  async function rotateKey() {
    if (
      !(await confirmDialog("Den gamla API-nyckeln slutar fungera direkt. Tillägget måste få den nya nyckeln innan det kan läsa Nav igen.", {
        confirmLabel: "Skapa ny nyckel",
        danger: true,
      }))
    )
      return;
    const result = await run(() => apiFetch<{ plugin: PluginDetail; apiKey: string }>(`/api/v1/plugins/${plugin.id}/rotate-key`, { method: "POST" }), "Kunde inte skapa ny API-nyckel");
    if (result) {
      adopt(result.plugin);
      setSecrets({ apiKey: result.apiKey });
    }
  }

  async function rotateSecret() {
    if (
      !(await confirmDialog("Den gamla webbhookshemligheten slutar gälla direkt. Händelser går inte att verifiera förrän tillägget fått den nya.", {
        confirmLabel: "Skapa ny hemlighet",
        danger: true,
      }))
    )
      return;
    const result = await run(
      () => apiFetch<{ plugin: PluginDetail; webhookSecret: string }>(`/api/v1/plugins/${plugin.id}/rotate-secret`, { method: "POST" }),
      "Kunde inte skapa ny webbhookshemlighet"
    );
    if (result) {
      adopt(result.plugin);
      setSecrets({ webhookSecret: result.webhookSecret });
    }
  }

  async function sendTest() {
    setTestResult(null);
    const result = await run(() => apiFetch<PluginTestEventResult>(`/api/v1/plugins/${plugin.id}/test-event`, { method: "POST" }), "Kunde inte skicka testhändelsen");
    if (result) {
      setTestResult(result);
      await reloadDeliveries().catch(() => {});
    }
  }

  async function retry(delivery: PluginDeliveryRow) {
    const row = await run(
      () => apiFetch<PluginDeliveryRow>(`/api/v1/plugins/${plugin.id}/deliveries/${delivery.id}/retry`, { method: "POST" }),
      "Kunde inte skicka igen"
    );
    if (row) {
      await reloadDeliveries().catch(() => {});
      // The delivery job picks the row up shortly; look again once.
      setTimeout(() => void reloadDeliveries().catch(() => {}), 4000);
    }
  }

  async function uninstall() {
    if (
      !(await confirmDelete(
        `Avinstallera ${plugin.name}? Tilläggets händelser, leveranser och behörighetsgrupp tas bort och API-nyckeln slutar fungera direkt.`
      ))
    )
      return;
    const done = await run(async () => {
      await apiFetch(`/api/v1/plugins/${plugin.id}`, { method: "DELETE" });
      return true;
    }, "Kunde inte avinstallera tillägget");
    if (done) {
      router.push("/system/tillagg");
      router.refresh();
    }
  }

  return (
    <>
      <FormError>{error}</FormError>

      <div className={styles.section}>
        <div className={styles.facts}>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Status</span>
            <span className={styles.factValue}>
              <StatusPill status={plugin.status === "active" ? "done" : "draft"} label={PLUGIN_STATUS_LABELS[plugin.status]} />
            </span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Adress</span>
            <span className={styles.factValue}>{plugin.baseUrl}</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Installerat</span>
            <span className={styles.factValue}>
              {formatStockholmDateTime(plugin.installedAt)}
            </span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>API-nyckel</span>
            <span className={`${styles.factValue} ${styles.mono}`}>{plugin.apiKeyPrefix}…</span>
          </div>
        </div>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" disabled={busy} onClick={toggleStatus}>
            {plugin.status === "active" ? "Pausa" : "Aktivera"}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setUpdateOpen(true)}>
            Uppdatera manifest
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={rotateKey}>
            Ny API-nyckel
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={rotateSecret}>
            Ny webbhookshemlighet
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={sendTest}>
            Skicka testhändelse
          </Button>
        </div>
        {plugin.status === "paused" && (
          <FormNotice>
            Tillägget är pausat: dess sidor och flikar visas inte och händelserna väntar tills du väljer Aktivera.
          </FormNotice>
        )}
        {testResult && (
          <FormNotice>
            {testResult.delivered
              ? `Testhändelsen levererades (svarskod ${testResult.statusCode ?? "–"}).`
              : `Testhändelsen levererades inte${testResult.statusCode ? ` (svarskod ${testResult.statusCode})` : ""}${testResult.error ? `: ${testResult.error}` : ""}.`}
          </FormNotice>
        )}
      </div>

      <div className={styles.section}>
        <SectionHeading>Manifest</SectionHeading>
        <ManifestSummary manifest={plugin.manifest} />
      </div>

      <div className={styles.section}>
        <SectionHeading>Rättigheter</SectionHeading>
        <FormHint attached>
          Tilläggets behörighetsgrupp. Ändringen gäller direkt, även för händelser som väntar på leverans.
        </FormHint>
        {notGranted.length > 0 && (
          <FormNotice>
            Manifestet begär även {notGranted.map((p) => PERMISSION_LABELS[p]).join(", ")}, som tillägget inte har fått. Kryssa i dem här om du vill ge dem.
          </FormNotice>
        )}
        <PermissionBoxes value={permissions} onChange={setPermissions} idPrefix="plugin-perm" />
        <label className={styles.check}>
          <Checkbox checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          Endast läsning
        </label>
        <FormActions>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !permissionsDirty}
            onClick={() => patch({ permissions: [...permissions], readOnly }, "Kunde inte spara rättigheterna")}
          >
            Spara rättigheter
          </Button>
          {saved && !permissionsDirty && <span className={styles.mutedLine}>Sparat</span>}
        </FormActions>
      </div>

      <div className={styles.section}>
        <SectionHeading
          actions={
            <Button type="button" variant="secondary" size="small" onClick={() => void reloadDeliveries()}>
              Uppdatera
            </Button>
          }
        >
          Leveranser
        </SectionHeading>
        <FormHint attached>
          De senaste 100 händelserna. {plugin.pendingDeliveries > 0 ? `${plugin.pendingDeliveries} väntar på leverans. ` : ""}Misslyckade försök görs om
          automatiskt; efter sju försök ger Nav upp och du kan välja Skicka igen.
        </FormHint>
        <Table
          columns={[
            { key: "event", label: "Händelse", width: "minmax(160px, 1.4fr)" },
            { key: "number", label: "Post", width: "110px" },
            { key: "occurred", label: "Inträffade", width: "150px" },
            { key: "status", label: "Status", width: "120px" },
            { key: "attempts", label: "Försök", width: "70px", align: "right" },
            { key: "result", label: "Senaste svar", width: "minmax(160px, 1.4fr)" },
            { key: "actions", label: "", width: "110px" },
          ]}
          rows={deliveries}
          emptyText="Inga leveranser ännu"
          renderCell={(d, key) => {
            switch (key) {
              case "event":
                return pluginEventLabel(d.eventType);
              case "number":
                return d.entityNumber ?? "–";
              case "occurred":
                return formatStockholmDateTime(d.occurredAt);
              case "status":
                return <StatusPill status={DELIVERY_STATUS[d.status]} label={PLUGIN_DELIVERY_STATUS_LABELS[d.status]} />;
              case "attempts":
                return d.attempts;
              case "result":
                return (
                  <span className={styles.mutedLine}>
                    {d.lastError ?? (d.lastStatusCode ? `Svarskod ${d.lastStatusCode}` : "–")}
                    {d.status === "pending" && d.nextAttemptAt ? ` · nästa försök ${formatStockholmDateTime(d.nextAttemptAt)}` : ""}
                  </span>
                );
              default:
                return d.status === "failed" ? (
                  <Button type="button" variant="secondary" size="small" disabled={busy} onClick={() => retry(d)}>
                    Skicka igen
                  </Button>
                ) : null;
            }
          }}
        />
      </div>

      <div className={styles.section}>
        <SectionHeading>Avinstallera</SectionHeading>
        <FormHint attached>
          Tar bort tillägget, dess händelser och leveranser och behörighetsgruppen. Den tekniska användaren tas bort ur användarregistret.
        </FormHint>
        <div className={styles.actions}>
          <Button type="button" variant="danger" disabled={busy} onClick={uninstall}>
            Avinstallera
          </Button>
        </div>
      </div>

      <Modal open={secrets !== null} onClose={() => setSecrets(null)} title="Ny nyckel" wide>
        {secrets && (
          <div className={styles.body}>
            <SecretsPanel apiKey={secrets.apiKey} webhookSecret={secrets.webhookSecret} />
            <FormActions>
              <Button type="button" variant="primary" onClick={() => setSecrets(null)}>
                Klar
              </Button>
            </FormActions>
          </div>
        )}
      </Modal>

      <Modal open={updateOpen} onClose={() => setUpdateOpen(false)} title="Uppdatera manifest" wide>
        <UpdateManifest
          plugin={plugin}
          onClose={() => setUpdateOpen(false)}
          onUpdated={(next) => {
            setUpdateOpen(false);
            adopt(next);
            setSaved(false);
          }}
        />
      </Modal>
    </>
  );
}

function UpdateManifest({
  plugin,
  onClose,
  onUpdated,
}: {
  plugin: PluginDetail;
  onClose: () => void;
  onUpdated: (next: PluginDetail) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(plugin.baseUrl);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchAgain() {
    setPending(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await apiFetch<PluginPreview>("/api/v1/plugins/preview", { method: "POST", body: JSON.stringify({ baseUrl }) }));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta manifestet"));
    }
    setPending(false);
  }

  async function save() {
    if (!preview?.manifest || !preview.baseUrl) return;
    setPending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { manifest: preview.manifest };
      if (preview.baseUrl !== plugin.baseUrl) body.baseUrl = preview.baseUrl;
      onUpdated(await apiFetch<PluginDetail>(`/api/v1/plugins/${plugin.id}`, { method: "PATCH", body: JSON.stringify(body) }));
    } catch (err) {
      const b = (err as { body?: { errors?: string[] } }).body;
      setError([apiErrorMessage(err, "Kunde inte uppdatera manifestet"), ...(b?.errors ?? [])].join(" "));
      setPending(false);
    }
  }

  const diff = preview?.ok && preview.manifest ? manifestDiff(plugin.manifest, preview.manifest) : null;

  return (
    <div className={styles.body}>
      <FormError>{error}</FormError>
      <Field label="Adress" htmlFor="update-plugin-url">
        <Input id="update-plugin-url" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <div className={styles.actions}>
        <Button type="button" variant="secondary" disabled={pending || baseUrl.trim() === ""} onClick={fetchAgain}>
          {pending && !preview ? "Hämtar…" : "Hämta manifest"}
        </Button>
      </div>
      {preview && !preview.ok && (
        <>
          <FormError>Manifestet kan inte användas:</FormError>
          <ul className={styles.list}>
            {preview.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      )}
      {preview && preview.warnings.length > 0 && (
        <FormNotice>
          <ul className={styles.list}>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </FormNotice>
      )}
      {preview && preview.manifest && preview.manifest.key !== plugin.key && (
        <FormError>Manifestets nyckel ({preview.manifest.key}) är en annan än tilläggets ({plugin.key}).</FormError>
      )}
      {diff && (
        <div className={styles.body}>
          <SectionHeading>Skillnader mot det installerade</SectionHeading>
          {diff.added.length === 0 && diff.removed.length === 0 ? (
            <p className={styles.mutedLine}>Inga skillnader i rättigheter, händelser, sidor eller flikar.</p>
          ) : (
            <ul className={styles.list}>
              {diff.added.map((a) => (
                <li key={`a-${a}`} className={styles.diffAdd}>
                  Tillkommer – {a}
                </li>
              ))}
              {diff.removed.map((r) => (
                <li key={`r-${r}`} className={styles.diffRemove}>
                  Försvinner – {r}
                </li>
              ))}
            </ul>
          )}
          <FormHint>Nya begärda rättigheter läggs aldrig till av sig själva — ge dem under Rättigheter efteråt.</FormHint>
        </div>
      )}
      <FormActions style={{ justifyContent: "space-between" }}>
        <Button type="button" variant="ghost" onClick={onClose}>
          Avbryt
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={pending || !preview?.ok || preview.manifest?.key !== plugin.key}
          onClick={save}
        >
          {pending && preview ? "Sparar…" : "Spara manifest"}
        </Button>
      </FormActions>
    </div>
  );
}
