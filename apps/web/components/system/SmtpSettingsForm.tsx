"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { SystemSettings } from "../../lib/types";
import cardStyles from "./SettingsForm.module.css";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";

// SMTP settings for outgoing document email (förfrågan/inköpsorder/offert/
// orderbekräftelse). The stored password is never shown — leaving the field
// blank keeps it.
export function SmtpSettingsForm({ settings }: { settings: SystemSettings }) {
  const [host, setHost] = useState(settings.smtpHost);
  const [port, setPort] = useState(String(settings.smtpPort));
  const [secure, setSecure] = useState(settings.smtpSecure);
  const [user, setUser] = useState(settings.smtpUser);
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(settings.smtpFromName);
  const [fromEmail, setFromEmail] = useState(settings.smtpFromEmail);
  const [passwordSet, setPasswordSet] = useState(settings.smtpPasswordSet);

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testPending, setTestPending] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError("Porten måste vara ett heltal 1–65535");
      return;
    }
    setPending(true);
    try {
      const updated = await apiFetch<SystemSettings>("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({
          smtpHost: host,
          smtpPort: portNumber,
          smtpSecure: secure,
          smtpUser: user,
          // Blank keeps the stored password.
          smtpPassword: password,
          smtpFromName: fromName,
          smtpFromEmail: fromEmail,
        }),
      });
      setPasswordSet(updated.smtpPasswordSet);
      setPassword("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara inställningarna");
    } finally {
      setPending(false);
    }
  }

  async function sendTest() {
    setTestResult(null);
    setTestPending(true);
    try {
      await apiFetch("/api/v1/mail/test", { method: "POST", body: JSON.stringify({ to: testTo }) });
      setTestResult({ ok: true, text: `Testmejl skickat till ${testTo}` });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : "Testmejlet kunde inte skickas" });
    } finally {
      setTestPending(false);
    }
  }

  return (
    <div className={cardStyles.card} style={{ marginTop: 18 }}>
      <Form onSubmit={handleSave}>
        <div>
          <div className={cardStyles.label}>E-post (SMTP)</div>
          <div className={cardStyles.description}>
            Extern SMTP-server för utgående e-post — förfrågningar, inköpsordrar, offerter och orderbekräftelser
            skickas som PDF-bilagor. Lösenordet visas aldrig; lämna fältet tomt för att behålla det sparade.
          </div>
        </div>
        <FormError>{error}</FormError>

        <FormRow>
          <Field label="Server (host)" htmlFor="smtpHost">
            <Input id="smtpHost" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
          </Field>
          <Field label="Port" htmlFor="smtpPort">
            <Input id="smtpPort" type="number" min={1} max={65535} size="xs" value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
          <Field label="Anslutning" htmlFor="smtpSecure">
            <Select id="smtpSecure" value={secure ? "ssl" : "starttls"} onChange={(e) => setSecure(e.target.value === "ssl")}>
              <option value="starttls">STARTTLS (port 587)</option>
              <option value="ssl">SSL/TLS (port 465)</option>
            </Select>
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Användarnamn" htmlFor="smtpUser">
            <Input id="smtpUser" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Lösenord" htmlFor="smtpPassword">
            <Input
              id="smtpPassword"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={passwordSet ? "•••••••• (sparat)" : ""}
              autoComplete="new-password"
            />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Avsändarnamn" htmlFor="smtpFromName">
            <Input id="smtpFromName" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Företaget AB" />
          </Field>
          <Field label="Avsändaradress" htmlFor="smtpFromEmail">
            <Input
              id="smtpFromEmail"
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="order@example.com"
            />
          </Field>
        </FormRow>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <span className={cardStyles.saved}>Sparat</span>}
        </FormActions>
      </Form>

      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--color-border)" }}>
        <div className={cardStyles.description} style={{ marginBottom: 8 }}>
          Skicka ett testmejl för att kontrollera inställningarna (spara först).
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Input
            aria-label="Mottagare för testmejl"
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="din@adress.se"
            style={{ maxWidth: 280 }}
          />
          <Button type="button" variant="secondary" disabled={testPending || testTo.trim() === ""} onClick={sendTest}>
            {testPending ? "Skickar…" : "Skicka testmejl"}
          </Button>
          {testResult &&
            (testResult.ok ? (
              <span className={cardStyles.saved}>{testResult.text}</span>
            ) : (
              <FormError inline>{testResult.text}</FormError>
            ))}
        </div>
      </div>
    </div>
  );
}
