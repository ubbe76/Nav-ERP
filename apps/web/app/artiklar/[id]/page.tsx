import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { ArticleTabs } from "../../../components/articles/ArticleTabs";
import { ArticleCardHeader } from "../../../components/articles/ArticleCardHeader";
import { apiGet } from "../../../lib/api";
import type { Article, ArticleGroup, BomComponent, BomTreeNode, CostCalculation, Paged, RoutingOperation, StockBalance, WorkCenter } from "../../../lib/types";

export default async function ArticleDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const article = await apiGet<Article>(`/api/v1/articles/${params.id}`, cookieHeader).catch(() => null);
  if (!article) notFound();

  const [bom, bomTree, balancesPage, calculations, routing, workCenters, groups] = await Promise.all([
    apiGet<BomComponent[]>(`/api/v1/articles/${params.id}/bom`, cookieHeader),
    apiGet<BomTreeNode>(`/api/v1/articles/${params.id}/bom-tree`, cookieHeader),
    apiGet<Paged<StockBalance>>(`/api/v1/stock/balances?articleId=${params.id}&limit=1000`, cookieHeader),
    apiGet<CostCalculation[]>(`/api/v1/articles/${params.id}/cost-calculations`, cookieHeader),
    apiGet<RoutingOperation[]>(`/api/v1/articles/${params.id}/routing`, cookieHeader),
    apiGet<WorkCenter[]>("/api/v1/work-centers", cookieHeader),
    apiGet<ArticleGroup[]>("/api/v1/article-groups", cookieHeader),
  ]);
  const balances = balancesPage.rows;
  // Running stock balance shown in the persistent header: the sum of on-hand
  // across every location, in the article's base unit.
  const totalOnHand = balances.reduce((sum, b) => sum + Number(b.quantityOnHand), 0);

  return (
    <AppShell active="Artiklar">
      <ArticleCardHeader article={article} totalOnHand={totalOnHand} />

      <ArticleTabs
        article={article}
        bom={bom}
        bomTree={bomTree}
        balances={balances}
        calculations={calculations}
        routing={routing}
        workCenters={workCenters}
        groups={groups}
      />
    </AppShell>
  );
}
