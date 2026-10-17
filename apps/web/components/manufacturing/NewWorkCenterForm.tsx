"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { ProductionGroup, WeekSchedule, WorkCenter } from "../../lib/types";
import { Form, FormHint, FormActions, FormError, FormRow } from "../ui/Form";
import { findCodeClash, WorkCenterCodeField, WorkCenterCodeHint } from "./WorkCenterCodeField";

// Creates a work center (resurs), or edits one when `workCenter` is passed.
export function NewWorkCenterForm({
  workCenter,
  allWorkCenters,
  groups,
  weekSchedules,
  onSuccess,
}: {
  workCenter?: WorkCenter;
  // Every work center regardless of type — legoresurser share the same
  // 3-digit code series, so the number hint has to show them too.
  allWorkCenters: WorkCenter[];
  groups: ProductionGroup[];
  weekSchedules: WeekSchedule[];
  onSuccess: () => void;
}) {
  const [code, setCode] = useState(workCenter?.code ?? "");
  const [name, setName] = useState(workCenter?.name ?? "");
  const [type, setType] = useState<WorkCenter["type"]>(workCenter?.type ?? "machine");
  const [productionGroupId, setProductionGroupId] = useState(workCenter?.productionGroupId ?? "");
  const [hourlyRate, setHourlyRate] = useState(workCenter ? String(Number(workCenter.hourlyRate)) : "0");
  const [overheadPercent, setOverheadPercent] = useState(
    workCenter ? String(Number(workCenter.overheadPercent)) : "0"
  );
  const [weekScheduleId, setWeekScheduleId] = useState(workCenter?.weekScheduleId ?? "");
  const [capacityFactor, setCapacityFactor] = useState(
    workCenter ? String(Number(workCenter.capacityFactor)) : "1"
  );
  const [hoursPerDay, setHoursPerDay] = useState(
    workCenter?.hoursPerDay != null ? String(Number(workCenter.hoursPerDay)) : ""
  );
  const [active, setActive] = useState(workCenter?.active ?? true);
  // Monitor G5 import fields (Produktionsgruppslista Kostnader/Lista) —
  // manually editable too, not just importable.
  const [calcRate1, setCalcRate1] = useState(
    workCenter?.calcRate1 != null ? String(Number(workCenter.calcRate1)) : ""
  );
  const [rateAppliesToSetup, setRateAppliesToSetup] = useState(workCenter?.rateAppliesToSetup ?? false);
  const [rateAppliesToRun, setRateAppliesToRun] = useState(workCenter?.rateAppliesToRun ?? false);
  const [defaultSetupTime, setDefaultSetupTime] = useState(
    workCenter?.defaultSetupTime != null ? String(Number(workCenter.defaultSetupTime)) : ""
  );
  const [defaultOperationName, setDefaultOperationName] = useState(workCenter?.defaultOperationName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Active schedules, plus whichever one is currently selected even if it's
  // since been deactivated — otherwise editing a work center pointed at a
  // now-inactive schedule renders a blank select (value with no matching
  // option), silently inviting the user to wipe the link on save.
  const selectableWeekSchedules = weekSchedules.filter((ws) => ws.active || ws.id === weekScheduleId);
  // Caught here rather than as the server's 409 after submit.
  const codeClash = findCodeClash(allWorkCenters, code, workCenter?.id);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const payload = {
        code,
        name,
        type,
        productionGroupId: productionGroupId === "" ? null : productionGroupId,
        hourlyRate: Number(hourlyRate),
        overheadPercent: Number(overheadPercent),
        weekScheduleId: weekScheduleId || null,
        capacityFactor: Number(capacityFactor),
        hoursPerDay: hoursPerDay.trim() === "" ? null : Number(hoursPerDay),
        active,
        calcRate1: calcRate1.trim() === "" ? null : Number(calcRate1),
        rateAppliesToSetup,
        rateAppliesToRun,
        defaultSetupTime: defaultSetupTime.trim() === "" ? null : Number(defaultSetupTime),
        defaultOperationName: defaultOperationName.trim() === "" ? null : defaultOperationName,
      };
      if (workCenter) {
        await apiFetch(`/api/v1/work-centers/${workCenter.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/api/v1/work-centers", { method: "POST", body: JSON.stringify(payload) });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara resursen");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <WorkCenterCodeField value={code} onChange={setCode} clash={codeClash} />
        <Field label="Typ" htmlFor="type">
          <Select id="type" value={type} onChange={(e) => setType(e.target.value as WorkCenter["type"])}>
            <option value="machine">Maskin</option>
            <option value="personnel">Personal</option>
          </Select>
        </Field>
      </FormRow>
      <WorkCenterCodeHint existing={allWorkCenters} clash={codeClash} />

      <Field label="Namn" htmlFor="name">
        <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Produktionsgrupp" htmlFor="productionGroupId">
        <Select id="productionGroupId" value={productionGroupId} onChange={(e) => setProductionGroupId(e.target.value)}>
          <option value="">— Ingen —</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.code} · {group.name}
            </option>
          ))}
        </Select>
      </Field>

      <FormRow>
        <Field label="Timkostnad" htmlFor="hourlyRate">
          <Input id="hourlyRate" type="number" min="0" step="0.01" size="sm" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} />
        </Field>
        {/* TO — tillverkningsomkostnad, a percentage of this resource's labor
            cost. The other markups (MO/LO/Affo/generellt) are system-wide and
            live under System → Kalkyler. */}
        <Field label="TO-påslag (%)" htmlFor="overheadPercent">
          <Input id="overheadPercent" type="number" min="0" step="0.01" size="xs" value={overheadPercent} onChange={(e) => setOverheadPercent(e.target.value)} />
        </Field>
      </FormRow>

      {/* Monitor G5 import fields (Produktionsgruppslista Kostnader/Lista) —
          a second calc rate and which of ställ/styck it applies to, plus the
          Lista file's default setup time and operation name used to prefill
          new routing rows for this resource. */}
      <FormRow>
        <Field label="Kalkylpris 1" htmlFor="calcRate1">
          <Input id="calcRate1" type="number" min="0" step="0.01" size="sm" value={calcRate1} onChange={(e) => setCalcRate1(e.target.value)} />
        </Field>
        <Field label="Förvald ställtid" htmlFor="defaultSetupTime">
          <Input
            id="defaultSetupTime"
            type="number"
            min="0"
            step="any"
            size="sm"
            value={defaultSetupTime}
            onChange={(e) => setDefaultSetupTime(e.target.value)}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Gäller ställ" htmlFor="rateAppliesToSetup">
          <Toggle id="rateAppliesToSetup" checked={rateAppliesToSetup} onChange={(e) => setRateAppliesToSetup(e.target.checked)} />
        </Field>
        <Field label="Gäller styck" htmlFor="rateAppliesToRun">
          <Toggle id="rateAppliesToRun" checked={rateAppliesToRun} onChange={(e) => setRateAppliesToRun(e.target.checked)} />
        </Field>
      </FormRow>

      <Field label="Förvald operationsbenämning" htmlFor="defaultOperationName">
        <Input
          id="defaultOperationName"
          maxLength={100}
          value={defaultOperationName}
          onChange={(e) => setDefaultOperationName(e.target.value)}
        />
      </Field>

      {/* E2 Beläggning: the schedule drives availableHours per week in the
          capacity matrix; the factor multiplies it (parallel machines). */}
      <FormRow>
        <Field label="Veckoschema (kapacitet)" htmlFor="weekScheduleId">
          <Select id="weekScheduleId" value={weekScheduleId} onChange={(e) => setWeekScheduleId(e.target.value)}>
            <option value="">— Inget —</option>
            {selectableWeekSchedules.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.code} · {ws.name}
                {!ws.active ? " (inaktiv)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kapacitetsfaktor" htmlFor="capacityFactor">
          <Input
            id="capacityFactor"
            type="number"
            min="0"
            step="any"
            size="xs"
            value={capacityFactor}
            onChange={(e) => setCapacityFactor(e.target.value)}
          />
        </Field>
      </FormRow>

      {/* Without a week schedule, hours per day (Monday–Friday) give the
          resource capacity — the schedule wins when both are set. */}
      <Field label="Kapacitet (timmar per dag)" htmlFor="hoursPerDay">
        <Input
          id="hoursPerDay"
          type="number"
          min="0"
          max="24"
          step="any"
          size="xs"
          value={hoursPerDay}
          onChange={(e) => setHoursPerDay(e.target.value)}
        />
      </Field>
      <FormHint attached>Måndag–fredag, helgdagar avräknade. Används när resursen saknar veckoschema.</FormHint>

      <Field label="Aktiv" htmlFor="active">
        <Toggle id="active" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || codeClash !== null}>
          {pending ? "Sparar…" : workCenter ? "Spara resurs" : "Skapa resurs"}
        </Button>
      </FormActions>
    </Form>
  );
}
