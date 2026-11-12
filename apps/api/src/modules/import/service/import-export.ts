// The registers as import files (#35, GET /imports/:entity/export): the
// template's columns in the template's order — IMPORT_FIELD_HELP, the ONE
// source the templates, the wizard's field help and the manual are built
// from — filled with the stored values written the way the entity's planner
// reads them, so that importing the file back changes nothing (the round
// trip, import-export.test.ts). Pure: records in, cells and files out; the
// reads are import-export.repository.ts.
//
// What "the way the planner reads them" means is the planner's own rule,
// inverted here, per entity (articles.ts, article-units.ts, routing.ts,
// bom.ts, supplier-prices.ts, customer-prices.ts, stock-balances.ts,
// customers.ts, suppliers.ts, the contact/address importers, work-centers.ts,
// lego-work-centers.ts, production-groups.ts). A change to a planner rule is
// a change here too — the round-trip test fails otherwise.
import {
  IMPORT_EXPORT_MAX_ROWS,
  exportTable,
  plainDecimal,
  round2,
  round4,
  roundToDecimals,
  tableCsv,
  toBaseQuantity,
  unitsPerHourToMinutesPerUnit,
  type ArticleType,
  type CsvColumn,
  type ExportTable,
  type ImportEntity,
  type ImportExportFormat,
  type OperationTimeUnit,
} from "@navet/shared";
import { IMPORT_FIELD_HELP } from "./field-help.js";
import { importTemplateInfo } from "./import-template.js";
import { CSV_CONTENT_TYPE, XLSX_CONTENT_TYPE, tableXlsx } from "../../system/service/table-export.js";
import { buildStoredZip } from "../../system/service/xlsx-writer.js";

// One file row: the import field -> its cell. A number is written as a
// number (decimal comma in the CSV, a number cell in Excel — unless the
// template formats the column as Text, then as that text); null/undefined/""
// is an empty cell, which every planner reads as "leave the field alone".
export type ImportExportCells = Record<string, string | number | null | undefined>;

// Rows that must stay in ONE file when the export is split: an article's
// operations, a parent's structure rows, a pair's price steps. The import
// treats each of them as a set (Uppdatera befintliga, the replaced steps),
// so half a set in one file would be read as the whole.
export type ImportExportBlock = ImportExportCells[];

const YES = "Ja";
const NO = "Nej";
const yesNo = (value: boolean): string => (value ? YES : NO);

// A cell value v such that forward(v) is exactly the stored target: the
// stored value is what the planner's rounding made of the cell, so the
// inverse is searched for with as few digits as possible (10 rather than
// 9.999999999) and checked through the planner's own function.
export function invertRounded(target: number, forward: (cell: number) => number, guess: number): number {
  if (!Number.isFinite(guess)) return guess;
  for (let digits = 1; digits <= 15; digits++) {
    const candidate = Number(guess.toPrecision(digits));
    if (forward(candidate) === target) return candidate;
  }
  return guess;
}

// --- articles ----------------------------------------------------------------

export interface ArticleExportRecord {
  articleNumber: string;
  name: string;
  type: ArticleType;
  isPhantom: boolean;
  unitCode: string;
  groupCode: string | null;
  articleCode: string | null;
  standardCost: number | null;
  weight: number | null;
  surfaceTreatment: string | null;
  colour: string | null;
  extraDescription: string | null;
  nameEn: string | null;
  extraDescriptionEn: string | null;
  barcode: string | null;
  active: boolean;
  reorderPoint: number | null;
  orderQuantity: number | null;
  rounding: number | null;
  safetyStock: number | null;
  stockControlled: boolean;
  forecastControlled: boolean;
  manufacturingLeadTimeDays: number | null;
  quantityPerPackage: number | null;
  /** The primary supplier (Inköp tab) and its catalogue lead time. */
  primarySupplierNumber: string | null;
  primarySupplierLeadTimeDays: number | null;
  /** The active article revision; the FIRST drawing number and its active revision. */
  activeRevision: string | null;
  drawingNumber: string | null;
  drawingRevision: string | null;
}

const ARTICLE_TYPE_WORDS: Record<ArticleType, string> = {
  manufactured: "Tillverkad",
  purchased: "Köpt",
  service: "Tjänst",
};

