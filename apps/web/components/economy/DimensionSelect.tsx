"use client";

import type { SelectHTMLAttributes } from "react";
import { Field, Select } from "../ui/Field";
import { FormRow } from "../ui/Form";
import type { CostCenter, Project } from "../../lib/types";

// Pickers for the two accounting dimensions. A selected value that is no
// longer offered (a deactivated cost centre, a closed project) stays in the
// list marked as such, so opening an old document never silently changes it.
// Select value for an explicit "no cost center" — distinct from "" (leave it
// to the server's default), so a form can send null instead of omitting.
export const NO_OBJECT = "__none__";

interface Common extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "children"> {
  value: string;
  onChange: (id: string) => void;
  emptyLabel?: string;
}

export function CostCenterSelect({
  value,
  onChange,
  emptyLabel = "—",
  noneLabel,
  all,
  size,
  ...rest
}: Common & { all: CostCenter[]; size?: "xs" | "sm" | "md"; noneLabel?: string }) {
  const current = value && value !== NO_OBJECT ? all.find((c) => c.id === value) : undefined;
  return (
    <Select size={size} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="">{emptyLabel}</option>
      {noneLabel && <option value={NO_OBJECT}>{noneLabel}</option>}
      {all
        .filter((c) => c.active || c.id === value)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.name}
            {c.active ? "" : " (inaktivt)"}
          </option>
        ))}
      {value && value !== NO_OBJECT && !current && <option value={value}>(okänt kostnadsställe)</option>}
    </Select>
  );
}

export function ProjectSelect({
  value,
  onChange,
  emptyLabel = "—",
  noneLabel,
  all,
  size,
  ...rest
}: Common & { all: Project[]; size?: "xs" | "sm" | "md"; noneLabel?: string }) {
  const current = value && value !== NO_OBJECT ? all.find((p) => p.id === value) : undefined;
  return (
    <Select size={size} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="">{emptyLabel}</option>
      {noneLabel && <option value={NO_OBJECT}>{noneLabel}</option>}
      {all
        .filter((p) => (p.active && p.status === "open") || p.id === value)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
            {p.status === "closed" ? " (stängt)" : p.active ? "" : " (inaktivt)"}
          </option>
        ))}
      {value && value !== NO_OBJECT && !current && <option value={value}>(okänt projekt)</option>}
    </Select>
  );
}

// "Kostnadsställe" + "Projekt" side by side in a document header form. Renders
// nothing until at least one object exists (or the document already carries
// one), so installations that do not use the dimensions see no new fields.
export function DimensionFields({
  idPrefix,
  lists,
  costCenterId,
  projectId,
  onCostCenterChange,
  onProjectChange,
  withCostCenter = true,
  costCenterLabel = "Kostnadsställe",
  projectLabel = "Projekt",
}: {
  idPrefix: string;
  lists: { allCostCenters: CostCenter[]; allProjects: Project[] };
  costCenterId: string;
  projectId: string;
  onCostCenterChange: (id: string) => void;
  onProjectChange: (id: string) => void;
  withCostCenter?: boolean;
  costCenterLabel?: string;
  projectLabel?: string;
}) {
  const visible =
    (withCostCenter && (lists.allCostCenters.length > 0 || costCenterId !== "")) ||
    lists.allProjects.length > 0 ||
    projectId !== "";
  if (!visible) return null;
  return (
    <FormRow>
      {withCostCenter && (
        <Field label={costCenterLabel} htmlFor={`${idPrefix}CostCenter`}>
          <CostCenterSelect id={`${idPrefix}CostCenter`} all={lists.allCostCenters} value={costCenterId} onChange={onCostCenterChange} />
        </Field>
      )}
      <Field label={projectLabel} htmlFor={`${idPrefix}Project`}>
        <ProjectSelect id={`${idPrefix}Project`} all={lists.allProjects} value={projectId} onChange={onProjectChange} />
      </Field>
    </FormRow>
  );
}
