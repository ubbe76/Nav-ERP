import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BackupSection } from "../../../components/system/BackupSection";
import { getCurrentUser } from "../../../lib/api";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function BackupPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  // Admin-only, matching the rest of System.
  if (!user || user.role !== "admin") {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Säkerhetskopiering</div>
          <div className={shellStyles.meta}>Ladda ner en komplett kopia av databasen</div>
        </div>
        <HelpLink chapter="system" anchor="sakerhetskopiering" label="Hjälp om säkerhetskopiering" />
      </div>

      <BackupSection />
    </AppShell>
  );
}
