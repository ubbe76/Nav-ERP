"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormError, FormHint } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import type { EmployeeErasurePlan, EmployeeErasureBlocker } from "../../lib/types";
import styles from "./EmployeeTabs.module.css";

// "2026-02" → "februari 2026"
function monthLabel(month: string): string {
  const [year, mm] = month.split("-");
  const name = new Date(Date.UTC(Number(year), Number(mm) - 1, 1)).toLocaleDateString("sv-SE", { month: "long", timeZone: "UTC" });
  return `${name} ${year}`;
}

function blockerText(blocker: EmployeeErasureBlocker): string {
  switch (blocker.code) {
    case "active":
      return "Den anställde är aktiv — stäng av Aktiv och spara först.";
    case "open-session":
      return "Den anställde har en öppen närvaro eller stämpling.";
    case "open-period":
      return `Löneperioden är inte låst för ${blocker.months.map(monthLabel).join(", ")}.`;
  }
}

// Personuppgifter (GDPR, #2) on the personalkort — admin only. The server
// decides: Radera for an employee who never stamped or got paid, Anonymisera
// for one with history, and lists what still blocks it.
export function EmployeeErasureSection({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const router = useRouter();
  const [plan, setPlan] = useState<EmployeeErasurePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<EmployeeErasurePlan>(`/api/v1/employees/${employeeId}/erasure`)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Kunde inte läsa om den anställde kan raderas");
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  async function run() {
    if (!plan || plan.action === "anonymized") return;
    const remove = plan.action === "delete";
    const ok = await confirmDialog(
      remove
        ? `Radera ${employeeName} helt? Det går inte att ångra.`
        : `Anonymisera ${employeeName}? Namn, personnummer, kontaktuppgifter, lön och alla kommentarer tas bort för gott. Tider, frånvaro och låsta löneunderlag finns kvar under anställningsnumret. Det går inte att ångra.`,
      { confirmLabel: remove ? "Radera" : "Anonymisera", danger: true }
    );
    if (!ok) return;
    setError(null);
    setPending(true);
    try {
      if (remove) {
        await apiFetch(`/api/v1/employees/${employeeId}`, { method: "DELETE" });
        router.push("/personal/anstallda");
      } else {
        await apiFetch(`/api/v1/employees/${employeeId}/anonymize`, { method: "POST" });
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Det gick inte");
      setPending(false);
    }
  }

  if (!plan && !error) return null;
  return (
    <Card className={styles.erasureCard}>
      <SectionHeading>Personuppgifter (GDPR)</SectionHeading>
      <FormError>{error}</FormError>
      {plan?.action === "delete" && (
        <FormHint>
          Den anställde har aldrig stämplat, haft frånvaro eller fått lön i Nav och kan raderas helt.
        </FormHint>
      )}
      {plan?.action === "anonymize" && (
        <FormHint>
          Den anställde har tid eller lön i Nav. Anonymisering tar bort namn, personnummer, kontaktuppgifter, lön och alla
          kommentarer. Tider, frånvaro och låsta löneunderlag finns kvar under anställningsnumret, som behålls så att
          underlagen går att stämma av mot lönesystemet.
        </FormHint>
      )}
      {plan && plan.blockers.length > 0 && (
        <ul className={styles.erasureBlockers}>
          {plan.blockers.map((b) => (
            <li key={b.code}>{blockerText(b)}</li>
          ))}
        </ul>
      )}
      {plan && plan.action !== "anonymized" && (
        <Button type="button" variant="danger" disabled={pending || plan.blockers.length > 0} onClick={() => void run()}>
          {pending ? "Arbetar…" : plan.action === "delete" ? "Radera anställd" : "Anonymisera anställd"}
        </Button>
      )}
    </Card>
  );
}
