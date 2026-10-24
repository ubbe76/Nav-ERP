"use client";

import { useId, type InputHTMLAttributes } from "react";
import { Input } from "./Field";
import { COMMON_CURRENCIES } from "../../lib/currency";

// A currency code field (ISO 4217, three capital letters) with the common
// currencies as suggestions — any code the API accepts can still be typed
// (Riksbanken publishes more than the suggestions). Upper-cases as it is typed.
export function CurrencyInput({
  value,
  onValueChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size" | "list"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const listId = useId();
  return (
    <>
      <Input
        size="xs"
        maxLength={3}
        pattern="[A-Z]{3}"
        title="3 stora bokstäver, t.ex. SEK eller EUR"
        autoComplete="off"
        {...props}
        list={listId}
        value={value}
        onChange={(e) => onValueChange(e.target.value.toUpperCase())}
      />
      <datalist id={listId}>
        <option value="SEK" />
        {COMMON_CURRENCIES.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>
    </>
  );
}
