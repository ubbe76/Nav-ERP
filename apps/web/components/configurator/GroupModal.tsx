"use client";

import { confirmDelete } from "../../lib/confirm";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  CONFIGURATOR_GROUP_KIND_LABELS,
  type ConfiguratorArticleField,
  type ConfiguratorGroupDetail,
  type ConfiguratorGroupKind,
  type ConfiguratorValueDetail,
} from "../../lib/configurator";
import { Modal } from "../ui/Modal";
import { ArticlePicker, type ArticlePickerValue } from "../ui/ArticlePicker";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import styles from "./GroupModal.module.css";

interface GroupModalProps {
  articleId: string;
  /** null = a new group. */
  group: ConfiguratorGroupDetail | null;
  open: boolean;
  onClose: () => void;
  /** Reload the template. */
  onChanged: () => void | Promise<void>;
  /** A new group was created — the parent switches the modal to edit mode. */
  onCreated: (groupId: string) => void;
}

const KIND_OPTIONS = (
  Object.keys(CONFIGURATOR_GROUP_KIND_LABELS) as ConfiguratorGroupKind[]
).map((value) => ({
  value,
  label: CONFIGURATOR_GROUP_KIND_LABELS[value],
}));

// Numbers come from the API as "1000.0000"; the form shows them trimmed.
function trimNumber(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  return String(Number(v));
}

function sameNumber(a: string, b: string | null | undefined): boolean {
  const left = a.trim() === "" ? null : Number(a);
  const right = b === null || b === undefined || b === "" ? null : Number(b);
  return left === right;
}

export function GroupModal({
  articleId,
  group,
  open,
  onClose,
  onChanged,
  onCreated,
}: GroupModalProps) {
  const title = group ? `Ändra valgrupp ${group.code}` : "Lägg till valgrupp";
  // The alternative editor registers a flush here; every way of closing the
  // dialog (X, Escape, backdrop, Stäng, Spara) saves pending edits first and
  // stays open, with the error shown, when a save fails.
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const requestClose = async () => {
    const ok = flushRef.current ? await flushRef.current() : true;
    if (ok) onClose();
  };
  return (
    <Modal open={open} onClose={() => void requestClose()} title={title} wide>
      <GroupForm
        key={group?.id ?? "new"}
        articleId={articleId}
        group={group}
        flushRef={flushRef}
        onClose={requestClose}
        onChanged={onChanged}
        onCreated={onCreated}
      />
    </Modal>
  );
}

