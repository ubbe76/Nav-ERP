import { describe, expect, it } from "vitest";
import { configuratorGroupKindSchema, configuratorModeSchema, configuratorRuleEffectSchema, priceSourceSchema, configuratorLineSourceSchema, configuratorArticleFieldSchema, type VariantPreviewRow as SharedPreviewRow, type VariantListRow as SharedListRow, type VariantOf as SharedVariantOf, type VariantSelectionEntry as SharedSelEntry, type ConfiguratorTemplateDetail as SharedTemplate, type ConfiguratorTemplateView as SharedTemplateView, type ConfiguratorDerivation as SharedDerivation, type OrderRowConfiguration as SharedRowConfig } from "@navet/shared";
import { CONFIGURATOR_ARTICLE_FIELDS, CONFIGURATOR_GROUP_KIND_LABELS, CONFIGURATOR_MODE_LABELS, CONFIGURATOR_RULE_EFFECT_LABELS, PRICE_SOURCES, CONFIGURATOR_LINE_SOURCES, type VariantPreviewRow as WebPreviewRow, type VariantListRow as WebListRow, type VariantOf as WebVariantOf, type VariantSelectionEntry as WebSelEntry, type ConfiguratorTemplateDetail as WebTemplate, type ConfiguratorTemplateView as WebTemplateView, type ConfiguratorDerivation as WebDerivation, type OrderRowConfiguration as WebRowConfig } from "../../web/lib/configurator";
import { selectionFromEntries as webSelectionFromEntries } from "../../web/lib/configurator";
import { selectionFromEntries as apiSelectionFromEntries } from "../src/modules/configurator/service/variant-identity.js";

describe("web configurator mirror", () => {
  it("labels cover exactly the shared enums", () => {
    expect(Object.keys(CONFIGURATOR_MODE_LABELS).sort()).toEqual([...configuratorModeSchema.options].sort());
    expect(Object.keys(CONFIGURATOR_GROUP_KIND_LABELS).sort()).toEqual([...configuratorGroupKindSchema.options].sort());
    expect(Object.keys(CONFIGURATOR_RULE_EFFECT_LABELS).sort()).toEqual([...configuratorRuleEffectSchema.options].sort());
  });

  it("PriceSource mirrors the shared price-chain sources exactly", () => {
    expect([...PRICE_SOURCES].sort()).toEqual([...priceSourceSchema.options].sort());
  });

  it("line sources mirror the shared enum", () => {
    expect([...CONFIGURATOR_LINE_SOURCES].sort()).toEqual([...configuratorLineSourceSchema.options].sort());
  });

  it("template detail shapes are mutually assignable (compile-time)", () => {
    const toShared = (w: WebTemplate): SharedTemplate => w;
    const toWeb = (s: SharedTemplate): WebTemplate => s;
    expect(typeof toShared).toBe("function");
    expect(typeof toWeb).toBe("function");
  });

  it("template view shapes (GET with structureWarnings) are mutually assignable (compile-time)", () => {
    const toShared = (w: WebTemplateView): SharedTemplateView => w;
    const toWeb = (s: SharedTemplateView): WebTemplateView => s;
    expect(typeof toShared).toBe("function");
    expect(typeof toWeb).toBe("function");
  });

  it("derive response shapes are mutually assignable (compile-time)", () => {
    const toShared = (w: WebDerivation): SharedDerivation => w;
    const toWeb = (s: SharedDerivation): WebDerivation => s;
    expect(typeof toShared).toBe("function");
    expect(typeof toWeb).toBe("function");
  });

  it("article fields mirror the shared enum", () => {
    expect([...CONFIGURATOR_ARTICLE_FIELDS].sort()).toEqual([...configuratorArticleFieldSchema.options].sort());
  });

  it("variant shapes are mutually assignable (compile-time)", () => {
    const a = (w: WebPreviewRow): SharedPreviewRow => w;
    const b = (s: SharedPreviewRow): WebPreviewRow => s;
    const c = (w: WebListRow): SharedListRow => w;
    const d = (s: SharedListRow): WebListRow => s;
    const e = (w: WebVariantOf): SharedVariantOf => w;
    const f = (s: SharedVariantOf): WebVariantOf => s;
    const g = (w: WebSelEntry): SharedSelEntry => w;
    const h = (s: SharedSelEntry): WebSelEntry => s;
    expect([a, b, c, d, e, f, g, h].every((fn) => typeof fn === "function")).toBe(true);
  });

  it("order row configuration shapes are mutually assignable (compile-time)", () => {
    const toShared = (w: WebRowConfig): SharedRowConfig => w;
    const toWeb = (s: SharedRowConfig): WebRowConfig => s;
    expect(typeof toShared).toBe("function");
    expect(typeof toWeb).toBe("function");
  });

  // Delprojekt 5: both selectionFromEntries write null for an empty entry (a
  // re-evaluated row keeps "empty" even after the template gets a default).
  it("selectionFromEntries mirrors the API: null for an empty entry", () => {
    const entries: SharedSelEntry[] = [
      { groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: null, valueName: null, value: null, unit: null },
      { groupCode: "HJUL", groupName: "Hjul", kind: "boolean", valueCode: null, valueName: null, value: false, unit: null },
      { groupCode: "BREDD", groupName: "Bredd", kind: "number", valueCode: null, valueName: null, value: 1200, unit: "mm" },
    ];
    const expected = { LOCK: null, HJUL: false, BREDD: 1200 };
    expect(webSelectionFromEntries(entries)).toEqual(expected);
    expect(apiSelectionFromEntries(entries)).toEqual(expected);
  });
});
