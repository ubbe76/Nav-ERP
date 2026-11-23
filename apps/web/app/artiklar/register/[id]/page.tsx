import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { SplitView } from "../../../../components/split/SplitView";
import { ArticleSummary } from "../../../../components/articles/ArticleSummary";
import { apiGet } from "../../../../lib/api";
import type { Article, ArticleOverview, Paged, StockBalance } from "../../../../lib/types";

// Artikelregistret, lista och kort (Programramen steg 3, the user's choice
// "Sammanfattning som i skissen"): the list beside a summary of the article —
// stock, demand and supply, prices — with Öppna artikelkort for the whole
// card (/artiklar/:id, without the list: its tabs need the width).
export default async function ArticleSummaryPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const article = await apiGet<Article>(`/api/v1/articles/${params.id}`, cookieHeader).catch(() => null);
  if (!article) notFound();

  const [balancesPage, overview] = await Promise.all([
    apiGet<Paged<StockBalance>>(`/api/v1/stock/balances?articleId=${params.id}&limit=1000`, cookieHeader).catch(() => null),
    // The demand and supply rows (Artikelöversikten's); a failed read leaves the section out.
    apiGet<ArticleOverview>(`/api/v1/articles/${params.id}/overview`, cookieHeader).catch(() => null),
  ]);

  return (
    <AppShell>
      <SplitView list="/artiklar/register" selectedId={params.id} renderedAt={Date.now()}>
        <ArticleSummary article={article} balances={balancesPage?.rows ?? null} overview={overview} />
      </SplitView>
    </AppShell>
  );
}
