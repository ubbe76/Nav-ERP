// apps/api/src/modules/configurator/service/variant-expand.ts
import type { ConfiguratorSelection } from "@navet/shared";
import type { EngineGroup, EngineTemplate } from "./configurator-engine.js";

// Produktkonfigurator — lagerförda varianter: expands the user's value sets (per group code, same form as the
// engine's `selection`) into one selection per combination. Pure (no DB imports). The Cartesian product runs
// in group order (sortOrder, then code), values in the order given, so the preview rows and the created
// variants come out in a predictable order. A group absent from `sets` is absent from every selection — the
// engine applies its default. A `null` in a set is the engine's "deliberately empty" (delprojekt 5) and is
// passed through as such — resolveVariant builds its sets from a selection that may clear a default this way,
// and variantSetsSchema (preview/create) accepts null in choice and number sets for the same reason. A boolean
// set's null is read as false (the engine's own reading) before the duplicate check, so [false, null] can never
// become two combinations with one key; the schema refuses null in a boolean set. The sets are validated here against the
// template (unknown group, alternative not in the group, wrong value type, duplicate, empty set); whether a
// COMBINATION is valid (rules, ranges, inactive alternatives) is the engine's verdict per row.

export const MAX_VARIANT_COMBINATIONS = 200;

export type VariantSets = Record<string, (string | null)[] | (boolean | null)[] | (number | null)[]>;

/** A malformed set. The service maps it to InvalidConfiguratorVariantSetError (400). */
export class VariantSetError extends Error {}

/** More combinations than the cap; `count` is the real total so the message can show it. */
export class TooManyCombinationsError extends Error {
  constructor(public count: number) {
    super(`${count}`);
  }
}

export function expandCombinations(template: EngineTemplate, sets: VariantSets): ConfiguratorSelection[] {
  const groups = [...template.groups].sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const byCode = new Map(groups.map((g) => [g.code, g]));
  for (const code of Object.keys(sets)) {
    if (!byCode.has(code)) throw new VariantSetError(`Valgruppen ${code} finns inte`);
  }

  // Validate every set before multiplying so the cap error reports the real count of a well-formed request.
  const validated: { group: EngineGroup; values: (string | boolean | number | null)[] }[] = [];
  for (const g of groups) {
    const raw = sets[g.code];
    if (raw === undefined) continue;
    validated.push({ group: g, values: validateSet(g, raw) });
  }
  const total = validated.reduce((n, v) => n * v.values.length, 1);
  if (total > MAX_VARIANT_COMBINATIONS) throw new TooManyCombinationsError(total);

  let combos: ConfiguratorSelection[] = [{}];
  for (const { group, values } of validated) {
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [group.code]: v })));
  }
  return combos;
}

function validateSet(g: EngineGroup, raw: (string | boolean | number | null)[]): (string | boolean | number | null)[] {
  if (raw.length === 0) throw new VariantSetError(`${g.name} saknar värden`);
  if (new Set(raw).size !== raw.length) throw new VariantSetError(`${g.name} har samma värde flera gånger`);
  switch (g.kind) {
    case "choice":
      for (const v of raw) {
        if (v === null) continue;
        if (typeof v !== "string") throw new VariantSetError(`${g.name} tar alternativkoder`);
        if (!g.values.some((x) => x.code === v)) throw new VariantSetError(`Alternativet ${v} finns inte i ${g.name}`);
      }
      return raw;
    case "boolean": {
      for (const v of raw) if (v !== null && typeof v !== "boolean") throw new VariantSetError(`${g.name} tar ja eller nej`);
      // Cleared ≡ nej in the engine — normalised so the duplicate check sees it.
      const normalized = raw.map((v) => (v === null ? false : v));
      if (new Set(normalized).size !== normalized.length) throw new VariantSetError(`${g.name} har samma värde flera gånger`);
      return normalized;
    }
    case "number":
      for (const v of raw) if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw new VariantSetError(`${g.name} tar tal`);
      return raw;
  }
}
