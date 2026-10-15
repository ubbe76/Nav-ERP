"use client";

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage, demoBlockersText } from "../../lib/errorMessages";
import type { DemoDataCreated, DemoDataStatus } from "../../lib/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormError, FormHint, FormStack } from "../ui/Form";

export function DemoDataSection({ initial }: { initial: DemoDataStatus }) {
  const [status, setStatus] = useState(initial);
  const [created, setCreated] = useState<DemoDataCreated["created"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    const ok = await confirmDialog(
      "Skapa exempeldata? Artiklar, kunder, leverantörer, resurser och lagersaldon läggs in. De kan inte tas bort automatiskt.",
      { confirmLabel: "Skapa exempeldata" }
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<DemoDataCreated>("/api/v1/demo-data", { method: "POST" });
      setCreated(res.created);
      setStatus({ available: false, blockers: ["articles", "customers", "suppliers", "workCenters"] });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa exempeldata"));
      setStatus(await apiFetch<DemoDataStatus>("/api/v1/demo-data").catch(() => status));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card maxWidth={640}>
      <FormStack>
        <p style={{ margin: 0 }}>
          Exempeldata är ett påhittat företag som tillverkar rostfri storköksinredning — arbetsbord med bänkskiva,
          underrede och hyllplan. Det skapar fem resurser, tre leverantörer med prislistor, fyra kunder, råvaror och
          köpkomponenter med lagersaldo, halvfabrikat och färdiga produkter med struktur, operationer och standardpris.
          Med det kan du prova kundorder, tillverkningsorder, kalkyl, behovsberäkning och inköp direkt.
        </p>
        <FormError>{error}</FormError>
        {created ? (
          <p style={{ margin: 0 }}>
            Klart: {created.articles} artiklar, {created.workCenters} resurser, {created.customers} kunder och{" "}
            {created.suppliers} leverantörer skapades. Börja i <Link href="/artiklar/register">artikelregistret</Link>, bland{" "}
            <Link href="/kunder">kunderna</Link> eller i <Link href="/artiklar/oversikt">artikelöversikten</Link>.
          </p>
        ) : (
          <div>
            <Button variant="primary" onClick={create} disabled={!status.available || busy}>
              {busy ? "Skapar…" : "Skapa exempeldata"}
            </Button>
          </div>
        )}
        {!status.available && !created && !error && (
          <FormHint>
            Exempeldata kan bara skapas på en tom installation — det finns redan {demoBlockersText(status.blockers)}.
          </FormHint>
        )}
        <FormHint>
          Exempeldatan kan inte tas bort automatiskt. Använd den för att prova systemet, inte i en installation som
          ska användas skarpt.
        </FormHint>
      </FormStack>
    </Card>
  );
}
