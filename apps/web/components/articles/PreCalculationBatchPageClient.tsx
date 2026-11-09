"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { fetchCopiedCount } from "../../lib/copiedArticles";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, formatPercent, formatQuantity, formatSignedMoney } from "../../lib/format";
import { ARTICLE_TYPE_LABELS, type ArticleGroup, type ArticleType, type RegisterEntry } from "../../lib/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Input, Select } from "../ui/Field";
import { FormError, FormHint, FormNotice, FormStack } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { useCan } from "../PermissionsProvider";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { shareTrack, Table } from "../ui/Table";
import styles from "./PreCalculationBatchPageClient.module.css";

type Source = "copied" | "filter";

interface BatchRow {
  articleId: string;
  articleNumber: string;
  name: string;
  type: ArticleType;
  quantity: number;
  quantitySource: "latest" | "fallback";
  manufacturingCostPerUnit: number | null;
  selfCostPerUnit: number | null;
  salesPricePerUnit: number | null;
  previous: { calculationId: string; calculatedAt: string; quantity: number; manufacturingCostPerUnit: number | null } | null;
  change: { amount: number; percent: number } | null;
  currentStandardCost: number | null;
  currentSalesPrice: number | null;
  warnings: string[];
  error: string | null;
}

interface SaveResult {
  saved: { articleId: string; articleNumber: string; calculationId: string; standardCostSet: boolean; salesPriceSet: boolean }[];
  errors: { articleId: string; articleNumber: string | null; message: string }[];
}

// What the shown table was computed for — save and re-run use exactly this,
// never the form's current (possibly edited) values.
interface RanWith {
  body: Record<string, unknown>;
  multiLevel: boolean;
}

type TypeFilter = "" | ArticleType;

// One Artikelnummer från/till row in the filter. An article is taken when it
// lies in ANY of the rows; a row with both fields empty is not sent (it
// would let everything in). Mirrors PRE_CALCULATION_BATCH_MAX_RANGES in
// packages/shared/src/pre-calculation-batch.ts (the web cannot import it).
interface RangeRow {
  from: string;
  to: string;
}
const MAX_RANGES = 20;
const emptyRange = (): RangeRow => ({ from: "", to: "" });

const money = (v: number | null) => (v === null ? "—" : formatMoney(v));
const dateOf = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });

