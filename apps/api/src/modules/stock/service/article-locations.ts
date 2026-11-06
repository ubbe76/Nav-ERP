// Flera lagerplatser per artikel (migration 0186) — the rules of
// PUT /articles/:id/locations, pure (no DB imports): the repository leaf
// (repository/article-locations.ts) reads the places under its locks and
// asks here. Every refusal is a Swedish sentence; the route answers it as
// 400 article-location-invalid.
import { ARTICLE_ALTERNATIVE_LOCATIONS_MAX, type ArticleLocationsInput } from "@navet/shared";
import { FALLBACK_LOCATION_NAME } from "./outflow-allocation.js";

export interface ArticleLocationFacts {
  id: string;
  name: string;
  warehouseName: string;
  active: boolean;
  blocked: boolean;
}

const label = (place: ArticleLocationFacts) => `${place.warehouseName} — ${place.name}`;

// What the request says on its own, before any place is read: at most 20
// alternatives, each once, and the huvudplats not among them (it is first
// in the order already).
export function articleLocationInputProblem(input: ArticleLocationsInput): string | null {
  const alternatives = input.alternativeLocationIds;
  if (alternatives.length > ARTICLE_ALTERNATIVE_LOCATIONS_MAX) {
    return `En artikel kan ha högst ${ARTICLE_ALTERNATIVE_LOCATIONS_MAX} alternativa lagerplatser.`;
  }
  if (new Set(alternatives).size !== alternatives.length) {
    return "Samma lagerplats står flera gånger bland de alternativa lagerplatserna.";
  }
  if (input.primaryLocationId !== null && alternatives.includes(input.primaryLocationId)) {
    return "Huvudplatsen kan inte också vara en alternativ lagerplats.";
  }
  return null;
}

// Against the places as they are (read under the locks) and the article's
// current set. An inactive or blocked place may only STAY in its role — a
// place retired or blocked after it was chosen is skipped by the resolver and
// by Automatiskt, and refusing it would stop the card from saving anything
// else — but never be put there anew: as the huvudplats when it was not the
// huvudplats, as an alternative when it was not an alternative. "***" is the
// fallback after every place, so it is never one of the alternatives (it may
// be the huvudplats, as every new article without a place has it).
export function articleLocationPlaceProblem(
  input: ArticleLocationsInput,
  current: ArticleLocationsInput,
  places: ReadonlyMap<string, ArticleLocationFacts>
): string | null {
  const ids = [...(input.primaryLocationId ? [input.primaryLocationId] : []), ...input.alternativeLocationIds];
  if (ids.some((id) => !places.has(id))) return "Lagerplatsen finns inte längre — ladda om sidan.";

  if (input.alternativeLocationIds.some((id) => places.get(id)!.name === FALLBACK_LOCATION_NAME)) {
    return `Reservplatsen ${FALLBACK_LOCATION_NAME} kan inte vara en alternativ lagerplats — den används när ingen annan plats går.`;
  }

  if (input.primaryLocationId && input.primaryLocationId !== current.primaryLocationId) {
    const primary = places.get(input.primaryLocationId)!;
    if (!primary.active) return `Lagerplatsen ${label(primary)} är inaktiv och kan inte väljas som huvudplats.`;
    if (primary.blocked) return `Lagerplatsen ${label(primary)} är spärrad och kan inte väljas som huvudplats.`;
  }

  const kept = new Set(current.alternativeLocationIds);
  for (const id of input.alternativeLocationIds) {
    if (kept.has(id)) continue;
    const place = places.get(id)!;
    if (!place.active) return `Lagerplatsen ${label(place)} är inaktiv och kan inte läggas till som alternativ lagerplats.`;
    if (place.blocked) return `Lagerplatsen ${label(place)} är spärrad och kan inte läggas till som alternativ lagerplats.`;
  }
  return null;
}
