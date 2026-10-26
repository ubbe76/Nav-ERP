import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ArticlesPageClient } from "../../../components/articles/ArticlesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Article, ArticleGroup, Paged, RegisterEntry } from "../../../lib/types";

export default async function ArticlesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [articles, groups, articleCodes] = await Promise.all([
    apiGet<Paged<Article>>(`/api/v1/articles${listApiQuery(searchParams, ["type", "groupId", "articleCodeId"], pageSize)}`, cookieHeader),
    apiGet<ArticleGroup[]>("/api/v1/article-groups", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/article-codes", cookieHeader),
  ]);

  return (
    <AppShell active="Artiklar">
      <ArticlesPageClient articles={articles} groups={groups} articleCodes={articleCodes} pageSize={pageSize} />
    </AppShell>
  );
}
