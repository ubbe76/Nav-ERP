import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ProjectReportPageClient } from "../../../components/reports/ProjectReportPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export default async function ProjektrapportPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/projektrapport")) {
    return (
      <AppShell active="Rapporter">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="Rapporter">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Projektrapport</div>
          <div className={shellStyles.meta}>Intäkter, kostnader och resultat per projekt ur bokföringen</div>
        </div>
        <HelpLink chapter="rapporter" anchor="projektrapport" label="Hjälp om projektrapporten" />
      </div>

      <ProjectReportPageClient
        defaults={{
          projectId: singleParam(searchParams.projectId),
          from: singleParam(searchParams.from),
          to: singleParam(searchParams.to),
        }}
      />
    </AppShell>
  );
}
