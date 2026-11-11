import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ValutakurserPageClient } from "../../../components/economy/ValutakurserPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { isIsoDate } from "../../../lib/bankReconciliation";
import { canOpen } from "../../../lib/pageAccess";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { ExchangeRateEntry, ExchangeRateSettings, Paged } from "../../../lib/types";

// Valutakurser: the stored rates (fetched from Riksbanken or typed in) behind
// every foreign-currency document. Gated by the Ekonomi permission like the
// rest of /ekonomi; the settings (källa, API-nyckel) are admin-only in the API,
// so they are only fetched — and the card only shown — for an administrator.
export default async function ValutakurserPage(props: { searchParams: Promise<PageSearchParams> }) {
  const rawParams = await props.searchParams;
  // An invalid date in the URL (a half-typed year) would make the API answer
  // 400 and crash the page — treat it as an empty filter instead.
  const searchParams: PageSearchParams = { ...rawParams };
  for (const key of ["from", "to"]) {
    const value = searchParams[key];
    if (typeof value !== "string" || !isIsoDate(value)) delete searchParams[key];
  }
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
