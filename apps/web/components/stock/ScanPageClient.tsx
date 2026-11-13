"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "../ui/Card";
import { GatedLink } from "../ui/GatedLink";
import { ScanInput } from "../ui/ScanInput";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatQuantity } from "../../lib/format";
import { StatusPill } from "../ui/StatusPill";
import {
  MANUFACTURING_ORDER_STATUS_PILL,
  PURCHASE_ORDER_STATUS_PILL,
  SALES_ORDER_STATUS_PILL,
  type ManufacturingOrderStatus,
  type Paged,
  type PurchaseOrderStatus,
  type SalesOrderStatus,
  type ScanMatch,
  type ScanResult,
  type StockBalance,
} from "../../lib/types";
import styles from "./ScanPageClient.module.css";

type Balance = StockBalance & { id: string };

// A quantity with the article's base unit (the scan answer carries none).
function QuantityWithUnit({ articleId, quantity }: { articleId: string; quantity: number }) {
  const [unit, setUnit] = useState("");
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ unit: string }>(`/api/v1/articles/${articleId}`)
      .then((a) => {
        if (!cancelled) setUnit(a.unit);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [articleId]);
  return <>{`${formatQuantity(quantity)} ${unit}`.trim()}</>;
}

// Lager → Skanna: scan anything and see what it is. The last result stays
// until the next scan replaces it.
export function ScanPageClient() {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A slow answer for an earlier scan must not overwrite a newer one.
  const sequence = useRef(0);

  async function onScan(code: string) {
    const mine = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const found = await apiFetch<ScanResult>(`/api/v1/scan?code=${encodeURIComponent(code)}`);
      if (mine === sequence.current) setResult(found);
    } catch (err) {
      if (mine === sequence.current) setError(apiErrorMessage(err, "Kunde inte slå upp koden"));
    } finally {
      if (mine === sequence.current) setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <ScanInput autoFocus onScan={(code) => void onScan(code)} />
      {error && <p className={styles.error}>{error}</p>}
      {loading && <p className={styles.muted}>Söker…</p>}
      {result?.gs1 && (
        <p className={styles.muted}>
          GS1-kod
          {result.gs1.gtin ? ` · GTIN ${result.gs1.gtin}` : ""}
          {result.gs1.batch ? ` · batch ${result.gs1.batch}` : ""}
          {result.gs1.serial ? ` · serienummer ${result.gs1.serial}` : ""}
          {result.gs1.expiresOn ? ` · utgångsdatum ${result.gs1.expiresOn}` : ""}
          {result.gs1.quantity !== null ? ` · antal ${result.gs1.quantity}` : ""}
        </p>
      )}
      {result && (
        <div className={styles.cards}>
          {result.matches.length === 0 ? (
            <Card maxWidth="none">
              <p className={styles.title}>Ingen träff för {result.gs1 ? "koden" : result.code}</p>
            </Card>
          ) : (
            result.matches.map((m) => <MatchCard key={`${m.kind}-${m.id}`} match={m} />)
          )}
        </div>
      )}
    </div>
  );
}

