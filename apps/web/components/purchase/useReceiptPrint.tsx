"use client";

import { useState } from "react";
import { LabelPrintDialog } from "../stock/LabelPrintDialog";
import { PalletCardDialog } from "../documents/PalletCardDialog";
import type { ReceiptPrintEntry } from "../../lib/receiptPrint";

// Etikett och pallkort vid inleverans — the two dialogs for an inköpsorder's
// receipts, shared by the Inleverans routine (what was just received) and
// the IO card's Inleveranser (all of them, or one row). `openLabels` and
// `openPalletCard` take the entries to print; render `dialogs` once.
export function useReceiptPrint(orderId: string) {
  const [labels, setLabels] = useState<ReceiptPrintEntry[] | null>(null);
  const [cards, setCards] = useState<ReceiptPrintEntry[] | null>(null);
  const dialogs = (
    <>
      <LabelPrintDialog
        open={labels !== null}
        onClose={() => setLabels(null)}
        endpoint={`/api/v1/purchase-orders/${orderId}/receipts/labels`}
        idsKey="receiptIds"
        ids={labels?.flatMap((e) => e.receiptIds) ?? []}
        maxIds={2000}
        title="Skriv ut inleveransetiketter"
      />
      <PalletCardDialog
        target={cards ? { kind: "receipt", orderId, entries: cards } : null}
        onClose={() => setCards(null)}
      />
    </>
  );
  return { openLabels: (entries: ReceiptPrintEntry[]) => setLabels(entries), openPalletCard: (entries: ReceiptPrintEntry[]) => setCards(entries), dialogs };
}
