"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState } from "react";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import type { CostCalculation } from "../../lib/types";
import { CostSpecification } from "./CostSpecification";
import styles from "./CostCalculationList.module.css";

const TYPE_LABELS: Record<CostCalculation["type"], string> = { pre: "Förkalkyl", post: "Efterkalkyl" };

function money(value: string | number) {
  return `${formatMoney(value)} kr`;
}

// Sales price divided by quantity — "—" rather than Infinity/NaN for the
// (should-be-impossible) zero-quantity calculation.
function unitPrice(c: CostCalculation) {
  const quantity = Number(c.quantity);
  if (!quantity) return "—";
  return money(Number(c.salesPrice) / quantity);
}

// TVK and SVK are plain sums of the stored steps — the API never stores them.
function selfCost(c: CostCalculation) {
  return (
    Number(c.materialCost) +
    Number(c.materialOverhead) +
    Number(c.laborCost) +
    Number(c.overhead) +
    Number(c.subcontractCost) +
    Number(c.subcontractOverhead) +
    Number(c.semiFinishedCost) +
    Number(c.businessOverhead)
  );
}

// The calculation history for one article or one manufacturing order. Clicking
// the type opens the specification — Table has no onRowClick, and button plus
// Modal is the house pattern for a detail view without its own route.
export function CostCalculationList({
  calculations,
  emptyText = "Ingen kalkyl gjord än.",
  openId,
  onCloseSpecification,
  onDeleted,
  onArticleChanged,
}: {
  calculations: CostCalculation[];
  emptyText?: string;
  // Lets a caller open a specification straight after calculating.
  openId?: string | null;
  onCloseSpecification?: () => void;
  // Called after the specification wrote a figure back onto the article
  // (standard cost / sales price), so the card can re-read those fields.
  onArticleChanged?: () => void;
  // Called after a calculation was removed, so the caller can refresh its list.
  onDeleted?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const open = selected ?? openId ?? null;

  function close() {
    setSelected(null);
    onCloseSpecification?.();
  }

  // Pre-calculations only: an efterkalkyl is the record of what an order
  // actually cost, and the API refuses to delete one (409).
  async function remove(row: CostCalculation) {
    if (!(await confirmDelete(`Ta bort förkalkylen från ${new Date(row.calculatedAt).toLocaleString("sv-SE")}?`))) return;
    setError(null);
    setDeletingId(row.id);
    try {
      await apiFetch(`/api/v1/cost-calculations/${row.id}`, { method: "DELETE" });
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort kalkylen");
    } finally {
      setDeletingId(null);
    }
  }

  if (calculations.length === 0) return <p>{emptyText}</p>;

  const openCalculation = calculations.find((c) => c.id === open);

  return (
    <>
      <FormError margin="below">{error}</FormError>

      <Table<CostCalculation>
        columns={[
          { key: "type", label: "Typ", width: "110px" },
          { key: "quantity", label: "Antal", width: "80px", align: "right" },
          { key: "materialCost", label: "Material", width: "110px", align: "right" },
          { key: "subcontractCost", label: "Lego", width: "100px", align: "right" },
          { key: "laborCost", label: "Lön", width: "100px", align: "right" },
          { key: "selfCost", label: "Självkostnad", width: "130px", align: "right" },
          { key: "unitPrice", label: "Styckpris", width: "110px", align: "right" },
          { key: "salesPrice", label: "Försäljningspris", width: "140px", align: "right" },
          { key: "calculatedAt", label: "Datum", width: "1fr" },
          { key: "actions", label: "", width: "110px", align: "right" },
        ]}
        rows={calculations}
        renderCell={(row, key) => {
          switch (key) {
            case "type":
              return (
                <button type="button" className={styles.rowLink} onClick={() => setSelected(row.id)}>
                  {TYPE_LABELS[row.type]}
                </button>
              );
            case "quantity":
              return Number(row.quantity).toLocaleString("sv-SE");
            case "materialCost":
            case "subcontractCost":
            case "laborCost":
            case "salesPrice":
              return money(row[key]);
            case "selfCost":
              return money(selfCost(row));
            case "unitPrice":
              return unitPrice(row);
            case "calculatedAt":
              return new Date(row.calculatedAt).toLocaleString("sv-SE");
            case "actions":
              return row.type === "pre" ? (
                <Button
                  type="button"
                  size="small"
                  variant="danger"
                  disabled={deletingId === row.id}
                  onClick={() => remove(row)}
                >
                  {deletingId === row.id ? "Tar bort…" : "Ta bort"}
                </Button>
              ) : null;
            default:
              return null;
          }
        }}
      />

      <Modal
        open={open !== null}
        onClose={close}
        title={
          openCalculation
            ? `Kalkylspecifikation · ${TYPE_LABELS[openCalculation.type]} ${Number(openCalculation.quantity).toLocaleString("sv-SE")} st`
            : "Kalkylspecifikation"
        }
      >
        {open && <CostSpecification calculationId={open} onApplied={onArticleChanged} />}
      </Modal>
    </>
  );
}
