import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "../../../components/AppShell";
import { Table } from "../../../components/ui/Table";
import { ListExportLink, ListToolbar, ListFilterSelect, Pagination } from "../../../components/ui/ListControls";
import { StatusPill } from "../../../components/ui/StatusPill";
import buttonStyles from "../../../components/ui/Button.module.css";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import { STOCK_COUNT_STATUS_LABELS, type Paged, type StockCountSession } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

const PILL_STATUS = { open: "running", posted: "done", cancelled: "stopped" } as const;

// Admin-gated like /lager/vardering — the API requires admin on /stock-counts.
export default async function StockCountListPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Lager">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  const sessions = await apiGet<Paged<StockCountSession>>(
    `/api/v1/stock-counts${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Inventering</div>
          <div className={shellStyles.meta}>{sessions.total.toLocaleString("sv-SE")} inventeringar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/lager/inventering/ny" className={`${buttonStyles.button} ${buttonStyles.primary}`}>
            + Ny inventering
          </Link>
          <HelpLink chapter="lager" anchor="inventering" label="Hjälp om inventering" />
        </div>
      </div>

      <ListToolbar placeholder="Sök INV-nummer eller lagerplats…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(STOCK_COUNT_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ListExportLink endpoint="/api/v1/stock-counts/csv" />
      </ListToolbar>

      <Table<StockCountSession>
        columns={[
          { key: "countNumber", label: "Nummer", width: "120px" },
          { key: "location", label: "Lagerplats", width: "1fr" },
          { key: "status", label: "Status", width: "130px" },
          { key: "blocksTransactions", label: "Spärr", width: "90px" },
          { key: "counted", label: "Räknade", width: "110px", align: "right" },
          { key: "createdAt", label: "Skapad", width: "160px" },
        ]}
        rows={sessions.rows}
        emptyText="Inga inventeringar ännu"
        renderCell={(row, key) => {
          switch (key) {
            case "countNumber":
              return <Link href={`/lager/inventering/${row.id}`}>{row.countNumber}</Link>;
            case "location":
              return `${row.warehouseName} — ${row.locationName}`;
            case "status":
              return <StatusPill status={PILL_STATUS[row.status]} label={STOCK_COUNT_STATUS_LABELS[row.status]} compact />;
            case "blocksTransactions":
              return row.blocksTransactions ? "Ja" : "Nej";
            case "counted":
              return `${row.countedCount} / ${row.rowCount}`;
            case "createdAt":
              return new Date(row.createdAt).toLocaleString("sv-SE");
            default:
              return null;
          }
        }}
      />

      <Pagination total={sessions.total} pageSize={pageSize} />
    </AppShell>
  );
}
