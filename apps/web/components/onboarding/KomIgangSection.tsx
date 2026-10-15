"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { OnboardingView } from "../../lib/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormError, FormHint, FormStack } from "../ui/Form";
import { OnboardingChecklist } from "./OnboardingChecklist";

export function KomIgangSection({ initial, initiallyHidden }: { initial: OnboardingView; initiallyHidden: boolean }) {
  const [view, setView] = useState(initial);
  const [hidden, setHidden] = useState(initiallyHidden);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function setHide(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/v1/me/settings", { method: "PATCH", body: JSON.stringify({ hideOnboarding: next }) });
      setHidden(next);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara valet"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card maxWidth="none">
      <FormStack>
        <p style={{ margin: 0 }}>
          {view.done} av {view.total} klara.{" "}
          {view.complete
            ? "Allt är klart — checklistan visas inte längre på Översikten."
            : hidden
              ? "Checklistan är dold på din Översikt."
              : "Checklistan visas på Översikten tills allt är klart."}
        </p>
        <FormError>{error}</FormError>
        <OnboardingChecklist view={view} onChange={setView} />
        {!view.complete && (
          <div>
            {hidden ? (
              <Button variant="secondary" onClick={() => setHide(false)} disabled={busy}>Visa på Översikten</Button>
            ) : (
              <Button variant="secondary" onClick={() => setHide(true)} disabled={busy}>Dölj på Översikten</Button>
            )}
          </div>
        )}
        <FormHint>Stegen bockas av av sig själva när uppgifterna finns i systemet — utom nummerserierna, som du markerar som granskade.</FormHint>
      </FormStack>
    </Card>
  );
}
