"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import {
  ATF_MODE_LABELS,
  ATF_TRANSACTION_TYPE_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  OVERTIME_COMPENSATION_LABELS,
  type Absence,
  type AbsenceType,
  type AtfMode,
  type AtfStatus,
  type AtfTransactionType,
  type DaySchedule,
  type Employee,
  type EmployeeScheduleOverrides,
  type EmploymentType,
  type OvertimeCompensation,
  type ResolvedCalendarDay,
  type SystemSettings,
  type TerminalStation,
  type UserRole,
  type WeekSchedule,
} from "../../lib/types";
import { formatHours } from "./SchedulesPageClient";
import { FranvaroTab } from "./FranvaroTab";
import styles from "./EmployeeTabs.module.css";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormHint, FormRow, FormSaved } from "../ui/Form";

const TABS = ["Allmänt", "Anställning", "Schema", "Frånvaro", "ATF"] as const;
type Tab = (typeof TABS)[number];

interface EmployeeTabsProps {
  employee: Employee;
  weekSchedules: WeekSchedule[];
  daySchedules: DaySchedule[];
  overrides: EmployeeScheduleOverrides;
  calendar: ResolvedCalendarDay[];
  absenceTypes: AbsenceType[];
  initialAbsences: Absence[];
  atf: AtfStatus;
  systemSettings: SystemSettings;
  userRole: UserRole;
  stations: TerminalStation[];
}

// Empty input = null in the register (fields are all optional).
const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

