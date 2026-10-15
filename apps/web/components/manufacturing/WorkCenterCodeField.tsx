"use client";

import { Field, Input } from "../ui/Field";
import { FormHint } from "../ui/Form";
import { WORK_CENTER_TYPE_LABELS, type WorkCenter } from "../../lib/types";

// The 3-digit code series is shared by machines, personnel and legoresurser
// (one unique constraint on work_centers.code), so both registers' forms use
// these two pieces: the field itself, and — below the FormRow it sits in — a
// hint listing the numbers already taken. Without it the only feedback on a
// collision is the server's 409 after submit.

// The work center already using `code`, ignoring the one being edited.
export function findCodeClash(
  existing: WorkCenter[],
  code: string,
  currentId: string | undefined
): WorkCenter | null {
  if (code.length === 0) return null;
  return existing.find((wc) => wc.code === code && wc.id !== currentId) ?? null;
}

export function WorkCenterCodeField({
  value,
  onChange,
  clash,
}: {
  value: string;
  onChange: (code: string) => void;
  clash: WorkCenter | null;
}) {
  return (
    <Field label="Nummer (3 siffror)" htmlFor="code">
      <Input
        id="code"
        required
        inputMode="numeric"
        pattern="\d{3}"
        maxLength={3}
        title="Exakt 3 siffror"
        size="xs"
        aria-invalid={clash ? true : undefined}
        aria-describedby="codeHint"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
      />
    </Field>
  );
}

// Goes on its own row *after* the FormRow holding the field — .row is a
// two-column grid, so a hint placed inside it would land in the neighbouring
// column instead of under the number.
export function WorkCenterCodeHint({ existing, clash }: { existing: WorkCenter[]; clash: WorkCenter | null }) {
  if (clash) {
    return (
      <FormHint attached id="codeHint" style={{ color: "var(--status-stopped-text)" }}>
        Numret {clash.code} används redan av {clash.name} ({WORK_CENTER_TYPE_LABELS[clash.type]}
        {!clash.active ? ", inaktiv" : ""}).
      </FormHint>
    );
  }
  if (existing.length === 0) {
    return (
      <FormHint attached id="codeHint">
        Inga nummer är upptagna än — välj fritt.
      </FormHint>
    );
  }
  return (
    <FormHint attached id="codeHint">
      Upptagna nummer ({existing.length} st — maskin, personal och lego delar serie):
      {/* Scrolls rather than growing: a register of fifty resources would
          otherwise push the rest of the form out of the modal. An explicit
          line-height makes max-height land on a line boundary, so the list
          never cuts a row in half and reads as scrollable rather than
          truncated. */}
      <span
        style={{
          display: "block",
          lineHeight: "1.5em",
          maxHeight: "6em",
          overflowY: "auto",
          marginTop: 2,
          paddingRight: 4,
        }}
      >
        {existing.map((wc, i) => (
          <span key={wc.id}>
            {i > 0 ? " · " : ""}
            <strong>{wc.code}</strong> {wc.name}
          </span>
        ))}
      </span>
    </FormHint>
  );
}
