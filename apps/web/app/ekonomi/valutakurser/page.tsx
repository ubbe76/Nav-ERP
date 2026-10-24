import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ValutakurserPageClient } from "../../../components/economy/ValutakurserPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { canOpen } from "../../../lib/pageAccess";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { ExchangeRateEntry, ExchangeRateSettings, Paged } from "../../../lib/types";

// Valutakurser: the stored rates (fetched from Riksbanken or typed in) behind
// every foreign-currency document. Gated by the Ekonomi permission like the
// rest of /ekonomi; the settings (källa, API-nyckel) are admin-only in the API,
// so they are only fetched — and the card only shown — for an administrator.
export default async function ValutakurserPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/valutakurser")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  const [rates, settings] = await Promise.all([
    // `search` is the currency code (the API matches it exactly, upper-cased).
    apiGet<Paged<ExchangeRateEntry>>(
      `/api/v1/exchange-rates/list${listApiQuery(searchParams, ["from", "to", "source"], pageSize)}`,
      cookieHeader
    ),
    user.role === "admin"
      ? apiGet<ExchangeRateSettings>("/api/v1/exchange-rate-settings", cookieHeader).catch(() => null)
      : Promise.resolve(null),
  ]);

  return (
    <AppShell active="Ekonomi">
      <ValutakurserPageClient rates={rates} settings={settings} pageSize={pageSize} />
    </AppShell>
  );
}
