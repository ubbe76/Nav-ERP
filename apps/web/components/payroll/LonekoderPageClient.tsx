"use client";

import { useState, type FormEvent, type InputHTMLAttributes } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  OB_DAY_KIND_LABELS,
  type AbsenceType,
  type AttendanceDeviationReason,
  type ObDayKind,
  type ObRule,
} from "../../lib/types";
import styles from "./LonekoderPageClient.module.css";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";

const TABS = ["Frånvarokoder", "OB-tillägg", "Avvikelseorsaker"] as const;
export type Tab = (typeof TABS)[number];

// Same free-form "HH:MM" normalization as SchedulesPageClient's ClockInput
// (apps/web/components/timereport/SchedulesPageClient.tsx) — that helper
// isn't exported, so it's duplicated here rather than reaching across
// module boundaries for a private function.
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

// 24-hour time field, same as SchedulesPageClient's — free-form typing is
// normalized on blur, the pattern catches leftovers on submit.
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

// Shown on both create/edit modals — free-text PAXml codes have no
// server-side allowlist, so a mistyped code only surfaces as an invalid
// export file once payroll actually tries to run it.
const PAXML_HINT =
  "PAXml-koden måste finnas i lönesystemets löneartstabell — en felaktig kod ger en ogiltig exportfil.";

// Both registers share the same duplicate-code/name (409, DuplicatePayrollCodeError)
// and OB-window (400, InvalidObWindowError) failure shapes from the API —
// translated to fixed Swedish copy by the shared error-code dictionary.
function formatPayrollError(err: unknown): string {
  return apiErrorMessage(err, "Kunde inte spara");
}

const rowLinkStyle = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  color: "inherit",
} as const;

export function LonekoderPageClient({
  absenceTypes,
  obRules,
  deviationReasons,
  scheduleBalancing,
  initialTab,
}: {
  absenceTypes: AbsenceType[];
  obRules: ObRule[];
  deviationReasons: AttendanceDeviationReason[];
  // Shows the "Tjänar in ATF" setting on absence codes.
  scheduleBalancing: boolean;
  // ?flik=avvikelseorsaker — the settings panel links straight to the register.
  initialTab?: Tab;
}) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? "Frånvarokoder");

  return (
    <>
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

      {activeTab === "Frånvarokoder" && <AbsenceTypesTab absenceTypes={absenceTypes} scheduleBalancing={scheduleBalancing} />}
      {activeTab === "OB-tillägg" && <ObRulesTab obRules={obRules} />}
      {activeTab === "Avvikelseorsaker" && <DeviationReasonsTab reasons={deviationReasons} />}
    </>
  );
}

// --- Frånvarokoder ---

