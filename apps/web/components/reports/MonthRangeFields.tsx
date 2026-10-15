import type { ReactNode } from "react";
import { Field, Input } from "../ui/Field";
import { FormHint, FormRow } from "../ui/Form";
import { monthLabel } from "./reportFormat";

// Shared "Från månad"/"Till månad" pair for every Rapporter page — empty
// inputs mean "let the server default to the last 12 months" (see
// docs/manual/rapporter.md). The resolved range the API actually answered
// with is echoed back underneath, since an empty pair is otherwise a filter
// with no visible value. `children` is for a page's extra field (e.g.
// "Gruppera per") sharing the same row.
export function MonthRangeFields({
  from,
  to,
  onFromChange,
  onToChange,
  resolved,
  columns = 2,
  children,
}: {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  resolved?: { from: string; to: string } | null;
  columns?: 2 | 3 | 4;
  children?: ReactNode;
}) {
  return (
    <>
      <FormRow columns={columns}>
        <Field label="Från månad" htmlFor="reportFrom">
          <Input id="reportFrom" type="month" value={from} onChange={(e) => onFromChange(e.target.value)} />
        </Field>
        <Field label="Till månad" htmlFor="reportTo">
          <Input id="reportTo" type="month" value={to} onChange={(e) => onToChange(e.target.value)} />
        </Field>
        {children}
      </FormRow>
      {resolved && (
        <FormHint>
          Visar {monthLabel(resolved.from)} – {monthLabel(resolved.to)}
        </FormHint>
      )}
    </>
  );
}
