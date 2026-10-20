"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { PalletCardDialog } from "./PalletCardDialog";

// Pallkort link for a delivery note in a server-rendered list: opens the
// delivery dialog (kolli per row).
export function PalletCardButton({ deliveryId }: { deliveryId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" size="small" onClick={() => setOpen(true)}>
        Pallkort
      </Button>
      <PalletCardDialog target={open ? { kind: "delivery", deliveryId } : null} onClose={() => setOpen(false)} />
    </>
  );
}
