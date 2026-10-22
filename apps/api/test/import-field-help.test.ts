import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMPORT_ENTITY_ORDER, importEntitySchema, type ImportEntity } from "@navet/shared";
import { IMPORT_FIELD_HELP } from "../src/modules/import/service/field-help.js";
import { ImportMappingError, normalizeHeader } from "../src/modules/import/service/import.service.js";
import { normalizeDecimal } from "../src/modules/import/service/csv.js";
import { detectImportEntity } from "../src/modules/import/service/detect.js";
import {
  ARTICLE_IMPORT_FIELDS,
  parseArticleType,
  planArticleImport,
  suggestArticleMapping,
} from "../src/modules/import/service/articles.js";
import {
  ARTICLE_UNIT_IMPORT_FIELDS,
  planArticleUnitImport,
  suggestArticleUnitMapping,
} from "../src/modules/import/service/article-units.js";
import {
  ROUTING_IMPORT_FIELDS,
  parseRoutingTimeUnit,
  planRoutingImport,
  suggestRoutingMapping,
} from "../src/modules/import/service/routing.js";
import { BOM_IMPORT_FIELDS, planBomImport, suggestBomMapping } from "../src/modules/import/service/bom.js";
import {
  SUPPLIER_PRICE_IMPORT_FIELDS,
  planSupplierPriceImport,
  suggestSupplierPriceMapping,
} from "../src/modules/import/service/supplier-prices.js";
import {
  CUSTOMER_PRICE_IMPORT_FIELDS,
  planCustomerPriceImport,
  suggestCustomerPriceMapping,
} from "../src/modules/import/service/customer-prices.js";
import {
  CUSTOMER_IMPORT_FIELDS,
  planCustomerImport,
  suggestCustomerMapping,
} from "../src/modules/import/service/customers.js";
import {
  CUSTOMER_CONTACT_IMPORT_FIELDS,
  planCustomerContactImport,
  suggestCustomerContactMapping,
} from "../src/modules/import/service/customer-contacts.js";
import {
  CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS,
  planCustomerDeliveryAddressImport,
  suggestCustomerDeliveryAddressMapping,
} from "../src/modules/import/service/customer-delivery-addresses.js";
import {
  SUPPLIER_IMPORT_FIELDS,
  planSupplierImport,
  suggestSupplierMapping,
} from "../src/modules/import/service/suppliers.js";
import {
  SUPPLIER_CONTACT_IMPORT_FIELDS,
  planSupplierContactImport,
  suggestSupplierContactMapping,
} from "../src/modules/import/service/supplier-contacts.js";
import {
  SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS,
  planSupplierDeliveryAddressImport,
  suggestSupplierDeliveryAddressMapping,
} from "../src/modules/import/service/supplier-delivery-addresses.js";
import {
  WORK_CENTER_IMPORT_FIELDS,
  parseWorkCenterType,
  planWorkCenterImport,
  suggestWorkCenterMapping,
} from "../src/modules/import/service/work-centers.js";
import {
  LEGO_WORK_CENTER_IMPORT_FIELDS,
  planLegoWorkCenterImport,
  suggestLegoWorkCenterMapping,
} from "../src/modules/import/service/lego-work-centers.js";
import {
  PRODUCTION_GROUP_IMPORT_FIELDS,
  planProductionGroupImport,
  suggestProductionGroupMapping,
} from "../src/modules/import/service/production-groups.js";
import { IMPORT_TEMPLATES } from "../src/modules/import/service/import-template.js";

// The field help (field-help.ts) is the single source for the Excel
// templates, the manual chapter Importmallar and the wizard's mapping step.
// Pure — no database: every planner is driven with an empty row set and a
// stub that answers every lookup with nothing.

type Planner = (input: Parameters<typeof planArticleImport>[0], deps: never) => Promise<unknown>;

interface EntitySpec {
  fields: readonly string[];
  suggest: (headers: string[]) => Record<string, string | null>;
  plan: Planner;
  /** Mirror constant in apps/web/lib/importFields.ts. */
  webConstant: string;
}

