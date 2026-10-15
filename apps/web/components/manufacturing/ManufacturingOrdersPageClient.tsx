"use client";

import { useState } from "react";
import Link from "next/link";
import { ArticleOverviewButton } from "../articles/ArticleOverviewButton";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Checkbox } from "../ui/Field";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { FormError, FormNotice } from "../ui/Form";
import { NewManufacturingOrderForm } from "./NewManufacturingOrderForm";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { MANUFACTURING_ORDER_STATUS_PILL, type ManufacturingOrder, type Paged } from "../../lib/types";
import {
  ACTION_LABELS,
  actionsForStatus,
  confirmCancel,
  runOrderAction,
  type OrderAction,
} from "../../lib/manufacturingOrderActions";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/tillverkning/ordrar/page.module.css";
import { HelpLink } from "../ui/HelpLink";
import { useCan, useCanOpen } from "../PermissionsProvider";

const BULK_ACTIONS: OrderAction[] = ["release", "close", "cancel"];

interface RowFailure {
  orderNumber: string;
  message: string;
}

export function ManufacturingOrdersPageClient({
  orders,
  pageSize,
}: {
  orders: Paged<ManufacturingOrder>;
  pageSize: number;
}) {
  const router = useRouter();
  // Workshop profile: list is read-only (no create, export, selection or actions).
  const readOnly = !useCan()(["tillverkning"]);
  const canOpen = useCanOpen();
  const [modalOpen, setModalOpen] = useState(false);
  // Status actions straight from the list (NOTES.md #8): one row at a time
  // via the buttons in the Åtgärder column, or several at once via the
  // checkboxes and the bar under the table. Every call is the card's own
  // per-order endpoint — there is no batch endpoint, so a bulk run is a
  // sequential loop that reports per order and keeps the failed ones
  // selected for a retry.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState<OrderAction | null>(null);
  const [failures, setFailures] = useState<RowFailure[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const busy = pendingId !== null || bulkPending !== null;
  const selectableRows = orders.rows.filter((order) => actionsForStatus(order.status).length > 0);
  const selectedRows = orders.rows.filter((order) => selected.has(order.id));
  const selectedOnPage = selectableRows.filter((order) => selected.has(order.id)).length;
  const allSelectedOnPage = selectableRows.length > 0 && selectedOnPage === selectableRows.length;

  function targetsFor(action: OrderAction) {
    return selectedRows.filter((order) => actionsForStatus(order.status).includes(action));
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(selectableRows.map((order) => order.id)) : new Set());
  }

  function toggleRow(orderId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(orderId);
      else next.delete(orderId);
      return next;
    });
  }

  async function runOne(order: ManufacturingOrder, action: OrderAction) {
    if (action === "cancel" && !(await confirmCancel([order.orderNumber]))) return;
    setFailures([]);
    setWarnings([]);
    setPendingId(order.id);
    try {
      setWarnings(await runOrderAction(order.id, action));
      toggleRow(order.id, false);
      router.refresh();
    } catch (err) {
      setFailures([{ orderNumber: order.orderNumber, message: err instanceof Error ? err.message : "Åtgärden misslyckades" }]);
    } finally {
      setPendingId(null);
    }
  }

  async function runBulk(action: OrderAction) {
    const targets = targetsFor(action);
    if (targets.length === 0) return;
    if (action === "cancel" && !(await confirmCancel(targets.map((order) => order.orderNumber)))) return;
    setFailures([]);
    setWarnings([]);
    setBulkPending(action);
    const failed: RowFailure[] = [];
    const failedIds = new Set<string>();
    const collectedWarnings: string[] = [];
    try {
      for (const order of targets) {
        try {
          // Release warnings name the component, not the order — prefix them
          // so a bulk release still tells which TO is short.
          collectedWarnings.push(...(await runOrderAction(order.id, action)).map((w) => `${order.orderNumber}: ${w}`));
        } catch (err) {
          failed.push({ orderNumber: order.orderNumber, message: err instanceof Error ? err.message : "Åtgärden misslyckades" });
          failedIds.add(order.id);
        }
      }
      // Successful orders leave the selection; failed ones stay checked so
      // the same button retries exactly them.
      setSelected((prev) => new Set([...prev].filter((id) => failedIds.has(id) || !targets.some((t) => t.id === id))));
      setFailures(failed);
      setWarnings(collectedWarnings);
      router.refresh();
    } finally {
      setBulkPending(null);
    }
  }

  // The bulk controls render twice — under the table on desktop, above it in
  // the mobile stack — so they are built once here.
  const selectedSummary = `${selectedRows.length} ${selectedRows.length === 1 ? "order vald" : "ordrar valda"}`;
  const bulkButtons = (
    <span className={styles.rowActions}>
      {BULK_ACTIONS.map((action) => {
        const count = targetsFor(action).length;
        return (
          <Button
            key={action}
            type="button"
            size="small"
            variant={action === "cancel" ? "danger" : "secondary"}
            disabled={busy || count === 0}
            onClick={() => runBulk(action)}
          >
            {bulkPending === action ? "Arbetar…" : `${ACTION_LABELS[action].label} valda (${count})`}
          </Button>
        );
      })}
      <Button type="button" size="small" variant="ghost" disabled={busy} onClick={() => setSelected(new Set())}>
        Avmarkera
      </Button>
    </span>
  );

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Tillverkningsordrar</div>
          <div className={shellStyles.meta}>{orders.total.toLocaleString("sv-SE")} ordrar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          {canOpen("/tillverkning/resurser") && (
            <Link href="/tillverkning/resurser" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Resurser
            </Link>
          )}
          {!readOnly && (
            <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
              + Ny tillverkningsorder
            </Button>
          )}
          <HelpLink chapter="tillverkning" anchor="tillverkningsorder" label="Hjälp om tillverkningsorder" />
        </div>
      </div>

      <ListToolbar placeholder="Sök ordernummer eller artikel…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(MANUFACTURING_ORDER_STATUS_PILL).map(([value, pill]) => ({ value, label: pill.label }))}
        />
        {!readOnly && <ListExportLink endpoint="/api/v1/manufacturing-orders/csv" />}
      </ListToolbar>

      {warnings.length > 0 && (
        <FormNotice className={styles.listMessage}>
          <strong>Varning vid frisläpp — otillräckligt lagersaldo:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </FormNotice>
      )}
      {failures.length > 0 && (
        <FormError margin="below">
          <strong>{failures.length === 1 ? "Åtgärden misslyckades:" : "Misslyckades för:"}</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {failures.map((f, i) => (
              <li key={`${f.orderNumber}-${i}`}>
                {f.orderNumber} — {f.message}
              </li>
            ))}
          </ul>
        </FormError>
      )}

      {/* Mobile stack (≤640px, see Table.module.css): the table's header row
          — and with it the select-all checkbox — is hidden, and the bar
          under 50 stacked cards is out of reach. This sticky bar above the
          list carries "Välj alla" and the bulk buttons instead; CSS hides
          it on wider screens where the header checkbox and .bulkBar serve. */}
      {!readOnly && (
      <div className={styles.selectBar} role="region" aria-label="Markera ordrar">
        <label className={styles.selectAllLabel}>
          <SelectAllCheckbox
            checked={allSelectedOnPage}
            indeterminate={selectedOnPage > 0 && !allSelectedOnPage}
            disabled={selectableRows.length === 0 || busy}
            onChange={toggleAll}
            ariaLabel="Välj alla ordrar på sidan"
          />
          Välj alla på sidan ({selectableRows.length})
        </label>
        {selectedRows.length > 0 && (
          <>
            <span>{selectedSummary}</span>
            {bulkButtons}
          </>
        )}
      </div>
      )}

      <Table<ManufacturingOrder>
        columns={[
          {
            key: "select",
            label: "",
            width: "36px",
            header: (
              <SelectAllCheckbox
                checked={allSelectedOnPage}
                indeterminate={selectedOnPage > 0 && !allSelectedOnPage}
                disabled={selectableRows.length === 0 || busy}
                onChange={toggleAll}
                ariaLabel="Välj alla ordrar på sidan"
              />
            ),
          },
          { key: "orderNumber", label: "Ordernummer", width: "130px" },
          { key: "articleNumber", label: "Artikel", width: "minmax(160px, 1fr)" },
          { key: "quantity", label: "Antal", width: "90px", align: "right" as const },
          { key: "dueDate", label: "Färdigt", width: "110px" },
          { key: "status", label: "Status", width: "120px" },
          { key: "actions", label: "Åtgärder", width: "210px", align: "right" as const },
        ].filter((c) => !readOnly || (c.key !== "actions" && c.key !== "select"))}
        rows={orders.rows}
        emptyText="Inga ordrar matchar sökningen"
        renderCell={(order, key) => {
          switch (key) {
            case "select": {
              const selectable = actionsForStatus(order.status).length > 0;
              return (
                <Checkbox
                  checked={selected.has(order.id)}
                  disabled={!selectable || busy}
                  onChange={(e) => toggleRow(order.id, e.target.checked)}
                  aria-label={`Välj ${order.orderNumber}`}
                />
              );
            }
            case "orderNumber":
              return (
                <Link href={`/tillverkning/ordrar/${order.id}`} className={styles.rowLink}>
                  {order.orderNumber}
                </Link>
              );
            case "articleNumber":
              return (
                <>
                  {order.articleNumber} — {order.articleName}
                  <ArticleOverviewButton articleId={order.articleId} articleNumber={order.articleNumber} />
                </>
              );
            case "quantity":
              return Number(order.quantity);
            case "dueDate":
              return order.dueDate ?? "—";
            case "status": {
              const pill = MANUFACTURING_ORDER_STATUS_PILL[order.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "actions": {
              const actions = actionsForStatus(order.status);
              if (order.status === "in_progress") {
                // Completing books the receipt and needs a location and a
                // quantity — that form lives on the card.
                return (
                  <Link href={`/tillverkning/ordrar/${order.id}`} className={`${buttonStyles.button} ${buttonStyles.ghost} ${buttonStyles.small}`}>
                    Slutför på kortet
                  </Link>
                );
              }
              if (actions.length === 0) return null;
              return (
                <span className={styles.rowActions}>
                  {actions.map((action) => (
                    <Button
                      key={action}
                      type="button"
                      size="small"
                      variant={action === "cancel" ? "danger" : "secondary"}
                      disabled={busy}
                      onClick={() => runOne(order, action)}
                    >
                      {pendingId === order.id ? "Arbetar…" : ACTION_LABELS[action].label}
                    </Button>
                  ))}
                </span>
              );
            }
            default:
              return null;
          }
        }}
      />

      {/* Desktop: the bar under the table, shown while rows are selected.
          Hidden by CSS in the mobile stack, where .selectBar above the
          table carries the same buttons. */}
      {!readOnly && selectedRows.length > 0 && (
        <div className={styles.bulkBar} role="region" aria-label="Åtgärder för valda ordrar">
          <span>{selectedSummary}</span>
          {bulkButtons}
        </div>
      )}

      <Pagination total={orders.total} pageSize={pageSize} />

      {!readOnly && (
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny tillverkningsorder">
        <NewManufacturingOrderForm />
      </Modal>
      )}
    </>
  );
}
