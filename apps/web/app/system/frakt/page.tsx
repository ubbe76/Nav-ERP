import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { FreightSettingsForm } from "../../../components/shipping/FreightSettingsForm";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";
import { apiGet } from "../../../lib/api";
import type { Article, FreightProduct, FreightSettings, PickupTime } from "../../../lib/types";

export default async function FreightSettingsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const settings = await apiGet<FreightSettings>("/api/v1/freight-settings", cookieHeader).catch(() => null);
  if (settings === null) {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }
  const [pickupTimes, products, article] = await Promise.all([
    apiGet<PickupTime[]>("/api/v1/freight-settings/pickup-times", cookieHeader),
    apiGet<FreightProduct[]>("/api/v1/freight-products", cookieHeader),
    settings.freightArticleId
      ? apiGet<Article>(`/api/v1/articles/${settings.freightArticleId}`, cookieHeader).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Frakt</div>
          <div className={shellStyles.meta}>Transportbokning via Sendify</div>
        </div>
        <HelpLink chapter="system" anchor="fraktinstallningar" label="Hjälp om fraktinställningar" />
      </div>
      <FreightSettingsForm
        initial={settings}
        pickupTimes={pickupTimes}
        products={products}
        freightArticle={article ? { id: article.id, articleNumber: article.articleNumber, name: article.name } : null}
      />
    </AppShell>
  );
}
