"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { ConfiguratorGroupDetail, VariantPreviewRow } from "../../lib/configurator";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { parseDecimal } from "./parseDecimal";
import { VariantPreviewTable, summarize } from "./VariantPreviewTable";
import styles from "./Variants.module.css";

interface Props {
  open: boolean;
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  /** The template's Ordervolym, the default for Kalkylantal. */
  defaultQuantity: number;
  onClose: () => void;
  /** Reload the variant list. */
  onChanged: () => void | Promise<void>;
  /** Changes on every opening so the form starts fresh. */
  openKey: number;
}

type SetValue = string[] | boolean[] | number[];

// "12,5; 20" -> [12.5, 20]. Null when a part is not a number.
function parseNumberList(raw: string): number[] | null {
  const parts = raw
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const out: number[] = [];
  for (const p of parts) {
    const n = parseDecimal(p);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

function decimalComma(v: string | null): string {
  return v === null ? "" : String(Number(v)).replace(".", ",");
}

export function CreateVariantsModal(props: Props) {
  return (
    <Modal open={props.open} onClose={props.onClose} title="Skapa varianter" wide>
      <CreateVariantsForm key={props.openKey} {...props} />
    </Modal>
  );
}

function CreateVariantsForm({ articleId, groups, defaultQuantity, onClose, onChanged }: Props) {
  const base = `/api/v1/articles/${articleId}/configurator/variants`;
  // Checked alternative codes per choice group (all active ones to start with).
  const [choice, setChoice] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      groups.filter((g) => g.kind === "choice").map((g) => [g.code, g.values.filter((v) => v.active).map((v) => v.code)]),
    ),
  );
  const [bool, setBool] = useState<Record<string, { with: boolean; without: boolean }>>(() =>
    Object.fromEntries(groups.filter((g) => g.kind === "boolean").map((g) => [g.code, { with: true, without: true }])),
  );
  const [numbers, setNumbers] = useState<Record<string, string>>(() =>
    Object.fromEntries(groups.filter((g) => g.kind === "number").map((g) => [g.code, decimalComma(g.defaultNumber)])),
  );
  const [quantityRaw, setQuantityRaw] = useState(String(defaultQuantity));
  const [rows, setRows] = useState<VariantPreviewRow[] | null>(null);
  const [created, setCreated] = useState(false);
  // The exact request body of the last preview; Skapa sends this very body.
  const [previewedBody, setPreviewedBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function change(fn: () => void) {
    fn();
    setError(null);
  }

  // A group without a checked value is left out, and the engine default applies.
  function buildBody(): { sets: Record<string, SetValue>; calcQuantity: number } | string {
    const quantity = parseDecimal(quantityRaw);
    if (quantity === null || quantity <= 0) return "Kalkylantal måste vara större än 0";
    const sets: Record<string, SetValue> = {};
    for (const g of groups) {
      if (g.kind === "choice") {
        const codes = g.values.filter((v) => v.active && choice[g.code]?.includes(v.code)).map((v) => v.code);
        if (codes.length > 0) sets[g.code] = codes;
      } else if (g.kind === "boolean") {
        const b = bool[g.code];
        const list: boolean[] = [];
        if (b?.with) list.push(true);
        if (b?.without) list.push(false);
        if (list.length > 0) sets[g.code] = list;
      } else {
        const list = parseNumberList(numbers[g.code] ?? "");
        if (list === null) return `${g.name}: skriv tal med decimalkomma, åtskilda med semikolon`;
        if (list.length > 0) sets[g.code] = list;
      }
    }
    return { sets, calcQuantity: quantity };
  }

  const currentBody = buildBody();
  // Skapa needs a preview of exactly what the form holds now.
  const dirty = previewedBody === null || typeof currentBody === "string" || JSON.stringify(currentBody) !== previewedBody;

  async function run(path: string, json: string): Promise<VariantPreviewRow[] | null> {
    setError(null);
    setPending(true);
    try {
      return await apiFetch<VariantPreviewRow[]>(path, { method: "POST", body: json });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte räkna ut varianterna"));
      return null;
    } finally {
      setPending(false);
    }
  }

  async function preview() {
    const body = buildBody();
    if (typeof body === "string") {
      setError(body);
      return;
    }
    const json = JSON.stringify(body);
    const res = await run(`${base}/preview`, json);
    if (res) {
      setRows(res);
      setPreviewedBody(json);
    }
  }

  async function create() {
    if (previewedBody === null || dirty) return;
    const res = await run(base, previewedBody);
    if (res) {
      setRows(res);
      setCreated(true);
      await onChanged();
    }
  }

  const newCount = rows ? rows.filter((r) => r.status === "new").length : 0;

  return (
    <Form onSubmit={(e) => e.preventDefault()}>
      {!created && (
        <>
          <div className={styles.stack}>
            {groups.map((g) => (
              <div key={g.id} className={styles.group}>
                <h4 className={styles.groupTitle}>{g.name}</h4>
                {g.kind === "choice" && (
                  <div className={styles.checks}>
                    {g.values
                      .filter((v) => v.active)
                      .map((v) => (
                        <label key={v.id} className={styles.inline}>
                          <Checkbox
                            checked={choice[g.code]?.includes(v.code) ?? false}
                            onChange={(e) =>
                              change(() =>
                                setChoice((c) => {
                                  const cur = c[g.code] ?? [];
                                  return {
                                    ...c,
                                    [g.code]: e.target.checked ? [...cur, v.code] : cur.filter((x) => x !== v.code),
                                  };
                                }),
                              )
                            }
                          />
                          {v.name}
                        </label>
                      ))}
                  </div>
                )}
                {g.kind === "boolean" && (
                  <div className={styles.checks}>
                    {(["with", "without"] as const).map((k) => (
                      <label key={k} className={styles.inline}>
                        <Checkbox
                          checked={bool[g.code]?.[k] ?? false}
                          onChange={(e) =>
                            change(() =>
                              setBool((b) => ({
                                ...b,
                                [g.code]: { with: true, without: true, ...b[g.code], [k]: e.target.checked },
                              })),
                            )
                          }
                        />
                        {k === "with" ? "Med" : "Utan"}
                      </label>
                    ))}
                  </div>
                )}
                {g.kind === "number" && (
                  <Field label={g.unit ? `Värden (${g.unit}), åtskilda med ;` : "Värden, åtskilda med ;"} htmlFor={`cfg-vars-${g.code}`}>
                    <Input
                      id={`cfg-vars-${g.code}`}
                      inputMode="decimal"
                      value={numbers[g.code] ?? ""}
                      onChange={(e) => change(() => setNumbers((n) => ({ ...n, [g.code]: e.target.value })))}
                    />
                  </Field>
                )}
              </div>
            ))}
          </div>
          <FormHint>
            En grupp utan ikryssade alternativ utelämnas, och då gäller gruppens förval.
          </FormHint>
          <Field label="Kalkylantal" htmlFor="cfg-vars-quantity">
            <Input
              id="cfg-vars-quantity"
              type="number"
              min="0"
              step="any"
              value={quantityRaw}
              onChange={(e) => change(() => setQuantityRaw(e.target.value))}
            />
          </Field>
        </>
      )}
      <FormError>{error}</FormError>
      {rows && (
        <>
          <p className={styles.summary}>{summarize(rows)}</p>
          <VariantPreviewTable rows={rows} />
        </>
      )}
      <FormActions>
        {!created && (
          <>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => void preview()}>
              Förhandsgranska
            </Button>
            <Button type="button" disabled={pending || dirty || newCount === 0} onClick={() => void create()}>
              Skapa {newCount} {newCount === 1 ? "variant" : "varianter"}
            </Button>
          </>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          {created ? "Stäng" : "Avbryt"}
        </Button>
      </FormActions>
    </Form>
  );
}
