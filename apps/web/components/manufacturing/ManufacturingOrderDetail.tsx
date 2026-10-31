"use client";

import { RowDeviationLink } from "../quality/RowDeviationLink";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { StatusPill } from "../ui/StatusPill";
import { Input } from "../ui/Field";
import { minutesPerUnitToSecondsPerUnit, minutesPerUnitToUnitsPerHour, toUnitQuantity } from "../../lib/units";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { takeReleaseWarnings } from "../../lib/releaseWarnings";
import { confirmDelete } from "../../lib/confirm";
import { MoMaterialModal } from "./MoMaterialModal";
import { OperationModal, type OperationPayload } from "../articles/OperationModal";
import { ReportsSection } from "./ReportsSection";
import { ReportPanel } from "./ReportPanel";
import { PalletCardDialog, type PalletCardTarget } from "../documents/PalletCardDialog";
import { moOperationLabel } from "../../lib/moReportRows";
import { useCan, useCanOpen } from "../PermissionsProvider";
import { ACTION_LABELS, actionsForStatus, confirmCancel, runOrderAction, type OrderAction } from "../../lib/manufacturingOrderActions";
import {
  MANUFACTURING_ORDER_STATUS_PILL,
  type CostCalculation,
  type CostCalculationDraft,
  type EmployeeDirectoryEntry,
  type ManufacturingOrder,
  type MOMaterialConsumption,
  type MOOperationDeleteResult,
  type MOOperationSaveResult,
  type WorkCenter,
  type MOOperation,
  type MOReport,
  type ScrapEntry,
  type StockLocation,
  type TimeReport,
} from "../../lib/types";
import { Card } from "../ui/Card";
import { ConfigurationLineList } from "../configurator/ConfigurationLines";
import { configurationLines } from "../../lib/configurationLines";
import { formatMoney, formatQuantity } from "../../lib/format";
import { FormError, FormHint, FormNotice, FormStack } from "../ui/Form";
import { CostCalculationList } from "../costing/CostCalculationList";
import { CostChain } from "../ui/CostChain";
import { chainLines } from "../../lib/costChain";
import { SectionHeading } from "../ui/SectionHeading";
import { AuditTrailSection } from "../system/AuditTrailSection";
import { Lock } from "lucide-react";
import { plannedWeekLabel } from "../../lib/planning";

interface ManufacturingOrderDetailProps {
  order: ManufacturingOrder;
  materials: MOMaterialConsumption[];
  operations: MOOperation[];
  locations: StockLocation[];
  timeReports: TimeReport[];
  employees: EmployeeDirectoryEntry[];
  costCalculations: CostCalculation[];
  scrap: ScrapEntry[];
  reports: MOReport[];
  // Ångra rapportering — admin/arbetsledare with Tillverkning.
  canUndoReports: boolean;
}

