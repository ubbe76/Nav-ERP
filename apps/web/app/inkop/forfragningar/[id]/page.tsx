import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { InquiryDetail } from "../../../../components/purchase/InquiryDetail";
import { MailSection } from "../../../../components/mail/MailSection";
import { apiGet } from "../../../../lib/api";
import { countDrawings, getDefaultRecipient, getDocumentEmails } from "../../../../lib/mail";
import type { Inquiry, InquiryRow, RegisterEntry, Supplier } from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function InquiryDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const inquiry = await apiGet<Inquiry>(`/api/v1/inquiries/${params.id}`, cookieHeader).catch(() => null);
  if (!inquiry) notFound();

  const [rows, emails, supplier, deliveryTerms, paymentTerms, carriers] = await Promise.all([
    apiGet<InquiryRow[]>(`/api/v1/inquiries/${params.id}/rows`, cookieHeader),
    getDocumentEmails(inquiry.id, cookieHeader),
    apiGet<Supplier>(`/api/v1/suppliers/${inquiry.supplierId}`, cookieHeader).catch(() => null),
    apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
  ]);
  const defaultTo = await getDefaultRecipient("suppliers", inquiry.supplierId, supplier?.email ?? null, cookieHeader);
  const drawingCount = await countDrawings(rows.map((r) => r.articleId), cookieHeader);
  const mailable = inquiry.status !== "ordered" && inquiry.status !== "cancelled";

  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{inquiry.inquiryNumber}</div>
          <div className={shellStyles.meta}>Förfrågan · {inquiry.supplierName}</div>
        </div>
        <HelpLink chapter="inkop" anchor="forfragningar-prisforfragan" label="Hjälp om förfrågningar" />
      </div>

      <InquiryDetail inquiry={inquiry} rows={rows} registers={{ deliveryTerms, paymentTerms, carriers }} />

      <MailSection
        emails={emails}
        defaultTo={defaultTo}
        sendButtons={
          mailable
            ? [
                {
                  label: "Skicka via e-post",
                  modalTitle: `Skicka ${inquiry.inquiryNumber} via e-post`,
                  endpoint: `/api/v1/inquiries/${inquiry.id}/send-email`,
                  subject: `Förfrågan ${inquiry.inquiryNumber}`,
                  message: `Hej!\n\nSe bifogad förfrågan ${inquiry.inquiryNumber}.\n\nMed vänliga hälsningar`,
                },
              ]
            : []
        }
        pdfLinks={[{ label: "Ladda ner PDF", href: `/api/v1/inquiries/${inquiry.id}/pdf` }]}
        drawingCount={drawingCount}
      />
    </AppShell>
  );
}
