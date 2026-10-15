import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import shellStyles from "../../../components/AppShell.module.css";
import { KomIgangSection } from "../../../components/onboarding/KomIgangSection";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet } from "../../../lib/api";
import type { OnboardingView } from "../../../lib/types";

export default async function KomIgangPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [view, settings] = await Promise.all([
    apiGet<OnboardingView>("/api/v1/onboarding", cookieHeader),
    apiGet<{ hideOnboarding?: boolean }>("/api/v1/me/settings", cookieHeader),
  ]);
  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kom igång</div>
          <div className={shellStyles.meta}>Det som behöver göras på en ny installation</div>
        </div>
        <HelpLink chapter="system" anchor="kom-igang" label="Hjälp om Kom igång" />
      </div>
      <KomIgangSection initial={view} initiallyHidden={settings.hideOnboarding === true} />
    </AppShell>
  );
}
