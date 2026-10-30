"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { StockLocation } from "../../lib/types";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";

export function NewStockCountForm({ locations, initialLocationId }: { locations: StockLocation[]; initialLocationId?: string }) {
  const router = useRouter();
  const [locationId, setLocationId] = useState(initialLocationId ?? "");
  const [blocksTransactions, setBlocksTransactions] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (locations.length === 0) {
    return (
      <Card>
        <p>Det behövs minst en lagerplats innan du kan skapa en inventering.</p>
      </Card>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!locationId) {
      setError("Välj en lagerplats");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const session = await apiFetch<{ id: string }>("/api/v1/stock-counts", {
        method: "POST",
        body: JSON.stringify({
          locationId,
          blocksTransactions,
          note: note || undefined,
        }),
      });
      router.push(`/lager/inventering/${session.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa inventeringen");
      setPending(false);
    }
  }

  return (
    <Card>
      <Form onSubmit={handleSubmit}>
        <FormError>{error}</FormError>

        <Field label="Lagerplats" htmlFor="countLocation">
          <Select id="countLocation" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Välj lagerplats…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.warehouseName} — {l.name}
              </option>
            ))}
          </Select>
        </Field>

        {/* Checkbox (ui/Field.tsx) has no `label` prop — it's a bare styled
            <input type="checkbox">, so the visible text is a sibling inside
            a wrapping <label>, same pattern as LocationsSection.tsx. */}
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-body)", fontSize: 13 }}>
          <Checkbox
            id="countBlocks"
            checked={blocksTransactions}
            onChange={(e) => setBlocksTransactions(e.target.checked)}
          />
          Spärra lagertransaktioner under inventeringen
        </label>
        <FormHint attached>
          Med spärr avvisas alla lagerrörelser på platsen tills inventeringen registreras eller avbryts.
          Utan spärr tillåts rörelser men berörda rader varningsflaggas.
        </FormHint>

        <Field label="Anteckning (valfritt)" htmlFor="countNote">
          <Input id="countNote" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Skapar…" : "Skapa inventeringsunderlag"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}
