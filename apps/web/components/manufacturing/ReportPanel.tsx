"use client";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { ScrapReasonFields } from "../quality/ScrapReasonFields";
import { useScrapReasons } from "../../lib/useScrapReasons";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { confirmDialog } from "../../lib/confirm";
import { suggestedConsumeQuantity, suggestedReportHours } from "../../lib/moSuggestions";
import { groupReportRows, moOperationLabel } from "../../lib/moReportRows";
import { stockholmToday } from "../../lib/date";
import type {
  EmployeeDirectoryEntry,
  MOMaterialConsumption,
  MOOperation,
  StockLocation,
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
  onDone: () => void;
}

function LocationOptions({ locations }: { locations: StockLocation[] }) {
  return (
    <>
      <option value="">Artikelns lagerplats</option>
      {locations.map((l) => (
        <option key={l.id} value={l.id}>
          {l.warehouseName} — {l.name}
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
  onDone,
}: ReportPanelProps) {
  const orderDone = orderStatus === "done";
  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
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
            <Field label="Lagerplats för materialuttag" htmlFor="reportMaterialLocation">
              <Select id="reportMaterialLocation" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <LocationOptions locations={locations} />
              </Select>
            </Field>
          )}
        </div>

        {groups.map(({ operation, materials: linked }) => (
          <div key={operation.id} className={styles.section}>
            <OperationRow
              orderId={orderId}
              orderQuantity={orderQuantity}
              operation={operation}
              locationId={locationId}
              scrapReasonOptions={scrapReasonOptions}
              onDone={onDone}
            />
            {linked.map((m) => (
              <MaterialRow key={m.id} orderId={orderId} material={m} locationId={locationId} onDone={onDone} />
            ))}
          </div>
        ))}

        {unlinked.length > 0 && (
          <div className={styles.section}>
            <div className={styles.groupTitle}>Vid slutrapportering</div>
            {unlinked.map((m) => (
              <MaterialRow key={m.id} orderId={orderId} material={m} locationId={locationId} onDone={onDone} />
            ))}
          </div>
        )}

        <ReportTimeRow employees={employees} operations={operations} orderQuantity={orderQuantity} timeReports={timeReports} onDone={onDone} />

        {(orderStatus === "released" || orderStatus === "in_progress") && (
          // No Starta: Slutför order works straight on a released order.
          <CompleteOrderRow
            orderId={orderId}
            orderQuantity={orderQuantity}
            quantityReceived={quantityReceived}
            locations={locations}
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
  onDone,
}: {
  orderId: string;
  orderQuantity: string;
  operation: MOOperation;
  locationId: string;
  scrapReasonOptions: ReturnType<typeof useScrapReasons>;
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
          {/* Kvar = planned − OK; scrapped units must be made again. */}
          <span className={`num ${styles.summary}`}>
            {isPending ? `Planerat ${Number(orderQuantity)} · Klart ${Number(op.quantityCompleted ?? 0)}` : `Klart ${Number(op.quantityCompleted ?? 0)} av ${Number(orderQuantity)}`}
            {Number(op.quantityScrapped) > 0 ? ` · Kasserat ${Number(op.quantityScrapped)}` : ""}
            {isPending ? (
              <>
                {" "}
                · <strong>Kvar {remaining}</strong>
              </>
            ) : (
              " · Klar"
            )}
          </span>
          {isPending && op.workCenterType === "subcontract" && (
            <span className={styles.hint}>Lego — avrapporteras vid inleverans</span>
          )}
        </div>
        {isPending && (
          <>
            <div className={styles.cell}>
              <Field label="Antal klart" htmlFor={`quantityCompleted-${op.id}`}>
                <Input
                  id={`quantityCompleted-${op.id}`}
                  type="number"
                  min="0"
                  step="any"
                  size="sm"
                  value={quantity ?? remaining}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </Field>
            </div>
            <div className={styles.cell}>
              <Field label="Kasserat" htmlFor={`quantityScrapped-${op.id}`}>
                <Input
                  id={`quantityScrapped-${op.id}`}
                  type="number"
                  min="0"
                  step="any"
                  size="sm"
                  value={scrapped}
                  onChange={(e) => setScrapped(e.target.value)}
                />
              </Field>
            </div>
            <div className={styles.cell}>
              <Field label="Faktisk tid" htmlFor={`actualTime-${op.id}`}>
                <Input
                  id={`actualTime-${op.id}`}
                  type="number"
                  min="0"
                  step="0.01"
                  size="sm"
                  value={actualTime}
                  onChange={(e) => setActualTime(e.target.value)}
                />
              </Field>
            </div>
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

// --- One material row: numbers, and Förbruka while something remains ---

function MaterialRow({
  orderId,
  material: m,
  locationId,
  onDone,
}: {
  orderId: string;
  material: MOMaterialConsumption;
  locationId: string;
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
          <span className={`num ${styles.summary}`}>
            {toUnitQuantity(Number(m.quantityConsumed), m.unitFactor)}/{toUnitQuantity(Number(m.quantityPlanned), m.unitFactor)} {m.unitCode}
          </span>
        </div>
        {open && (
          <>
            <div className={styles.cell}>
              <Field label={`Antal (${m.unitCode})`} htmlFor={`consumeQuantity-${m.id}`}>
                <Input
                  id={`consumeQuantity-${m.id}`}
                  type="number"
                  min="0"
                  step="any"
                  required
                  size="sm"
                  value={quantity}
                  onChange={(e) => setTypedQuantity(e.target.value)}
                />
              </Field>
            </div>
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
  onDone,
}: {
  employees: EmployeeDirectoryEntry[];
  operations: MOOperation[];
  orderQuantity: string;
  timeReports: TimeReport[];
  onDone: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const [operationId, setOperationId] = useState(operations[0]?.id ?? "");
  const [date, setDate] = useState(stockholmToday());
  // Timmar is prefilled with the operation's theoretical time less what is
  // already reported on it; a typed value wins until another operation is
  // picked or the report is saved.
  const [typedHours, setTypedHours] = useState<string | null>(null);
  const hours =
    typedHours ?? suggestedReportHours(operations.find((op) => op.id === operationId), orderQuantity, timeReports);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (employees.length === 0 || operations.length === 0) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/time-reports", {
        method: "POST",
        body: JSON.stringify({ employeeId, moOperationId: operationId, date, hours: Number(hours), note: note || undefined }),
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
      {/* Five fields never fit beside a title — the title gets its own line. */}
      <div className={styles.groupTitle}>Rapportera tid</div>
      <div className={styles.line}>
        <div className={styles.wide}>
          <Field label="Anställd" htmlFor="reportEmployeeId">
            <Select id="reportEmployeeId" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.employeeNumber} — {emp.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className={styles.wide}>
          <Field label="Operation" htmlFor="reportOperationId">
            <Select
              id="reportOperationId"
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
          </Field>
        </div>
        <div className={styles.cell}>
          <Field label="Datum" htmlFor="reportDate">
            <Input id="reportDate" type="date" required size="sm" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <div className={styles.cell}>
          <Field label="Timmar" htmlFor="reportHours">
            <Input id="reportHours" type="number" min="0" step="any" required size="sm" value={hours} onChange={(e) => setTypedHours(e.target.value)} />
          </Field>
        </div>
        <div className={styles.wide}>
          <Field label="Anteckning (valfritt)" htmlFor="reportNote">
            <Input id="reportNote" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className={styles.action}>
          <Button type="submit" variant="primary" disabled={pending}>
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
  onDone,
}: {
  orderId: string;
  orderQuantity: string;
  quantityReceived: string;
  locations: StockLocation[];
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
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte slutföra ordern"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.section} onSubmit={handleSubmit}>
      <div className={styles.line}>
        <div className={styles.title}>
          <span className={styles.name}>Slutför order</span>
          <span className={styles.hint}>
            Stänger ordern. Antal är det som läggs i lager nu.
            {received > 0 ? ` ${received} st är redan inlevererade från sista operationen — 0 stänger ordern utan mer inleverans.` : ""}
          </span>
        </div>
        <div className={styles.cell}>
          <Field label="Antal" htmlFor="completeQuantity">
            <Input
              id="completeQuantity"
              type="number"
              min="0"
              step="any"
              required
              size="sm"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        </div>
        {/* Stock locations are optional — the select only appears when some exist. */}
        {locations.length > 0 && (
          <div className={styles.wide}>
            <Field label="Lagerplats" htmlFor="completeLocationId">
              <Select id="completeLocationId" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <LocationOptions locations={locations} />
              </Select>
            </Field>
          </div>
        )}
        <div className={styles.action}>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Slutför…" : "Slutför order"}
          </Button>
        </div>
      </div>
      <FormError>{error}</FormError>
    </form>
  );
}
