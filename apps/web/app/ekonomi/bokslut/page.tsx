import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BokslutPageClient } from "../../../components/economy/BokslutPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { ApiError, apiGet, getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { Account, FiscalYear, Paged, ResultTransferPreview, YearEndClosingDetail } from "../../../lib/types";
import { defaultFiscalYearId, stockholmToday } from "../../../lib/yearEnd";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

export default async function BokslutPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/bokslut")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const fiscalYears = await apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader);
  const requested = typeof searchParams.fiscalYearId === "string" ? searchParams.fiscalYearId : undefined;
  const selectedId = fiscalYears.find((year) => year.id === requested)?.id ?? defaultFiscalYearId(fiscalYears, stockholmToday());

  let closing: YearEndClosingDetail | null = null;
  if (selectedId) {
    const list = await apiGet<Paged<{ id: string }>>(`/api/v1/year-end-closings?fiscalYearId=${selectedId}`, cookieHeader);
    if (list.rows[0]) closing = await apiGet<YearEndClosingDetail>(`/api/v1/year-end-closings/${list.rows[0].id}`, cookieHeader);
  }
  const accounts =
    closing?.status === "in_progress" ? (await apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader)).rows : [];
  // A missing or inactive 8999/2099 makes the preview 409 — the page still
  // renders and the card points to Kontoplan instead of the posting.
  let resultTransferPreview: ResultTransferPreview | null = null;
  let resultTransferAccountsMissing = false;
  if (closing?.status === "in_progress") {
    try {
      resultTransferPreview = await apiGet<ResultTransferPreview>(
        `/api/v1/year-end-closings/${closing.id}/result-transfer-preview`,
        cookieHeader
      );
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "missing-posting-account")) throw err;
      resultTransferAccountsMissing = true;
    }
  }

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Bokslut</div>
          <div className={shellStyles.meta}>Årsbokslut steg för steg per räkenskapsår</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="arsbokslut" label="Hjälp om bokslutet" />
      </div>
      <BokslutPageClient
        key={closing ? `${closing.id}-${closing.status}` : (selectedId ?? "none")}
        fiscalYears={fiscalYears}
        selectedId={selectedId}
        closing={closing}
        accounts={accounts}
        resultTransferPreview={resultTransferPreview}
        resultTransferAccountsMissing={resultTransferAccountsMissing}
      />
    </AppShell>
  );
}
