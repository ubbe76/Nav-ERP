"use client";

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { FormActions, FormHint, FormStack } from "../ui/Form";
import {
  ARTICLE_COPY_PART_LABELS,
  ARTICLE_COPY_PART_REASONS,
  ARTICLE_COPY_PARTS,
  articleCopyPartAllowed,
  type ArticleCopyPart,
} from "../../lib/articleCopy";
import type { Article, ArticleType } from "../../lib/types";
import styles from "./NewArticleForm.module.css";

const PART_DESCRIPTIONS: Record<ArticleCopyPart, string> = {
  information:
    "Typ, grundenhet, standardkostnad, varugrupp, artikelkod, lagerplats och fantomartikel förifylls i formuläret. Övriga uppgifter på Allmänt, planeringen och de alternativa enheterna kopieras när artikeln skapas.",
  beredning: "Strukturens komponenter och operationerna, med materialets koppling till operationerna.",
  inkop: "Leverantörerna med huvudleverantör och stafflade priser.",
  filer: "Ritningsnummer och bifogade filer.",
};

interface CopyFromModalProps {
  // Open while set.
  source: Article | null;
  // The parts already chosen for this source (Ändra); null = a fresh pick,
  // every part checked.
  initialParts: ArticleCopyPart[] | null;
  // The form's current Typ — the type the new article gets unless
  // Information is checked, in which case it takes the source's type.
  formType: ArticleType;
  onCancel: () => void;
  onConfirm: (source: Article, parts: ArticleCopyPart[]) => void;
}

export function CopyFromModal({ source, initialParts, formType, onCancel, onConfirm }: CopyFromModalProps) {
  return (
    <Modal
      open={source !== null}
      onClose={onCancel}
      title={source ? `Kopiera från ${source.articleNumber} – ${source.name}` : "Kopiera från"}
    >
      {source && (
        <CopyFromChoices
          source={source}
          initialParts={initialParts}
          formType={formType}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  );
}

// Mounted per opening (Modal unmounts its children while closed), so the
// checkboxes start from initialParts every time.
function CopyFromChoices({ source, initialParts, formType, onCancel, onConfirm }: CopyFromModalProps & { source: Article }) {
  const [checked, setChecked] = useState<Set<ArticleCopyPart>>(() => new Set(initialParts ?? ARTICLE_COPY_PARTS));
  // Newly applied Information pre-fills Typ from the source, so the type
  // rules are judged against the type the new article will actually get.
  // Information already applied earlier (Ändra) pre-fills nothing — the
  // form's Typ, possibly changed since, stands.
  const informationIsNew = checked.has("information") && !initialParts?.includes("information");
  const effectiveType = informationIsNew ? source.type : formType;
  const chosen = ARTICLE_COPY_PARTS.filter((part) => checked.has(part) && articleCopyPartAllowed(part, effectiveType));

  function toggle(part: ArticleCopyPart, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(part);
    else next.delete(part);
    setChecked(next);
  }

  return (
    <FormStack>
      {ARTICLE_COPY_PARTS.map((part) => {
        const allowed = articleCopyPartAllowed(part, effectiveType);
        return (
          <div key={part} className={styles.copyChoice}>
            <label className={allowed ? styles.copyChoiceLabel : `${styles.copyChoiceLabel} ${styles.copyChoiceDisabled}`}>
              <Checkbox
                id={`copyPart-${part}`}
                checked={allowed && checked.has(part)}
                disabled={!allowed}
                onChange={(e) => toggle(part, e.target.checked)}
              />
              {ARTICLE_COPY_PART_LABELS[part]}
            </label>
            <FormHint className={styles.copyChoiceHint}>
              {allowed ? PART_DESCRIPTIONS[part] : ARTICLE_COPY_PART_REASONS[part]}
            </FormHint>
          </div>
        );
      })}
      <FormHint>
        Lagersaldo, historik, revisioner, kundpriser, prislistor och konfigurator kopieras aldrig. Artikelnummer och
        benämning tas alltid från formuläret.
      </FormHint>
      <FormActions>
        <Button type="button" variant="primary" disabled={chosen.length === 0} onClick={() => onConfirm(source, chosen)}>
          Kopiera
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </FormStack>
  );
}