function GroupForm({
  articleId,
  group,
  flushRef,
  onClose,
  onChanged,
  onCreated,
}: Omit<GroupModalProps, "open" | "onClose"> & {
  flushRef: { current: (() => Promise<boolean>) | null };
  onClose: () => void | Promise<void>;
}) {
  const base = `/api/v1/articles/${articleId}/configurator/groups`;
  const [kind, setKind] = useState<ConfiguratorGroupKind>(
    group?.kind ?? "choice",
  );
  const [code, setCode] = useState(group?.code ?? "");
  const [name, setName] = useState(group?.name ?? "");
  const [required, setRequired] = useState(group?.required ?? false);
  const [priceAdd, setPriceAdd] = useState(
    group ? trimNumber(group.priceAdd) : "0",
  );
  const [unit, setUnit] = useState(group?.unit ?? "");
  const [minValue, setMinValue] = useState(trimNumber(group?.minValue));
  const [maxValue, setMaxValue] = useState(trimNumber(group?.maxValue));
  const [step, setStep] = useState(trimNumber(group?.step));
  const [defaultNumber, setDefaultNumber] = useState(
    trimNumber(group?.defaultNumber),
  );
  const [pricePerUnit, setPricePerUnit] = useState(
    group ? trimNumber(group.pricePerUnit) : "0",
  );
  const [priceBaseValue, setPriceBaseValue] = useState(
    group ? trimNumber(group.priceBaseValue) : "0",
  );
  const [articleField, setArticleField] = useState<ConfiguratorArticleField | "">(
    group?.articleField ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function createBody(): Record<string, unknown> {
    const common = { kind, code, name: name.trim() };
    if (kind === "choice")
      return { ...common, required, articleField: articleField || null };
    if (kind === "boolean")
      return { ...common, priceAdd: Number(priceAdd || 0) };
    return {
      ...common,
      required,
      unit: unit.trim() === "" ? null : unit.trim(),
      minValue: Number(minValue),
      maxValue: Number(maxValue),
      step: step.trim() === "" ? null : Number(step),
      defaultNumber: defaultNumber.trim() === "" ? null : Number(defaultNumber),
      pricePerUnit: Number(pricePerUnit || 0),
      priceBaseValue: Number(priceBaseValue || 0),
    };
  }

  // Only fields that changed — and only those that belong to the group's kind —
  // so the server's kind check never sees a foreign field.
  function patchBody(g: ConfiguratorGroupDetail): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (code !== g.code) patch.code = code;
    if (name.trim() !== g.name) patch.name = name.trim();
    if (g.kind !== "boolean" && required !== g.required)
      patch.required = required;
    if (g.kind === "choice" && (articleField || null) !== g.articleField)
      patch.articleField = articleField || null;
    if (g.kind === "boolean" && !sameNumber(priceAdd, g.priceAdd))
      patch.priceAdd = Number(priceAdd || 0);
    if (g.kind === "number") {
      if ((unit.trim() || null) !== g.unit)
        patch.unit = unit.trim() === "" ? null : unit.trim();
      if (!sameNumber(minValue, g.minValue)) patch.minValue = Number(minValue);
      if (!sameNumber(maxValue, g.maxValue)) patch.maxValue = Number(maxValue);
      if (!sameNumber(step, g.step))
        patch.step = step.trim() === "" ? null : Number(step);
      if (!sameNumber(defaultNumber, g.defaultNumber))
        patch.defaultNumber =
          defaultNumber.trim() === "" ? null : Number(defaultNumber);
      if (!sameNumber(pricePerUnit, g.pricePerUnit))
        patch.pricePerUnit = Number(pricePerUnit || 0);
      if (!sameNumber(priceBaseValue, g.priceBaseValue))
        patch.priceBaseValue = Number(priceBaseValue || 0);
    }
    return patch;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (!group) {
        const created = await apiFetch<ConfiguratorGroupDetail>(base, {
          method: "POST",
          body: JSON.stringify(createBody()),
        });
        // Reload first so the edit-mode modal finds the group in the list.
        await onChanged();
        // A list group continues in edit mode so its alternatives can be added.
        if (kind === "choice") onCreated(created.id);
        else await onClose();
      } else {
        const patch = patchBody(group);
        if (Object.keys(patch).length > 0) {
          await apiFetch(`${base}/${group.id}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
          });
          await onChanged();
        }
        await onClose();
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara valgruppen"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Form onSubmit={onSubmit}>
        {!group && (
          <Field label="Sort">
            <SegmentedToggle
              value={kind}
              options={KIND_OPTIONS}
              onChange={setKind}
              ariaLabel="Sort"
            />
          </Field>
        )}
        {group && (
          <FormHint>
            Sort: {CONFIGURATOR_GROUP_KIND_LABELS[group.kind]}
          </FormHint>
        )}

        <FormRow>
          <Field label="Kod" htmlFor="cfg-group-code">
            <Input
              id="cfg-group-code"
              value={code}
              maxLength={20}
              required
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Namn" htmlFor="cfg-group-name">
            <Input
              id="cfg-group-name"
              value={name}
              maxLength={100}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </FormRow>

        {kind !== "boolean" && (
          <label className={styles.inline}>
            <Checkbox
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            Obligatorisk
          </label>
        )}

        {kind === "choice" && (
          <Field label="Fyller artikelns fält" htmlFor="cfg-group-article-field">
            <Select
              id="cfg-group-article-field"
              value={articleField}
              onChange={(e) =>
                setArticleField(e.target.value as ConfiguratorArticleField | "")
              }
            >
              <option value="">—</option>
              <option value="colour">Färg</option>
              <option value="surface_treatment">Ytbehandling</option>
            </Select>
            <FormHint>
              Varianten får det valda alternativets namn i det här fältet på artikeln.
            </FormHint>
          </Field>
        )}

        {kind === "boolean" && (
          <Field label="Pristillägg" htmlFor="cfg-group-price">
            <Input
              id="cfg-group-price"
              type="number"
              step="0.01"
              value={priceAdd}
              onChange={(e) => setPriceAdd(e.target.value)}
            />
          </Field>
        )}

        {kind === "number" && (
          <>
            <FormRow columns={3}>
              <Field label="Enhet" htmlFor="cfg-group-unit">
                <Input
                  id="cfg-group-unit"
                  value={unit}
                  maxLength={20}
                  onChange={(e) => setUnit(e.target.value)}
                />
              </Field>
              <Field label="Min" htmlFor="cfg-group-min">
                <Input
                  id="cfg-group-min"
                  type="number"
                  min="0"
                  step="any"
                  required
                  value={minValue}
                  onChange={(e) => setMinValue(e.target.value)}
                />
              </Field>
              <Field label="Max" htmlFor="cfg-group-max">
                <Input
                  id="cfg-group-max"
                  type="number"
                  min="0"
                  step="any"
                  required
                  value={maxValue}
                  onChange={(e) => setMaxValue(e.target.value)}
                />
              </Field>
            </FormRow>
            <FormRow columns={2}>
              <Field label="Steg" htmlFor="cfg-group-step">
                <Input
                  id="cfg-group-step"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Fritt"
                  value={step}
                  onChange={(e) => setStep(e.target.value)}
                />
              </Field>
              <Field label="Förval" htmlFor="cfg-group-default">
                <Input
                  id="cfg-group-default"
                  type="number"
                  min="0"
                  step="any"
                  value={defaultNumber}
                  onChange={(e) => setDefaultNumber(e.target.value)}
                />
              </Field>
            </FormRow>
            <FormRow columns={2}>
              <Field label="Pris per enhet" htmlFor="cfg-group-ppu">
                <Input
                  id="cfg-group-ppu"
                  type="number"
                  min="0"
                  step="0.01"
                  value={pricePerUnit}
                  onChange={(e) => setPricePerUnit(e.target.value)}
                />
              </Field>
              <Field label="Räknas över" htmlFor="cfg-group-base">
                <Input
                  id="cfg-group-base"
                  type="number"
                  min="0"
                  step="any"
                  value={priceBaseValue}
                  onChange={(e) => setPriceBaseValue(e.target.value)}
                />
              </Field>
            </FormRow>
            <FormHint>
              Tillägget räknas på det som överstiger Räknas över.
            </FormHint>
          </>
        )}

        <FormError>{error}</FormError>
        <FormActions>
          <Button type="submit" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void onClose()}
          >
            Stäng
          </Button>
        </FormActions>

        {!group && kind === "choice" && (
          <FormHint>Spara gruppen för att lägga till alternativ.</FormHint>
        )}
      </Form>
      {group && group.kind === "choice" && (
        <ValueEditor
          articleId={articleId}
          group={group}
          flushRef={flushRef}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

function ValueEditor({
  articleId: templateId,
  group,
  flushRef,
  onChanged,
}: {
  articleId: string;
  group: ConfiguratorGroupDetail;
  flushRef: { current: (() => Promise<boolean>) | null };
  onChanged: () => void | Promise<void>;
}) {
  const groupUrl = `/api/v1/articles/${templateId}/configurator/groups/${group.id}`;
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("0");
  const [newArticle, setNewArticle] = useState<ArticlePickerValue | null>(null);
  const rowFlushers = useRef(new Map<string, () => Promise<boolean>>());

  async function run(
    fn: () => Promise<unknown>,
    fallback: string,
  ): Promise<boolean> {
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err) {
      setError(apiErrorMessage(err, fallback));
      return false;
    }
  }

  const add = async (): Promise<boolean> => {
    const ok = await run(
      () =>
        apiFetch(`${groupUrl}/values`, {
          method: "POST",
          body: JSON.stringify({
            code: newCode,
            name: newName.trim(),
            priceAdd: Number(newPrice || 0),
            ...(newArticle ? { articleId: newArticle.id } : {}),
          }),
        }),
      "Kunde inte lägga till alternativet",
    );
    if (ok) {
      setNewCode("");
      setNewName("");
      setNewPrice("0");
      setNewArticle(null);
    }
    return ok;
  };

  // Saves every edited row and a complete new-alternative row. A half-filled
  // new row is not an edit of anything stored, so it is left alone.
  const addRef = useRef(add);
  addRef.current = add;
  const draftComplete = newCode !== "" && newName.trim() !== "";
  const draftRef = useRef(draftComplete);
  draftRef.current = draftComplete;
  const draftTouchedRef = useRef(false);
  draftTouchedRef.current = newCode !== "" || newName.trim() !== "";
  useEffect(() => {
    const flushers = rowFlushers.current;
    flushRef.current = async () => {
      for (const flush of [...flushers.values()]) {
        if (!(await flush())) return false;
      }
      if (draftRef.current) return addRef.current();
      if (draftTouchedRef.current) {
        setError("Fyll i både kod och namn eller rensa raden");
        return false;
      }
      return true;
    };
    return () => {
      flushRef.current = null;
    };
  }, [flushRef]);

  const move = (index: number, dir: -1 | 1) => {
    const ids = group.values.map((v) => v.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void run(
      () =>
        apiFetch(`${groupUrl}/values/reorder`, {
          method: "POST",
          body: JSON.stringify({ ids }),
        }),
      "Kunde inte flytta alternativet",
    );
  };

  return (
    <div className={styles.valuesBlock}>
      <h4 className={styles.subHeading}>Alternativ</h4>
      {group.values.length === 0 && <FormHint>Inga alternativ ännu.</FormHint>}
      {group.values.map((value, index) => (
        <ValueRow
          key={value.id}
          register={(flush) => {
            if (flush) rowFlushers.current.set(value.id, flush);
            else rowFlushers.current.delete(value.id);
          }}
          value={value}
          templateId={templateId}
          isDefault={group.defaultValueId === value.id}
          first={index === 0}
          last={index === group.values.length - 1}
          onPatch={(patch) =>
            run(
              () =>
                apiFetch(`${groupUrl}/values/${value.id}`, {
                  method: "PATCH",
                  body: JSON.stringify(patch),
                }),
              "Kunde inte spara alternativet",
            )
          }
          onDefault={() =>
            void run(
              () =>
                apiFetch(groupUrl, {
                  method: "PATCH",
                  body: JSON.stringify({
                    defaultValueId:
                      group.defaultValueId === value.id ? null : value.id,
                  }),
                }),
              "Kunde inte sätta förvalet",
            )
          }
          onMove={(dir) => move(index, dir)}
          onDelete={async () => {
            if (!(await confirmDelete(`Ta bort alternativet ${value.code}?`))) return;
            void run(
              () =>
                apiFetch(`${groupUrl}/values/${value.id}`, {
                  method: "DELETE",
                }),
              "Kunde inte ta bort alternativet",
            );
          }}
        />
      ))}

      <form
        className={styles.valueRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (draftComplete) void add();
        }}
      >
        <div className={styles.valueFields}>
          <Field label="Kod" htmlFor="cfg-new-value-code">
            <Input
              id="cfg-new-value-code"
              value={newCode}
              maxLength={20}
              onChange={(e) => {
                setError(null);
                setNewCode(e.target.value.toUpperCase());
              }}
            />
          </Field>
          <Field label="Namn" htmlFor="cfg-new-value-name">
            <Input
              id="cfg-new-value-name"
              value={newName}
              maxLength={100}
              onChange={(e) => {
                setError(null);
                setNewName(e.target.value);
              }}
            />
          </Field>
          <Field label="Tillägg" htmlFor="cfg-new-value-price">
            <Input
              id="cfg-new-value-price"
              type="number"
              step="0.01"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
            />
          </Field>
          <Field label="Artikel" htmlFor="cfg-new-value-article">
            <ArticlePicker
              id="cfg-new-value-article"
              value={newArticle}
              excludeId={templateId}
              onChange={setNewArticle}
            />
          </Field>
        </div>
        <div>
          <Button type="submit" variant="secondary" disabled={!draftComplete}>
            Lägg till alternativ
          </Button>
        </div>
      </form>
      <FormError>{error}</FormError>
    </div>
  );
}

function ValueRow({
  register,
  value,
  templateId,
  isDefault,
  first,
  last,
  onPatch,
  onDefault,
  onMove,
  onDelete,
}: {
  register: (flush: (() => Promise<boolean>) | null) => void;
  value: ConfiguratorValueDetail;
  templateId: string;
  isDefault: boolean;
  first: boolean;
  last: boolean;
  onPatch: (patch: Record<string, unknown>) => Promise<boolean>;
  onDefault: () => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [code, setCode] = useState(value.code);
  const [name, setName] = useState(value.name);
  const [price, setPrice] = useState(trimNumber(value.priceAdd));
  const storedArticle: ArticlePickerValue | null = value.articleId
    ? { id: value.articleId, articleNumber: value.articleNumber ?? "", name: value.articleName ?? "" }
    : null;
  const [article, setArticle] = useState<ArticlePickerValue | null>(storedArticle);
  const uid = useId();
  const [rowError, setRowError] = useState<string | null>(null);
  // The save in flight, so a blur flush and a close flush never send the same
  // patch twice.
  const inflight = useRef<{ key: string; promise: Promise<boolean> } | null>(
    null,
  );

  // Only the changed fields, so a PATCH never repeats stored values.
  function pendingPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (code !== value.code) patch.code = code;
    if (name.trim() !== value.name) patch.name = name.trim();
    if (!sameNumber(price, value.priceAdd)) patch.priceAdd = Number(price || 0);
    if ((article?.id ?? null) !== value.articleId) patch.articleId = article?.id ?? null;
    return patch;
  }

  // Saves the row's edits; a rejected save restores the stored values so the
  // row never shows something the server refused.
  async function flush(): Promise<boolean> {
    if (code === "" || name.trim() === "") {
      setRowError("Kod och namn får inte vara tomma");
      return false;
    }
    const patch = pendingPatch();
    if (Object.keys(patch).length === 0) return true;
    const key = JSON.stringify(patch);
    if (inflight.current?.key === key) return inflight.current.promise;
    const promise = (async () => {
      const ok = await onPatch(patch);
      if (!ok) {
        setCode(value.code);
        setName(value.name);
        setPrice(trimNumber(value.priceAdd));
        setArticle(storedArticle);
      }
      return ok;
    })();
    inflight.current = { key, promise };
    try {
      return await promise;
    } finally {
      if (inflight.current?.promise === promise) inflight.current = null;
    }
  }

  // Picking (or clearing) the article is a discrete choice, saved at once.
  const pickedId = article?.id ?? null;
  useEffect(() => {
    if (pickedId !== value.articleId) void flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedId]);

  // Re-registered every render so the dialog's close handler sees fresh state.
  useEffect(() => {
    register(flush);
    return () => register(null);
  });

  return (
    <form
      className={styles.valueRow}
      onSubmit={(e) => {
        e.preventDefault();
        void flush();
      }}
    >
      <button type="submit" hidden />
      <div className={styles.valueFields}>
        <Field label="Kod" htmlFor={`${uid}-code`}>
          <Input
            id={`${uid}-code`}
            value={code}
            maxLength={20}
            onChange={(e) => {
              setRowError(null);
              setCode(e.target.value.toUpperCase());
            }}
            onBlur={() => void flush()}
          />
        </Field>
        <Field label="Namn" htmlFor={`${uid}-name`}>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={100}
            onChange={(e) => {
              setRowError(null);
              setName(e.target.value);
            }}
            onBlur={() => void flush()}
          />
        </Field>
        <Field label="Tillägg" htmlFor={`${uid}-price`}>
          <Input
            id={`${uid}-price`}
            type="number"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            onBlur={() => void flush()}
          />
        </Field>
        <Field label="Artikel" htmlFor={`${uid}-article`}>
          <ArticlePicker
            id={`${uid}-article`}
            value={article}
            excludeId={templateId}
            onChange={(picked) => {
              setRowError(null);
              setArticle(picked);
            }}
          />
        </Field>
      </div>
      <FormError>{rowError}</FormError>
      <div className={styles.valueActions}>
        <label className={styles.inline}>
          <Checkbox
            checked={value.active}
            onChange={(e) => void onPatch({ active: e.target.checked })}
          />
          Aktiv
        </label>
        <label className={styles.inline}>
          {/* ONE handler: a click sets the default, a click on the selected
              one clears it — exactly one PATCH per click. (onChange + onClick
              both ran off the same native click, so the outcome hung on
              React's plugin order and the controlled-checked restore.) */}
          <input
            type="radio"
            name="cfg-default-value"
            checked={isDefault}
            readOnly
            onClick={onDefault}
          />
          Förval
        </label>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={first}
          onClick={() => onMove(-1)}
        >
          Upp
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={last}
          onClick={() => onMove(1)}
        >
          Ned
        </Button>
        <Button type="button" size="small" variant="danger" onClick={onDelete}>
          Ta bort
        </Button>
      </div>
    </form>
  );
}
