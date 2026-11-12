"use client";

import { useState } from "react";
import { useCan } from "../PermissionsProvider";
import { confirmDialog } from "../../lib/confirm";
import type { PlanningOrdersResult } from "../../lib/types";
import { apiFetch } from "../../lib/api";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { GatedLink } from "../ui/GatedLink";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import {
  ALERTS_EMPTY_TEXT,
  formatAlertTime,
  type AlertGroup,
  type AlertKind,
  type AlertsResponse,
  type AlertItem,
  type AlertSupplierSection,
  supplierSections,
} from "../../lib/alerts";
import styles from "./AlertsPageClient.module.css";
import { apiErrorMessage } from "../../lib/errorMessages";

interface Props {
  initial: AlertsResponse;
  digest: { enabled: boolean; kinds: AlertKind[] | null };
  email: string;
  /** HH:MM, or null when the user may not read the system setting. */
  digestTime: string | null;
  /** Only ever true for an administrator (the SMTP settings are admin data). */
  smtpMissing: boolean;
}

export function AlertsPageClient({ initial, digest, email, digestTime, smtpMissing }: Props) {
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
      setRefreshError(apiErrorMessage(err, "Kunde inte uppdatera aviseringarna"));
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
      setSaveError(apiErrorMessage(err, "Kunde inte spara inställningen"));
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

  // Skapa inköpsorder (Behöver beställas): the picked rows' proposals go to
  // the same route as behovsberäkningens Skapa ordrar.
  const canOrder = useCan()(["inkop", "tillverkning"]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<PlanningOrdersResult | null>(null);

  function togglePicked(keys: string[], on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of keys) (on ? next.add(k) : next.delete(k));
      return next;
    });
  }

  async function createOrders() {
    const needed = alerts.groups.find((g) => g.kind === "purchase_needed");
    const items = (needed?.items ?? []).filter((i) => picked.has(i.key) && i.proposals?.length);
    if (items.length === 0) return;
    const ok = await confirmDialog(
      `Skapa inköpsorder för ${items.length} ${items.length === 1 ? "artikel" : "artiklar"}? En inköpsorder skapas per leverantör, köp och lego var för sig.`,
      { confirmLabel: "Skapa inköpsorder" }
    );
    if (!ok) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch<PlanningOrdersResult>("/api/v1/planning/orders", {
        method: "POST",
        body: JSON.stringify({ proposals: items.flatMap((i) => i.proposals ?? []) }),
      });
      setCreated(res);
      setPicked(new Set());
      await refresh();
    } catch (err) {
      setCreateError(apiErrorMessage(err, "Kunde inte skapa inköpsorder"));
    } finally {
      setCreating(false);
    }
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

      {created && (
        <section className={styles.group}>
          <h2 className={styles.groupTitle}>Skapade inköpsorder</h2>
          {created.purchaseOrders.length === 0 && <p className={styles.hint}>Inga inköpsorder skapades.</p>}
          {created.purchaseOrders.map((po) => (
            <GatedLink key={po.id} href={`/inkop/ordrar/${po.id}`} className={styles.row}>
              <span className={styles.primary}>
                {po.orderNumber} – {po.supplierName} ({po.rowCount} {po.rowCount === 1 ? "rad" : "rader"})
              </span>
            </GatedLink>
          ))}
          {created.warnings.map((w, i) => (
            <p key={`w-${i}`} className={styles.warning}>
              {w.orderNumber} · {w.articleNumber}: {w.message}
            </p>
          ))}
          {created.errors.map((e, i) => (
            <p key={`e-${i}`} className={styles.error}>
              {e.articleNumber} — {e.message}
            </p>
          ))}
        </section>
      )}

      {everythingEmpty ? (
        <p className={styles.empty}>{ALERTS_EMPTY_TEXT}</p>
      ) : (
        alerts.groups
          .filter((g) => g.count > 0 || g.error)
          .map((group) =>
            group.kind === "purchase_needed" && group.supplierGroups ? (
              <PurchaseNeededCard
                key={group.kind}
                group={group}
                canOrder={canOrder}
                picked={picked}
                onToggle={togglePicked}
                creating={creating}
                error={createError}
                onCreate={() => void createOrders()}
              />
            ) : (
              <GroupCard key={group.kind} group={group} />
            )
          )
      )}

      <section className={styles.digest} aria-labelledby="digest-heading">
        <h2 id="digest-heading" className={styles.digestTitle}>
          Daglig sammanställning via e-post
        </h2>
        <label className={styles.check}>
          <Checkbox
            checked={enabled}
            disabled={saving}
            onChange={(e) => void saveDigest({ alertDigest: e.target.checked })}
          />
          <span>Skicka mig en sammanställning varje arbetsdag</span>
        </label>
        <p className={styles.hint}>
          Sammanställningen skickas till {email || "din e-postadress"}
          {digestTime ? ` klockan ${digestTime}` : ""} på arbetsdagar, och bara när det finns något att bevaka.
        </p>
        {!email && (
          <p className={styles.warning}>Ditt konto saknar e-postadress, så ingen sammanställning kan skickas.</p>
        )}
        {smtpMissing && (
          <p className={styles.warning}>
            Ingen SMTP-server är konfigurerad, så inga sammanställningar skickas. Ställ in den under System →
            Inställningar → E-post (SMTP).
          </p>
        )}
        <fieldset className={styles.kinds} disabled={saving || !enabled}>
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

