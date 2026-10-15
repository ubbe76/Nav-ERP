import { headers } from "next/headers";
import Link from "next/link";
import { ArticleOverviewButton } from "../../../components/articles/ArticleOverviewButton";
import { AppShell } from "../../../components/AppShell";
import { Table } from "../../../components/ui/Table";
import { ListExportLink, ListToolbar, Pagination } from "../../../components/ui/ListControls";
import buttonStyles from "../../../components/ui/Button.module.css";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, StockBalance } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

interface RowWithId extends StockBalance {
  id: string;
}

export default async function StockPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const balancesPage = await apiGet<Paged<StockBalance>>(
    `/api/v1/stock/balances${listApiQuery(searchParams, [], pageSize)}`,
    cookieHeader
  );
  const balances: RowWithId[] = balancesPage.rows.map((b) => ({ ...b, id: `${b.articleId}-${b.locationId}` }));

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Lager</div>
          <div className={shellStyles.meta}>{balancesPage.total.toLocaleString("sv-SE")} saldorader</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/lager/platser" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Lagerplatser
          </Link>
          <Link href="/lager/transaktioner" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Transaktioner
          </Link>
          <Link href="/lager/flytta" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Lagerflytt
          </Link>
          <Link href="/lager/justering" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            + Justering
          </Link>
          <Link href="/lager/inventering" className={`${buttonStyles.button} ${buttonStyles.primary}`}>
            Inventering
          </Link>
          <HelpLink chapter="lager" anchor="saldon" label="Hjälp om lagersaldon" />
        </div>
      </div>

      <ListToolbar placeholder="Sök artikelnummer eller benämning…">
        <ListExportLink endpoint="/api/v1/stock/balances/csv" />
      </ListToolbar>

      <Table<RowWithId>
        columns={[
          { key: "articleNumber", label: "Artikelnummer", width: "160px" },
          { key: "articleName", label: "Benämning", width: "1fr" },
          { key: "warehouseName", label: "Lager", width: "160px" },
          { key: "locationName", label: "Lagerplats", width: "160px" },
          { key: "quantityOnHand", label: "Saldo", width: "110px", align: "right" },
          { key: "id", label: "", width: "90px", align: "right" },
        ]}
        rows={balances}
        emptyText="Inga saldorader matchar sökningen"
        renderCell={(row, key) => {
          switch (key) {
            case "articleNumber":
              return (
                <>
                  {row.articleNumber}
                  <ArticleOverviewButton articleId={row.articleId} articleNumber={row.articleNumber} />
                </>
              );
            case "quantityOnHand":
              return Number(row.quantityOnHand);
            // Stock can be tracked without locations — those rows show "—".
            case "warehouseName":
            case "locationName":
              return row[key as keyof RowWithId] ?? "—";
            case "id":
              return row.locationId ? (
                <Link href={`/lager/flytta?from=${row.locationId}&article=${row.articleId}`}>Flytta</Link>
              ) : null;
            default:
              return row[key as keyof RowWithId];
          }
        }}
      />

      <Pagination total={balancesPage.total} pageSize={pageSize} />
    </AppShell>
  );
}
