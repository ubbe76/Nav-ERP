"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { NewPurchaseOrderForm } from "./NewPurchaseOrderForm";
import { NewInquiryForm } from "./NewInquiryForm";
import type { Supplier } from "../../lib/types";

// "+ Ny förfrågan" / "+ Ny inköpsorder" on the supplier card — both open
// their form with the supplier locked to the card's supplier.
export function NewOrderFromSupplierButton({ supplier }: { supplier: Supplier }) {
  const [mode, setMode] = useState<"inquiry" | "order" | null>(null);

  return (
    <>
      <div style={{ display: "flex", gap: 10 }}>
        <Button type="button" variant="secondary" onClick={() => setMode("inquiry")}>
          + Ny förfrågan
        </Button>
        <Button type="button" variant="primary" onClick={() => setMode("order")}>
          + Ny inköpsorder
        </Button>
      </div>
      <Modal
        open={mode !== null}
        onClose={() => setMode(null)}
        title={`${mode === "inquiry" ? "Ny förfrågan" : "Ny inköpsorder"} — ${supplier.name}`}
      >
        {mode === "inquiry" && <NewInquiryForm lockedSupplier={supplier} />}
        {mode === "order" && <NewPurchaseOrderForm lockedSupplier={supplier} />}
      </Modal>
    </>
  );
}