const ENTITIES: Record<ImportEntity, EntitySpec> = {
  articles: { fields: ARTICLE_IMPORT_FIELDS, suggest: suggestArticleMapping, plan: planArticleImport as Planner, webConstant: "ARTICLE_IMPORT_FIELDS" },
  articleUnits: { fields: ARTICLE_UNIT_IMPORT_FIELDS, suggest: suggestArticleUnitMapping, plan: planArticleUnitImport as Planner, webConstant: "ARTICLE_UNIT_IMPORT_FIELDS" },
  routing: { fields: ROUTING_IMPORT_FIELDS, suggest: suggestRoutingMapping, plan: planRoutingImport as Planner, webConstant: "ROUTING_IMPORT_FIELDS" },
  bom: { fields: BOM_IMPORT_FIELDS, suggest: suggestBomMapping, plan: planBomImport as Planner, webConstant: "BOM_IMPORT_FIELDS" },
  supplierPrices: { fields: SUPPLIER_PRICE_IMPORT_FIELDS, suggest: suggestSupplierPriceMapping, plan: planSupplierPriceImport as Planner, webConstant: "SUPPLIER_PRICE_IMPORT_FIELDS" },
  customerPrices: { fields: CUSTOMER_PRICE_IMPORT_FIELDS, suggest: suggestCustomerPriceMapping, plan: planCustomerPriceImport as Planner, webConstant: "CUSTOMER_PRICE_IMPORT_FIELDS" },
  customers: { fields: CUSTOMER_IMPORT_FIELDS, suggest: suggestCustomerMapping, plan: planCustomerImport as Planner, webConstant: "CUSTOMER_IMPORT_FIELDS" },
  customerContacts: { fields: CUSTOMER_CONTACT_IMPORT_FIELDS, suggest: suggestCustomerContactMapping, plan: planCustomerContactImport as Planner, webConstant: "CUSTOMER_CONTACT_IMPORT_FIELDS" },
  customerDeliveryAddresses: { fields: CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS, suggest: suggestCustomerDeliveryAddressMapping, plan: planCustomerDeliveryAddressImport as Planner, webConstant: "CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS" },
  suppliers: { fields: SUPPLIER_IMPORT_FIELDS, suggest: suggestSupplierMapping, plan: planSupplierImport as Planner, webConstant: "SUPPLIER_IMPORT_FIELDS" },
  supplierContacts: { fields: SUPPLIER_CONTACT_IMPORT_FIELDS, suggest: suggestSupplierContactMapping, plan: planSupplierContactImport as Planner, webConstant: "SUPPLIER_CONTACT_IMPORT_FIELDS" },
  supplierDeliveryAddresses: { fields: SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS, suggest: suggestSupplierDeliveryAddressMapping, plan: planSupplierDeliveryAddressImport as Planner, webConstant: "SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS" },
  workCenters: { fields: WORK_CENTER_IMPORT_FIELDS, suggest: suggestWorkCenterMapping, plan: planWorkCenterImport as Planner, webConstant: "WORK_CENTER_IMPORT_FIELDS" },
  legoWorkCenters: { fields: LEGO_WORK_CENTER_IMPORT_FIELDS, suggest: suggestLegoWorkCenterMapping, plan: planLegoWorkCenterImport as Planner, webConstant: "LEGO_WORK_CENTER_IMPORT_FIELDS" },
  productionGroups: { fields: PRODUCTION_GROUP_IMPORT_FIELDS, suggest: suggestProductionGroupMapping, plan: planProductionGroupImport as Planner, webConstant: "PRODUCTION_GROUP_IMPORT_FIELDS" },
};

const ALL_ENTITIES = importEntitySchema.options;

// Every lookup comes back empty; the two non-Map answers are the shapes the
// planners destructure before looking at any row.
const EMPTY_DEPS = new Proxy(
  {},
  {
    get: (_target, name) => async () => {
      if (name === "allBomEdges") return [];
      if (name === "resolveDefaults") return { unitId: "unit", locationId: "location" };
      return new Map();
    },
  }
) as never;

