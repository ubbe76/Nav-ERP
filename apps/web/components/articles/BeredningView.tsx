"use client";

import { confirmDelete } from "../../lib/confirm";
import { Fragment, useState } from "react";
import { Button } from "../ui/Button";
import { SectionHeading } from "../ui/SectionHeading";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { Modal } from "../ui/Modal";
import { FormError } from "../ui/Form";
import { NewArticleForm } from "./NewArticleForm";
import { OperationModal } from "./OperationModal";
import { BomComponentModal } from "./BomComponentModal";
import { LegoInquiryModal } from "./LegoInquiryModal";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { minutesPerUnitToUnitsPerHour, toUnitQuantity } from "../../lib/units";
import { operationLabel } from "./operation-label";
import type { ArticleGroup, BomComponent, RoutingOperation, WorkCenter } from "../../lib/types";
import styles from "./Beredning.module.css";

// Tid/enhet and Cykeltid are always stored/returned in minutes per unit — the
// per-operation timeUnit is a pure display preference. Guard: 0 (or less) has
// no meaningful st/h conversion, so it always renders in minutes.
function formatMinutesPerUnit(minutesText: string, timeUnit: RoutingOperation["timeUnit"]): string {
  const minutes = Number(minutesText);
  if (timeUnit === "units_per_hour" && minutes > 0) {
    return `${minutesPerUnitToUnitsPerHour(minutes).toLocaleString("sv-SE")} st/h`;
  }
  return `${minutes.toLocaleString("sv-SE", { maximumFractionDigits: 4 })} min`;
}

interface BeredningViewProps {
  articleId: string;
  articleNumber: string;
  bom: BomComponent[];
  routing: RoutingOperation[];
  workCenters: WorkCenter[];
  groups: ArticleGroup[];
  // Parent reloads tree + view data after any mutation.
  onChanged: () => void;
}

