"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { UnitSelect, convertQuantityInput, useUnitOptions } from "../ui/UnitSelect";
import { toBaseQuantity } from "../../lib/units";
import { apiFetch } from "../../lib/api";
import type { Article, StockLocation } from "../../lib/types";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";

export function NewAdjustmentForm({ locations }: { locations: StockLocation[] }) {
  const router = useRouter();
  const [article, setArticle] = useState<Article | null>(null);
  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  const [quantityDelta, setQuantityDelta] = useState("0");
  const [unitId, setUnitId] = useState(""); // "" = artikelns grundenhet
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const baseUnitCode = article?.unit ?? "";
  // Entered in the chosen unit, booked in the base unit — the ledger is
  // always in the article's base unit.
  const baseDelta = toBaseQuantity(Number(quantityDelta) || 0, currentFactor);

  if (locations.length === 0) {
    return (
      <Card>
        <p>Det behövs minst en lagerplats innan du kan göra en justering.</p>
      </Card>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!article) {
      setError("Välj en artikel");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/stock/transactions", {
        method: "POST",
        body: JSON.stringify({
          articleId: article.id,
          locationId: locationId || undefined,
          quantityDelta: baseDelta,
          transactionType: "inventory_adjustment",
          note: note || undefined,
        }),
      });
      router.push("/lager/transaktioner");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte registrera justeringen");
      setPending(false);
    }
  }

  return (
    <Card>
      <Form onSubmit={handleSubmit}>
        <FormError>{error}</FormError>

        <Field label="Artikel" htmlFor="articleId">
          <ArticlePicker
            id="articleId"
            value={article}
            onChange={(a) => {
              setArticle(a);
              setUnitId("");
            }}
          />
        </Field>

        <Field label="Lagerplats" htmlFor="locationId">
          <Select id="locationId" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Artikelns lagerplats</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.warehouseName} — {l.name}
              </option>
            ))}
          </Select>
        </Field>

        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Justering" htmlFor="quantityDelta">
            <Input
              id="quantityDelta"
              type="number"
              step="any"
              required
              size="sm"
              value={quantityDelta}
              onChange={(e) => setQuantityDelta(e.target.value)}
            />
          </Field>
          {/* Only shown when the article has alternative units. */}
          {unitOptions.length > 1 && (
            <Field label="Enhet" htmlFor="adjustmentUnit">
              <UnitSelect
                id="adjustmentUnit"
                options={unitOptions}
                value={unitId}
                onChange={(option) => {
                  setQuantityDelta((q) => convertQuantityInput(q, currentFactor, option.factor));
                  setUnitId(option.value);
                }}
              />
            </Field>
          )}
        </div>
        <FormHint attached>
          Positivt tal ökar saldot, negativt minskar det.
          {unitId !== "" && ` Bokförs som ${baseDelta} ${baseUnitCode} — saldot räknas alltid i grundenheten.`}
        </FormHint>

        <Field label="Anteckning (valfritt)" htmlFor="note">
          <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Registrerar…" : "Registrera justering"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}
