"use client";

import { Checkbox, Field, Select, Input } from "../ui/Field";
import { FormHint, FormRow } from "../ui/Form";
import type { DeliveryDayMode } from "../../lib/types";
import styles from "./DeliveryDaysFields.module.css";

// ISO weekdays, Monday = 1 (the API's convention).
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mån" },
  { value: 2, label: "Tis" },
  { value: 3, label: "Ons" },
  { value: 4, label: "Tor" },
  { value: 5, label: "Fre" },
  { value: 6, label: "Lör" },
  { value: 7, label: "Sön" },
];

// What the mode means differs by side: a supplier's date is when the goods
// reach us or leave them, a customer's when they reach the customer or leave us.
const MODE_LABELS: Record<"customer" | "supplier", Record<DeliveryDayMode, string>> = {
  supplier: { arrival: "Ankomst till oss", dispatch: "Avsändning från leverantören" },
  customer: { arrival: "Ankomst till kunden", dispatch: "Avsändning från oss" },
};

export interface DeliveryDayDefaults {
  mode: DeliveryDayMode;
  transitDays: number;
}

export interface DeliveryDaysValue {
  weekdays: number[];
  mode: DeliveryDayMode | null;
  // Raw input text: "" = null (the system default).
  transitDays: string;
}

// Fasta leveransdagar for the Villkor & frakt tab, shared by the supplier and
// customer cards. `defaults` are the current system settings for this side;
// null when they could not be read, then the labels just say "Systemets
// förval" without naming it.
export function DeliveryDaysFields({
  kind,
  value,
  onChange,
  defaults,
}: {
  kind: "customer" | "supplier";
  value: DeliveryDaysValue;
  onChange: (next: DeliveryDaysValue) => void;
  defaults: DeliveryDayDefaults | null;
}) {
  const labels = MODE_LABELS[kind];

  function toggleWeekday(day: number, checked: boolean) {
    const weekdays = checked ? [...value.weekdays, day] : value.weekdays.filter((d) => d !== day);
    onChange({ ...value, weekdays: weekdays.sort((a, b) => a - b) });
  }

  return (
    <>
      <Field label="Leveransdagar">
        <div className={styles.weekdays} role="group" aria-label="Leveransdagar">
          {WEEKDAYS.map((day) => (
            <label key={day.value} className={styles.weekday}>
              <Checkbox
                checked={value.weekdays.includes(day.value)}
                onChange={(e) => toggleWeekday(day.value, e.target.checked)}
              />
              {day.label}
            </label>
          ))}
        </div>
      </Field>
      <FormHint attached>Lämna tomt om alla dagar fungerar.</FormHint>

      <FormRow>
        <Field label="Dagarna avser" htmlFor="deliveryDayMode">
          <Select
            id="deliveryDayMode"
            value={value.mode ?? ""}
            onChange={(e) => onChange({ ...value, mode: e.target.value === "" ? null : (e.target.value as DeliveryDayMode) })}
          >
            <option value="">
              {defaults ? `Systemets förval (${labels[defaults.mode]})` : "Systemets förval"}
            </option>
            <option value="arrival">{labels.arrival}</option>
            <option value="dispatch">{labels.dispatch}</option>
          </Select>
        </Field>
        <Field label="Transportdagar" htmlFor="transitDays">
          <Input
            id="transitDays"
            type="number"
            min="0"
            step="1"
            size="xs"
            placeholder={defaults ? `Förval: ${defaults.transitDays}` : "Förval"}
            value={value.transitDays}
            onChange={(e) => onChange({ ...value, transitDays: e.target.value })}
          />
        </Field>
      </FormRow>
    </>
  );
}
