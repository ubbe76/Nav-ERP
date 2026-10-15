"use client";

import { useRef } from "react";
import {
  CONDITION_OP_LABELS,
  type ConfiguratorCondition,
  type ConfiguratorGroupDetail,
  type ConfiguratorGroupKind,
} from "../../lib/configurator";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { FormHint, FormLineRow, FormLineRowTop, FormRow } from "../ui/Form";
import styles from "./RuleModal.module.css";

export type Op = ConfiguratorCondition["op"];

const OPS_BY_KIND: Record<ConfiguratorGroupKind, Op[]> = {
  choice: ["is", "is_not"],
  boolean: ["selected", "not_selected"],
  number: ["eq", "ne", "lt", "le", "gt", "ge"],
};

export const TARGET_BLOCKED = "Målgruppen kan inte stå i regelns egna villkor";

export interface ConditionDraft {
  key: number;
  groupId: string;
  op: Op | "";
  valueIds: string[];
  value: string;
}

export const emptyDraft = (key: number): ConditionDraft => ({ key, groupId: "", op: "", valueIds: [], value: "" });

export function fromCondition(key: number, c: ConfiguratorCondition): ConditionDraft {
  return {
    key,
    groupId: c.groupId,
    op: c.op,
    valueIds: "valueIds" in c ? c.valueIds : [],
    value: "value" in c ? String(Number(c.value)) : "",
  };
}

// Throws a Swedish message when the row is incomplete.
export function toCondition(d: ConditionDraft, groups: ConfiguratorGroupDetail[]): ConfiguratorCondition {
  const group = groups.find((g) => g.id === d.groupId);
  if (!group || d.op === "") throw new Error("Välj grupp och operator för varje villkor");
  if (group.kind === "choice") {
    if (d.valueIds.length === 0) throw new Error(`Välj minst ett alternativ för ${group.name}`);
    return { groupId: group.id, op: d.op as "is" | "is_not", valueIds: d.valueIds };
  }
  if (group.kind === "boolean") return { groupId: group.id, op: d.op as "selected" | "not_selected" };
  const value = Number(d.value);
  if (d.value.trim() === "" || !Number.isFinite(value)) throw new Error(`Ange ett värde för ${group.name}`);
  return { groupId: group.id, op: d.op as "eq", value };
}

// The "Villkor" block shared by rules, conditional lines and operations: rows of
// Grupp → Operator → Värde plus "+ Villkor".
export function ConditionEditor({
  conditions,
  groups,
  onChange,
  emptyHint = "Utan villkor gäller regeln alltid.",
}: {
  conditions: ConditionDraft[];
  groups: ConfiguratorGroupDetail[];
  onChange: (next: ConditionDraft[]) => void;
  emptyHint?: string;
}) {
  const nextKey = useRef(1000);
  return (
    <>
      <h4 className={styles.subHeading}>Villkor</h4>
      {conditions.length === 0 && <FormHint>{emptyHint}</FormHint>}
      {conditions.map((c) => (
        <ConditionRow
          key={c.key}
          draft={c}
          groups={groups}
          blockedGroupIds={[]}
          onChange={(patch) => onChange(conditions.map((x) => (x.key === c.key ? { ...x, ...patch } : x)))}
          onRemove={() => onChange(conditions.filter((x) => x.key !== c.key))}
        />
      ))}
      <div>
        <Button
          type="button"
          size="small"
          variant="secondary"
          onClick={() => onChange([...conditions, emptyDraft(nextKey.current++)])}
        >
          + Villkor
        </Button>
      </div>
    </>
  );
}

// Grupp → Operator → Värde. The value field follows the group's kind.
export function ConditionRow({
  draft,
  groups,
  blockedGroupIds,
  onChange,
  onRemove,
}: {
  draft: ConditionDraft;
  groups: ConfiguratorGroupDetail[];
  blockedGroupIds: string[];
  onChange: (patch: Partial<ConditionDraft>) => void;
  onRemove?: () => void;
}) {
  const group = groups.find((g) => g.id === draft.groupId);
  const ops = group ? OPS_BY_KIND[group.kind] : [];
  const uid = `cfg-cond-${draft.key}`;
  return (
    <FormLineRow>
      <FormLineRowTop>
        <Field label="Grupp" htmlFor={`${uid}-group`}>
          <Select
            id={`${uid}-group`}
            value={draft.groupId}
            onChange={(e) => {
              const next = groups.find((g) => g.id === e.target.value);
              onChange({
                groupId: e.target.value,
                op: next ? OPS_BY_KIND[next.kind][0]! : "",
                valueIds: [],
                value: "",
              });
            }}
          >
            <option value="">— Välj —</option>
            {groups.map((g) => {
              const blocked = blockedGroupIds.includes(g.id);
              return (
                <option key={g.id} value={g.id} disabled={blocked} title={blocked ? TARGET_BLOCKED : undefined}>
                  {g.name} ({g.code})
                </option>
              );
            })}
          </Select>
        </Field>
        {onRemove && (
          <Button type="button" size="small" variant="danger" onClick={onRemove}>
            Ta bort
          </Button>
        )}
      </FormLineRowTop>
      {group && (
        <FormRow>
          <Field label="Operator" htmlFor={`${uid}-op`}>
            <Select id={`${uid}-op`} value={draft.op} onChange={(e) => onChange({ op: e.target.value as Op })}>
              {ops.map((op) => (
                <option key={op} value={op}>
                  {CONDITION_OP_LABELS[op]}
                </option>
              ))}
            </Select>
          </Field>
          {group.kind === "choice" && (
            <Field label="Värde">
              <div className={styles.checks}>
                {group.values.map((v) => (
                  <label key={v.id} className={styles.inline}>
                    <Checkbox
                      checked={draft.valueIds.includes(v.id)}
                      onChange={(e) =>
                        onChange({
                          valueIds: e.target.checked ? [...draft.valueIds, v.id] : draft.valueIds.filter((x) => x !== v.id),
                        })
                      }
                    />
                    {v.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
          {group.kind === "number" && (
            <Field label={group.unit ? `Värde (${group.unit})` : "Värde"} htmlFor={`${uid}-value`}>
              <Input
                id={`${uid}-value`}
                type="number"
                min="0"
                step="any"
                value={draft.value}
                onChange={(e) => onChange({ value: e.target.value })}
              />
            </Field>
          )}
        </FormRow>
      )}
    </FormLineRow>
  );
}
