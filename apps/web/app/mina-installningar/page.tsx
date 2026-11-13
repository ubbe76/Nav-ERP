import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { HelpLink } from "../../components/ui/HelpLink";
import { Card } from "../../components/ui/Card";
import { SectionHeading } from "../../components/ui/SectionHeading";
import { FormHint, FormNotice } from "../../components/ui/Form";
import { AppearanceControls } from "../../components/settings/AppearanceControls";
import { PasswordForm } from "../../components/settings/PasswordForm";
import { MailTemplatesEditor, type MailTemplateView } from "../../components/settings/MailTemplatesEditor";
import { apiGet, getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";
import styles from "./page.module.css";

// Mina inställningar (2026-11-13): the signed-in user's own settings — the
// user menu's Tema/Täthet/Flikar/Favoriter (copied, still in the menu too),
// Byt lösenord and E-postmallar. Every logged-in user (pageAccess "any").
export default async function MySettingsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  if (!user) redirect("/login");
  // An Endast läsning account cannot save templates (403), so it gets none.
  const templates = user.readOnly
    ? null
    : await apiGet<MailTemplateView[]>("/api/v1/me/mail-templates", cookieHeader).catch(() => null);

  return (
    <AppShell active="Översikt">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Mina inställningar</div>
          <div className={shellStyles.meta}>
            {user.name} · {user.email}
          </div>
        </div>
        <HelpLink chapter="komma-igang" anchor="mina-installningar" label="Hjälp om Mina inställningar" />
      </div>

      <div className={styles.columns}>
        <div className={styles.column}>
          <Card>
            <SectionHeading>Utseende och arbetssätt</SectionHeading>
            <FormHint>Samma inställningar som i användarmenyn uppe till höger. De sparas direkt och följer med dig mellan datorer.</FormHint>
            <div className={styles.settings}>
              <AppearanceControls classes={{ section: styles.setting, label: styles.settingLabel }} />
            </div>
          </Card>
          <Card>
            <SectionHeading>Byt lösenord</SectionHeading>
            <PasswordForm />
          </Card>
        </div>
        <div className={styles.column}>
          <Card maxWidth={720}>
            <SectionHeading>E-postmallar</SectionHeading>
            {user.readOnly ? (
              <FormNotice>Kontot kan bara läsa och skickar inga dokument, så e-postmallarna kan inte ändras.</FormNotice>
            ) : templates ? (
              <MailTemplatesEditor initial={templates} />
            ) : (
              <FormNotice>Kunde inte läsa e-postmallarna just nu.</FormNotice>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
