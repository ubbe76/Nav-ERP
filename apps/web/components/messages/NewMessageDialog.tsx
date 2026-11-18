"use client";

import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Textarea } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { RecipientPicker, useRecipientSelection } from "./RecipientPicker";
import { addDaysIso, stockholmToday } from "../../lib/date";
import {
  BOARD_DEFAULT_DAYS,
  BOARD_MAX_DAYS,
  CONVERSATION_SUBJECT_MAX,
  MESSAGE_BODY_MAX,
  type ConversationDetail,
  type ConversationLink,
} from "../../lib/messages";
import styles from "./Messages.module.css";

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
  const selection = useRecipientSelection();
  const { chosen, hasTerminal } = selection;
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attach, setAttach] = useState(pageLink?.document ?? false);
  const today = useMemo(() => stockholmToday(), []);
  const [boardUntil, setBoardUntil] = useState(() => addDaysIso(today, BOARD_DEFAULT_DAYS));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          ...selection.payload,
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
      <RecipientPicker label="Mottagare" inputId="message-recipient-search" selection={selection} />

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
      {selection.hasEmployee && (
        <FormHint>
          En anställd ser meddelandet i stämpelterminalen efter sitt anställningsnummer och kvitterar med OK, läst — eller svarar med Svara.
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
