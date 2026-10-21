"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import type { Customer, Paged } from "../../lib/types";
import { ReportCsvLink } from "./ReportCsvLink";
import styles from "./OrderRegister.module.css";

// Mirror of QuoteFollowupReport in packages/shared/src/reports.ts (the web
// can't import @navet/shared).
type QuoteOutcome = "won" | "lost" | "open" | "cancelled";

interface Figures {
  count: number;
  value: number;
  won: number;
  wonValue: number;
  lost: number;
  lostValue: number;
  open: number;
  openValue: number;
  expired: number;
  expiredValue: number;
  cancelled: number;
  cancelledValue: number;
  hitRateCount: number | null;
  hitRateValue: number | null;
}

interface QuoteFollowupReport {
  from: string;
  to: string;
  customerId: string | null;
  totals: Figures;
  customers: (Figures & { customerId: string; customerNumber: string; customerName: string })[];
  months: (Figures & { month: string })[];
  lossReasons: { reasonId: string | null; code: string | null; name: string; count: number; value: number; share: number | null }[];
  quotes: {
    id: string;
    orderNumber: string;
    customerId: string;
    customerNumber: string;
    customerName: string;
    createdDate: string;
    quoteValidUntil: string | null;
    status: string;
    outcome: QuoteOutcome;
    expired: boolean;
    lostReason: { id: string; code: string; name: string } | null;
    lostNote: string | null;
    value: number;
  }[];
}

export interface QuoteFollowupDefaults {
  from: string;
  to: string;
  customerId?: string;
}

const ENDPOINT = "/api/v1/reports/quote-followup";

// Hit rates are fractions (0.6667); null (nothing won or lost) shows as –.
const percent = (rate: number | null) =>
  rate === null ? "–" : `${(rate * 100).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`;
const kr = (n: number) => `${formatMoney(n)} kr`;

function outcomeLabel(q: { outcome: QuoteOutcome; expired: boolean }): string {
  if (q.outcome === "won") return "Vunnen";
  if (q.outcome === "lost") return "Förlorad";
  if (q.outcome === "cancelled") return "Makulerad";
  return q.expired ? "Utgången" : "Öppen";
}

// Scrolls inside its own box on narrow screens so the page never grows wider
// than the screen.
function Scroller({ children }: { children: React.ReactNode }) {
  return <div style={{ overflowX: "auto", maxWidth: "100%" }}>{children}</div>;
}

