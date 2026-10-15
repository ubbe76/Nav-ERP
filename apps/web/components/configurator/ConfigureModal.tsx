"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, formatSignedMoney } from "../../lib/format";
import { draftLines } from "../../lib/configurationLines";
import type {
  ConfiguratorEvaluation,
  ConfiguratorGroupDetail,
  ConfiguratorSelection,
  ConfiguratorTemplateDetail,
  ResolveVariantResult,
  RowConfigurationDraft,
} from "../../lib/configurator";
import type { Article } from "../../lib/types";
import { Button } from "../ui/Button";
import { Form, FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { ConfigurationGroupFields } from "./ConfigurationGroupFields";
import { rawFromSelection, selectionFromRaw, type RawConfiguration } from "./selectionFromRaw";
import styles from "./TestConfigurationPanel.module.css";

interface Props {
  open: boolean;
  /** Remount per opening (key=). */
  openKey: number;
  /** The picked template (configuratorMode "variants" or "to_order"). */
  template: Article | null;
  /** Evaluate with the customer when the form has one. */
  customerId: string | null;
  /** False on Ny tillverkningsorder. */
  showPrice: boolean;
  /** Evaluate at this quantity (staffel); default 1. */
  quantity?: number;
  /** Prefill (Ändra konfiguration / Konfigurera om). */
  initialSelection?: ConfiguratorSelection;
  /** Dialog title; default "Konfigurera". */
  title?: string;
  /** Extra line under the heading, e.g. "Ett handskrivet à-pris ersätts av konfigurationens pris." */
  notice?: string;
  /** Given ⇒ Lägg in hands the selection + evaluation back WITHOUT calling /variant (to_order rows and Ändra konfiguration). */
  onConfigured?: (draft: RowConfigurationDraft) => void;
  /** Otherwise (variants mode on a new row) Lägg in resolves the variant. */
  onResolved?: (result: ResolveVariantResult) => void;
  /** Avbryt / Esc / ✕ — the form clears its article field. */
  onCancel: () => void;
}

// Konfigurera: pick a configuration on an order row; Lägg in fetches or
// creates the variant article and hands it back to the form.
export function ConfigureModal(props: Props) {
  // Rendered into document.body: the order forms mount this inside their own
  // <form>, and a form must not contain another form.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Closing the dialog hands focus back to the article picker, which opens its
  // result list on focus and would cover the choice lines just entered — let go of it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (props.open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.getAttribute("role") === "combobox") active.blur();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.open]);
  if (!mounted) return null;
  return createPortal(
    <Modal open={props.open} onClose={props.onCancel} title={props.title ?? "Konfigurera"}>
      {props.open && props.template && <ConfigureForm key={props.openKey} {...props} template={props.template} />}
    </Modal>,
    document.body,
  );
}

function ConfigureForm({ template, customerId, showPrice, quantity, initialSelection, notice, onConfigured, onResolved, onCancel }: Props & { template: Article }) {
  const [groups, setGroups] = useState<ConfiguratorGroupDetail[] | null>(null);
  const [raw, setRaw] = useState<RawConfiguration>({});
  const [result, setResult] = useState<ConfiguratorEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A measure is half-typed ("12,"): what the dialog shows is not what was last evaluated.
  const [halfTyped, setHalfTyped] = useState(false);
  const seq = useRef(0);
  const lastSelection = useRef<ConfiguratorSelection>({});

  // The template's groups: GET /articles/:id/configurator (office read).
  useEffect(() => {
    apiFetch<ConfiguratorTemplateDetail>(`/api/v1/articles/${template.id}/configurator`)
      .then((t) => {
        setGroups(t.groups);
        if (initialSelection) setRaw(rawFromSelection(t.groups, initialSelection));
      })
      .catch((err) => setError(apiErrorMessage(err, "Kunde inte läsa konfiguratorn")));
  }, [template.id]);

  // Debounced evaluate on every change (same race guard as TestConfigurationPanel).
  useEffect(() => {
    if (!groups) return;
    const mine = ++seq.current;
    const { selection, pending: incomplete } = selectionFromRaw(groups, raw);
    setHalfTyped(incomplete);
    if (incomplete) {
      // Bumping seq above already discards any in-flight answer; nothing is pending any more.
      setEvaluating(false);
      return;
    }
    lastSelection.current = selection;
    setEvaluating(true);
    const timer = setTimeout(() => {
      apiFetch<ConfiguratorEvaluation>(`/api/v1/configurator/${template.id}/evaluate`, {
        method: "POST",
        body: JSON.stringify({ selection, quantity: quantity ?? 1, ...(customerId ? { customerId } : {}) }),
      })
        .then((res) => {
          if (mine === seq.current) {
            setResult(res);
            setError(null);
            setEvaluating(false);
          }
        })
        .catch((err) => {
          if (mine === seq.current) {
            setResult(null);
            setError(apiErrorMessage(err, "Kunde inte utvärdera konfigurationen"));
            setEvaluating(false);
          }
        });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, groups, customerId, template.id, quantity]);

  async function insert() {
    if (!result) return;
    if (onConfigured) {
      onConfigured({ selection: lastSelection.current, evaluation: result, lines: draftLines(groups ?? [], result) });
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch<ResolveVariantResult>(`/api/v1/configurator/${template.id}/variant`, {
        method: "POST",
        body: JSON.stringify({ selection: lastSelection.current }),
      });
      onResolved?.(res);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta eller skapa varianten"));
      setPending(false);
    }
  }

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        // React bubbles submit through portals: keep it from submitting the order form behind the dialog.
        e.stopPropagation();
        if (result?.valid && !evaluating && !halfTyped && !pending) void insert();
      }}
    >
      <FormHint>
        {template.articleNumber} — {template.name}
      </FormHint>
      {notice && <FormNotice>{notice}</FormNotice>}
      {groups && groups.length === 0 && <FormNotice>Mallen har inga valgrupper.</FormNotice>}
      {groups && (
        <ConfigurationGroupFields
          groups={groups}
          raw={raw}
          onChange={(code, value) => setRaw((r) => ({ ...r, [code]: value }))}
          result={result}
          idPrefix="cfg-row"
        />
      )}
      <FormError>{error}</FormError>
      {result && (
        <>
          <div className={`${styles.status} ${result.valid ? styles.valid : styles.invalid}`}>
            {result.valid ? "Giltig" : "Ogiltig"}
          </div>
          {result.errors.map((m) => (
            <FormError key={m}>{m}</FormError>
          ))}
          {showPrice && (
            <dl className={styles.prices}>
              <dt>Grundpris</dt>
              <dd>{result.price.base === null ? "—" : formatMoney(result.price.base)}</dd>
              {result.price.additions.map((a) => (
                <Fragment key={`${a.groupCode}-${a.label}`}>
                  <dt>{a.label}</dt>
                  <dd>{formatSignedMoney(a.amount)}</dd>
                </Fragment>
              ))}
              <dt className={styles.total}>Pris</dt>
              <dd className={styles.total}>{result.price.unitPrice === null ? "—" : formatMoney(result.price.unitPrice)}</dd>
              {result.price.discountPercent > 0 && (
                <>
                  <dt>Rabatt</dt>
                  <dd>{Number(result.price.discountPercent)} %</dd>
                </>
              )}
            </dl>
          )}
          {result.warnings.map((w) => (
            <FormNotice key={w}>{w}</FormNotice>
          ))}
        </>
      )}
      <FormActions>
        <Button type="submit" variant="primary" disabled={!result?.valid || evaluating || halfTyped || pending}>
          {pending ? "Lägger in…" : "Lägg in"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
