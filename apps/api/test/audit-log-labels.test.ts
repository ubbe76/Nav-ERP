import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_TYPE_LABELS } from "../src/modules/system/service/audit-log-labels.js";

// Händelseloggen shows a raw key when a writer's entityType/action has no
// Swedish label. The labels live twice — the API (CSV export) and the web —
// so both must carry the keys the newer writers use.
const web = readFileSync(new URL("../../web/lib/types.ts", import.meta.url), "utf8");

describe("händelseloggens etiketter", () => {
  it.each([
    ["entity", "system"],
    ["entity", "api_client"],
    ["action", "demo_data_created"],
    ["action", "onboarding_number_series_reviewed"],
    ["action", "supplier_changed"],
  ])("labels the %s %s on both sides", (kind, key) => {
    const api = kind === "entity" ? AUDIT_ENTITY_TYPE_LABELS : AUDIT_ACTION_LABELS;
    expect(api[key]).toMatch(/\S/);
    expect(web).toMatch(new RegExp(`\\b${key}: "`));
  });
});