// Offertuppföljning — filters live in the URL, the same query string drives
// the screen and the CSV.
export function QuoteFollowupPageClient({ defaults }: { defaults: QuoteFollowupDefaults }) {
  const router = useRouter();
  const pathname = usePathname();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [customerId, setCustomerId] = useState(defaults.customerId ?? "");
  const [customers, setCustomers] = useState<{ id: string; label: string }[]>([]);
  const [data, setData] = useState<QuoteFollowupReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Paged<Customer>>("/api/v1/customers?limit=1000")
      .then((page) => setCustomers(page.rows.map((c) => ({ id: c.id, label: `${c.customerNumber} ${c.name}` }))))
      .catch(() => setCustomers([]));
  }, []);

  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (customerId) qs.set("customerId", customerId);
  const qsString = qs.toString();
  const periodOk = from !== "" && to !== "" && from <= to;

  useEffect(() => {
    router.replace(`${pathname}?${qsString}`, { scroll: false });
    if (!periodOk) {
      setData(null);
      setLoading(false);
      setError(from === "" || to === "" ? "Ange både Från och Till" : "Från måste vara före Till");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<QuoteFollowupReport>(`${ENDPOINT}?${qsString}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(apiErrorMessage(err, "Kunde inte hämta offertuppföljningen"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable
  }, [qsString]);

  const t = data?.totals;

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <FormStack>
          <FormRow columns={3}>
            <Field label="Från" htmlFor="quoteFrom">
              <Input id="quoteFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Till" htmlFor="quoteTo">
              <Input id="quoteTo" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Kund" htmlFor="quoteCustomer">
              <Select id="quoteCustomer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Alla kunder</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
        </FormStack>
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar offertuppföljningen…</FormHint>}

      {data && t && !loading && (
        <>
          <KpiRow>
            <KpiTile label="Offerter" value={t.count} signal={kr(t.value)} />
            <KpiTile label="Vunna" value={t.won} signal={kr(t.wonValue)} />
            <KpiTile label="Förlorade" value={t.lost} signal={kr(t.lostValue)} />
            <KpiTile label="Öppna" value={t.open} signal={`varav ${t.expired.toLocaleString("sv-SE")} utgångna`} />
            <KpiTile label="Makulerade" value={t.cancelled} />
            <KpiTile label="Hit rate (antal)" value={percent(t.hitRateCount)} />
            <KpiTile label="Hit rate (värde)" value={percent(t.hitRateValue)} />
          </KpiRow>
          <FormHint>
            Hit rate = vunna / (vunna + förlorade); makulerade offerter räknas inte. Värdet är radernas nuvarande värde
            exkl. moms.
          </FormHint>

          <div className={styles.actions} style={{ margin: "16px 0 0" }}>
            <ReportCsvLink path={`${ENDPOINT}/csv?${qsString}`} />
          </div>

          <SectionHeading>Per kund</SectionHeading>
          <Scroller>
            <Table
              columns={[
                { key: "customer", label: "Kund", width: "minmax(160px, 1fr)" },
                { key: "count", label: "Offerter", width: "75px", align: "right" },
                { key: "value", label: "Värde", width: "115px", align: "right" },
                { key: "won", label: "Vunna", width: "70px", align: "right" },
                { key: "lost", label: "Förlorade", width: "85px", align: "right" },
                { key: "open", label: "Öppna", width: "70px", align: "right" },
                { key: "hitCount", label: "Hit rate (antal)", width: "110px", align: "right" },
                { key: "hitValue", label: "Hit rate (värde)", width: "110px", align: "right" },
              ]}
              rows={data.customers.map((c) => ({ ...c, id: c.customerId }))}
              emptyText="Inga offerter i urvalet."
              renderCell={(c, key) => {
                switch (key) {
                  case "customer":
                    return `${c.customerNumber} ${c.customerName}`;
                  case "count":
                    return <span className="num">{c.count}</span>;
                  case "value":
                    return <span className="num">{kr(c.value)}</span>;
                  case "won":
                    return <span className="num">{c.won}</span>;
                  case "lost":
                    return <span className="num">{c.lost}</span>;
                  case "open":
                    return <span className="num">{c.open}</span>;
                  case "hitCount":
                    return <span className="num">{percent(c.hitRateCount)}</span>;
                  case "hitValue":
                    return <span className="num">{percent(c.hitRateValue)}</span>;
                  default:
                    return null;
                }
              }}
            />
          </Scroller>

          <SectionHeading spaced>Per månad</SectionHeading>
          <Scroller>
            <Table
              columns={[
                { key: "month", label: "Månad", width: "minmax(100px, 1fr)" },
                { key: "count", label: "Offerter", width: "75px", align: "right" },
                { key: "value", label: "Värde", width: "115px", align: "right" },
                { key: "won", label: "Vunna", width: "70px", align: "right" },
                { key: "lost", label: "Förlorade", width: "85px", align: "right" },
                { key: "open", label: "Öppna", width: "70px", align: "right" },
                { key: "hitCount", label: "Hit rate (antal)", width: "110px", align: "right" },
                { key: "hitValue", label: "Hit rate (värde)", width: "110px", align: "right" },
              ]}
              rows={data.months.map((m) => ({ ...m, id: m.month }))}
              emptyText="Inga offerter i urvalet."
              renderCell={(m, key) => {
                switch (key) {
                  case "month":
                    return <span className="num">{m.month}</span>;
                  case "count":
                    return <span className="num">{m.count}</span>;
                  case "value":
                    return <span className="num">{kr(m.value)}</span>;
                  case "won":
                    return <span className="num">{m.won}</span>;
                  case "lost":
                    return <span className="num">{m.lost}</span>;
                  case "open":
                    return <span className="num">{m.open}</span>;
                  case "hitCount":
                    return <span className="num">{percent(m.hitRateCount)}</span>;
                  case "hitValue":
                    return <span className="num">{percent(m.hitRateValue)}</span>;
                  default:
                    return null;
                }
              }}
            />
          </Scroller>

          <SectionHeading spaced>Per förlustorsak</SectionHeading>
          <Scroller>
            <Table
              columns={[
                { key: "reason", label: "Förlustorsak", width: "minmax(160px, 1fr)" },
                { key: "count", label: "Antal", width: "75px", align: "right" },
                { key: "value", label: "Värde", width: "115px", align: "right" },
                { key: "share", label: "Andel av förlorade", width: "130px", align: "right" },
              ]}
              rows={data.lossReasons.map((r) => ({ ...r, id: r.reasonId ?? "none" }))}
              emptyText="Inga förlorade offerter i urvalet."
              renderCell={(r, key) => {
                switch (key) {
                  case "reason":
                    return r.code ? `${r.code} · ${r.name}` : r.name;
                  case "count":
                    return <span className="num">{r.count}</span>;
                  case "value":
                    return <span className="num">{kr(r.value)}</span>;
                  case "share":
                    return <span className="num">{percent(r.share)}</span>;
                  default:
                    return null;
                }
              }}
            />
          </Scroller>

          <SectionHeading spaced>Offerter</SectionHeading>
          <Scroller>
            <Table
              columns={[
                { key: "orderNumber", label: "Offert", width: "100px" },
                { key: "customer", label: "Kund", width: "minmax(140px, 1fr)" },
                { key: "createdDate", label: "Skapad", width: "95px" },
                { key: "validUntil", label: "Giltig t.o.m.", width: "105px" },
                { key: "outcome", label: "Utfall", width: "95px" },
                { key: "reason", label: "Orsak", width: "minmax(120px, 1fr)" },
                { key: "value", label: "Värde", width: "115px", align: "right" },
              ]}
              rows={data.quotes}
              emptyText="Inga offerter i urvalet."
              renderCell={(q, key) => {
                switch (key) {
                  case "orderNumber":
                    return (
                      <GatedLink href={`/forsaljning/ordrar/${q.id}`} className={styles.orderLink}>
                        {q.orderNumber}
                      </GatedLink>
                    );
                  case "customer":
                    return `${q.customerNumber} ${q.customerName}`;
                  case "createdDate":
                    return <span className="num">{q.createdDate}</span>;
                  case "validUntil":
                    return <span className="num">{q.quoteValidUntil ?? "–"}</span>;
                  case "outcome":
                    return outcomeLabel(q);
                  case "reason":
                    return q.outcome === "lost" ? (
                      <div>
                        <div>{q.lostReason ? q.lostReason.name : "Ingen orsak angiven"}</div>
                        {q.lostNote && <div className={styles.muted}>{q.lostNote}</div>}
                      </div>
                    ) : (
                      "–"
                    );
                  case "value":
                    return <span className="num">{kr(q.value)}</span>;
                  default:
                    return null;
                }
              }}
            />
          </Scroller>
        </>
      )}
    </>
  );
}