// parseArticleType's words: Fiktiv is a manufactured phantom.
export function articleTypeCell(type: ArticleType, isPhantom: boolean): string {
  return isPhantom && type === "manufactured" ? "Fiktiv" : ARTICLE_TYPE_WORDS[type];
}

export function articleExportBlocks(records: ArticleExportRecord[]): ImportExportBlock[] {
  return records.map((r) => [
    {
      articleNumber: r.articleNumber,
      name: r.name,
      type: articleTypeCell(r.type, r.isPhantom),
      unitCode: r.unitCode,
      groupCode: r.groupCode,
      articleCode: r.articleCode,
      standardCost: r.standardCost,
      weight: r.weight,
      surfaceTreatment: r.surfaceTreatment,
      colour: r.colour,
      extraDescription: r.extraDescription,
      nameEn: r.nameEn,
      extraDescriptionEn: r.extraDescriptionEn,
      barcode: r.barcode,
      active: yesNo(r.active),
      reorderPoint: r.reorderPoint,
      orderQuantity: r.orderQuantity,
      rounding: r.rounding,
      // The planner takes Orderkvantitet only under this rule when the
      // column is there — and the column is always there in an export.
      lotSizingRule: r.orderQuantity !== null ? "Fast orderstorlek" : null,
      safetyStock: r.safetyStock,
      stockControlled: r.stockControlled ? "Lagerstyrd" : "Orderstyrd",
      forecastControlled: yesNo(r.forecastControlled),
      // Where the planner puts Ledtid: the article's own for a manufactured
      // one, the primary supplier's for a purchased one, nowhere for a service.
      leadTimeDays:
        r.type === "manufactured"
          ? r.manufacturingLeadTimeDays
          : r.type === "purchased"
            ? r.primarySupplierLeadTimeDays
            : null,
      articleRevision: r.activeRevision,
      drawingNumber: r.drawingNumber,
      drawingRevision: r.drawingNumber !== null ? r.drawingRevision : null,
      quantityPerPackage: r.quantityPerPackage,
      primarySupplierNumber: r.primarySupplierNumber,
    },
  ]);
}

// --- alternative units -------------------------------------------------------

export interface ArticleUnitExportRecord {
  articleNumber: string;
  baseUnitCode: string;
  /** The default purchase/sales unit is the base unit (no other unit chosen). */
  purchaseOnBase: boolean;
  salesOnBase: boolean;
  units: { unitCode: string; quantityPerBase: number; isPurchaseUnit: boolean; isSalesUnit: boolean }[];
}

// Omräkningsfaktor is base units per ONE alternative unit; the planner
// stores quantity_per_base = round6(1 / factor).
export function unitFactorCell(quantityPerBase: number): number {
  return invertRounded(quantityPerBase, (factor) => roundToDecimals(1 / factor, 6), 1 / quantityPerBase);
}

// The base unit's own row (factor 1) comes first, as in the files the import
// was built for: it shows what the factors count in, and its Ja is how a
// file says "the base unit is the purchase/sales unit". Only articles that
// have an alternative unit get rows at all.
export function articleUnitExportBlocks(records: ArticleUnitExportRecord[]): ImportExportBlock[] {
  return records
    .filter((r) => r.units.length > 0)
    .map((r) => [
      {
        articleNumber: r.articleNumber,
        unitCode: r.baseUnitCode,
        factor: 1,
        isPurchaseUnit: yesNo(r.purchaseOnBase),
        isSalesUnit: yesNo(r.salesOnBase),
      },
      ...r.units.map((unit) => ({
        articleNumber: r.articleNumber,
        unitCode: unit.unitCode,
        factor: unitFactorCell(unit.quantityPerBase),
        isPurchaseUnit: yesNo(unit.isPurchaseUnit),
        isSalesUnit: yesNo(unit.isSalesUnit),
      })),
    ]);
}

// --- operations --------------------------------------------------------------

export interface RoutingExportRecord {
  articleNumber: string;
  sequenceNo: number;
  workCenterCode: string;
  isSubcontract: boolean;
  /** Minutes / minutes per unit, as stored. */
  setupTime: number;
  runTimePerUnit: number;
  cycleTimePerUnit: number | null;
  timeUnit: OperationTimeUnit;
  costingOnly: boolean;
  comment: string | null;
  description: string | null;
  packingInstructions: string | null;
  subcontractSupplierNumber: string | null;
  setupPrice: number | null;
  unitPrice: number | null;
  transportPrice: number | null;
}