export function EmployeeTabs({
  employee,
  weekSchedules,
  daySchedules,
  overrides,
  calendar,
  absenceTypes,
  initialAbsences,
  atf,
  systemSettings,
  userRole,
  stations,
}: EmployeeTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("Allmänt");

  return (
    <div>
      <div className={styles.tabStrip}>
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={styles.tab}
            data-active={tab === activeTab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Allmänt" && <AllmantTab employee={employee} stations={stations} />}
      {activeTab === "Anställning" && <AnstallningTab employee={employee} />}
      {activeTab === "Schema" && (
        <SchemaTab
          employee={employee}
          weekSchedules={weekSchedules}
          daySchedules={daySchedules}
          overrides={overrides}
          calendar={calendar}
        />
      )}
      {activeTab === "Frånvaro" && (
        <FranvaroTab
          employeeId={employee.id}
          employeeName={employee.name}
          absenceTypes={absenceTypes}
          initialAbsences={initialAbsences}
          userRole={userRole}
        />
      )}
      {activeTab === "ATF" && <AtfTab employee={employee} atf={atf} systemSettings={systemSettings} />}
    </div>
  );
}

function useSaveState() {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  return { error, setError, saved, setSaved, pending, setPending };
}

function AllmantTab({ employee, stations }: { employee: Employee; stations: TerminalStation[] }) {
  const router = useRouter();
  const [employeeNumber, setEmployeeNumber] = useState(employee.employeeNumber);
  const [name, setName] = useState(employee.name);
  const [active, setActive] = useState(employee.active);
  const [phone, setPhone] = useState(employee.phone ?? "");
  const [email, setEmail] = useState(employee.email ?? "");
  const [address, setAddress] = useState(employee.address ?? "");
  const [postalCode, setPostalCode] = useState(employee.postalCode ?? "");
  const [city, setCity] = useState(employee.city ?? "");
  // Only stations in the list are shown, so only those are kept and sent back:
  // saved defaults that point at an inactive or lego work center stay hidden.
  const [defaultWorkCenterIds, setDefaultWorkCenterIds] = useState<string[]>(() =>
    employee.defaultWorkCenterIds.filter((id) => stations.some((s) => s.id === id))
  );
  const { error, setError, saved, setSaved, pending, setPending } = useSaveState();

  function toggleStation(id: string, checked: boolean) {
    setDefaultWorkCenterIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/v1/employees/${employee.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          employeeNumber,
          name,
          active,
          defaultWorkCenterIds,
          phone: orNull(phone),
          email: orNull(email),
          address: orNull(address),
          postalCode: orNull(postalCode),
          city: orNull(city),
        }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <Form onSubmit={save}>
        <FormError>{error}</FormError>

        <FormRow>
          <Field label="Anställningsnummer" htmlFor="employeeNumber">
            <Input
              id="employeeNumber"
              required
              value={employeeNumber}
              onChange={(e) => setEmployeeNumber(e.target.value)}
            />
          </Field>
          <Field label="Aktiv" htmlFor="active">
            <Toggle id="active" checked={active} onChange={(e) => setActive(e.target.checked)} />
          </Field>
        </FormRow>

        <Field label="Namn" htmlFor="name">
          <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <FormRow>
          <Field label="Telefon" htmlFor="phone">
            <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="E-post" htmlFor="email">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </FormRow>

        <Field label="Adress" htmlFor="address">
          <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>

        <FormRow>
          <Field label="Postnummer" htmlFor="postalCode">
            <Input id="postalCode" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          </Field>
          <Field label="Ort" htmlFor="city">
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
        </FormRow>

        <Field label="Förvalda stationer">
          <div className={styles.stationGrid}>
            {stations.map((station) => (
              <label key={station.id} className={styles.stationOption}>
                <Checkbox
                  checked={defaultWorkCenterIds.includes(station.id)}
                  onChange={(e) => toggleStation(station.id, e.target.checked)}
                />
                <span>
                  {station.code} · {station.name}
                </span>
              </label>
            ))}
          </div>
          <FormHint>Väljs i stämpelterminalen när den anställde identifierar sig. Alla kan byta station i listan.</FormHint>
        </Field>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>
    </Card>
  );
}

function AnstallningTab({ employee }: { employee: Employee }) {
  const router = useRouter();
  const [personalIdentityNumber, setPersonalIdentityNumber] = useState(employee.personalIdentityNumber ?? "");
  const [employedFrom, setEmployedFrom] = useState(employee.employedFrom ?? "");
  const [employedTo, setEmployedTo] = useState(employee.employedTo ?? "");
  const [employmentType, setEmploymentType] = useState<EmploymentType | "">(employee.employmentType ?? "");
  const [wage, setWage] = useState(employee.wage ?? "");
  const [weeklyHours, setWeeklyHours] = useState(employee.weeklyHours ?? "");
  const [overtimeCompensation, setOvertimeCompensation] = useState<OvertimeCompensation>(
    employee.overtimeCompensation
  );
  const { error, setError, saved, setSaved, pending, setPending } = useSaveState();

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/v1/employees/${employee.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          personalIdentityNumber: orNull(personalIdentityNumber),
          employedFrom: orNull(employedFrom),
          employedTo: orNull(employedTo),
          employmentType: employmentType === "" ? null : employmentType,
          wage: wage.trim() === "" ? null : Number(wage),
          weeklyHours: weeklyHours.trim() === "" ? null : Number(weeklyHours),
          overtimeCompensation,
        }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <Form onSubmit={save}>
        <FormError>{error}</FormError>

        <Field label="Personnummer" htmlFor="pin">
          <Input
            id="pin"
            placeholder="ÅÅÅÅMMDD-XXXX"
            value={personalIdentityNumber}
            onChange={(e) => setPersonalIdentityNumber(e.target.value)}
          />
        </Field>

        <FormRow>
          <Field label="Anställd från" htmlFor="employedFrom">
            <Input id="employedFrom" type="date" value={employedFrom} onChange={(e) => setEmployedFrom(e.target.value)} />
          </Field>
          <Field label="Anställd till" htmlFor="employedTo">
            <Input id="employedTo" type="date" value={employedTo} onChange={(e) => setEmployedTo(e.target.value)} />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Anställningsform" htmlFor="employmentType">
            <Select
              id="employmentType"
              value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value as EmploymentType | "")}
            >
              <option value="">Ej angiven</option>
              {(Object.keys(EMPLOYMENT_TYPE_LABELS) as EmploymentType[]).map((type) => (
                <option key={type} value={type}>
                  {EMPLOYMENT_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={employmentType === "monthly" ? "Månadslön (kr)" : "Timlön (kr)"} htmlFor="wage">
            <Input id="wage" type="number" step="0.01" min="0" value={wage} onChange={(e) => setWage(e.target.value)} />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Veckoarbetstid (timmar)" htmlFor="weeklyHours">
            <Input
              id="weeklyHours"
              type="number"
              step="0.5"
              min="0"
              max="168"
              value={weeklyHours}
              onChange={(e) => setWeeklyHours(e.target.value)}
            />
          </Field>
          <Field label="Övertidsersättning" htmlFor="overtimeCompensation">
            <Select
              id="overtimeCompensation"
              value={overtimeCompensation}
              onChange={(e) => setOvertimeCompensation(e.target.value as OvertimeCompensation)}
            >
              {(Object.keys(OVERTIME_COMPENSATION_LABELS) as OvertimeCompensation[]).map((value) => (
                <option key={value} value={value}>
                  {OVERTIME_COMPENSATION_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>

        <FormHint>Uppgifterna används för kommande löneunderlag tillsammans med närvarostämplingarna.</FormHint>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>
    </Card>
  );
}

const WEEKDAY_SHORT = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];

// Where a resolved day's schedule came from, for the preview.
function sourceLabel(day: ResolvedCalendarDay): string {
  switch (day.source) {
    case "day-override":
      return "Dagsavvikelse";
    case "holiday":
      return `Helgdag: ${day.holidayName}`;
    case "week-override":
      return "Veckoavvikelse";
    case "standard":
      return "Standard";
    default:
      return "";
  }
}

function SchemaTab({
  employee,
  weekSchedules,
  daySchedules,
  overrides,
  calendar,
}: {
  employee: Employee;
  weekSchedules: WeekSchedule[];
  daySchedules: DaySchedule[];
  overrides: EmployeeScheduleOverrides;
  calendar: ResolvedCalendarDay[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Standardschema
  const [defaultWeekScheduleId, setDefaultWeekScheduleId] = useState(employee.defaultWeekScheduleId ?? "");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  // Ny veckoavvikelse
  const currentYear = new Date().getFullYear();
  const [overrideYear, setOverrideYear] = useState(String(currentYear));
  const [overrideWeek, setOverrideWeek] = useState("");
  const [overrideWeekScheduleId, setOverrideWeekScheduleId] = useState("");

  // Ny dagsavvikelse ("" = ledig)
  const [overrideDate, setOverrideDate] = useState("");
  const [overrideDayScheduleId, setOverrideDayScheduleId] = useState("");

  async function run(action: () => Promise<unknown>, fallbackMessage: string) {
    setError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : fallbackMessage);
      return false;
    }
  }

  async function saveDefaultSchedule(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setPending(true);
    const ok = await run(
      () =>
        apiFetch(`/api/v1/employees/${employee.id}`, {
          method: "PATCH",
          body: JSON.stringify({ defaultWeekScheduleId: defaultWeekScheduleId === "" ? null : defaultWeekScheduleId }),
        }),
      "Kunde inte spara standardschemat"
    );
    setSaved(ok);
    setPending(false);
  }

  async function addWeekOverride(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        apiFetch(`/api/v1/employees/${employee.id}/week-overrides`, {
          method: "POST",
          body: JSON.stringify({
            isoYear: Number(overrideYear),
            isoWeek: Number(overrideWeek),
            weekScheduleId: overrideWeekScheduleId,
          }),
        }),
      "Kunde inte spara veckoavvikelsen"
    );
    if (ok) {
      setOverrideWeek("");
      setOverrideWeekScheduleId("");
    }
  }

  async function addDayOverride(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        apiFetch(`/api/v1/employees/${employee.id}/day-overrides`, {
          method: "POST",
          body: JSON.stringify({
            date: overrideDate,
            dayScheduleId: overrideDayScheduleId === "" ? null : overrideDayScheduleId,
          }),
        }),
      "Kunde inte spara dagsavvikelsen"
    );
    if (ok) {
      setOverrideDate("");
      setOverrideDayScheduleId("");
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <FormError>{error}</FormError>

      <Card>
        <Form onSubmit={saveDefaultSchedule}>
          <Field label="Standardveckoschema" htmlFor="defaultWeekSchedule">
            <Select
              id="defaultWeekSchedule"
              value={defaultWeekScheduleId}
              onChange={(e) => setDefaultWeekScheduleId(e.target.value)}
            >
              <option value="">— Inget —</option>
              {weekSchedules.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.code} · {ws.name}
                  {!ws.active && " (inaktiv)"}
                </option>
              ))}
            </Select>
            <FormHint>
              Gäller alla veckor som inte har en avvikelse i kalendern nedan. Scheman underhålls i registret{" "}
              <a href="/tillverkning/scheman">Scheman</a>.
            </FormHint>
          </Field>
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {saved && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        </Form>
      </Card>

      <Card>
        <Form onSubmit={addWeekOverride}>
          <strong>Veckoavvikelser</strong>
          <FormHint>Veckor som följer ett annat veckoschema än standardschemat.</FormHint>
          {overrides.weekOverrides.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              {overrides.weekOverrides.map((o) => (
                <div key={o.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>
                    <span className="num">
                      v.{o.isoWeek} {o.isoYear}
                    </span>{" "}
                    — {o.weekScheduleCode} · {o.weekScheduleName}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      run(
                        () =>
                          apiFetch(`/api/v1/employees/${employee.id}/week-overrides/${o.id}`, { method: "DELETE" }),
                        "Kunde inte ta bort veckoavvikelsen"
                      )
                    }
                  >
                    Ta bort
                  </Button>
                </div>
              ))}
            </div>
          )}
          <FormRow>
            <Field label="År" htmlFor="overrideYear">
              <Input
                id="overrideYear"
                type="number"
                min={2000}
                max={2100}
                required
                value={overrideYear}
                onChange={(e) => setOverrideYear(e.target.value)}
              />
            </Field>
            <Field label="Vecka" htmlFor="overrideWeek">
              <Input
                id="overrideWeek"
                type="number"
                min={1}
                max={53}
                required
                value={overrideWeek}
                onChange={(e) => setOverrideWeek(e.target.value)}
              />
            </Field>
          </FormRow>
          <Field label="Veckoschema" htmlFor="overrideWeekSchedule">
            <Select
              id="overrideWeekSchedule"
              required
              value={overrideWeekScheduleId}
              onChange={(e) => setOverrideWeekScheduleId(e.target.value)}
            >
              <option value="">Välj schema…</option>
              {weekSchedules.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.code} · {ws.name}
                </option>
              ))}
            </Select>
          </Field>
          <FormActions>
            <Button type="submit" variant="secondary">
              + Lägg till veckoavvikelse
            </Button>
          </FormActions>
        </Form>
      </Card>

      <Card>
        <Form onSubmit={addDayOverride}>
          <strong>Dagsavvikelser</strong>
          <FormHint>
            Enskilda datum med annat dagsschema eller ledigt — gäller före både helgdagar och veckoscheman.
          </FormHint>
          {overrides.dayOverrides.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              {overrides.dayOverrides.map((o) => (
                <div key={o.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>
                    <span className="num">{o.date}</span> —{" "}
                    {o.dayScheduleId ? `${o.dayScheduleCode} · ${o.dayScheduleName}` : "Ledig"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      run(
                        () => apiFetch(`/api/v1/employees/${employee.id}/day-overrides/${o.id}`, { method: "DELETE" }),
                        "Kunde inte ta bort dagsavvikelsen"
                      )
                    }
                  >
                    Ta bort
                  </Button>
                </div>
              ))}
            </div>
          )}
          <FormRow>
            <Field label="Datum" htmlFor="overrideDate">
              <Input
                id="overrideDate"
                type="date"
                required
                value={overrideDate}
                onChange={(e) => setOverrideDate(e.target.value)}
              />
            </Field>
            <Field label="Dagsschema" htmlFor="overrideDaySchedule">
              <Select
                id="overrideDaySchedule"
                value={overrideDayScheduleId}
                onChange={(e) => setOverrideDayScheduleId(e.target.value)}
              >
                <option value="">— Ledig —</option>
                {daySchedules.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} · {d.name} ({d.startTime}–{d.endTime})
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <FormActions>
            <Button type="submit" variant="secondary">
              + Lägg till dagsavvikelse
            </Button>
          </FormActions>
        </Form>
      </Card>

      <Card>
        <strong>Kommande 4 veckor</strong>
        <FormHint>Så här löses schemat upp per dag, med kalenderns avvikelser och helgdagar inräknade.</FormHint>
        <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
          {calendar.map((day) => (
            <div
              key={day.date}
              style={{
                display: "grid",
                // minmax caps: keeps the desktop look (up to 150px/160px)
                // but lets the outer columns shrink instead of forcing a
                // fixed 326px+gap floor that overflowed on narrow viewports.
                gridTemplateColumns: "minmax(84px,150px) minmax(0,1fr) minmax(96px,160px)",
                gap: 8,
                alignItems: "baseline",
              }}
            >
              <span className="num">
                {WEEKDAY_SHORT[day.weekday - 1]} {day.date}
              </span>
              <span>
                {day.daySchedule
                  ? `${day.daySchedule.code} · ${day.daySchedule.name} (${day.daySchedule.startTime}–${day.daySchedule.endTime}, ${formatHours(day.daySchedule.netMinutes)})`
                  : "Ledig"}
              </span>
              <FormHint>
                {sourceLabel(day)}
              </FormHint>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}


// ATF (arbetstidsförkortning): rule settings, derived balance and the
// withdrawal/adjustment ledger. Accrual is computed from the rule — only
// uttag and justeringar are stored.
function AtfTab({
  employee,
  atf,
  systemSettings,
}: {
  employee: Employee;
  atf: AtfStatus;
  systemSettings: SystemSettings;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Inställningar
  const [atfMode, setAtfMode] = useState<AtfMode>(employee.atfMode);
  const [minutesPerWeek, setMinutesPerWeek] = useState(
    employee.atfMinutesPerWeek === null ? "" : String(employee.atfMinutesPerWeek)
  );
  const [startDate, setStartDate] = useState(employee.atfStartDate ?? "");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  // Ny transaktion
  const [txDate, setTxDate] = useState(new Date().toLocaleDateString("sv-SE"));
  const [txType, setTxType] = useState<AtfTransactionType>("withdrawal");
  const [txHours, setTxHours] = useState("");
  const [txNote, setTxNote] = useState("");

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/v1/employees/${employee.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          atfMode,
          atfMinutesPerWeek: minutesPerWeek.trim() === "" ? null : Number(minutesPerWeek),
          atfStartDate: startDate === "" ? null : startDate,
        }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara ATF-inställningarna");
    } finally {
      setPending(false);
    }
  }

  async function addTransaction(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const hours = Number(txHours.replace(",", "."));
    if (!Number.isFinite(hours) || hours === 0) {
      setError("Ange antal timmar (t.ex. 4 eller 0,5)");
      return;
    }
    try {
      await apiFetch(`/api/v1/employees/${employee.id}/atf-transactions`, {
        method: "POST",
        body: JSON.stringify({
          date: txDate,
          type: txType,
          minutes: Math.round(hours * 60),
          note: txNote.trim() === "" ? undefined : txNote.trim(),
        }),
      });
      setTxHours("");
      setTxNote("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte registrera transaktionen");
    }
  }

  async function deleteTransaction(id: string) {
    setError(null);
    try {
      await apiFetch(`/api/v1/employees/${employee.id}/atf-transactions/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort transaktionen");
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <FormError>{error}</FormError>

      <Card>
        <strong>Saldo</strong>
        <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
          <div style={{ fontSize: 24, fontWeight: 600 }} className="num">
            <span style={atf.balanceMinutes < 0 ? { color: "var(--status-stopped-text)" } : undefined}>
              {formatHours(atf.balanceMinutes)}
            </span>
          </div>
          {atf.mode === "weekly" ? (
            <FormHint>
              Veckouttag — intjäningen ({atf.effectiveMinutesPerWeek} min/vecka) tas ut löpande via kortare
              arbetsvecka och läggs inte till saldot.
            </FormHint>
          ) : (
            <FormHint>
              Intjänat {formatHours(atf.accruedMinutes)} ({atf.effectiveMinutesPerWeek} min/vecka
              {atf.source === "system" ? ", systemstandard" : ""}) · Uttaget {formatHours(atf.withdrawnMinutes)}
              {atf.adjustedMinutes !== 0 && <> · Justerat {formatHours(atf.adjustedMinutes)}</>}
              {atf.startDate === null && <> · Inget startdatum satt — ingen intjäning räknas.</>}
            </FormHint>
          )}
        </div>
      </Card>

      <Card>
        <Form onSubmit={saveSettings}>
          <strong>Inställningar</strong>
          <FormRow>
            <Field label="Uttagsläge" htmlFor="atfMode">
              <Select id="atfMode" value={atfMode} onChange={(e) => setAtfMode(e.target.value as AtfMode)}>
                {(Object.keys(ATF_MODE_LABELS) as AtfMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {ATF_MODE_LABELS[mode]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Minuter per vecka" htmlFor="atfMinutes">
              <Input
                id="atfMinutes"
                type="number"
                min={0}
                max={600}
                placeholder={`Systemstandard: ${systemSettings.atfMinutesPerWeek}`}
                value={minutesPerWeek}
                onChange={(e) => setMinutesPerWeek(e.target.value)}
              />
            </Field>
          </FormRow>
          <Field label="Intjäning från" htmlFor="atfStart">
            <Input id="atfStart" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <FormHint>
            Tidbank samlar intjäningen till saldot; Veckouttag kvittar den löpande (kortare arbetsvecka läggs i
            schemat). Tomt minutfält = följ systemstandarden. Intjäningen räknas per hel vecka (mån–sön) från
            startdatumet — ändras minutsatsen i efterhand räknas historiken om, korrigera i så fall med en justering.
          </FormHint>
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {saved && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        </Form>
      </Card>

      <Card>
        <Form onSubmit={addTransaction}>
          <strong>Transaktioner</strong>
          {atf.transactions.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              {atf.transactions.map((tx) => (
                <div key={tx.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>
                    <span className="num">{tx.date}</span> — {ATF_TRANSACTION_TYPE_LABELS[tx.type]}{" "}
                    <span className="num">
                      {tx.type === "withdrawal" ? `−${formatHours(tx.minutes)}` : formatHours(tx.minutes)}
                    </span>
                    {tx.note && <span className={styles.inlineNote}> — {tx.note}</span>}
                  </span>
                  <Button type="button" variant="ghost" onClick={() => deleteTransaction(tx.id)}>
                    Ta bort
                  </Button>
                </div>
              ))}
            </div>
          )}
          <FormRow>
            <Field label="Datum" htmlFor="txDate">
              <Input id="txDate" type="date" required value={txDate} onChange={(e) => setTxDate(e.target.value)} />
            </Field>
            <Field label="Typ" htmlFor="txType">
              <Select id="txType" value={txType} onChange={(e) => setTxType(e.target.value as AtfTransactionType)}>
                {(Object.keys(ATF_TRANSACTION_TYPE_LABELS) as AtfTransactionType[]).map((type) => (
                  <option key={type} value={type}>
                    {ATF_TRANSACTION_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Timmar" htmlFor="txHours">
              <Input
                id="txHours"
                type="number"
                step="0.25"
                required
                placeholder={txType === "withdrawal" ? "t.ex. 4" : "t.ex. 12 eller -1,5"}
                value={txHours}
                onChange={(e) => setTxHours(e.target.value)}
              />
            </Field>
            <Field label="Notering" htmlFor="txNote">
              <Input id="txNote" value={txNote} onChange={(e) => setTxNote(e.target.value)} />
            </Field>
          </FormRow>
          <FormHint>
            Uttag minskar saldot. Justering kan vara negativ — använd den för ingående saldo eller korrigeringar.
          </FormHint>
          <FormActions>
            <Button type="submit" variant="secondary">
              + Registrera
            </Button>
          </FormActions>
        </Form>
      </Card>
    </div>
  );
}
