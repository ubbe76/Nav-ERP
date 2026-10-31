"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type {
  ConfiguratorBomLineDetail,
  ConfiguratorGroupDetail,
  ConfiguratorOperationDetail,
} from "../../lib/configurator";
import type { RoutingOperation } from "../../lib/types";
import { Button } from "../ui/Button";
import { FormError, FormNotice } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { BomLineModal } from "./BomLineModal";
import { conditionsText } from "./ruleText";
import styles from "./Structure.module.css";

interface BomLineSectionProps {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  lines: ConfiguratorBomLineDetail[];
  operations: ConfiguratorOperationDetail[];
  routing: RoutingOperation[];
  canEdit: boolean;
  /** Täckningsvarningar: alternatives a family of lines leaves without a line (from the template GET). */
  warnings: string[];
  onChanged: () => void | Promise<void>;
}

export function BomLineSection({ articleId, groups, lines, operations, routing, canEdit, warnings, onChanged }: BomLineSectionProps) {
  const [error, setError] = useState<string | null>(null);
  // null = closed, "new" = creating, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const base = `/api/v1/articles/${articleId}/configurator/bom-lines`;
  const editingLine = lines.find((l) => l.id === editing) ?? null;

  async function run(fn: () => Promise<unknown>, fallback: string) {
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, fallback));
    }
  }

  function move(index: number, dir: -1 | 1) {
    const ids = lines.map((l) => l.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void run(() => apiFetch(`${base}/reorder`, { method: "POST", body: JSON.stringify({ ids }) }), "Kunde inte flytta raden");
  }

  function operationText(line: ConfiguratorBomLineDetail): string {
    if (line.operationSequenceNo === null) return "";
    const op = line.routingOperationId
      ? routing.find((r) => r.id === line.routingOperationId)
      : operations.find((o) => o.id === line.configuratorOperationId);
    // Routing not loaded (the fetch failed) or the operation gone: still say what the number is.
    if (!op) return `Operation ${line.operationSequenceNo}`;
    return `${line.operationSequenceNo} ${op.description ?? op.workCenterName}`.trim();
  }

  return (
    <div>
      <SectionHeading
        spaced
        actions={
          canEdit && (
            <Button size="small" variant="secondary" onClick={() => setEditing("new")}>
              Lägg till strukturrad
            </Button>
          )
        }
      >
        Struktur per val
      </SectionHeading>
      <FormError margin="below">{error}</FormError>
      {warnings.map((w) => (
        <FormNotice key={w}>{w}</FormNotice>
      ))}
      <Table<ConfiguratorBomLineDetail>
        columns={[
          { key: "when", label: "Villkor", width: "minmax(140px, 1.4fr)" },
          { key: "component", label: "Komponent", width: "minmax(140px, 1.4fr)" },
          { key: "quantity", label: "Antal", width: "minmax(80px, 1fr)" },
          { key: "operation", label: "Operation", width: "minmax(100px, 1fr)" },
          { key: "note", label: "Anteckning", width: "minmax(80px, 1fr)" },
          ...(canEdit ? [{ key: "actions", label: "", width: "260px", align: "right" as const }] : []),
        ]}
        rows={lines}
        emptyText="Inga villkorade strukturrader ännu"
        renderCell={(line, key) => {
          const index = lines.indexOf(line);
          switch (key) {
            case "when":
              return conditionsText(line.conditions, groups);
            case "component":
              return line.source === "article"
                ? `${line.componentArticleNumber ?? ""} ${line.componentArticleName ?? ""}`.trim()
                : `Från valet ${line.componentGroupName ?? ""}`.trim();
            case "quantity":
              return line.quantityFormula != null ? (
                <span className={styles.mono}>{line.quantityFormula}</span>
              ) : (
                String(Number(line.quantity))
              );
            case "operation":
              return operationText(line);
            case "note":
              return line.note ?? "";
            case "actions":
              return (
                <span className={styles.actions}>
                  <Button size="small" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
                    Upp
                  </Button>
                  <Button size="small" variant="ghost" disabled={index === lines.length - 1} onClick={() => move(index, 1)}>
                    Ned
                  </Button>
                  <Button size="small" variant="secondary" onClick={() => setEditing(line.id)}>
                    Ändra
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    onClick={async () => {
                      if (!(await confirmDelete("Ta bort strukturraden?"))) return;
                      void run(() => apiFetch(`${base}/${line.id}`, { method: "DELETE" }), "Kunde inte ta bort raden");
                    }}
                  >
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />
      <BomLineModal
        articleId={articleId}
        groups={groups}
        operations={operations}
        routing={routing}
        line={editing === "new" ? null : editingLine}
        open={editing !== null && (editing === "new" || editingLine !== null)}
        onClose={() => setEditing(null)}
        onChanged={onChanged}
      />
    </div>
  );
}
