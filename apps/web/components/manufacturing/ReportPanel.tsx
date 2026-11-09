"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input, Label, Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { ScrapReasonFields } from "../quality/ScrapReasonFields";
import { useScrapReasons } from "../../lib/useScrapReasons";
import { locationOptionLabel } from "../../lib/stockLocations";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { confirmDialog } from "../../lib/confirm";
import { notify } from "../../lib/notice";
import { formatQuantity } from "../../lib/format";
import { defaultReportKind, suggestedConsumeQuantity, suggestedReportHours } from "../../lib/moSuggestions";
import { groupReportRows, moOperationLabel } from "../../lib/moReportRows";
import { stockholmToday } from "../../lib/date";
import type {
  EmployeeDirectoryEntry,
  MOMaterialConsumption,
  MOOperation,
  StockLocation,
  TimeKind,
  TimeReport,
} from "../../lib/types";
import styles from "./ReportPanel.module.css";

// Manual reporting on the TO card in one card: a row per operation (OK,
// scrapped, time, Slutför) with its linked material underneath (Förbruka),
// the material drawn at final reporting, a time row and Slutför order.
// Efterrapportering: a done order takes the same reports minus the finished
// goods, so the Slutför order row is only for released / in_progress.

interface ReportPanelProps {
  orderId: string;
  orderStatus: string;
  orderQuantity: string;
  quantityReceived: string;
  operations: MOOperation[];
  materials: MOMaterialConsumption[];
  locations: StockLocation[];
  employees: EmployeeDirectoryEntry[];
  timeReports: TimeReport[];
  // Dela tid i ställ och produktion: Rapportera tid gets a Typ field.
  timeKindSplit?: boolean;
  // Ångra rapportering (admin/arbetsledare): the notice after Slutför
  // operation offers Ångra on exactly that report.
  canUndoReports?: boolean;
  onDone: () => void;
}

// A grid cell: the label is only drawn on a phone (the column header row
// carries it on a desktop); the input itself has an aria-label either way.
function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={[styles.cell, className].filter(Boolean).join(" ")}>
      <span className={styles.mobileLabel} aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}

function LocationOptions({
  locations,
  emptyLabel = "Artikelns lagerplats",
}: {
  locations: StockLocation[];
  emptyLabel?: string;
}) {
  return (
    <>
      <option value="">{emptyLabel}</option>
      {locations.map((l) => (
        <option key={l.id} value={l.id}>
          {locationOptionLabel(l)}
        </option>
      ))}
    </>
  );
}

