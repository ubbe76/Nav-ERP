"use client";

import { useEffect, useMemo, useState } from "react";
import {
  materialGroupText,
  materialSections,
  rowMaterialNeed,
  selectableForCoRun,
  selectedInListOrder,
} from "../../lib/coRun";
import { RUN_PLAN_STATUS_PILL, materialDocumentHref, materialText, materialTone, runPlanStatusText } from "../../lib/dayPlan";
import { formatStockholmDate } from "../../lib/date";
import { formatQuantity } from "../../lib/format";
import { weekdayShortDate } from "../../lib/planning";
import type { RunPlanMaterialGroup, RunPlanRow } from "../../lib/types";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill } from "../ui/StatusPill";
import styles from "./MaterialGroups.module.css";

// Material-läget (Körplan and each resource of Dagplan): the listed rows
// grouped by ingoing material, so jobs that draw the same material can be
// run together. The API owns the grouping (materialGroups, unlinkedRowKeys);
// this component presents it and keeps the selection for Samkör valda… —
// one selection per OPERATION, also when its row stands in two groups. It
// never writes: the chosen rows are handed to the page, which owns the dialog.

const formatHours = (hours: number): string =>
  hours.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function MaterialGroups({
  rows,
  groups,
  unlinkedRowKeys,
  version,
  canSelect,
  busy = false,
  onCoRun,
}: {
  // The listed rows of ONE resource, in the order the list shows them.
  rows: RunPlanRow[];
  groups: RunPlanMaterialGroup[];
  unlinkedRowKeys: string[];
  // Changes with every read of the page: the selection is cleared.
  version: unknown;
  // Checkboxes and Samkör valda… — users with Tillverkning.
  canSelect: boolean;
  busy?: boolean;
  // The chosen rows, in the order of the list.
  onCoRun?: (rows: RunPlanRow[]) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setSelected(new Set()), [version]);

  const sections = useMemo(() => materialSections(rows, groups, unlinkedRowKeys), [rows, groups, unlinkedRowKeys]);
  const chosen = useMemo(() => selectedInListOrder(rows, selected), [rows, selected]);
  const selecting = canSelect && onCoRun !== undefined;

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function renderRow(row: RunPlanRow, group: RunPlanMaterialGroup | null, withCheckbox: boolean) {
    const id = row.moOperationId;
    const need = group ? rowMaterialNeed(row, group.articleId) : null;
    const state = need ? materialText(need.material) : null;
    return (
      <li key={row.key} className={styles.row} data-select={withCheckbox ? "true" : undefined} data-late={row.late ? "true" : undefined}>
        {withCheckbox && (
          <span className={styles.check}>
            {id && selectableForCoRun(row) && (
              <Checkbox
                checked={selected.has(id)}
                disabled={busy}
                aria-label={`Välj op ${row.sequenceNo} på ${row.orderNumber}`}
                onChange={(e) => toggle(id, e.target.checked)}
              />
            )}
          </span>
        )}
        <span className={styles.day} data-label="Dag">
          {row.date ? weekdayShortDate(row.date) : "Ej planerad"}
        </span>
        <span className={styles.order}>
          <GatedLink href={`/tillverkning/ordrar/${row.manufacturingOrderId}`} className={styles.orderLink}>
            {row.orderNumber}
          </GatedLink>
        </span>
        <span className={styles.operation}>
          <span className={styles.operationText}>
            Op {row.sequenceNo}
            {row.description ? ` ${row.description}` : ""}
          </span>
          <span className={styles.article} title={`${row.articleNumber} ${row.articleName}`}>
            <span className="num">{row.articleNumber}</span> {row.articleName}
          </span>
        </span>
        <span className={styles.facts}>
          <span className={`${styles.quantity} num`} data-label="Antal kvar">
            {formatQuantity(row.remainingQuantity)}
          </span>
          <span className={`${styles.hours} num`} data-label="Tid kvar">
            {formatHours(row.remainingHours)}
            <span className={styles.unit}> h</span>
          </span>
          <span className={`${styles.due} num`} data-label="Färdigdatum">
            {formatStockholmDate(row.dueDate)}
          </span>
        </span>
        <span className={styles.status}>
          <StatusPill status={RUN_PLAN_STATUS_PILL[row.status]} label={runPlanStatusText(row)} compact />
          {row.planLocked && <span className={styles.lockBadge}>Låst</span>}
        </span>
        <span className={styles.need} data-label="Behov" data-empty={need ? undefined : "true"}>
          {need && state && (
            <>
              <span className="num">{need.text}</span>
              <span className={styles.state} data-tone={materialTone(state)}>
                {state.text}
                {state.document && (
                  <>
                    {" · "}
                    <GatedLink href={materialDocumentHref(state.document)} className={styles.document}>
                      {state.document.number}
                    </GatedLink>
                    {state.document.draft ? " (utkast)" : ""}
                  </>
                )}
                {state.rest ? ` · ${state.rest}` : ""}
              </span>
            </>
          )}
        </span>
      </li>
    );
  }

  function head(withCheckbox: boolean, withNeed: boolean) {
    return (
      <div className={styles.headRow} data-select={withCheckbox ? "true" : undefined} aria-hidden="true">
        {withCheckbox && <span />}
        <span>Dag</span>
        <span>TO</span>
        <span>Operation · Artikel</span>
        <span className={styles.right}>Antal kvar</span>
        <span className={styles.right}>Tid kvar (h)</span>
        <span>Färdigdatum</span>
        <span>Status</span>
        <span>{withNeed ? "Behov" : ""}</span>
      </div>
    );
  }

  // The closing groups: collapsed, never selectable.
  function restGroup(title: string, restRows: RunPlanRow[], hint: string) {
    if (restRows.length === 0) return null;
    return (
      <details className={styles.group} data-rest="true">
        <summary className={styles.summary}>
          <span className={styles.title}>
            {title} (<span className="num">{restRows.length}</span>)
          </span>
        </summary>
        <p className={styles.hint}>{hint}</p>
        {head(false, false)}
        <ul className={styles.rows}>{restRows.map((row) => renderRow(row, null, false))}</ul>
      </details>
    );
  }

  return (
    <div className={styles.groups}>
      {sections.groups.length === 0 && <p className={styles.empty}>Inga operationer med kopplat köpt material kvar att ta ut.</p>}

      {sections.groups.map(({ group, rows: groupRows }) => {
        const selectable = selecting && groupRows.some(selectableForCoRun);
        return (
          <details key={group.articleId} className={styles.group} data-short={group.short ? "true" : undefined} open>
            <summary className={styles.summary}>
              <span className={styles.title}>
                <span className="num">{group.articleNumber}</span> {group.articleName}
              </span>
              <span className={styles.totals}>
                {materialGroupText(group)}
                {group.short && <span className={styles.shortBadge}>räcker inte</span>}
              </span>
              <span className={styles.count}>
                <span className="num">{groupRows.length}</span> {groupRows.length === 1 ? "operation" : "operationer"}
              </span>
            </summary>
            {head(selecting, true)}
            <ul className={styles.rows}>{groupRows.map((row) => renderRow(row, group, selecting))}</ul>
            {selectable && (
              <div className={styles.actions}>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={busy || chosen.length < 2}
                  title={chosen.length < 2 ? "Välj minst två operationer" : undefined}
                  onClick={() => onCoRun?.(chosen)}
                >
                  Samkör valda…
                </Button>
                <span className={styles.chosen}>
                  <span className="num">{chosen.length}</span> {chosen.length === 1 ? "vald" : "valda"}
                </span>
              </div>
            )}
          </details>
        );
      })}

      {restGroup("Utan kopplat material", sections.unlinked, "Koppla materialet till operationen i beredningen för att kunna samköra.")}
      {restGroup("Materialet uttaget", sections.drawn, "Allt kopplat material är redan uttaget till operationerna.")}
      {restGroup("Planerad TO", sections.other, "En planerad tillverkningsorder har inget material att koppla förrän den är frisläppt.")}
    </div>
  );
}
