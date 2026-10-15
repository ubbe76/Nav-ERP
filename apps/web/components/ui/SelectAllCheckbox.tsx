"use client";

import { useEffect, useRef } from "react";
import { Checkbox } from "./Field";

// Header checkbox for a selectable list: checked when every selectable row is
// picked, indeterminate when only some are. Lives in its own client component
// because `indeterminate` is a DOM property with no JSX attribute — it has to
// be written to the node through a ref, which the plain `Checkbox` wrapper in
// Field.tsx (importable from server components) can't do.
export function SelectAllCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <Checkbox
      ref={ref}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={ariaLabel}
    />
  );
}
