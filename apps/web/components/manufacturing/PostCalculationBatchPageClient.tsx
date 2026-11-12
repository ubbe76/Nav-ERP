"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatStockholmDateTime } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatPercent, formatQuantity, formatSignedMoney, formatUnitPrice } from "../../lib/format";
import { MANUFACTURING_ORDER_STATUS_PILL, type ArticleGroup, type ManufacturingOrderStatus } from "../../lib/types";
import { ArticleNumberInput } from "../ui/ArticleNumberInput";
import { ArticlePicker, type ArticlePickerValue } from "../ui/ArticlePicker";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Input, Select } from "../ui/Field";
import { FormError, FormNotice, FormStack } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { useCan } from "../PermissionsProvider";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { shareTrack, Table } from "../ui/Table";
import styles from "./PostCalculationBatchPageClient.module.css";

interface BatchRow {
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  status: ManufacturingOrderStatus;
  lastReceivedOn: string | null;
  outputQuantity: number;
  preliminary: boolean;
  calculatedPerUnit: number | null;
  actualPerUnit: number | null;
  variance: { amount: number; percent: number | null } | null;
  latestPostCalculation: { calculationId: string; calculatedAt: string } | null;
  warnings: string[];
  error: string | null;
}

interface SaveResult {
  saved: { manufacturingOrderId: string; orderNumber: string; calculationId: string }[];
  errors: { manufacturingOrderId: string; orderNumber: string | null; message: string }[];
}

interface ListedOrder {
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  status: ManufacturingOrderStatus;
  lastReceivedOn: string | null;
  hasPostCalculation: boolean;
}

// Visa urval's answer plus the selection it was asked for (JSON of the body).
interface ListedSelection {
  key: string;
  count: number;
  max: number;
  orders: ListedOrder[];
}

const STATUS_ORDER: ManufacturingOrderStatus[] = ["planned", "released", "in_progress", "done", "closed", "cancelled"];
const money = (v: number | null) => (v === null ? "—" : formatUnitPrice(v));

