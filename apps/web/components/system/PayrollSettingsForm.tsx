"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import type { SystemSettings } from "../../lib/types";
import cardStyles from "./SettingsForm.module.css";

// PAXml löneart codes for the payroll export (löneunderlag) and the daily
// overtime grace period. The codes themselves mean nothing to NAV — they are
// only stamped onto the exported PAXml file, so they must match whatever the
// payroll system's own löneartstabell expects.
export function PayrollSettingsForm({ settings }: { settings: SystemSettings }) {
  const [codeWorked, setCodeWorked] = useState(settings.paxmlCodeWorked);
  const [codeOvertime, setCodeOvertime] = useState(settings.paxmlCodeOvertime);
  const [codeOvertimeOffSchedule, setCodeOvertimeOffSchedule] = useState(settings.paxmlCodeOvertimeOffSchedule);
  const [codeOvertimeComp, setCodeOvertimeComp] = useState(settings.paxmlCodeOvertimeComp);
  const [codeOvertimeOffScheduleComp, setCodeOvertimeOffScheduleComp] = useState(
    settings.paxmlCodeOvertimeOffScheduleComp
  );
  const [codeAtf, setCodeAtf] = useState(settings.paxmlCodeAtf);
  const [thresholdMinutes, setThresholdMinutes] = useState(String(settings.payrollOvertimeThresholdMinutes));

  const [reasonRequired, setReasonRequired] = useState(settings.attendanceReasonRequired);
  const [toleranceMinutes, setToleranceMinutes] = useState(String(settings.attendanceReasonToleranceMinutes));
  const [overtimeChoice, setOvertimeChoice] = useState(settings.terminalOvertimeChoice);

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(body: Partial<SystemSettings>) {
    setError(null);
    setPending(true);
    try {
      return await apiFetch<SystemSettings>("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara inställningarna");
      return null;
    } finally {
      setPending(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaved(false);

    const minutes = thresholdMinutes.trim() === "" ? 0 : Number(thresholdMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 600) {
      setError("Övertidströskeln måste vara ett heltal 0–600 minuter");
      return;
    }

    const tolerance = toleranceMinutes.trim() === "" ? 0 : Number(toleranceMinutes);
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 120) {
      setError("Marginalen måste vara ett heltal 0–120 minuter");
      return;
    }

    const updated = await save({
      paxmlCodeWorked: codeWorked,
      paxmlCodeOvertime: codeOvertime,
      paxmlCodeOvertimeOffSchedule: codeOvertimeOffSchedule,
      paxmlCodeOvertimeComp: codeOvertimeComp,
      paxmlCodeOvertimeOffScheduleComp: codeOvertimeOffScheduleComp,
      paxmlCodeAtf: codeAtf,
      payrollOvertimeThresholdMinutes: minutes,
      attendanceReasonRequired: reasonRequired,
      attendanceReasonToleranceMinutes: tolerance,
      terminalOvertimeChoice: overtimeChoice,
    });
    if (updated) {
      setCodeWorked(updated.paxmlCodeWorked);
      setCodeOvertime(updated.paxmlCodeOvertime);
      setCodeOvertimeOffSchedule(updated.paxmlCodeOvertimeOffSchedule);
      setCodeOvertimeComp(updated.paxmlCodeOvertimeComp);
      setCodeOvertimeOffScheduleComp(updated.paxmlCodeOvertimeOffScheduleComp);
      setCodeAtf(updated.paxmlCodeAtf);
      setThresholdMinutes(String(updated.payrollOvertimeThresholdMinutes));
      setReasonRequired(updated.attendanceReasonRequired);
      setToleranceMinutes(String(updated.attendanceReasonToleranceMinutes));
      setOvertimeChoice(updated.terminalOvertimeChoice);
      setSaved(true);
    }
  }

  return (
    <div className={cardStyles.card} style={{ marginTop: 18 }}>
      <Form onSubmit={handleSave}>
        <div>
          <div className={cardStyles.label}>Lön &amp; PAXml</div>
          <div className={cardStyles.description}>
            Tidkoder och övertidsregler som används av löneunderlagsexporten (PAXml).
          </div>
        </div>
        <FormError>{error}</FormError>

        <FormRow>
          <Field label="Tidkod arbetad tid" htmlFor="paxmlCodeWorked">
            <Input
              id="paxmlCodeWorked"
              value={codeWorked}
              onChange={(e) => setCodeWorked(e.target.value)}
              maxLength={20}
              size="md"
            />
          </Field>
          <Field label="Tidkod övertid" htmlFor="paxmlCodeOvertime">
            <Input
              id="paxmlCodeOvertime"
              value={codeOvertime}
              onChange={(e) => setCodeOvertime(e.target.value)}
              maxLength={20}
              size="md"
            />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Tidkod övertid helg" htmlFor="paxmlCodeOvertimeOffSchedule">
            <Input
              id="paxmlCodeOvertimeOffSchedule"
              value={codeOvertimeOffSchedule}
              onChange={(e) => setCodeOvertimeOffSchedule(e.target.value)}
              maxLength={20}
              size="md"
            />
          </Field>
          <Field label="Tidkod ATF-uttag" htmlFor="paxmlCodeAtf">
            <Input id="paxmlCodeAtf" value={codeAtf} onChange={(e) => setCodeAtf(e.target.value)} maxLength={20} size="md" />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Tidkod övertid – komptid" htmlFor="paxmlCodeOvertimeComp">
            <Input
              id="paxmlCodeOvertimeComp"
              value={codeOvertimeComp}
              onChange={(e) => setCodeOvertimeComp(e.target.value)}
              maxLength={20}
              size="md"
            />
          </Field>
          <Field label="Tidkod övertid helg – komptid" htmlFor="paxmlCodeOvertimeOffScheduleComp">
            <Input
              id="paxmlCodeOvertimeOffScheduleComp"
              value={codeOvertimeOffScheduleComp}
              onChange={(e) => setCodeOvertimeOffScheduleComp(e.target.value)}
              maxLength={20}
              size="md"
            />
          </Field>
        </FormRow>
        <FormHint attached>Tidkoderna måste matcha lönesystemets löneartstabell — stäm av med er lönekonsult.</FormHint>

        <Field label="Övertidströskel (minuter per dag)" htmlFor="payrollOvertimeThresholdMinutes">
          <Input
            id="payrollOvertimeThresholdMinutes"
            type="number"
            min={0}
            max={600}
            size="sm"
            value={thresholdMinutes}
            onChange={(e) => setThresholdMinutes(e.target.value)}
          />
        </Field>

        <div className={cardStyles.row}>
          <div className={cardStyles.texts}>
            <div className={cardStyles.label}>Kräv anledning vid sen ankomst och tidig hemgång</div>
            <div className={cardStyles.description}>
              På: terminalen frågar efter en anledning när närvaron stämplas in senare än schemats start, eller ut
              tidigare än schemats slut, med mer än marginalen. Gäller inte lediga dagar eller uttag av ATF.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={reasonRequired}
            aria-label="Kräv anledning vid sen ankomst och tidig hemgång"
            className={cardStyles.switch}
            data-on={reasonRequired}
            disabled={pending}
            onClick={() => setReasonRequired(!reasonRequired)}
          >
            <span className={cardStyles.knob} aria-hidden="true" />
          </button>
        </div>

        <Field label="Marginal (minuter)" htmlFor="attendanceReasonToleranceMinutes">
          <Input
            id="attendanceReasonToleranceMinutes"
            type="number"
            min={0}
            max={120}
            size="sm"
            value={toleranceMinutes}
            onChange={(e) => setToleranceMinutes(e.target.value)}
          />
        </Field>
        <FormHint attached>
          Avvikelser upp till och med marginalen kräver ingen anledning. Anledningarna väljs ur registret
          Avvikelseorsaker under Lönekoder.
        </FormHint>

        <div className={cardStyles.row}>
          <div className={cardStyles.texts}>
            <div className={cardStyles.label}>Fråga om övertidsersättning i terminalen</div>
            <div className={cardStyles.description}>
              På: när dagen ger övertid enligt lönens regel frågar terminalen vid Gå hem om övertiden ska betalas ut
              eller sparas som komptid. Valet sparas som dagens val i löneunderlaget.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={overtimeChoice}
            aria-label="Fråga om övertidsersättning i terminalen"
            className={cardStyles.switch}
            data-on={overtimeChoice}
            disabled={pending}
            onClick={() => setOvertimeChoice(!overtimeChoice)}
          >
            <span className={cardStyles.knob} aria-hidden="true" />
          </button>
        </div>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <span className={cardStyles.saved}>Sparat</span>}
        </FormActions>
      </Form>
    </div>
  );
}
