"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormSaved } from "../ui/Form";

// Byt lösenord: POST /me/password. The new password ends every other session
// of the account (other computers and phones are logged out); this one gets a
// fresh cookie and stays logged in.
export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (next.length < 8) {
      setError("Det nya lösenordet måste ha minst 8 tecken.");
      return;
    }
    if (next !== repeat) {
      setError("De två nya lösenorden är inte lika.");
      return;
    }
    setPending(true);
    try {
      await apiFetch("/api/v1/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      setCurrent("");
      setNext("");
      setRepeat("");
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Lösenordet kunde inte bytas"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Nuvarande lösenord" htmlFor="password-current">
        <Input
          id="password-current"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="Nytt lösenord" htmlFor="password-new">
        <Input
          id="password-new"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={255}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <FormHint attached>Minst 8 tecken.</FormHint>
      <Field label="Upprepa nytt lösenord" htmlFor="password-repeat">
        <Input
          id="password-repeat"
          type="password"
          autoComplete="new-password"
          required
          maxLength={255}
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </Field>
      <FormHint>
        Efter bytet loggas du ut på andra datorer och telefoner, men inte här. Har du glömt ditt lösenord kan en
        administratör sätta ett nytt under System → Användare.
      </FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Byter…" : "Byt lösenord"}
        </Button>
        {saved && <FormSaved>Lösenordet är bytt.</FormSaved>}
      </FormActions>
    </Form>
  );
}
