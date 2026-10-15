"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { NewQuoteForm } from "./NewQuoteForm";
import type { Customer } from "../../lib/types";

// "+ Ny offert" / "+ Ny kundorder" on the customer card — both open the
// quote form with the customer locked; kundorder creates it confirmed.
export function NewQuoteFromCustomerButton({ customer }: { customer: Customer }) {
  const [mode, setMode] = useState<"quote" | "order" | null>(null);

  return (
    <>
      <div style={{ display: "flex", gap: 10 }}>
        <Button type="button" variant="secondary" onClick={() => setMode("quote")}>
          + Ny offert
        </Button>
        <Button type="button" variant="primary" onClick={() => setMode("order")}>
          + Ny kundorder
        </Button>
      </div>
      <Modal
        open={mode !== null}
        onClose={() => setMode(null)}
        title={`${mode === "order" ? "Ny kundorder" : "Ny offert"} — ${customer.name}`}
      >
        {mode !== null && <NewQuoteForm lockedCustomer={customer} mode={mode} />}
      </Modal>
    </>
  );
}
