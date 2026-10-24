import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { VerificationCard } from "../../../../components/economy/VerificationCard";
import { HelpLink } from "../../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import type { Account, Paged, VerificationDetail, VerificationSeries } from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { canOpen } from "../../../../lib/pageAccess";

// Gated by the Ekonomi permission (canOpen) like the rest of /ekonomi — the
// API's /verifications surface requires the same permission.
export default async function VerificationDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/verifikat")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const verification = await apiGet<VerificationDetail>(`/api/v1/verifications/${params.id}`, cookieHeader).catch(
    () => null
  );
  if (!verification) notFound();

  const [accounts, series, source] = await Promise.all([
    // Form dropdown data — active accounts only, fetched in full until a
    // searchable picker exists (same "?limit=1000" convention as every other
    // simple register dropdown).
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
    apiGet<VerificationSeries[]>("/api/v1/verification-series", cookieHeader),
    // Resolves the source verification's displayNumber when this one is a
    // reversal draft (Omför) — the detail response only carries the source's
    // id (reversesVerificationId), not its number.
    verification.reversesVerificationId
      ? apiGet<VerificationDetail>(`/api/v1/verifications/${verification.reversesVerificationId}`, cookieHeader).catch(
          () => null
        )
      : Promise.resolve(null),
  ]);

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{verification.displayNumber}</div>
          <div className={shellStyles.meta}>
            {verification.seriesCode} · {verification.yearLabel}
          </div>
        </div>
        <HelpLink chapter="ekonomi" anchor="verifikat" label="Hjälp om verifikat" />
      </div>

      {/* key: Kopiera/Omför navigate between verifications on this same route — the
          rows table keeps its own state, so each verification gets a fresh card. */}
      <VerificationCard
        key={verification.id}
        verification={verification}
        accounts={accounts.rows}
        series={series}
        bookedByName={verification.bookedByName}
        sourceDisplayNumber={source?.displayNumber ?? null}
      />
    </AppShell>
  );
}
