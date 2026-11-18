"use client";

import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { addDaysIso, stockholmToday } from "../../lib/date";
import {
  BOARD_DEFAULT_DAYS,
  BOARD_MAX_DAYS,
  recipientsToAdd,
  type ConversationDetail,
  type MessageRecipients,
} from "../../lib/messages";
import { RecipientPicker, useRecipientSelection } from "./RecipientPicker";

// Lägg till deltagare: the same selection and rules as the recipients of a
// new conversation, without those already in it. A terminal asks for the day
// the anslagstavla shows the conversation through.
export function AddParticipantsDialog({
  open,
  onClose,
  conversation,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  conversation: ConversationDetail;
  onAdded: (conversation: ConversationDetail) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Lägg till deltagare">
      <AddParticipantsForm onClose={onClose} conversation={conversation} onAdded={onAdded} />
    </Modal>
  );
}

// Mounted only while the dialog is open, so every opening reads the
// selection afresh.
function AddParticipantsForm({
  onClose,
  conversation,
  onAdded,
}: {
  onClose: () => void;
  conversation: ConversationDetail;
  onAdded: (conversation: ConversationDetail) => void;
}) {
  const participants = conversation.participants;
  const narrow = useCallback((all: MessageRecipients) => recipientsToAdd(all, participants), [participants]);
  const selection = useRecipientSelection(narrow);
  const today = useMemo(() => stockholmToday(), []);
  const [boardUntil, setBoardUntil] = useState(() => addDaysIso(today, BOARD_DEFAULT_DAYS));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    if (selection.chosen.length === 0) return setError("Välj minst en deltagare.");
    setSaving(true);
    try {
      const updated = await apiFetch<ConversationDetail>(`/api/v1/conversations/${conversation.id}/participants`, {
        method: "POST",
        body: JSON.stringify({ ...selection.payload, ...(selection.hasTerminal ? { boardUntil } : {}) }),
      });
      onAdded(updated);
    } catch (err) {
      setError(apiErrorMessage(err, "Deltagarna kunde inte läggas till"));
      setSaving(false);
    }
  }

  return (
    <Form onSubmit={onSubmit}>
      <RecipientPicker
        label="Nya deltagare"
        inputId="message-add-participant-search"
        selection={selection}
        emptyText="Alla som går att skriva till är redan med."
      />
      {selection.hasTerminal && (
        <>
          <Field label="Visas på terminalen t.o.m." htmlFor="message-add-board-until">
            <Input
              id="message-add-board-until"
              type="date"
              size="md"
              value={boardUntil}
              min={today}
              max={addDaysIso(today, BOARD_MAX_DAYS)}
              onChange={(e) => setBoardUntil(e.target.value)}
              required
            />
          </Field>
          <FormHint attached>Konversationen står överst på stämpelterminalen för alla, till och med den dagen.</FormHint>
        </>
      )}
      <FormHint>Den som läggs till ser hela konversationen, också det som redan är skrivet.</FormHint>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Lägger till…" : "Lägg till"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
