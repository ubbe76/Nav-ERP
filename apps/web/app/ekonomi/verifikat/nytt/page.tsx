import { headers } from "next/headers";
import { AppShell } from "../../../../components/AppShell";
import { NewVerificationPageClient } from "../../../../components/economy/NewVerificationPageClient";
import { HelpLink } from "../../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import type { Account, Paged, VerificationSeries, VerificationTemplate } from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { canOpen } from "../../../../lib/pageAccess";

// Gated by the Ekonomi permission like the rest of /ekonomi. `?mall=<id>`
// (Ny från mall on the verification list) opens the page filled from that
// template.
export default async function NewVerificationPage(props: { searchParams: Promise<{ mall?: string }> }) {
  const { mall } = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/verifikat")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [accounts, series, templates] = await Promise.all([
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
    apiGet<VerificationSeries[]>("/api/v1/verification-series", cookieHeader),
    apiGet<{ rows: VerificationTemplate[]; total: number }>("/api/v1/verification-templates", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Nytt verifikat</div>
          <div className={shellStyles.meta}>Fyll i raderna direkt i tabellen</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="verifikat" label="Hjälp om verifikat" />
      </div>

      <NewVerificationPageClient
        accounts={accounts.rows}
        series={series}
        templates={templates.rows}
        initialTemplateId={mall ?? null}
      />
    </AppShell>
  );
}
