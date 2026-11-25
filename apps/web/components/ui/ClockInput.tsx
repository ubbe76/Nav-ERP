"use client";

import type { InputHTMLAttributes } from "react";
import { Input } from "./Field";
import { CLOCK_PATTERN, normalizeClockTime } from "../../lib/clockTime";
import { withAutoColon } from "../../lib/duration";

// 24-hour clock time field (scheman, OB-tillägg). The native
// <input type="time"> renders AM/PM when the browser's OS locale says so — a
// text input keeps the register 24-hour everywhere. Digits get their colon
// while typed ("0730" shows 07:30 — the phone's numeric keypad has no colon);
// leaving the field writes HH:MM ("7" → "07:00", "730" → "07:30"), and the
// pattern catches leftovers on submit.
export function ClockInput({
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
      pattern={CLOCK_PATTERN}
      title="Klockslag i 24-timmarsformat, t.ex. 06:30 eller 16:00 — kolonet fylls i själv, så 0630 räcker"
      value={value}
      onChange={(e) => onValueChange(withAutoColon(e.target.value, value))}
      onBlur={(e) => {
        const normalized = normalizeClockTime(e.target.value);
        if (normalized && normalized !== value) onValueChange(normalized);
      }}
    />
  );
}