export function ManufacturingOrderDetail({
  order,
  materials,
  operations,
  locations,
  timeReports,
  employees,
  costCalculations,
  scrap,
  reports,
  canUndoReports,
}: ManufacturingOrderDetailProps) {
  const router = useRouter();
  const can = useCan();
  const canOpen = useCanOpen();
  const isAdmin = can(["admin"]);
  // Skapa avvikelse per kassationsrad.
  const canReportDeviation = can(["kvalitet"]);
  // Workshop profile: the card is read-only (no actions, calculations or due date).
  const readOnly = !can(["tillverkning"]);
  const pill = MANUFACTURING_ORDER_STATUS_PILL[order.status];
  const [releaseWarnings, setReleaseWarnings] = useState<string[] | null>(null);
  // A TO is released when it is created — the form hands its shortage
  // warnings over (read once, so a reload does not show them again).
  useEffect(() => {
    const handedOver = takeReleaseWarnings(order.id);
    if (handedOver) setReleaseWarnings(handedOver);
  }, [order.id]);
  // Produktionsplanering: Sen (planned finish after the due date), from the
  // order's plan summary.
  const late = order.late === true;
  // Opens the specification for the calculation that was just made.
  const [openCalculationId, setOpenCalculationId] = useState<string | null>(null);

  // Ändra material och operationer: only while the order is released or in
  // progress, and never in the workshop profile's read-only mode.
  const canEditLines = !readOnly && (order.status === "released" || order.status === "in_progress");
  const [materialDialog, setMaterialDialog] = useState<{ editing: MOMaterialConsumption | null } | null>(null);
  const [operationDialog, setOperationDialog] = useState<{ editing: MOOperation | null } | null>(null);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [palletCard, setPalletCard] = useState<PalletCardTarget | null>(null);
  // Warnings (shortage, planning) and the outcome of the last change.
  const [changeNotice, setChangeNotice] = useState<{ warnings: string[]; message?: string } | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  // Historik fetches on mount — remounted after a change so the new event shows.
  const [historyKey, setHistoryKey] = useState(0);
  function afterLineChange() {
    setHistoryKey((k) => k + 1);
    router.refresh();
  }

  function openOperationDialog(editing: MOOperation | null) {
    setOperationDialog({ editing });
    if (workCenters.length === 0) {
      apiFetch<WorkCenter[]>("/api/v1/work-centers")
        .then((rows) => setWorkCenters(rows.filter((wc) => wc.active)))
        .catch(() => setWorkCenters([]));
    }
  }

  // Nothing reported on the operation, as far as this card can see — the
  // server makes the final call (mo-operation-reported / -linked-purchase).
  function operationUntouched(op: MOOperation) {
    return (
      op.status === "pending" &&
      !(Number(op.quantityCompleted ?? 0) > 0) &&
      !(Number(op.quantityScrapped) > 0) &&
      op.actualTime === null &&
      !reports.some((r) => r.moOperationId === op.id) &&
      !timeReports.some((t) => t.operationSequenceNo === op.sequenceNo)
    );
  }

  async function removeMaterial(row: MOMaterialConsumption) {
    if (!(await confirmDelete(`Ta bort materialet ${row.componentArticleNumber} från ordern?`))) return;
    setLineError(null);
    try {
      await apiFetch(`/api/v1/manufacturing-orders/${order.id}/materials/${row.id}`, { method: "DELETE" });
      setChangeNotice(null);
      afterLineChange();
    } catch (err) {
      setLineError(apiErrorMessage(err, "Kunde inte ta bort materialet"));
    }
  }

  async function removeOperation(op: MOOperation) {
    if (!(await confirmDelete(`Ta bort operation ${op.sequenceNo} från ordern?`))) return;
    setLineError(null);
    try {
      const res = await apiFetch<MOOperationDeleteResult>(
        `/api/v1/manufacturing-orders/${order.id}/operations/${op.id}`,
        { method: "DELETE" }
      );
      const unlinked = res?.unlinkedMaterials ?? 0;
      setChangeNotice({
        warnings: res?.warnings ?? [],
        message:
          unlinked > 0
            ? `${unlinked} materialrad${unlinked === 1 ? "" : "er"} var kopplad${unlinked === 1 ? "" : "e"} till operationen och dras nu vid inleverans.`
            : undefined,
      });
      afterLineChange();
    } catch (err) {
      setLineError(apiErrorMessage(err, "Kunde inte ta bort operationen"));
    }
  }

  async function saveOperation(editing: MOOperation | null, payload: OperationPayload) {
    const res = await apiFetch<MOOperationSaveResult>(
      editing
        ? `/api/v1/manufacturing-orders/${order.id}/operations/${editing.id}`
        : `/api/v1/manufacturing-orders/${order.id}/operations`,
      { method: editing ? "PATCH" : "POST", body: JSON.stringify(payload) }
    );
    setChangeNotice({ warnings: res?.warnings ?? [] });
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 20, alignItems: "center" }}>
        <StatusPill status={pill.status} label={pill.label} />
        {late && (
          <span title="Planerat klar ligger efter färdigdatumet">
            <StatusPill status="delayed" label="Sen" />
          </span>
        )}
        <span>
          Antal: <strong>{Number(order.quantity)}</strong>
        </span>
        {/* Delinleverans: OK on the last operation goes into stock at once. */}
        {Number(order.quantityReceived) > 0 && (
          <span>
            Inlevererat: <strong>{Number(order.quantityReceived)}</strong> av {Number(order.quantity)}
          </span>
        )}
        {order.salesOrder && (
          <span>
            Kundorder:{" "}
            {canOpen(`/forsaljning/ordrar/${order.salesOrder.id}`) ? (
              <Link href={`/forsaljning/ordrar/${order.salesOrder.id}`}>
                {order.salesOrder.orderNumber} ({order.salesOrder.customerName})
              </Link>
            ) : (
              <>
                {order.salesOrder.orderNumber} ({order.salesOrder.customerName})
              </>
            )}
          </span>
        )}
        {/* E2 Beläggning: editable only while the order is still open — once
            done/closed/cancelled the planned date is moot. */}
        {!readOnly && (order.status === "planned" || order.status === "released" || order.status === "in_progress") && (
          <DueDateField orderId={order.id} dueDate={order.dueDate} onDone={() => router.refresh()} />
        )}
        {/* Beställningsvara: the förkalkyl's cost per unit is what the finished goods are valued at on
            receipt. Office data — the workshop profile gets null from the server and never sees the row. */}
        {order.configuration && can(["office"]) && (
          <span>
            Lagervärde vid inleverans:{" "}
            <strong>
              {order.configuration.cost.manufacturingCostPerUnit !== null
                ? `${formatMoney(order.configuration.cost.manufacturingCostPerUnit)} kr/st (förkalkyl)`
                : "saknas"}
            </strong>
          </span>
        )}
        {/* Shop-floor printout — the article's drawings are appended. */}
        <a
          href={`/api/v1/manufacturing-orders/${order.id}/pdf`}
          className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          download
        >
          Skriv ut TO (PDF)
        </a>
      </div>
      {order.configuration && (
        <div style={{ marginBottom: "var(--space-6)" }}>
          <ConfigurationLineList lines={configurationLines(order.configuration.selection)} />
        </div>
      )}
      {order.note && <p>{order.note}</p>}

      {releaseWarnings && releaseWarnings.length > 0 && (
        <FormError margin="below">
          <strong>Varning vid frisläpp:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {releaseWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </FormError>
      )}

      {changeNotice && (changeNotice.warnings.length > 0 || changeNotice.message) && (
        <FormNotice style={{ marginBottom: 12 }} role="status">
          {changeNotice.message && <div>{changeNotice.message}</div>}
          {changeNotice.warnings.length > 0 && (
            <ul style={{ margin: changeNotice.message ? "6px 0 0" : 0, paddingLeft: 18 }}>
              {changeNotice.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </FormNotice>
      )}
      {lineError && <FormError margin="below">{lineError}</FormError>}

      <SectionHeading
        actions={
          canEditLines && (
            <Button type="button" variant="ghost" size="small" onClick={() => setMaterialDialog({ editing: null })}>
              + Lägg till material
            </Button>
          )
        }
      >
        Material
      </SectionHeading>
      {materials.length > 0 ? (
        <Table<MOMaterialConsumption>
          columns={[
            { key: "componentArticleNumber", label: "Artikelnummer", width: "150px" },
            { key: "componentName", label: "Benämning", width: "1fr" },
            { key: "moOperationId", label: "Operation", width: "150px" },
            { key: "quantityPlanned", label: "Planerat", width: "100px", align: "right" },
            { key: "unitCode", label: "Enhet", width: "70px" },
            { key: "quantityConsumed", label: "Förbrukat", width: "100px", align: "right" },
            ...(canEditLines ? [{ key: "id", label: "", width: "170px", align: "right" as const }] : []),
          ]}
          rows={materials}
          renderCell={(row, key) => {
            switch (key) {
              case "quantityPlanned":
              case "quantityConsumed":
                // Displayed in the BOM row's unit (snapshotted at release) —
                // stored values are in the component's base unit.
                return toUnitQuantity(Number(row[key]), row.unitFactor);
              case "id":
                return (
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                    <Button type="button" variant="ghost" size="small" onClick={() => setMaterialDialog({ editing: row })}>
                      Ändra
                    </Button>
                    {Number(row.quantityConsumed) === 0 && (
                      <Button type="button" variant="ghost" size="small" onClick={() => removeMaterial(row)}>
                        Ta bort
                      </Button>
                    )}
                  </span>
                );
              case "moOperationId": {
                // Linked material is drawn when its operation is completed;
                // unlinked material is drawn at final reporting.
                const op = operations.find((o) => o.id === row.moOperationId);
                return op ? moOperationLabel(op) : "Vid slutrapportering";
              }
              default:
                return row[key as keyof MOMaterialConsumption];
            }
          }}
        />
      ) : (
        <p>Inga materialrader (artikeln saknar struktur, eller ordern är inte frisläppt än).</p>
      )}

      <SectionHeading
        spaced
        actions={
          canEditLines && (
            <Button type="button" variant="ghost" size="small" onClick={() => openOperationDialog(null)}>
              + Lägg till operation
            </Button>
          )
        }
      >
        Operationer
      </SectionHeading>
      {operations.length > 0 ? (
        <Table<MOOperation>
          columns={[
            { key: "sequenceNo", label: "Sekvensnr", width: "76px", align: "right" },
            { key: "workCenterName", label: "Operation", width: "minmax(110px, 1fr)" },
            { key: "plannedWeek", label: "Planerad vecka", width: "100px" },
            { key: "setupTime", label: "Ställtid (min)", width: "70px", align: "right" },
            { key: "runTimePerUnit", label: "Tid/enhet", width: "76px", align: "right" },
            { key: "status", label: "Status", width: "80px" },
            { key: "quantityCompleted", label: "Antal OK", width: "60px", align: "right" },
            { key: "quantityScrapped", label: "Kasserat", width: "70px", align: "right" },
            { key: "actualTime", label: "Faktisk tid", width: "64px", align: "right" },
            { key: "id", label: "", width: canEditLines ? "120px" : "70px", align: "right" },
          ]}
          rows={operations}
          renderCell={(row, key) => {
            switch (key) {
              case "sequenceNo":
                return row.sequenceNo;
              // Reprint the pallet card for the operation — no quantity
              // param, so it shows the accumulated reported quantity.
              case "id":
                return (
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      onClick={() =>
                        setPalletCard({
                          kind: "single",
                          url: `/api/v1/manufacturing-orders/${order.id}/operations/${row.id}/pallet-card`,
                          // Same default as the API: accumulated OK, else the order quantity.
                          quantity: Number(row.quantityCompleted ?? 0) > 0 ? Number(row.quantityCompleted) : Number(order.quantity),
                          unit: order.articleUnitCode,
                        })
                      }
                    >
                      Pallkort
                    </Button>
                    {canEditLines && row.status === "pending" && (
                      <Button type="button" variant="ghost" size="small" onClick={() => openOperationDialog(row)}>
                        Ändra
                      </Button>
                    )}
                    {canEditLines && operationUntouched(row) && (
                      <Button type="button" variant="ghost" size="small" onClick={() => removeOperation(row)}>
                        Ta bort
                      </Button>
                    )}
                  </span>
                );
              // The description is what the step IS; the resource code keeps
              // the machine visible. Falls back to the resource name.
              case "workCenterName":
                return (
                  <>
                    {row.workCenterCode} · {row.description ?? row.workCenterName}
                    {row.workCenterType === "subcontract" && (
                      // Lego: bought from a supplier, not stamped — the
                      // terminal hides it, so say where the receipt comes
                      // from. Slutför operation stays as manual fallback.
                      <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                        Lego · {row.subcontractSupplierName ?? "leverantör saknas"} — avrapporteras vid inleverans
                      </div>
                    )}
                    {row.packingInstructions && (
                      <div
                        style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}
                        title={row.packingInstructions}
                      >
                        📦 {row.packingInstructions}
                      </div>
                    )}
                  </>
                );
              // Produktionsplanering: the planned weeks; Låst = moved by hand
              // in the Beläggning and left alone by Planera.
              case "plannedWeek": {
                if (row.status === "done" || row.workCenterType === "subcontract") return "–";
                const weeks = plannedWeekLabel(row.plannedStartWeek, row.plannedEndWeek);
                if (!weeks) return <span style={{ color: "var(--color-text-muted)" }}>Ej planerad</span>;
                return (
                  <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    {weeks}
                    {row.planLocked && (
                      <span
                        title="Flyttad för hand — Planera låter veckan ligga kvar"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 12,
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        <Lock size={12} aria-hidden="true" />
                        Låst
                      </span>
                    )}
                  </span>
                );
              }
              case "setupTime":
              case "runTimePerUnit": {
                // Lego operations carry prices, not times.
                if (row.workCenterType === "subcontract") {
                  const price = key === "setupTime" ? row.setupPrice : row.unitPrice;
                  const priceText = price != null ? `${Number(price).toLocaleString("sv-SE")} kr` : "–";
                  if (key === "setupTime" && row.transportPrice != null) {
                    return (
                      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        <span>{priceText}</span>
                        <span style={{ fontSize: 12, color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
                          Transport {Number(row.transportPrice).toLocaleString("sv-SE")} kr
                        </span>
                      </span>
                    );
                  }
                  return priceText;
                }
                if (key === "setupTime") return formatQuantity(row.setupTime);
                // Tid/enhet shows the unit the beredning was saved in — see
                // packages/shared/src/units.ts. Guard: 0 has no meaningful
                // st/h conversion, so it always renders in minutes.
                const runTimePerUnit = Number(row.runTimePerUnit);
                if (row.timeUnit === "units_per_hour" && runTimePerUnit > 0) {
                  return `${minutesPerUnitToUnitsPerHour(runTimePerUnit).toLocaleString("sv-SE")} st/h`;
                }
                if (row.timeUnit === "seconds_per_unit") {
                  return `${formatQuantity(minutesPerUnitToSecondsPerUnit(runTimePerUnit))} sek`;
                }
                return formatQuantity(runTimePerUnit);
              }
              case "status":
                return row.status === "done" ? (
                  <StatusPill status="done" label="Klar" compact />
                ) : (
                  <StatusPill status="draft" label="Väntar" compact />
                );
              case "quantityCompleted":
                return row.quantityCompleted !== null ? formatQuantity(row.quantityCompleted) : "–";
              case "quantityScrapped":
                return Number(row.quantityScrapped) > 0 ? formatQuantity(row.quantityScrapped) : "–";
              case "actualTime":
                return row.actualTime !== null ? Number(row.actualTime) : "–";
              default:
                return row[key as keyof MOOperation];
            }
          }}
        />
      ) : (
        <p>Inga operationer (artikeln saknar operationer i beredningen, eller ordern är inte frisläppt än).</p>
      )}

      {timeReports.length > 0 && (
        <>
          <SectionHeading spaced>Rapporterad tid</SectionHeading>
          <Table<TimeReport>
            columns={[
              { key: "employeeName", label: "Anställd", width: "1fr" },
              { key: "operationSequenceNo", label: "Operation", width: "160px" },
              { key: "date", label: "Datum", width: "120px" },
              { key: "hours", label: "Timmar", width: "100px", align: "right" },
              { key: "note", label: "Anteckning", width: "1fr" },
            ]}
            rows={timeReports}
            renderCell={(row, key) => {
              switch (key) {
                case "operationSequenceNo":
                  return `${row.operationSequenceNo} — ${row.workCenterName}`;
                case "hours":
                  return formatQuantity(row.hours);
                case "note":
                  return row.note ?? "–";
                default:
                  return row[key as keyof TimeReport];
              }
            }}
          />
        </>
      )}

      {scrap.length > 0 && (
        <>
          <SectionHeading spaced>Kassationer</SectionHeading>
          <Table<ScrapEntry>
            columns={[
              { key: "createdAt", label: "Tid", width: "150px" },
              { key: "sequenceNo", label: "Operation", width: "1fr" },
              { key: "quantity", label: "Antal", width: "90px", align: "right" },
              { key: "reason", label: "Orsak", width: "2fr" },
              { key: "employeeName", label: "Anställd", width: "1fr" },
              ...(canReportDeviation ? [{ key: "id", label: "", width: "140px", align: "right" as const }] : []),
            ]}
            rows={scrap}
            renderCell={(row, key) => {
              switch (key) {
                case "createdAt":
                  return new Date(row.createdAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
                case "sequenceNo":
                  return `${row.sequenceNo} — ${row.workCenterName}`;
                case "quantity":
                  return formatQuantity(row.quantity);
                case "employeeName":
                  return row.employeeName ?? "–";
                case "reason":
                  // Orsak from the register, then the comment (older rows: the free text alone).
                  return row.reasonName
                    ? `${row.reasonName}${row.reason ? ` — ${row.reason}` : ""}`
                    : (row.reason ?? "–");
                case "id":
                  return (
                    <RowDeviationLink
                      label="Skapa avvikelse"
                      params={{
                        type: "internal",
                        manufacturingOrderId: order.id,
                        moOperationId: row.moOperationId,
                        articleId: order.articleId,
                        quantity: Number(row.quantity),
                        reasonId: row.reasonId ?? undefined,
                        title: `Kassation operation ${row.sequenceNo}`,
                      }}
                    />
                  );
                default:
                  return row[key as keyof ScrapEntry] as string;
              }
            }}
          />
        </>
      )}

      {canEditLines && (
        <>
          <MoMaterialModal
            open={materialDialog !== null}
            onClose={() => setMaterialDialog(null)}
            orderId={order.id}
            orderArticleId={order.articleId}
            operations={operations}
            editing={materialDialog?.editing ?? null}
            onSaved={(warnings) => {
              setMaterialDialog(null);
              setLineError(null);
              setChangeNotice({ warnings });
              afterLineChange();
            }}
          />
          <OperationModal
            open={operationDialog !== null}
            onClose={() => setOperationDialog(null)}
            workCenters={workCenters}
            editing={operationDialog?.editing ?? null}
            defaultSequenceNo={(operations.reduce((max, op) => Math.max(max, op.sequenceNo), 0)) + 10}
            onSubmit={(payload) => saveOperation(operationDialog?.editing ?? null, payload)}
            onSaved={() => {
              setOperationDialog(null);
              setLineError(null);
              afterLineChange();
            }}
          />
        </>
      )}

      <PalletCardDialog target={palletCard} onClose={() => setPalletCard(null)} />

      {/* Efterrapportering: a done order still takes reports (time, scrap
          and material, no finished goods) until Stäng order. */}
      {!readOnly && (order.status === "released" || order.status === "in_progress" || order.status === "done") && (
        <>
          <SectionHeading spaced>Rapportera</SectionHeading>
          <ReportPanel
            orderId={order.id}
            orderStatus={order.status}
            orderQuantity={order.quantity}
            quantityReceived={order.quantityReceived}
            operations={operations}
            materials={materials}
            locations={locations}
            employees={employees}
            timeReports={timeReports}
            onDone={() => router.refresh()}
          />
        </>
      )}

      <ReportsSection
        orderId={order.id}
        reports={reports}
        onPalletCard={(report) =>
          setPalletCard({
            kind: "single",
            url: `/api/v1/manufacturing-orders/${order.id}/reports/${report.id}/pallet-card`,
            quantity: Number(report.quantityOk),
            unit: order.articleUnitCode,
          })
        }
        canUndo={!readOnly && canUndoReports}
        onDone={() => router.refresh()}
      />

      {!readOnly && costCalculations.length > 0 && (
        <>
          <SectionHeading spaced>Kalkyl</SectionHeading>
          <CostCalculationList
            calculations={costCalculations}
            openId={openCalculationId}
            onCloseSpecification={() => setOpenCalculationId(null)}
            onDeleted={() => router.refresh()}
          />
        </>
      )}

      {!readOnly && (
      <div style={{ marginTop: 20, display: "flex", gap: 16, flexWrap: "wrap" }}>
        {order.status === "planned" && (
          <StatusActions
            orderId={order.id}
            orderNumber={order.orderNumber}
            actions={actionsForStatus("planned")}
            onDone={(warnings) => {
              setReleaseWarnings(warnings);
              router.refresh();
            }}
          />
        )}

        {(order.status === "released" || order.status === "in_progress") && (
          <StatusActions
            orderId={order.id}
            orderNumber={order.orderNumber}
            actions={actionsForStatus(order.status)}
            onDone={() => router.refresh()}
          />
        )}

        {order.status === "done" && (
          <StatusActions
            orderId={order.id}
            orderNumber={order.orderNumber}
            actions={actionsForStatus("done")}
            onDone={() => router.refresh()}
          />
        )}

        <PostCalculateAction
          orderId={order.id}
          onDone={(calculationId) => {
            setOpenCalculationId(calculationId);
            router.refresh();
          }}
        />
      </div>
      )}

      {/* The audit-log API is admin-only. */}
      {isAdmin && <AuditTrailSection key={historyKey} entityType="manufacturing_order" entityId={order.orderNumber} />}
    </div>
  );
}

// --- Planned completion date (E2 Beläggning) — inline edit, no card ---

function DueDateField({
  orderId,
  dueDate,
  onDone,
}: {
  orderId: string;
  dueDate: string | null;
  onDone: () => void;
}) {
  const [value, setValue] = useState(dueDate ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Resync when the server value changes underneath us (router.refresh()
  // after any other action on the card) — otherwise a stale unsaved draft
  // in the input could get POSTed over a newer date on the next Spara.
  useEffect(() => {
    setValue(dueDate ?? "");
  }, [dueDate]);

  async function save() {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/manufacturing-orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ dueDate: value || null }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara datumet");
    } finally {
      setPending(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <label htmlFor="dueDate" style={{ whiteSpace: "nowrap" }}>
        Planerat färdigdatum:
      </label>
      <Input id="dueDate" type="date" size="sm" value={value} onChange={(e) => setValue(e.target.value)} />
      <Button type="button" size="small" variant="secondary" disabled={pending} onClick={save}>
        {pending ? "Sparar…" : "Spara"}
      </Button>
      {error && <span style={{ color: "var(--status-stopped-text)" }}>{error}</span>}
    </span>
  );
}

// --- Release / Makulera / close (no body, just an action call) ---
// Labels/endpoints live in lib/manufacturingOrderActions.ts, shared with the
// TO list's row and bulk actions.

function StatusActions({
  orderId,
  orderNumber,
  actions,
  onDone,
}: {
  orderId: string;
  orderNumber: string;
  actions: OrderAction[];
  onDone: (warnings: string[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function run(action: OrderAction) {
    if (action === "cancel" && !(await confirmCancel([orderNumber]))) return;
    setError(null);
    setPending(action);
    try {
      onDone(await runOrderAction(orderId, action));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Åtgärden misslyckades");
      setPending(null);
    }
  }

  return (
    <Card maxWidth={260}>
      <FormStack>
        <FormError>{error}</FormError>
        {actions.map((action) => (
          <Button
            key={action}
            type="button"
            variant={ACTION_LABELS[action].variant}
            disabled={pending !== null}
            onClick={() => run(action)}
          >
            {pending === action ? "Arbetar…" : ACTION_LABELS[action].label}
          </Button>
        ))}
      </FormStack>
    </Card>
  );
}

// --- Efterkalkyl — shown first, saved only on request. No status gate in the
// backend, so the button is always available. ---

function PostCalculateAction({ orderId, onDone }: { orderId: string; onDone: (calculationId: string) => void }) {
  // The computed but unsaved calculation, warnings included — they belong to
  // the figures on screen, not to a past run.
  const [preview, setPreview] = useState<{ calculation: CostCalculationDraft; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);

  async function run() {
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<{ calculation: CostCalculationDraft; warnings: string[] }>(
        `/api/v1/manufacturing-orders/${orderId}/cost-calculations/post-calculate`,
        { method: "POST" }
      );
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte efterkalkylera");
    } finally {
      setPending(false);
    }
  }

  // Recomputed server-side rather than posting the previewed figures back —
  // the API never trusts numbers from the browser.
  async function save() {
    setError(null);
    setSaving(true);
    try {
      const result = await apiFetch<{ calculation: CostCalculation; warnings: string[] }>(
        `/api/v1/manufacturing-orders/${orderId}/cost-calculations/post-calculate`,
        { method: "POST", body: JSON.stringify({ save: true }) }
      );
      setPreview(null);
      // Hand the saved calculation up so its specification opens right away
      // instead of making the user hunt for it in the history.
      onDone(result.calculation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara kalkylen");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card maxWidth={360}>
      <FormStack>
        <FormError>{error}</FormError>
        <Button type="button" variant="secondary" disabled={pending} onClick={run}>
          {pending ? "Beräknar…" : "Efterkalkylera"}
        </Button>

        {preview && (
          <>
            <FormHint>Beräkningen sparas först när du klickar Spara kalkyl.</FormHint>
            {preview.warnings.length > 0 && (
              <FormError>
                <strong>Varning:</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </FormError>
            )}
            {/* Number(quantity) comes from the calculation itself, not any
                live input — the panel has none, but this keeps the call
                sited the same way as the Kalkyl tab's. */}
            <CostChain lines={chainLines(preview.calculation, Number(preview.calculation.quantity))} />
            <Button type="button" variant="primary" disabled={saving} onClick={save}>
              {saving ? "Sparar…" : "Spara kalkyl"}
            </Button>
          </>
        )}
      </FormStack>
    </Card>
  );
}