function MatchCard({ match }: { match: ScanMatch }) {
  switch (match.kind) {
    case "article":
      return (
        <Card maxWidth="none">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.kind}>Artikel{match.active ? "" : " · Inaktiv"}</div>
              <div className={styles.title}>
                {match.articleNumber} · {match.name}
              </div>
            </div>
            <GatedLink href={`/artiklar/${match.id}`} className={styles.link}>
              Öppna artikelkortet
            </GatedLink>
          </div>
          <SectionHeading>Saldo per lagerplats</SectionHeading>
          <Balances query={`articleId=${match.id}&limit=100`} mode="article" unit={match.unitCode} />
        </Card>
      );
    case "location":
      return (
        <Card maxWidth="none">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.kind}>
                Lagerplats{match.active ? "" : " · Inaktiv"}
                {match.blocked && " · Spärrad"}
              </div>
              <div className={styles.title}>
                {match.labelCode} · {match.warehouseName} / {match.name}
              </div>
            </div>
            <GatedLink href="/lager/platser" className={styles.link}>
              Lagerplatser
            </GatedLink>
          </div>
          <SectionHeading>Innehåll</SectionHeading>
          <Balances query={`locationId=${match.id}&limit=200`} mode="location" />
        </Card>
      );
    case "batch":
      return (
        <Card maxWidth="none">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.kind}>{match.batchKind === "serial" ? "Serienummer" : "Batch"}</div>
              <div className={styles.title}>{match.batchNumber}</div>
              <div className={styles.sub}>
                {match.articleNumber} · {match.articleName}
                {match.expiresOn ? ` · utgångsdatum ${match.expiresOn}` : ""}
              </div>
            </div>
            <GatedLink href={`/lager/sparbarhet?batch=${match.id}`} className={styles.link}>
              Öppna spårningen
            </GatedLink>
          </div>
          <SectionHeading>Saldo per lagerplats</SectionHeading>
          {match.locations.length === 0 ? (
            <p className={styles.muted}>Inget i lager</p>
          ) : (
            <Table<{ id: string; place: string; blocked: boolean; quantity: number }>
              columns={[
                { key: "place", label: "Lagerplats", width: "1fr" },
                { key: "quantity", label: "Saldo", width: "110px", align: "right" },
              ]}
              rows={match.locations.map((l) => ({
                id: l.locationId,
                place: `${l.warehouseName} / ${l.locationName}`,
                blocked: l.blocked,
                quantity: l.quantity,
              }))}
              renderCell={(row, key) =>
                key === "place" ? (
                  <>
                    {row.place}
                    {row.blocked && (
                      <span style={{ marginLeft: 8 }}>
                        <StatusPill status="stopped" label="Spärrad" compact />
                      </span>
                    )}
                  </>
                ) : (
                  <QuantityWithUnit articleId={match.articleId} quantity={row.quantity} />
                )
              }
            />
          )}
        </Card>
      );
    case "purchaseOrder":
      return (
        <OrderCard
          kind="Inköpsorder"
          href={`/inkop/ordrar/${match.id}`}
          number={match.orderNumber}
          sub={match.partyName}
          pill={PURCHASE_ORDER_STATUS_PILL[match.status as PurchaseOrderStatus]}
        />
      );
    case "salesOrder":
      return (
        <OrderCard
          kind="Kundorder"
          href={`/forsaljning/ordrar/${match.id}`}
          number={match.orderNumber}
          sub={match.partyName}
          pill={SALES_ORDER_STATUS_PILL[match.status as SalesOrderStatus]}
        />
      );
    case "manufacturingOrder":
      return (
        <OrderCard
          kind="Tillverkningsorder"
          href={`/tillverkning/ordrar/${match.id}`}
          number={match.orderNumber}
          sub={`${match.articleNumber} · ${match.articleName}`}
          pill={MANUFACTURING_ORDER_STATUS_PILL[match.status as ManufacturingOrderStatus]}
        />
      );
  }
}

// The order's status as the order lists show it; undefined only for a status
// the web does not know yet, which then shows nothing rather than a code.
type Pill = { status: "running" | "delayed" | "stopped" | "done" | "draft"; label: string } | undefined;

function OrderCard({ kind, href, number, sub, pill }: { kind: string; href: string; number: string; sub: string; pill: Pill }) {
  return (
    <Card maxWidth="none">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.kind}>{kind}</div>
          <div className={styles.title}>{number}</div>
          <div className={styles.sub}>{sub}</div>
          {pill && <StatusPill status={pill.status} label={pill.label} compact />}
        </div>
        <GatedLink href={href} className={styles.link}>
          Öppna ordern
        </GatedLink>
      </div>
    </Card>
  );
}

// Balance rows for the matched article (per location) or location (per article).
function Balances({ query, mode, unit }: { query: string; mode: "article" | "location"; unit?: string }) {
  const [state, setState] = useState<{ rows: Balance[]; total: number } | "failed" | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Paged<StockBalance>>(`/api/v1/stock/balances?${query}`)
      .then((page) => {
        if (cancelled) return;
        setState({ rows: page.rows.map((b) => ({ ...b, id: `${b.articleId}-${b.locationId ?? "none"}` })), total: page.total });
      })
      .catch(() => !cancelled && setState("failed"));
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (state === null) return <p className={styles.muted}>Hämtar saldo…</p>;
  if (state === "failed") return <p className={styles.error}>Kunde inte hämta saldot</p>;
  const first = mode === "article";
  return (
    <>
      <Table<Balance>
        columns={[
          first
            ? { key: "place", label: "Lagerplats", width: "1fr" }
            : { key: "article", label: "Artikel", width: "1fr" },
          { key: "quantity", label: "Saldo", width: "110px", align: "right" },
        ]}
        rows={state.rows}
        emptyText={first ? "Inget saldo på någon lagerplats" : "Inga artiklar på lagerplatsen"}
        renderCell={(row, key) => {
          if (key === "place") {
            return row.locationName ? (
              <>
                {row.warehouseName} / {row.locationName}
                {row.locationBlocked && (
                  <span style={{ marginLeft: 8 }}>
                    <StatusPill status="stopped" label="Spärrad" compact />
                  </span>
                )}
              </>
            ) : (
              "Ingen lagerplats"
            );
          }
          if (key === "article") return `${row.articleNumber} · ${row.articleName}`;
          return `${formatQuantity(Number(row.quantityOnHand))}${unit ? ` ${unit}` : ""}`;
        }}
      />
      {state.total > state.rows.length && (
        <p className={styles.muted}>Visar {state.rows.length} av {state.total} rader.</p>
      )}
    </>
  );
}