// The Tidsenhet words parseRoutingTimeUnit reads.
const TIME_UNIT_WORDS = {
  minutes_per_unit: "minuter/enhet",
  units_per_hour: "antal/timme",
  seconds_per_unit: "sekunder/enhet",
} as const;

// The times in the operation's own display unit, so the import keeps the
// unit: st/h has Ställtid in HOURS and Stycktid as units per hour, sek/st
// has both in seconds (convertRoutingTimes/convertCycleTime, inverted). A
// run time of 0 has no st/h value and is written in minutes.
export function routingTimeCells(r: Pick<RoutingExportRecord, "setupTime" | "runTimePerUnit" | "cycleTimePerUnit" | "timeUnit">): {
  setupTime: number;
  runTimePerUnit: number;
  cycleTimePerUnit: number | null;
  timeUnit: string;
} {
  if (r.timeUnit === "units_per_hour" && r.runTimePerUnit > 0) {
    return {
      setupTime: invertRounded(r.setupTime, (hours) => round2(hours * 60), r.setupTime / 60),
      runTimePerUnit: invertRounded(r.runTimePerUnit, unitsPerHourToMinutesPerUnit, 60 / r.runTimePerUnit),
      cycleTimePerUnit:
        r.cycleTimePerUnit === null || r.cycleTimePerUnit <= 0
          ? null
          : invertRounded(r.cycleTimePerUnit, unitsPerHourToMinutesPerUnit, 60 / r.cycleTimePerUnit),
      timeUnit: TIME_UNIT_WORDS.units_per_hour,
    };
  }
  if (r.timeUnit === "seconds_per_unit") {
    return {
      setupTime: invertRounded(r.setupTime, (seconds) => round2(seconds / 60), r.setupTime * 60),
      runTimePerUnit: invertRounded(r.runTimePerUnit, (seconds) => round4(seconds / 60), r.runTimePerUnit * 60),
      cycleTimePerUnit:
        r.cycleTimePerUnit === null || r.cycleTimePerUnit <= 0
          ? null
          : invertRounded(r.cycleTimePerUnit, (seconds) => round4(seconds / 60), r.cycleTimePerUnit * 60),
      timeUnit: TIME_UNIT_WORDS.seconds_per_unit,
    };
  }
  return {
    setupTime: r.setupTime,
    runTimePerUnit: r.runTimePerUnit,
    cycleTimePerUnit: r.cycleTimePerUnit === null || r.cycleTimePerUnit <= 0 ? null : r.cycleTimePerUnit,
    timeUnit: TIME_UNIT_WORDS.minutes_per_unit,
  };
}

// One block per article, in sequence order. A lego operation has no times
// (the planner writes 0 and warns about anything else) and is the only kind
// that carries Leverantör and the three prices.
export function routingExportBlocks(records: RoutingExportRecord[]): ImportExportBlock[] {
  return blocksBy(records, (r) => r.articleNumber).map((operations) =>
    operations.map((r) => {
      const times = r.isSubcontract ? null : routingTimeCells(r);
      return {
        articleNumber: r.articleNumber,
        sequenceNo: r.sequenceNo,
        workCenterCode: r.workCenterCode,
        setupTime: times?.setupTime ?? null,
        runTimePerUnit: times?.runTimePerUnit ?? null,
        timeUnit: times?.timeUnit ?? null,
        costingOnly: yesNo(r.costingOnly),
        comment: r.comment,
        description: r.description,
        packingInstructions: r.packingInstructions,
        subcontractSupplierNumber: r.isSubcontract ? r.subcontractSupplierNumber : null,
        setupPrice: r.isSubcontract ? r.setupPrice : null,
        unitPrice: r.isSubcontract ? r.unitPrice : null,
        transportPrice: r.isSubcontract ? r.transportPrice : null,
        cycleTimePerUnit: times?.cycleTimePerUnit ?? null,
      };
    })
  );
}

// --- structure ---------------------------------------------------------------

export interface BomExportRecord {
  parentNumber: string;
  componentNumber: string;
  /** In the component's base unit, as stored. */
  quantity: number;
  /** The row's display unit when the component still has it, else the base unit. */
  unitCode: string;
  /** The display unit's CURRENT quantity_per_base; null in the base unit. */
  unitFactor: number | null;
  operationSequenceNo: number | null;
  position: string | null;
  costingOnly: boolean;
  componentName: string;
  componentType: ArticleType;
  componentIsPhantom: boolean;
  componentStandardCost: number | null;
}

