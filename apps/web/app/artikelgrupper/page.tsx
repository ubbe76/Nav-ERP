import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { ArticleGroupsPageClient } from "../../components/articles/ArticleGroupsPageClient";
import { apiGet } from "../../lib/api";
import type { ArticleGroup } from "../../lib/types";

export default async function ArticleGroupsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const groups = await apiGet<ArticleGroup[]>("/api/v1/article-groups", cookieHeader);

  return (
    <AppShell active="Artiklar">
      <ArticleGroupsPageClient groups={groups} />
    </AppShell>
  );
}
