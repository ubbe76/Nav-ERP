import type {
  ConfiguratorGroupDetail, ConfiguratorMode, ConfiguratorTemplateDetail, PublicTemplate, PublicTemplateGroup, PublicTemplateSummary,
} from "@navet/shared";

// Konfigurator delprojekt 5 — the external configurator's view of a template.
// Pure: built field by field from the internal detail (never spread), so a
// field added to ConfiguratorTemplateDetail later can never leak by accident.
// Out by design: rules, structure lines, operations, the alternatives'
// article links, the group's article field, every internal id and every
// cost. Availability and rule messages come from evaluate instead.

// The template article's identity (the detail itself carries neither).
export type PublicTemplateArticle = { articleNumber: string; name: string };

// What the summary needs — a full detail satisfies it, and so does the list
// query's lean row (no values, rules, lines or operations loaded).
export type PublicTemplateSummarySource = {
  articleId: string;
  mode: ConfiguratorMode;
  basePrice: string | null;
  groups: Pick<ConfiguratorGroupDetail, "code" | "name" | "kind" | "required" | "sortOrder">[];
};

const toNumber = (v: string | null): number | null => (v === null ? null : Number(v));
const bySortOrder = <T extends { sortOrder: number; code: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));

// The default as the engine applies it to a missing key: the alternative's
// code (only while it is active), ja/nej = Nej, the number's default value.
function groupDefault(g: ConfiguratorGroupDetail): string | boolean | number | null {
  if (g.kind === "boolean") return false;
  if (g.kind === "number") return toNumber(g.defaultNumber);
  return g.values.find((v) => v.id === g.defaultValueId && v.active)?.code ?? null;
}

function toPublicGroup(g: ConfiguratorGroupDetail): PublicTemplateGroup {
  return {
    code: g.code,
    name: g.name,
    kind: g.kind,
    required: g.required,
    unit: g.unit,
    min: toNumber(g.minValue),
    max: toNumber(g.maxValue),
    step: toNumber(g.step),
    default: groupDefault(g),
    priceAdd: Number(g.priceAdd),
    pricePerUnit: Number(g.pricePerUnit),
    priceBaseValue: Number(g.priceBaseValue),
    values: bySortOrder(g.values.filter((v) => v.active)).map((v) => ({ code: v.code, name: v.name, priceAdd: Number(v.priceAdd) })),
  };
}

export function toPublicTemplateSummary(source: PublicTemplateSummarySource, article: PublicTemplateArticle): PublicTemplateSummary {
  return {
    articleId: source.articleId,
    articleNumber: article.articleNumber,
    name: article.name,
    mode: source.mode,
    basePrice: toNumber(source.basePrice),
    groups: bySortOrder(source.groups).map((g) => ({ code: g.code, name: g.name, kind: g.kind, required: g.required })),
  };
}

export function toPublicTemplate(detail: ConfiguratorTemplateDetail, article: PublicTemplateArticle): PublicTemplate {
  return {
    articleId: detail.articleId,
    articleNumber: article.articleNumber,
    name: article.name,
    mode: detail.mode,
    basePrice: toNumber(detail.basePrice),
    groups: bySortOrder(detail.groups).map(toPublicGroup),
  };
}
