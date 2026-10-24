"use client";

import { confirmDialog } from "../../lib/confirm";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { SectionHeading } from "../ui/SectionHeading";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Card } from "../ui/Card";
import { FormError, FormStack } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { apiFetch } from "../../lib/api";
import { currencyLabel, exchangeDifferenceText, formatRate, SEK } from "../../lib/currency";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import { INVOICE_TYPE_LABELS, type PaymentDetail, type PaymentRow } from "../../lib/types";

export function PaymentCard({
  payment,
  // The whole /ekonomi/verifikat surface is admin-only — the two verifikat
  // links below are only rendered for admins, resolved server-side (same
  // idiom as InvoiceCard/SupplierInvoiceCard/VerificationCard).
  canOpenVerifications,
}: {
  payment: PaymentDetail;
  canOpenVerifications: boolean;
}) {
  const router = useRouter();
  const cancelled = payment.cancelledAt !== null;
  // Valuta: a payment in another currency also carries the SEK that reached the
  // bank account, the bank's fee and the kursdifferens it booked.
  const foreign = payment.currency !== SEK;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function cancelPayment() {
    // A pure kvittning was never booked (verificationId null), so there is
    // nothing to reverse — promising an omföring for one would be a lie.
    const consequence =
      payment.verificationId === null
        ? "Inget verifikat behöver omföras och fakturorna öppnas igen."
        : "En omföring bokförs och fakturorna öppnas igen.";
    if (!(await confirmDialog(`Makulera betalning ${payment.paymentNumber}? ${consequence}`))) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/payments/${payment.id}/cancel`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte makulera betalningen"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 24, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        <StatusPill status={cancelled ? "stopped" : "done"} label={cancelled ? "Makulerad" : "Registrerad"} />
        <span>
          Kund: <strong>{payment.customerName}</strong>
        </span>
        <span>Datum: {payment.paymentDate}</span>
        <span>
          Belopp: {formatMoney(payment.amount)} {currencyLabel(payment.currency)}
        </span>
        {foreign && <span>Insatt på kontot: {formatMoney(payment.amountSek)} kr</span>}
        {foreign && Number(payment.bankFeeSek) > 0 && <span>Bankavgift: {formatMoney(payment.bankFeeSek)} kr</span>}
        {foreign && <span>{exchangeDifferenceText(payment.exchangeRateDifferenceSek, formatMoney)}</span>}
        <span>Konto: {payment.bankAccountNumber}</span>
        {payment.bankFileEntry && (
          <span>
            Från <GatedLink href={`/forsaljning/bankfiler/${payment.bankFileEntry.bankFileId}`}>bankfil {payment.bankFileEntry.filename}</GatedLink>
          </span>
        )}
        {payment.verificationId === null ? (
          // A pure kvittning between open items never booked anything — not
          // sensitive, shown regardless of role (mirrors the list's own tooltip).
          <span title="Kvittning (inget verifikat)">Verifikat: — (kvittning)</span>
        ) : (
          canOpenVerifications && (
            <span>
              Verifikat{" "}
              <Link href={`/ekonomi/verifikat/${payment.verificationId}`}>
                {payment.verificationDisplayNumber ?? "–"}
              </Link>
            </span>
          )
        )}
        {cancelled && canOpenVerifications && payment.cancellationVerificationId && (
          <span>
            Makuleringsverifikat{" "}
            <Link href={`/ekonomi/verifikat/${payment.cancellationVerificationId}`}>
              {payment.cancellationDisplayNumber ?? "–"}
            </Link>
          </span>
        )}
      </div>

      <FormError>{error}</FormError>

      {payment.note && (
        <p>
          <strong>Notering:</strong> {payment.note}
        </p>
      )}

      <SectionHeading spaced>Rader</SectionHeading>
      {payment.rows.length > 0 ? (
        <Table<PaymentRow>
          columns={[
            { key: "invoiceNumber", label: "Faktura", width: "1fr" },
            { key: "appliedAmount", label: "Belopp", width: "150px", align: "right" },
            { key: "writeOffAmount", label: "Avskrivning", width: "150px", align: "right" },
            // Valuta: the invoice's own rate and the SEK the row cleared of the
            // booked receivable.
            ...(foreign
              ? [
                  { key: "invoiceRate", label: "Fakturans kurs", width: "130px", align: "right" as const },
                  { key: "settledSek", label: "Avräknat i SEK", width: "150px", align: "right" as const },
                ]
              : []),
          ]}
          rows={payment.rows}
          renderCell={(row, key) => {
            switch (key) {
              case "invoiceNumber":
                return (
                  <Link href={`/forsaljning/fakturor/${row.invoiceId}`}>
                    {row.invoiceNumber ?? "–"} ({INVOICE_TYPE_LABELS[row.invoiceType]})
                  </Link>
                );
              case "appliedAmount":
                return `${formatMoney(row.appliedAmount)} ${currencyLabel(payment.currency)}`;
              case "writeOffAmount":
                return Number(row.writeOffAmount) !== 0
                  ? `${formatMoney(row.writeOffAmount)} ${currencyLabel(payment.currency)}`
                  : "–";
              case "invoiceRate":
                return row.invoiceExchangeRate === null ? "–" : formatRate(row.invoiceExchangeRate);
              case "settledSek":
                return `${formatMoney(Number(row.appliedAmountSek) + Number(row.writeOffAmountSek))} kr`;
              default:
                return null;
            }
          }}
        />
      ) : (
        <p>Inga rader.</p>
      )}

      <div style={{ marginTop: 20 }}>
        <Card maxWidth={320}>
          <FormStack>
            <strong>Åtgärder</strong>
            {!cancelled ? (
              <Button type="button" variant="danger" disabled={pending} onClick={cancelPayment}>
                Makulera
              </Button>
            ) : (
              <span>Betalningen är makulerad.</span>
            )}
          </FormStack>
        </Card>
      </div>
    </div>
  );
}