export function ReportPanel({
  orderId,
  orderStatus,
  orderQuantity,
  quantityReceived,
  operations,
  materials,
  locations,
  employees,
  timeReports,
  timeKindSplit = false,
  canUndoReports = false,
  onDone,
}: ReportPanelProps) {
  const orderDone = orderStatus === "done";
  const [locationId, setLocationId] = useState(""); // "" = Automatiskt (own location, then other locations with stock)
  const scrapReasonOptions = useScrapReasons();
  const { groups, unlinked } = groupReportRows(operations, materials);

  return (
    <Card maxWidth="none">
      <div className={styles.panel}>
        <div className={styles.header}>
          <FormHint>
            {orderDone
              ? "Ordern är klar. Det du rapporterar nu kommer med i efterkalkylen: antal, kassation och material som är kopplat till operationen. Inga fler färdiga varor läggs in i lager."
              : "Kopplat material dras automatiskt för antal OK + kasserat. En operation blir klar när hela orderns antal är rapporterat som OK."}
          </FormHint>
          {/* Stock locations are optional — the select only appears when some exist. */}
          {locations.length > 0 && (
            <div className={styles.inlineField}>
              <Label htmlFor="reportMaterialLocation">Lagerplats för materialuttag</Label>
              <Select
                id="reportMaterialLocation"
                size="md"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <LocationOptions locations={locations} emptyLabel="Automatiskt" />
              </Select>
            </div>
          )}
        </div>
        {locations.length > 0 && (
          <FormHint>
            Tas från artikelns lagerplats och sedan från andra platser med saldo. En vald plats tar även emot de färdiga
            varorna när den sista operationen rapporteras. En spärrad lagerplats tar bara emot de färdiga varorna — materialet tas då med Automatiskt.
          </FormHint>
        )}

        {/* Column labels once; on a phone each row stacks and its own labels show. */}
        <div className={`${styles.line} ${styles.head}`} aria-hidden="true">
          <span>Operation</span>
          <span>Klart/Kvar</span>
          <span>Antal klart</span>
          <span>Kasserat</span>
          <span>Faktisk tid</span>
          <span />
        </div>

        {groups.map(({ operation, materials: linked }) => (
          <div key={operation.id} className={styles.section}>
            <OperationRow
              orderId={orderId}
              orderQuantity={orderQuantity}
              operation={operation}
              locationId={locationId}
              scrapReasonOptions={scrapReasonOptions}
              canUndo={canUndoReports}
              onDone={onDone}
            />
            {linked.map((m) => (
              <MaterialRow key={m.id} orderId={orderId} material={m} locationId={locationId} canUndo={canUndoReports} onDone={onDone} />
            ))}
          </div>
        ))}

        {unlinked.length > 0 && (
          <div className={styles.section}>
            <div className={styles.groupTitle}>Vid slutrapportering</div>
            {unlinked.map((m) => (
              <MaterialRow key={m.id} orderId={orderId} material={m} locationId={locationId} canUndo={canUndoReports} onDone={onDone} />
            ))}
          </div>
        )}

        <ReportTimeRow
          employees={employees}
          operations={operations}
          orderQuantity={orderQuantity}
          timeReports={timeReports}
          timeKindSplit={timeKindSplit}
          canUndo={canUndoReports}
          onDone={onDone}
        />

        {(orderStatus === "released" || orderStatus === "in_progress") && (
          // No Starta: Slutför order works straight on a released order.
          <CompleteOrderRow
            orderId={orderId}
            orderQuantity={orderQuantity}
            quantityReceived={quantityReceived}
            locations={locations}
            canUndo={canUndoReports}
            onDone={onDone}
          />
        )}
      </div>
    </Card>
  );
}

// --- One operation: summary, OK / scrapped / time, Slutför ---

