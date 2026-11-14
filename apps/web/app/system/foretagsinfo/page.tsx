import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { CompanyInfoForm } from "../../../components/system/CompanyInfoForm";
import { CompanyCarriersSection } from "../../../components/system/CompanyCarriersSection";
import { MailSignatureCompanySection } from "../../../components/system/MailSignatureCompanySection";
import { apiGet } from "../../../lib/api";
import type { CompanyCarrier, CompanyInfo, RegisterEntry, SystemSettings } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function CompanyInfoPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const info = await apiGet<CompanyInfo>("/api/v1/company-info", cookieHeader).catch(() => null);

  if (info === null) {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const [carriers, companyCarriers, settings] = await Promise.all([
    apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
    apiGet<CompanyCarrier[]>("/api/v1/company-carriers", cookieHeader),
    apiGet<SystemSettings>("/api/v1/settings", cookieHeader),
  ]);

  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Företagsinformation</div>
          <div className={shellStyles.meta}>Företagsuppgifter och logotyp för dokument och e-postsignaturen</div>
        </div>
        <HelpLink chapter="system" anchor="foretagsinformation" label="Hjälp om företagsinformation" />
      </div>

      <CompanyInfoForm initial={info}>
        <MailSignatureCompanySection info={info} initial={settings.mailSignatureCompanyFields} />
      </CompanyInfoForm>
      <CompanyCarriersSection carriers={carriers} companyCarriers={companyCarriers} />
    </AppShell>
  );
}
