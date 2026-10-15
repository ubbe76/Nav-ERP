"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, formatSignedMoney, round2 } from "../../lib/format";
import { formatQuantity } from "../../lib/stampSessions";
import type { Customer } from "../../lib/types";
import type {
  ConfiguratorDerivation,
  ConfiguratorMode,
  ConfiguratorEvaluation,
  ConfiguratorGroupDetail,
  ConfiguratorSelection,
} from "../../lib/configurator";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { FormError, FormNotice } from "../ui/Form";
import { SearchPicker } from "../ui/SearchPicker";
import { SectionHeading } from "../ui/SectionHeading";
import { useCan } from "../PermissionsProvider";
import { CreateVariantModal } from "./CreateVariantModal";
import { ConfigurationGroupFields } from "./ConfigurationGroupFields";
import { parseDecimal } from "./parseDecimal";
import { selectionFromRaw, type RawConfiguration } from "./selectionFromRaw";
import styles from "./TestConfigurationPanel.module.css";

export { parseDecimal };

export function TestConfigurationPanel({
  articleId,
  groups,
  mode,
  defaultQuantity,
}: {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  mode: ConfiguratorMode;
  /** The template's Ordervolym, the default for Kalkylantal in Skapa variant. */
  defaultQuantity: number;
}) {
  const canEdit = useCan()(["artiklar"]);
  const [variantOpen, setVariantOpen] = useState(false);
  const [variantKey, setVariantKey] = useState(0);
  const [variantSelection, setVariantSelection] = useState<ConfiguratorSelection>({});
  // Raw form state per group code.
  const [raw, setRaw] = useState<RawConfiguration>({});
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [result, setResult] = useState<ConfiguratorEvaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const [quantityRaw, setQuantityRaw] = useState("1");
  const [derivation, setDerivation] = useState<ConfiguratorDerivation | null>(null);
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  // True once the input changed after the derivation was fetched.
  const [stale, setStale] = useState(false);
  const deriveSeq = useRef(0);
  // Visa struktur och kalkyl must not run on a selection the form no longer
  // shows: `pendingInput` while a measure field is half-typed ("12,"), and
  // `pendingEvaluation` from an input change until its evaluation is written.
  const [pendingInput, setPendingInput] = useState(false);
  const [pendingEvaluation, setPendingEvaluation] = useState(false);
  // The selection the last evaluation was made for (what derive must use).
  const lastSelection = useRef<ConfiguratorSelection>({});
  const quantity = parseDecimal(quantityRaw);

  // `mine` is taken when the input changes, so an answer for older input is
  // never written once a newer change has happened (even before its request).
  async function evaluate(mine: number, selection: ConfiguratorSelection, customerId: string | null) {
    try {
      const res = await apiFetch<ConfiguratorEvaluation>(`/api/v1/configurator/${articleId}/evaluate`, {
        method: "POST",
        body: JSON.stringify({ selection, ...(customerId ? { customerId } : {}) }),
      });
      if (mine === seq.current) {
        setResult(res);
        setError(null);
        setPendingInput(false);
        setPendingEvaluation(false);
      }
    } catch (err) {
      if (mine === seq.current) {
        // A failed evaluation must not leave the previous Giltig/Ogiltig looking current.
        setResult(null);
        setError(apiErrorMessage(err, "Kunde inte utvärdera konfigurationen"));
        setPendingInput(false);
        setPendingEvaluation(false);
      }
    }
  }

  // Re-evaluates (debounced) on every change, including the template itself
  // changing while the panel is open.
  useEffect(() => {
    const mine = ++seq.current;
    // Any input change makes a shown derivation (and one in flight) outdated.
    deriveSeq.current++;
    setDeriving(false);
    setStale(true);
    setDeriveError(null);
    setPendingEvaluation(true);
    const { selection, pending } = selectionFromRaw(groups, raw);
    // Half-typed ("12,"): evaluating without it would fall back to the
    // default — keep the previous result instead.
    if (pending) {
      setPendingInput(true);
      return;
    }
    lastSelection.current = selection;
    const timer = setTimeout(() => void evaluate(mine, selection, customer?.id ?? null), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, customer, groups, articleId]);

  async function showDerivation() {
    if (quantity === null || quantity <= 0) return;
    const mine = ++deriveSeq.current;
    setDeriving(true);
    setDeriveError(null);
    try {
      const res = await apiFetch<ConfiguratorDerivation>(`/api/v1/configurator/${articleId}/derive`, {
        method: "POST",
        body: JSON.stringify({
          selection: lastSelection.current,
          quantity,
          ...(customer ? { customerId: customer.id } : {}),
        }),
      });
      if (mine === deriveSeq.current) {
        setDerivation(res);
        setStale(false);
        setDeriving(false);
      }
    } catch (err) {
      if (mine === deriveSeq.current) {
        setDerivation(null);
        setDeriveError(apiErrorMessage(err, "Kunde inte härleda struktur och kalkyl"));
        setDeriving(false);
      }
    }
  }

  return (
    <div>
      <SectionHeading spaced>Testa konfiguration</SectionHeading>
      <div className={styles.stack}>
        <Field label="Kund (valfritt)" htmlFor="cfg-test-customer">
          <SearchPicker
            id="cfg-test-customer"
            endpoint="/api/v1/customers"
            value={customer}
            onChange={setCustomer}
            formatLabel={(c) => `${c.customerNumber} — ${c.name}`}
            placeholder="Sök kundnummer eller namn…"
            emptyText="Inga kunder matchar sökningen"
          />
        </Field>
        {groups.length === 0 && <p className={styles.empty}>Lägg till valgrupper för att kunna testa.</p>}
        <ConfigurationGroupFields
          groups={groups}
          raw={raw}
          onChange={(code, value) => setRaw((r) => ({ ...r, [code]: value }))}
          result={result}
          idPrefix="cfg-test"
        />

        <FormError>{error}</FormError>
        {result && (
          <>
            <div className={`${styles.status} ${result.valid ? styles.valid : styles.invalid}`}>
              {result.valid ? "Giltig" : "Ogiltig"}
            </div>
            {result.errors.length > 0 && (
              <ul className={styles.fieldErrors}>
                {result.errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            <dl className={styles.prices}>
              <dt>Grundpris</dt>
              <dd>{result.price.base === null ? "—" : formatMoney(result.price.base)}</dd>
              {result.price.additions.map((a) => (
                <PriceLine key={`${a.groupCode}-${a.label}`} label={a.label} amount={a.amount} />
              ))}
              <dt className={styles.total}>Totalt</dt>
              <dd className={styles.total}>{result.price.unitPrice === null ? "—" : formatMoney(result.price.unitPrice)}</dd>
              {result.price.discountPercent > 0 && (
                <DiscountLines unitPrice={result.price.unitPrice} discountPercent={result.price.discountPercent} />
              )}
            </dl>
            {result.warnings.map((w) => (
              <FormNotice key={w}>{w}</FormNotice>
            ))}
            {result.valid && result.key && <div className={styles.key}>Nyckel: {result.key}</div>}
          </>
        )}

        <Field label="Antal" htmlFor="cfg-test-quantity">
          <Input
            id="cfg-test-quantity"
            type="number"
            min="0"
            step="any"
            value={quantityRaw}
            onChange={(e) => {
              setQuantityRaw(e.target.value);
              deriveSeq.current++;
              setDeriving(false);
              setStale(true);
              setDeriveError(null);
            }}
          />
        </Field>
        <div className={styles.buttons}>
          <Button
            type="button"
            variant="secondary"
            disabled={!result?.valid || pendingInput || pendingEvaluation || quantity === null || quantity <= 0 || deriving}
            onClick={() => void showDerivation()}
          >
            Visa struktur och kalkyl
          </Button>
          {mode === "variants" && canEdit && (
            <Button
              type="button"
              variant="secondary"
              disabled={!result?.valid || pendingInput || pendingEvaluation}
              onClick={() => {
                setVariantSelection({ ...lastSelection.current });
                setVariantKey((k) => k + 1);
                setVariantOpen(true);
              }}
            >
              Skapa variant
            </Button>
          )}
        </div>
        <FormError>{deriveError}</FormError>
        {derivation && stale && (
          <FormNotice>Struktur och kalkyl gäller ett tidigare val — klicka Visa struktur och kalkyl igen</FormNotice>
        )}
        {derivation && <DerivationView derivation={derivation} stale={stale} />}
        <CreateVariantModal
          open={variantOpen}
          openKey={variantKey}
          articleId={articleId}
          selection={variantSelection}
          defaultQuantity={defaultQuantity}
          onClose={() => setVariantOpen(false)}
        />
      </div>
    </div>
  );
}

function PriceLine({ label, amount }: { label: string; amount: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{formatSignedMoney(amount)}</dd>
    </>
  );
}

// Totalt is before the discount; Att betala = Totalt × (1 − d/100), 2 decimals.
function DiscountLines({ unitPrice, discountPercent }: { unitPrice: number | null; discountPercent: number }) {
  const toPay = unitPrice === null ? null : round2(unitPrice * (1 - discountPercent / 100));
  return (
    <>
      <dt>Rabatt {Number(discountPercent)} %</dt>
      <dd>{unitPrice === null || toPay === null ? "—" : formatSignedMoney(toPay - unitPrice)}</dd>
      <dt className={styles.total}>Att betala</dt>
      <dd className={styles.total}>{toPay === null ? "—" : formatMoney(toPay)}</dd>
    </>
  );
}

function DerivationView({ derivation, stale }: { derivation: ConfiguratorDerivation; stale: boolean }) {
  const { structure, costing } = derivation;
  if (!structure.derivable) {
    return (
      <div className={stale ? styles.stale : undefined}>
        <div className={`${styles.status} ${styles.invalid}`}>Konfigurationen är inte giltig</div>
        <Messages structure={structure} />
      </div>
    );
  }
  return (
    <div className={`${styles.stack} ${stale ? styles.stale : ""}`}>
      <Messages structure={structure} />
      <h4 className={styles.subheading}>Material</h4>
      {structure.materials.length === 0 ? (
        <p className={styles.empty}>Inget material.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Artikelnr</th>
                <th>Benämning</th>
                <th className={styles.num}>Antal</th>
                <th>Operation</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {structure.materials.map((m, i) => (
                <tr key={`${m.lineId ?? "base"}-${m.componentArticleId}-${i}`}>
                  <td>{m.articleNumber}</td>
                  <td>{m.articleName}</td>
                  <td className={styles.num}>
                    {formatQuantity(m.quantity)}
                    {m.unitCode ? ` ${m.unitCode}` : ""}
                  </td>
                  <td>{m.operation ? m.operation.sequenceNo : "—"}</td>
                  <td>{m.source === "line" && <span className={styles.badge}>Villkorad</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4 className={styles.subheading}>Operationer</h4>
      {structure.operations.length === 0 ? (
        <p className={styles.empty}>Inga operationer.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Nr</th>
                <th>Resurs</th>
                <th>Beskrivning</th>
                <th className={styles.num}>Ställtid (min)</th>
                <th className={styles.num}>Stycktid (min/st)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {structure.operations.map((o) => (
                <tr key={`${o.kind}-${o.id}`}>
                  <td>{o.sequenceNo}</td>
                  <td>
                    {o.workCenterCode} {o.workCenterName}
                  </td>
                  <td>{o.description ?? "—"}</td>
                  <td className={styles.num}>
                    {formatQuantity(o.setupTime)}
                    {o.setupPrice !== null && <div className={styles.key}>Ställpris {formatMoney(o.setupPrice)}</div>}
                  </td>
                  <td className={styles.num}>
                    {formatQuantity(o.runTimePerUnit)}
                    {o.unitPrice !== null && <div className={styles.key}>Styckpris {formatMoney(o.unitPrice)}</div>}
                  </td>
                  <td>{o.costingOnly && <span className={styles.badge}>Bara kalkyl</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {costing && (
        <>
          <h4 className={styles.subheading}>Förkalkyl för {formatQuantity(costing.quantity)} st</h4>
          <dl className={styles.prices}>
            <dt>Material</dt>
            <dd>{formatMoney(costing.materialCost)}</dd>
            <dt>Operationer</dt>
            <dd>{formatMoney(costing.operationCost)}</dd>
            <dt>Påslag</dt>
            <dd>{formatMoney(costing.markups)}</dd>
            <dt className={styles.total}>Tillverkningskostnad</dt>
            <dd className={styles.total}>{formatMoney(costing.manufacturingCost)}</dd>
            <dt>Tillverkningskostnad per st</dt>
            <dd>{formatMoney(costing.manufacturingCostPerUnit)}</dd>
          </dl>
          {costing.warnings.map((w) => (
            <FormNotice key={w}>{w}</FormNotice>
          ))}
        </>
      )}
    </div>
  );
}

function Messages({ structure }: { structure: ConfiguratorDerivation["structure"] }) {
  return (
    <>
      {structure.errors.map((m) => (
        <FormError key={m}>{m}</FormError>
      ))}
      {structure.warnings.map((m) => (
        <FormNotice key={m}>{m}</FormNotice>
      ))}
    </>
  );
}
