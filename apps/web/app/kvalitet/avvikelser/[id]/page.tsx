import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { DeviationCard } from "../../../../components/quality/DeviationCard";
import { MailSection } from "../../../../components/mail/MailSection";
import buttonStyles from "../../../../components/ui/Button.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { getDefaultRecipient, getDocumentEmails } from "../../../../lib/mail";
import { DEVIATION_TYPE_LABELS, getResponsibleCandidates, type Deviation, type DeviationReason } from "../../../../lib/quality";
import shellStyles from "../../../../components/AppShell.module.css";

// The PDF is called Reklamationsbesked to a customer, Reklamation to a
// supplier and Avvikelserapport for an internal case.
const REPORT_TITLE = { customer: "Reklamationsbesked", supplier: "Reklamation", internal: "Avvikelserapport" } as const;

export default async function DeviationPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const deviation = await apiGet<Deviation>(`/api/v1/deviations/${id}`, cookieHeader).catch(() => null);
  if (!deviation) notFound();

  const user = await getCurrentUser(cookieHeader);
  const [reasons, responsible, emails] = await Promise.all([
    apiGet<DeviationReason[]>("/api/v1/deviation-reasons", cookieHeader),
    getResponsibleCandidates(
      cookieHeader,
      user,
      deviation.responsibleUserId ? [{ id: deviation.responsibleUserId, name: deviation.responsibleUserName ?? "–" }] : []
    ),
    getDocumentEmails(deviation.id, cookieHeader),
  ]);
  const partnerId = deviation.type === "customer" ? deviation.customerId : deviation.type === "supplier" ? deviation.supplierId : null;
  const defaultTo = partnerId
    ? await getDefaultRecipient(deviation.type === "customer" ? "customers" : "suppliers", partnerId, deviation.counterpartyEmail, cookieHeader)
    : "";

  const title = REPORT_TITLE[deviation.type];
  const lower = title.toLowerCase();
  const subject = `${title} ${deviation.deviationNumber}`;
  const message = `Hej!\n\nSe bifogat ${lower} ${deviation.deviationNumber}.\n\nMed vänliga hälsningar`;
  const endpoint = `/api/v1/deviations/${deviation.id}/email`;

  return (
    <AppShell active="Kvalitet">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{deviation.deviationNumber}</div>
          <div className={shellStyles.meta}>
            {DEVIATION_TYPE_LABELS[deviation.type]}
            {deviation.counterpartyName ? ` · ${deviation.counterpartyName}` : ""} · {deviation.title}
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/kvalitet/avvikelser" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Avvikelser
          </Link>
          <HelpLink chapter="kvalitet" anchor="avvikelsekortet" label="Hjälp om avvikelsekortet" />
        </div>
      </div>

      <DeviationCard key={deviation.updatedAt} deviation={deviation} reasons={reasons} responsible={responsible} />

      <MailSection
        emails={emails}
        defaultTo={defaultTo}
        sendButtons={[
          {
            label: `Skicka ${lower}`,
            modalTitle: `Skicka ${lower} ${deviation.deviationNumber} via e-post`,
            endpoint,
            subject,
            message,
            extraBody: { includeDetails: false },
          },
          {
            label: `Skicka ${lower} med analys och åtgärd`,
            modalTitle: `Skicka ${lower} ${deviation.deviationNumber} med analys och åtgärd via e-post`,
            endpoint,
            subject,
            message,
            extraBody: { includeDetails: true },
          },
        ]}
        pdfLinks={[
          { label: `${title} med analys och åtgärd (PDF)`, href: `/api/v1/deviations/${deviation.id}/pdf?details=1` },
        ]}
      />
    </AppShell>
  );
}
