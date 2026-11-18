"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Checkbox, Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { matchesRecipient, type MessageRecipients } from "../../lib/messages";
import styles from "./Messages.module.css";

// The recipient selection shared by Nytt meddelande and Lägg till deltagare:
// users, terminals and employees — searchable, several at once.
export type RecipientGroup = "users" | "terminals" | "employees";
export interface RecipientOption {
  key: string;
  group: RecipientGroup;
  id: string;
  label: string;
}

const GROUP_LABELS: Record<RecipientGroup, string> = { users: "Användare", terminals: "Terminaler", employees: "Anställda" };
const GROUPS: RecipientGroup[] = ["users", "terminals", "employees"];

function optionsOf(recipients: MessageRecipients): RecipientOption[] {
  return [
    ...recipients.users.map((u) => ({ key: `users:${u.id}`, group: "users" as const, id: u.id, label: u.name })),
    ...recipients.terminals.map((u) => ({ key: `terminals:${u.id}`, group: "terminals" as const, id: u.id, label: u.name })),
    ...recipients.employees.map((e) => ({
      key: `employees:${e.id}`,
      group: "employees" as const,
      id: e.id,
      label: `${e.employeeNumber} ${e.name}`,
    })),
  ];
}

// Reads the selection once per mount (the dialogs mount when they open) and
// keeps what is chosen. `narrow` drops recipients (Lägg till deltagare: those
// already in the conversation).
export function useRecipientSelection(narrow?: (all: MessageRecipients) => MessageRecipients) {
  const [all, setAll] = useState<MessageRecipients | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<MessageRecipients>("/api/v1/messages/recipients")
      .then((res) => {
        if (!cancelled) setAll(res);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(apiErrorMessage(err, "Kunde inte läsa mottagarna"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => (all ? optionsOf(narrow ? narrow(all) : all) : null), [all, narrow]);
  const byKey = useMemo(() => new Map((options ?? []).map((o) => [o.key, o])), [options]);
  const chosen = selected.map((key) => byKey.get(key)).filter((o): o is RecipientOption => o !== undefined);

  function toggle(key: string) {
    setSelected((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  }

  return {
    options,
    loadError,
    selected,
    chosen,
    toggle,
    hasTerminal: chosen.some((o) => o.group === "terminals"),
    hasEmployee: chosen.some((o) => o.group === "employees"),
    // The API's two lists: users AND terminals travel as recipientUserIds.
    payload: {
      recipientUserIds: chosen.filter((o) => o.group !== "employees").map((o) => o.id),
      recipientEmployeeIds: chosen.filter((o) => o.group === "employees").map((o) => o.id),
    },
  };
}

export function RecipientPicker({
  label,
  inputId,
  selection,
  emptyText = "Det finns ingen att skriva till.",
}: {
  label: string;
  inputId: string;
  selection: ReturnType<typeof useRecipientSelection>;
  emptyText?: string;
}) {
  const { options, loadError, selected, chosen, toggle } = selection;
  const [search, setSearch] = useState("");
  const visible = (options ?? []).filter((o) => matchesRecipient(o.label, search));

  return (
    <Field label={label} htmlFor={inputId}>
      {chosen.length > 0 && (
        <div className={styles.chips}>
          {chosen.map((o) => (
            <span key={o.key} className={styles.chip}>
              {o.label}
              <button type="button" className={styles.chipRemove} aria-label={`Ta bort ${o.label}`} onClick={() => toggle(o.key)}>
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        id={inputId}
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        // Enter in the search must not send the half-written form.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        placeholder="Sök användare, terminal eller anställd…"
        autoComplete="off"
      />
      <div className={styles.recipientList} role="group" aria-label={`${label} att välja`}>
        {loadError ? (
          <div className={styles.empty}>{loadError}</div>
        ) : options === null ? (
          <div className={styles.empty}>Hämtar mottagare…</div>
        ) : visible.length === 0 ? (
          <div className={styles.empty}>{options.length === 0 ? emptyText : "Ingen träff."}</div>
        ) : (
          GROUPS.map((group) => {
            const rows = visible.filter((o) => o.group === group);
            if (rows.length === 0) return null;
            return (
              <div key={group}>
                <div className={styles.recipientGroup}>{GROUP_LABELS[group]}</div>
                {rows.map((o) => (
                  <label key={o.key} className={styles.recipientOption}>
                    <Checkbox checked={selected.includes(o.key)} onChange={() => toggle(o.key)} />
                    {o.label}
                  </label>
                ))}
              </div>
            );
          })
        )}
      </div>
    </Field>
  );
}
