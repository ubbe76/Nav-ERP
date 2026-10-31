"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import {
  SCHEDULE_BREAK_TYPE_LABELS,
  type DaySchedule,
  type Holiday,
  type ScheduleBreak,
  type ScheduleBreakType,
  type SystemSettings,
  type WeekSchedule,
} from "../../lib/types";
import { apiErrorMessage } from "../../lib/errorMessages";
import shellStyles from "../../components/AppShell.module.css";
import formStyles from "./EmployeeTabs.module.css";
import styles from "../../app/tillverkning/tidrapporter/page.module.css";
import { HelpLink } from "../ui/HelpLink";
import { useCanOpenPersonal } from "../PermissionsProvider";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";

const TABS = ["Dagsscheman", "Veckoscheman", "Helgdagar"] as const;
type Tab = (typeof TABS)[number];

export const WEEKDAY_LABELS = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
const WEEKDAY_SHORT = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];

// Same rule as the API: net working time = start→end minus unpaid breaks
// (raster); paid breaks (pauser) count as working time.
const toMinutes = (t: string) => {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return h * 60 + m;
};

export function netMinutes(schedule: { startTime: string; endTime: string; breaks: ScheduleBreak[] }) {
  const unpaid = schedule.breaks
    .filter((b) => b.type === "unpaid")
    .reduce((sum, b) => sum + toMinutes(b.endTime) - toMinutes(b.startTime), 0);
  return toMinutes(schedule.endTime) - toMinutes(schedule.startTime) - unpaid;
}

export function formatHours(minutes: number) {
  return `${(minutes / 60).toLocaleString("sv-SE", { maximumFractionDigits: 2 })} h`;
}

