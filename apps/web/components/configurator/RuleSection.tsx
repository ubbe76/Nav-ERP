"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { ConfiguratorGroupDetail, ConfiguratorRuleDetail } from "../../lib/configurator";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { FormError, FormHint } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { RuleModal } from "./RuleModal";
import { ruleText } from "./ruleText";
import styles from "./RuleModal.module.css";

interface RuleSectionProps {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  rules: ConfiguratorRuleDetail[];
  canEdit: boolean;
  onChanged: () => void | Promise<void>;
}

export function RuleSection({ articleId, groups, rules, canEdit, onChanged }: RuleSectionProps) {
  const [error, setError] = useState<string | null>(null);
  // null = closed, "new" = creating, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const base = `/api/v1/articles/${articleId}/configurator/rules`;
  const editingRule = rules.find((r) => r.id === editing) ?? null;

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
    const ids = rules.map((r) => r.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void run(() => apiFetch(`${base}/reorder`, { method: "POST", body: JSON.stringify({ ids }) }), "Kunde inte flytta regeln");
  }

  return (
    <div>
      <SectionHeading
        spaced
        actions={
          canEdit && (
            <Button size="small" variant="secondary" onClick={() => setEditing("new")}>
              Lägg till regel
            </Button>
          )
        }
      >
        Regler
      </SectionHeading>
      <FormError margin="below">{error}</FormError>
      {rules.length === 0 && <FormHint>Inga regler ännu</FormHint>}
      <div>
        {rules.map((rule, index) => (
          <div key={rule.id} className={`${styles.listItem} ${rule.active ? "" : styles.inactive}`}>
            <span className={styles.listText}>
              {ruleText(rule, groups)} — <em>{rule.message}</em>
            </span>
            {canEdit && (
              <span className={styles.listActions}>
                <label className={styles.inline}>
                  <Checkbox
                    checked={rule.active}
                    onChange={(e) =>
                      void run(
                        () => apiFetch(`${base}/${rule.id}`, { method: "PATCH", body: JSON.stringify({ active: e.target.checked }) }),
                        "Kunde inte ändra regeln",
                      )
                    }
                  />
                  Aktiv
                </label>
                <Button size="small" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
                  Upp
                </Button>
                <Button size="small" variant="ghost" disabled={index === rules.length - 1} onClick={() => move(index, 1)}>
                  Ned
                </Button>
                <Button size="small" variant="secondary" onClick={() => setEditing(rule.id)}>
                  Ändra
                </Button>
                <Button
                  size="small"
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirmDelete("Ta bort regeln?"))) return;
                    void run(() => apiFetch(`${base}/${rule.id}`, { method: "DELETE" }), "Kunde inte ta bort regeln");
                  }}
                >
                  Ta bort
                </Button>
              </span>
            )}
          </div>
        ))}
      </div>
      <RuleModal
        articleId={articleId}
        groups={groups}
        rule={editing === "new" ? null : editingRule}
        open={editing !== null && (editing === "new" || editingRule !== null)}
        onClose={() => setEditing(null)}
        onChanged={onChanged}
      />
    </div>
  );
}
