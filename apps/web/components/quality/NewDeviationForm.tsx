"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import {
  DEVIATION_TYPES,
  DEVIATION_TYPE_LABELS,
  deviationHref,
  reasonAppliesToType,
  type Deviation,
  type DeviationReason,
  type DeviationType,
  type ResponsibleCandidate,
} from "../../lib/quality";
import { DeviationFields } from "./DeviationFields";
import { draftPayload, draftProblem, type DeviationDraft } from "./deviationDraft";

// Ny avvikelse: pick the type first, then the same fields the card edits.
export function NewDeviationForm({
  initial,
  typeChosen,
  reasons,
  responsible,
}: {
  initial: DeviationDraft;
  // False when the link carried no type — the form then asks for it first.
  typeChosen: boolean;
  reasons: DeviationReason[];
  responsible: ResponsibleCandidate[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<DeviationDraft>(initial);
  const [chosen, setChosen] = useState(typeChosen);
  const [initialJson] = useState(() => JSON.stringify(initial));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState(false);

  // Prefilled context is not an unsaved edit; typing is.
  useUnsavedGuard(!created && JSON.stringify(draft) !== initialJson);

  function patch(next: Partial<DeviationDraft>) {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  function chooseType(type: DeviationType) {
    setChosen(true);
    setDraft((prev) => {
      // A reason chosen for another type is dropped rather than refused later.
      const reason = reasons.find((r) => r.id === prev.reasonId);
      return { ...prev, type, reasonId: reason && reasonAppliesToType(reason, type) ? prev.reasonId : "" };
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = draftProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setPending(true);
    try {
      const card = await apiFetch<Deviation>("/api/v1/deviations", {
        method: "POST",
        body: JSON.stringify(draftPayload(draft, "create")),
      });
      setCreated(true);
      router.push(deviationHref(card.id));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa avvikelsen"));
      setPending(false);
    }
  }

  return (
    <Card maxWidth="none">
      <Form onSubmit={submit}>
        <FormError>{error}</FormError>

        <Field label="Typ" htmlFor="devType">
          <Select
            id="devType"
            size="md"
            value={chosen ? draft.type : ""}
            onChange={(e) => {
              if (e.target.value) chooseType(e.target.value as DeviationType);
            }}
          >
            {!chosen && <option value="">— Välj typ —</option>}
            {DEVIATION_TYPES.map((type) => (
              <option key={type} value={type}>
                {DEVIATION_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
          <FormHint>
            Kundreklamation: kunden reklamerar något vi levererat. Leverantörsavvikelse: något vi fått från en leverantör
            är fel. Intern avvikelse: ett fel vi hittar själva i produktionen.
          </FormHint>
        </Field>

        {chosen && <DeviationFields draft={draft} onChange={patch} reasons={reasons} responsible={responsible} mode="create" />}

        <FormActions>
          <Link href="/kvalitet/avvikelser" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Avbryt
          </Link>
          <Button type="submit" variant="primary" disabled={pending || !chosen}>
            {pending ? "Skapar…" : "Skapa avvikelse"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}