function OperationRow({
  orderId,
  orderQuantity,
  operation: op,
  locationId,
  scrapReasonOptions,
  canUndo,
  onDone,
}: {
  orderId: string;
  orderQuantity: string;
  operation: MOOperation;
  locationId: string;
  scrapReasonOptions: ReturnType<typeof useScrapReasons>;
  canUndo: boolean;
  onDone: () => void;
}) {
  // Prefilled with what REMAINS of the order quantity (terminal partials
  // already accumulated on the operation aren't double-counted).
  const [quantity, setQuantity] = useState<string | null>(null);
  const [scrapped, setScrapped] = useState("0");
  const [actualTime, setActualTime] = useState("");
  const [scrapReason, setScrapReason] = useState("");
  // Kassationsorsaker from Kvalitetsorsaker: Orsak is chosen, scrapReason holds the Kommentar.
  const [scrapReasonId, setScrapReasonId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRegister = scrapReasonOptions !== null && scrapReasonOptions.length > 0;
  const isPending = op.status === "pending";
  const remaining = String(Math.max(Number(orderQuantity) - Number(op.quantityCompleted ?? 0), 0));

  async function complete() {
    const scrapQty = Number(scrapped) || 0;
    if (scrapQty > 0 && reasonRegister && scrapReasonId === "") {
      setError("Välj en orsak när kasserat antal är större än 0.");
      return;
    }
    if (scrapQty > 0 && !reasonRegister && scrapReason.trim() === "") {
      setError("Ange en kassationsorsak när kasserat antal är större än 0.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const quantityCompleted = quantity ?? remaining;
      const completed = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch(`/api/v1/manufacturing-orders/${orderId}/operations/${op.id}/complete`, {
          method: "POST",
          body: JSON.stringify({
            ...(actualTime ? { actualTime: Number(actualTime) } : {}),
            quantityCompleted: Number(quantityCompleted) || 0,
            quantityScrapped: scrapQty,
            ...(scrapQty > 0 && reasonRegister ? { scrapReasonId } : {}),
            scrapReason: scrapReason.trim() || undefined,
            locationId: locationId || undefined,
            allowMaterialShortage,
          }),
        })
      );
      if (completed === null) {
        setPending(false);
        return;
      }
      // Auto-open the pallet card for the just-reported quantity — best
      // effort (a popup blocker may stop a window.open after an async
      // call); the Pallkort link on the operation row is the always-there
      // fallback. Without a positive quantity the card falls back to the
      // operation's accumulated quantity.
      const reported = Number(quantityCompleted) || 0;
      const reportId = (completed as { reportId?: string | null }).reportId ?? null;
      window.open(
        reportId
          ? `/api/v1/manufacturing-orders/${orderId}/reports/${reportId}/pallet-card`
          : `/api/v1/manufacturing-orders/${orderId}/operations/${op.id}/pallet-card${reported > 0 ? `?quantity=${reported}` : ""}`,
        "_blank",
        "noopener"
      );
      // Återkoppling (punkt 7): what was booked, with Ångra on this report.
      notify({
        message: `Rapporterat ${formatQuantity(reported)} OK${scrapQty > 0 ? ` och ${formatQuantity(scrapQty)} kasserat` : ""} på ${moOperationLabel(op)}.`,
        action:
          canUndo && reportId
            ? {
                label: "Ångra",
                run: async () => {
                  await apiFetch(`/api/v1/manufacturing-orders/${orderId}/reports/${reportId}/undo`, { method: "POST" });
                  onDone();
                  return "Rapporteringen är ångrad.";
                },
              }
            : undefined,
      });
      // router.refresh keeps this row's state, and a partial report leaves
      // the operation pending — start over from the new remainder.
      setQuantity(null);
      setScrapped("0");
      setActualTime("");
      setScrapReason("");
      setScrapReasonId("");
      setPending(false);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte slutföra operationen"));
      setPending(false);
    }
  }

  return (
    <>
      <div className={styles.line}>
        <div className={styles.title}>
          <span className={styles.name}>{moOperationLabel(op)}</span>
          {isPending && op.workCenterType === "subcontract" && (
            <span className={styles.hint}>Lego — avrapporteras vid inleverans</span>
          )}
        </div>
        {/* Kvar = planned − OK; scrapped units must be made again. */}
        <div className={`num ${styles.summary}`}>
          {isPending ? (
            <span title={`Planerat ${Number(orderQuantity)}`}>
              {Number(op.quantityCompleted ?? 0)} / <strong>{remaining}</strong>
              <span className={styles.mobileLabel}> (Klart / Kvar)</span>
            </span>
          ) : (
            <span>Klart {Number(op.quantityCompleted ?? 0)} av {Number(orderQuantity)} · Klar</span>
          )}
          {Number(op.quantityScrapped) > 0 && <div>Kasserat {Number(op.quantityScrapped)}</div>}
        </div>
        {isPending && (
          <>
            <Cell label="Antal klart">
              <Input
                id={`quantityCompleted-${op.id}`}
                aria-label={`Antal klart för ${moOperationLabel(op)}`}
                type="number"
                min="0"
                step="any"
                size="sm"
                value={quantity ?? remaining}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Cell>
            <Cell label="Kasserat">
              <Input
                id={`quantityScrapped-${op.id}`}
                aria-label={`Kasserat för ${moOperationLabel(op)}`}
                type="number"
                min="0"
                step="any"
                size="sm"
                value={scrapped}
                onChange={(e) => setScrapped(e.target.value)}
              />
            </Cell>
            <Cell label="Faktisk tid">
              <Input
                id={`actualTime-${op.id}`}
                aria-label={`Faktisk tid för ${moOperationLabel(op)}`}
                type="number"
                min="0"
                step="0.01"
                size="sm"
                value={actualTime}
                onChange={(e) => setActualTime(e.target.value)}
              />
            </Cell>
            <div className={styles.action}>
              <Button type="button" variant="secondary" size="small" disabled={pending} onClick={complete}>
                {pending ? "…" : "Slutför"}
              </Button>
            </div>
          </>
        )}
      </div>
      {isPending && Number(scrapped) > 0 && (
        <ScrapReasonFields
          idPrefix={`scrap-${op.id}`}
          reasons={scrapReasonOptions}
          reasonId={scrapReasonId}
          text={scrapReason}
          onReasonId={setScrapReasonId}
          onText={setScrapReason}
        />
      )}
      <FormError>{error}</FormError>
    </>
  );
}

// Ångra in a notice: undoes exactly that report (POST …/reports/:id/undo,
// the same route as Ångra under Rapporteringar).
function undoReportAction(orderId: string, reportId: string, onDone: () => void, doneText: string) {
  return {
    label: "Ångra",
    run: async () => {
      await apiFetch(`/api/v1/manufacturing-orders/${orderId}/reports/${reportId}/undo`, { method: "POST" });
      onDone();
      return doneText;
    },
  };
}

// --- One material row: numbers, and Förbruka while something remains ---

function MaterialRow({
  orderId,
  material: m,
  locationId,
  canUndo,
  onDone,
}: {
  orderId: string;
  material: MOMaterialConsumption;
  locationId: string;
  canUndo: boolean;
  onDone: () => void;
}) {
  // Antal is prefilled with what remains of the row's planned quantity; a
  // typed value wins until the draw is booked.
  const [typedQuantity, setTypedQuantity] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = Number(m.quantityConsumed) < Number(m.quantityPlanned);
  const quantity = typedQuantity ?? suggestedConsumeQuantity(m);

  async function consume(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      // Entered in the material row's display unit, booked in the base unit.
      const consumed = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch(`/api/v1/manufacturing-orders/${orderId}/materials/${m.id}/consume`, {
          method: "POST",
          body: JSON.stringify({
            locationId: locationId || undefined,
            quantity: toBaseQuantity(Number(quantity), m.unitFactor ?? null),
            allowMaterialShortage,
          }),
        })
      );
      if (consumed === null) return;
      // Återkoppling: what was drawn, with Ångra on exactly this draw.
      const reportId = (consumed as { reportId?: string }).reportId ?? null;
      notify({
        message: `Förbrukat ${formatQuantity(Number(quantity))} ${m.unitCode} ${m.componentArticleNumber}.`,
        action: canUndo && reportId ? undoReportAction(orderId, reportId, onDone, "Förbrukningen är ångrad.") : undefined,
      });
      setTypedQuantity(null);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte förbruka materialet"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form className={`${styles.line} ${styles.material}`} onSubmit={consume}>
        <div className={styles.title}>
          <span>
            <span className={styles.name}>{m.componentArticleNumber}</span> {m.componentName}
          </span>
        </div>
        <div className={`num ${styles.summary}`}>
          {toUnitQuantity(Number(m.quantityConsumed), m.unitFactor)}/{toUnitQuantity(Number(m.quantityPlanned), m.unitFactor)} {m.unitCode}
        </div>
        {open && (
          <>
            <Cell label={`Antal (${m.unitCode})`} className={styles.qty}>
              <Input
                id={`consumeQuantity-${m.id}`}
                aria-label={`Antal (${m.unitCode}) för ${m.componentArticleNumber} ${m.componentName}`}
                type="number"
                min="0"
                step="any"
                required
                size="sm"
                value={quantity}
                onChange={(e) => setTypedQuantity(e.target.value)}
              />
              <span className={styles.unit}>{m.unitCode}</span>
            </Cell>
            <div className={styles.action}>
              <Button type="submit" variant="secondary" size="small" disabled={pending}>
                {pending ? "Förbrukar…" : "Förbruka"}
              </Button>
            </div>
          </>
        )}
      </form>
      <FormError>{error}</FormError>
    </>
  );
}

