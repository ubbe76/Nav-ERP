"use client";

import { Input } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import styles from "./Structure.module.css";

// A formula text field (monospace) with the language hint and the template's codes.
export function FormulaField({
  id,
  value,
  onChange,
  codes,
  error,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  codes: string[];
  error?: string | null;
}) {
  return (
    <>
      <Input
        id={id}
        className={styles.formula}
        value={value}
        maxLength={500}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <FormHint attached>
        Koder: {codes.length > 0 ? codes.join(", ") : "—"} · + − × ÷ · min, max, avrunda, avrunda_upp, avrunda_ned, om ·
        decimalkomma, ; mellan argument
      </FormHint>
      <FormError>{error}</FormError>
    </>
  );
}
