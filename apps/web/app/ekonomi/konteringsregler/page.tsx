import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { KonteringsreglerPageClient } from "../../../components/economy/KonteringsreglerPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { Account, ArticleGroup, Paged, PostingRule, SystemSettings } from "../../../lib/types";
import type { VatCodeView } from "../../../lib/vatCodes";
import { canOpen } from "../../../lib/pageAccess";

// Automatkontering (B2). Gated by the Ekonomi permission like the rest of
// /ekonomi — every route this page writes (PATCH /settings/posting,
// /posting-rules) requires it in the API too; this page-level check just
// keeps everyone else from seeing an empty/erroring page instead of a 403.
export default async function KonteringsreglerPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/konteringsregler")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  // Neither /posting-rules nor /article-groups is paginated — both answer
  // with a plain array (economy.repository.ts's listPostingRules,
  // article.repository.ts's listArticleGroups).
  const [settings, postingRules, accounts, articleGroups, vatCodes] = await Promise.all([
    apiGet<SystemSettings>("/api/v1/settings", cookieHeader),
    apiGet<PostingRule[]>("/api/v1/posting-rules", cookieHeader),
    // Inactive accounts included: the selects list the active ones, the rest
    // only tell a deactivated setting apart from one missing in the chart.
    apiGet<Paged<Account>>("/api/v1/accounts?includeInactive=true&limit=1000", cookieHeader),
    apiGet<ArticleGroup[]>("/api/v1/article-groups", cookieHeader),
    apiGet<VatCodeView[]>("/api/v1/vat-codes", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <KonteringsreglerPageClient
        settings={settings}
        postingRules={postingRules}
        accounts={accounts.rows}
        articleGroups={articleGroups}
        vatCodes={vatCodes}
      />
    </AppShell>
  );
}
