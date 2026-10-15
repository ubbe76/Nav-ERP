"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  MENU_PERMISSIONS,
  PERMISSION_IMPLIES,
  PERMISSION_LABELS,
  WORKSHOP_PERMISSIONS,
  type Permission,
} from "../../lib/permissions";
import type { PermissionGroup } from "../../lib/types";

// A permission implied by a checked menu (Tillverkning => Stämpelterminal,
// Tillverkningsorder (läsläge); Artiklar => Artikelöversikt) shows checked and
// locked — it's granted anyway, and storing it twice would only confuse.
function impliedBy(selected: ReadonlySet<Permission>, p: Permission): Permission | null {
  for (const parent of selected) if (PERMISSION_IMPLIES[parent]?.includes(p)) return parent;
  return null;
}

export function PermissionGroupForm({
  group,
  allGroups,
  onSuccess,
}: {
  group?: PermissionGroup;
  allGroups: PermissionGroup[];
  onSuccess: () => void;
}) {
  const [code, setCode] = useState(group?.code ?? "");
  const [name, setName] = useState(group?.name ?? "");
  const [selected, setSelected] = useState<Set<Permission>>(new Set(group?.permissions ?? []));
  const [replacementId, setReplacementId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function toggle(p: Permission, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(p);
    else next.delete(p);
    // Drop children that just became implied, so they aren't stored twice.
    if (on) for (const child of PERMISSION_IMPLIES[p] ?? []) next.delete(child);
    setSelected(next);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const body = JSON.stringify({ code, name, permissions: [...selected] });
    try {
      if (group) await apiFetch(`/api/v1/permission-groups/${group.id}`, { method: "PATCH", body });
      else await apiFetch("/api/v1/permission-groups", { method: "POST", body });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara behörighetsgruppen"));
      setPending(false);
    }
  }

  async function handleDelete() {
    if (!group) return;
    if (group.userCount > 0 && !replacementId) {
      setError(`Gruppen används av ${group.userCount} användare — välj en grupp att flytta dem till.`);
      return;
    }
    if (!(await confirmDelete(`Ta bort behörighetsgruppen ${group.code}?`))) return;
    setError(null);
    setPending(true);
    const query = replacementId ? `?replacementId=${replacementId}` : "";
    try {
      await apiFetch(`/api/v1/permission-groups/${group.id}${query}`, { method: "DELETE" });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort behörighetsgruppen"));
      setPending(false);
    }
  }

  function renderBox(p: Permission) {
    const parent = impliedBy(selected, p);
    return (
      <label key={p} style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-body)", fontSize: 13 }}>
        <Checkbox checked={parent !== null || selected.has(p)} disabled={parent !== null} onChange={(e) => toggle(p, e.target.checked)} />
        {parent ? `${PERMISSION_LABELS[p]} (ingår i ${PERMISSION_LABELS[parent]})` : PERMISSION_LABELS[p]}
      </label>
    );
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>
      <Field label="Kod" htmlFor="pg-code">
        <Input id="pg-code" required maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="Namn" htmlFor="pg-name">
        <Input id="pg-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <SectionHeading>Menyer</SectionHeading>
      {MENU_PERMISSIONS.map(renderBox)}
      <FormHint attached>En meny ger rätt att ändra i modulen. Läsa i andra modulers register får alla med minst en meny.</FormHint>

      <SectionHeading spaced>Verkstad</SectionHeading>
      {WORKSHOP_PERMISSIONS.map(renderBox)}

      {group && group.userCount > 0 && (
        <Field label="Flytta användarna till (vid borttagning)" htmlFor="pg-replacement">
          <Select id="pg-replacement" value={replacementId} onChange={(e) => setReplacementId(e.target.value)}>
            <option value="">— Välj grupp —</option>
            {allGroups
              .filter((g) => g.id !== group.id)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code} — {g.name}
                </option>
              ))}
          </Select>
        </Field>
      )}

      <FormActions style={{ justifyContent: group ? "space-between" : "flex-end" }}>
        {group && (
          <Button type="button" variant="danger" disabled={pending} onClick={handleDelete}>
            Ta bort grupp
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : group ? "Spara grupp" : "Skapa grupp"}
        </Button>
      </FormActions>
    </Form>
  );
}
