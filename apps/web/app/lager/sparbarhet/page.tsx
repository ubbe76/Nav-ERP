import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { BatchesList } from "../../../components/stock/BatchesList";
import { BatchDates } from "../../../components/stock/BatchDates";
import { BatchTraceView } from "../../../components/stock/BatchTraceView";
import { Pagination } from "../../../components/ui/ListControls";
import buttonStyles from "../../../components/ui/Button.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { BatchTrace, Paged, StockBatchListRow } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lager → Spårbarhet (#8): without ?batch= a searchable batch list, with it
// the batch's trace — backward (where it came from) and forward (where it went).
export default async function TraceabilityPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const rawBatch = typeof searchParams.batch === "string" ? searchParams.batch : undefined;
  const batchId = rawBatch && UUID_RE.test(rawBatch) ? rawBatch : undefined;

  const trace = batchId
    ? await apiGet<BatchTrace>(`/api/v1/stock/batches/${encodeURIComponent(batchId)}/trace`, cookieHeader).catch(() => null)
    : null;
  const list = batchId
    ? null
    : await apiGet<Paged<StockBatchListRow>>(`/api/v1/stock/batches${listApiQuery(searchParams, ["expiry", "kind"], pageSize)}`, cookieHeader);

  // A search that finds exactly one batch opens its trace (the batch links in
  // the log and on the receipt are ?search=<number>).
  const search = typeof searchParams.search === "string" ? searchParams.search.trim() : "";
  if (list && search !== "" && list.total === 1 && list.rows[0]) redirect(`/lager/sparbarhet?batch=${list.rows[0].id}`);

  const serialRoot = trace?.batch.kind === "serial";
  const title = trace ? `${serialRoot ? "Serienummer" : "Batch"} ${trace.batch.batchNumber ?? "Okänd"}` : "Spårbarhet";
  const meta = trace
    ? `${trace.batch.articleNumber} ${trace.batch.articleName}${trace.batch.burnt ? " — Bränt (utleveransen ångrad)" : ""}`
    : `${(list?.total ?? 0).toLocaleString("sv-SE")} träffar`;

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{title}</div>
          <div className={shellStyles.meta}>{meta}</div>
        </div>
        <div className={shellStyles.topbarActions}>
          {batchId && (
            <>
              <Link href="/lager/sparbarhet" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
                Alla batcher och serienummer
              </Link>
              <Link href={`/lager/transaktioner?batch=${batchId}`} className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
                Lagerlogg
              </Link>
            </>
          )}
          <HelpLink chapter="lager" anchor="batchnummer-och-sparbarhet" label="Hjälp om spårbarhet" />
        </div>
      </div>

      {batchId && !trace && <p>Batchen eller serienumret hittades inte.</p>}
      {trace && (
        <>
          <BatchDates batch={trace.batch} />
          <BatchTraceView trace={trace} />
        </>
      )}
      {list && (
        <>
          <BatchesList rows={list.rows} />
          <Pagination total={list.total} pageSize={pageSize} />
        </>
      )}
    </AppShell>
  );
}
