"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatSignedMoney } from "../../lib/format";
import {
  CONFIGURATOR_GROUP_KIND_LABELS,
  type ConfiguratorGroupDetail,
} from "../../lib/configurator";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { GroupModal } from "./GroupModal";

interface GroupSectionProps {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  canEdit: boolean;
  onChanged: () => void | Promise<void>;
}

function num(v: string | null): string {
  return v === null ? "" : String(Number(v));
}

// "3 alternativ", "+250,00 kr" or "800–3000 mm".
function contentLabel(g: ConfiguratorGroupDetail): string {
  if (g.kind === "choice") return `${g.values.length} alternativ`;
  if (g.kind === "boolean") return `${formatSignedMoney(g.priceAdd)} kr`;
  const unit = g.unit ? ` ${g.unit}` : "";
  return `${num(g.minValue)}–${num(g.maxValue)}${unit}`;
}

export function GroupSection({
  articleId,
  groups,
  canEdit,
  onChanged,
}: GroupSectionProps) {
  const [error, setError] = useState<string | null>(null);
  // null = closed, "new" = creating, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const base = `/api/v1/articles/${articleId}/configurator/groups`;
  const editingGroup = groups.find((g) => g.id === editing) ?? null;

  async function move(index: number, dir: -1 | 1) {
    const ids = groups.map((g) => g.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setError(null);
    try {
      await apiFetch(`${base}/reorder`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      await onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte flytta valgruppen"));
    }
  }

  async function remove(group: ConfiguratorGroupDetail) {
    if (!(await confirmDelete(`Ta bort valgruppen ${group.code}?`))) return;
    setError(null);
    try {
      await apiFetch(`${base}/${group.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort valgruppen"));
    }
  }

  return (
    <div>
      <SectionHeading
        spaced
        actions={
          canEdit && (
            <Button
              size="small"
              variant="secondary"
              onClick={() => setEditing("new")}
            >
              Lägg till valgrupp
            </Button>
          )
        }
      >
        Valgrupper
      </SectionHeading>
      <FormError margin="below">{error}</FormError>
      <Table<ConfiguratorGroupDetail>
        columns={[
          { key: "code", label: "Kod", width: "90px" },
          { key: "name", label: "Namn", width: "minmax(140px, 1fr)" },
          { key: "kind", label: "Sort", width: "100px" },
          { key: "required", label: "Obligatorisk", width: "100px" },
          { key: "content", label: "Innehåll", width: "140px" },
          { key: "actions", label: "", width: "260px", align: "right" },
        ]}
        rows={groups}
        emptyText="Inga valgrupper ännu"
        renderCell={(g, key) => {
          const index = groups.indexOf(g);
          switch (key) {
            case "code":
              return g.code;
            case "name":
              return g.name;
            case "kind":
              return CONFIGURATOR_GROUP_KIND_LABELS[g.kind];
            case "required":
              return g.kind === "boolean" ? "—" : g.required ? "Ja" : "Nej";
            case "content":
              return contentLabel(g);
            case "actions":
              return canEdit ? (
                <span
                  style={{
                    display: "inline-flex",
                    flexWrap: "wrap",
                    gap: 4,
                    justifyContent: "flex-end",
                  }}
                >
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => void move(index, -1)}
                  >
                    Upp
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={index === groups.length - 1}
                    onClick={() => void move(index, 1)}
                  >
                    Ned
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => setEditing(g.id)}
                  >
                    Ändra
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    onClick={() => void remove(g)}
                  >
                    Ta bort
                  </Button>
                </span>
              ) : null;
            default:
              return null;
          }
        }}
      />
      <GroupModal
        articleId={articleId}
        group={editing === "new" ? null : editingGroup}
        open={editing !== null && (editing === "new" || editingGroup !== null)}
        onClose={() => setEditing(null)}
        onChanged={onChanged}
        onCreated={setEditing}
      />
    </div>
  );
}