export function PreCalculationBatchPageClient({ initialSource }: { initialSource: Source }) {
  const canWrite = useCan()(["artiklar", "tillverkning"]);
  const [copiedCount, setCopiedCount] = useState<number | null>(null);
  const [source, setSource] = useState<Source>(initialSource);
  const [groups, setGroups] = useState<ArticleGroup[]>([]);
  const [articleCodes, setArticleCodes] = useState<RegisterEntry[]>([]);
  const [ranges, setRanges] = useState<RangeRow[]>([emptyRange()]);
  const [groupId, setGroupId] = useState("");
  const [type, setType] = useState<TypeFilter>("manufactured");
  const [articleCodeId, setArticleCodeId] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [fallbackQuantity, setFallbackQuantity] = useState("1");
  const [multiLevel, setMultiLevel] = useState(false);

  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [ranWith, setRanWith] = useState<RanWith | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [setStandardCost, setSetStandardCost] = useState(false);
  const [setSalesPrice, setSetSalesPrice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    fetchCopiedCount()
      .then((n) => {
        setCopiedCount(n);
        if (n === 0) setSource((s) => (s === "copied" ? "filter" : s));
      })
      // Unknown, not empty: a failed count leaves Kopierat selectable (the
      // preview reports its own error) instead of reading as "your list is empty".
      .catch(() => setCopiedCount(null));
    apiFetch<ArticleGroup[]>("/api/v1/article-groups").then(setGroups).catch(() => setGroups([]));
    apiFetch<RegisterEntry[]>("/api/v1/article-codes").then(setArticleCodes).catch(() => setArticleCodes([]));
  }, []);

  const copiedDisabled = copiedCount === 0;
  const quantityValid = Number(fallbackQuantity) > 0;

  function setRange(index: number, patch: Partial<RangeRow>) {
    setRanges((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  // At least one row stays, so the fields never disappear.
  function removeRange(index: number) {
    setRanges((prev) => (prev.length === 1 ? [emptyRange()] : prev.filter((_, i) => i !== index)));
  }

  function selectionBody(): Record<string, unknown> {
    if (source === "copied") return { selection: { copied: true } };
    const articleNumberRanges = ranges
      .map((r) => ({ from: r.from.trim(), to: r.to.trim() }))
      .filter((r) => r.from || r.to)
      .map((r) => ({ ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}) }));
    return {
      selection: {
        ...(articleNumberRanges.length > 0 ? { articleNumberRanges } : {}),
        ...(groupId ? { groupId } : {}),
        ...(type ? { type } : {}),
        ...(articleCodeId ? { articleCodeId } : {}),
        activeOnly,
      },
    };
  }

  // keepResult = the re-run after Spara markerade: the result stays visible and
  // nothing is preselected, so a second click cannot save the same
  // calculations again by accident.
  async function runPreview(ran: RanWith, keepResult: boolean) {
    setRunning(true);
    setError(null);
    if (!keepResult) setResult(null);
    try {
      const res = await apiFetch<{ rows: BatchRow[] }>("/api/v1/costing/pre-calculations/batch", {
        method: "POST",
        body: JSON.stringify({ ...ran.body, multiLevel: ran.multiLevel }),
      });
      setRows(res.rows);
      setRanWith(ran);
      setSelected(keepResult ? new Set() : new Set(res.rows.filter((r) => !r.error).map((r) => r.articleId)));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte förkalkylera urvalet"));
    } finally {
      setRunning(false);
    }
  }

  function onPreview() {
    if (!quantityValid) return;
    void runPreview({ body: { ...selectionBody(), fallbackQuantity: Number(fallbackQuantity) }, multiLevel }, false);
  }

  const selectable = useMemo(() => (rows ?? []).filter((r) => !r.error), [rows]);
  const selectedCount = selectable.filter((r) => selected.has(r.articleId)).length;
  const errorCount = (rows ?? []).filter((r) => r.error).length;

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function onSave() {
    if (!ranWith || selectedCount === 0) return;
    if (setStandardCost || setSalesPrice) {
      const what = setStandardCost && setSalesPrice ? "standardpris och försäljningspris" : setStandardCost ? "standardpris" : "försäljningspris";
      const ok = await confirmDialog(`Spara ${selectedCount} förkalkyler och sätta ${what} för ${selectedCount} artiklar?`, {
        confirmLabel: "Spara",
      });
      if (!ok) return;
    }
    setSaving(true);
    setSaveError(null);
    setResult(null);
    try {
      const res = await apiFetch<SaveResult>("/api/v1/costing/pre-calculations/batch/save", {
        method: "POST",
        body: JSON.stringify({
          items: selectable.filter((r) => selected.has(r.articleId)).map((r) => ({ articleId: r.articleId, quantity: r.quantity })),
          multiLevel: ranWith.multiLevel,
          setStandardCost,
          setSalesPrice,
        }),
      });
      setResult(res);
      // Re-run the preview with the same inputs so "Förra TVK/st" and the
      // current prices reflect what was just saved.
      await runPreview(ranWith, true);
    } catch (err) {
      setSaveError(apiErrorMessage(err, "Kunde inte spara förkalkylerna"));
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    {
      key: "select",
      label: "Markera",
      width: "28px",
      header: (
        <SelectAllCheckbox
          checked={selectable.length > 0 && selectedCount === selectable.length}
          indeterminate={selectedCount > 0 && selectedCount < selectable.length}
          disabled={selectable.length === 0}
          onChange={(on) => setSelected(on ? new Set(selectable.map((r) => r.articleId)) : new Set())}
          ariaLabel="Markera alla artiklar"
        />
      ),
    },
    { key: "articleNumber", label: "Artikelnummer", width: shareTrack(90) },
    { key: "name", label: "Benämning", width: shareTrack(130, 2) },
    { key: "quantity", label: "Antal", width: shareTrack(100), align: "right" as const },
    { key: "tvk", label: "TVK/st", width: shareTrack(80), align: "right" as const },
    { key: "prevTvk", label: "Förra TVK/st", width: shareTrack(90), align: "right" as const },
    { key: "change", label: "Ändring", width: shareTrack(80), align: "right" as const },
    { key: "standard", label: "Standardpris", width: shareTrack(80), align: "right" as const },
    { key: "price", label: "Pris/st", width: shareTrack(70), align: "right" as const },
    { key: "sales", label: "Försäljningspris", width: shareTrack(105), align: "right" as const },
  ];

  const tableRows = (rows ?? []).map((r) => ({ ...r, id: r.articleId }));

  function renderCell(r: (typeof tableRows)[number], key: string) {
    if (r.error && key !== "select" && key !== "articleNumber" && key !== "name") return null;
    switch (key) {
      case "select":
        return (
          <Checkbox
            checked={selected.has(r.id)}
            disabled={!!r.error}
            onChange={(e) => toggle(r.id, e.target.checked)}
            aria-label={`Markera ${r.articleNumber}`}
          />
        );
      case "articleNumber":
        return <Link href={`/artiklar/${r.id}`}>{r.articleNumber}</Link>;
      case "name":
        return (
          <span className={styles.value}>
            {r.name}
            {r.error && <span className={styles.rowError}>{r.error}</span>}
            {r.warnings.map((w, i) => (
              <span key={i} className={styles.rowNote}>
                Varning: {w}
              </span>
            ))}
          </span>
        );
      case "quantity":
        return (
          <span className={styles.value}>
            {formatQuantity(r.quantity)}
            <span className={styles.sub}>{r.quantitySource === "latest" ? "senaste förkalkyl" : "valt antal"}</span>
          </span>
        );
      case "tvk":
        return money(r.manufacturingCostPerUnit);
      case "prevTvk":
        return r.previous && r.previous.manufacturingCostPerUnit !== null ? (
          <span className={styles.value}>
            {formatMoney(r.previous.manufacturingCostPerUnit)}
            <span className={styles.sub}>{dateOf(r.previous.calculatedAt)}</span>
          </span>
        ) : (
          "—"
        );
      case "change":
        return r.change ? (
          <span className={`${styles.value} ${r.change.amount > 0 ? styles.up : r.change.amount < 0 ? styles.down : ""}`}>
            {formatSignedMoney(r.change.amount)}
            <span className={styles.sub}>{`${r.change.percent > 0 ? "+" : ""}${formatPercent(r.change.percent, 2)}`}</span>
          </span>
        ) : (
          "—"
        );
      case "standard":
        return money(r.currentStandardCost);
      case "price":
        return money(r.salesPricePerUnit);
      case "sales":
        return money(r.currentSalesPrice);
      default:
        return null;
    }
  }

  const standardSet = result?.saved.filter((s) => s.standardCostSet).length ?? 0;
  const salesSet = result?.saved.filter((s) => s.salesPriceSet).length ?? 0;

  return (
    <div className={styles.stack}>
      <Card maxWidth="none">
        <FormStack>
          <div className={styles.sourceRow} role="radiogroup" aria-label="Urval">
            <label className={styles.radio} data-disabled={copiedDisabled}>
              <input type="radio" name="source" checked={source === "copied"} disabled={copiedDisabled} onChange={() => setSource("copied")} />
              Kopierat{copiedCount !== null ? ` (${copiedCount.toLocaleString("sv-SE")})` : ""}
            </label>
            <GatedLink href="/artiklar/kopierat" className={styles.sourceLink}>
              Visa och ändra
            </GatedLink>
            <label className={styles.radio}>
              <input type="radio" name="source" checked={source === "filter"} onChange={() => setSource("filter")} />
              Filter
            </label>
          </div>
          {copiedDisabled && (
            <FormHint>
              Kopierat är tomt. Kopiera artiklar i <Link href="/artiklar/register">artikelregistret</Link> eller lägg till dem på sidan{" "}
              <GatedLink href="/artiklar/kopierat">Kopierat</GatedLink> först.
            </FormHint>
          )}

          {source === "filter" && (
            <fieldset className={styles.filter}>
              <legend className={styles.filterLegend}>Filtrera</legend>
              <div className={styles.ranges} role="group" aria-label="Artikelnummer från och till">
                <span className={styles.filterLabel}>Artikelnummer</span>
                {ranges.map((r, i) => (
                  <div key={i} className={styles.rangeRow}>
                    <Input
                      value={r.from}
                      placeholder="Från"
                      aria-label={`Artikelnummer från, intervall ${i + 1}`}
                      onChange={(e) => setRange(i, { from: e.target.value })}
                    />
                    <span className={styles.rangeDash} aria-hidden="true">
                      –
                    </span>
                    <Input value={r.to} placeholder="Till" aria-label={`Artikelnummer till, intervall ${i + 1}`} onChange={(e) => setRange(i, { to: e.target.value })} />
                    <button
                      type="button"
                      className={styles.rangeRemove}
                      disabled={ranges.length === 1}
                      aria-label={`Ta bort intervall ${i + 1}`}
                      title="Ta bort intervall"
                      onClick={() => removeRange(i)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {ranges.length < MAX_RANGES && (
                  <button type="button" className={styles.addRange} onClick={() => setRanges((prev) => [...prev, emptyRange()])}>
                    + Lägg till intervall
                  </button>
                )}
              </div>
              <div className={styles.filterGrid}>
                <div className={styles.compactField}>
                  <label className={styles.filterLabel} htmlFor="pcb-group">
                    Varugrupp
                  </label>
                  <Select id="pcb-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                    <option value="">Alla</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={styles.compactField}>
                  <label className={styles.filterLabel} htmlFor="pcb-type">
                    Typ
                  </label>
                  <Select id="pcb-type" value={type} onChange={(e) => setType(e.target.value as TypeFilter)}>
                    <option value="">Alla</option>
                    {(Object.keys(ARTICLE_TYPE_LABELS) as ArticleType[]).map((t) => (
                      <option key={t} value={t}>
                        {ARTICLE_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={styles.compactField}>
                  <label className={styles.filterLabel} htmlFor="pcb-code">
                    Artikelkod
                  </label>
                  <Select id="pcb-code" value={articleCodeId} onChange={(e) => setArticleCodeId(e.target.value)}>
                    <option value="">Alla</option>
                    {articleCodes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} {c.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <label className={`${styles.checkLine} ${styles.gridCheck}`}>
                  <Checkbox checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
                  Bara aktiva
                </label>
              </div>
            </fieldset>
          )}

          <div className={styles.optionsRow}>
            <div className={styles.compactField}>
              <label className={styles.filterLabel} htmlFor="pcb-qty">
                Antal när förkalkyl saknas
              </label>
              <Input id="pcb-qty" type="number" size="sm" min="0" step="any" value={fallbackQuantity} onChange={(e) => setFallbackQuantity(e.target.value)} />
            </div>
            <label className={`${styles.checkLine} ${styles.gridCheck}`}>
              <Checkbox checked={multiLevel} onChange={(e) => setMultiLevel(e.target.checked)} />
              Räkna om underliggande nivåer
            </label>
          </div>
          <FormHint>Varje artikel räknas med antalet i sin senaste förkalkyl.</FormHint>
          <div>
            <Button type="button" onClick={onPreview} disabled={running || !quantityValid || (source === "copied" && copiedDisabled)}>
              {running ? "Beräknar…" : "Förkalkylera"}
            </Button>
          </div>
          <FormError>{error}</FormError>
        </FormStack>
      </Card>

      {result && (
        <Card maxWidth="none">
          <div role="status">
            <strong>
              {result.saved.length === 1 ? "1 förkalkyl sparad." : `${result.saved.length} förkalkyler sparade.`}
            </strong>
            {(standardSet > 0 || salesSet > 0) && (
              <>
                {" "}
                {standardSet > 0 && `Standardpris satt för ${standardSet} artiklar. `}
                {salesSet > 0 && `Försäljningspris satt för ${salesSet} artiklar.`}
              </>
            )}
          </div>
          {result.errors.length > 0 && (
            <FormNotice>
              {result.errors.length === 1 ? "1 artikel gick inte att spara helt:" : `${result.errors.length} artiklar gick inte att spara helt:`}
              <ul className={styles.resultList}>
                {result.errors.map((e, i) => (
                  <li key={i}>
                    {e.articleNumber ?? e.articleId}: {e.message}
                  </li>
                ))}
              </ul>
            </FormNotice>
          )}
        </Card>
      )}

      {rows && (
        <>
          <div className={styles.summary}>
            {rows.length === 1 ? "1 artikel" : `${rows.length.toLocaleString("sv-SE")} artiklar`}, varav {errorCount} med fel
          </div>
          <div className={styles.tableWrap}>
            <div className={styles.tableMin}>
              <Table
                columns={columns}
                rows={tableRows}
                renderCell={renderCell}
                emptyText="Inga artiklar matchar urvalet"
              />
            </div>
          </div>
          {canWrite && rows.length > 0 && (
            <Card maxWidth="none">
              <div className={styles.saveBar}>
                <Button type="button" onClick={() => void onSave()} disabled={saving || running || selectedCount === 0}>
                  {saving ? "Sparar…" : `Spara markerade (${selectedCount})`}
                </Button>
                <label className={styles.checkLine}>
                  <Checkbox checked={setStandardCost} onChange={(e) => setSetStandardCost(e.target.checked)} />
                  Sätt standardpris
                </label>
                <label className={styles.checkLine}>
                  <Checkbox checked={setSalesPrice} onChange={(e) => setSetSalesPrice(e.target.checked)} />
                  Sätt försäljningspris
                </label>
              </div>
              <FormError>{saveError}</FormError>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