// --- Report time ---

function ReportTimeRow({
  employees,
  operations,
  orderQuantity,
  timeReports,
  timeKindSplit,
  canUndo,
  onDone,
}: {
  employees: EmployeeDirectoryEntry[];
  operations: MOOperation[];
  orderQuantity: string;
  timeReports: TimeReport[];
  timeKindSplit: boolean;
  canUndo: boolean;
  onDone: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const [operationId, setOperationId] = useState(operations[0]?.id ?? "");
  const [date, setDate] = useState(stockholmToday());
  // Timmar is prefilled with the operation's theoretical time less what is
  // already reported on it; a typed value wins until another operation is
  // picked or the report is saved.
  // Typ (Dela tid i ställ och produktion): förval Produktion, "" = ej
  // uppdelad. The suggestion follows it, but switching Typ never overwrites
  // a typed value.
  const [kind, setKind] = useState<TimeKind | "">(defaultReportKind(timeKindSplit));
  const [typedHours, setTypedHours] = useState<string | null>(null);
  const hours =
    typedHours ??
    suggestedReportHours(operations.find((op) => op.id === operationId), orderQuantity, timeReports, timeKindSplit ? kind : "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (employees.length === 0 || operations.length === 0) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await apiFetch<{ id: string }>("/api/v1/time-reports", {
        method: "POST",
        body: JSON.stringify({
          employeeId,
          moOperationId: operationId,
          date,
          hours: Number(hours),
          note: note || undefined,
          ...(timeKindSplit && kind ? { kind } : {}),
        }),
      });
      // Återkoppling: Ångra takes this time report away again (a locked
      // payroll period refuses, and the notice says so).
      const operation = operations.find((op) => op.id === operationId);
      const employee = employees.find((emp) => emp.id === employeeId);
      notify({
        message: `Rapporterat ${formatQuantity(Number(hours))} h${employee ? ` för ${employee.name}` : ""}${operation ? ` på ${moOperationLabel(operation)}` : ""}.`,
        action:
          canUndo && created?.id
            ? {
                label: "Ångra",
                run: async () => {
                  await apiFetch(`/api/v1/time-reports/${created.id}`, { method: "DELETE" });
                  onDone();
                  return "Tidrapporten är borttagen.";
                },
              }
            : undefined,
      });
      setNote("");
      setTypedHours(null);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte rapportera tiden"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.section} onSubmit={handleSubmit}>
      <div className={styles.formRow}>
        <div className={styles.rowLabel}>Rapportera tid</div>
        <Cell label="Anställd" className={styles.grow}>
          <Select id="reportEmployeeId" aria-label="Anställd" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.employeeNumber} — {emp.name}
              </option>
            ))}
          </Select>
        </Cell>
        <Cell label="Operation" className={styles.grow}>
          <Select
            id="reportOperationId"
            aria-label="Operation"
            value={operationId}
            onChange={(e) => {
              setOperationId(e.target.value);
              setTypedHours(null);
            }}
          >
            {operations.map((op) => (
              <option key={op.id} value={op.id}>
                {moOperationLabel(op)}
              </option>
            ))}
          </Select>
        </Cell>
        {timeKindSplit && (
          <Cell label="Typ" className={styles.date}>
            <Select id="reportKind" aria-label="Typ" value={kind} onChange={(e) => setKind(e.target.value as TimeKind | "")}>
              <option value="">Ej uppdelad</option>
              <option value="setup">Ställ</option>
              <option value="run">Produktion</option>
            </Select>
          </Cell>
        )}
        <Cell label="Datum" className={styles.date}>
          <Input id="reportDate" aria-label="Datum" type="date" required size="sm" value={date} onChange={(e) => setDate(e.target.value)} />
        </Cell>
        <Cell label="Timmar" className={styles.hours}>
          <Input id="reportHours" aria-label="Timmar" type="number" min="0" step="any" required size="sm" value={hours} onChange={(e) => setTypedHours(e.target.value)} />
        </Cell>
        <Cell label="Anteckning (valfritt)" className={styles.grow}>
          <Input id="reportNote" aria-label="Anteckning (valfritt)" placeholder="Anteckning" value={note} onChange={(e) => setNote(e.target.value)} />
        </Cell>
        <div className={styles.rowAction}>
          <Button type="submit" variant="primary" size="small" disabled={pending}>
            {pending ? "Rapporterar…" : "Rapportera tid"}
          </Button>
        </div>
      </div>
      <FormError>{error}</FormError>
    </form>
  );
}

