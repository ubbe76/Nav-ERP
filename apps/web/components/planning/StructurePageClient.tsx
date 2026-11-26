"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { Button } from "../ui/Button";
import { Checkbox, Input } from "../ui/Field";
import { FormError, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { RowMenu } from "../ui/RowMenu";
import { StatusPill } from "../ui/StatusPill";
import { MoveComponentsDialog } from "../manufacturing/MoveComponentsDialog";
import { MissingComponentsDialog } from "../manufacturing/MissingComponentsDialog";
import { MoveOperationDialog, type MoveTarget } from "./MoveOperationDialog";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { OUTLOOK_DERIVED_NOTE, headLine } from "../../lib/deliveryOutlook";
import {
  OPERATIONS_OPEN_LEVEL,
  NARROW_MAX_INDENT,
  UNLOCK_ORDERS_MAX,
  ancestorIds,
  axisWeeks,
  barSegments,
  chunked,
  flooredAtToday,
  foldableIds,
  goesToLink,
  goesToText,
  lockedOrderCount,
  lockedText,
  markerIndex,
  moveTargetOf,
  nodeDates,
  nodeHref,
  nodeMarks,
  nodeTitle,
  operationDates,
  operationMovable,
  operationTitle,
  orderChildFacts,
  spanSegment,
  stockOnlyCount,
  structureHref,
  structureOrderIds,
  totalsText,
  truncatedNotices,
  unlockOrderQuestion,
  unlockStructureQuestion,
  visibleNodes,
  weekdayLetter,
  type StructureAxis,
  type StructureOrderNode,
} from "../../lib/structureTree";
import type {
  CoverageMove,
  ManufacturingOrder,
  ManufacturingOrderCoverage,
  SalesOrder,
  StructureNode,
  StructureOperation,
  StructureResult,
  UnlockOperationResult,
  UnlockOrdersResult,
} from "../../lib/types";
import styles from "./StructurePageClient.module.css";

// Strukturvyn: ONE order's whole tree with its planned days — a kundorder's
// rows or a TO at the top (?ko=<id> / ?to=<id>). A read view: the tree, the
// late marks and the days are the API's, derived at every read. The few
// actions are the existing ones (Flytta…, Lås upp, the TO card's dialogs)
// and only shown with Tillverkning.
export function StructurePageClient() {
  const searchParams = useSearchParams();
  const to = searchParams.get("to");
  const ko = searchParams.get("ko");
  if (to) return <StructureView key={`to:${to}`} query={`manufacturingOrderId=${encodeURIComponent(to)}`} />;
  if (ko) return <StructureView key={`ko:${ko}`} query={`salesOrderId=${encodeURIComponent(ko)}`} />;
  return <StructureSearch />;
}

// --- Without an order: find one by number -----------------------------------

interface SearchHit {
  href: string;
  number: string;
  text: string;
}

function StructureSearch() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    const term = text.trim();
    if (!term) return;
    setBusy(true);
    const query = `search=${encodeURIComponent(term)}&limit=8`;
    // Each list is read with its own permission — a profile without the
    // kundorder list simply finds TOs only.
    const [orders, salesOrders] = await Promise.all([
      apiFetch<{ rows: ManufacturingOrder[] }>(`/api/v1/manufacturing-orders?${query}`).catch(() => ({ rows: [] })),
      apiFetch<{ rows: SalesOrder[] }>(`/api/v1/sales-orders?${query}`).catch(() => ({ rows: [] })),
    ]);
    const found: SearchHit[] = [
      ...orders.rows.map((o) => ({
        href: structureHref({ to: o.id }),
        number: o.orderNumber,
        text: `${o.articleNumber ?? ""} ${o.articleName ?? ""}`.trim(),
      })),
      ...salesOrders.rows.map((o) => ({ href: structureHref({ ko: o.id }), number: o.orderNumber, text: o.customerName ?? "" })),
    ];
    setBusy(false);
    const exact = found.filter((h) => h.number.toLowerCase() === term.toLowerCase());
    if (exact.length === 1) {
      router.push(exact[0]!.href);
      return;
    }
    setHits(found);
  }

  return (
    <div className={styles.search}>
      <p className={styles.searchLead}>Öppna strukturen för en tillverkningsorder eller en kundorder.</p>
      <form className={styles.searchForm} onSubmit={search}>
        <Input
          aria-label="TO- eller KO-nummer"
          placeholder="TO- eller KO-nummer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        <Button type="submit" variant="primary" disabled={busy || text.trim() === ""}>
          {busy ? "Söker…" : "Visa strukturen"}
        </Button>
      </form>
      {hits !== null &&
        (hits.length === 0 ? (
          <p className={styles.muted}>Ingen order hittades.</p>
        ) : (
          <ul className={styles.hits}>
            {hits.map((h) => (
              <li key={h.href}>
                <Link href={h.href} className={styles.nodeLink}>
                  {h.number}
                </Link>
                {h.text && <span className={styles.muted}> · {h.text}</span>}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

// --- The view ---------------------------------------------------------------

type Row = { kind: "node"; node: StructureNode } | { kind: "operation"; node: StructureOrderNode; op: StructureOperation };

const domId = (nodeId: string) => `structure-${nodeId}`;

function StructureView({ query }: { query: string }) {
  const canWrite = useCan()(["tillverkning"]);
  const [data, setData] = useState<StructureResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // A late answer never replaces a newer one.
  const sequence = useRef(0);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showStock, setShowStock] = useState(false);
  // Operations: unfolded on the two top levels, the rest on request — per
  // order, or all at once.
  const [operationsOpen, setOperationsOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [highlight, setHighlight] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [componentsFor, setComponentsFor] = useState<{ orderId: string; moves: CoverageMove[] } | null>(null);
  const [missingFor, setMissingFor] = useState<string | null>(null);

  useEffect(() => {
    const seq = ++sequence.current;
    setLoading(true);
    apiFetch<StructureResult>(`/api/v1/planning/structure?${query}`)
      .then((result) => {
        if (seq !== sequence.current) return;
        setData(result);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (seq !== sequence.current) return;
        setData(null);
        setLoadError(apiErrorMessage(err, "Kunde inte läsa strukturen."));
      })
      .finally(() => {
        if (seq === sequence.current) setLoading(false);
      });
  }, [query, reloadTick]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // The highlight after a jump fades by itself.
  useEffect(() => {
    if (highlight === null) return;
    const timer = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(timer);
  }, [highlight]);

  if (loadError) return <FormError>{loadError}</FormError>;
  if (!data) return <p className={styles.muted}>Läser strukturen…</p>;

  const { nodes, axis, today } = data;
  const foldable = foldableIds(nodes, showStock);
  const stockCount = stockOnlyCount(nodes);
  const shown = visibleNodes(nodes, collapsed, showStock);

  const operationsShown = (node: StructureOrderNode) => operationsOpen.get(node.id) ?? node.level <= OPERATIONS_OPEN_LEVEL;
  const withOperations = nodes.filter((n): n is StructureOrderNode => n.kind === "order" && n.operations.length > 0);
  const allOperationsOpen = withOperations.length > 0 && withOperations.every(operationsShown);

  const rows: Row[] = [];
  for (const node of shown) {
    rows.push({ kind: "node", node });
    if (node.kind === "order" && !collapsed.has(node.id) && operationsShown(node)) {
      for (const op of node.operations) rows.push({ kind: "operation", node, op });
    }
  }

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggleOperations(node: StructureOrderNode) {
    setOperationsOpen((current) => new Map(current).set(node.id, !operationsShown(node)));
  }

  function toggleAllOperations() {
    const open = !allOperationsOpen;
    setOperationsOpen(new Map(withOperations.map((n) => [n.id, open])));
  }

  // "visas ovan": unfold what hides the first place, scroll to it and mark it.
  function jumpTo(id: string) {
    const above = new Set(ancestorIds(nodes, id));
    setCollapsed((current) => new Set([...current].filter((c) => !above.has(c))));
    setHighlight(id);
    requestAnimationFrame(() => {
      const el = document.getElementById(domId(id));
      el?.scrollIntoView({ block: "center", inline: "nearest" });
      el?.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
    });
  }

  // --- Writes: the existing routes, only with Tillverkning -------------------

  async function unlockOrders(ids: string[], question: string) {
    if (!canWrite) return;
    if (ids.length === 0 || busy) return;
    if (!(await confirmDialog(question, { confirmLabel: "Lås upp" }))) return;
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      let operations = 0;
      for (const part of chunked(ids, UNLOCK_ORDERS_MAX)) {
        const result = await apiFetch<UnlockOrdersResult>("/api/v1/planning/unlock-orders", {
          method: "POST",
          body: JSON.stringify({ manufacturingOrderIds: part }),
        });
        operations += result.unlocked.reduce((sum, o) => sum + o.operations, 0);
      }
      setNotice(
        operations === 0
          ? "Inga operationer var låsta."
          : `${operations === 1 ? "1 operation upplåst" : `${operations} operationer upplåsta`}. Dagarna står kvar tills nästa Planera.`
      );
    } catch (err) {
      setActionError(apiErrorMessage(err, "Kunde inte låsa upp"));
    } finally {
      setBusy(false);
      reload();
    }
  }

  async function unlockOperation(op: StructureOperation) {
    if (!canWrite) return;
    if (busy) return;
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch<UnlockOperationResult>(`/api/v1/planning/operations/${op.moOperationId}/unlock`, { method: "POST" });
    } catch (err) {
      setActionError(apiErrorMessage(err, "Kunde inte låsa upp operationen"));
    } finally {
      setBusy(false);
      reload();
    }
  }

  function openMove(node: StructureOrderNode, op: StructureOperation) {
    if (!canWrite) return;
    setMoveTarget(moveTargetOf(node, op));
  }

  // Flytta halvfabrikaten…: the dialog's rows are the TO card's coverage.
  async function openComponents(node: StructureOrderNode) {
    if (!canWrite) return;
    if (busy) return;
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      const coverage = await apiFetch<ManufacturingOrderCoverage>(`/api/v1/manufacturing-orders/${node.manufacturingOrderId}/coverage`);
      if (coverage.moves.length === 0) setNotice(`${node.orderNumber} har inga halvfabrikat att flytta.`);
      else setComponentsFor({ orderId: node.manufacturingOrderId, moves: coverage.moves });
    } catch (err) {
      setActionError(apiErrorMessage(err, "Kunde inte läsa halvfabrikaten"));
    } finally {
      setBusy(false);
    }
  }

  async function reloadComponents() {
    if (!componentsFor) return;
    const coverage = await apiFetch<ManufacturingOrderCoverage>(`/api/v1/manufacturing-orders/${componentsFor.orderId}/coverage`);
    setComponentsFor({ orderId: componentsFor.orderId, moves: coverage.moves });
  }

  function openMissing(node: StructureOrderNode) {
    if (!canWrite) return;
    setMissingFor(node.manufacturingOrderId);
  }

  const lockedOrders = lockedOrderCount(nodes);
  const todayIndex = markerIndex(today, axis);
  const gridStyle = { "--days": axis.days.length } as CSSProperties;
  const headLineOf = data.root.kind === "sales_order" ? headLine(data.root.outlook, today) : null;
  const rootOrder = data.root.kind === "manufacturing_order" ? nodes.find((n): n is StructureOrderNode => n.kind === "order" && n.parentId === null) : null;

  return (
    <div className={styles.page} data-loading={loading || undefined}>
      <header className={styles.head}>
        <div className={styles.headTitle}>
          {data.root.kind === "sales_order" ? (
            <>
              <GatedLink href={`/forsaljning/ordrar/${data.root.salesOrderId}`} className={styles.rootLink}>
                {data.root.orderNumber}
              </GatedLink>
              <span className={styles.rootDetail}>{data.root.customerName}</span>
            </>
          ) : (
            <>
              <GatedLink href={`/tillverkning/ordrar/${data.root.manufacturingOrderId}`} className={styles.rootLink}>
                {data.root.orderNumber}
              </GatedLink>
              {rootOrder && (
                <span className={styles.rootDetail}>
                  {rootOrder.articleNumber} — {rootOrder.articleName}
                </span>
              )}
            </>
          )}
        </div>
        {headLineOf && (
          <div className={styles.outlook} data-tone={headLineOf.tone}>
            <span className={styles.muted}>Leveransläge:</span> <span className={styles.outlookText}>{headLineOf.text}</span>
          </div>
        )}
        <div className={styles.totals}>{totalsText(data.totals)}</div>
        <p className={styles.note}>{OUTLOOK_DERIVED_NOTE}</p>

        {data.root.kind === "manufacturing_order" && data.goesTo.length > 0 && (
          <div className={styles.goesTo}>
            <div className={styles.goesToTitle}>Går till</div>
            <ul className={styles.goesToList}>
              {data.goesTo.map((g, i) => {
                const link = goesToLink(g);
                return (
                  <li key={i}>
                    <span data-late={g.late || undefined}>{goesToText(g, today)}</span>
                    {link && (
                      <Link href={link.href} className={styles.goesToLink}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className={styles.controls}>
          {stockCount > 0 && (
            <label className={styles.check}>
              <Checkbox checked={showStock} onChange={(e) => setShowStock(e.target.checked)} />
              <span>Visa material i lager ({stockCount})</span>
            </label>
          )}
          {withOperations.length > 0 && (
            <Button type="button" variant="ghost" size="small" onClick={toggleAllOperations}>
              {allOperationsOpen ? "Dölj alla operationer" : "Visa alla operationer"}
            </Button>
          )}
          {canWrite && data.totals.lockedOperations > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={() => unlockOrders(structureOrderIds(nodes), unlockStructureQuestion(data.totals.lockedOperations, lockedOrders))}
            >
              Lås upp strukturen
            </Button>
          )}
        </div>
      </header>

      {truncatedNotices(data.truncated).map((text) => (
        <FormNotice key={text}>{text}</FormNotice>
      ))}
      <FormError>{actionError}</FormError>
      {notice && <FormNotice>{notice}</FormNotice>}

      {nodes.length === 0 ? (
        <p className={styles.muted}>
          {data.root.kind === "sales_order"
            ? "Kundordern har inga öppna rader att visa en struktur för."
            : "Tillverkningsordern har ingen struktur att visa."}
        </p>
      ) : (
        <div className={styles.box}>
          <div className={styles.scroller}>
            <div className={styles.grid} style={gridStyle} data-structure="grid">
              {/* The axis' head: weeks above days. Hidden on a narrow box. */}
              <div className={styles.corner} style={{ gridRow: "1 / span 2", gridColumn: 1 }}>
                Order och material
              </div>
              {axisWeeks(axis).map((week) => (
                <div
                  key={`w${week.fromIndex}`}
                  className={styles.weekHead}
                  style={{ gridRow: 1, gridColumn: `${week.fromIndex + 2} / span ${week.span}` }}
                >
                  {week.span >= 2 ? `v.${week.isoWeek}` : ""}
                </div>
              ))}
              {axis.days.map((day, index) => (
                <div
                  key={day.date}
                  className={styles.dayHead}
                  data-off={day.off || undefined}
                  data-today={day.date === today || undefined}
                  title={day.date}
                  style={{ gridRow: 2, gridColumn: index + 2 }}
                >
                  <span>{weekdayLetter(day.weekday)}</span>
                  <span className={styles.dayNumber}>{Number(day.date.slice(8, 10))}</span>
                </div>
              ))}
              {/* Days off and today as columns behind every row. */}
              {axis.days.map((day, index) =>
                day.off ? (
                  <div key={`off${day.date}`} className={styles.offDay} style={{ gridRow: `3 / span ${rows.length}`, gridColumn: index + 2 }} />
                ) : null
              )}
              {todayIndex !== null && (
                <div className={styles.todayColumn} style={{ gridRow: `3 / span ${rows.length}`, gridColumn: todayIndex + 2 }} />
              )}

              {rows.map((row, index) => {
                const gridRow = index + 3;
                if (row.kind === "operation") {
                  return (
                    <OperationRow
                      key={`${row.node.id}/op:${row.op.moOperationId}`}
                      node={row.node}
                      op={row.op}
                      axis={axis}
                      today={today}
                      gridRow={gridRow}
                      canWrite={canWrite}
                      busy={busy}
                      onMove={() => openMove(row.node, row.op)}
                      onUnlock={() => unlockOperation(row.op)}
                    />
                  );
                }
                const node = row.node;
                return (
                  <NodeRow
                    key={node.id}
                    node={node}
                    axis={axis}
                    today={today}
                    gridRow={gridRow}
                    foldable={foldable.has(node.id) || (node.kind === "order" && node.operations.length > 0 && operationsShown(node))}
                    collapsed={collapsed.has(node.id)}
                    highlighted={highlight === node.id}
                    operationsOpen={node.kind === "order" ? operationsShown(node) : false}
                    onToggle={() => toggle(node.id)}
                    onToggleOperations={() => node.kind === "order" && toggleOperations(node)}
                    onJump={jumpTo}
                    menu={
                      canWrite && node.kind === "order" && node.repeatOf === null ? (
                        <OrderMenu
                          node={node}
                          facts={orderChildFacts(nodes, node.id)}
                          busy={busy}
                          onComponents={() => openComponents(node)}
                          onMissing={() => openMissing(node)}
                          onUnlock={() => unlockOrders([node.manufacturingOrderId], unlockOrderQuestion(node))}
                        />
                      ) : null
                    }
                  />
                );
              })}
            </div>
          </div>
          <div className={styles.legend} aria-hidden="true">
            <span>
              <i className={styles.legendBar} /> planerad dag
            </span>
            <span>
              <i className={styles.legendDiamond} /> färdigdatum / avsändning
            </span>
            <span>
              <i className={styles.legendNeed} /> behövs
            </span>
            <span>
              <i className={styles.legendDot} /> inleverans
            </span>
          </div>
        </div>
      )}

      {canWrite && (
        <MoveOperationDialog target={moveTarget} today={today} onClose={() => setMoveTarget(null)} onChanged={reload} />
      )}
      {canWrite && (
        <MoveComponentsDialog
          open={componentsFor !== null}
          onClose={() => setComponentsFor(null)}
          orderId={componentsFor?.orderId ?? ""}
          moves={componentsFor?.moves ?? []}
          onReload={reloadComponents}
          onMoved={reload}
        />
      )}
      {canWrite && missingFor !== null && (
        <MissingComponentsDialog open onClose={() => setMissingFor(null)} orderId={missingFor} onCreated={reload} />
      )}
    </div>
  );
}

// The TO's ⋯ menu — the TO card's dialogs and Lås upp hela ordern.
function OrderMenu({
  node,
  facts,
  busy,
  onComponents,
  onMissing,
  onUnlock,
}: {
  node: StructureOrderNode;
  facts: { missingManufacturable: boolean; componentOrders: boolean };
  busy: boolean;
  onComponents: () => void;
  onMissing: () => void;
  onUnlock: () => void;
}) {
  return (
    <RowMenu
      label={`Åtgärder för ${node.orderNumber}`}
      items={[
        facts.componentOrders && { label: "Flytta halvfabrikaten…", onSelect: onComponents, disabled: busy },
        facts.missingManufacturable && { label: "Skapa saknade halvfabrikat…", onSelect: onMissing, disabled: busy },
        node.lockedOperations > 0 && { label: "Lås upp hela ordern", onSelect: onUnlock, disabled: busy },
      ]}
    />
  );
}

const indentStyle = (level: number): CSSProperties =>
  ({ "--level": level, "--level-narrow": Math.min(level, NARROW_MAX_INDENT) }) as CSSProperties;

// A mark on the axis: one day column, the shape in its middle.
function Marker({ index, shape, tone, title }: { index: number; shape: "diamond" | "need" | "dot"; tone?: "late"; title: string }) {
  return (
    <span className={styles.marker} data-shape={shape} data-tone={tone} title={title} style={{ gridColumn: index + 1 }}>
      <i />
    </span>
  );
}

function NodeRow({
  node,
  axis,
  today,
  gridRow,
  foldable,
  collapsed,
  highlighted,
  operationsOpen,
  onToggle,
  onToggleOperations,
  onJump,
  menu,
}: {
  node: StructureNode;
  axis: StructureAxis;
  today: string;
  gridRow: number;
  foldable: boolean;
  collapsed: boolean;
  highlighted: boolean;
  operationsOpen: boolean;
  onToggle: () => void;
  onToggleOperations: () => void;
  onJump: (id: string) => void;
  menu: React.ReactNode;
}) {
  const title = nodeTitle(node);
  const href = nodeHref(node);
  const dates = nodeDates(node, today, axis);
  // The last part the wide layout shows (the axis says the others).
  const lastWide = dates.reduce((last, d, i) => (d.onAxis ? last : i), -1);
  const marks = nodeMarks(node);
  const repeat = node.kind === "order" && node.repeatOf !== null ? node.repeatOf : null;

  return (
    <>
      <div
        id={domId(node.id)}
        className={styles.cell}
        data-kind={node.kind}
        data-root={node.parentId === null || undefined}
        data-highlight={highlighted || undefined}
        style={{ gridRow, gridColumn: 1, ...indentStyle(node.level) }}
      >
        {foldable ? (
          <button
            type="button"
            className={styles.fold}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Fäll ut" : "Fäll ihop"} ${title.label}`}
            onClick={onToggle}
          >
            {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          </button>
        ) : (
          <span className={styles.foldSpace} aria-hidden="true" />
        )}
        <div className={styles.main}>
          <div className={styles.line}>
            {node.level > NARROW_MAX_INDENT && (
              <span className={styles.levelBadge} title={`Nivå ${node.level}`}>
                {node.level}
              </span>
            )}
            {href ? (
              <GatedLink href={href} className={styles.nodeLink}>
                {title.label}
              </GatedLink>
            ) : (
              <span className={styles.nodeLabel}>{title.label}</span>
            )}
            <span className={styles.detail}>{title.detail}</span>
          </div>
          {(dates.length > 0 || marks.late || marks.pills.length > 0 || marks.locked > 0 || repeat !== null || node.kind === "order") && (
            <div className={styles.sub}>
              {dates.length > 0 && (
                <span className={styles.dates}>
                  {dates.map((d, i) => (
                    <span
                      key={d.text}
                      className={styles.date}
                      data-on-axis={d.onAxis || undefined}
                      data-last={i === dates.length - 1 || undefined}
                      data-last-wide={i === lastWide || undefined}
                    >
                      {d.text}
                    </span>
                  ))}
                </span>
              )}
              {marks.late && <span className={styles.late}>{marks.late}</span>}
              {marks.pills.map((pill) => (
                <span key={pill.label} title={pill.title}>
                  <StatusPill status={pill.tone} label={pill.label} compact />
                </span>
              ))}
              {marks.locked > 0 && (
                <span className={styles.lockedBadge}>
                  <Lock size={12} aria-hidden="true" />
                  {lockedText(marks.locked)}
                </span>
              )}
              {repeat !== null && (
                <button type="button" className={styles.linkButton} onClick={() => onJump(repeat)}>
                  visas ovan
                </button>
              )}
              {node.kind === "order" && repeat === null && node.operations.length > 0 && !collapsed && (
                <button type="button" className={styles.linkButton} aria-expanded={operationsOpen} onClick={onToggleOperations}>
                  {operationsOpen ? "Dölj operationer" : `Visa operationer (${node.operations.length})`}
                </button>
              )}
            </div>
          )}
        </div>
        {menu && <div className={styles.menu}>{menu}</div>}
      </div>
      <div className={styles.lane} data-kind={node.kind} style={{ gridRow }}>
        <NodeLane node={node} axis={axis} today={today} />
      </div>
    </>
  );
}

// What the node shows on the axis.
function NodeLane({ node, axis, today }: { node: StructureNode; axis: StructureAxis; today: string }) {
  const at = (date: string | null) => markerIndex(flooredAtToday(date, today), axis);
  switch (node.kind) {
    case "sales_row": {
      const ship = at(node.row.promisedShipDate);
      return ship === null ? null : (
        <Marker
          index={ship}
          shape="diamond"
          tone={node.row.status === "late" || node.row.status === "uncovered" ? "late" : undefined}
          title={`Avsändning ${node.row.promisedShipDate}`}
        />
      );
    }
    case "order": {
      const need = at(node.link?.needDate ?? null);
      const needMarker =
        need === null ? null : <Marker index={need} shape="need" tone={node.link?.late ? "late" : undefined} title={`Behövs ${node.link?.needDate}`} />;
      if (node.repeatOf !== null) return needMarker;
      const span = spanSegment(node.plannedStartDate, node.plannedFinish ?? node.plannedEndDate, axis, today);
      const due = at(node.dueDate);
      return (
        <>
          {span && (
            <span
              className={styles.span}
              data-tone={node.late ? "late" : undefined}
              title={`Planerad ${node.plannedStartDate} – ${node.plannedFinish ?? node.plannedEndDate ?? node.plannedStartDate}`}
              style={{ gridColumn: `${span.fromIndex + 1} / ${span.toIndex + 2}` }}
            />
          )}
          {needMarker}
          {due !== null && <Marker index={due} shape="diamond" tone={node.late ? "late" : undefined} title={`Färdigdatum ${node.dueDate}`} />}
        </>
      );
    }
    case "material": {
      const need = at(node.needDate);
      return need === null ? null : <Marker index={need} shape="need" tone={node.uncovered > 0 ? "late" : undefined} title={`Behövs ${node.needDate}`} />;
    }
    case "supply": {
      if (node.supply !== "purchase_order" || node.undated) return null;
      const ready = at(node.readyDate);
      return ready === null ? null : <Marker index={ready} shape="dot" tone={node.late ? "late" : undefined} title={`Inleverans ${node.readyDate}`} />;
    }
    default:
      return null;
  }
}

function OperationRow({
  node,
  op,
  axis,
  today,
  gridRow,
  canWrite,
  busy,
  onMove,
  onUnlock,
}: {
  node: StructureOrderNode;
  op: StructureOperation;
  axis: StructureAxis;
  today: string;
  gridRow: number;
  canWrite: boolean;
  busy: boolean;
  onMove: () => void;
  onUnlock: () => void;
}) {
  const title = operationTitle(op);
  const dates = operationDates(op, today);
  const movable = canWrite && operationMovable(op);
  const barTitle = `${node.orderNumber} ${title} — ${dates}`;
  return (
    <>
      <div
        className={styles.cell}
        data-kind="operation"
        data-done={op.status === "done" || undefined}
        style={{ gridRow, gridColumn: 1, ...indentStyle(node.level + 1) }}
      >
        <span className={styles.foldSpace} aria-hidden="true" />
        <div className={styles.main}>
          <div className={styles.line}>
            <span className={styles.opTitle}>{title}</span>
            <span className={styles.detail}>{dates}</span>
            {op.planLocked && op.status === "pending" && (
              <span className={styles.lockedBadge}>
                <Lock size={12} aria-hidden="true" />
                Låst
              </span>
            )}
          </div>
        </div>
        {canWrite && (
          <div className={styles.menu}>
            <RowMenu
              label={`Åtgärder för ${node.orderNumber} ${title}`}
              items={[
                movable && { label: "Flytta…", onSelect: onMove },
                op.planLocked && op.status === "pending" && { label: "Lås upp", onSelect: onUnlock, disabled: busy },
              ]}
            />
          </div>
        )}
      </div>
      <div className={styles.lane} data-kind="operation" style={{ gridRow }}>
        {barSegments(op, axis).map((segment) =>
          movable ? (
            <button
              key={segment.fromIndex}
              type="button"
              className={styles.bar}
              data-locked={op.planLocked || undefined}
              data-tone={node.late ? "late" : undefined}
              title={`${barTitle} · Flytta…`}
              aria-label={`Flytta ${barTitle}`}
              style={{ gridColumn: `${segment.fromIndex + 1} / ${segment.toIndex + 2}` }}
              onClick={onMove}
            />
          ) : (
            <span
              key={segment.fromIndex}
              className={styles.bar}
              data-locked={op.planLocked || undefined}
              data-tone={node.late ? "late" : undefined}
              title={barTitle}
              style={{ gridColumn: `${segment.fromIndex + 1} / ${segment.toIndex + 2}` }}
            />
          )
        )}
      </div>
    </>
  );
}
