import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "../../../components/AppShell";
import { StockTransactionsView } from "../../../components/stock/StockTransactionsView";
import buttonStyles from "../../../components/ui/Button.module.css";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import { STOCK_TRANSACTION_TYPE_LABELS, type Article, type Paged, type StockLocation, type StockTransaction } from "../../../lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function StockTransactionsPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();

  // The URL speaks ?article=&location=; the API wants articleId/locationId.
  // Every value is validated here and silently dropped when malformed, so a
  // hand-edited URL renders unfiltered instead of an API 400 / error page.
  const single = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : undefined);
  const uuid = (v: string | undefined) => (v && UUID_RE.test(v) ? v : undefined);
  const day = (v: string | undefined) => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : undefined;
  };
  const type = single(searchParams.type);
  const direction = single(searchParams.direction);
  const articleId = uuid(single(searchParams.article));
  const locationId = uuid(single(searchParams.location));
  const clean: PageSearchParams = {
    search: searchParams.search,
    page: searchParams.page,
    type: type && Object.hasOwn(STOCK_TRANSACTION_TYPE_LABELS, type) ? type : undefined,
    direction: direction === "in" || direction === "out" ? direction : undefined,
    from: day(single(searchParams.from)),
    to: day(single(searchParams.to)),
  };
  const apiParams = new URLSearchParams(listApiQuery(clean, ["type", "direction", "from", "to"], pageSize));
  if (articleId) apiParams.set("articleId", articleId);
  if (locationId) apiParams.set("locationId", locationId);

  const [transactions, locations, article] = await Promise.all([
    apiGet<Paged<StockTransaction>>(`/api/v1/stock/transactions?${apiParams.toString()}`, cookieHeader),
    apiGet<StockLocation[]>("/api/v1/stock/locations?includeInactive=true", cookieHeader),
    articleId ? apiGet<Article>(`/api/v1/articles/${encodeURIComponent(articleId)}`, cookieHeader).catch(() => null) : Promise.resolve(null),
  ]);

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Transaktioner</div>
          <div className={shellStyles.meta}>{transactions.total.toLocaleString("sv-SE")} transaktioner</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/lager/saldon" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Lager
          </Link>
          <Link href="/lager/justering" className={`${buttonStyles.button} ${buttonStyles.primary}`}>
            + Justering
          </Link>
          <HelpLink chapter="lager" anchor="transaktioner" label="Hjälp om lagertransaktioner" />
        </div>
      </div>

      <StockTransactionsView transactions={transactions} locations={locations} article={article ? { id: article.id, articleNumber: article.articleNumber, name: article.name } : null} pageSize={pageSize} />
    </AppShell>
  );
}