// Antal is in the row's unit; the planner converts it with the component's
// current factor (toBaseQuantity), so the cell is the quantity that converts
// back to the stored base quantity.
export function bomQuantityCell(quantity: number, unitFactor: number | null): number {
  if (unitFactor === null) return quantity;
  return invertRounded(quantity, (cell) => toBaseQuantity(cell, unitFactor), quantity * unitFactor);
}

// One block per parent, the rows in the structure's own order (the import
// matches a repeated component row by row in that order).
export function bomExportBlocks(records: BomExportRecord[]): ImportExportBlock[] {
  return blocksBy(records, (r) => r.parentNumber).map((rows) =>
    rows.map((r) => ({
      articleNumber: r.parentNumber,
      componentNumber: r.componentNumber,
      quantity: bomQuantityCell(r.quantity, r.unitFactor),
      unitCode: r.unitCode,
      operationSequenceNo: r.operationSequenceNo,
      position: r.position,
      costingOnly: yesNo(r.costingOnly),
      // Read only by Skapa saknade artiklar, for a component the register
      // lacks — what another installation needs to create it.
      componentName: r.componentName,
      componentType: articleTypeCell(r.componentType, r.componentIsPhantom),
      componentStandardCost: r.componentStandardCost,
    }))
  );
}

// --- purchase prices ---------------------------------------------------------

export interface SupplierPriceExportRecord {
  articleNumber: string;
  supplierNumber: string;
  supplierArticleNumber: string | null;
  price: number | null;
  isPrimary: boolean;
  leadTimeDays: number | null;
  /** Ascending. */
  breaks: { fromQuantity: number; price: number }[];
}

// The stafflade file's shape: the pair's first row is the catalogue row and
// carries the first step; every further step is a row of its own with the
// key and the step only. Rabatt (%) stays empty — the stored price is the
// net price. One block per article, so a pair's steps are never split.
export function supplierPriceExportBlocks(records: SupplierPriceExportRecord[]): ImportExportBlock[] {
  return blocksBy(records, (r) => r.articleNumber).map((pairs) =>
    pairs.flatMap((r) => {
      const [first, ...rest] = r.breaks;
      return [
        {
          articleNumber: r.articleNumber,
          supplierNumber: r.supplierNumber,
          supplierArticleNumber: r.supplierArticleNumber,
          price: r.price,
          isPrimary: yesNo(r.isPrimary),
          leadTimeDays: r.leadTimeDays,
          breakQuantity: first?.fromQuantity ?? null,
          breakPrice: first?.price ?? null,
        },
        ...rest.map((step) => ({
          articleNumber: r.articleNumber,
          supplierNumber: r.supplierNumber,
          breakQuantity: step.fromQuantity,
          breakPrice: step.price,
        })),
      ];
    })
  );
}

// --- customer prices ---------------------------------------------------------

export interface CustomerPriceExportRecord {
  articleNumber: string;
  customerNumber: string;
  customerArticleNumber: string | null;
  /** The pair's article rules with a price (a rule with only a discount is not an import value). */
  rules: { fromQuantity: number; unitPrice: number; setupPrice: number | null }[];
}

