"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { DurationInput } from "../ui/DurationInput";
import { formatDuration, parseDuration } from "../../lib/duration";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import type { SystemSettings } from "../../lib/types";
import cardStyles from "../system/SettingsForm.module.css";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useUnsavedGuard } from "../../lib/unsavedGuard";

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
  // The three durations are tt:mm (lib/duration.ts); the settings keep minutes.
  const [thresholdMinutes, setThresholdMinutes] = useState(formatDuration(settings.payrollOvertimeThresholdMinutes));
  const [atfMinutesPerWeek, setAtfMinutesPerWeek] = useState(formatDuration(settings.atfMinutesPerWeek));
  const [scheduleBalancing, setScheduleBalancing] = useState(settings.scheduleBalancing);

  const [reasonRequired, setReasonRequired] = useState(settings.attendanceReasonRequired);
  const [toleranceMinutes, setToleranceMinutes] = useState(formatDuration(settings.attendanceReasonToleranceMinutes));
  const [overtimeChoice, setOvertimeChoice] = useState(settings.terminalOvertimeChoice);

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);

  async function save(body: Partial<SystemSettings>) {
    setError(null);
    setPending(true);
    try {
      return await apiFetch<SystemSettings>("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara inställningarna"));
      return null;
    } finally {
      setPending(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaved(false);

    const minutes = thresholdMinutes.trim() === "" ? 0 : parseDuration(thresholdMinutes);
    if (minutes === null || minutes > 600) {
      setError("Övertidströskeln ska vara en tid mellan 0:00 och 10:00 (tt:mm)");
      return;
    }

    const atfMinutes = atfMinutesPerWeek.trim() === "" ? 0 : parseDuration(atfMinutesPerWeek);
    if (atfMinutes === null || atfMinutes > 600) {
      setError("ATF-intjäningen ska vara en tid mellan 0:00 och 10:00 (tt:mm)");
      return;
    }

    const tolerance = toleranceMinutes.trim() === "" ? 0 : parseDuration(toleranceMinutes);
    if (tolerance === null || tolerance > 120) {
      setError("Marginalen ska vara en tid mellan 0:00 och 2:00 (tt:mm)");
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
      atfMinutesPerWeek: atfMinutes,
      scheduleBalancing,
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
      setThresholdMinutes(formatDuration(updated.payrollOvertimeThresholdMinutes));
      setAtfMinutesPerWeek(formatDuration(updated.atfMinutesPerWeek));
      setScheduleBalancing(updated.scheduleBalancing);
      setReasonRequired(updated.attendanceReasonRequired);
      setToleranceMinutes(formatDuration(updated.attendanceReasonToleranceMinutes));
      setOvertimeChoice(updated.terminalOvertimeChoice);
      setDirty(false);
      setSaved(true);
    }
  }

  return (
    <div className={cardStyles.card}>
      <Form onSubmit={handleSave} onChange={() => setDirty(true)}>
        <div>
          <div className={cardStyles.label}>Lön, PAXml &amp; schema</div>
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

        <Field label="Övertidströskel per dag (tt:mm)" htmlFor="payrollOvertimeThresholdMinutes">
          <DurationInput id="payrollOvertimeThresholdMinutes" placeholder="t.ex. 0:30" size="sm" value={thresholdMinutes} onValueChange={setThresholdMinutes} />
        </Field>

        <Field label="ATF-intjäning per vecka (tt:mm)" htmlFor="atfMinutesPerWeek">
          <DurationInput id="atfMinutesPerWeek" placeholder="t.ex. 1:22" size="sm" value={atfMinutesPerWeek} onValueChange={setAtfMinutesPerWeek} />
        </Field>
        <FormHint attached>
          Arbetstidsförkortning som tjänas in per fullgjord arbetsvecka, t.ex. 1:22. 0:00 = ATF används inte. Kan avvikas
          per anställd på personalkortet.
        </FormHint>

        <div className={cardStyles.row}>
          <div className={cardStyles.texts}>
            <div className={cardStyles.label}>Tillåt ATF-uttag via schemat</div>
            <div className={cardStyles.description}>
              På: veckoscheman kan få ordinarie arbetstid och ATF per vecka. ATF och inarbetning räknas per arbetsdag,
              och veckans sista arbetsdag blir kortare — är den röd blir dagen före kortare. Av: veckoscheman följer
              bara sina dagsscheman.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={scheduleBalancing}
            aria-label="Tillåt ATF-uttag via schemat"
            className={cardStyles.switch}
            data-on={scheduleBalancing}
            disabled={pending}
            onClick={() => setScheduleBalancing(!scheduleBalancing)}
          >
            <span className={cardStyles.knob} aria-hidden="true" />
          </button>
        </div>

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

        <Field label="Marginal (tt:mm)" htmlFor="attendanceReasonToleranceMinutes">
          <DurationInput id="attendanceReasonToleranceMinutes" placeholder="t.ex. 0:05" size="sm" value={toleranceMinutes} onValueChange={setToleranceMinutes} />
        </Field>
        <FormHint attached>
          Avvikelser upp till och med marginalen kräver ingen anledning. Anledningarna väljs ur registret{" "}
          <Link href="/personal/lonekoder?flik=avvikelseorsaker">
            Personal & lön → Lönekoder → Avvikelseorsaker
          </Link>
          .
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
