"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { NUMBER_SERIES_LABELS, type NumberSeries } from "../../lib/types";
import styles from "./NumberSeriesList.module.css";

function formatPreview(series: NumberSeries) {
  const numberPart = series.digits > 0 ? String(series.nextNumber).padStart(series.digits, "0") : String(series.nextNumber);
  return `${series.prefix}${numberPart}`;
}

function SeriesRow({ series, onUpdated }: { series: NumberSeries; onUpdated: (updated: NumberSeries) => void }) {
  const [editing, setEditing] = useState(false);
  const [prefix, setPrefix] = useState(series.prefix);
  const [nextNumber, setNextNumber] = useState(String(series.nextNumber));
  const [digits, setDigits] = useState(String(series.digits));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function startEdit() {
    setPrefix(series.prefix);
    setNextNumber(String(series.nextNumber));
    setDigits(String(series.digits));
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    setError(null);
    setPending(true);
    try {
      const updated = await apiFetch<NumberSeries>(`/api/v1/number-series/${series.key}`, {
        method: "PATCH",
        body: JSON.stringify({ prefix, nextNumber: Number(nextNumber), digits: Number(digits) }),
      });
      onUpdated(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara nummerserien");
    } finally {
      setPending(false);
    }
  }

  if (!editing) {
    return (
      <div className={styles.row}>
        <div className={styles.info}>
          <div className={styles.label}>{NUMBER_SERIES_LABELS[series.key]}</div>
          <div className={`${styles.preview} num`}>Nästa: {formatPreview(series)}</div>
        </div>
        <Button type="button" variant="secondary" size="small" onClick={startEdit}>
          Redigera
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.editRow}>
      <div className={styles.label}>{NUMBER_SERIES_LABELS[series.key]}</div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.editFields}>
        <Field label="Prefix" htmlFor={`prefix-${series.key}`}>
          <Input id={`prefix-${series.key}`} size="xs" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
        <Field label="Nästa nummer" htmlFor={`next-${series.key}`}>
          <Input
            id={`next-${series.key}`}
            type="number"
            min={1}
            size="sm"
            value={nextNumber}
            onChange={(e) => setNextNumber(e.target.value)}
          />
        </Field>
        <Field label="Antal siffror" htmlFor={`digits-${series.key}`}>
          <Input
            id={`digits-${series.key}`}
            type="number"
            min={0}
            max={10}
            size="xs"
            value={digits}
            onChange={(e) => setDigits(e.target.value)}
          />
        </Field>
      </div>
      <div className={styles.actions}>
        <Button type="button" variant="primary" size="small" onClick={handleSave} disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="ghost" size="small" onClick={() => setEditing(false)} disabled={pending}>
          Avbryt
        </Button>
      </div>
    </div>
  );
}

export function NumberSeriesList({ series: initial }: { series: NumberSeries[] }) {
  const [series, setSeries] = useState(initial);

  function handleUpdated(updated: NumberSeries) {
    setSeries((prev) => prev.map((s) => (s.key === updated.key ? updated : s)));
  }

  return (
    <div className={styles.card}>
      {series.map((s) => (
        <SeriesRow key={s.key} series={s} onUpdated={handleUpdated} />
      ))}
    </div>
  );
}
