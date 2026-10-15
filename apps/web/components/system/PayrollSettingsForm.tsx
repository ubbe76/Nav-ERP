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

    const updated = await save({
      paxmlCodeWorked: codeWorked,
      paxmlCodeOvertime: codeOvertime,
      paxmlCodeOvertimeOffSchedule: codeOvertimeOffSchedule,
      paxmlCodeOvertimeComp: codeOvertimeComp,
      paxmlCodeOvertimeOffScheduleComp: codeOvertimeOffScheduleComp,
      paxmlCodeAtf: codeAtf,
      payrollOvertimeThresholdMinutes: minutes,
    });
    if (updated) {
      setCodeWorked(updated.paxmlCodeWorked);
      setCodeOvertime(updated.paxmlCodeOvertime);
      setCodeOvertimeOffSchedule(updated.paxmlCodeOvertimeOffSchedule);
      setCodeOvertimeComp(updated.paxmlCodeOvertimeComp);
      setCodeOvertimeOffScheduleComp(updated.paxmlCodeOvertimeOffScheduleComp);
      setCodeAtf(updated.paxmlCodeAtf);
      setThresholdMinutes(String(updated.payrollOvertimeThresholdMinutes));
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