// The planner's reading, inverted: the rule at antal 1 is Pris, the rules
// above it are steps (the first on the pair's first row, the rest on rows of
// their own). A pair with steps but no rule at antal 1 leaves Pris EMPTY
// (untouched — a 0 there means "remove the antal-1 rule", with a warning),
// and a rule at antal 1 priced 0 beside steps is written as the step at
// Gränsvärde 1, which the planner reads as the price at antal 1 (a Pris 0
// would remove it). Ställpris is written when every rule of the pair has the
// same one — the planner puts the cell on all of them; rules that differ
// keep theirs through an empty cell.
export function customerPriceExportBlocks(records: CustomerPriceExportRecord[]): ImportExportBlock[] {
  return blocksBy(records, (r) => r.articleNumber).map((pairs) =>
    pairs.flatMap((r): ImportExportCells[] => {
      const base = r.rules.find((rule) => rule.fromQuantity === 1) ?? null;
      const steps = r.rules.filter((rule) => rule.fromQuantity > 1).sort((a, b) => a.fromQuantity - b.fromQuantity);
      const priced = base ? [base, ...steps] : steps;
      if (priced.length === 0 && r.customerArticleNumber === null) return [];
      const setup = priced[0]?.setupPrice ?? null;
      const setupPrice = setup !== null && priced.every((rule) => rule.setupPrice === setup) ? setup : null;
      const key = { articleNumber: r.articleNumber, customerNumber: r.customerNumber };
      const stepCells = (rule: { fromQuantity: number; unitPrice: number }) => ({
        breakQuantity: rule.fromQuantity,
        breakPrice: rule.unitPrice,
      });
      const baseAsStep = base !== null && base.unitPrice === 0 && steps.length > 0;
      const rest = baseAsStep ? [base, ...steps] : steps;
      const [first, ...further] = rest;
      return [
        {
          ...key,
          price: base !== null && !baseAsStep ? base.unitPrice : null,
          customerArticleNumber: r.customerArticleNumber,
          setupPrice,
          ...(first ? stepCells(first) : {}),
        },
        ...further.map((rule) => ({ ...key, ...stepCells(rule) })),
      ];
    })
  );
}

// --- stock balances ----------------------------------------------------------

export interface StockBalanceExportRecord {
  articleNumber: string;
  warehouseName: string;
  locationName: string;
  quantity: number;
}

// Antal is the balance after the import, per article and place — today's
// balance, so the import finds nothing to book. À-pris stays empty: it only
// values an increase, and there is none.
export function stockBalanceExportBlocks(records: StockBalanceExportRecord[]): ImportExportBlock[] {
  return blocksBy(records, (r) => r.articleNumber).map((rows) =>
    rows.map((r) => ({
      articleNumber: r.articleNumber,
      warehouseName: r.warehouseName,
      locationName: r.locationName,
      quantity: r.quantity,
    }))
  );
}

// --- partners ----------------------------------------------------------------

export interface RegisterRow {
  id: string;
  code: string;
  name: string;
}

// The cell that names a register row (betalningsvillkor, leveransvillkor,
// speditör, prislista): the importer resolves the cell against the lowercased
// code AND name of every row. The name is preferred — it is what the
// template shows, and what another installation creates the row from — and
// the code is used when the name is not unique among those keys.
export function registerCellTexts(rows: RegisterRow[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const key of [row.code.toLowerCase(), row.name.toLowerCase()]) {
      const set = owners.get(key) ?? new Set<string>();
      set.add(row.id);
      owners.set(key, set);
    }
  }
  const unique = (text: string) => text.trim() !== "" && owners.get(text.toLowerCase())?.size === 1;
  return new Map(rows.map((row) => [row.id, unique(row.name) || !unique(row.code) ? row.name : row.code]));
}

// A stored address (lines joined with "\n") as the three address columns the
// importers join again: line 1, line 2 and the rest. When the lines would not
// join back to the same text (a blank line, spaces around a line) the whole
// address goes in the first column.
export function addressCells(address: string | null): [string | null, string | null, string | null] {
  if (address === null || address === "") return [null, null, null];
  const lines = address.split("\n");
  const parts = [lines[0] ?? "", lines[1] ?? "", lines.slice(2).join("\n")];
  const joined = parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n");
  if (joined !== address) return [address, null, null];
  return [parts[0] || null, parts[1] || null, parts[2] || null];
}

const LANGUAGE_WORDS: Record<string, string> = { sv: "Svenska", en: "Engelska" };

export interface CustomerExportRecord {
  customerNumber: string;
  name: string;
  orgNumber: string | null;
  vatNumber: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  paymentTerm: string | null;
  deliveryTerm: string | null;
  carrier: string | null;
  priceList: string | null;
  discountPercent: number;
  invoiceName: string | null;
  invoiceAddress: string | null;
  invoicePostalCode: string | null;
  invoiceCity: string | null;
  invoiceCountry: string | null;
  invoiceEmail: string | null;
  ourSupplierNumber: string | null;
  collectiveInvoicing: boolean;
  invoiceOnHold: boolean;
  privatePerson: boolean;
  website: string | null;
  currency: string;
  language: string;
}

