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
    ["entity", "einvoice_settings"],
    ["action", "einvoice_sent"],
    ["action", "einvoice_failed"],
    ["action", "lost"],
    ["action", "reopened"],
    ["action", "order_created"],
    ["action", "created_from_quote"],
    ["entity", "theme"],
    ["action", "theme_created"],
    ["action", "theme_updated"],
    ["action", "theme_deleted"],
    ["entity", "plugin"],
    ["action", "plugin_installed"],
    ["action", "plugin_updated"],
    ["action", "plugin_paused"],
    ["action", "plugin_activated"],
    ["action", "plugin_key_rotated"],
    ["action", "plugin_secret_rotated"],
    ["action", "plugin_uninstalled"],
    ["entity", "invoice_scan"],
    ["entity", "invoice_scan_settings"],
    ["action", "received"],
    ["action", "converted"],
    ["action", "rejected"],
    ["action", "restored"],
    ["action", "booking_taken_over"],
    // Fraktgranskningen: Sendify's answer to BOOK lost or unreadable.
    ["action", "booking_unknown"],
    // Påslag per nivå (#16).
    ["entity", "article_group"],
    ["entity", "customer"],
    ["action", "markups_changed"],
    // Pegging (#9).
    ["action", "component_orders_created"],
    // Prognos (#10).
    ["action", "forecast_updated"],
  ])("labels the %s %s on both sides", (kind, key) => {
    const api = kind === "entity" ? AUDIT_ENTITY_TYPE_LABELS : AUDIT_ACTION_LABELS;
    expect(api[key]).toMatch(/\S/);
    expect(web).toMatch(new RegExp(`\\b${key}: "`));
  });
});