export function PostCalculationBatchPageClient() {
  const canWrite = useCan()(["tillverkning"]);
  const [groups, setGroups] = useState<ArticleGroup[]>([]);
  const [receivedFrom, setReceivedFrom] = useState("");
  const [receivedTo, setReceivedTo] = useState("");
  const [article, setArticle] = useState<ArticlePickerValue | null>(null);
  const [numberFrom, setNumberFrom] = useState("");
  const [numberTo, setNumberTo] = useState("");
  const [groupId, setGroupId] = useState("");
  const [statuses, setStatuses] = useState<Set<ManufacturingOrderStatus>>(new Set(["done", "closed"]));

  const [listed, setListed] = useState<ListedSelection | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    apiFetch<ArticleGroup[]>("/api/v1/article-groups").then(setGroups).catch(() => setGroups([]));
  }, []);

  // Either one article or an article number interval — only one of them is
  // sent (the API refuses both).
  function selectionBody(): Record<string, unknown> {
    return {
      selection: {
        ...(receivedFrom ? { receivedFrom } : {}),
        ...(receivedTo ? { receivedTo } : {}),
        ...(article ? { articleId: article.id } : {}),
        ...(!article && numberFrom.trim() ? { articleNumberFrom: numberFrom.trim() } : {}),
        ...(!article && numberTo.trim() ? { articleNumberTo: numberTo.trim() } : {}),
        ...(groupId ? { groupId } : {}),
        statuses: STATUS_ORDER.filter((s) => statuses.has(s)),
      },
    };
  }

  const noStatus = statuses.size === 0;

  async function runPreview(keepResult: boolean) {
    setRunning(true);
    setError(null);
    if (!keepResult) setResult(null);
    try {
      const res = await apiFetch<{ rows: BatchRow[] }>("/api/v1/costing/post-calculations/batch", {
        method: "POST",
        body: JSON.stringify(selectionBody()),
      });
      setRows(res.rows);
      // Marked unless it already has a saved post-calculation or an error;
      // after Spara nothing is preselected so a second click cannot save the
      // same calculations again by accident.
      setSelected(
        keepResult ? new Set() : new Set(res.rows.filter((r) => !r.error && !r.latestPostCalculation).map((r) => r.manufacturingOrderId)),
      );
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte efterkalkylera urvalet"));
    } finally {
      setRunning(false);
    }
  }

  async function onListSelection() {
    const body = selectionBody();
    const key = JSON.stringify(body);
    setListing(true);
    setListError(null);
    try {
      const res = await apiFetch<Omit<ListedSelection, "key">>("/api/v1/costing/post-calculations/batch/selection", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setListed({ key, ...res });
    } catch (err) {
      setListed(null);
      setListError(apiErrorMessage(err, "Kunde inte visa urvalet"));
    } finally {
      setListing(false);
    }
  }

  const shownSelection = listed && listed.key === JSON.stringify(selectionBody()) ? listed : null;

  const selectable = useMemo(() => (rows ?? []).filter((r) => !r.error), [rows]);
  const selectedCount = selectable.filter((r) => selected.has(r.manufacturingOrderId)).length;
  const errorCount = (rows ?? []).filter((r) => r.error).length;

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleStatus(s: ManufacturingOrderStatus, on: boolean) {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (on) next.add(s);
      else next.delete(s);
      return next;
    });
  }

  async function onSave() {
    if (selectedCount === 0) return;
    setSaving(true);
    setSaveError(null);
    setResult(null);
    try {
      const ids = selectable.filter((r) => selected.has(r.manufacturingOrderId)).map((r) => r.manufacturingOrderId);
      const res = await apiFetch<SaveResult>("/api/v1/costing/post-calculations/batch/save", {
        method: "POST",
        body: JSON.stringify({ manufacturingOrderIds: ids }),
      });
      setResult(res);
      // Re-run with the same selection so "Senaste efterkalkyl" shows what
      // was just saved.
      await runPreview(true);
    } catch (err) {
      setSaveError(apiErrorMessage(err, "Kunde inte spara efterkalkylerna"));
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
          onChange={(on) => setSelected(on ? new Set(selectable.map((r) => r.manufacturingOrderId)) : new Set())}
          ariaLabel="Markera alla ordrar"
        />
      ),
    },
    { key: "order", label: "TO-nummer", width: shareTrack(90) },
    { key: "article", label: "Artikel", width: shareTrack(150, 2) },
    { key: "status", label: "Status", width: shareTrack(80) },
    { key: "received", label: "Senaste inleverans", width: shareTrack(100) },
    { key: "quantity", label: "Inlevererat", width: shareTrack(80), align: "right" as const },
    { key: "calculated", label: "Kalkylerat/st", width: shareTrack(90), align: "right" as const },
    { key: "actual", label: "Efterkalkyl/st", width: shareTrack(90), align: "right" as const },
    { key: "variance", label: "Avvikelse/st", width: shareTrack(90), align: "right" as const },
    { key: "latest", label: "Senaste efterkalkyl", width: shareTrack(110) },
  ];

  const tableRows = (rows ?? []).map((r) => ({ ...r, id: r.manufacturingOrderId }));

  function renderCell(r: (typeof tableRows)[number], key: string) {
    if (r.error && key !== "select" && key !== "order" && key !== "article") return null;
    switch (key) {
      case "select":
        return (
          <Checkbox
            checked={selected.has(r.id)}
            disabled={!!r.error}
            onChange={(e) => toggle(r.id, e.target.checked)}
            aria-label={`Markera ${r.orderNumber}`}
          />
        );
      case "order":
        return <GatedLink href={`/tillverkning/ordrar/${r.id}`}>{r.orderNumber}</GatedLink>;
      case "article":
        return (
          <span className={styles.value}>
            {r.articleNumber} {r.articleName}
            {r.error && <span className={styles.rowError}>{r.error}</span>}
            {r.warnings.map((w, i) => (
              <span key={i} className={styles.rowNote}>
                Varning: {w}
              </span>
            ))}
          </span>
        );
      case "status":
        return MANUFACTURING_ORDER_STATUS_PILL[r.status].label;
      case "received":
        return r.lastReceivedOn ?? "—";
      case "quantity":
        return formatQuantity(r.outputQuantity);
      case "calculated":
        return r.preliminary ? <span className={styles.sub}>Ej klar</span> : money(r.calculatedPerUnit);
      case "actual":
        return r.preliminary ? <span className={styles.sub}>Ej klar</span> : money(r.actualPerUnit);
      case "variance":
        return r.variance ? (
          <span className={`${styles.value} ${r.variance.amount > 0 ? styles.up : r.variance.amount < 0 ? styles.down : ""}`}>
            {formatSignedMoney(r.variance.amount)}
            {r.variance.percent !== null && (
              <span className={styles.sub}>{`${r.variance.percent > 0 ? "+" : ""}${formatPercent(r.variance.percent, 2)}`}</span>
            )}
          </span>
        ) : (
          "—"
        );
      case "latest":
        return r.latestPostCalculation ? formatStockholmDateTime(r.latestPostCalculation.calculatedAt) : "—";
      default:
        return null;
    }
  }

  return (
    <div className={styles.stack}>
      <Card maxWidth="none">
        <FormStack>
          <fieldset className={styles.filter}>
            <legend className={styles.filterLegend}>Urval</legend>
            <div className={styles.filterGrid}>
              <div className={styles.compactField}>
                <label className={styles.filterLabel} htmlFor="pocb-from">
                  Senaste inleverans från
                </label>
                <Input id="pocb-from" type="date" value={receivedFrom} onChange={(e) => setReceivedFrom(e.target.value)} />
              </div>
              <div className={styles.compactField}>
                <label className={styles.filterLabel} htmlFor="pocb-to">
                  Senaste inleverans till
                </label>
                <Input id="pocb-to" type="date" value={receivedTo} onChange={(e) => setReceivedTo(e.target.value)} />
              </div>
              <div className={styles.compactField}>
                <label className={styles.filterLabel} htmlFor="pocb-group">
                  Varugrupp
                </label>
                <Select id="pocb-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">Alla</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className={styles.compactField}>
              <label className={styles.filterLabel} htmlFor="pocb-article">
                Artikel
              </label>
              <ArticlePicker id="pocb-article" value={article} onChange={setArticle} />
            </div>
            <div className={styles.compactField} role="group" aria-label="Artikelnummer från och till">
              <span className={styles.filterLabel}>Artikelnummer från/till{article ? " (inte med en vald artikel)" : ""}</span>
              <div className={styles.pairRow}>
                <ArticleNumberInput value={numberFrom} placeholder="Från" aria-label="Artikelnummer från" onChange={setNumberFrom} />
                <span className={styles.dash} aria-hidden="true">
                  –
                </span>
                <ArticleNumberInput value={numberTo} placeholder="Till" aria-label="Artikelnummer till" onChange={setNumberTo} />
              </div>
            </div>
            <div className={styles.compactField} role="group" aria-label="Status">
              <span className={styles.filterLabel}>Status</span>
              <div className={styles.statusRow}>
                {STATUS_ORDER.map((s) => (
                  <label key={s} className={styles.checkLine}>
                    <Checkbox checked={statuses.has(s)} onChange={(e) => toggleStatus(s, e.target.checked)} />
                    {MANUFACTURING_ORDER_STATUS_PILL[s].label}
                  </label>
                ))}
              </div>
            </div>
          </fieldset>
          <div className={styles.runButtons}>
            <Button type="button" variant="secondary" onClick={() => void onListSelection()} disabled={listing || noStatus}>
              {listing ? "Hämtar…" : "Visa urval"}
            </Button>
            <Button type="button" onClick={() => void runPreview(false)} disabled={running || noStatus}>
              {running ? "Beräknar…" : "Efterkalkylera"}
            </Button>
          </div>
          <FormError>{listError ?? error}</FormError>
        </FormStack>
      </Card>

      {shownSelection && (
        <Card maxWidth="none">
          <div className={styles.listedHead}>
            <strong>Urvalet har {shownSelection.count === 1 ? "1 order" : `${shownSelection.count.toLocaleString("sv-SE")} ordrar`}</strong>
            <Button type="button" variant="secondary" size="small" onClick={() => setListed(null)}>
              Dölj
            </Button>
          </div>
          {shownSelection.count > shownSelection.max && (
            <FormNotice>
              Högst {shownSelection.max} ordrar kan efterkalkyleras åt gången — snäva in urvalet. Listan visar de första {shownSelection.max}.
            </FormNotice>
          )}
          {shownSelection.orders.length > 0 && (
            <div className={styles.listedWrap}>
              <Table
                columns={[
                  { key: "order", label: "TO-nummer", width: shareTrack(90) },
                  { key: "article", label: "Artikel", width: shareTrack(200, 3) },
                  { key: "status", label: "Status", width: shareTrack(80) },
                  { key: "received", label: "Senaste inleverans", width: shareTrack(100) },
                  { key: "has", label: "Efterkalkyl", width: shareTrack(80) },
                ]}
                rows={shownSelection.orders.map((o) => ({ ...o, id: o.manufacturingOrderId }))}
                renderCell={(o, key) =>
                  key === "order" ? (
                    <GatedLink href={`/tillverkning/ordrar/${o.id}`}>{o.orderNumber}</GatedLink>
                  ) : key === "article" ? (
                    `${o.articleNumber} ${o.articleName}`
                  ) : key === "status" ? (
                    MANUFACTURING_ORDER_STATUS_PILL[o.status].label
                  ) : key === "received" ? (
                    (o.lastReceivedOn ?? "—")
                  ) : o.hasPostCalculation ? (
                    "Sparad"
                  ) : (
                    "—"
                  )
                }
                emptyText="Inga ordrar matchar urvalet"
              />
            </div>
          )}
          {shownSelection.count === 0 && <p className={styles.summary}>Inga ordrar matchar urvalet.</p>}
        </Card>
      )}

      {result && (
        <Card maxWidth="none">
          <div role="status">
            <strong>{result.saved.length === 1 ? "1 efterkalkyl sparad." : `${result.saved.length} efterkalkyler sparade.`}</strong>
            {result.saved.length > 0 && <> {result.saved.map((s) => s.orderNumber).join(", ")}</>}
          </div>
          {result.errors.length > 0 && (
            <FormNotice>
              {result.errors.length === 1 ? "1 order gick inte att spara:" : `${result.errors.length} ordrar gick inte att spara:`}
              <ul className={styles.resultList}>
                {result.errors.map((e, i) => (
                  <li key={i}>
                    {e.orderNumber ?? e.manufacturingOrderId}: {e.message}
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
            {rows.length === 1 ? "1 order" : `${rows.length.toLocaleString("sv-SE")} ordrar`}, varav {errorCount} med fel
          </div>
          <div className={styles.tableWrap}>
            <div className={styles.tableMin}>
              <Table columns={columns} rows={tableRows} renderCell={renderCell} emptyText="Inga ordrar matchar urvalet" />
            </div>
          </div>
          {canWrite && rows.length > 0 && (
            <Card maxWidth="none">
              <div className={styles.saveBar}>
                <Button type="button" onClick={() => void onSave()} disabled={saving || running || selectedCount === 0}>
                  {saving ? "Sparar…" : `Spara markerade (${selectedCount})`}
                </Button>
              </div>
              <FormError>{saveError}</FormError>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