function AlertRow({ item, checkbox }: { item: AlertItem; checkbox?: React.ReactNode }) {
  const content = (
    <>
      <span className={styles.marker} data-tone={item.severity} aria-hidden="true" />
      <span className={styles.texts}>
        <span className={styles.primary}>{item.primary}</span>
        {item.secondary && <span className={styles.secondary}>{item.secondary}</span>}
      </span>
    </>
  );
  const link =
    item.href === null ? (
      <span className={styles.row}>{content}</span>
    ) : (
      <GatedLink href={item.href} className={styles.row}>
        {content}
      </GatedLink>
    );
  if (!checkbox) return link;
  return (
    <div className={styles.pickRow}>
      {checkbox}
      {link}
    </div>
  );
}

function PurchaseNeededCard({
  group,
  canOrder,
  picked,
  onToggle,
  creating,
  error,
  onCreate,
}: {
  group: AlertGroup;
  canOrder: boolean;
  picked: Set<string>;
  onToggle: (keys: string[], on: boolean) => void;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  const sections = supplierSections(group);
  const pickedCount = group.items.filter((i) => picked.has(i.key)).length;
  return (
    <section className={styles.group}>
      <header className={styles.groupHeader}>
        <span className={styles.marker} data-tone={group.severity} aria-hidden="true" />
        <h2 className={styles.groupTitle}>{group.label}</h2>
        <span className={styles.count}>{group.count}</span>
        {canOrder && pickedCount > 0 && (
          <Button type="button" size="small" disabled={creating} onClick={onCreate}>
            {creating ? "Skapar…" : `Skapa inköpsorder (${pickedCount})`}
          </Button>
        )}
      </header>
      {error && <p className={styles.error}>{error}</p>}
      {sections.map((section) => (
        <SupplierSection
          key={section.group.key}
          section={section}
          canOrder={canOrder}
          picked={picked}
          onToggle={onToggle}
          listHref={group.listHref}
        />
      ))}
      <GatedLink href={group.listHref} className={styles.all}>
        Visa alla
      </GatedLink>
    </section>
  );
}

function SupplierSection({
  section,
  canOrder,
  picked,
  onToggle,
  listHref,
}: {
  section: AlertSupplierSection;
  canOrder: boolean;
  picked: Set<string>;
  onToggle: (keys: string[], on: boolean) => void;
  listHref: string;
}) {
  const { group: sg, items } = section;
  const none = sg.supplierId === null;
  const selectable = canOrder && !none;
  const keys = items.map((i) => i.key);
  const allPicked = keys.length > 0 && keys.every((k) => picked.has(k));
  const title = none ? "Utan förvald leverantör" : (sg.supplierName ?? "Leverantör");
  return (
    <div className={styles.supplierSection}>
      <div className={styles.supplierHeader}>
        {selectable && (
          <SelectAllCheckbox
            checked={allPicked}
            indeterminate={!allPicked && keys.some((k) => picked.has(k))}
            ariaLabel={`Markera alla för ${title}`}
            onChange={(on) => onToggle(keys, on)}
          />
        )}
        {none ? (
          <span className={styles.supplierName}>{title}</span>
        ) : (
          <GatedLink href={`/leverantorer/${sg.supplierId}`} className={styles.supplierName}>
            {title}
          </GatedLink>
        )}
        <span className={styles.count}>{sg.count}</span>
        {selectable && <span className={styles.hint}>Markera alla</span>}
      </div>
      {none && <p className={styles.hint}>Ange leverantör på artikelkortets flik Inköp.</p>}
      {items.map((item) => (
        <AlertRow
          key={item.key}
          item={item}
          checkbox={
            selectable ? (
              <Checkbox
                checked={picked.has(item.key)}
                aria-label={`Markera ${item.primary}`}
                onChange={(e) => onToggle([item.key], e.target.checked)}
              />
            ) : undefined
          }
        />
      ))}
      {sg.count > sg.shown && (
        <GatedLink href={listHref} className={styles.all}>
          + {sg.count - sg.shown} till
        </GatedLink>
      )}
    </div>
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
