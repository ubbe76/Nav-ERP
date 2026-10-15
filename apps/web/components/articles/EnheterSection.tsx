"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { ArticleUnit, RegisterEntry } from "../../lib/types";
import styles from "./ArticleForm.module.css";
import { FormError, FormStack } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";

// Alternative units (alternativa enheter) on the article card's Allmänt tab.
// Factor direction: "1 {base unit} = X {alternative unit}" — an article
// stocked in st weighing 5 kg apiece stores 5 on its kg row; the inverse
// (1 kg = 0,2 st) is shown as a live hint.
export function EnheterSection({
  articleId,
  baseUnitCode,
  allUnits,
  articleUnits,
  onChanged,
}: {
  articleId: string;
  baseUnitCode: string;
  allUnits: RegisterEntry[];
  articleUnits: ArticleUnit[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function removeRow(row: ArticleUnit) {
    setError(null);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/units/${row.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort enheten");
    }
  }

  return (
    <div className={styles.block}>
      {/* "Alternativa enheter", not just "Enheter" — the Allmänt tab already
          has an Enheter section for the base/purchase/sales units. */}
      <SectionHeading>Alternativa enheter</SectionHeading>
      <FormStack>
        <FormError>{error}</FormError>

        {articleUnits.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary)" }}>
            Inga alternativa enheter — artikeln hanteras enbart i {baseUnitCode}.
          </p>
        ) : (
          articleUnits.map((row) => (
            <ArticleUnitRow
              key={row.id}
              articleId={articleId}
              baseUnitCode={baseUnitCode}
              row={row}
              onChanged={onChanged}
              onRemove={() => removeRow(row)}
            />
          ))
        )}

        <AddArticleUnitForm
          articleId={articleId}
          baseUnitCode={baseUnitCode}
          allUnits={allUnits}
          articleUnits={articleUnits}
          onChanged={onChanged}
        />
      </FormStack>
    </div>
  );
}

function factorHint(baseUnitCode: string, unitCode: string, factor: string): string | null {
  const n = Number(factor);
  if (!Number.isFinite(n) || n <= 0) return null;
  const inverse = 1 / n;
  const rounded = Math.round(inverse * 10000) / 10000;
  return `1 ${unitCode} = ${rounded.toLocaleString("sv-SE")} ${baseUnitCode}`;
}

function ArticleUnitRow({
  articleId,
  baseUnitCode,
  row,
  onChanged,
  onRemove,
}: {
  articleId: string;
  baseUnitCode: string;
  row: ArticleUnit;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const [factor, setFactor] = useState(String(Number(row.quantityPerBase)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = Number(factor) !== Number(row.quantityPerBase);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/units/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ quantityPerBase: Number(factor) }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save}>
      <FormError>{error}</FormError>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Enhet" htmlFor={`unit-${row.id}`}>
          <Input id={`unit-${row.id}`} value={`${row.unitCode} · ${row.unitName}`} disabled />
        </Field>
        <Field label={`1 ${baseUnitCode} =`} htmlFor={`factor-${row.id}`}>
          <Input
            id={`factor-${row.id}`}
            type="number"
            size="xs"
            min="0"
            step="any"
            required
            value={factor}
            onChange={(e) => setFactor(e.target.value)}
          />
        </Field>
        <span style={{ paddingBottom: 10, fontSize: 13 }}>{row.unitCode}</span>
        <span style={{ paddingBottom: 10, fontSize: 13, color: "var(--color-text-secondary)" }}>
          {factorHint(baseUnitCode, row.unitCode, factor)}
        </span>
        {dirty && (
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onRemove}>
          Ta bort
        </Button>
      </div>
    </form>
  );
}

function AddArticleUnitForm({
  articleId,
  baseUnitCode,
  allUnits,
  articleUnits,
  onChanged,
}: {
  articleId: string;
  baseUnitCode: string;
  allUnits: RegisterEntry[];
  articleUnits: ArticleUnit[];
  onChanged: () => void;
}) {
  const [unitId, setUnitId] = useState("");
  const [factor, setFactor] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The base unit and already-added units can't be added again.
  const usedUnitIds = new Set(articleUnits.map((u) => u.unitId));
  const selectable = allUnits.filter((u) => u.code !== baseUnitCode && !usedUnitIds.has(u.id));
  const selectedCode = allUnits.find((u) => u.id === unitId)?.code ?? "enhet";

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/units`, {
        method: "POST",
        body: JSON.stringify({ unitId, quantityPerBase: Number(factor) }),
      });
      setUnitId("");
      setFactor("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte lägga till enheten");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={add}>
      <FormError>{error}</FormError>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Lägg till enhet" htmlFor="newArticleUnit">
          <Select id="newArticleUnit" required value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">Välj enhet…</option>
            {selectable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.code} · {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`1 ${baseUnitCode} =`} htmlFor="newArticleUnitFactor">
          <Input
            id="newArticleUnitFactor"
            type="number"
            size="xs"
            min="0"
            step="any"
            required
            value={factor}
            onChange={(e) => setFactor(e.target.value)}
          />
        </Field>
        <span style={{ paddingBottom: 10, fontSize: 13 }}>{selectedCode}</span>
        <span style={{ paddingBottom: 10, fontSize: 13, color: "var(--color-text-secondary)" }}>
          {unitId && factor ? factorHint(baseUnitCode, selectedCode, factor) : null}
        </span>
        <Button type="submit" variant="secondary" disabled={pending || !unitId}>
          {pending ? "Lägger till…" : "Lägg till"}
        </Button>
      </div>
    </form>
  );
}
