"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { chainLines } from "../../lib/costChain";
import type { CostCalculation, CostCalculationDraft } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { Card } from "../ui/Card";
import { CostChain } from "../ui/CostChain";
import { CostCalculationList } from "../costing/CostCalculationList";
import { SectionHeading } from "../ui/SectionHeading";
import { computeLineMargin } from "../../lib/margin";
import styles from "./KalkylTab.module.css";
import { formatStockholmDate } from "../../lib/date";

// The markups Pröva påslag sends; absent key = the ones that apply.
type TryMarkups = { generalMarkupPercent?: number; materialMarkupPercent?: number };

function isTrial(m: TryMarkups) {
  return m.generalMarkupPercent !== undefined || m.materialMarkupPercent !== undefined;
}

function markupsBody(m: TryMarkups) {
  return isTrial(m) ? { markups: m } : {};
}

const checkboxRowStyle = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  fontFamily: "var(--font-body)",
  fontSize: 13,
} as const;

export function KalkylTab({
  articleId,
  calculations,
  salesPrice,
}: {
  articleId: string;
  calculations: CostCalculation[];
  // The article's own base price (bottom of the price chain), for the margin
  // card. Null = no base price set.
  salesPrice: string | null;
}) {
  const router = useRouter();
  const [quantity, setQuantity] = useState("1");
  const [multiLevel, setMultiLevel] = useState(false);
  // Pröva påslag (#16): the two price markups to try instead of the ones that
  // apply to the article (its varugrupp's, else the company's). Prefilled with
  // the applying values; only a field the user has changed is sent, so an
  // untouched panel calculates exactly like before and never makes a "prövat"
  // calculation. Nothing in System → Kalkyler is written either way.
  const [generalTry, setGeneralTry] = useState("");
  const [materialTry, setMaterialTry] = useState("");
  const [applying, setApplying] = useState<{ general: string; material: string } | null>(null);
  // "Manual wins": the late baseline response never overwrites typed values.
  // The refs mirror the touched flags for when the response lands.
  const generalTouchedNow = useRef(false);
  const materialTouchedNow = useRef(false);
  // The computed but unsaved calculation. Nothing is written until the user
  // asks for it with Spara kalkyl. Tagged with the INPUTS it was computed for
  // — quantity and the multi-level flag — so a response that lands after a
  // field has since been edited (the inputs aren't disabled while the request
  // is pending) can't be shown or saved against inputs it doesn't belong to.
  // Both are part of the tag: a single-level preview saved as a multi-level
  // calculation would store numbers nobody ever saw.
  const [preview, setPreview] = useState<{
    calculation: CostCalculationDraft;
    warnings: string[];
    quantity: string;
    multiLevel: boolean;
    markups: TryMarkups;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  // Opens the specification for the calculation that was just saved.
  const [openId, setOpenId] = useState<string | null>(null);

  // The markups that apply to this article today: a read-only preview, which
  // saves nothing. Its result fills the two fields unless the user got there
  // first.
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ calculation: CostCalculationDraft }>(
      `/api/v1/articles/${articleId}/cost-calculations/pre-calculate`,
      { method: "POST", body: JSON.stringify({ quantity: 1 }) }
    )
      .then(({ calculation }) => {
        if (cancelled) return;
        const general = String(Number(calculation.generalMarkupPercent));
        const material = String(Number(calculation.materialMarkupPercent));
        setApplying({ general, material });
        if (!generalTouchedNow.current) setGeneralTry(general);
        if (!materialTouchedNow.current) setMaterialTry(material);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  // The markups to send: a field that differs from what applies. While the
  // applying values are unknown (their fetch has not landed, or failed) there
  // is nothing to compare with — a field the user has typed in is then sent
  // as it stands, never silently dropped: the calculation would otherwise run
  // on the applying markups while the form shows the tried ones. Sending a
  // value that happens to equal the applying one only marks the calculation
  // as tried; the figures are the same.
  function tryMarkups(): TryMarkups {
    const out: TryMarkups = {};
    const differs = (value: string, applies: string | undefined, touched: boolean) =>
      value.trim() !== "" && (applies === undefined ? touched : Number(value) !== Number(applies));
    if (differs(generalTry, applying?.general, generalTouchedNow.current)) out.generalMarkupPercent = Number(generalTry);
    if (differs(materialTry, applying?.material, materialTouchedNow.current)) out.materialMarkupPercent = Number(materialTry);
    return out;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    // Captured now, not read again after the await: the field may change
    // while this request is in flight (the button is disabled, but not the
    // input), and the response must stay tied to the quantity it was for.
    const requestedQuantity = quantity;
    const requestedMultiLevel = multiLevel;
    const requestedMarkups = tryMarkups();
    try {
      const result = await apiFetch<{ calculation: CostCalculationDraft; warnings: string[] }>(
        `/api/v1/articles/${articleId}/cost-calculations/pre-calculate`,
        { method: "POST", body: JSON.stringify({ quantity: Number(requestedQuantity), multiLevel: requestedMultiLevel, ...markupsBody(requestedMarkups) }) }
      );
      setPreview({ ...result, quantity: requestedQuantity, multiLevel: requestedMultiLevel, markups: requestedMarkups });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte beräkna kalkylen");
    } finally {
      setPending(false);
    }
  }

  // Recomputed server-side rather than posting the previewed figures back —
  // the API never trusts numbers from the browser. The inputs come from the
  // preview, not the live fields, so a save can never disagree with what's
  // actually on screen (the render guard below hides this action entirely once
  // a field no longer matches the preview, but this keeps them in lockstep
  // even so). The flag must travel with the quantity: recomputing without it
  // would save a single-level calculation under a multi-level preview.
  async function save() {
    if (!preview) return;
    setError(null);
    setSaving(true);
    try {
      const result = await apiFetch<{ calculation: CostCalculation; warnings: string[] }>(
        `/api/v1/articles/${articleId}/cost-calculations/pre-calculate`,
        {
          method: "POST",
          body: JSON.stringify({ quantity: Number(preview.quantity), multiLevel: preview.multiLevel, save: true, ...markupsBody(preview.markups) }),
        }
      );
      setPreview(null);
      setOpenId(result.calculation.id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara kalkylen");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <CostCalculationList
        calculations={calculations}
        openId={openId}
        onCloseSpecification={() => setOpenId(null)}
        onDeleted={() => router.refresh()}
        onArticleChanged={() => router.refresh()}
      />

      <MarginCard calculations={calculations} salesPrice={salesPrice} />

      <div className={styles.panels}>
        <Card maxWidth={360}>
          <Form onSubmit={handleSubmit}>
            <FormError>{error}</FormError>

            <Field label="Antal att förkalkylera" htmlFor="quantity">
              <Input
                id="quantity"
                type="number"
                size="sm"
                min="0"
                step="any"
                required
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  // The panel's figures belong to the previous quantity.
                  setPreview(null);
                }}
              />
            </Field>

            {/* Checkbox (ui/Field.tsx) has no `label` prop — the visible text
                is a sibling inside a wrapping <label>, same pattern as
                OperationModal.tsx. */}
            <label style={checkboxRowStyle}>
              <Checkbox
                id="multiLevel"
                checked={multiLevel}
                onChange={(e) => {
                  setMultiLevel(e.target.checked);
                  // The panel's figures were computed the other way.
                  setPreview(null);
                }}
              />
              Räkna om underliggande nivåer
            </label>
            <FormHint attached>
              Tillverkade halvfabrikat i strukturen kostas ur sina egna strukturer och rutter i stället för sitt
              standardpris. Ett halvfabrikat utan struktur och rutt får sitt standardpris, med en varning.
            </FormHint>

            <SectionHeading>Pröva påslag</SectionHeading>
            <FormRow>
              <Field label="Generellt påslag (%)" htmlFor="tryGeneralMarkup">
                <Input
                  id="tryGeneralMarkup"
                  type="number"
                  min="0"
                  max="1000"
                  step="any"
                  size="xs"
                  value={generalTry}
                  onChange={(e) => {
                    generalTouchedNow.current = true;
                    setGeneralTry(e.target.value);
                    setPreview(null);
                  }}
                />
              </Field>
              <Field label="Materialpåslag (%)" htmlFor="tryMaterialMarkup">
                <Input
                  id="tryMaterialMarkup"
                  type="number"
                  min="0"
                  max="1000"
                  step="any"
                  size="xs"
                  value={materialTry}
                  onChange={(e) => {
                    materialTouchedNow.current = true;
                    setMaterialTry(e.target.value);
                    setPreview(null);
                  }}
                />
              </Field>
            </FormRow>
            <FormHint attached>
              Förifyllt med påslagen som gäller för artikeln: varugruppens, annars företagets. Ändra ett värde för att
              räkna förkalkylen med det i stället. Inget i System → Kalkyler ändras, och MO-, LO-, Affo- och TO-påslagen
              är alltid de vanliga.
            </FormHint>

            <FormActions>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Beräknar…" : "Förkalkylera"}
              </Button>
            </FormActions>
          </Form>
        </Card>

        {/* Only render while the preview's inputs still match the form —
            otherwise a superseded response would show figures for a quantity
            or a level setting the user has already moved past. */}
        {preview && preview.quantity === quantity && preview.multiLevel === multiLevel && (
          <Card maxWidth={360}>
            <FormStack>
              <FormHint>
                {isTrial(preview.markups)
                  ? "Prövningen sparas först när du klickar Spara som prövad kalkyl. Företagets inställningar ändras inte."
                  : "Beräkningen sparas först när du klickar Spara kalkyl."}
              </FormHint>
              {preview.warnings.map((w, i) => (
                <FormError key={i}>{w}</FormError>
              ))}
              {/* The quantity belongs to the calculation, not the (possibly
                  since-edited) input field — see the render guard above. */}
              <CostChain lines={chainLines(preview.calculation, Number(preview.calculation.quantity))} />
              <FormActions>
                <Button type="button" variant="primary" disabled={saving} onClick={save}>
                  {saving ? "Sparar…" : isTrial(preview.markups) ? "Spara som prövad kalkyl" : "Spara kalkyl"}
                </Button>
              </FormActions>
            </FormStack>
          </Card>
        )}
      </div>
    </div>
  );
}

// Täckningsbidrag on the article itself: the base sales price against the
// latest saved PRE-calculation's self cost per unit. Post-calculations are
// deliberately ignored — they describe one manufacturing order's outcome, not
// what the article costs to sell today. Nothing is fetched; the calculations
// are already on the page.
function MarginCard({ calculations, salesPrice }: { calculations: CostCalculation[]; salesPrice: string | null }) {
  // The list arrives newest first (the API orders by calculatedAt desc).
  const latestPre = calculations.find((c) => c.type === "pre" && Number(c.quantity) > 0);
  const selfCostPerUnit = latestPre
    ? chainLines(latestPre).find((l) => l.label === "Självkostnad (SVK)")!.amount / Number(latestPre.quantity)
    : null;
  const price = salesPrice === null ? null : Number(salesPrice);

  const margin =
    price === null
      ? null
      : computeLineMargin({ quantity: 1, unitPrice: price, discountPercent: 0, selfCostPerUnit });

  return (
    <Card maxWidth={520}>
      <SectionHeading>Marginal</SectionHeading>
      {price === null || selfCostPerUnit === null ? (
        <FormHint>
          {price === null && selfCostPerUnit === null
            ? "Sätt ett försäljningspris på artikeln och spara en förkalkyl för att se täckningsbidraget."
            : price === null
              ? "Artikeln saknar försäljningspris — sätt ett på fliken Allmänt, eller med Sätt försäljningspris i en sparad kalkyl."
              : "Ingen sparad förkalkyl att mäta mot. Spara en kalkyl ovan."}
        </FormHint>
      ) : (
        <>
          <CostChain
            lines={[
              { label: "Försäljningspris (artikeln)", amount: price },
              { label: "Självkostnad (SVK) per st", amount: selfCostPerUnit },
              { label: "Täckningsbidrag (TB)", amount: margin!.contribution!, kind: "result" },
            ]}
          />
          <FormHint>
            Täckningsgrad{" "}
            {margin!.marginPercent === null
              ? "—"
              : `${margin!.marginPercent.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`}
            . Mot förkalkylen från {formatStockholmDate(latestPre!.calculatedAt)} på{" "}
            {Number(latestPre!.quantity).toLocaleString("sv-SE")} st.
          </FormHint>
        </>
      )}
    </Card>
  );
}
