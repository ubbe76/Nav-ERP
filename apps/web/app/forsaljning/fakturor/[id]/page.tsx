import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { InvoiceCard } from "../../../../components/sales/InvoiceCard";
import { MailSection, type SendButtonConfig } from "../../../../components/mail/MailSection";
import { AuditTrailSection } from "../../../../components/system/AuditTrailSection";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { canOpen } from "../../../../lib/pageAccess";
import { getDocumentEmails } from "../../../../lib/mail";
import {
  INVOICE_TYPE_LABELS,
  type Customer,
  type InvoiceDetail,
  type RegisterEntry,
  type SystemSettings,
} from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function InvoiceDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const invoice = await apiGet<InvoiceDetail>(`/api/v1/invoices/${params.id}`, cookieHeader).catch(() => null);
  if (!invoice) notFound();

  // customer's invoiceEmail isn't part of the invoice detail response (only
  // the frozen snapshot fields are) — fetched separately, same pattern as
  // the sales order page resolving its own "Skicka faktura" recipient.
  // The current user decides whether the Verifikat link is rendered at all —
  // /ekonomi/verifikat/… is admin-only, both as a page and in the API (same
  // idiom as /ekonomi/kontoplan's own gate).
  const [customer, emails, creditedInvoice, user, settings] = await Promise.all([
    apiGet<Customer>(`/api/v1/customers/${invoice.customerId}`, cookieHeader).catch(() => null),
    getDocumentEmails(invoice.id, cookieHeader),
    invoice.creditedInvoiceId
      ? apiGet<InvoiceDetail>(`/api/v1/invoices/${invoice.creditedInvoiceId}`, cookieHeader).catch(() => null)
      : Promise.resolve(null),
    getCurrentUser(cookieHeader),
    // Betalningspåminnelse (B3): the fee amount shown in the reminder
    // dialog's checkbox label — same plain-auth GET the betalningar page
    // already relies on for its own tolerance/betalkonto defaults.
    apiGet<SystemSettings>("/api/v1/settings", cookieHeader),
  ]);
  const paymentTerms = await apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader);

  const documentLabel = INVOICE_TYPE_LABELS[invoice.type];
  const canMail = invoice.status === "issued" || invoice.status === "paid";
  // Strictly the customer's invoiceEmail, no fallback to the general E-post
  // field — same idiom as the legacy order page's own "Skicka faktura"
  // button (app/forsaljning/[id]/page.tsx). Unset just leaves the recipient
  // field blank; MailSection's own defaultTo takes over only when set.
  const invoiceEmail = customer?.invoiceEmail ?? "";
  // Betalningspåminnelse (B3): unlike "Skicka faktura" above, the reminder
  // dialog falls back to the customer's legacy `email` column (no longer on
  // the card, but filled by import/older registrations) when there is no
  // dedicated fakturamejl — a reminder should still reach someone.
  const reminderDefaultTo = customer?.invoiceEmail ?? customer?.email ?? "";

  const sendButtons: SendButtonConfig[] = canMail
    ? [
        {
          label: `Skicka ${documentLabel.toLowerCase()}`,
          modalTitle: `Skicka ${documentLabel.toLowerCase()} ${invoice.invoiceNumber} via e-post`,
          endpoint: `/api/v1/invoices/${invoice.id}/send-email`,
          subject: `${documentLabel} ${invoice.invoiceNumber}`,
          message: `Hej!\n\nSe bifogad ${documentLabel.toLowerCase()} ${invoice.invoiceNumber}.\n\nMed vänliga hälsningar`,
          to: customer?.invoiceEmail ?? undefined,
        },
      ]
    : [];

  return (
    <AppShell active="Försäljning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{invoice.invoiceNumber ?? "Utkast"}</div>
          <div className={shellStyles.meta}>
            {documentLabel} · {invoice.customerName}
          </div>
        </div>
        <HelpLink chapter="forsaljning" anchor="fakturor" label="Hjälp om fakturor" />
      </div>

      <InvoiceCard
        invoice={invoice}
        paymentTerms={paymentTerms}
        creditedInvoiceNumber={creditedInvoice?.invoiceNumber ?? null}
        canOpenVerifications={user ? canOpen(user, "/ekonomi/verifikat") : false}
        reminderDefaultTo={reminderDefaultTo}
        reminderFee={settings.reminderFee}
      />

      {canMail && (
        <MailSection
          emails={emails}
          defaultTo={invoiceEmail}
          sendButtons={sendButtons}
          pdfLinks={[{ label: `${documentLabel} (PDF)`, href: `/api/v1/invoices/${invoice.id}/pdf` }]}
        />
      )}

      {/* Drafts have no number yet — and no audit history either, since
          issue() is what writes the first entry — so the section only
          mounts once the invoice has its own displayed number. */}
      {invoice.invoiceNumber && <AuditTrailSection entityType="invoice" entityId={invoice.invoiceNumber} />}
    </AppShell>
  );
}