export function customerExportBlocks(records: CustomerExportRecord[]): ImportExportBlock[] {
  return records.map((r) => {
    const [address, address2, address3] = addressCells(r.address);
    const [invoiceAddress, invoiceAddress2, invoiceAddress3] = addressCells(r.invoiceAddress);
    const hasInvoiceAddress = [r.invoiceName, r.invoiceAddress, r.invoicePostalCode, r.invoiceCity, r.invoiceCountry].some(
      (value) => value !== null && value !== ""
    );
    return [
      {
        customerNumber: r.customerNumber,
        name: r.name,
        // A private person's number is shown as Personnummer on the card;
        // the importer puts that column in the same field.
        orgNumber: r.privatePerson ? null : r.orgNumber,
        personalNumber: r.privatePerson ? r.orgNumber : null,
        vatNumber: r.vatNumber,
        contactName: r.contactName,
        email: r.email,
        phone: r.phone,
        address,
        address2,
        address3,
        postalCode: r.postalCode,
        city: r.city,
        country: r.country,
        paymentTerm: r.paymentTerm,
        deliveryTerm: r.deliveryTerm,
        carrier: r.carrier,
        priceList: r.priceList,
        discountPercent: r.discountPercent,
        // Not stored: Ja when the customer has an invoice address of its own.
        invoiceAddressDiffers: yesNo(hasInvoiceAddress),
        invoiceName: r.invoiceName,
        invoiceAddress,
        invoiceAddress2,
        invoiceAddress3,
        invoicePostalCode: r.invoicePostalCode,
        invoiceCity: r.invoiceCity,
        invoiceCountry: r.invoiceCountry,
        invoiceEmail: r.invoiceEmail,
        ourSupplierNumber: r.ourSupplierNumber,
        collectiveInvoicing: yesNo(r.collectiveInvoicing),
        invoiceOnHold: yesNo(r.invoiceOnHold),
        privatePerson: yesNo(r.privatePerson),
        website: r.website,
        currency: r.currency,
        language: LANGUAGE_WORDS[r.language] ?? r.language,
      },
    ];
  });
}

export interface SupplierExportRecord {
  supplierNumber: string;
  name: string;
  orgNumber: string | null;
  vatNumber: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  currency: string;
  language: string;
  ourCustomerNumber: string | null;
  paymentTerm: string | null;
  deliveryTerm: string | null;
  carrier: string | null;
  carrierCustomerNumber: string | null;
}

export function supplierExportBlocks(records: SupplierExportRecord[]): ImportExportBlock[] {
  return records.map((r) => {
    const [address, address2, address3] = addressCells(r.address);
    return [
      {
        supplierNumber: r.supplierNumber,
        name: r.name,
        orgNumber: r.orgNumber,
        vatNumber: r.vatNumber,
        contactName: r.contactName,
        email: r.email,
        phone: r.phone,
        address,
        address2,
        address3,
        postalCode: r.postalCode,
        city: r.city,
        country: r.country,
        currency: r.currency,
        language: LANGUAGE_WORDS[r.language] ?? r.language,
        ourCustomerNumber: r.ourCustomerNumber,
        paymentTerm: r.paymentTerm,
        deliveryTerm: r.deliveryTerm,
        carrier: r.carrier,
        carrierCustomerNumber: r.carrierCustomerNumber,
      },
    ];
  });
}

export interface ContactExportRecord {
  /** The customer or supplier number. */
  partnerNumber: string;
  name: string;
  isPrimary: boolean;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  comment: string | null;
}

// Faxnummer stays empty: the importer writes it into the comment
// ("… · Fax 08-…"), which is exported as the comment it is.
export function contactExportBlocks(records: ContactExportRecord[], numberField: "customerNumber" | "supplierNumber"): ImportExportBlock[] {
  return blocksBy(records, (r) => r.partnerNumber).map((contacts) =>
    contacts.map((r) => ({
      [numberField]: r.partnerNumber,
      name: r.name,
      isPrimary: yesNo(r.isPrimary),
      phone: r.phone,
      mobile: r.mobile,
      email: r.email,
      comment: r.comment,
    }))
  );
}

export interface DeliveryAddressExportRecord {
  partnerNumber: string;
  label: string;
  address: string;
  postalCode: string | null;
  city: string | null;
  /** Customers only. */
  country?: string;
  isDefault?: boolean;
}

