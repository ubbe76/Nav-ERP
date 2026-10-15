"use client";

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { OnboardingView } from "../../lib/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormError } from "../ui/Form";
import { OnboardingChecklist } from "./OnboardingChecklist";

// Översikten's "Kom igång" card for administrators: shown while a step is
// left and the administrator has not hidden it (user setting hideOnboarding).
export function OnboardingCard({ initial }: { initial: OnboardingView }) {
  const [view, setView] = useState(initial);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function hide() {
    const ok = await confirmDialog("Dölj checklistan? Du hittar den under System → Kom igång.", { confirmLabel: "Dölj checklistan" });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/v1/me/settings", { method: "PATCH", body: JSON.stringify({ hideOnboarding: true }) });
      setHidden(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte dölja checklistan"));
    } finally {
      setBusy(false);
    }
  }

  if (hidden || view.complete) return null;
  return (
    <Card maxWidth="none" style={{ marginBottom: "var(--space-dashboard-grid-gap)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Kom igång</h2>
          <div style={{ color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>
            {view.done} av {view.total} klara — det här behöver göras innan systemet går att använda fullt ut.
          </div>
        </div>
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
          <Link href="/system/kom-igang">Öppna Kom igång</Link>
          <Button variant="secondary" size="small" onClick={hide} disabled={busy}>
            Dölj checklistan
          </Button>
        </div>
      </div>
      <FormError>{error}</FormError>
      <OnboardingChecklist view={view} onChange={setView} />
    </Card>
  );
}