// The grouped beredning view: each routing operation is a group header with
// the BOM components tied to it nested underneath (the material drawn when
// that operation is reported), and material without an operation link in a
// trailing "Ej kopplat material" group. Add/edit forms live in modals so the
// whole beredning fits on screen.
export function BeredningView({
  articleId,
  articleNumber,
  bom,
  routing,
  workCenters,
  groups,
  onChanged,
}: BeredningViewProps) {
  // Lego inquiries are Inköp writes (POST /inquiries).
  const canInkop = useCan()(["inkop"]);
  const sortedOps = [...routing].sort((a, b) => a.sequenceNo - b.sequenceNo);
  const opIds = new Set(sortedOps.map((op) => op.id));
  // A component whose operation link points outside the current routing
  // (should not happen) falls back to the unlinked group rather than vanishing.
  const unlinked = bom.filter((row) => row.routingOperationId === null || !opIds.has(row.routingOperationId));

  const lastOp = sortedOps[sortedOps.length - 1];
  const defaultSequenceNo = lastOp ? lastOp.sequenceNo + 10 : 10;

  const [opModal, setOpModal] = useState<{ open: boolean; editing: RoutingOperation | null }>({
    open: false,
    editing: null,
  });
  const [compModal, setCompModal] = useState<{
    open: boolean;
    editing: BomComponent | null;
    presetOperationId: string;
  }>({ open: false, editing: null, presetOperationId: "" });
  const [newArticleOpen, setNewArticleOpen] = useState(false);
  const [legoModal, setLegoModal] = useState<{ open: boolean; op: RoutingOperation | null }>({
    open: false,
    op: null,
  });
  // Errors from the delete buttons — the modals carry their own.
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function removeOperation(op: RoutingOperation) {
    if (!(await confirmDelete(`Ta bort operation ${op.sequenceNo} (${op.description ?? op.workCenterName})?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/routing/${op.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort operationen");
    } finally {
      setPending(false);
    }
  }

  // Per-row min/st | st/h switch. Storage is always minutes per unit, so the
  // PATCH carries ONLY the display preference — no conversion, nothing else
  // on the operation is touched (same endpoint the dialog uses).
  async function changeTimeUnit(op: RoutingOperation, timeUnit: RoutingOperation["timeUnit"]) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/routing/${op.id}`, {
        method: "PATCH",
        body: JSON.stringify({ timeUnit }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte byta tidsenhet");
    } finally {
      setPending(false);
    }
  }

  async function removeComponent(row: BomComponent) {
    if (!(await confirmDelete(`Ta bort ${row.componentArticleNumber} ur strukturen?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/bom/${row.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort komponenten");
    } finally {
      setPending(false);
    }
  }

  function renderComponentRow(row: BomComponent) {
    return (
      <div key={row.id} className={styles.compRow}>
        <span className={styles.prepCell}>
          <span className={styles.compName}>
            <span className={styles.compPosition} title={row.position ? `Pos. ${row.position}` : "Pos."}>
              {row.position ?? "—"}
            </span>
            <span className={styles.compNumber}>{row.componentArticleNumber}</span>
            <span className={styles.compBenaming} title={row.componentName}>
              {row.componentIsPhantom ? `${row.componentName} · Fantom` : row.componentName}
            </span>
          </span>
        </span>
        <span className={styles.prepCell} data-align="right" />
        <span className={styles.prepCell} data-align="right" />
        <span className={`${styles.prepCell} num`} data-align="right" data-label="Antal">
          {toUnitQuantity(Number(row.quantity), row.unitFactor)} {row.unitCode}
        </span>
        <span className={`${styles.prepCell} ${styles.actionsCell}`}>
          <Button
            type="button"
            size="small"
            variant="ghost"
            onClick={() => setCompModal({ open: true, editing: row, presetOperationId: "" })}
          >
            Ändra
          </Button>
          <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => removeComponent(row)}>
            Ta bort
          </Button>
        </span>
      </div>
    );
  }

  const empty = sortedOps.length === 0 && bom.length === 0;

  return (
    <div>
      <SectionHeading
        actions={
          <span className={styles.headingActions}>
            <Button type="button" size="small" variant="secondary" onClick={() => setOpModal({ open: true, editing: null })}>
              + Ny operation
            </Button>
            <Button
              type="button"
              size="small"
              variant="secondary"
              onClick={() => setCompModal({ open: true, editing: null, presetOperationId: "" })}
            >
              + Lägg till komponent
            </Button>
          </span>
        }
      >
        Beredning
      </SectionHeading>

      <FormError>{error}</FormError>

      <div className={styles.prep}>
        {empty ? (
          <p className={styles.prepEmpty}>Inga operationer eller komponenter tillagda än.</p>
        ) : (
          <>
            <div className={styles.prepHeader}>
              <span className={styles.prepHeaderCell}>Operation / Pos. · komponent</span>
              <span className={styles.prepHeaderCell} data-align="right">
                Ställtid
              </span>
              <span className={styles.prepHeaderCell} data-align="right">
                Tid/enhet
              </span>
              <span className={styles.prepHeaderCell} data-align="right">
                Antal
              </span>
              <span className={styles.prepHeaderCell} />
            </div>

            {sortedOps.map((op) => (
              <Fragment key={op.id}>
                <div className={styles.opRow}>
                  <span className={styles.prepCell}>
                    <span className={styles.opName}>
                      <span className={styles.opMain}>
                        <span className={styles.opLabel} title={`${op.workCenterCode} · ${op.workCenterName}`}>
                          {operationLabel(op)}
                        </span>
                        <span className={styles.opResource}>{op.workCenterCode}</span>
                        {op.workCenterType === "subcontract" && <span className={styles.kalkylBadge}>Lego</span>}
                        {op.costingOnly && <span className={styles.kalkylBadge}>Kalkyl</span>}
                      </span>
                      {op.workCenterType === "subcontract" && (
                        // A lego operation is bought, not timed — supplier and
                        // drawing source stand where an ordinary row has nothing.
                        <span className={styles.opComment}>
                          {op.subcontractSupplierName ?? "Ingen leverantör"}
                          {op.useArticleDrawing ? " · artikelns ritningar" : op.hasFile ? " · egen ritning" : " · ingen ritning"}
                          {op.showNetWeight ? " · nettovikt på IO" : ""}
                        </span>
                      )}
                      {op.comment && (
                        <span className={styles.opComment} title={op.comment}>
                          {op.printOnWorkCard ? "🖨 " : ""}
                          {op.comment}
                        </span>
                      )}
                      {op.packingInstructions && (
                        <span className={styles.opComment} title={op.packingInstructions}>
                          📦 {op.packingInstructions}
                        </span>
                      )}
                    </span>
                  </span>
                  <span
                    className={`${styles.prepCell} num`}
                    data-align="right"
                    data-label={op.workCenterType === "subcontract" ? "Ställpris" : "Ställtid"}
                  >
                    {op.workCenterType === "subcontract" ? (
                      <span className={styles.timeStack}>
                        <span>
                          {op.setupPrice != null ? `${Number(op.setupPrice).toLocaleString("sv-SE")} kr` : "—"}
                        </span>
                        {op.transportPrice != null && (
                          <span className={styles.cycleTime}>
                            Transport {Number(op.transportPrice).toLocaleString("sv-SE")} kr
                          </span>
                        )}
                      </span>
                    ) : (
                      `${Number(op.setupTime).toLocaleString("sv-SE")} min`
                    )}
                  </span>
                  <span
                    className={`${styles.prepCell} num`}
                    data-align="right"
                    data-label={op.workCenterType === "subcontract" ? "Styckpris" : "Tid/enhet"}
                  >
                    {op.workCenterType === "subcontract" ? (
                      op.unitPrice != null ? (
                        `${Number(op.unitPrice).toLocaleString("sv-SE")} kr`
                      ) : (
                        "—"
                      )
                    ) : (
                      // The value plus the same min/st | st/h switch as the
                      // dialog — a pure display preference, saved on its own
                      // without opening the operation. st/h needs a stycktid
                      // > 0 (0 st/h has no meaning), same rule as the dialog.
                      <span className={styles.timeStack}>
                      <span className={styles.timeCell}>
                        {formatMinutesPerUnit(op.runTimePerUnit, op.timeUnit)}
                        <SegmentedToggle
                          size="small"
                          value={op.timeUnit}
                          disabled={pending}
                          ariaLabel={`Tidsenhet för operation ${op.sequenceNo}`}
                          onChange={(next) => void changeTimeUnit(op, next)}
                          options={[
                            { value: "minutes_per_unit", label: "min/st" },
                            {
                              value: "units_per_hour",
                              label: "st/h",
                              disabled: !(Number(op.runTimePerUnit) > 0),
                              title: Number(op.runTimePerUnit) > 0 ? undefined : "Kräver stycktid större än 0",
                            },
                          ]}
                        />
                      </span>
                      {op.cycleTimePerUnit != null && (
                        <span className={styles.cycleTime}>
                          Cykeltid {formatMinutesPerUnit(op.cycleTimePerUnit, op.timeUnit)}
                        </span>
                      )}
                      </span>
                    )}
                  </span>
                  <span className={styles.prepCell} data-align="right" />
                  <span className={`${styles.prepCell} ${styles.actionsCell}`}>
                    {canInkop && op.workCenterType === "subcontract" && (
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        onClick={() => setLegoModal({ open: true, op })}
                      >
                        Skicka förfrågan
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      onClick={() => setOpModal({ open: true, editing: op })}
                    >
                      Ändra
                    </Button>
                    <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => removeOperation(op)}>
                      Ta bort
                    </Button>
                  </span>
                </div>

                {bom.filter((row) => row.routingOperationId === op.id).map(renderComponentRow)}

                {/* Kalkyl operations can't carry material — the API refuses
                    the link (409), so no add row is offered. */}
                {!op.costingOnly && (
                  <div className={styles.addCompRow}>
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      onClick={() => setCompModal({ open: true, editing: null, presetOperationId: op.id })}
                    >
                      + Komponent
                    </Button>
                  </div>
                )}
              </Fragment>
            ))}

            {unlinked.length > 0 && (
              <>
                <div className={styles.groupRow}>Ej kopplat material</div>
                {unlinked.map(renderComponentRow)}
              </>
            )}
          </>
        )}
      </div>

      <OperationModal
        open={opModal.open}
        onClose={() => setOpModal({ open: false, editing: null })}
        articleId={articleId}
        workCenters={workCenters}
        editing={opModal.editing}
        defaultSequenceNo={defaultSequenceNo}
        onSaved={() => {
          setOpModal({ open: false, editing: null });
          onChanged();
        }}
      />

      <BomComponentModal
        open={compModal.open}
        onClose={() => setCompModal({ open: false, editing: null, presetOperationId: "" })}
        articleId={articleId}
        routing={routing}
        editing={compModal.editing}
        presetOperationId={compModal.presetOperationId}
        onSaved={() => {
          setCompModal({ open: false, editing: null, presetOperationId: "" });
          onChanged();
        }}
        onNewArticle={() => {
          setCompModal({ open: false, editing: null, presetOperationId: "" });
          setNewArticleOpen(true);
        }}
      />

      <Modal open={newArticleOpen} onClose={() => setNewArticleOpen(false)} title="Ny artikel i strukturen">
        <NewArticleForm
          groups={groups}
          attachToArticleId={articleId}
          onSuccess={() => {
            setNewArticleOpen(false);
            onChanged();
          }}
        />
      </Modal>

      {canInkop && legoModal.op && (
        <LegoInquiryModal
          open={legoModal.open}
          onClose={() => setLegoModal({ open: false, op: null })}
          articleId={articleId}
          articleNumber={articleNumber}
          operation={legoModal.op}
        />
      )}
    </div>
  );
}
