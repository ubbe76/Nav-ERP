"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  CONFIGURATOR_RULE_EFFECT_LABELS,
  type ConfiguratorCondition,
  type ConfiguratorGroupDetail,
  type ConfiguratorRuleDetail,
  type ConfiguratorRuleEffect,
} from "../../lib/configurator";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";
import {
  ConditionEditor,
  ConditionRow,
  TARGET_BLOCKED,
  emptyDraft,
  fromCondition,
  toCondition,
  type ConditionDraft,
} from "./ConditionEditor";
import styles from "./RuleModal.module.css";

const EFFECT_OPTIONS = (Object.keys(CONFIGURATOR_RULE_EFFECT_LABELS) as ConfiguratorRuleEffect[]).map((value) => ({
  value,
  label: CONFIGURATOR_RULE_EFFECT_LABELS[value],
}));

interface RuleModalProps {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  /** null = a new rule. */
  rule: ConfiguratorRuleDetail | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

export function RuleModal({ open, onClose, rule, ...rest }: RuleModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={rule ? "Ändra regel" : "Lägg till regel"} wide>
      <RuleForm key={rule?.id ?? "new"} rule={rule} onClose={onClose} {...rest} />
    </Modal>
  );
}

function RuleForm({ articleId, groups, rule, onClose, onChanged }: Omit<RuleModalProps, "open">) {
  const [effect, setEffect] = useState<ConfiguratorRuleEffect>(rule?.effect ?? "exclude");
  const [conditions, setConditions] = useState<ConditionDraft[]>(
    rule ? rule.conditions.map((c, i) => fromCondition(i, c)) : [],
  );
  // exclude / limit target
  const [targetGroupId, setTargetGroupId] = useState(rule && rule.effect !== "require" ? rule.target.groupId : "");
  const [targetValueIds, setTargetValueIds] = useState<string[]>(
    rule?.effect === "exclude" && "valueIds" in rule.target ? rule.target.valueIds : [],
  );
  const limitTarget = rule?.effect === "limit" ? (rule.target as { min?: number; max?: number }) : null;
  const [min, setMin] = useState(limitTarget?.min === undefined ? "" : String(limitTarget.min));
  const [max, setMax] = useState(limitTarget?.max === undefined ? "" : String(limitTarget.max));
  // require target — a condition in the same row form
  const [requireTarget, setRequireTarget] = useState<ConditionDraft>(
    rule?.effect === "require" ? fromCondition(0, rule.target as ConfiguratorCondition) : emptyDraft(0),
  );
  const [message, setMessage] = useState(rule?.message ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const conditionGroupIds = conditions.map((c) => c.groupId).filter(Boolean);
  // The target group may not appear in the conditions — checked both ways.
  const activeTargetId = effect === "require" ? requireTarget.groupId : targetGroupId;
  const targetConflict = activeTargetId !== "" && conditionGroupIds.includes(activeTargetId);

  function buildBody(): Record<string, unknown> {
    const built = conditions.map((c) => toCondition(c, groups));
    let target: unknown;
    if (effect === "exclude") {
      if (!targetGroupId) throw new Error("Välj målgrupp");
      if (targetValueIds.length === 0) throw new Error("Välj minst ett alternativ att utesluta");
      target = { groupId: targetGroupId, valueIds: targetValueIds };
    } else if (effect === "require") {
      target = toCondition(requireTarget, groups);
    } else {
      if (!targetGroupId) throw new Error("Välj målgrupp");
      if (min.trim() === "" && max.trim() === "") throw new Error("Ange Min, Max eller båda");
      target = {
        groupId: targetGroupId,
        ...(min.trim() !== "" ? { min: Number(min) } : {}),
        ...(max.trim() !== "" ? { max: Number(max) } : {}),
      };
    }
    if (message.trim() === "") throw new Error("Ange ett meddelande");
    return { effect, conditions: built, target, message: message.trim(), active: rule?.active ?? true };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let body: Record<string, unknown>;
    try {
      body = buildBody();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setPending(true);
    try {
      const base = `/api/v1/articles/${articleId}/configurator/rules`;
      await apiFetch(rule ? `${base}/${rule.id}` : base, {
        method: rule ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      await onChanged();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara regeln"));
    } finally {
      setPending(false);
    }
  }

  const targetGroups = groups.filter((g) => (effect === "exclude" ? g.kind === "choice" : g.kind === "number"));
  const targetGroup = groups.find((g) => g.id === targetGroupId);

  return (
    <Form onSubmit={submit}>
      <ConditionEditor conditions={conditions} groups={groups} onChange={setConditions} />

      <Field label="Effekt">
        <SegmentedToggle<ConfiguratorRuleEffect>
          value={effect}
          options={EFFECT_OPTIONS}
          ariaLabel="Effekt"
          onChange={(next) => {
            setEffect(next);
            setTargetGroupId("");
            setTargetValueIds([]);
          }}
        />
      </Field>

      <h4 className={styles.subHeading}>Mål</h4>
      {effect === "require" ? (
        <ConditionRow
          draft={requireTarget}
          groups={groups}
          blockedGroupIds={conditionGroupIds}
          onChange={(patch) => setRequireTarget((d) => ({ ...d, ...patch }))}
        />
      ) : (
        <>
          <Field label="Grupp" htmlFor="cfg-rule-target-group">
            <Select
              id="cfg-rule-target-group"
              value={targetGroupId}
              onChange={(e) => {
                setTargetGroupId(e.target.value);
                setTargetValueIds([]);
              }}
            >
              <option value="">— Välj —</option>
              {targetGroups.map((g) => {
                const blocked = conditionGroupIds.includes(g.id);
                return (
                  <option key={g.id} value={g.id} disabled={blocked} title={blocked ? TARGET_BLOCKED : undefined}>
                    {g.name} ({g.code})
                  </option>
                );
              })}
            </Select>
          </Field>
          {effect === "exclude" && targetGroup && (
            <Field label="Alternativ">
              <div className={styles.checks}>
                {targetGroup.values.map((v) => (
                  <label key={v.id} className={styles.inline}>
                    <Checkbox
                      checked={targetValueIds.includes(v.id)}
                      onChange={(e) =>
                        setTargetValueIds((ids) => (e.target.checked ? [...ids, v.id] : ids.filter((x) => x !== v.id)))
                      }
                    />
                    {v.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
          {effect === "limit" && (
            <FormRow>
              <Field label="Min" htmlFor="cfg-rule-min">
                <Input id="cfg-rule-min" type="number" min="0" step="any" value={min} onChange={(e) => setMin(e.target.value)} />
              </Field>
              <Field label="Max" htmlFor="cfg-rule-max">
                <Input id="cfg-rule-max" type="number" min="0" step="any" value={max} onChange={(e) => setMax(e.target.value)} />
              </Field>
            </FormRow>
          )}
        </>
      )}

      <Field label="Meddelande" htmlFor="cfg-rule-message">
        <Input
          id="cfg-rule-message"
          value={message}
          maxLength={255}
          required
          placeholder={'Visas för användaren, t.ex. "Elpolerad finns inte med lock C"'}
          onChange={(e) => setMessage(e.target.value)}
        />
      </Field>

      {targetConflict && <FormError>{TARGET_BLOCKED}</FormError>}
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" disabled={pending || targetConflict}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
