"use client";

import { useEffect, useState } from "react";
import { GatedLink } from "../ui/GatedLink";
import { Card } from "../ui/Card";
import { StatusPill } from "../ui/StatusPill";
import { Button } from "../ui/Button";
import { SectionHeading } from "../ui/SectionHeading";
import { FormError, FormHint } from "../ui/Form";
import { PdfActions } from "../documents/PdfActions";
import { SendEmailModal } from "../mail/MailSection";
import { fetchDefaultRecipient } from "../../lib/mail";
import type { CreatedInquiry } from "../../lib/types";
import styles from "../../app/tillverkning/behovsberakning/page.module.css";

// Result card for the behovsberäkningens "Skapa förfrågan" flow — same shape
// as the "Skapade ordrar" card, one row per created förfrågan with PDF/Maila
// actions, plus any buckets that failed to post.
export function CreatedInquiriesPanel({
  result,
}: {
  result: {
    created: CreatedInquiry[];
    errors: { supplierName: string; articleNumbers: string[]; message: string }[];
  };
}) {
  const [mailTarget, setMailTarget] = useState<CreatedInquiry | null>(null);
  const [mailTo, setMailTo] = useState<string | null>(null);
  const [sentIds, setSentIds] = useState<string[]>([]);

  useEffect(() => {
    if (!mailTarget) return;
    let cancelled = false;
    setMailTo(null);
    fetchDefaultRecipient("suppliers", mailTarget.supplierId).then((to) => {
      if (!cancelled) setMailTo(to);
    });
    return () => {
      cancelled = true;
    };
  }, [mailTarget]);

  return (
    <Card maxWidth="none" style={{ marginBottom: 20 }}>
      <SectionHeading>Skapade förfrågningar</SectionHeading>
      {result.created.length === 0 && result.errors.length === 0 && <p>Inga förfrågningar skapades.</p>}
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {result.created.map((inq) => (
          <li key={inq.id} className={styles.createdOrder}>
            <GatedLink href={`/inkop/forfragningar/${inq.id}`} className={styles.rowLink}>
              {inq.inquiryNumber} – {inq.supplierName} ({inq.rowCount} {inq.rowCount === 1 ? "rad" : "rader"})
            </GatedLink>
            <span className={styles.createdOrderActions}>
              <PdfActions href={`/api/v1/inquiries/${inq.id}/pdf`} />
              <Button type="button" variant="ghost" size="small" onClick={() => setMailTarget(inq)}>
                Maila
              </Button>
              {sentIds.includes(inq.id) && <StatusPill status="running" label="Skickad" compact />}
            </span>
          </li>
        ))}
      </ul>
      {result.created.length > 0 && (
        <FormHint style={{ marginTop: 10 }}>
          Förfrågningarna skapas som <strong>Utkast</strong> — att mejla en förfrågan sätter den till{" "}
          <strong>Skickad</strong>.
        </FormHint>
      )}
      {result.errors.length > 0 && (
        <FormError margin="above">
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {result.errors.map((e, i) => (
              // Index key: the same supplier can fail more than once (one
              // per bucket), so supplierName alone isn't unique.
              <li key={`${e.supplierName}-${i}`}>
                {e.supplierName}: {e.articleNumbers.join(", ")} — {e.message}
              </li>
            ))}
          </ul>
        </FormError>
      )}

      {/* Same dialog as the inköpsorder card's "Skicka via e-post". Held back
          until the recipient lookup resolves so the address is prefilled.
          drawingCount is 0: lego rows attach their drawings server-side
          regardless of what's picked here. */}
      {mailTarget && mailTo !== null && (
        <SendEmailModal
          open
          onClose={() => setMailTarget(null)}
          config={{
            label: "Maila",
            modalTitle: `Skicka ${mailTarget.inquiryNumber} via e-post`,
            endpoint: `/api/v1/inquiries/${mailTarget.id}/send-email`,
            subject: `Förfrågan ${mailTarget.inquiryNumber}`,
            message: `Hej!\n\nSe bifogad förfrågan ${mailTarget.inquiryNumber}.\n\nMed vänliga hälsningar`,
          }}
          defaultTo={mailTo}
          drawingCount={0}
          onSuccess={() => {
            setSentIds((prev) => [...prev, mailTarget.id]);
            setMailTarget(null);
          }}
        />
      )}
    </Card>
  );
}
