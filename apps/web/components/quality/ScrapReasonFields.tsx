"use client";

import { Field, Input, Select } from "../ui/Field";
import type { DeviationReason } from "../../lib/quality";

// The kassation's reason on the TO card and Pågående arbete: Orsak from the
// Kvalitetsorsaker flagged Kassation plus an optional Kommentar — or, when the
// installation has none, the free-text Kassationsorsak as before.
export function ScrapReasonFields({
  idPrefix,
  reasons,
  reasonId,
  text,
  onReasonId,
  onText,
  required = true,
}: {
  idPrefix: string;
  // null while loading (the free-text field shows, the API enforces the rule).
  reasons: DeviationReason[] | null;
  reasonId: string;
  text: string;
  onReasonId: (id: string) => void;
  onText: (text: string) => void;
  // False while nothing is scrapped (Pågående arbete shows the fields all the time).
  required?: boolean;
}) {
  if (reasons !== null && reasons.length > 0) {
    return (
      <>
        <Field label="Orsak" htmlFor={`${idPrefix}-reason`}>
          <Select id={`${idPrefix}-reason`} required={required} value={reasonId} onChange={(e) => onReasonId(e.target.value)}>
            <option value="">— Välj orsak —</option>
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} · {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kommentar (valfritt)" htmlFor={`${idPrefix}-comment`}>
          <Input id={`${idPrefix}-comment`} maxLength={500} value={text} onChange={(e) => onText(e.target.value)} />
        </Field>
      </>
    );
  }
  return (
    <Field label="Kassationsorsak" htmlFor={`${idPrefix}-reason`}>
      <Input
        id={`${idPrefix}-reason`}
        required={required}
        placeholder="T.ex. repor, måttfel…"
        value={text}
        onChange={(e) => onText(e.target.value)}
      />
    </Field>
  );
}
