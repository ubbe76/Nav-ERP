"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { AdminUser, PermissionGroup, UserRole } from "../../lib/types";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";

// Creates a user, or edits one when `user` is passed. On edit the password
// field is optional — left empty it keeps the current password. `currentUserId`
// (the logged-in admin) hides the "Ta bort användare" button for the own
// account — the API rejects self-deletion anyway (409), but hiding it avoids
// a doomed round trip.
export function UserForm({
  user,
  groups,
  currentUserId,
  onSuccess,
}: {
  user?: AdminUser;
  groups: PermissionGroup[];
  currentUserId?: string;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<UserRole>(user?.role ?? "user");
  const [active, setActive] = useState(user?.active ?? true);
  const [readOnly, setReadOnly] = useState(user?.readOnly ?? false);
  const defaultGroupId = user ? (user.permissionGroupId ?? "") : (groups.find((g) => g.code === "ALLA")?.id ?? "");
  const [permissionGroupId, setPermissionGroupId] = useState(defaultGroupId);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    // Endast läsning never goes with Administratör (the API refuses it), so
    // choosing that role clears the box.
    const readOnlyValue = role !== "admin" && readOnly;
    try {
      if (user) {
        await apiFetch(`/api/v1/auth/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            email,
            role,
            active,
            permissionGroupId: permissionGroupId || null,
            readOnly: readOnlyValue,
            ...(password ? { password } : {}),
          }),
        });
      } else {
        await apiFetch("/api/v1/auth/users", {
          method: "POST",
          body: JSON.stringify({ name, email, role, password, permissionGroupId: permissionGroupId || null, readOnly: readOnlyValue }),
        });
      }
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara användaren"));
      setPending(false);
    }
  }

  async function handleDelete() {
    if (!user) return;
    if (
      !(await confirmDelete(
        `Ta bort användaren ${user.name}? Kontot försvinner ur listan och kan inte logga in, men historiken (ordrar, verifikat m.m.) behåller sin signatur.`
      ))
    ) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/auth/users/${user.id}`, { method: "DELETE" });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort användaren"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Namn" htmlFor="user-name">
        <Input id="user-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="E-post" htmlFor="user-email">
        <Input id="user-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>

      <Field label="Roll" htmlFor="user-role">
        <Select id="user-role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
          <option value="user">Användare</option>
          <option value="supervisor">Arbetsledare</option>
          <option value="admin">Administratör</option>
        </Select>
      </Field>

      {role !== "admin" && (
        <>
          <Field label="Behörighetsgrupp" htmlFor="user-group">
            <Select id="user-group" value={permissionGroupId} onChange={(e) => setPermissionGroupId(e.target.value)}>
              <option value="">— Ingen åtkomst —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code} — {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <FormHint attached>Styr vilka menyer användaren når. Administratörer har alltid tillgång till allt.</FormHint>

          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Checkbox id="user-read-only" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            <span>Endast läsning</span>
          </label>
          <FormHint attached>Kan öppna allt som behörighetsgruppen ger, men inte ändra något. För demokonton och revisorer.</FormHint>
        </>
      )}

      <Field label={user ? "Nytt lösenord" : "Lösenord"} htmlFor="user-password">
        <Input
          id="user-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required={!user}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <FormHint attached>{user ? "Lämna tomt för att behålla nuvarande lösenord." : "Minst 8 tecken."}</FormHint>

      {user && (
        <Field label="Status" htmlFor="user-active">
          <Select
            id="user-active"
            value={active ? "active" : "inactive"}
            onChange={(e) => setActive(e.target.value === "active")}
          >
            <option value="active">Aktiv</option>
            <option value="inactive">Avstängd</option>
          </Select>
        </Field>
      )}

      <FormActions style={{ justifyContent: user && user.id !== currentUserId ? "space-between" : "flex-end" }}>
        {user && user.id !== currentUserId && (
          <Button type="button" variant="danger" disabled={pending} onClick={handleDelete}>
            Ta bort användare
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : user ? "Spara användare" : "Skapa användare"}
        </Button>
      </FormActions>
    </Form>
  );
}
