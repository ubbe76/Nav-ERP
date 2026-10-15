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
import { GatedLink } from "../ui/GatedLink";
import { FormError, FormStack } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import type { SupplierPaymentDetail, SupplierPaymentRow } from "../../lib/types";

export function SupplierPaymentCard({
  payment,
  // The whole /ekonomi/verifikat surface is admin-only — the two verifikat
  // links below are only rendered for admins, resolved server-side (same
  // idiom as InvoiceCard/SupplierInvoiceCard/VerificationCard).
  canOpenVerifications,
}: {
  payment: SupplierPaymentDetail;
  canOpenVerifications: boolean;
}) {
  const router = useRouter();
  const cancelled = payment.cancelledAt !== null;
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
      await apiFetch(`/api/v1/supplier-payments/${payment.id}/cancel`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte makulera betalningen");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 24, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        <StatusPill status={cancelled ? "stopped" : "done"} label={cancelled ? "Makulerad" : "Registrerad"} />
        <span>
          Leverantör: <strong>{payment.supplierName}</strong>
        </span>
        <span>Datum: {payment.paymentDate}</span>
        <span>Belopp: {formatMoney(payment.amount)} kr</span>
        <span>Konto: {payment.bankAccountNumber}</span>
        {payment.paymentBatchItem && (
          <span>
            Från <GatedLink href={`/inkop/betalfiler/${payment.paymentBatchItem.batchId}`}>betalfil {payment.paymentBatchItem.batchNumber}</GatedLink>, post{" "}
            {payment.paymentBatchItem.endToEndId}
          </span>
        )}
        {payment.bankFileEntry && (
          <span>
            Bekräftad via bankfil <GatedLink href={`/inkop/bankfiler/${payment.bankFileEntry.bankFileId}`}>{payment.bankFileEntry.filename}</GatedLink>
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
        <Table<SupplierPaymentRow>
          columns={[
            { key: "registrationNumber", label: "Faktura", width: "1fr" },
            { key: "appliedAmount", label: "Belopp", width: "150px", align: "right" },
            { key: "writeOffAmount", label: "Avskrivning", width: "150px", align: "right" },
          ]}
          rows={payment.rows}
          renderCell={(row, key) => {
            switch (key) {
              case "registrationNumber":
                // LF-handle plus the supplier's own invoice number — the AP
                // counterpart of the AR mirror's fakturanummer + typ.
                return (
                  <Link href={`/inkop/leverantorsfakturor/${row.supplierInvoiceId}`}>
                    {row.registrationNumber} ({row.invoiceNumber})
                  </Link>
                );
              case "appliedAmount":
                return `${formatMoney(row.appliedAmount)} kr`;
              case "writeOffAmount":
                return Number(row.writeOffAmount) !== 0 ? `${formatMoney(row.writeOffAmount)} kr` : "–";
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
