"use client";

import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Textarea } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { addDaysIso, stockholmToday } from "../../lib/date";
import {
  BOARD_DEFAULT_DAYS,
  BOARD_MAX_DAYS,
  CONVERSATION_SUBJECT_MAX,
  MESSAGE_BODY_MAX,
  matchesRecipient,
  type ConversationDetail,
  type ConversationLink,
  type MessageRecipients,
} from "../../lib/messages";
import styles from "./Messages.module.css";

type Group = "users" | "terminals" | "employees";
interface Option {
  key: string;
  group: Group;
  id: string;
  label: string;
}

const GROUP_LABELS: Record<Group, string> = { users: "Användare", terminals: "Terminaler", employees: "Anställda" };
const GROUPS: Group[] = ["users", "terminals", "employees"];

function optionsOf(recipients: MessageRecipients): Option[] {
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

// Nytt meddelande: recipients (users, terminals, employees — searchable,
// several), subject, the message, and — when opened from the envelope on
// another page — Bifoga länk till sidan du står på. A terminal among the
// recipients asks for the day the anslagstavla shows it through.
export function NewMessageDialog({
  open,
  onClose,
  onCreated,
  pageLink,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (conversation: ConversationDetail) => void;
  // The page the dialog was opened on; `document` ticks the box from the start.
  pageLink?: { link: ConversationLink; document: boolean } | null;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Nytt meddelande">
      <NewMessageForm onClose={onClose} onCreated={onCreated} pageLink={pageLink ?? null} />
    </Modal>
  );
}

// Mounted only while the dialog is open (Modal unmounts its children), so
// every opening starts empty and reads the recipients afresh.
function NewMessageForm({
  onClose,
  onCreated,
  pageLink,
}: {
  onClose: () => void;
  onCreated: (conversation: ConversationDetail) => void;
  pageLink: { link: ConversationLink; document: boolean } | null;
}) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attach, setAttach] = useState(pageLink?.document ?? false);
  const today = useMemo(() => stockholmToday(), []);
  const [boardUntil, setBoardUntil] = useState(() => addDaysIso(today, BOARD_DEFAULT_DAYS));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<MessageRecipients>("/api/v1/messages/recipients")
      .then((res) => {
        if (!cancelled) setOptions(optionsOf(res));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(apiErrorMessage(err, "Kunde inte läsa mottagarna"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byKey = useMemo(() => new Map((options ?? []).map((o) => [o.key, o])), [options]);
  const chosen = selected.map((key) => byKey.get(key)).filter((o): o is Option => o !== undefined);
  const visible = (options ?? []).filter((o) => matchesRecipient(o.label, search));
  const hasTerminal = chosen.some((o) => o.group === "terminals");

  function toggle(key: string) {
    setSelected((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  }

  async function send() {
    if (sending) return;
    setError(null);
    if (chosen.length === 0) return setError("Välj minst en mottagare.");
    if (!subject.trim()) return setError("Skriv ett ämne.");
    if (!body.trim()) return setError("Skriv ett meddelande.");
    setSending(true);
    try {
      const created = await apiFetch<ConversationDetail>("/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({
          subject,
          body,
          recipientUserIds: chosen.filter((o) => o.group !== "employees").map((o) => o.id),
          recipientEmployeeIds: chosen.filter((o) => o.group === "employees").map((o) => o.id),
          ...(attach && pageLink ? { link: pageLink.link } : {}),
          ...(hasTerminal ? { boardUntil } : {}),
        }),
      });
      onCreated(created);
    } catch (err) {
      setError(apiErrorMessage(err, "Meddelandet kunde inte skickas"));
      setSending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  // Ctrl/⌘+Enter sends, as in the conversation's reply box.
  function onBodyKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <Form onSubmit={onSubmit}>
      <Field label="Mottagare" htmlFor="message-recipient-search">
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
          id="message-recipient-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          // Enter in the search must not send the half-written message.
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          placeholder="Sök användare, terminal eller anställd…"
          autoComplete="off"
        />
        <div className={styles.recipientList} role="group" aria-label="Mottagare att välja">
          {loadError ? (
            <div className={styles.empty}>{loadError}</div>
          ) : options === null ? (
            <div className={styles.empty}>Hämtar mottagare…</div>
          ) : visible.length === 0 ? (
            <div className={styles.empty}>{options.length === 0 ? "Det finns ingen att skriva till." : "Ingen träff."}</div>
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

      {hasTerminal && (
        <>
          <Field label="Visas på terminalen t.o.m." htmlFor="message-board-until">
            <Input
              id="message-board-until"
              type="date"
              size="md"
              value={boardUntil}
              min={today}
              max={addDaysIso(today, BOARD_MAX_DAYS)}
              onChange={(e) => setBoardUntil(e.target.value)}
              required
            />
          </Field>
          <FormHint attached>
            Meddelandet står överst på stämpelterminalen för alla, till och med den dagen eller tills du tar bort det. Terminalen kan inte svara.
          </FormHint>
        </>
      )}
      {chosen.some((o) => o.group === "employees") && (
        <FormHint>
          En anställd ser meddelandet i stämpelterminalen efter sitt anställningsnummer och kvitterar med OK, läst. Den anställde kan inte svara.
        </FormHint>
      )}

      <Field label="Ämne" htmlFor="message-subject">
        <Input id="message-subject" value={subject} maxLength={CONVERSATION_SUBJECT_MAX} onChange={(e) => setSubject(e.target.value)} required />
      </Field>

      <Field label="Meddelande" htmlFor="message-body">
        <Textarea
          id="message-body"
          rows={6}
          value={body}
          maxLength={MESSAGE_BODY_MAX}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onBodyKeyDown}
          required
        />
      </Field>

      {pageLink && (
        <label className={styles.checkRow}>
          <Checkbox checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          <span className={styles.checkRowText}>
            Bifoga länk till sidan du står på
            <span className={styles.checkRowSub}>{pageLink.link.title}</span>
          </span>
        </label>
      )}

      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" variant="primary" disabled={sending}>
          {sending ? "Skickar…" : "Skicka"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
