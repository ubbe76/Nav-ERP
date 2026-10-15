"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import type { ConfiguratorGroupDetail, ConfiguratorOperationDetail } from "../../lib/configurator";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { OperationModal } from "./OperationModal";
import { conditionsText } from "./ruleText";
import styles from "./Structure.module.css";

interface OperationSectionProps {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  operations: ConfiguratorOperationDetail[];
  canEdit: boolean;
  onChanged: () => void | Promise<void>;
}

function timeCell(fixed: string | null, formula: string | null) {
  if (formula != null) return <span className={styles.mono}>{formula}</span>;
  return fixed === null ? "" : String(Number(fixed));
}

export function OperationSection({ articleId, groups, operations, canEdit, onChanged }: OperationSectionProps) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const base = `/api/v1/articles/${articleId}/configurator/operations`;
  const editingOp = operations.find((o) => o.id === editing) ?? null;

  async function remove(op: ConfiguratorOperationDetail) {
    if (!(await confirmDelete(`Ta bort operation ${op.sequenceNo}?`))) return;
    setError(null);
    try {
      await apiFetch(`${base}/${op.id}`, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort operationen"));
    }
  }

  return (
    <div>
      <SectionHeading
        spaced
        actions={
          canEdit && (
            <Button size="small" variant="secondary" onClick={() => setEditing("new")}>
              Lägg till operation
            </Button>
          )
        }
      >
        Rutt per val
      </SectionHeading>
      <FormError margin="below">{error}</FormError>
      <Table<ConfiguratorOperationDetail>
        columns={[
          { key: "when", label: "Villkor", width: "minmax(140px, 1.4fr)" },
          { key: "seq", label: "Nr", width: "60px" },
          { key: "wc", label: "Resurs", width: "minmax(100px, 1fr)" },
          { key: "desc", label: "Beskrivning", width: "minmax(100px, 1fr)" },
          { key: "setup", label: "Ställtid (min)", width: "minmax(90px, 1fr)" },
          { key: "run", label: "Stycktid (min/st)", width: "minmax(90px, 1fr)" },
          ...(canEdit ? [{ key: "actions", label: "", width: "170px", align: "right" as const }] : []),
        ]}
        rows={operations}
        emptyText="Inga villkorade operationer ännu"
        renderCell={(op, key) => {
          switch (key) {
            case "when":
              return conditionsText(op.conditions, groups);
            case "seq":
              return op.sequenceNo;
            case "wc":
              return `${op.workCenterCode} ${op.workCenterName}`;
            case "desc":
              return op.description ?? "";
            case "setup":
              return (
                <>
                  {timeCell(op.setupTime, op.setupFormula)}
                  {op.setupPrice !== null && <div className={styles.muted}>Ställpris {formatMoney(op.setupPrice)}</div>}
                </>
              );
            case "run":
              return (
                <>
                  {timeCell(op.runTimePerUnit, op.runFormula)}
                  {op.unitPrice !== null && <div className={styles.muted}>Styckpris {formatMoney(op.unitPrice)}</div>}
                </>
              );
            case "actions":
              return (
                <span className={styles.actions}>
                  <Button size="small" variant="secondary" onClick={() => setEditing(op.id)}>
                    Ändra
                  </Button>
                  <Button size="small" variant="danger" onClick={() => void remove(op)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />
      <OperationModal
        articleId={articleId}
        groups={groups}
        operation={editing === "new" ? null : editingOp}
        open={editing !== null && (editing === "new" || editingOp !== null)}
        onClose={() => setEditing(null)}
        onChanged={onChanged}
      />
    </div>
  );
}
