"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { GatedLink } from "../ui/GatedLink";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow, FormSaved } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import type { Article, ArticleBatchBalances, ArticleTracking, ArticleLocations, SerialNumberSeriesOption, StockBalance } from "../../lib/types";
import { articleLocationRole, ownPrimaryLocationId } from "../../lib/stockLocations";
import { ArticleLocationsCard } from "./ArticleLocationsCard";
import { ForecastCard } from "./ForecastCard";
import { formatQuantity } from "../../lib/format";
import { apiErrorMessage } from "../../lib/errorMessages";

interface RowWithId extends StockBalance {
  id: string;
}

// Lager-fliken: a Planering section (behovsberäkning input, E1) above the
// read-only saldo table.
export function LagerTab({
  article,
  balances,
  articleLocations,
}: {
  article: Article;
  balances: StockBalance[];
  articleLocations: ArticleLocations;
}) {
  const router = useRouter();
  const [places, setPlaces] = useState(articleLocations);
  const [reorderPoint, setReorderPoint] = useState(article.reorderPoint ?? "");
  const [safetyStock, setSafetyStock] = useState(article.safetyStock ?? "");
  const [stockControlled, setStockControlled] = useState(article.stockControlled ? "stock" : "order");
  const [orderQuantity, setOrderQuantity] = useState(article.orderQuantity ?? "");
  const [rounding, setRounding] = useState(article.rounding ?? "");
  const [leadTime, setLeadTime] = useState(article.manufacturingLeadTimeDays != null ? String(article.manufacturingLeadTimeDays) : "");
  const [forecastControlled, setForecastControlled] = useState(article.forecastControlled ?? false);
  const currentTracking: ArticleTracking = article.tracking ?? (article.batchTracked ? "batch" : "none");
  const [tracking, setTracking] = useState<ArticleTracking>(currentTracking);
  // Serienummer: when the number is created and which series gives it ("" = the common one).
  const [serialAssignedAt, setSerialAssignedAt] = useState<"receipt" | "delivery">(article.serialAssignedAt ?? "receipt");
  const [serialSeriesKey, setSerialSeriesKey] = useState(article.serialSeriesKey ?? "");
  const [serialSeries, setSerialSeries] = useState<SerialNumberSeriesOption[]>([]);
  const [newSeriesOpen, setNewSeriesOpen] = useState(false);
  const [newSeriesName, setNewSeriesName] = useState("");
  const [newSeriesPrefix, setNewSeriesPrefix] = useState("");
  const [newSeriesDigits, setNewSeriesDigits] = useState("6");
  const [newSeriesError, setNewSeriesError] = useState<string | null>(null);
  const [newSeriesPending, setNewSeriesPending] = useState(false);
  const [shelfLife, setShelfLife] = useState(article.shelfLifeDays != null ? String(article.shelfLifeDays) : "");
  const [batchSetting, setBatchSetting] = useState(false);
  const [batchBalances, setBatchBalances] = useState<ArticleBatchBalances | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Batchstyrd shows only when the company uses batch numbers (or the article
  // already is batch tracked); services and phantoms can't be.
  useEffect(() => {
    apiFetch<{ batchTrackingEnabled?: boolean }>("/api/v1/settings")
      .then((s) => setBatchSetting(Boolean(s.batchTrackingEnabled)))
      .catch(() => setBatchSetting(false));
  }, []);
  // A serienummerstyrd article shows its numbers per place (Saldo per serienummer).
  const stockSerial = currentTracking === "serial" && (article.serialAssignedAt ?? "receipt") === "receipt";
  useEffect(() => {
    if (currentTracking === "none") {
      setBatchBalances(null);
      return;
    }
    apiFetch<ArticleBatchBalances>(`/api/v1/articles/${article.id}/batch-balances`)
      .then(setBatchBalances)
      .catch(() => setBatchBalances(null));
  }, [article.id, currentTracking, balances]);
  const loadSerialSeries = useCallback(() => {
    apiFetch<SerialNumberSeriesOption[]>("/api/v1/serial-number-series")
      .then(setSerialSeries)
      .catch(() => setSerialSeries([]));
  }, []);
  useEffect(() => {
    if (tracking === "serial") loadSerialSeries();
  }, [tracking, loadSerialSeries]);
  const canBatchTrack = article.type !== "service" && !article.isPhantom;
  const showBatchToggle = canBatchTrack && (batchSetting || currentTracking !== "none");

  async function createSerialSeries() {
    setNewSeriesError(null);
    setNewSeriesPending(true);
    try {
      const created = await apiFetch<{ key: string }>("/api/v1/number-series", {
        method: "POST",
        body: JSON.stringify({
          forSerials: true,
          name: newSeriesName.trim(),
          prefix: newSeriesPrefix,
          digits: Number(newSeriesDigits),
        }),
      });
      await loadSerialSeries();
      setSerialSeriesKey(created.key);
      setNewSeriesOpen(false);
      setNewSeriesName("");
      setNewSeriesPrefix("");
    } catch (err) {
      setNewSeriesError(apiErrorMessage(err, "Kunde inte skapa serienummerserien"));
    } finally {
      setNewSeriesPending(false);
    }
  }

  async function savePlanning(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${article.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          reorderPoint: reorderPoint.trim() === "" ? null : Number(reorderPoint),
          safetyStock: safetyStock.trim() === "" ? null : Number(safetyStock),
          stockControlled: stockControlled === "stock",
          orderQuantity: orderQuantity.trim() === "" ? null : Number(orderQuantity),
          rounding: rounding.trim() === "" ? null : Number(rounding),
          forecastControlled,
          ...(showBatchToggle && tracking !== currentTracking ? { tracking } : {}),
          ...(showBatchToggle && tracking === "serial" && serialAssignedAt !== (article.serialAssignedAt ?? "receipt")
            ? { serialAssignedAt }
            : {}),
          ...(showBatchToggle && tracking === "serial" && serialSeriesKey !== (article.serialSeriesKey ?? "")
            ? { serialSeriesKey: serialSeriesKey === "" ? null : serialSeriesKey }
            : {}),
          ...(showBatchToggle && tracking === "batch" && shelfLife.trim() !== String(article.shelfLifeDays ?? "")
            ? { shelfLifeDays: shelfLife.trim() === "" ? null : Number(shelfLife) }
            : {}),
          // Only manufactured articles carry a lead time; others leave it untouched.
          ...(article.type === "manufactured"
            ? { manufacturingLeadTimeDays: leadTime.trim() === "" ? null : Number(leadTime) }
            : {}),
        }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara"));
    } finally {
      setPending(false);
    }
  }

  const rows: RowWithId[] = balances.map((b) => ({ ...b, id: `${b.articleId}-${b.locationId}` }));

  return (
    <div>
      <ArticleLocationsCard
        articleId={article.id}
        value={places}
        onSaved={(v) => {
          setPlaces(v);
          router.refresh();
        }}
      />

      <Card maxWidth={640} style={{ marginBottom: 20 }}>
        <SectionHeading>Planering</SectionHeading>
        <Form onSubmit={savePlanning}>
          <FormError>{error}</FormError>
          <FormRow columns={2}>
            <Field label="Styrning" htmlFor="stockControlled">
              <Select
                id="stockControlled"
                value={stockControlled}
                onChange={(e) => setStockControlled(e.target.value)}
              >
                <option value="order">Orderstyrd</option>
                <option value="stock">Lagerstyrd</option>
              </Select>
            </Field>
            <Field label="Säkerhetslager" htmlFor="safetyStock">
              <Input
                id="safetyStock"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={safetyStock}
                onChange={(e) => setSafetyStock(e.target.value)}
              />
            </Field>
          </FormRow>
          <FormRow columns={3}>
            <Field label="Beställningspunkt" htmlFor="reorderPoint">
              <Input
                id="reorderPoint"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={reorderPoint}
                onChange={(e) => setReorderPoint(e.target.value)}
              />
            </Field>
            <Field label="Orderkvantitet" htmlFor="orderQuantity">
              <Input
                id="orderQuantity"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={orderQuantity}
                onChange={(e) => setOrderQuantity(e.target.value)}
              />
            </Field>
            {/* Positive with at most 3 decimals — the server validates; step
                0.001 only sets the browser's stepping, min="0" keeps the step
                base whole (Firefox steps from min). */}
            <Field label="Avrundning" htmlFor="rounding">
              <Input
                id="rounding"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={rounding}
                onChange={(e) => setRounding(e.target.value)}
              />
            </Field>
            {article.type === "manufactured" && (
              <Field label="Ledtid (dagar)" htmlFor="manufacturingLeadTimeDays">
                <Input
                  id="manufacturingLeadTimeDays"
                  type="number"
                  size="sm"
                  min="0"
                  step="1"
                  value={leadTime}
                  onChange={(e) => setLeadTime(e.target.value)}
                />
              </Field>
            )}
          </FormRow>
          {article.type === "manufactured" && (
            <FormHint attached>
              Ledtid (dagar): tomt fält räknar ledtiden ur operationerna i rutten.
            </FormHint>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 0 4px" }}>
            <input type="checkbox" checked={forecastControlled} onChange={(e) => setForecastControlled(e.target.checked)} />
            Prognosstyrd
          </label>
          <FormHint attached>
            Prognosstyrd: behovsberäkningen planerar ett månadsbehov (snitt eller eget antal) för artikeln. Passar slutprodukter och
            reservdelar. Prognoskortet visas under Planering när artikeln är sparad som Prognosstyrd.
          </FormHint>
          {showBatchToggle && (
            <>
              <Field label="Spårning" htmlFor="tracking">
                <Select id="tracking" size="sm" value={tracking} onChange={(e) => setTracking(e.target.value as ArticleTracking)}>
                  <option value="none">Ingen</option>
                  <option value="batch">Batch</option>
                  <option value="serial">Serienummer</option>
                </Select>
              </Field>
              <FormHint attached>
                Batch: saldot hålls per batch. Befintligt saldo hamnar i batchen Okänd, som dras först; därefter
                dras batchen med kortast utgångsdatum först (utan datum: äldsta först). Batchnummer anges vid
                inleverans — tomt blir inköpsorderns nummer — och tillverkade varor får tillverkningsordernumret som batch.
                Serienummer: varje styck har ett eget nummer och saldot hålls per nummer.
              </FormHint>
              {tracking === "serial" && (
                <>
                  <FormRow columns={2}>
                    <Field label="Serienummer skapas" htmlFor="serialAssignedAt">
                      <Select
                        id="serialAssignedAt"
                        value={serialAssignedAt}
                        onChange={(e) => setSerialAssignedAt(e.target.value as "receipt" | "delivery")}
                      >
                        <option value="receipt">Vid inleverans</option>
                        <option value="delivery">Vid utleverans</option>
                      </Select>
                    </Field>
                    <Field label="Serienummerserie" htmlFor="serialSeriesKey">
                      <Select
                        id="serialSeriesKey"
                        value={newSeriesOpen ? "__new" : serialSeriesKey}
                        onChange={(e) => {
                          if (e.target.value === "__new") {
                            setNewSeriesOpen(true);
                            return;
                          }
                          setNewSeriesOpen(false);
                          setSerialSeriesKey(e.target.value);
                        }}
                      >
                        {serialSeries.length === 0 && <option value="">Serienummer</option>}
                        {serialSeries.map((o) => (
                          <option key={o.key} value={o.isDefault ? "" : o.key}>
                            {o.name ?? "Serienummer"}
                            {o.nextSerialNumber ? ` (nästa ${o.nextSerialNumber})` : " (full)"}
                            {o.isDefault ? " — gemensam" : ""}
                          </option>
                        ))}
                        <option value="__new">Ny serie…</option>
                      </Select>
                    </Field>
                  </FormRow>
                  <FormHint attached>
                    {serialAssignedAt === "receipt"
                      ? "Vid inleverans: numren skrivs eller skannas när varorna tas emot, och tillverkade varor får nästa nummer ur serien. Saldot hålls per nummer."
                      : "Vid utleverans: lagret räknas som vanligt utan nummer, och numret ges när varan levereras (förslag ur serien, som du kan ändra). Ett nummer som getts bränns — det ges aldrig igen, inte heller efter Ångra utleverans."}{" "}
                    Serierna hanteras under System → Nummerserier.
                  </FormHint>
                  {newSeriesOpen && (
                    <div style={{ display: "grid", gap: 8, margin: "8px 0" }}>
                      <FormError>{newSeriesError}</FormError>
                      <FormRow columns={3}>
                        <Field label="Namn" htmlFor="newSerialSeriesName">
                          <Input id="newSerialSeriesName" value={newSeriesName} onChange={(e) => setNewSeriesName(e.target.value)} />
                        </Field>
                        <Field label="Prefix" htmlFor="newSerialSeriesPrefix">
                          <Input
                            id="newSerialSeriesPrefix"
                            size="sm"
                            value={newSeriesPrefix}
                            onChange={(e) => setNewSeriesPrefix(e.target.value)}
                          />
                        </Field>
                        <Field label="Antal siffror" htmlFor="newSerialSeriesDigits">
                          <Input
                            id="newSerialSeriesDigits"
                            type="number"
                            min={0}
                            max={10}
                            size="xs"
                            value={newSeriesDigits}
                            onChange={(e) => setNewSeriesDigits(e.target.value)}
                          />
                        </Field>
                      </FormRow>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          disabled={newSeriesPending || newSeriesName.trim() === ""}
                          onClick={() => void createSerialSeries()}
                        >
                          {newSeriesPending ? "Skapar…" : "Skapa serie"}
                        </Button>
                        <Button type="button" variant="ghost" size="small" disabled={newSeriesPending} onClick={() => setNewSeriesOpen(false)}>
                          Avbryt
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {tracking === "batch" && (
                <>
                  <Field label="Hållbarhet (dagar)" htmlFor="shelfLifeDays">
                    <Input
                      id="shelfLifeDays"
                      type="number"
                      min="1"
                      step="1"
                      size="sm"
                      value={shelfLife}
                      onChange={(e) => setShelfLife(e.target.value)}
                    />
                  </Field>
                  <FormHint attached>
                    En tillverkad batch får inleveransdagen plus Hållbarhet som utgångsdatum. Tomt: inget datum.
                  </FormHint>
                </>
              )}
            </>
          )}
          <p style={{ margin: "12px 0 4px" }}>
            ABC-klass: <strong>{article.abcClass ?? "—"}</strong>
          </p>
          <FormHint attached>
            Klassen räknas på förbrukningsvärdet (förbrukat antal × standardpris) under perioden som anges i System →
            Inställningar (ABC — period). — betyder att artikeln står utanför klassningen.
          </FormHint>
          <FormHint attached>
            Används av behovsberäkningen. Beställningspunkt och Säkerhetslager jämförs mot projicerat saldo — det större av dem är golvet, och
            förslaget fyller upp till det. Styrning (Orderstyrd/Lagerstyrd) är bara information. Förslag avrundas upp till
            närmaste multipel av orderkvantiteten. Avrundning avrundar därefter förslag och orderrader (inköp,
            förfrågan, kundorder, tillverkningsorder) uppåt till närmaste multipel i grundenheten — 1 ger hela tal, 5
            ger 5, 10, 15 …, 7,38 ger hela stänger om 7,38 kg. Högst 3 decimaler.
          </FormHint>
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {saved && !pending && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        </Form>
      </Card>

      {article.forecastControlled && <ForecastCard articleId={article.id} unitCode={article.unit} />}

      <p style={{ margin: "0 0 12px" }}>
        <GatedLink href={`/lager/transaktioner?article=${article.id}`} style={{ color: "var(--accent-fg)" }}>
          Visa lagerlogg
        </GatedLink>
      </p>

      {stockSerial && batchBalances && batchBalances.batches.length > 0 && <SerialBalances batches={batchBalances.batches} />}

      {article.batchTracked && batchBalances && batchBalances.batches.length > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <SectionHeading>Saldo per batch</SectionHeading>
          <Table<{ id: string } & ArticleBatchBalances["batches"][number]>
            columns={[
              // Minimum widths: with minmax(0, …) the columns shrank to nothing
              // on the narrow card and the headers ran together (BATCHUTGÅNGSDATUM).
              { key: "batch", label: "Batch", width: "minmax(100px, 1fr)" },
              { key: "expiresOn", label: "Utgångsdatum", width: "minmax(120px, 150px)" },
              { key: "location", label: "Lagerplatser", width: "minmax(120px, 2fr)" },
              { key: "quantity", label: "Saldo", width: "minmax(80px, 120px)", align: "right" },
            ]}
            rows={batchBalances.batches.map((b) => ({ ...b, id: b.batchId ?? "unknown" }))}
            renderCell={(row, key) => {
              if (key === "batch") {
                return row.batchId ? (
                  <GatedLink href={`/lager/sparbarhet?batch=${row.batchId}`} style={{ color: "var(--accent-fg)" }}>
                    {row.batchNumber}
                  </GatedLink>
                ) : (
                  "Okänd"
                );
              }
              if (key === "expiresOn") {
                if (!row.expiresOn) return "—";
                return row.expired ? (
                  <span style={{ color: "var(--status-stopped-text)", fontWeight: 600 }}>{row.expiresOn} — utgången</span>
                ) : (
                  row.expiresOn
                );
              }
              if (key === "location") {
                return (
                  <span>
                    {row.locations.length === 0
                      ? "—"
                      : row.locations
                          .map(
                            (l) =>
                              `${l.locationName ? `${l.warehouseName ? `${l.warehouseName} · ` : ""}${l.locationName}` : "—"} (${formatQuantity(l.quantity)})${l.blocked ? " — spärrad" : ""}`
                          )
                          .join(", ")}
                  </span>
                );
              }
              return formatQuantity(row.total);
            }}
          />
        </Card>
      )}

      {balances.length === 0 ? (
        <p>Inget saldo registrerat för denna artikel.</p>
      ) : (
        <Table<RowWithId>
          columns={[
            { key: "warehouseName", label: "Lager", width: "1fr" },
            { key: "locationName", label: "Lagerplats", width: "1fr" },
            { key: "role", label: "Plats", width: "140px" },
            { key: "quantityOnHand", label: "Saldo", width: "140px", align: "right" },
          ]}
          rows={rows}
          renderCell={(row, key) => {
            if (key === "role") {
              return articleLocationRole(
                row.locationId,
                ownPrimaryLocationId(places.primary),
                places.alternatives.map((p) => p.locationId)
              );
            }
            if (key === "quantityOnHand") return formatQuantity(row.quantityOnHand);
            // Stock can be tracked without locations — those rows show "—".
            if (key === "locationName") {
              return (
                <span>
                  {row.locationName ?? "—"}
                  {row.locationBlocked && (
                    <span style={{ marginLeft: 8 }}>
                      <StatusPill status="stopped" label="Spärrad" compact />
                    </span>
                  )}
                </span>
              );
            }
            if (key === "warehouseName") return row[key as keyof RowWithId] ?? "—";
            return row[key as keyof RowWithId];
          }}
        />
      )}
    </div>
  );
}

// Saldo per serienummer: one row per place with the count and the numbers
// behind a fold (an article can have thousands); the stock from before the
// article got numbers (Okänd) is a count without a list.
function SerialBalances({ batches }: { batches: ArticleBatchBalances["batches"] }) {
  interface PlaceRow {
    id: string;
    place: string;
    blocked: boolean;
    numbers: { batchId: string; batchNumber: string }[];
    unknown: number;
  }
  const byPlace = new Map<string, PlaceRow>();
  for (const b of batches) {
    for (const l of b.locations) {
      const key = l.locationId ?? "none";
      const row = byPlace.get(key) ?? {
        id: key,
        place: l.locationName ? `${l.warehouseName ? `${l.warehouseName} · ` : ""}${l.locationName}` : "—",
        blocked: l.blocked,
        numbers: [],
        unknown: 0,
      };
      if (b.batchId && b.batchNumber) row.numbers.push({ batchId: b.batchId, batchNumber: b.batchNumber });
      else row.unknown += Number(l.quantity);
      byPlace.set(key, row);
    }
  }
  const rows = [...byPlace.values()].sort((a, b) => a.place.localeCompare(b.place, "sv", { numeric: true }));
  for (const r of rows) r.numbers.sort((a, b) => a.batchNumber.localeCompare(b.batchNumber, "sv", { numeric: true }));
  return (
    <Card style={{ marginBottom: 20 }}>
      <SectionHeading>Saldo per serienummer</SectionHeading>
      <Table<PlaceRow>
        columns={[
          { key: "place", label: "Lagerplats", width: "minmax(0, 1fr)" },
          { key: "count", label: "Antal", width: "minmax(70px, 100px)", align: "right" },
          { key: "numbers", label: "Serienummer", width: "minmax(0, 3fr)" },
        ]}
        rows={rows}
        renderCell={(row, key) => {
          if (key === "place") {
            return (
              <span>
                {row.place}
                {row.blocked && (
                  <span style={{ marginLeft: 8 }}>
                    <StatusPill status="stopped" label="Spärrad" compact />
                  </span>
                )}
              </span>
            );
          }
          if (key === "count") return formatQuantity(String(row.numbers.length + row.unknown));
          return (
            <details>
              <summary style={{ cursor: "pointer" }}>
                {row.numbers.length} serienummer{row.unknown > 0 ? ` + ${formatQuantity(String(row.unknown))} utan nummer (Okänd)` : ""}
              </summary>
              <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexWrap: "wrap", gap: "2px 12px", maxHeight: 200, overflowY: "auto" }}>
                {row.numbers.map((n) => (
                  <li key={n.batchId}>
                    <GatedLink href={`/lager/sparbarhet?batch=${n.batchId}`} style={{ color: "var(--accent-fg)" }}>
                      {n.batchNumber}
                    </GatedLink>
                  </li>
                ))}
              </ul>
            </details>
          );
        }}
      />
    </Card>
  );
}
