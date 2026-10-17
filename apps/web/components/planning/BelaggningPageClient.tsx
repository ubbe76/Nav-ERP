"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { StatusPill } from "../ui/StatusPill";
import { Select } from "../ui/Field";
import { ListFilterSelect, useListNavigation } from "../ui/ListControls";
import { FormError } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import type {
  CapacityCell,
  CapacityCellOrder,
  CapacityGroupBlock,
  CapacityResourceRow,
  CapacityResult,
  CapacityWeek,
  ProductionGroup,
} from "../../lib/types";
import styles from "./BelaggningPageClient.module.css";

const WEEK_OPTIONS = [4, 8, 13, 26];
const DEFAULT_WEEKS = 8;

function toneFor(loadPercent: number | null): "neutral" | "warn" | "alert" {
  if (loadPercent === null) return "neutral";
  if (loadPercent > 100) return "alert";
  if (loadPercent > 85) return "warn";
  return "neutral";
}

function formatHours(hours: number): string {
  return hours.toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

// Include the ISO year in the week label only when the horizon actually
// spans two of them (e.g. "v.1 2027") — otherwise it's just noise.
function weekLabel(week: CapacityWeek, spansMultipleYears: boolean): string {
  return spansMultipleYears ? `v.${week.isoWeek} ${week.isoYear}` : `v.${week.isoWeek}`;
}

// Which cell is currently expanded (drill-down row shown right under its
// resource). Carries the cell's own data — no re-fetch needed to render it.
interface ExpandedCell {
  key: string;
  workCenterId: string;
  label: string;
  cell: CapacityCell;
}

export function BelaggningPageClient() {
  const searchParams = useSearchParams();
  const { setFilter } = useListNavigation();
  const queryKey = searchParams.toString();

  const [groups, setGroups] = useState<ProductionGroup[]>([]);
  const [data, setData] = useState<CapacityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedCell | null>(null);

  useEffect(() => {
    apiFetch<ProductionGroup[]>("/api/v1/production-groups").then(setGroups).catch(() => setGroups([]));
  }, []);

  const weeksRaw = Number(searchParams.get("weeks"));
  const weeks = WEEK_OPTIONS.includes(weeksRaw) ? weeksRaw : DEFAULT_WEEKS;
  const productionGroupId = searchParams.get("productionGroupId") ?? "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setExpanded(null);
    const qs = new URLSearchParams({ weeks: String(weeks) });
    if (productionGroupId) qs.set("productionGroupId", productionGroupId);
    apiFetch<CapacityResult>(`/api/v1/planning/capacity?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setData(null);
        setLoadError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey mirrors weeks/productionGroupId
  }, [queryKey]);

  function toggleCell(resource: CapacityResourceRow, colKey: string, label: string, cell: CapacityCell) {
    if (cell.orders.length === 0) return;
    const key = `${resource.workCenterId}:${colKey}`;
    setExpanded((prev) => (prev?.key === key ? null : { key, workCenterId: resource.workCenterId, label, cell }));
  }

  const spansMultipleYears = data ? new Set(data.weeks.map((w) => w.isoYear)).size > 1 : false;
  const gridTemplateColumns = data ? `220px repeat(${data.weeks.length + 2}, minmax(96px, 1fr))` : undefined;

  return (
    <>
      <div className={styles.toolbar}>
        <ListFilterSelect
          param="productionGroupId"
          allLabel="Alla produktionsgrupper"
          ariaLabel="Filtrera på produktionsgrupp"
          options={groups.map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))}
        />
        <label htmlFor="weeksSelect" style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Veckor
        </label>
        <Select
          id="weeksSelect"
          size="xs"
          value={String(weeks)}
          onChange={(e) => setFilter("weeks", Number(e.target.value) === DEFAULT_WEEKS ? null : e.target.value)}
          aria-label="Antal veckor"
        >
          {WEEK_OPTIONS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </Select>
      </div>

      <FormError margin="below">{loadError}</FormError>

      {!loading && data && data.groups.length === 0 && <p>Inga släppta tillverkningsordrar med återstående tid.</p>}

      {data && data.groups.length > 0 && (
        <div className={styles.scroller}>
          <div className={styles.grid} style={{ gridTemplateColumns }}>
            <div className={styles.headerLabel}>Resurs</div>
            {data.weeks.map((w, i) => (
              <div key={i} className={styles.headerCell}>
                {weekLabel(w, spansMultipleYears)}
              </div>
            ))}
            <div className={styles.headerCell}>Senare</div>
            <div className={styles.headerCell}>Odaterat</div>

            {data.groups.map((group) => (
              <GroupBlock
                key={group.productionGroupId ?? "ungrouped"}
                group={group}
                weeks={data.weeks}
                spansMultipleYears={spansMultipleYears}
                expanded={expanded}
                onCellClick={toggleCell}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function GroupBlock({
  group,
  weeks,
  spansMultipleYears,
  expanded,
  onCellClick,
}: {
  group: CapacityGroupBlock;
  weeks: CapacityWeek[];
  spansMultipleYears: boolean;
  expanded: ExpandedCell | null;
  onCellClick: (resource: CapacityResourceRow, colKey: string, label: string, cell: CapacityCell) => void;
}) {
  return (
    <>
      <div className={styles.groupHeader}>{group.code ? `${group.code} · ${group.name}` : group.name}</div>

      {group.resources.map((resource) => (
        <ResourceBlock
          key={resource.workCenterId}
          resource={resource}
          weeks={weeks}
          spansMultipleYears={spansMultipleYears}
          expanded={expanded}
          onCellClick={onCellClick}
        />
      ))}

      <div className={styles.resourceLabel} data-summa="true">
        Summa
      </div>
      {group.weekTotals.map((cell, i) => (
        <CellView key={i} cell={cell} summa />
      ))}
      <CellView cell={group.laterTotal} summa />
      <CellView cell={group.undatedTotal} summa />
    </>
  );
}

function ResourceBlock({
  resource,
  weeks,
  spansMultipleYears,
  expanded,
  onCellClick,
}: {
  resource: CapacityResourceRow;
  weeks: CapacityWeek[];
  spansMultipleYears: boolean;
  expanded: ExpandedCell | null;
  onCellClick: (resource: CapacityResourceRow, colKey: string, label: string, cell: CapacityCell) => void;
}) {
  const isExpandedHere = expanded?.workCenterId === resource.workCenterId;
  const weekLabels = weeks.map((w) => weekLabel(w, spansMultipleYears));

  return (
    <>
      <div className={styles.resourceLabel}>
        <span>
          {resource.code} · {resource.name}
        </span>
        {resource.capacityFactor !== 1 && <span className={styles.factorBadge}>×{resource.capacityFactor}</span>}
        {!resource.hasSchedule && (
          <span className={styles.resourceMuted} title="Saknar veckoschema och timmar per dag">
            —
          </span>
        )}
        {!resource.active && <StatusPill status="draft" label="Inaktiv" compact />}
      </div>

      {resource.weeks.map((cell, i) => {
        const key = `week:${i}`;
        const label = weekLabels[i] ?? "";
        return (
          <CellView
            key={i}
            cell={cell}
            active={expanded?.key === `${resource.workCenterId}:${key}`}
            onClick={cell.orders.length > 0 ? () => onCellClick(resource, key, label, cell) : undefined}
          />
        );
      })}
      <CellView
        cell={resource.later}
        active={expanded?.key === `${resource.workCenterId}:later`}
        onClick={resource.later.orders.length > 0 ? () => onCellClick(resource, "later", "Senare", resource.later) : undefined}
      />
      <CellView
        cell={resource.undated}
        active={expanded?.key === `${resource.workCenterId}:undated`}
        onClick={
          resource.undated.orders.length > 0
            ? () => onCellClick(resource, "undated", "Odaterat", resource.undated)
            : undefined
        }
      />

      {isExpandedHere && expanded && (
        <ExpansionRow label={`${resource.code} · ${resource.name} — ${expanded.label}`} orders={expanded.cell.orders} />
      )}
    </>
  );
}

function CellContent({ cell }: { cell: CapacityCell }) {
  return (
    <>
      <span className={styles.cellHours}>
        {formatHours(cell.loadHours)}
        {cell.availableHours !== null && ` / ${formatHours(cell.availableHours)}`}
      </span>
      {cell.loadPercent !== null && (
        <>
          <span className={styles.cellPercent}>{cell.loadPercent}%</span>
          <div className={styles.fillTrack}>
            <div className={styles.fillBar} style={{ width: `${Math.min(cell.loadPercent, 100)}%` }} />
          </div>
        </>
      )}
    </>
  );
}

function CellView({
  cell,
  active = false,
  summa = false,
  onClick,
}: {
  cell: CapacityCell;
  active?: boolean;
  summa?: boolean;
  onClick?: () => void;
}) {
  const clickable = !!onClick;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!onClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <div
      className={styles.cell}
      data-tone={toneFor(cell.loadPercent)}
      data-clickable={clickable}
      data-active={active}
      data-summa={summa}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-expanded={clickable ? active : undefined}
      onKeyDown={clickable ? onKeyDown : undefined}
    >
      <CellContent cell={cell} />
    </div>
  );
}

function ExpansionRow({ label, orders }: { label: string; orders: CapacityCellOrder[] }) {
  return (
    <div className={styles.expansion}>
      <div className={styles.expansionTitle}>{label}</div>
      {orders.map((o) => (
        <div key={`${o.manufacturingOrderId}-${o.sequenceNo}`} className={styles.orderRow}>
          <Link href={`/tillverkning/ordrar/${o.manufacturingOrderId}`} className={styles.rowLink}>
            {o.orderNumber}
          </Link>
          <span>
            {o.articleNumber} — {o.articleName}
          </span>
          <span>Op {o.sequenceNo}</span>
          <span>{formatHours(o.remainingHours)} h</span>
          <span>{o.dueDate ?? "—"}</span>
          <span>{o.overdue && <StatusPill status="delayed" compact />}</span>
        </div>
      ))}
    </div>
  );
}