describe("field help — coverage", () => {
  it("covers every entity of importEntitySchema and no other", () => {
    expect(Object.keys(IMPORT_FIELD_HELP).sort()).toEqual([...ALL_ENTITIES].sort());
    expect(Object.keys(ENTITIES).sort()).toEqual([...ALL_ENTITIES].sort());
  });

  it.each(ALL_ENTITIES)("%s: the help lists exactly the planner's fields, in the wizard's order", (entity) => {
    expect(IMPORT_FIELD_HELP[entity].map((h) => h.field)).toEqual([...ENTITIES[entity].fields]);
  });

  it.each(ALL_ENTITIES)("%s: every entry has a header, a description and an example", (entity) => {
    for (const help of IMPORT_FIELD_HELP[entity]) {
      expect(help.header.trim(), help.field).not.toBe("");
      expect(help.label.trim(), help.field).not.toBe("");
      expect(help.description.trim().length, help.field).toBeGreaterThan(10);
      expect(help.example.trim(), help.field).not.toBe("");
      // The texts are for the user: never the old system's name, never a
      // line break (the manual table and the comment are single lines).
      expect(help.description, help.field).not.toMatch(/monitor/i);
      expect(help.description, help.field).not.toMatch(/\n/);
      expect(help.example, help.field).not.toMatch(/\n/);
    }
  });

  it.each(ALL_ENTITIES)("%s: the headers are unique", (entity) => {
    const headers = IMPORT_FIELD_HELP[entity].map((h) => normalizeHeader(h.header));
    expect(new Set(headers).size).toBe(headers.length);
  });
});

describe("field help — the template's headings map themselves", () => {
  it.each(ALL_ENTITIES)("%s: suggest…Mapping maps every template heading to its own field", (entity) => {
    const headers = IMPORT_FIELD_HELP[entity].map((h) => h.header);
    const mapping = ENTITIES[entity].suggest(headers);
    for (const help of IMPORT_FIELD_HELP[entity]) {
      expect(mapping[help.header], `${entity}.${help.field} ("${help.header}")`).toBe(help.field);
    }
  });

  it("the multi-file import recognises the templates of the entities it accepts", () => {
    for (const entity of IMPORT_ENTITY_ORDER) {
      const headers = IMPORT_FIELD_HELP[entity].map((h) => h.header);
      expect(detectImportEntity(headers), entity).toBe(entity);
    }
  });
});

describe("field help — required follows the planners", () => {
  it.each(ALL_ENTITIES)("%s: a mapping without a required field is refused, one without an optional field is not", async (entity) => {
    const spec = ENTITIES[entity];
    for (const help of IMPORT_FIELD_HELP[entity]) {
      const mapping: Record<string, string | null> = {};
      for (const other of IMPORT_FIELD_HELP[entity]) {
        if (other.field !== help.field) mapping[other.header] = other.field;
      }
      const attempt = spec.plan({ mapping, rows: [] }, EMPTY_DEPS);
      if (help.required) {
        await expect(attempt, `${entity}.${help.field} should be required`).rejects.toBeInstanceOf(ImportMappingError);
      } else {
        await expect(attempt, `${entity}.${help.field} should be optional`).resolves.toBeDefined();
      }
    }
  });
});

describe("field help — label and required mirror apps/web/lib/importFields.ts", () => {
  const source = readFileSync(new URL("../../web/lib/importFields.ts", import.meta.url), "utf8");

  function webFields(constant: string): { field: string; label: string; required: boolean }[] {
    const block = new RegExp(`export const ${constant}: ImportFieldConfig\\[\\] = \\[([\\s\\S]*?)\\n\\];`).exec(source);
    if (!block) throw new Error(`${constant} not found in importFields.ts`);
    const entries: { field: string; label: string; required: boolean }[] = [];
    const entryPattern = /\{ field: "([^"]+)", label: "([^"]+)"(, required: true)? \}/g;
    let match: RegExpExecArray | null;
    while ((match = entryPattern.exec(block[1]!)) !== null) {
      entries.push({ field: match[1]!, label: match[2]!, required: match[3] !== undefined });
    }
    return entries;
  }

  it.each(ALL_ENTITIES)("%s", (entity) => {
    const web = webFields(ENTITIES[entity].webConstant);
    expect(IMPORT_FIELD_HELP[entity].map((h) => ({ field: h.field, label: h.label, required: h.required }))).toEqual(web);
  });
});

