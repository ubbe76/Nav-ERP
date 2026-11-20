import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SplitListPage } from "../../../components/split/SplitListPage";
import { TableView } from "../../../components/split/ListViewToggle";
import { listPageView } from "../../../lib/listViewServer";
import { ArticlesPageClient } from "../../../components/articles/ArticlesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Article, ArticleGroup, Paged, RegisterEntry } from "../../../lib/types";

export default async function ArticlesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/artiklar/register", searchParams)) === "list") return <SplitListPage list="/artiklar/register" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [articles, groups, articleCodes] = await Promise.all([
    apiGet<Paged<Article>>(`/api/v1/articles${listApiQuery(searchParams, ["type", "groupId", "articleCodeId", "abcClass", "copied"], pageSize)}&withAbc=true`, cookieHeader),
    apiGet<ArticleGroup[]>("/api/v1/article-groups", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/article-codes", cookieHeader),
  ]);

  return (
    <AppShell>
      <TableView list="/artiklar/register">
        <ArticlesPageClient articles={articles} groups={groups} articleCodes={articleCodes} pageSize={pageSize} />
      </TableView>
    </AppShell>
  );
}
