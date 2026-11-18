"use client";

import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormError, FormHint, FormSaved } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import styles from "./EmployeeTabs.module.css";

interface TerminalPinStatus {
  pinSet: boolean;
  lockedUntil: string | null;
}

// Terminalkod on the personalkort (Kräv kod i stämpelterminalen): whether the
// employee has chosen a code — never the code — and Nollställ terminalkoden
// for the one who forgot it. The employee then chooses a new code at the
// terminal.
export function EmployeeTerminalPinSection({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const can = useCan();
  const [status, setStatus] = useState<TerminalPinStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<TerminalPinStatus>(`/api/v1/employees/${employeeId}/terminal-pin`)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "Kunde inte läsa terminalkodens status"));
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  async function reset() {
    const ok = await confirmDialog(
      `Nollställa terminalkoden för ${employeeName}? Koden tas bort och en spärr hävs. Nästa gång väljer den anställde en ny kod i stämpelterminalen.`,
      { confirmLabel: "Nollställ", danger: true }
    );
    if (!ok) return;
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      setStatus(await apiFetch<TerminalPinStatus>(`/api/v1/employees/${employeeId}/terminal-pin`, { method: "DELETE" }));
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Koden kunde inte nollställas"));
    } finally {
      setPending(false);
    }
  }

  if (!status && !error) return null;
  const lockedTime = status?.lockedUntil
    ? new Date(status.lockedUntil).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" })
    : null;
  return (
    <Card className={styles.erasureCard}>
      <SectionHeading>Terminalkod</SectionHeading>
      <FormError>{error}</FormError>
      {status && (
        <p className={styles.pinStatus}>
          <strong>{status.pinSet ? "Kod vald" : "Ingen kod"}</strong>
          {lockedTime ? ` — spärrad till kl. ${lockedTime} efter för många felaktiga försök` : ""}
        </p>
      )}
      <FormHint>
        Gäller när Kräv kod i stämpelterminalen är på under System → Inställningar. Den anställde väljer själv sin kod på
        4 siffror i stämpelterminalen; koden visas aldrig här.
      </FormHint>
      {saved && <FormSaved>Koden är nollställd.</FormSaved>}
      {status?.pinSet && can(["personal"]) && (
        <Button type="button" variant="danger" disabled={pending} onClick={() => void reset()}>
          {pending ? "Arbetar…" : "Nollställ terminalkoden"}
        </Button>
      )}
    </Card>
  );
}