describe("field help — the examples parse", () => {
  const NUMERIC: Partial<Record<ImportEntity, string[]>> = {
    articles: ["standardCost", "weight", "reorderPoint", "orderQuantity", "rounding"],
    articleUnits: ["factor"],
    routing: ["sequenceNo", "setupTime", "runTimePerUnit"],
    bom: ["quantity", "operationSequenceNo", "componentStandardCost"],
    supplierPrices: ["price", "discountPercent", "breakQuantity", "breakPrice"],
    customerPrices: ["price", "discountPercent"],
    customers: ["discountPercent"],
    workCenters: ["hourlyRate", "calcRate1", "defaultSetupTime"],
    legoWorkCenters: ["leadTimeDays", "queueTimeDays", "orderLeadTimeDays"],
  };
  const BOOLEAN: Partial<Record<ImportEntity, string[]>> = {
    articles: ["active"],
    articleUnits: ["isPurchaseUnit", "isSalesUnit"],
    routing: ["costingOnly"],
    supplierPrices: ["isPrimary"],
    customers: ["invoiceAddressDiffers", "collectiveInvoicing", "privatePerson"],
    customerContacts: ["isPrimary"],
    supplierContacts: ["isPrimary"],
    workCenters: ["rateAppliesToSetup", "rateAppliesToRun"],
  };
  // The narrowest vocabulary any boolean parser accepts (articles.ts's
  // parseActive) — an example in it is accepted by every one of them.
  const BOOL_WORDS = ["ja", "nej", "1", "0", "true", "false"];

  function example(entity: ImportEntity, field: string): string {
    const help = IMPORT_FIELD_HELP[entity].find((h) => h.field === field);
    if (!help) throw new Error(`${entity}.${field} has no help`);
    return help.example;
  }

  it("numbers", () => {
    for (const [entity, fields] of Object.entries(NUMERIC) as [ImportEntity, string[]][]) {
      for (const field of fields) {
        const value = normalizeDecimal(example(entity, field));
        expect(value, `${entity}.${field}`).not.toBeNull();
        expect(value!, `${entity}.${field}`).toBeGreaterThanOrEqual(0);
      }
    }
    // Integers where the planners demand them.
    expect(Number.isInteger(normalizeDecimal(example("routing", "sequenceNo")))).toBe(true);
    expect(Number.isInteger(normalizeDecimal(example("bom", "operationSequenceNo")))).toBe(true);
    // A staffel step must start above 1.
    expect(normalizeDecimal(example("supplierPrices", "breakQuantity"))!).toBeGreaterThan(1);
  });

  it("Ja/Nej", () => {
    for (const [entity, fields] of Object.entries(BOOLEAN) as [ImportEntity, string[]][]) {
      for (const field of fields) {
        expect(BOOL_WORDS, `${entity}.${field}`).toContain(example(entity, field).toLowerCase());
      }
    }
  });

  it("vocabularies and codes", () => {
    expect(parseArticleType(example("articles", "type"))).not.toBeNull();
    expect(parseArticleType(example("bom", "componentType"))).not.toBeNull();
    expect(parseRoutingTimeUnit(example("routing", "timeUnit"))).not.toBeNull();
    expect(parseWorkCenterType(example("workCenters", "type"))).toBe("machine");
    expect(example("articles", "lotSizingRule").toLowerCase().replace(/[^a-zåäö]/g, "")).toBe("fastorderstorlek");
    expect(example("articles", "groupCode")).toMatch(/^[0-9]{3,4}$/);
    for (const entity of ["routing", "workCenters", "legoWorkCenters"] as const) {
      const field = entity === "routing" ? "workCenterCode" : "code";
      expect(example(entity, field), entity).toMatch(/^[0-9]{3}$/);
    }
    expect(example("customers", "country")).toMatch(/^[A-Z]{2}$/);
    expect(example("customers", "invoiceCountry")).toMatch(/^[A-Z]{2}$/);
    expect(example("customerDeliveryAddresses", "country")).toMatch(/^[A-Z]{2}$/);
    expect(example("suppliers", "currency")).toMatch(/^[A-Z]{3}$/);
    for (const [entity, field] of [
      ["customers", "email"],
      ["customers", "invoiceEmail"],
      ["suppliers", "email"],
      ["customerContacts", "email"],
      ["supplierContacts", "email"],
    ] as const) {
      expect(example(entity, field), `${entity}.${field}`).toMatch(/^[^@\s]+@example\.com$/);
    }
  });
});

describe("the template registry", () => {
  it("has exactly one ASCII file name per entity", () => {
    expect(IMPORT_TEMPLATES.map((t) => t.entity).sort()).toEqual([...ALL_ENTITIES].sort());
    for (const info of IMPORT_TEMPLATES) {
      expect(info.fileName).toMatch(/^importmall-[a-z]+\.xlsx$/);
    }
    expect(new Set(IMPORT_TEMPLATES.map((t) => t.fileName)).size).toBe(IMPORT_TEMPLATES.length);
  });
});