export function deliveryAddressExportBlocks(
  records: DeliveryAddressExportRecord[],
  numberField: "customerNumber" | "supplierNumber"
): ImportExportBlock[] {
  return blocksBy(records, (r) => r.partnerNumber).map((addresses) =>
    addresses.map((r) => {
      const [address, address2, address3] = addressCells(r.address);
      return {
        [numberField]: r.partnerNumber,
        label: r.label,
        address,
        address2,
        address3,
        postalCode: r.postalCode,
        city: r.city,
        ...(numberField === "customerNumber" ? { country: r.country ?? null, isDefault: yesNo(r.isDefault === true) } : {}),
      };
    })
  );
}

// --- resources ---------------------------------------------------------------

export interface WorkCenterExportRecord {
  code: string;
  name: string;
  type: "machine" | "personnel";
  productionGroupCode: string | null;
  productionGroupName: string | null;
  hourlyRate: number;
  calcRate1: number | null;
  calcRate2: number | null;
  rateAppliesToSetup: boolean | null;
  rateAppliesToRun: boolean | null;
  defaultSetupTime: number | null;
  defaultOperationName: string | null;
}

export function workCenterExportBlocks(records: WorkCenterExportRecord[]): ImportExportBlock[] {
  return records.map((r) => [
    {
      code: r.code,
      name: r.name,
      // parseWorkCenterType's words.
      type: r.type === "machine" ? "Maskin" : "Personal",
      productionGroupCode: r.productionGroupCode,
      productionGroupName: r.productionGroupCode !== null ? r.productionGroupName : null,
      hourlyRate: r.hourlyRate,
      calcRate1: r.calcRate1,
      calcRate2: r.calcRate2,
      rateAppliesToSetup: r.rateAppliesToSetup === null ? null : yesNo(r.rateAppliesToSetup),
      rateAppliesToRun: r.rateAppliesToRun === null ? null : yesNo(r.rateAppliesToRun),
      defaultSetupTime: r.defaultSetupTime,
      defaultOperationName: r.defaultOperationName,
      // The one cost row the importer takes.
      costRowName: "Ordinarie",
    },
  ]);
}

export interface LegoWorkCenterExportRecord {
  code: string;
  name: string;
  supplierNumber: string | null;
  leadTimeDays: number | null;
  queueTimeDays: number | null;
  orderLeadTimeDays: number | null;
}

export function legoWorkCenterExportBlocks(records: LegoWorkCenterExportRecord[]): ImportExportBlock[] {
  return records.map((r) => [{ ...r }]);
}

export interface ProductionGroupExportRecord {
  code: string;
  name: string;
  description: string | null;
}

export function productionGroupExportBlocks(records: ProductionGroupExportRecord[]): ImportExportBlock[] {
  return records.map((r) => [{ ...r }]);
}

