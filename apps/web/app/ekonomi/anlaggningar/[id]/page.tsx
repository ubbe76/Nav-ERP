import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { AnlaggningCard } from "../../../../components/economy/AnlaggningCard";
import { HelpLink } from "../../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import type { Account, FixedAssetCategory, FixedAssetDetail, Paged } from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { canOpen } from "../../../../lib/pageAccess";
import { FIXED_ASSET_STATUS_LABELS } from "../../../../lib/fixedAssets";

export default async function AnlaggningPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/anlaggningar")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const asset = await apiGet<FixedAssetDetail>(`/api/v1/fixed-assets/${params.id}`, cookieHeader).catch(() => null);
  if (!asset) notFound();

  const [categories, accounts] = await Promise.all([
    apiGet<FixedAssetCategory[]>("/api/v1/fixed-asset-categories", cookieHeader),
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>
            {asset.assetNumber} · {asset.name}
          </div>
          <div className={shellStyles.meta}>
            {asset.category.name} · {FIXED_ASSET_STATUS_LABELS[asset.status]}
          </div>
        </div>
        <HelpLink chapter="ekonomi" anchor="avyttring" label="Hjälp om anläggningar och avyttring" />
      </div>
      <AnlaggningCard asset={asset} categories={categories} accounts={accounts.rows} />
    </AppShell>
  );
}