// --- Complete order (released / in_progress, receipt into stock) ---

function CompleteOrderRow({
  orderId,
  orderQuantity,
  quantityReceived,
  locations,
  canUndo,
  onDone,
}: {
  orderId: string;
  orderQuantity: string;
  quantityReceived: string;
  locations: StockLocation[];
  canUndo: boolean;
  onDone: () => void;
}) {
  const received = Number(quantityReceived);
  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  // Antal = what goes into stock NOW, on top of any delinleverans — so it
  // defaults to what remains; 0 closes a short order without receiving more.
  const [quantity, setQuantity] = useState(String(Math.max(Number(orderQuantity) - received, 0)));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Slutför order closes the order — ask first when it would close short of
    // the order quantity (0 closes it without receiving anything more).
    const total = received + Number(quantity);
    if (total < Number(orderQuantity)) {
      const fmt = (n: number) => n.toLocaleString("sv-SE");
      const ok = await confirmDialog(
        `Ordern stängs med ${fmt(total)} av ${fmt(Number(orderQuantity))} st inlevererade — resten tillverkas inte på den här ordern. Stäng ordern ändå?`,
        { confirmLabel: "Stäng ordern" }
      );
      if (!ok) return;
    }
    setError(null);
    setPending(true);
    try {
      const closed = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch(`/api/v1/manufacturing-orders/${orderId}/complete`, {
          method: "POST",
          body: JSON.stringify({ locationId: locationId || undefined, quantity: Number(quantity), allowMaterialShortage }),
        })
      );
      if (closed === null) return;
      // Återkoppling: the order is done; Ångra opens it again and takes back
      // what this Slutför order received and drew.
      const reportId = (closed as { reportId?: string }).reportId ?? null;
      notify({
        message: `Ordern är slutförd${Number(quantity) > 0 ? ` — ${formatQuantity(Number(quantity))} st inlevererade` : ""}.`,
        action: canUndo && reportId ? undoReportAction(orderId, reportId, onDone, "Slutför order är ångrad — ordern är öppen igen.") : undefined,
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte slutföra ordern"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.section} onSubmit={handleSubmit}>
      <div className={styles.formRow}>
        <div className={styles.rowLabel}>Slutför order</div>
        <Cell label="Antal" className={styles.hours}>
          <Input
            id="completeQuantity"
            aria-label="Antal"
            type="number"
            min="0"
            step="any"
            required
            size="sm"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Cell>
        {/* Stock locations are optional — the select only appears when some exist. */}
        {locations.length > 0 && (
          <Cell label="Lagerplats" className={styles.grow}>
            <Select id="completeLocationId" aria-label="Lagerplats" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <LocationOptions locations={locations} />
            </Select>
          </Cell>
        )}
        <div className={styles.rowAction}>
          <Button
            type="submit"
            variant="primary"
            size="small"
            disabled={pending}
            title="Stänger ordern. Antal är det som läggs i lager nu."
          >
            {pending ? "Slutför…" : "Slutför order"}
          </Button>
        </div>
      </div>
      {/* The general explanation is the button's tooltip; this one stays
          visible because it tells the user to enter 0. */}
      {received > 0 && (
        <span className={styles.hint}>
          {received} st är redan inlevererade från sista operationen — 0 stänger ordern utan mer inleverans.
        </span>
      )}
      <FormError>{error}</FormError>
    </form>
  );
}
