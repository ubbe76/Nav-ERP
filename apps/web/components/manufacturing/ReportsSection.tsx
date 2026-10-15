"use client";

import { useState } from "react";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import type { MOReport } from "../../lib/types";

// Rapporteringar on the TO card: every stamp-out, Slutför operation, lego
// receipt, Slutför order and manual material draw, newest first. Ångra
// reverses exactly what that one report booked (admin/arbetsledare only —
// it removes the stamp's time too); an undone row stays, greyed out.

function when(iso: string) {
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

function reportLabel(r: MOReport): string {
  if (r.source === "migration") {
    if (r.kind === "completion") return "Slutför order (före loggen)";
    if (r.kind === "material") return "Materialuttag (före loggen)";
    return "Rapporterat före loggen";
  }
  if (r.kind === "completion") return "Slutför order";
  if (r.kind === "material") return "Materialuttag";
  if (r.source === "terminal") return "Utstämpling";
  if (r.source === "purchase_receipt") return `Inleverans ${r.purchaseOrderNumber ?? "IO"}`;
  return "Slutför operation";
}

function quantity(value: string) {
  return Number(value) !== 0 ? Number(value).toLocaleString("sv-SE") : "–";
}

// What Ångra will do, spelled out for the confirmation.
function undoQuestion(r: MOReport): string {
  const effects: string[] = [];
  if (Number(r.quantityOk) > 0) effects.push(`${quantity(r.quantityOk)} st OK dras av`);
  if (Number(r.quantityScrapped) > 0) effects.push(`${quantity(r.quantityScrapped)} st kasserat dras av`);
  if (r.materials.length > 0) effects.push("materialet läggs tillbaka i lager");
  if (Number(r.quantityReceived) > 0) effects.push(`${quantity(r.quantityReceived)} st tas ut ur lager igen`);
  if (r.hours !== null) effects.push(`${quantity(r.hours)} h tid tas bort`);
  if (r.completedOrder) effects.push("ordern öppnas igen");
  const what = `${reportLabel(r).toLowerCase()} ${when(r.createdAt)}`;
  return effects.length > 0
    ? `Ångra ${what}? ${effects.join(", ").replace(/^./, (c) => c.toUpperCase())}.`
    : `Ångra ${what}?`;
}

export function ReportsSection({
  orderId,
  reports,
  canUndo,
  onDone,
}: {
  orderId: string;
  reports: MOReport[];
  canUndo: boolean;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (reports.length === 0) return null;

  async function undo(report: MOReport) {
    if (!(await confirmDialog(undoQuestion(report), { confirmLabel: "Ångra", danger: true }))) return;
    setError(null);
    setPendingId(report.id);
    try {
      await apiFetch(`/api/v1/manufacturing-orders/${orderId}/reports/${report.id}/undo`, { method: "POST" });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ångra rapporteringen");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <SectionHeading spaced>Rapporteringar</SectionHeading>
      <FormError margin="below">{error}</FormError>
      <Table<MOReport>
        columns={[
          { key: "createdAt", label: "Tid", width: "130px" },
          { key: "kind", label: "Rapportering", width: "minmax(0, 2fr)" },
          { key: "sequenceNo", label: "Operation", width: "minmax(0, 1fr)" },
          { key: "quantityOk", label: "OK", width: "70px", align: "right" },
          { key: "quantityScrapped", label: "Kasserat", width: "80px", align: "right" },
          { key: "quantityReceived", label: "Inlevererat", width: "90px", align: "right" },
          { key: "hours", label: "Timmar", width: "70px", align: "right" },
          { key: "employeeName", label: "Av", width: "minmax(0, 1fr)" },
          { key: "id", label: "", width: "130px", align: "right" },
        ]}
        rows={reports}
        renderCell={(row, key) => {
          const undone = row.undoneAt !== null;
          const muted = undone ? { color: "var(--color-text-muted)", textDecoration: "line-through" } : undefined;
          switch (key) {
            case "createdAt":
              return <span style={muted}>{when(row.createdAt)}</span>;
            case "kind":
              return (
                <span style={muted}>
                  {reportLabel(row)}
                  {row.materials.length > 0 && (
                    <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                      Material: {row.materials.map((m) => `${m.articleNumber} ${quantity(m.quantity)}`).join(", ")}
                    </div>
                  )}
                </span>
              );
            case "sequenceNo":
              return <span style={muted}>{row.sequenceNo !== null ? `${row.sequenceNo} — ${row.workCenterName}` : "–"}</span>;
            case "quantityOk":
            case "quantityScrapped":
            case "quantityReceived":
              return <span style={muted}>{quantity(row[key])}</span>;
            case "hours":
              return <span style={muted}>{row.hours !== null ? quantity(row.hours) : "–"}</span>;
            case "employeeName":
              return <span style={muted}>{row.employeeName ?? row.userName ?? "–"}</span>;
            case "id":
              if (undone) {
                return (
                  <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                    Ångrad {when(row.undoneAt!)}
                    {row.undoneByName ? ` av ${row.undoneByName}` : ""}
                  </span>
                );
              }
              // A lego receipt belongs to its IO.
              if (row.source === "purchase_receipt") {
                return <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>Ångras på IO</span>;
              }
              if (!canUndo) return null;
              return (
                <Button type="button" size="small" variant="secondary" disabled={pendingId !== null} onClick={() => undo(row)}>
                  {pendingId === row.id ? "Ångrar…" : "Ångra"}
                </Button>
              );
            default:
              return null;
          }
        }}
      />
    </>
  );
}
