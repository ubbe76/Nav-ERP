"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { ArticlePicker, type ArticlePickerValue } from "../ui/ArticlePicker";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  ARTICLE_COPY_PART_LABELS,
  ARTICLE_COPY_PART_REASONS,
  ARTICLE_COPY_PARTS,
  articleCopyPartAllowed,
  type ArticleCopyPart,
} from "../../lib/articleCopy";
import type { Article, ArticleGroup, ArticleType, RegisterEntry, StockLocation } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { CopyFromModal } from "./CopyFromModal";
import styles from "./NewArticleForm.module.css";

interface NewArticleFormProps {
  groups: ArticleGroup[];
  // When set, the created article is also added as a BOM component of this
  // article (a quantity field appears) — used from the Beredning view.
  attachToArticleId?: string;
  // Called after a successful create (+ attach). Without it the form
  // navigates to the new article's card, as on the /artiklar page.
  onSuccess?: (article: Article) => void;
}

export function NewArticleForm({ groups, attachToArticleId, onSuccess }: NewArticleFormProps) {
  const router = useRouter();
  const [articleNumber, setArticleNumber] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<ArticleType>("purchased");
  const [isPhantom, setIsPhantom] = useState(false);
  // Empty = the server's "st" default (created on first use).
  const [unitId, setUnitId] = useState("");
  const [units, setUnits] = useState<RegisterEntry[]>([]);
  const [standardCost, setStandardCost] = useState("");
  const [groupId, setGroupId] = useState("");
  const [defaultLocationId, setDefaultLocationId] = useState("");
  const [locations, setLocations] = useState<StockLocation[]>([]);

  useEffect(() => {
    apiFetch<StockLocation[]>("/api/v1/stock/locations").then(setLocations).catch(() => setLocations([]));
    apiFetch<RegisterEntry[]>("/api/v1/units").then(setUnits).catch(() => setUnits([]));
  }, []);
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // "Kopiera från": the confirmed source + parts, the source being chosen in
  // the dialog (a fresh pick or Ändra), and the parts a later Typ change
  // dropped (explained under the field).
  const [copySource, setCopySource] = useState<Article | null>(null);
  const [copyParts, setCopyParts] = useState<ArticleCopyPart[]>([]);
  const [droppedParts, setDroppedParts] = useState<ArticleCopyPart[]>([]);
  const [dialogSource, setDialogSource] = useState<Article | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function pickCopySource(picked: ArticlePickerValue | null) {
    setCopyError(null);
    // Typing in the picker drops the previous pick — and with it the copy.
    if (!picked) return clearCopy();
    // Closing a dialog hands focus back to what had it — the picker, which
    // would reopen its result list over the form. Let go of it first.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    try {
      // The picker's search rows don't carry every field the pre-fill reads.
      setDialogSource(await apiFetch<Article>(`/api/v1/articles/${picked.id}`));
    } catch (err) {
      setCopyError(apiErrorMessage(err, "Kunde inte hämta artikeln"));
    }
  }

  // Information pre-fills the form's own fields — but only when it is newly
  // chosen (a new source, or Information added via Ändra), so reopening the
  // dialog to change parts never overwrites what the user typed since.
  function confirmCopy(source: Article, chosenParts: ArticleCopyPart[]) {
    const informationIsNew =
      chosenParts.includes("information") && (copySource?.id !== source.id || !copyParts.includes("information"));
    // Safety net: only parts that apply to the type the article ends up with.
    const resultingType = informationIsNew ? source.type : type;
    const parts = chosenParts.filter((part) => articleCopyPartAllowed(part, resultingType));
    if (informationIsNew) {
      setType(source.type);
      setIsPhantom(source.isPhantom);
      setUnitId(source.unit === "st" ? "" : source.unitId);
      setStandardCost(source.standardCost === null ? "" : String(Number(source.standardCost)));
      setGroupId(source.groupId ?? "");
      // Only an active location is in the list; otherwise *** (standard).
      setDefaultLocationId(locations.some((l) => l.id === source.defaultLocationId) ? source.defaultLocationId! : "");
    }
    setCopySource(source);
    setCopyParts(parts);
    setDroppedParts([]);
    setDialogSource(null);
  }

  function clearCopy() {
    setCopySource(null);
    setCopyParts([]);
    setDroppedParts([]);
  }

  // A checked part that no longer applies to the new Typ is unchecked, and
  // the line under the field says why.
  // A part a type change dropped comes back when the type allows it again,
  // so the explanation never goes stale.
  function changeType(next: ArticleType) {
    setType(next);
    const all = ARTICLE_COPY_PARTS.filter((part) => copyParts.includes(part) || droppedParts.includes(part));
    setCopyParts(all.filter((part) => articleCopyPartAllowed(part, next)));
    setDroppedParts(all.filter((part) => !articleCopyPartAllowed(part, next)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    let article: Article;
    try {
      article = await apiFetch<Article>("/api/v1/articles", {
        method: "POST",
        body: JSON.stringify({
          articleNumber,
          name,
          type,
          isPhantom,
          unitId: unitId === "" ? undefined : unitId,
          standardCost: standardCost === "" ? undefined : Number(standardCost),
          groupId: groupId === "" ? undefined : groupId,
          defaultLocationId: defaultLocationId === "" ? undefined : defaultLocationId,
          copyFrom: copySource && copyParts.length > 0 ? { articleId: copySource.id, parts: copyParts } : undefined,
        }),
      });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa artikeln"));
      setPending(false);
      return;
    }

    if (attachToArticleId) {
      try {
        await apiFetch(`/api/v1/articles/${attachToArticleId}/bom`, {
          method: "POST",
          body: JSON.stringify({ componentArticleId: article.id, quantity: Number(quantity) }),
        });
      } catch (err) {
        setError(
          `Artikeln skapades men kunde inte kopplas in i strukturen: ${err instanceof Error ? err.message : "okänt fel"}`
        );
        setPending(false);
        return;
      }
    }

    if (onSuccess) {
      onSuccess(article);
    } else {
      router.push(`/artiklar/${article.id}`);
    }
  }

  // The "st" unit's id — the Grundenhet select's empty value stands for it.
  const stUnitId = units.find((u) => u.code === "st")?.id ?? "";
  const baseUnitHint = copyBaseUnitHint();

  // A different base unit than the source's: the unit-relative parts are
  // either skipped (alternative units) or copied as they stand.
  function copyBaseUnitHint(): string | null {
    if (!copySource || units.length === 0 || copySource.unitId === (unitId || stUnitId)) return null;
    const asIs: string[] = [];
    if (copyParts.includes("inkop")) asIs.push("leverantörspriserna");
    if (copyParts.includes("beredning")) asIs.push("strukturens antal och operationstiderna");
    const skip = copyParts.includes("information");
    if (!skip && asIs.length === 0) return null;
    const parts = [`Grundenheten är inte densamma som på ${copySource.articleNumber} (${copySource.unit}).`];
    if (skip) parts.push("Alternativa enheter och inköps-/försäljningsenhet kopieras inte.");
    if (asIs.length > 0) {
      parts.push(`${asIs.join(" och ").replace(/^./, (c) => c.toUpperCase())} gäller per grundenhet och kopieras som de är.`);
    }
    return parts.join(" ");
  }

  return (
    <>
      <Form onSubmit={handleSubmit}>
        <FormError>{error}</FormError>

        <FormRow>
          <Field label="Artikelnummer" htmlFor="articleNumber">
            <Input id="articleNumber" size="md" required value={articleNumber} onChange={(e) => setArticleNumber(e.target.value)} />
          </Field>
          <Field label="Typ" htmlFor="type">
            <Select id="type" value={type} onChange={(e) => changeType(e.target.value as ArticleType)}>
              <option value="purchased">Köpt</option>
              <option value="manufactured">Tillverkad</option>
              <option value="service">Tjänst</option>
            </Select>
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Benämning" htmlFor="name">
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Kopiera från" htmlFor="copyFrom">
            <ArticlePicker
              id="copyFrom"
              value={dialogSource ?? copySource}
              onChange={pickCopySource}
              placeholder="Välj artikel att kopiera från…"
            />
          </Field>
        </FormRow>
        {copyError && <FormError>{copyError}</FormError>}
        {copySource && (
          <div className={styles.copyLine}>
            <span className={styles.copyText}>
              {copyParts.length > 0
                ? `Kopierar: ${copyParts.map((part) => ARTICLE_COPY_PART_LABELS[part]).join(", ")}`
                : "Kopierar inget"}
            </span>
            <Button type="button" variant="ghost" size="small" onClick={() => setDialogSource(copySource)}>
              Ändra
            </Button>
            <Button type="button" variant="ghost" size="small" onClick={clearCopy}>
              Ta bort
            </Button>
          </div>
        )}
        {copySource && droppedParts.length > 0 && (
          <FormHint attached>{droppedParts.map((part) => ARTICLE_COPY_PART_REASONS[part]).join(". ")}.</FormHint>
        )}
        {baseUnitHint && <FormHint attached>{baseUnitHint}</FormHint>}

        <FormRow>
          <Field label="Grundenhet" htmlFor="unit">
            <Select id="unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">st (standard)</option>
              {units
                .filter((u) => u.code !== "st")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code} · {u.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Standardkostnad (valfritt)" htmlFor="standardCost">
            <Input
              id="standardCost"
              type="number"
              size="sm"
              min="0"
              // A 4-decimal cost, pre-filled exactly from a copy source.
              step="any"
              value={standardCost}
              onChange={(e) => setStandardCost(e.target.value)}
            />
          </Field>
        </FormRow>

        <FormRow>
          <Field label="Artikelgrupp (valfritt)" htmlFor="groupId">
            <Select id="groupId" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Ingen grupp</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code} · {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lagerplats" htmlFor="newArticleLocation">
            {/* Empty = the auto-created "***" fallback location. */}
            <Select id="newArticleLocation" value={defaultLocationId} onChange={(e) => setDefaultLocationId(e.target.value)}>
              <option value="">*** (standard)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.warehouseName} — {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Fantomartikel" htmlFor="isPhantom">
            <Toggle id="isPhantom" checked={isPhantom} onChange={(e) => setIsPhantom(e.target.checked)} />
          </Field>
        </FormRow>
        <FormHint attached>
          Fantomartiklar lagerhålls aldrig — de löses upp till sina egna komponenter vid tillverkning och kalkyl.
          Relevant för underrede/modulstrukturer, typiskt på tillverkade artiklar.
        </FormHint>

        {attachToArticleId && (
          <Field label="Antal i strukturen" htmlFor="quantity">
            <Input
              id="quantity"
              type="number"
              size="sm"
              min="0"
              step="any"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        )}

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Skapar…" : attachToArticleId ? "Skapa och koppla" : "Skapa artikel"}
          </Button>
        </FormActions>
      </Form>

      {/* Outside the <form>: the dialog's own buttons must never submit it. */}
      <CopyFromModal
        source={dialogSource}
        initialParts={dialogSource && dialogSource.id === copySource?.id ? copyParts : null}
        formType={type}
        onCancel={() => setDialogSource(null)}
        onConfirm={confirmCopy}
      />
    </>
  );
}