function AbsenceTypesTab({
  absenceTypes,
  scheduleBalancing,
}: {
  absenceTypes: AbsenceType[];
  scheduleBalancing: boolean;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AbsenceType | null>(null);
  const [seedNotice, setSeedNotice] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  async function runSeed() {
    setSeeding(true);
    setSeedNotice(null);
    try {
      const result = await apiFetch<{ created: number; skipped: number }>(
        "/api/v1/absence-types/generate-standard",
        { method: "POST" }
      );
      setSeedNotice(
        result.created === 0
          ? "Alla standardkoder fanns redan"
          : `${result.created} skapade${result.skipped > 0 ? `, ${result.skipped} fanns redan` : ""}`
      );
      router.refresh();
    } catch (err) {
      setSeedNotice(err instanceof Error ? err.message : "Kunde inte förifylla");
    } finally {
      setSeeding(false);
    }
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, marginBottom: 14 }}>
        {seedNotice && (
          <span style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--color-text-secondary)" }}>
            {seedNotice}
          </span>
        )}
        <Button type="button" variant="secondary" disabled={seeding} onClick={runSeed}>
          {seeding ? "Förifyller…" : "Förifyll standardkoder"}
        </Button>
        <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
          + Ny frånvarokod
        </Button>
      </div>

      <Table<AbsenceType>
        columns={[
          { key: "code", label: "Kod", width: "110px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "paxmlCode", label: "PAXml-kod", width: "140px" },
          ...(scheduleBalancing ? [{ key: "earnsAtf", label: "Tjänar in ATF", width: "130px" }] : []),
          { key: "active", label: "Aktiv", width: "110px" },
        ]}
        rows={absenceTypes}
        emptyText="Inga frånvarokoder registrerade än"
        renderCell={(type, key) => {
          switch (key) {
            case "code":
              return (
                <button type="button" onClick={() => setEditing(type)} style={rowLinkStyle}>
                  {type.code}
                </button>
              );
            case "name":
              return (
                <button type="button" onClick={() => setEditing(type)} style={rowLinkStyle}>
                  <strong>{type.name}</strong>
                </button>
              );
            case "paxmlCode":
              return <span className="num">{type.paxmlCode}</span>;
            case "earnsAtf":
              return type.earnsAtf ? "Ja" : "Nej";
            case "active":
              return type.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Ny frånvarokod">
        <AbsenceTypeForm
          scheduleBalancing={scheduleBalancing}
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
          <AbsenceTypeForm
            absenceType={editing}
            scheduleBalancing={scheduleBalancing}
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

function AbsenceTypeForm({
  absenceType,
  scheduleBalancing,
  onDone,
}: {
  absenceType?: AbsenceType;
  scheduleBalancing: boolean;
  onDone: () => void;
}) {
  const [code, setCode] = useState(absenceType?.code ?? "");
  const [name, setName] = useState(absenceType?.name ?? "");
  const [paxmlCode, setPaxmlCode] = useState(absenceType?.paxmlCode ?? "");
  const [active, setActive] = useState(absenceType?.active ?? true);
  const [earnsAtf, setEarnsAtf] = useState(absenceType?.earnsAtf ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const payload = { code, name, paxmlCode, active, ...(scheduleBalancing ? { earnsAtf } : {}) };
      if (absenceType) {
        await apiFetch(`/api/v1/absence-types/${absenceType.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch("/api/v1/absence-types", { method: "POST", body: JSON.stringify(payload) });
      }
      onDone();
    } catch (err) {
      setError(formatPayrollError(err));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>
      <FormHint>{PAXML_HINT}</FormHint>

      <FormRow>
        <Field label="Kod" htmlFor="absenceCode">
          <Input id="absenceCode" required maxLength={20} size="md" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Aktiv" htmlFor="absenceActive">
          <Toggle id="absenceActive" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </Field>
      </FormRow>

      <Field label="Namn" htmlFor="absenceName">
        <Input id="absenceName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="PAXml-tidkod" htmlFor="absencePaxmlCode">
        <Input
          id="absencePaxmlCode"
          required
          maxLength={20}
          size="md"
          value={paxmlCode}
          onChange={(e) => setPaxmlCode(e.target.value)}
        />
      </Field>

      {scheduleBalancing && (
        <Field label="Tjänar in ATF" htmlFor="absenceEarnsAtf">
          <Toggle id="absenceEarnsAtf" checked={earnsAtf} onChange={(e) => setEarnsAtf(e.target.checked)} />
          <FormHint>
            Av: en arbetsdag med den här frånvaron tjänar inte in sin ATF-andel, och veckans sista arbetsdag blir så mycket
            längre (t.ex. sjukdom, VAB).
          </FormHint>
        </Field>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : absenceType ? "Spara" : "Skapa"}
        </Button>
      </FormActions>
    </Form>
  );
}

// --- OB-tillägg ---

function ObRulesTab({ obRules }: { obRules: ObRule[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ObRule | null>(null);

  return (
    <>
      <FormActions style={{ margin: "12px 0" }}>
        <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
          + Nytt OB-tillägg
        </Button>
      </FormActions>

      <Table<ObRule>
        columns={[
          { key: "code", label: "Kod", width: "110px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "dayKind", label: "Dagtyp", width: "110px" },
          { key: "time", label: "Tid", width: "140px" },
          { key: "paxmlCode", label: "PAXml-kod", width: "140px" },
          { key: "active", label: "Aktiv", width: "110px" },
        ]}
        rows={obRules}
        emptyText="Inga OB-tillägg registrerade än"
        renderCell={(rule, key) => {
          switch (key) {
            case "code":
              return (
                <button type="button" onClick={() => setEditing(rule)} style={rowLinkStyle}>
                  {rule.code}
                </button>
              );
            case "name":
              return (
                <button type="button" onClick={() => setEditing(rule)} style={rowLinkStyle}>
                  <strong>{rule.name}</strong>
                </button>
              );
            case "dayKind":
              return OB_DAY_KIND_LABELS[rule.dayKind];
            case "time":
              return (
                <span className="num">
                  {rule.startTime}–{rule.endTime}
                </span>
              );
            case "paxmlCode":
              return <span className="num">{rule.paxmlCode}</span>;
            case "active":
              return rule.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nytt OB-tillägg">
        <ObRuleForm
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
          <ObRuleForm
            obRule={editing}
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

function ObRuleForm({ obRule, onDone }: { obRule?: ObRule; onDone: () => void }) {
  const [code, setCode] = useState(obRule?.code ?? "");
  const [name, setName] = useState(obRule?.name ?? "");
  const [dayKind, setDayKind] = useState<ObDayKind>(obRule?.dayKind ?? "weekday");
  const [startTime, setStartTime] = useState(obRule?.startTime ?? "18:00");
  const [endTime, setEndTime] = useState(obRule?.endTime ?? "22:00");
  const [paxmlCode, setPaxmlCode] = useState(obRule?.paxmlCode ?? "");
  const [active, setActive] = useState(obRule?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const payload = { code, name, dayKind, startTime, endTime, paxmlCode, active };
      if (obRule) {
        await apiFetch(`/api/v1/ob-rules/${obRule.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/api/v1/ob-rules", { method: "POST", body: JSON.stringify(payload) });
      }
      onDone();
    } catch (err) {
      setError(formatPayrollError(err));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>
      <FormHint>{PAXML_HINT}</FormHint>

      <FormRow>
        <Field label="Kod" htmlFor="obCode">
          <Input id="obCode" required maxLength={20} size="md" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Aktiv" htmlFor="obActive">
          <Toggle id="obActive" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </Field>
      </FormRow>

      <Field label="Namn" htmlFor="obName">
        <Input id="obName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Dagtyp" htmlFor="obDayKind">
        <Select id="obDayKind" value={dayKind} onChange={(e) => setDayKind(e.target.value as ObDayKind)}>
          {(Object.keys(OB_DAY_KIND_LABELS) as ObDayKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {OB_DAY_KIND_LABELS[kind]}
            </option>
          ))}
        </Select>
      </Field>

      <FormRow>
        <Field label="Från" htmlFor="obStart">
          <ClockInput id="obStart" required value={startTime} onValueChange={setStartTime} />
        </Field>
        <Field label="Till" htmlFor="obEnd">
          <ClockInput id="obEnd" required value={endTime} onValueChange={setEndTime} />
        </Field>
      </FormRow>
      <FormHint>
        Tidsfönstret får inte gå över midnatt. Ett tillägg som gäller natten mot nästa dag läggs som två rader,
        t.ex. 22:00–23:59 och 00:00–06:00.
      </FormHint>

      <Field label="PAXml-tidkod" htmlFor="obPaxmlCode">
        <Input
          id="obPaxmlCode"
          required
          maxLength={20}
          size="md"
          value={paxmlCode}
          onChange={(e) => setPaxmlCode(e.target.value)}
        />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : obRule ? "Spara" : "Skapa"}
        </Button>
      </FormActions>
    </Form>
  );
}

// --- Avvikelseorsaker ---

function DeviationReasonsTab({ reasons }: { reasons: AttendanceDeviationReason[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AttendanceDeviationReason | null>(null);

  return (
    <>
      <FormHint>
        Orsaker som stämpelterminalen erbjuder när någon kommer sent eller går tidigt. Orsaker raderas aldrig —
        avmarkera Aktiv för att dölja en.
      </FormHint>
      <FormActions style={{ margin: "12px 0" }}>
        <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
          + Ny avvikelseorsak
        </Button>
      </FormActions>

      <Table<AttendanceDeviationReason>
        columns={[
          { key: "code", label: "Kod", width: "110px" },
          { key: "name", label: "Benämning", width: "1fr" },
          { key: "active", label: "Aktiv", width: "110px" },
        ]}
        rows={reasons}
        emptyText="Inga avvikelseorsaker registrerade än"
        renderCell={(reason, key) => {
          switch (key) {
            case "code":
              return (
                <button type="button" onClick={() => setEditing(reason)} style={rowLinkStyle}>
                  {reason.code}
                </button>
              );
            case "name":
              return (
                <button type="button" onClick={() => setEditing(reason)} style={rowLinkStyle}>
                  <strong>{reason.name}</strong>
                </button>
              );
            case "active":
              return reason.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Ny avvikelseorsak">
        <DeviationReasonForm
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
          <DeviationReasonForm
            reason={editing}
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

function DeviationReasonForm({ reason, onDone }: { reason?: AttendanceDeviationReason; onDone: () => void }) {
  const [code, setCode] = useState(reason?.code ?? "");
  const [name, setName] = useState(reason?.name ?? "");
  const [active, setActive] = useState(reason?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const payload = { code, name, active };
      if (reason) {
        await apiFetch(`/api/v1/attendance-deviation-reasons/${reason.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch("/api/v1/attendance-deviation-reasons", { method: "POST", body: JSON.stringify(payload) });
      }
      onDone();
    } catch (err) {
      setError(formatPayrollError(err));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Kod" htmlFor="deviationCode">
          <Input id="deviationCode" required maxLength={10} size="md" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Aktiv" htmlFor="deviationActive">
          <Toggle id="deviationActive" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </Field>
      </FormRow>

      <Field label="Benämning" htmlFor="deviationName">
        <Input id="deviationName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : reason ? "Spara" : "Skapa"}
        </Button>
      </FormActions>
    </Form>
  );
}
