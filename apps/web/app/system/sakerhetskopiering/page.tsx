import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BackupSection } from "../../../components/system/BackupSection";
import { StorageSection } from "../../../components/system/StorageSection";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { StorageUsage } from "../../../lib/types";
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

  const usage = await apiGet<StorageUsage>("/api/v1/storage", cookieHeader);

  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Säkerhetskopiering</div>
          <div className={shellStyles.meta}>Lagringsutrymme och en komplett kopia av databasen</div>
        </div>
        <HelpLink chapter="system" anchor="sakerhetskopiering" label="Hjälp om säkerhetskopiering" />
      </div>

      <StorageSection usage={usage} />
      <BackupSection />
    </AppShell>
  );
}