// Consecutive records with the same key as one block (the readers sort by
// that key first).
function blocksBy<T>(records: T[], key: (record: T) => string): T[][] {
  const blocks: T[][] = [];
  let current: T[] = [];
  let currentKey: string | null = null;
  for (const record of records) {
    const k = key(record);
    if (currentKey !== null && k !== currentKey) {
      blocks.push(current);
      current = [];
    }
    current.push(record);
    currentKey = k;
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

// --- columns, parts and files --------------------------------------------------

// The table of one file: the entity's template columns in template order
// (IMPORT_FIELD_HELP). A number in a column the template formats as Text
// (Sekvensnr, Rabatt (%) …) is written as that text; any other number is a
// "decimal" cell — every decimal, decimal comma in the CSV. A cell the row
// builder left out is empty.
export function importExportColumns(entity: ImportEntity): { columns: CsvColumn<ImportExportCells>[]; textColumns: number[] } {
  const fields = IMPORT_FIELD_HELP[entity];
  const columns = fields.map((f): CsvColumn<ImportExportCells> => {
    if (f.text) {
      return {
        label: f.header,
        format: "text",
        value: (row) => {
          const value = row[f.field];
          return typeof value === "number" ? plainDecimal(value).replace(".", ",") : value;
        },
      };
    }
    return {
      label: f.header,
      value: (row) => row[f.field],
      format: NUMERIC_FIELDS[entity].has(f.field) ? "decimal" : "text",
    };
  });
  return { columns, textColumns: fields.flatMap((f, i) => (f.text ? [i] : [])) };
}

// The fields whose cells are numbers. A field named here must exist in the
// entity's field help (import-export.test.ts).
export const NUMERIC_FIELDS: Record<ImportEntity, ReadonlySet<string>> = {
  articles: new Set([
    "standardCost",
    "weight",
    "reorderPoint",
    "orderQuantity",
    "rounding",
    "safetyStock",
    "leadTimeDays",
    "quantityPerPackage",
  ]),
  articleUnits: new Set(["factor"]),
  routing: new Set(["sequenceNo", "setupTime", "runTimePerUnit", "setupPrice", "unitPrice", "transportPrice", "cycleTimePerUnit"]),
  bom: new Set(["quantity", "operationSequenceNo", "componentStandardCost"]),
  supplierPrices: new Set(["price", "discountPercent", "leadTimeDays", "breakQuantity", "breakPrice"]),
  customerPrices: new Set(["price", "discountPercent", "setupPrice", "breakQuantity", "breakPrice"]),
  stockBalances: new Set(["quantity", "unitCost"]),
  customers: new Set(["discountPercent"]),
  customerContacts: new Set(),
  customerDeliveryAddresses: new Set(),
  suppliers: new Set(),
  supplierContacts: new Set(),
  supplierDeliveryAddresses: new Set(),
  workCenters: new Set(["hourlyRate", "calcRate1", "calcRate2", "defaultSetupTime"]),
  legoWorkCenters: new Set(["leadTimeDays", "queueTimeDays", "orderLeadTimeDays"]),
  productionGroups: new Set(),
};

// Blocks packed into files of at most maxRows rows, never splitting a block:
// a block goes to the next file when it does not fit. A block larger than
// the limit gets a file of its own (the import refuses it — it could not
// read the set whole either way).
export function splitImportExportBlocks(blocks: ImportExportBlock[], maxRows: number): ImportExportCells[][] {
  const parts: ImportExportCells[][] = [];
  let current: ImportExportCells[] = [];
  for (const block of blocks) {
    if (block.length === 0) continue;
    if (current.length > 0 && current.length + block.length > maxRows) {
      parts.push(current);
      current = [];
    }
    current = current.concat(block);
  }
  if (current.length > 0 || parts.length === 0) parts.push(current);
  return parts;
}

// "importmall-artiklar.xlsx" -> "artiklar": the export is named after the
// template it follows.
export function importExportBasename(entity: ImportEntity, date: string): string {
  const name = importTemplateInfo(entity).fileName.replace(/^importmall-/, "").replace(/\.xlsx$/, "");
  return `export-${name}-${date}`;
}

export interface ImportExportFile {
  filename: string;
  content: string | Buffer;
  contentType: string;
  /** Rows in the whole export and the number of files it came as. */
  rowCount: number;
  partCount: number;
}

export const ZIP_CONTENT_TYPE = "application/zip";

export function importExportTable(entity: ImportEntity, rows: ImportExportCells[]): { table: ExportTable; textColumns: number[] } {
  const { columns, textColumns } = importExportColumns(entity);
  return { table: exportTable(columns, rows), textColumns };
}

// One file when the rows fit, otherwise a .zip of "…-del-1", "…-del-2" …,
// each a complete import file with the heading row. The Excel file's sheet
// is named Import, like the template's.
export function renderImportExport(
  entity: ImportEntity,
  blocks: ImportExportBlock[],
  format: ImportExportFormat,
  date: string,
  maxRows: number = IMPORT_EXPORT_MAX_ROWS
): ImportExportFile {
  const parts = splitImportExportBlocks(blocks, maxRows);
  const basename = importExportBasename(entity, date);
  const rowCount = parts.reduce((sum, part) => sum + part.length, 0);
  const render = (rows: ImportExportCells[]): string | Buffer => {
    const { table, textColumns } = importExportTable(entity, rows);
    return format === "xlsx" ? tableXlsx(table, "Import", textColumns) : tableCsv(table);
  };
  if (parts.length === 1) {
    return {
      filename: `${basename}.${format}`,
      content: render(parts[0]!),
      contentType: format === "xlsx" ? XLSX_CONTENT_TYPE : CSV_CONTENT_TYPE,
      rowCount,
      partCount: 1,
    };
  }
  const entries = parts.map((rows, index) => {
    const content = render(rows);
    return {
      name: `${basename}-del-${index + 1}.${format}`,
      data: typeof content === "string" ? Buffer.from(content, "utf8") : content,
    };
  });
  return { filename: `${basename}.zip`, content: buildStoredZip(entries), contentType: ZIP_CONTENT_TYPE, rowCount, partCount: parts.length };
}
