"use client";

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { OnboardingView } from "../../lib/types";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import styles from "./OnboardingChecklist.module.css";

// The nine setup steps, shared by Översikten's card and System → Kom igång.
// Every step but the number series ticks itself from the data.
export function OnboardingChecklist({ view, onChange }: { view: OnboardingView; onChange: (next: OnboardingView) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function markReviewed() {
    setBusy(true);
    setError(null);
    try {
      onChange(await apiFetch<OnboardingView>("/api/v1/onboarding/number-series-reviewed", { method: "POST" }));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte markera nummerserierna"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <FormError>{error}</FormError>
      <div className={styles.groups}>
        {view.groups.map((group) => (
          <section key={group.title}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            <ul className={styles.steps}>
              {group.steps.map((step) => (
                <li key={step.key} className={styles.step}>
                  <span className={`${styles.mark} ${step.done ? styles.markDone : ""}`} role="img" aria-label={step.done ? "Klart" : "Kvar"}>
                    {step.done ? "✓" : ""}
                  </span>
                  <div>
                    <div className={`${styles.title} ${step.done ? styles.titleDone : ""}`}>
                      {step.title}
                    </div>
                    {!step.done && <p className={styles.description}>{step.description}</p>}
                    <div className={styles.links}>
                      {step.links.map((link) => (
                        <Link key={link.href} href={link.href}>
                          {link.label}
                        </Link>
                      ))}
                      {step.key === "numberSeries" && !step.done && (
                        <Button variant="secondary" size="small" onClick={markReviewed} disabled={busy}>
                          Markera som granskade
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
