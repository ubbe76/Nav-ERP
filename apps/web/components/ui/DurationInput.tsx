"use client";

import type { ComponentProps } from "react";
import { Input } from "./Field";
import { DURATION_HINT, durationPattern, formatDuration, parseDuration } from "../../lib/duration";

// A duration typed as tt:mm (lib/duration.ts — a bare number is minutes).
// Leaving the field writes what was understood ("90" → "1:30", "8" → "0:08"),
// so the reading is seen before it is saved; the browser's pattern check
// stops a submit of anything else. The value stays text — the form converts
// it to minutes or hours when it sends.
export function DurationInput({
  value,
  onValueChange,
  signed = false,
  onBlur,
  ...props
}: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type" | "pattern" | "inputMode"> & {
  value: string;
  onValueChange: (value: string) => void;
  // An ATF adjustment can be negative.
  signed?: boolean;
}) {
  return (
    <Input
      type="text"
      // The decimal keypad has digits and a separator (the minus is not on
      // it, so a signed field keeps the full keyboard).
      inputMode={signed ? "text" : "decimal"}
      autoComplete="off"
      pattern={durationPattern(signed)}
      title={DURATION_HINT}
      placeholder="t.ex. 1:30"
      {...props}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      onBlur={(e) => {
        const minutes = parseDuration(e.target.value, { signed });
        if (minutes !== null) {
          const shown = formatDuration(minutes);
          if (shown !== e.target.value) onValueChange(shown);
        }
        onBlur?.(e);
      }}
    />
  );
}
