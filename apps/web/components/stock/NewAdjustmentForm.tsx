"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { UnitSelect, convertQuantityInput, useUnitOptions } from "../ui/UnitSelect";
import { toBaseQuantity } from "../../lib/units";
import { locationOptionLabel } from "../../lib/stockLocations";
import { apiFetch } from "../../lib/api";
import { BatchSelect, useBatchBalances } from "./BatchSelect";
import { BATCH_AUTO, batchIdField } from "../../lib/batch";
import { SerialCellPicker } from "./SerialNumbers";
import type { Article, ArticleBatchBalances, StockLocation } from "../../lib/types";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiErrorMessage } from "../../lib/errorMessages";

export function NewAdjustmentForm({ locations }: { locations: StockLocation[] }) {
  const router = useRouter();
  const [article, setArticle] = useState<Article | null>(null);
  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  const [quantityDelta, setQuantityDelta] = useState("0");
  const [unitId, setUnitId] = useState(""); // "" = artikelns grundenhet
  const [note, setNote] = useState("");
  // Batch (#8): a positive adjustment names the batch (empty = Okänd), a
  // negative one picks which batch to take from.
  const [batchInfo, setBatchInfo] = useState<ArticleBatchBalances | null>(null);
  const [batchNumber, setBatchNumber] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [batchChoice, setBatchChoice] = useState(BATCH_AUTO);
  // Serienummer (#8 etapp 2): an increase names ONE number (Serienummer), a
  // decrease picks the numbers to take (serialIds; none = the place's oldest).
  const [serialNumber, setSerialNumber] = useState("");
  const [serialIds, setSerialIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const baseUnitCode = article?.unit ?? "";
  // Entered in the chosen unit, booked in the base unit — the ledger is
  // always in the article's base unit.
  const baseDelta = toBaseQuantity(Number(quantityDelta) || 0, currentFactor);

  useEffect(() => {
    setBatchInfo(null);
    setBatchNumber("");
    setExpiresOn("");
    setBatchChoice(BATCH_AUTO);
    setSerialNumber("");
    setSerialIds([]);
    if (!article) return;
    let cancelled = false;
    apiFetch<ArticleBatchBalances>(`/api/v1/articles/${article.id}/batch-balances`)
      .then((r) => {
        if (!cancelled) setBatchInfo(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [article]);
  const batchTracked = Boolean(batchInfo?.batchTracked);
  const serialStock = article?.tracking === "serial" && (article.serialAssignedAt ?? "receipt") === "receipt";
  const { rows: batchRows } = useBatchBalances((batchTracked || serialStock) && article ? [article.id] : []);

  // A negative adjustment takes goods from a place: with "Artikelns lagerplats"
  // the API resolves the place by the inflow rule, which may not be where the
  // stock lies — so the place must be chosen.
  const needsLocation = baseDelta < 0 && locationId === "";

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
    if (needsLocation) {
      setError("Välj vilken lagerplats varorna tas från");
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
          ...(batchTracked && baseDelta > 0 && batchNumber.trim()
            ? { batchNumber: batchNumber.trim(), ...(expiresOn ? { expiresOn } : {}) }
            : {}),
          ...(batchTracked && baseDelta < 0 ? batchIdField(batchChoice) : {}),
          ...(serialStock && baseDelta > 0 && serialNumber.trim() ? { batchNumber: serialNumber.trim() } : {}),
          ...(serialStock && baseDelta < 0 && serialIds.length > 0 ? { serialIds } : {}),
          transactionType: "inventory_adjustment",
          note: note || undefined,
        }),
      });
      router.push("/lager/transaktioner");
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte registrera justeringen"));
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
                {locationOptionLabel(l)}
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
          {needsLocation && " Välj vilken lagerplats varorna tas från."}
          {unitId !== "" && ` Bokförs som ${baseDelta} ${baseUnitCode} — saldot räknas alltid i grundenheten.`}
        </FormHint>

        {article && batchTracked && batchInfo && baseDelta > 0 && (
          <Field label="Batch" htmlFor="adjustmentBatch">
            <Input
              id="adjustmentBatch"
              size="sm"
              placeholder="Okänd"
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
            />
          </Field>
        )}
        {article && batchTracked && batchInfo && baseDelta > 0 && (
          <Field label="Utgångsdatum (valfritt)" htmlFor="adjustmentExpiresOn">
            <Input
              id="adjustmentExpiresOn"
              type="date"
              size="sm"
              value={expiresOn}
              disabled={batchNumber.trim() === ""}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>
        )}
        {article && serialStock && baseDelta > 0 && (
          <Field label="Serienummer" htmlFor="adjustmentSerial">
            <Input
              id="adjustmentSerial"
              size="md"
              placeholder="Skriv eller skanna serienummer"
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
            />
            <FormHint>Ett serienummer och ett styck per justering. Tomt: saldot bokas utan nummer (Okänd).</FormHint>
          </Field>
        )}
        {article && serialStock && baseDelta < 0 && (
          <Field label="Serienummer" htmlFor="adjustmentSerialChoice">
            <SerialCellPicker
              ariaLabel="Serienummer"
              rows={batchRows}
              articleId={article.id}
              locationId={locationId || null}
              value={serialIds}
              onChange={(next) => {
                setSerialIds(next);
                // One styck per number: the decrease follows the picked numbers.
                if (next.length > 0) {
                  setUnitId("");
                  setQuantityDelta(String(-next.length));
                }
              }}
            />
          </Field>
        )}
        {article && batchTracked && batchInfo && baseDelta < 0 && (
          <Field label="Batch" htmlFor="adjustmentBatchChoice">
            <BatchSelect
              id="adjustmentBatchChoice"
              rows={batchRows}
              articleId={article.id}
              locationId={locationId || null}
              value={batchChoice}
              onChange={setBatchChoice}
            />
          </Field>
        )}

        <Field label="Anteckning (valfritt)" htmlFor="note">
          <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending || needsLocation}>
            {pending ? "Registrerar…" : "Registrera justering"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}
