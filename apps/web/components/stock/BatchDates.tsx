"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { useCan } from "../PermissionsProvider";
import { stockholmToday } from "../../lib/date";
import type { TraceBatchRef } from "../../lib/types";
import { BatchEditDialog } from "./BatchEditDialog";

// The batch's utgångsdatum above its trace, and Ändra for those with Lager.
export function BatchDates({ batch }: { batch: TraceBatchRef }) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (!batch.batchId || !batch.batchNumber) return null;
  const expired = batch.expiresOn ? batch.expiresOn < stockholmToday() : false;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "0 0 16px", flexWrap: "wrap" }}>
      <span>
        Utgångsdatum:{" "}
        {batch.expiresOn ? (
          <strong style={expired ? { color: "var(--status-stopped-text)" } : undefined}>
            {batch.expiresOn}
            {expired ? " — utgången" : ""}
          </strong>
        ) : (
          "—"
        )}
      </span>
      {can(["lager"]) && (
        <>
          <Button type="button" variant="secondary" size="small" onClick={() => setOpen(true)}>
            Ändra
          </Button>
          <BatchEditDialog
            open={open}
            onClose={() => setOpen(false)}
            batchId={batch.batchId}
            batchNumber={batch.batchNumber}
            expiresOn={batch.expiresOn ?? null}
          />
        </>
      )}
    </div>
  );
}
