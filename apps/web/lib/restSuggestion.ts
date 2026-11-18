import { round4 } from "./format";

// Rest som förslag i antalsfältet — the pure rule behind the system setting:
// does a quantity field start with the remaining amount or empty? One rule
// for Inleverans, Utleverans, Rapportera (TO card) and Stämpla ut (terminal
// and Pågående). No DB or React imports, so the API test suite loads it
// directly (test/web-rest-suggestion.test.ts).

export type RestRoutine = "receipt" | "delivery" | "report" | "stamp";

// What GET /settings (and GET /settings/terminal for the stamp one) answers,
// narrowed to these four. A field that is missing — an older API, a failed
// read — falls back to the default.
export interface RestSuggestionSettings {
  restSuggestReceipt?: boolean;
  restSuggestDelivery?: boolean;
  restSuggestReport?: boolean;
  restSuggestStamp?: boolean;
}

// The behaviour before the setting existed. Mirrors
// apps/api/src/modules/system/service/rest-suggestion-settings.ts.
export const REST_SUGGESTION_DEFAULTS: Record<RestRoutine, boolean> = {
  receipt: true,
  delivery: true,
  report: true,
  stamp: false,
};

const FIELD: Record<RestRoutine, keyof RestSuggestionSettings> = {
  receipt: "restSuggestReceipt",
  delivery: "restSuggestDelivery",
  report: "restSuggestReport",
  stamp: "restSuggestStamp",
};

// Should the routine suggest the remaining amount in its quantity field?
export function suggestsRest(settings: RestSuggestionSettings | null | undefined, routine: RestRoutine): boolean {
  return settings?.[FIELD[routine]] ?? REST_SUGGESTION_DEFAULTS[routine];
}

// The text a quantity field starts with: the remaining amount (never below
// 0, rounded like every quantity) when the routine suggests it, else empty —
// never "0".
export function restFieldValue(suggest: boolean, remaining: number): string {
  return suggest ? String(Math.max(0, round4(remaining))) : "";
}

// Stämpling: the rest is suggested only when the setting is on AND nobody
// else has an open stamp on the same operation — the rest is then shared
// between the stamps, and the operator reports their own part. `othersStamping`
// tells the terminal to say why the field stays empty.
export function stampRestSuggestion(input: { enabled: boolean; remaining: number; othersStamping: boolean }): {
  value: string;
  othersStamping: boolean;
} {
  const shared = input.enabled && input.othersStamping;
  return { value: restFieldValue(input.enabled && !input.othersStamping, input.remaining), othersStamping: shared };
}

// Another person's open stamp (paused or running) on the same operation.
// `session` is the stamp being stopped; the same session never counts.
export function othersStampingOnOperation(
  openSessions: { id: string; moOperationId: string }[],
  session: { id: string; moOperationId: string }
): boolean {
  return openSessions.some((s) => s.moOperationId === session.moOperationId && s.id !== session.id);
}
