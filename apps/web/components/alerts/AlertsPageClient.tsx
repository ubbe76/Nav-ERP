"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { GatedLink } from "../ui/GatedLink";
import {
  ALERTS_EMPTY_TEXT,
  formatAlertTime,
  type AlertGroup,
  type AlertKind,
  type AlertsResponse,
} from "../../lib/alerts";
import styles from "./AlertsPageClient.module.css";

interface Props {
  initial: AlertsResponse;
  digest: { enabled: boolean; kinds: AlertKind[] | null };
  email: string;
  readOnly: boolean;
  /** HH:MM, or null when the user may not read the system setting. */
  digestTime: string | null;
  /** Only ever true for an administrator (the SMTP settings are admin data). */
  smtpMissing: boolean;
}

export function AlertsPageClient({ initial, digest, email, readOnly, digestTime, smtpMissing }: Props) {
  const [alerts, setAlerts] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(digest.enabled);
  const [kinds, setKinds] = useState<AlertKind[] | null>(digest.kinds);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      setAlerts(await apiFetch<AlertsResponse>("/api/v1/alerts"));
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Kunde inte uppdatera aviseringarna");
    } finally {
      setRefreshing(false);
    }
  }

  async function saveDigest(body: { alertDigest?: boolean; alertDigestKinds?: AlertKind[] | null }) {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiFetch<{ alertDigest: boolean; alertDigestKinds: AlertKind[] | null }>("/api/v1/me/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setEnabled(updated.alertDigest);
      setKinds(updated.alertDigestKinds);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Kunde inte spara inställningen");
    } finally {
      setSaving(false);
    }
  }

  // The groups in the response are exactly the kinds this user may see.
  const visibleKinds = alerts.groups.map((g) => g.kind);
  const isChecked = (kind: AlertKind) => kinds === null || kinds.includes(kind);

  function toggleKind(kind: AlertKind) {
    const current = visibleKinds.filter(isChecked);
    const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind];
    // Every visible kind ticked = "all", which keeps following new kinds.
    void saveDigest({ alertDigestKinds: next.length === visibleKinds.length ? null : next });
  }

  const everythingEmpty = alerts.groups.every((g) => g.count === 0 && !g.error);

  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.computed}>Beräknad {formatAlertTime(alerts.computedAt)}</span>
        <Button type="button" variant="secondary" size="small" disabled={refreshing} onClick={refresh}>
          {refreshing ? "Uppdaterar…" : "Uppdatera"}
        </Button>
        {refreshError && <span className={styles.error}>{refreshError}</span>}
      </div>

      {everythingEmpty ? (
        <p className={styles.empty}>{ALERTS_EMPTY_TEXT}</p>
      ) : (
        alerts.groups
          .filter((g) => g.count > 0 || g.error)
          .map((group) => <GroupCard key={group.kind} group={group} />)
      )}

      <section className={styles.digest} aria-labelledby="digest-heading">
        <h2 id="digest-heading" className={styles.digestTitle}>
          Daglig sammanställning via e-post
        </h2>
        <label className={styles.check}>
          <Checkbox
            checked={enabled}
            disabled={readOnly || saving}
            onChange={(e) => void saveDigest({ alertDigest: e.target.checked })}
          />
          <span>Skicka mig en sammanställning varje arbetsdag</span>
        </label>
        <p className={styles.hint}>
          Sammanställningen skickas till {email || "din e-postadress"}
          {digestTime ? ` klockan ${digestTime}` : ""} på arbetsdagar, och bara när det finns något att bevaka.
        </p>
        {readOnly && (
          <p className={styles.hint}>Ditt konto har Endast läsning, så sammanställningen kan inte ändras.</p>
        )}
        {!email && (
          <p className={styles.warning}>Ditt konto saknar e-postadress, så ingen sammanställning kan skickas.</p>
        )}
        {smtpMissing && (
          <p className={styles.warning}>
            Ingen SMTP-server är konfigurerad, så inga sammanställningar skickas. Ställ in den under System →
            Inställningar → E-post (SMTP).
          </p>
        )}
        <fieldset className={styles.kinds} disabled={readOnly || saving || !enabled}>
          <legend className={styles.legend}>Ta med</legend>
          {alerts.groups.map((g) => (
            <label key={g.kind} className={styles.check}>
              <Checkbox checked={isChecked(g.kind)} onChange={() => toggleKind(g.kind)} />
              <span>{g.label}</span>
            </label>
          ))}
        </fieldset>
        {saveError && <p className={styles.error}>{saveError}</p>}
      </section>
    </>
  );
}

function GroupCard({ group }: { group: AlertGroup }) {
  return (
    <section className={styles.group}>
      <header className={styles.groupHeader}>
        <span className={styles.marker} data-tone={group.severity} aria-hidden="true" />
        <h2 className={styles.groupTitle}>{group.label}</h2>
        <span className={styles.count}>{group.error ? "–" : group.count}</span>
      </header>
      {group.error ? (
        <p className={styles.error}>{group.message ?? "Kunde inte läsa den här typen av aviseringar."}</p>
      ) : (
        <>
          {group.items.map((item) => {
            const content = (
              <>
                <span className={styles.marker} data-tone={item.severity} aria-hidden="true" />
                <span className={styles.texts}>
                  <span className={styles.primary}>{item.primary}</span>
                  {item.secondary && <span className={styles.secondary}>{item.secondary}</span>}
                </span>
              </>
            );
            return item.href === null ? (
              <span key={item.key} className={styles.row}>
                {content}
              </span>
            ) : (
              <GatedLink key={item.key} href={item.href} className={styles.row}>
                {content}
              </GatedLink>
            );
          })}
          <GatedLink href={group.listHref} className={styles.all}>
            Visa alla
          </GatedLink>
        </>
      )}
    </section>
  );
}
