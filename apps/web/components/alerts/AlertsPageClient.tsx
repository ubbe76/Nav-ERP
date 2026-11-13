"use client";

import { useEffect, useState } from "react";
import { useCan } from "../PermissionsProvider";
import { confirmDialog } from "../../lib/confirm";
import type { PlanningOrdersResult } from "../../lib/types";
import { apiFetch } from "../../lib/api";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { GatedLink } from "../ui/GatedLink";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import {
  ALERT_AREAS,
  ALERT_AREA_LABELS,
  ALERT_PREVIEW_ROWS,
  ALERTS_EMPTY_TEXT,
  alertAreaAnchor,
  alertAreaSections,
  alertGroupTone,
  alertKindAnchor,
  alertKindFromHash,
  formatAlertTime,
  previewSupplierSections,
  type AlertAreaSection,
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

  // Fem + Visa fler: the kinds unfolded on the page. A kind named in the
  // address (#typ-<kind>, Översiktens Att bevaka) opens unfolded.
  const [expanded, setExpanded] = useState<Set<AlertKind>>(new Set());
  function setKindExpanded(kind: AlertKind, on: boolean) {
    setExpanded((prev) => {
      if (prev.has(kind) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }
  useEffect(() => {
    function fromHash() {
      const kind = alertKindFromHash(window.location.hash);
      if (kind) setKindExpanded(kind, true);
    }
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const areas = alertAreaSections(alerts.groups);
  const everythingEmpty = areas.length === 0;

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
        <>
          {areas.length > 1 && <AreaNav areas={areas} />}
          {areas.map((section) => (
            <section
              key={section.area}
              id={alertAreaAnchor(section.area)}
              className={styles.area}
              aria-labelledby={`${alertAreaAnchor(section.area)}-rubrik`}
            >
              <h2 id={`${alertAreaAnchor(section.area)}-rubrik`} className={styles.areaTitle}>
                <span className={styles.marker} data-tone={section.tone} aria-hidden="true" />
                {section.label}
                <span className={styles.areaCount}>{section.count}</span>
              </h2>
              {section.groups.map((group) =>
                group.kind === "purchase_needed" && group.supplierGroups ? (
                  <PurchaseNeededCard
                    key={group.kind}
                    group={group}
                    expanded={expanded.has(group.kind)}
                    onExpand={(on) => setKindExpanded(group.kind, on)}
                    canOrder={canOrder}
                    picked={picked}
                    onToggle={togglePicked}
                    creating={creating}
                    error={createError}
                    onCreate={() => void createOrders()}
                  />
                ) : (
                  <GroupCard
                    key={group.kind}
                    group={group}
                    expanded={expanded.has(group.kind)}
                    onExpand={(on) => setKindExpanded(group.kind, on)}
                  />
                )
              )}
            </section>
          ))}
        </>
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
          {ALERT_AREAS.map((area) => {
            const inArea = alerts.groups.filter((g) => g.area === area);
            if (inArea.length === 0) return null;
            return (
              <div key={area} className={styles.kindArea}>
                <div className={styles.kindAreaTitle}>{ALERT_AREA_LABELS[area]}</div>
                {inArea.map((g) => (
                  <label key={g.kind} className={styles.check}>
                    <Checkbox checked={isChecked(g.kind)} onChange={() => toggleKind(g.kind)} />
                    <span>{g.label}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </fieldset>
        {saveError && <p className={styles.error}>{saveError}</p>}
      </section>
    </>
  );
}

// Hoppa till område: one link per area with something to show.
function AreaNav({ areas }: { areas: AlertAreaSection[] }) {
  return (
    <nav className={styles.areaNav} aria-label="Områden">
      {areas.map((section) => (
        <a key={section.area} href={`#${alertAreaAnchor(section.area)}`} className={styles.areaLink}>
          <span className={styles.marker} data-tone={section.tone} aria-hidden="true" />
          {section.label}
          <span className={styles.areaLinkCount}>{section.count}</span>
        </a>
      ))}
    </nav>
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

// The kind's heading: marker, label and count. The id is the anchor
// Översiktens Att bevaka links to.
function KindHeader({ group, children }: { group: AlertGroup; children?: React.ReactNode }) {
  return (
    <header className={styles.groupHeader}>
      <span className={styles.marker} data-tone={alertGroupTone(group)} aria-hidden="true" />
      <h3 className={styles.groupTitle}>{group.label}</h3>
      <span className={styles.count}>{group.error ? "–" : group.count}</span>
      {children}
    </header>
  );
}

// Visa fler (N) / Visa färre, then Öppna listan (the kind's own list page).
function KindFooter({
  group,
  hidden,
  expanded,
  onExpand,
}: {
  group: AlertGroup;
  hidden: number;
  expanded: boolean;
  onExpand: (on: boolean) => void;
}) {
  const foldable = group.items.length > ALERT_PREVIEW_ROWS;
  return (
    <div className={styles.footer}>
      {foldable && (
        <button
          type="button"
          className={styles.more}
          aria-expanded={expanded}
          aria-controls={`${alertKindAnchor(group.kind)}-rader`}
          onClick={() => onExpand(!expanded)}
        >
          {expanded ? "Visa färre" : `Visa fler (${hidden})`}
        </button>
      )}
      <GatedLink href={group.listHref} className={styles.all}>
        Öppna listan
      </GatedLink>
    </div>
  );
}

function PurchaseNeededCard({
  group,
  expanded,
  onExpand,
  canOrder,
  picked,
  onToggle,
  creating,
  error,
  onCreate,
}: {
  group: AlertGroup;
  expanded: boolean;
  onExpand: (on: boolean) => void;
  canOrder: boolean;
  picked: Set<string>;
  onToggle: (keys: string[], on: boolean) => void;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  const sections = supplierSections(group);
  const visible = expanded ? sections : previewSupplierSections(sections, ALERT_PREVIEW_ROWS);
  const visibleCount = visible.reduce((sum, s) => sum + s.items.length, 0);
  const pickedCount = group.items.filter((i) => picked.has(i.key)).length;
  return (
    <section id={alertKindAnchor(group.kind)} className={styles.group}>
      <KindHeader group={group}>
        {canOrder && pickedCount > 0 && (
          <Button type="button" size="small" disabled={creating} onClick={onCreate}>
            {creating ? "Skapar…" : `Skapa inköpsorder (${pickedCount})`}
          </Button>
        )}
      </KindHeader>
      {error && <p className={styles.error}>{error}</p>}
      <div id={`${alertKindAnchor(group.kind)}-rader`}>
        {visible.map((section) => (
          <SupplierSection
            key={section.group.key}
            section={section}
            // Markera alla picks the supplier's every row, also the folded
            // ones — so it unfolds the card: nothing is picked out of sight.
            allItems={sections.find((s) => s.group.key === section.group.key)?.items ?? section.items}
            complete={expanded}
            canOrder={canOrder}
            picked={picked}
            onToggle={onToggle}
            onPickAll={() => onExpand(true)}
            listHref={group.listHref}
          />
        ))}
      </div>
      <KindFooter group={group} hidden={group.items.length - visibleCount} expanded={expanded} onExpand={onExpand} />
    </section>
  );
}

function SupplierSection({
  section,
  allItems,
  complete,
  canOrder,
  picked,
  onToggle,
  onPickAll,
  listHref,
}: {
  section: AlertSupplierSection;
  /** The supplier's every row in the response (section.items may be folded). */
  allItems: AlertItem[];
  /** The card is unfolded — "+ N till" only then. */
  complete: boolean;
  canOrder: boolean;
  picked: Set<string>;
  onToggle: (keys: string[], on: boolean) => void;
  onPickAll: () => void;
  listHref: string;
}) {
  const { group: sg, items } = section;
  const none = sg.supplierId === null;
  const selectable = canOrder && !none;
  const keys = allItems.map((i) => i.key);
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
            onChange={(on) => {
              if (on) onPickAll();
              onToggle(keys, on);
            }}
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
      {complete && sg.count > sg.shown && (
        <GatedLink href={listHref} className={styles.all}>
          + {sg.count - sg.shown} till
        </GatedLink>
      )}
    </div>
  );
}

function GroupCard({
  group,
  expanded,
  onExpand,
}: {
  group: AlertGroup;
  expanded: boolean;
  onExpand: (on: boolean) => void;
}) {
  const visible = expanded ? group.items : group.items.slice(0, ALERT_PREVIEW_ROWS);
  return (
    <section id={alertKindAnchor(group.kind)} className={styles.group}>
      <KindHeader group={group} />
      {group.error ? (
        <p className={styles.error}>{group.message ?? "Kunde inte läsa den här typen av aviseringar."}</p>
      ) : (
        <>
          <div id={`${alertKindAnchor(group.kind)}-rader`}>
            {visible.map((item) => (
              <AlertRow key={item.key} item={item} />
            ))}
          </div>
          <KindFooter group={group} hidden={group.items.length - visible.length} expanded={expanded} onExpand={onExpand} />
        </>
      )}
    </section>
  );
}
