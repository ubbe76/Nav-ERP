// apps/api/src/modules/configurator/service/variant-identity.ts
import type { ConfiguratorArticleField, ConfiguratorSelection, VariantSelectionEntry } from "@navet/shared";
import { normalizeNumber, type EffectiveValue, type EngineTemplate } from "./configurator-engine.js";

// Produktkonfigurator — lagerförda varianter: the variant's identity derived from the template article and
// the engine's effective values. Pure (no DB imports). Article number = template number + one `-part` per
// group WITH a value, in group order (sortOrder, then code); name = template name + `, part` likewise. The
// `selection` copy has one entry per group, empty ones included, so the variant shows its choices even after
// the template changes (stored as configurator_variants.selection).

export const ARTICLE_NUMBER_MAX = 50;
export const ARTICLE_NAME_MAX = 255;

export type VariantIdentity =
  | { ok: true; articleNumber: string; name: string; selection: VariantSelectionEntry[] }
  | { ok: false; articleNumber: string; name: string; error: string; selection: VariantSelectionEntry[] };

/** A measure as written in number and name: decimal comma, no trailing zeros (`1200`, `12,5`). */
export const svNumber = (n: number) => normalizeNumber(n).replace(".", ",");

const sortGroups = <G extends { sortOrder: number; code: string }>(groups: G[]): G[] =>
  [...groups].sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

/** One entry per group in group order (sortOrder, then code), empty groups included — the stored
 *  `selection` of a variant and of a beställningsvara row (configurator 4b shares this builder). */
export function selectionEntries(template: EngineTemplate, effective: Map<string, EffectiveValue>): VariantSelectionEntry[] {
  const selection: VariantSelectionEntry[] = [];
  for (const g of sortGroups(template.groups)) {
    const cur = effective.get(g.id);
    const entry: VariantSelectionEntry = {
      groupCode: g.code, groupName: g.name, kind: g.kind, valueCode: null, valueName: null, value: null, unit: g.unit,
    };
    if (g.kind === "choice") {
      const value = cur?.valueId ? g.values.find((v) => v.id === cur.valueId) : undefined;
      if (value) {
        entry.valueCode = value.code;
        entry.valueName = value.name;
        entry.value = value.code;
      }
    } else if (g.kind === "boolean") {
      entry.value = cur?.value === true;
    } else if (typeof cur?.value === "number") {
      entry.value = cur.value;
    }
    selection.push(entry);
  }
  return selection;
}

export function variantIdentity(
  template: EngineTemplate,
  templateArticle: { articleNumber: string; name: string },
  effective: Map<string, EffectiveValue>
): VariantIdentity {
  const selection = selectionEntries(template, effective);
  let articleNumber = templateArticle.articleNumber;
  let name = templateArticle.name;

  for (const entry of selection) {
    if (entry.kind === "choice" && entry.valueCode !== null) {
      articleNumber += `-${entry.valueCode}`;
      name += `, ${entry.valueName}`;
    } else if (entry.kind === "boolean" && entry.value === true) {
      articleNumber += `-${entry.groupCode}`;
      name += `, ${entry.groupName}`;
    } else if (entry.kind === "number" && typeof entry.value === "number") {
      const written = svNumber(entry.value);
      articleNumber += `-${written}`;
      name += `, ${entry.groupName} ${written}${entry.unit ? ` ${entry.unit}` : ""}`;
    }
  }

  if (articleNumber.length > ARTICLE_NUMBER_MAX) {
    return { ok: false, articleNumber, name, error: `Artikelnumret blir längre än ${ARTICLE_NUMBER_MAX} tecken`, selection };
  }
  if (name.length > ARTICLE_NAME_MAX) {
    return { ok: false, articleNumber, name, error: `Benämningen blir längre än ${ARTICLE_NAME_MAX} tecken`, selection };
  }
  return { ok: true, articleNumber, name, selection };
}

export type VariantArticleFields = { colour?: string | null; surfaceTreatment?: string | null };

const FIELD_KEY: Record<ConfiguratorArticleField, keyof VariantArticleFields> = { colour: "colour", surface_treatment: "surfaceTreatment" };

/**
 * The article fields (Färg/Ytbehandling) a group is coupled to via `article_field`: the chosen alternative's
 * name, null when the coupled group has no value. A field no group is coupled to is left out — the caller
 * keeps the template's own value for it.
 */
export function variantArticleFields(
  groups: { id: string; articleField: ConfiguratorArticleField | null; values: { id: string; name: string }[] }[],
  effective: Map<string, EffectiveValue>
): VariantArticleFields {
  const fields: VariantArticleFields = {};
  for (const g of groups) {
    if (!g.articleField) continue;
    const valueId = effective.get(g.id)?.valueId ?? null;
    const value = valueId ? g.values.find((v) => v.id === valueId) : undefined;
    fields[FIELD_KEY[g.articleField]] = value?.name ?? null;
  }
  return fields;
}

// The stored entries back to the engine's selection (variantPrice and the
// configured rows re-evaluate the template with them). An entry without a
// value comes back as `null` — "deliberately empty" to the engine (delprojekt
// 5) — so a saved row/variant keeps the group empty even if the template later
// gets a default for it; an unchecked ja/nej stays `false`. The key is
// unaffected: an empty group contributes nothing to it either way. Mirrored in
// apps/web/lib/configurator.ts.
export function selectionFromEntries(entries: VariantSelectionEntry[]): ConfiguratorSelection {
  const selection: ConfiguratorSelection = {};
  for (const e of entries) selection[e.groupCode] = e.value;
  return selection;
}