// Normalize a loosely typed clock time to "HH:MM": "7" → "07:00",
// "730"/"7:30" → "07:30", "1630" → "16:30". Returns null when unparseable.
function normalizeClockTime(raw: string): string | null {
  const cleaned = raw.trim().replace(/[.,]/g, ":");
  let hours: number;
  let minutes: number;
  if (cleaned.includes(":")) {
    const [h = "", m = ""] = cleaned.split(":");
    if (!/^\d{1,2}$/.test(h) || !/^\d{0,2}$/.test(m)) return null;
    hours = Number(h);
    minutes = m === "" ? 0 : Number(m.padEnd(2, "0"));
  } else if (/^\d{1,4}$/.test(cleaned)) {
    if (cleaned.length <= 2) {
      hours = Number(cleaned);
      minutes = 0;
    } else {
      hours = Number(cleaned.slice(0, -2));
      minutes = Number(cleaned.slice(-2));
    }
  } else {
    return null;
  }
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// 24-hour time field. The native <input type="time"> renders AM/PM when the
// browser's OS locale says so — a text input keeps the register 24-hour
// everywhere. Free-form typing is normalized on blur; the pattern catches
// leftovers on submit.
function ClockInput({
  value,
  onValueChange,
  ...props
}: { value: string; onValueChange: (value: string) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "pattern" | "size"
>) {
  return (
    <Input
      {...props}
      type="text"
      inputMode="numeric"
      placeholder="HH:MM"
      maxLength={5}
      pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
      title="Klockslag i 24-timmarsformat, t.ex. 06:30 eller 16:00"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      onBlur={(e) => {
        const normalized = normalizeClockTime(e.target.value);
        if (normalized && normalized !== value) onValueChange(normalized);
      }}
    />
  );
}

export function SchedulesPageClient({
  daySchedules,
  weekSchedules,
  holidays,
  scheduleBalancing,
}: {
  daySchedules: DaySchedule[];
  weekSchedules: WeekSchedule[];
  holidays: Holiday[];
  scheduleBalancing: SystemSettings["scheduleBalancing"];
}) {
  const canOpenPersonal = useCanOpenPersonal();
  const [activeTab, setActiveTab] = useState<Tab>("Dagsscheman");

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Scheman</div>
          <div className={shellStyles.meta}>
            {daySchedules.length} dagsscheman · {weekSchedules.length} veckoscheman
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          {canOpenPersonal && (
            <Link href="/personal/anstallda" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Anställda
            </Link>
          )}
          <HelpLink chapter="personal-tid" anchor="scheman" label="Hjälp om scheman" />
        </div>
      </div>

      <div className={formStyles.tabStrip}>
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={formStyles.tab}
            data-active={tab === activeTab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Dagsscheman" && <DaySchedulesTab daySchedules={daySchedules} />}
      {activeTab === "Veckoscheman" && (
        <WeekSchedulesTab
          weekSchedules={weekSchedules}
          daySchedules={daySchedules}
          scheduleBalancing={scheduleBalancing}
        />
      )}
      {activeTab === "Helgdagar" && <HolidaysTab holidays={holidays} daySchedules={daySchedules} />}
    </>
  );
}

// --- Dagsscheman ---

function DaySchedulesTab({ daySchedules }: { daySchedules: DaySchedule[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<DaySchedule | null>(null);

  return (
    <>
      <FormActions style={{ margin: "12px 0" }}>
        <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
          + Nytt dagsschema
        </Button>
      </FormActions>

      <Table<DaySchedule>
        columns={[
          { key: "code", label: "Kod", width: "110px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "time", label: "Tid", width: "140px" },
          { key: "breaks", label: "Avbrott", width: "110px", align: "right" },
          { key: "net", label: "Nettotid", width: "110px", align: "right" },
          { key: "active", label: "Status", width: "120px" },
        ]}
        rows={daySchedules}
        emptyText="Inga dagsscheman registrerade än"
        renderCell={(schedule, key) => {
          switch (key) {
            case "code":
              return (
                <button type="button" className={styles.rowLink} onClick={() => setEditing(schedule)}>
                  {schedule.code}
                </button>
              );
            case "name":
              return (
                <button type="button" className={styles.rowLink} onClick={() => setEditing(schedule)}>
                  <strong>{schedule.name}</strong>
                </button>
              );
            case "time":
              return (
                <span className="num">
                  {schedule.startTime}–{schedule.endTime}
                </span>
              );
            case "breaks":
              return schedule.breaks.length;
            case "net":
              return <span className="num">{formatHours(netMinutes(schedule))}</span>;
            case "active":
              return schedule.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nytt dagsschema">
        <DayScheduleForm
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `${editing.code} · ${editing.name}` : ""}
      >
        {editing && (
          <DayScheduleForm
            schedule={editing}
            onDone={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function DayScheduleForm({ schedule, onDone }: { schedule?: DaySchedule; onDone: () => void }) {
  const [code, setCode] = useState(schedule?.code ?? "");
  const [name, setName] = useState(schedule?.name ?? "");
  const [startTime, setStartTime] = useState(schedule?.startTime ?? "07:00");
  const [endTime, setEndTime] = useState(schedule?.endTime ?? "16:00");
  const [active, setActive] = useState(schedule?.active ?? true);
  const [breaks, setBreaks] = useState<ScheduleBreak[]>(schedule?.breaks ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateBreak(index: number, patch: Partial<ScheduleBreak>) {
    setBreaks((current) => current.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const payload = { code, name, startTime, endTime, active, breaks };
      if (schedule) {
        await apiFetch(`/api/v1/day-schedules/${schedule.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/api/v1/day-schedules", { method: "POST", body: JSON.stringify(payload) });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara dagsschemat");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Kod" htmlFor="dayCode">
          <Input id="dayCode" required maxLength={20} size="md" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Aktiv" htmlFor="dayActive">
          <Toggle id="dayActive" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </Field>
      </FormRow>

      <Field label="Namn" htmlFor="dayName">
        <Input id="dayName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <FormRow>
        <Field label="Starttid" htmlFor="dayStart">
          <ClockInput id="dayStart" required value={startTime} onValueChange={setStartTime} />
        </Field>
        <Field label="Sluttid" htmlFor="dayEnd">
          <ClockInput id="dayEnd" required value={endTime} onValueChange={setEndTime} />
        </Field>
      </FormRow>

      <Field label="Avbrott" htmlFor="dayBreaks">
        <FormHint>
          Rast är obetald (t.ex. lunch) och räknas bort från arbetstiden, paus är betald (t.ex. fika) och ingår.
        </FormHint>
        <div id="dayBreaks" style={{ display: "grid", gap: 8 }}>
          {breaks.map((b, index) => (
            <div key={index} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) auto", gap: 8 }}>
              <Select
                aria-label="Typ av avbrott"
                value={b.type}
                onChange={(e) => updateBreak(index, { type: e.target.value as ScheduleBreakType })}
              >
                {(Object.keys(SCHEDULE_BREAK_TYPE_LABELS) as ScheduleBreakType[]).map((type) => (
                  <option key={type} value={type}>
                    {SCHEDULE_BREAK_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
              <ClockInput
                aria-label="Avbrott start"
                required
                value={b.startTime}
                onValueChange={(startTime) => updateBreak(index, { startTime })}
              />
              <ClockInput
                aria-label="Avbrott slut"
                required
                value={b.endTime}
                onValueChange={(endTime) => updateBreak(index, { endTime })}
              />
              <Button type="button" variant="ghost" onClick={() => setBreaks((c) => c.filter((_, i) => i !== index))}>
                Ta bort
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setBreaks((c) => [...c, { type: "unpaid", startTime: "12:00", endTime: "12:30" }])}
            >
              + Lägg till avbrott
            </Button>
          </div>
        </div>
      </Field>

      <FormHint>Nettotid: {formatHours(netMinutes({ startTime, endTime, breaks }))}</FormHint>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : schedule ? "Spara schema" : "Skapa schema"}
        </Button>
      </FormActions>
    </Form>
  );
}

// --- Veckoscheman ---

function WeekSchedulesTab({
  weekSchedules,
  daySchedules,
  scheduleBalancing,
}: {
  weekSchedules: WeekSchedule[];
  daySchedules: DaySchedule[];
  scheduleBalancing: boolean;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WeekSchedule | null>(null);

  const netByDaySchedule = useMemo(
    () => new Map(daySchedules.map((d) => [d.id, netMinutes(d)])),
    [daySchedules]
  );

  return (
    <>
      <FormActions style={{ margin: "12px 0" }}>
        <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
          + Nytt veckoschema
        </Button>
      </FormActions>

      <Table<WeekSchedule>
        columns={[
          { key: "code", label: "Kod", width: "110px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "days", label: "Dagar", width: "220px" },
          { key: "net", label: "Nettotid/vecka", width: "130px", align: "right" },
          ...(scheduleBalancing
            ? [
                { key: "ordinary", label: "Ordinarie/vecka", width: "130px", align: "right" as const },
                { key: "atf", label: "ATF/vecka", width: "110px", align: "right" as const },
              ]
            : []),
          { key: "active", label: "Status", width: "120px" },
        ]}
        rows={weekSchedules}
        emptyText="Inga veckoscheman registrerade än"
        renderCell={(schedule, key) => {
          switch (key) {
            case "code":
              return (
                <button type="button" className={styles.rowLink} onClick={() => setEditing(schedule)}>
                  {schedule.code}
                </button>
              );
            case "name":
              return (
                <button type="button" className={styles.rowLink} onClick={() => setEditing(schedule)}>
                  <strong>{schedule.name}</strong>
                </button>
              );
            case "days":
              return schedule.days.length === 0
                ? "—"
                : schedule.days.map((d) => WEEKDAY_SHORT[d.weekday - 1]).join(", ");
            case "net": {
              const total = schedule.days.reduce((sum, d) => sum + (netByDaySchedule.get(d.dayScheduleId) ?? 0), 0);
              return <span className="num">{formatHours(total)}</span>;
            }
            case "ordinary":
              return schedule.ordinaryMinutesPerWeek === null ? (
                "—"
              ) : (
                <span className="num">{formatHours(schedule.ordinaryMinutesPerWeek)}</span>
              );
            case "atf":
              return schedule.ordinaryMinutesPerWeek === null ? (
                "—"
              ) : (
                <span className="num">{schedule.atfMinutesPerWeek} min</span>
              );
            case "active":
              return schedule.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nytt veckoschema">
        <WeekScheduleForm
          scheduleBalancing={scheduleBalancing}
          daySchedules={daySchedules}
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `${editing.code} · ${editing.name}` : ""}
      >
        {editing && (
          <WeekScheduleForm
            schedule={editing}
            scheduleBalancing={scheduleBalancing}
            daySchedules={daySchedules}
            onDone={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function WeekScheduleForm({
  schedule,
  daySchedules,
  scheduleBalancing,
  onDone,
}: {
  schedule?: WeekSchedule;
  daySchedules: DaySchedule[];
  scheduleBalancing: boolean;
  onDone: () => void;
}) {
  const [code, setCode] = useState(schedule?.code ?? "");
  const [name, setName] = useState(schedule?.name ?? "");
  const [active, setActive] = useState(schedule?.active ?? true);
  // One select per ISO weekday (index 0 = måndag); "" = ledig.
  const [dayScheduleIds, setDayScheduleIds] = useState<string[]>(() => {
    const ids = Array<string>(7).fill("");
    for (const day of schedule?.days ?? []) ids[day.weekday - 1] = day.dayScheduleId;
    return ids;
  });
  // Ordinary hours per week as typed (timmar); empty = no balancing.
  const [ordinaryHours, setOrdinaryHours] = useState(
    // Two decimals is within half a minute, so saving rounds back to the stored minutes.
    schedule?.ordinaryMinutesPerWeek != null ? String(Math.round((schedule.ordinaryMinutesPerWeek / 60) * 100) / 100) : ""
  );
  const [atfMinutes, setAtfMinutes] = useState(String(schedule?.atfMinutesPerWeek ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const ordinaryMinutes = parseOrdinaryMinutes(ordinaryHours);
  const atfValue = atfMinutes.trim() === "" ? 0 : Math.round(Number(atfMinutes.replace(",", ".")));
  const days = dayScheduleIds
    .map((dayScheduleId, index) => ({ weekday: index + 1, dayScheduleId }))
    .filter((d) => d.dayScheduleId !== "");
  const preview = useBalancePreview(
    scheduleBalancing && ordinaryMinutes !== null && Number.isFinite(atfValue) ? ordinaryMinutes : null,
    atfValue,
    days
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const balancing = scheduleBalancing
        ? { ordinaryMinutesPerWeek: ordinaryMinutes, atfMinutesPerWeek: Number.isFinite(atfValue) ? atfValue : 0 }
        : {};
      const payload = { code, name, active, days, ...balancing };
      if (schedule) {
        await apiFetch(`/api/v1/week-schedules/${schedule.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/api/v1/week-schedules", { method: "POST", body: JSON.stringify(payload) });
      }
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara veckoschemat"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Kod" htmlFor="weekCode">
          <Input id="weekCode" required maxLength={20} size="md" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Aktiv" htmlFor="weekActive">
          <Toggle id="weekActive" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </Field>
      </FormRow>

      <Field label="Namn" htmlFor="weekName">
        <Input id="weekName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {WEEKDAY_LABELS.map((label, index) => (
        <Field key={label} label={label} htmlFor={`weekday-${index}`}>
          <Select
            id={`weekday-${index}`}
            value={dayScheduleIds[index]}
            onChange={(e) =>
              setDayScheduleIds((current) => current.map((id, i) => (i === index ? e.target.value : id)))
            }
          >
            <option value="">— Ledig —</option>
            {daySchedules.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} · {d.name} ({d.startTime}–{d.endTime}){!d.active && " (inaktiv)"}
              </option>
            ))}
          </Select>
        </Field>
      ))}

      {scheduleBalancing && (
        <>
          <FormRow>
            <Field label="Ordinarie arbetstid per vecka (timmar)" htmlFor="weekOrdinary">
              <Input
                id="weekOrdinary"
                type="number"
                min="0"
                step="any"
                size="md"
                value={ordinaryHours}
                onChange={(e) => setOrdinaryHours(e.target.value)}
              />
            </Field>
            <Field label="ATF per vecka (minuter)" htmlFor="weekAtf">
              <Input
                id="weekAtf"
                type="number"
                min="0"
                step="any"
                size="md"
                value={atfMinutes}
                onChange={(e) => setAtfMinutes(e.target.value)}
              />
            </Field>
          </FormRow>
          <FormHint>Tomt = ingen utjämning: veckan följer då bara sina dagsscheman.</FormHint>
          {preview && <BalancePreview state={preview} />}
        </>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : schedule ? "Spara schema" : "Skapa schema"}
        </Button>
      </FormActions>
    </Form>
  );
}

// Hours typed in the form -> whole minutes; null = empty or not a number.
function parseOrdinaryMinutes(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const hours = Number(trimmed);
  if (!Number.isFinite(hours)) return null;
  return Math.round(hours * 60);
}

interface PreviewRow {
  weekday: number;
  dayScheduleId: string;
  dayScheduleCode: string;
  holiday: boolean;
  last: boolean;
  startTime: string | null;
  endTime: string | null;
  netMinutes: number;
}
interface PreviewWeek {
  days: PreviewRow[];
  netMinutes: number;
  atfMinutes: number;
}
interface BalancePreviewData {
  normalWorkdays: number;
  ordinaryMinutesPerDay: number;
  atfMinutesPerDay: number;
  fullWeek: PreviewWeek;
  lastDayHoliday: (PreviewWeek & { holidayWeekday: number }) | null;
}
type PreviewState = { data: BalancePreviewData | null; message: string | null; loading: boolean };

// The server is the only place that computes the balanced week; this just
// asks it (debounced) and drops answers that arrive after a newer request.
function useBalancePreview(
  ordinaryMinutes: number | null,
  atfMinutes: number,
  days: { weekday: number; dayScheduleId: string }[]
): PreviewState | null {
  const [state, setState] = useState<PreviewState>({ data: null, message: null, loading: false });
  const seq = useRef(0);
  const key = JSON.stringify([ordinaryMinutes, atfMinutes, days]);

  useEffect(() => {
    if (ordinaryMinutes === null) {
      seq.current += 1;
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch<BalancePreviewData>("/api/v1/week-schedules/preview", {
          method: "POST",
          body: JSON.stringify({ days, ordinaryMinutesPerWeek: ordinaryMinutes, atfMinutesPerWeek: atfMinutes }),
        });
        if (mine === seq.current) setState({ data, message: null, loading: false });
      } catch (err) {
        if (mine === seq.current) {
          setState({ data: null, message: apiErrorMessage(err, "Kunde inte räkna veckan"), loading: false });
        }
      }
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return ordinaryMinutes === null ? null : state;
}

// "8 h 00 min" — rounded to whole minutes before splitting, so 479.6 is 8 h 00.
function formatHoursMinutes(minutes: number): string {
  const whole = Math.round(minutes);
  return `${Math.floor(whole / 60)} h ${String(whole % 60).padStart(2, "0")} min`;
}

function formatMinutesSv(value: number): string {
  return value.toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

function BalancePreview({ state }: { state: PreviewState }) {
  const { data, message } = state;
  return (
    <div aria-live="polite" style={{ opacity: state.loading ? 0.6 : 1 }}>
      {data && (
        <>
          <FormHint>
            {formatHoursMinutes(data.ordinaryMinutesPerDay)} ordinarie och {formatMinutesSv(data.atfMinutesPerDay)} min ATF per
            arbetsdag. Veckans sista arbetsdag (i fetstil) får det som återstår av veckan.
          </FormHint>
          <PreviewTable title="En hel vecka" week={data.fullWeek} />
          {data.lastDayHoliday && (
            <PreviewTable
              title={`Kort vecka (helgdag på ${WEEKDAY_LABELS[data.lastDayHoliday.holidayWeekday - 1]!.toLowerCase()})`}
              week={data.lastDayHoliday}
            />
          )}
        </>
      )}
      {message && <FormHint>{message}</FormHint>}
    </div>
  );
}

function PreviewTable({ title, week }: { title: string; week: PreviewWeek }) {
  const cell = { padding: "3px 8px", textAlign: "left" as const, whiteSpace: "nowrap" as const };
  return (
    <div style={{ marginTop: 10 }}>
      <strong>{title}</strong>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, color: "var(--color-text-primary)" }}>
          <thead>
            <tr style={{ color: "var(--color-text-secondary)" }}>
              <th style={cell}>Dag</th>
              <th style={cell}>Dagsschema</th>
              <th style={cell}>Slutar</th>
              <th style={cell}>Tid</th>
            </tr>
          </thead>
          <tbody>
            {week.days.map((row) => (
              <tr key={row.weekday} style={{ borderTop: "1px solid var(--color-divider)", fontWeight: row.last ? 700 : 400 }}>
                <td style={cell}>{WEEKDAY_SHORT[row.weekday - 1]}</td>
                <td style={cell}>{row.holiday ? "Helgdag" : row.dayScheduleCode}</td>
                <td className="num" style={cell}>{row.holiday ? "—" : row.endTime}</td>
                <td className="num" style={cell}>{row.holiday ? "—" : formatHours(row.netMinutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Helgdagar ---

function HolidaysTab({ holidays, daySchedules }: { holidays: Holiday[]; daySchedules: DaySchedule[] }) {
  const router = useRouter();
  const currentYear = new Date().getFullYear();
  const years = useMemo(() => {
    const set = new Set(holidays.map((h) => Number(h.date.slice(0, 4))));
    set.add(currentYear);
    return [...set].sort();
  }, [holidays, currentYear]);
  const [year, setYear] = useState(currentYear);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seedResult, setSeedResult] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const rows = holidays.filter((h) => Number(h.date.slice(0, 4)) === year);

  async function deleteHoliday(id: string) {
    setError(null);
    setSeedResult(null);
    try {
      await apiFetch(`/api/v1/holidays/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort helgdagen");
    }
  }

  // Seed the selected year with Swedish holidays; dates that already have a
  // holiday are left untouched.
  async function seedSwedishHolidays() {
    setError(null);
    setSeedResult(null);
    setSeeding(true);
    try {
      const result = await apiFetch<{ created: number; skipped: number }>("/api/v1/holidays/generate-swedish", {
        method: "POST",
        body: JSON.stringify({ year }),
      });
      setSeedResult(
        result.created === 0
          ? `Alla svenska helgdagar ${year} fanns redan.`
          : `${result.created} helgdagar tillagda för ${year}${result.skipped > 0 ? ` (${result.skipped} fanns redan)` : ""}.`
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte förifylla helgdagarna");
    } finally {
      setSeeding(false);
    }
  }

  return (
    <>
      <FormActions style={{ margin: "12px 0", justifyContent: "space-between" }}>
        <Select aria-label="År" size="xs" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        <div style={{ display: "flex", gap: 10 }}>
          <Button type="button" variant="secondary" disabled={seeding} onClick={seedSwedishHolidays}>
            {seeding ? "Fyller i…" : `Förifyll svenska helgdagar ${year}`}
          </Button>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            + Ny helgdag
          </Button>
        </div>
      </FormActions>

      <FormError>{error}</FormError>
      {seedResult && <FormHint>{seedResult}</FormHint>}

      <Table<Holiday>
        columns={[
          { key: "date", label: "Datum", width: "140px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "schedule", label: "Schema", width: "240px" },
          { key: "actions", label: "", width: "110px", align: "right" },
        ]}
        rows={rows}
        emptyText={`Inga helgdagar registrerade för ${year}`}
        renderCell={(holiday, key) => {
          switch (key) {
            case "date":
              return <span className="num">{holiday.date}</span>;
            case "name":
              return <strong>{holiday.name}</strong>;
            case "schedule":
              return holiday.dayScheduleId ? `${holiday.dayScheduleCode} · ${holiday.dayScheduleName}` : "Helt ledig";
            case "actions":
              return (
                <Button type="button" variant="ghost" onClick={() => deleteHoliday(holiday.id)}>
                  Ta bort
                </Button>
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Ny helgdag">
        <HolidayForm
          daySchedules={daySchedules}
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

function HolidayForm({ daySchedules, onDone }: { daySchedules: DaySchedule[]; onDone: () => void }) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [dayScheduleId, setDayScheduleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/holidays", {
        method: "POST",
        body: JSON.stringify({ date, name, dayScheduleId: dayScheduleId === "" ? null : dayScheduleId }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara helgdagen");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Datum" htmlFor="holidayDate">
          <Input id="holidayDate" type="date" required size="sm" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Namn" htmlFor="holidayName">
          <Input id="holidayName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </FormRow>

      <Field label="Schema" htmlFor="holidaySchedule">
        <Select id="holidaySchedule" value={dayScheduleId} onChange={(e) => setDayScheduleId(e.target.value)}>
          <option value="">— Helt ledig —</option>
          {daySchedules.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} · {d.name} ({d.startTime}–{d.endTime})
            </option>
          ))}
        </Select>
        <FormHint>Välj ett dagsschema för t.ex. halvdag, annars är dagen helt ledig.</FormHint>
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Skapa helgdag"}
        </Button>
      </FormActions>
    </Form>
  );
}
