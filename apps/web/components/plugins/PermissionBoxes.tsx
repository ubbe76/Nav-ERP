"use client";

import { Checkbox } from "../ui/Field";
import { SectionHeading } from "../ui/SectionHeading";
import { FormHint } from "../ui/Form";
import {
  MENU_PERMISSIONS,
  PERMISSION_IMPLIES,
  PERMISSION_LABELS,
  WORKSHOP_PERMISSIONS,
  type Permission,
} from "../../lib/permissions";
import styles from "./Plugins.module.css";

// A permission implied by a checked menu shows checked and locked (the same
// rule as Behörighetsgrupper: Tillverkning => Stämpelterminal etc.).
function impliedBy(selected: ReadonlySet<Permission>, p: Permission): Permission | null {
  for (const parent of selected) if (PERMISSION_IMPLIES[parent]?.includes(p)) return parent;
  return null;
}

// Drops the children a checked parent already implies, so nothing is stored twice.
export function normalizePermissions(list: readonly Permission[]): Permission[] {
  const set = new Set(list);
  for (const p of list) for (const child of PERMISSION_IMPLIES[p] ?? []) set.delete(child);
  return [...set];
}

export function PermissionBoxes({
  value,
  onChange,
  idPrefix,
}: {
  value: ReadonlySet<Permission>;
  onChange: (next: Set<Permission>) => void;
  idPrefix: string;
}) {
  function toggle(p: Permission, on: boolean) {
    const next = new Set(value);
    if (on) {
      next.add(p);
      for (const child of PERMISSION_IMPLIES[p] ?? []) next.delete(child);
    } else {
      next.delete(p);
    }
    onChange(next);
  }

  function renderBox(p: Permission) {
    const parent = impliedBy(value, p);
    return (
      <label key={p} className={styles.check}>
        <Checkbox
          id={`${idPrefix}-${p}`}
          checked={parent !== null || value.has(p)}
          disabled={parent !== null}
          onChange={(e) => toggle(p, e.target.checked)}
        />
        {parent ? `${PERMISSION_LABELS[p]} (ingår i ${PERMISSION_LABELS[parent]})` : PERMISSION_LABELS[p]}
      </label>
    );
  }

  return (
    <div className={styles.body}>
      <SectionHeading>Menyer</SectionHeading>
      <div className={styles.checks}>{MENU_PERMISSIONS.map(renderBox)}</div>
      <FormHint attached>En meny ger tillägget rätt att ändra i modulen. Läsa i andra modulers register får alla med minst en meny.</FormHint>
      <SectionHeading spaced>Verkstad</SectionHeading>
      <div className={styles.checks}>{WORKSHOP_PERMISSIONS.map(renderBox)}</div>
    </div>
  );
}
