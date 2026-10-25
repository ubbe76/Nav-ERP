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
import { SALES_ORDER_STATUS_PILL } from "../../lib/types";
import type { Project, SalesOrderStatus } from "../../lib/types";
import { ReportCsvLink } from "./ReportCsvLink";
import styles from "./OrderRegister.module.css";

// Mirror of GET /reports/project-report (bokföringsgranskningen etapp 5 del A).
interface ProjectReport {
  project: { id: string; code: string; name: string };
  // Echo of the range; with no range given the API answers the first/last
  // booked day, or null when the project has no booked rows.
  from: string | null;
  to: string | null;
  revenue: number;
  costs: number;
  result: number;
  months: { month: string; revenue: number; costs: number; result: number }[];
  accounts: { accountNumber: string; accountName: string; amount: number }[];
  salesOrders: { id: string; orderNumber: string; status: string; value: number }[];
}

export interface ProjectReportDefaults {
  projectId?: string;
  from?: string;
  to?: string;
}

const ENDPOINT = "/api/v1/reports/project-report";
const kr = (n: number) => `${formatMoney(n)} kr`;

// "alla datum" when the project has no booked rows (the API echoes null).
function rangeText(from: string | null, to: string | null): string {
  if (from && to) return `${from} till och med ${to}`;
  if (from) return `från ${from}`;
  if (to) return `till och med ${to}`;
  return "alla datum";
}

function Scroller({ children }: { children: React.ReactNode }) {
  return <div style={{ overflowX: "auto", maxWidth: "100%" }}>{children}</div>;
}

// Projektrapport — per project the revenue, costs and result out of the
// bookkeeping, per month and per account, plus the linked customer orders.
// Filters live in the URL; the same query string drives the screen and the CSV.
export function ProjectReportPageClient({ defaults }: { defaults: ProjectReportDefaults }) {
  const router = useRouter();
  const pathname = usePathname();
  const [projectId, setProjectId] = useState(defaults.projectId ?? "");
  const [from, setFrom] = useState(defaults.from ?? "");
  const [to, setTo] = useState(defaults.to ?? "");
  const [projects, setProjects] = useState<Project[]>([]);
  const [data, setData] = useState<ProjectReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ rows: Project[] }>("/api/v1/projects?includeInactive=true&limit=1000")
      .then((page) => setProjects(page.rows))
      .catch(() => setProjects([]));
  }, []);

  const qs = new URLSearchParams();
  if (projectId) qs.set("projectId", projectId);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const qsString = qs.toString();

  useEffect(() => {
    router.replace(qsString ? `${pathname}?${qsString}` : pathname, { scroll: false });
    if (!projectId) {
      setData(null);
      setError(null);
      return;
    }
    if (from && to && from > to) {
      setData(null);
      setError("Från måste vara före Till");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ProjectReport>(`${ENDPOINT}?${qsString}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(apiErrorMessage(err, "Kunde inte hämta projektrapporten"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable
  }, [qsString]);

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <FormStack>
          <FormRow columns={3}>
            <Field label="Projekt" htmlFor="projectReportProject">
              <Select id="projectReportProject" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">— Välj projekt —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                    {p.status === "closed" ? " (stängt)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Från" htmlFor="projectReportFrom">
              <Input id="projectReportFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Till" htmlFor="projectReportTo">
              <Input id="projectReportTo" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </FormRow>
          <FormHint>Lämna Från och Till tomma för hela projektets bokföring.</FormHint>
        </FormStack>
      </Card>

      <FormError margin="below">{error}</FormError>
      {!projectId && <p>Välj ett projekt för att se dess intäkter, kostnader och resultat.</p>}
      {loading && <FormHint>Hämtar projektrapporten…</FormHint>}

      {data && !loading && (
        <>
          <KpiRow>
            <KpiTile label="Intäkter" value={kr(data.revenue)} />
            <KpiTile label="Kostnader" value={kr(data.costs)} />
            <KpiTile label="Resultat" value={kr(data.result)} signal={`${data.project.code} · ${data.project.name}`} tone={data.result < 0 ? "alert" : "neutral"} />
          </KpiRow>
          <FormHint>
            Intäkter och kostnader är de bokförda verifikatraderna som bär projektet — {rangeText(data.from, data.to)}.
            Kundordrarna nedan är de som har projektet i sitt huvud.
          </FormHint>

          <div className={styles.actions} style={{ margin: "16px 0 0" }}>
            <ReportCsvLink path={`${ENDPOINT}/csv?${qsString}`} />
          </div>

          <SectionHeading>Per månad</SectionHeading>
          <Scroller>
            <Table
              columns={[
                { key: "month", label: "Månad", width: "minmax(100px, 1fr)" },
                { key: "revenue", label: "Intäkter", width: "130px", align: "right" },
                { key: "costs", label: "Kostnader", width: "130px", align: "right" },
                { key: "result", label: "Resultat", width: "130px", align: "right" },
              ]}
              rows={data.months.map((m) => ({ ...m, id: m.month }))}
              emptyText="Inga bokningar på projektet i perioden."
              footer={{
                month: "Totalt",
                revenue: formatMoney(data.revenue),
                costs: formatMoney(data.costs),
                result: formatMoney(data.result),
              }}
              renderCell={(m, key) => {
                switch (key) {
                  case "month":
                    return <span className="num">{m.month}</span>;
                  case "revenue":
                    return <span className="num">{formatMoney(m.revenue)}</span>;
                  case "costs":
                    return <span className="num">{formatMoney(m.costs)}</span>;
                  case "result":
                    return <span className="num">{formatMoney(m.result)}</span>;
                  default:
                    return null;
                }
              }}
            />
          </Scroller>

          <SectionHeading spaced>Per konto</SectionHeading>
          <Scroller>
            <Table
              columns={[
                { key: "account", label: "Konto", width: "minmax(200px, 1fr)" },
                { key: "amount", label: "Belopp", width: "140px", align: "right" },
              ]}
              rows={data.accounts.map((a) => ({ ...a, id: a.accountNumber }))}
              emptyText="Inga bokningar på projektet i perioden."
              renderCell={(a, key) => {
                switch (key) {
                  case "account":
                    return `${a.accountNumber} · ${a.accountName}`;
                  case "amount":
                    return <span className="num">{formatMoney(a.amount)}</span>;
                  default:
                    return null;
                }
              }}
            />
          </Scroller>

          <SectionHeading spaced>Kundordrar på projektet</SectionHeading>
          <Scroller>
            <Table
              columns={[
                { key: "order", label: "Order", width: "minmax(120px, 1fr)" },
                { key: "status", label: "Status", width: "160px" },
                { key: "value", label: "Värde", width: "140px", align: "right" },
              ]}
              rows={data.salesOrders}
              emptyText="Inga kundordrar är kopplade till projektet."
              renderCell={(o, key) => {
                switch (key) {
                  case "order":
                    return <GatedLink href={`/forsaljning/ordrar/${o.id}`}>{o.orderNumber}</GatedLink>;
                  case "status":
                    return SALES_ORDER_STATUS_PILL[o.status as SalesOrderStatus]?.label ?? o.status;
                  case "value":
                    return <span className="num">{kr(o.value)}</span>;
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
