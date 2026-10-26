"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { confirmDelete } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { NUMBER_SERIES_LABELS, type ArticleNumberSeriesOption, type NumberSeries, type NumberSeriesKey } from "../../lib/types";
import styles from "./NumberSeriesList.module.css";

function formatPreview(series: NumberSeries) {
  const numberPart = series.digits > 0 ? String(series.nextNumber).padStart(series.digits, "0") : String(series.nextNumber);
  return `${series.prefix}${numberPart}`;
}

// The user's own article series (the built-in "article" series is not one).
function isOwnArticleSeries(series: NumberSeries) {
  return series.forArticles && series.key !== "article";
}

function seriesLabel(series: NumberSeries) {
  return series.name ?? NUMBER_SERIES_LABELS[series.key as NumberSeriesKey] ?? series.key;
}

function SeriesRow({
  series,
  preview,
  onUpdated,
  onDeleted,
}: {
  series: NumberSeries;
  // An article series' next FREE number (taken numbers are skipped), when known.
  preview?: string;
  onUpdated: (updated: NumberSeries) => void;
  onDeleted: (key: string) => void;
}) {
  const own = isOwnArticleSeries(series);
  const [name, setName] = useState(series.name ?? "");
  const [editing, setEditing] = useState(false);
  const [prefix, setPrefix] = useState(series.prefix);
  const [nextNumber, setNextNumber] = useState(String(series.nextNumber));
  const [digits, setDigits] = useState(String(series.digits));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function startEdit() {
    setName(series.name ?? "");
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
        body: JSON.stringify({
          ...(own ? { name } : {}),
          prefix,
          nextNumber: Number(nextNumber),
          digits: Number(digits),
        }),
      });
      onUpdated(updated);
      setEditing(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara nummerserien"));
    } finally {
      setPending(false);
    }
  }

  async function handleDelete() {
    if (
      !(await confirmDelete(
        `Ta bort nummerserien ${seriesLabel(series)}? Varugrupper som använder den får standardserien Artikelnummer.`
      ))
    )
      return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/number-series/${series.key}`, { method: "DELETE" });
      onDeleted(series.key);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort nummerserien"));
      setPending(false);
    }
  }

  if (!editing) {
    return (
      <div className={styles.row}>
        <div className={styles.info}>
          <div className={styles.label}>{seriesLabel(series)}</div>
          <div className={`${styles.preview} num`}>Nästa: {preview ?? formatPreview(series)}</div>
          {error && <div className={styles.error}>{error}</div>}
        </div>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" size="small" onClick={startEdit}>
            Redigera
          </Button>
          {own && (
            <Button type="button" variant="ghost" size="small" onClick={handleDelete} disabled={pending}>
              Ta bort
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.editRow}>
      <div className={styles.label}>{seriesLabel(series)}</div>
      {error && <div className={styles.error}>{error}</div>}
      {own && (
        <Field label="Namn" htmlFor={`name-${series.key}`}>
          <Input id={`name-${series.key}`} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      )}
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

function NewSeriesForm({ onCreated, onCancel }: { onCreated: (created: NumberSeries) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [nextNumber, setNextNumber] = useState("1");
  const [digits, setDigits] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleCreate() {
    setError(null);
    setPending(true);
    try {
      const created = await apiFetch<NumberSeries>("/api/v1/number-series", {
        method: "POST",
        body: JSON.stringify({ name, prefix, nextNumber: Number(nextNumber), digits: Number(digits) }),
      });
      onCreated(created);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa nummerserien"));
      setPending(false);
    }
  }

  return (
    <div className={styles.editRow}>
      {error && <div className={styles.error}>{error}</div>}
      <Field label="Namn" htmlFor="new-series-name">
        <Input id="new-series-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className={styles.editFields}>
        <Field label="Prefix" htmlFor="new-series-prefix">
          <Input id="new-series-prefix" size="xs" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
        <Field label="Nästa nummer" htmlFor="new-series-next">
          <Input
            id="new-series-next"
            type="number"
            min={1}
            step={1}
            size="sm"
            value={nextNumber}
            onChange={(e) => setNextNumber(e.target.value)}
          />
        </Field>
        <Field label="Antal siffror" htmlFor="new-series-digits">
          <Input
            id="new-series-digits"
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
        <Button type="button" variant="primary" size="small" onClick={handleCreate} disabled={pending || name.trim() === ""}>
          {pending ? "Skapar…" : "Skapa artikelserie"}
        </Button>
        <Button type="button" variant="ghost" size="small" onClick={onCancel} disabled={pending}>
          Avbryt
        </Button>
      </div>
    </div>
  );
}

export function NumberSeriesList({ series: initial }: { series: NumberSeries[] }) {
  const [series, setSeries] = useState(initial);
  const [creating, setCreating] = useState(false);
  // Article series skip numbers that are already taken, so their "Nästa" is
  // the server's preview rather than the counter — refreshed after changes.
  const [articlePreviews, setArticlePreviews] = useState<Record<string, string>>({});
  const loadPreviews = useCallback(() => {
    apiFetch<ArticleNumberSeriesOption[]>("/api/v1/article-number-series")
      .then((rows) => setArticlePreviews(Object.fromEntries(rows.map((r) => [r.key, r.nextArticleNumber]))))
      .catch(() => setArticlePreviews({}));
  }, []);
  useEffect(loadPreviews, [loadPreviews]);

  function handleUpdated(updated: NumberSeries) {
    setSeries((prev) => prev.map((s) => (s.key === updated.key ? updated : s)));
    if (updated.forArticles) loadPreviews();
  }

  function handleDeleted(key: string) {
    setSeries((prev) => prev.filter((s) => s.key !== key));
  }

  const builtIn = series.filter((s) => !isOwnArticleSeries(s));
  const own = series.filter(isOwnArticleSeries);

  return (
    <>
      <div className={styles.card}>
        {builtIn.map((s) => (
          <SeriesRow key={s.key} series={s} preview={articlePreviews[s.key]} onUpdated={handleUpdated} onDeleted={handleDeleted} />
        ))}
      </div>

      <h2 className={styles.sectionTitle}>Egna artikelserier</h2>
      <div className={styles.card}>
        {own.map((s) => (
          <SeriesRow key={s.key} series={s} preview={articlePreviews[s.key]} onUpdated={handleUpdated} onDeleted={handleDeleted} />
        ))}
        {creating ? (
          <NewSeriesForm
            onCreated={(created) => {
              setSeries((prev) => [...prev, created]);
              setCreating(false);
              loadPreviews();
            }}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <div className={styles.row}>
            <Button type="button" variant="secondary" size="small" onClick={() => setCreating(true)}>
              + Ny artikelserie
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
