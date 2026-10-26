import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { VarderingPageClient } from "../../../components/stock/VarderingPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { ArticleGroup, RegisterEntry } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /ekonomi reports (see balansrakning/page.tsx)
// — GET /stock/valuation requires the admin role in the API too (stock.routes.ts).
export default async function LagervarderingPage(props: { searchParams: Promise<PageSearchParams> }) {
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

  const [groups, articleCodes] = await Promise.all([
    apiGet<ArticleGroup[]>("/api/v1/article-groups", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/article-codes", cookieHeader),
  ]);

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Lagervärdering</div>
          <div className={shellStyles.meta}>
            Lagervärde per valfritt datum — standardpris, senaste inköp eller vägt snitt
          </div>
        </div>
        <HelpLink chapter="lager" anchor="lagervardering" label="Hjälp om lagervärdering" />
      </div>

      <VarderingPageClient
        groups={groups}
        articleCodes={articleCodes}
        defaultAsOf={singleParam(searchParams.asOf)}
        defaultMethod={singleParam(searchParams.method)}
        defaultGroupId={singleParam(searchParams.groupId)}
        defaultArticleCodeId={singleParam(searchParams.articleCodeId)}
        defaultGroupBy={singleParam(searchParams.groupBy)}
      />
    </AppShell>
  );
}
