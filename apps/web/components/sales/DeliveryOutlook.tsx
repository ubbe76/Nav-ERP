"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatQuantity } from "../../lib/format";
import { toUnitQuantity } from "../../lib/units";
import {
  COMPONENT_LATE_LABEL,
  OUTLOOK_DERIVED_NOTE,
  OUTLOOK_ERROR,
  allocationHref,
  allocationText,
  headLine,
  outlookLabel,
  outlookTone,
  uncoveredText,
} from "../../lib/deliveryOutlook";
import { structureHref } from "../../lib/structureTree";
import type { OutlookRow, SalesOrderDeliveryOutlook, SalesOrderRow } from "../../lib/types";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill } from "../ui/StatusPill";
import styles from "./DeliveryOutlook.module.css";

// Leveransläge on the kundorder card: will the rows leave on the day they
// were promised? Derived by the API at every read (the pegging), nothing is
// stored — so it is fetched when the card is shown and again whenever the
// card itself is read again (`refreshKey`: the props a router.refresh()
// replaces). A failed read shows no mark and a discreet line; the card works
// as before.
export interface DeliveryOutlookState {
  outlook: SalesOrderDeliveryOutlook | null;
  error: string | null;
  rowOf: (rowId: string) => OutlookRow | null;
  isOpen: (rowId: string) => boolean;
  toggle: (rowId: string) => void;
}

export function useDeliveryOutlook(orderId: string, enabled: boolean, refreshKey: unknown): DeliveryOutlookState {
  const [outlook, setOutlook] = useState<SalesOrderDeliveryOutlook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // A late answer never replaces a newer one.
  const sequence = useRef(0);

  useEffect(() => {
    const seq = ++sequence.current;
    if (!enabled) {
      setOutlook(null);
      setError(null);
      return;
    }
    apiFetch<SalesOrderDeliveryOutlook>(`/api/v1/sales-orders/${orderId}/delivery-outlook`)
      .then((result) => {
        if (seq !== sequence.current) return;
        setOutlook(result);
        setError(null);
      })
      .catch((err) => {
        if (seq !== sequence.current) return;
        setOutlook(null);
        setError(apiErrorMessage(err, OUTLOOK_ERROR));
      });
  }, [orderId, enabled, refreshKey]);

  const rowOf = useCallback((rowId: string) => outlook?.rows.find((r) => r.salesOrderRowId === rowId) ?? null, [outlook]);
  const isOpen = useCallback((rowId: string) => open.has(rowId), [open]);
  const toggle = useCallback((rowId: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  }, []);
  return { outlook, error, rowOf, isOpen, toggle };
}

// The order's line under the status row.
export function DeliveryOutlookHead({ state }: { state: DeliveryOutlookState }) {
  if (state.error) return <p className={styles.error}>{state.error}</p>;
  if (!state.outlook) return null;
  const line = headLine(state.outlook, state.outlook.today);
  if (!line) return null;
  return (
    <div className={styles.head} data-tone={line.tone} data-delivery-outlook="head">
      <span className={styles.headLabel}>Leveransläge:</span>
      <span className={styles.headText}>{line.text}</span>
      {state.outlook.counts.componentLate > 0 && <StatusPill status="delayed" label={COMPONENT_LATE_LABEL} compact />}
      {/* The whole tree behind the line — plain text for a profile without the page. */}
      <GatedLink href={structureHref({ ko: state.outlook.salesOrderId })} className={styles.structureLink}>
        Visa strukturen
      </GatedLink>
    </div>
  );
}

// What covers the row: one line per source, never a table.
function AllocationList({ outlookRow, row, today }: { outlookRow: OutlookRow; row: SalesOrderRow; today: string }) {
  const inRowUnit = (q: number) => `${formatQuantity(toUnitQuantity(q, row.unitFactor))} ${row.unitCode}`;
  return (
    <ul className={styles.list} data-delivery-outlook="list">
      {outlookRow.allocations.map((a, i) => {
        const text = allocationText(a, inRowUnit(a.quantity), today);
        const href = allocationHref(a);
        return (
          <li key={i}>
            {href ? <GatedLink href={href}>{text.label}</GatedLink> : text.label} {a.kind === "stock" ? "" : "· "}
            {text.detail}
            {text.late && <span className={styles.late}> · {text.late}</span>}
          </li>
        );
      })}
      {outlookRow.uncovered > 0 && <li className={styles.late}>{uncoveredText(inRowUnit(outlookRow.uncovered))}</li>}
      <li className={styles.note}>{OUTLOOK_DERIVED_NOTE}</li>
    </ul>
  );
}

// The row's pill in the Leveransläge column — a button that opens the list.
// Renders nothing for a row without an outlook (delivered, a tjänst, the
// freight row), so the stacked row card prints no empty line.
export function DeliveryOutlookCell({ state, row }: { state: DeliveryOutlookState; row: SalesOrderRow }) {
  const outlookRow = state.rowOf(row.id);
  if (!outlookRow || !state.outlook) return null;
  const open = state.isOpen(row.id);
  return (
    <div className={styles.cell} data-delivery-outlook="row">
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        title={open ? "Dölj vad som täcker raden" : "Visa vad som täcker raden"}
        onClick={() => state.toggle(row.id)}
      >
        <StatusPill status={outlookTone(outlookRow)} label={outlookLabel(outlookRow)} compact />
        <span className={styles.chevron} aria-hidden="true">
          {open ? "▲" : "▼"}
        </span>
      </button>
      {outlookRow.componentLate && <StatusPill status="delayed" label={COMPONENT_LATE_LABEL} compact />}
      {open && (
        <div className={styles.narrowOnly}>
          <AllocationList outlookRow={outlookRow} row={row} today={state.outlook.today} />
        </div>
      )}
    </div>
  );
}

// The same list as the row's unfolded part (Table's rowDetail, drawn on a
// wide screen only) — where it has room. null = nothing is drawn.
export function deliveryOutlookDetail(state: DeliveryOutlookState, row: SalesOrderRow) {
  const outlookRow = state.rowOf(row.id);
  if (!outlookRow || !state.outlook || !state.isOpen(row.id)) return null;
  return (
    <div className={styles.wide}>
      <AllocationList outlookRow={outlookRow} row={row} today={state.outlook.today} />
    </div>
  );
}
