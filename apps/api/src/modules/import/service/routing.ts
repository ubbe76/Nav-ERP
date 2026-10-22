// Routing import (operationer — TODO2 #15). Sibling of articles.ts /
// customers.ts / suppliers.ts: the entity-specific planner lives here and
// builds on the shared machinery in import.service.ts; all database work
// lives in import.repository.ts.
//
// Unlike the three partner imports this one is CREATE-ONLY by default. A
// routing row that already exists is a row error, not an update: the file is
// a migration of Monitor's routing, and silently rewriting an operation
// someone has already reported time against would be worse than refusing.
// With input.skipExisting the row becomes a SKIP instead. With
// input.updateExisting (opt-in, mutually exclusive with skipExisting) the
// existing operation IS rewritten — resource, times, time unit, Kalkyl and
// whichever text fields the file fills in — which is how a routing imported
// with the wrong time unit gets repaired by re-running the file. Released
// orders are unaffected either way: their mo_operations snapshot is never
// touched, same rule as PATCH on the article card.
import type { ImportCommitInput } from "@navet/shared";
import { unitsPerHourToMinutesPerUnit } from "@navet/shared";
import { normalizeDecimal } from "./csv.js";
import type { ExistingArticle } from "./articles.js";
import { padWorkCenterCode } from "./work-centers.js";
import {
  ImportMappingError,
  normalizeHeader,
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them.
export const ROUTING_IMPORT_FIELDS = [
  "articleNumber",
  "sequenceNo",
  "workCenterCode",
  "setupTime",
  "runTimePerUnit",
  "timeUnit",
  "costingOnly",
  "comment",
  "description",
  "packingInstructions",
] as const;
export type RoutingImportField = (typeof ROUTING_IMPORT_FIELDS)[number];

// setup_time and run_time_per_unit are NOT NULL without a default, and
// createRoutingOperationSchema demands both. Defaulting an unmapped column to
// 0 would quietly wreck the pre-calculation across thousands of articles, so
// the columns are required and the user writes 0 where a step has no setup.
const REQUIRED_FIELDS: RoutingImportField[] = [
  "articleNumber",
  "sequenceNo",
  "workCenterCode",
  "setupTime",
  "runTimePerUnit",
];

// work_centers.code is varchar(3) with a check constraint of exactly three
// digits (packages/db/src/schema/manufacturing.ts).
const WORK_CENTER_CODE_PATTERN = /^[0-9]{3}$/;

// Normalized header -> target field (see import.service.ts's normalizeHeader:
// "Tid/enhet" -> "tidenhet", "Ställtid" -> "stalltid").
export const ROUTING_HEADER_ALIASES: Record<string, string> = {
  artikelnummer: "articleNumber",
  artikelnr: "articleNumber",
  artnr: "articleNumber",
  sekvensnr: "sequenceNo",
  sekvensnummer: "sequenceNo",
  sekvens: "sequenceNo",
  operation: "sequenceNo",
  operationsnr: "sequenceNo",
  operationsnummer: "sequenceNo",
  opnr: "sequenceNo",
  // Monitor G5's Operationslista heads the column "Op." — normalizeHeader
  // strips the period, so the alias is the bare "op".
  op: "sequenceNo",
  ordningsnr: "sequenceNo",
  ordningsnummer: "sequenceNo",
  resurs: "workCenterCode",
  resursnr: "workCenterCode",
  resursnummer: "workCenterCode",
  resurskod: "workCenterCode",
  // Monitor calls the resource a production group, both in the Operationslista
  // ("Produktionsgrupp") and in the Materiallista ("Pgrp").
  produktionsgrupp: "workCenterCode",
  prodgrupp: "workCenterCode",
  maskin: "workCenterCode",
  maskinnr: "workCenterCode",
  maskinnummer: "workCenterCode",
  arbetsplats: "workCenterCode",
  arbetscentrum: "workCenterCode",
  stalltid: "setupTime",
  stalltidmin: "setupTime",
  stalltidminuter: "setupTime",
  riggtid: "setupTime",
  rigg: "setupTime",
  setuptid: "setupTime",
  tidenhet: "runTimePerUnit",
  tidperenhet: "runTimePerUnit",
  enhetstid: "runTimePerUnit",
  styckstid: "runTimePerUnit",
  stycktid: "runTimePerUnit",
  cykeltid: "runTimePerUnit",
  maskintid: "runTimePerUnit",
  // Monitor G5's Operationslista heads the time-unit column "Enhet" —
  // "antal/timme" there means Stycktid is pieces per hour and Ställtid is
  // in HOURS. See parseRoutingTimeUnit/convertRoutingTimes below.
  enhet: "timeUnit",
  tidsenhet: "timeUnit",
  kalkyl: "costingOnly",
  kalkyloperation: "costingOnly",
  kalkylrad: "costingOnly",
  endastkalkyl: "costingOnly",
  // "Kommentar" on the operation. Monitor G5 heads the column "Instruktion".
  instruktion: "comment",
  kommentar: "comment",
  anteckning: "comment",
  // "Beskrivning" — the operation's NAME, Monitor's "Operationens benämning".
  // `beskrivning` briefly pointed at comment (TODO2 #18) and moved here when
  // the field it actually names arrived. Bare `benamning` is deliberately
  // absent: in a file whose article column is headed something other than
  // "Artikelbenämning" it would be a guess, and the user maps it by hand.
  operationensbenamning: "description",
  operationsbenamning: "description",
  operationsbeskrivning: "description",
  beskrivning: "description",
  // "Packinstruktion" on the operation — same field as the article card's
  // Beredning-flik.
  packinstruktion: "packingInstructions",
  packinstruktioner: "packingInstructions",
  packning: "packingInstructions",
};

export function suggestRoutingMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, ROUTING_HEADER_ALIASES);
}

// Deliberately NOT reusing articles.ts's parseActive: the article import's
// accepted vocabulary is a shipped contract and must not be widened by a
// side effect of this one.
function parseCostingOnly(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (["ja", "j", "1", "true", "sant", "x"].includes(value)) return true;
  if (["nej", "n", "0", "false", "falskt"].includes(value)) return false;
  return null;
}

// The time unit a file's Ställtid/Stycktid columns are expressed in. Storage
// is ALWAYS minutes per unit (operation_time_unit is a display preference,
// see packages/db/src/schema/manufacturing.ts), so the planner converts here,
// once. Monitor G5's vocabulary plus the obvious Swedish/English spellings;
// the cell is normalized like a header ("antal/timme" → "antaltimme").
export type RoutingFileTimeUnit = "minutes_per_unit" | "units_per_hour" | "hours_per_unit" | "seconds_per_unit";

const TIME_UNIT_VOCABULARY: Record<string, RoutingFileTimeUnit> = {
  // Monitor: "antal/timme" — pieces per hour; setup time in hours.
  antaltimme: "units_per_hour",
  antalpertimme: "units_per_hour",
  antalh: "units_per_hour",
  sttim: "units_per_hour",
  sth: "units_per_hour",
  stpertimme: "units_per_hour",
  stycktimme: "units_per_hour",
  styckpertimme: "units_per_hour",
  enhetertimme: "units_per_hour",
  unitsperhour: "units_per_hour",
  // Minutes per unit — today's (and the unmapped column's) meaning.
  minuterenhet: "minutes_per_unit",
  minutenhet: "minutes_per_unit",
  minst: "minutes_per_unit",
  minperst: "minutes_per_unit",
  min: "minutes_per_unit",
  minuter: "minutes_per_unit",
  minutes: "minutes_per_unit",
  minutesperunit: "minutes_per_unit",
  // Hours per unit.
  timmarenhet: "hours_per_unit",
  timenhet: "hours_per_unit",
  timst: "hours_per_unit",
  timmarperst: "hours_per_unit",
  tim: "hours_per_unit",
  timmar: "hours_per_unit",
  h: "hours_per_unit",
  hours: "hours_per_unit",
  hoursperunit: "hours_per_unit",
  // Seconds per unit.
  sekunderenhet: "seconds_per_unit",
  sekenhet: "seconds_per_unit",
  sekst: "seconds_per_unit",
  sek: "seconds_per_unit",
  sekunder: "seconds_per_unit",
  s: "seconds_per_unit",
  seconds: "seconds_per_unit",
  secondsperunit: "seconds_per_unit",
};

export function parseRoutingTimeUnit(raw: string): RoutingFileTimeUnit | null {
  return TIME_UNIT_VOCABULARY[normalizeHeader(raw)] ?? null;
}

// Ställtid/Stycktid from the file → the stored minutes plus the display unit
// the operation is saved with. Setup time keeps 2 decimals, run time 4 (the
// column scales). "antal/timme" with Stycktid 0 cannot be expressed as st/h
// (0 units per hour has no meaning — the same rule the operation dialog
// enforces), so it lands as 0 min/st with a warning instead of an error: the
// row is still a valid operation, it just has no run time.
export function convertRoutingTimes(
  unit: RoutingFileTimeUnit,
  setup: number,
  run: number
): { setupTime: number; runTimePerUnit: number; timeUnit: "minutes_per_unit" | "units_per_hour"; warning?: string } {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  switch (unit) {
    case "minutes_per_unit":
      return { setupTime: round2(setup), runTimePerUnit: round4(run), timeUnit: "minutes_per_unit" };
    case "hours_per_unit":
      return { setupTime: round2(setup * 60), runTimePerUnit: round4(run * 60), timeUnit: "minutes_per_unit" };
    case "seconds_per_unit":
      return { setupTime: round2(setup / 60), runTimePerUnit: round4(run / 60), timeUnit: "minutes_per_unit" };
    case "units_per_hour":
      if (run > 0) {
        return { setupTime: round2(setup * 60), runTimePerUnit: unitsPerHourToMinutesPerUnit(run), timeUnit: "units_per_hour" };
      }
      return {
        setupTime: round2(setup * 60),
        runTimePerUnit: 0,
        timeUnit: "minutes_per_unit",
        warning: "Stycktid 0 kan inte uttryckas i st/h — sparas som 0 min/st",
      };
  }
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests. `type` on the work
// centre is what tells a legoresurs apart — lego operations carry no times.
export interface RoutingImportDeps {
  articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>>;
  workCentersByCode(): Promise<Map<string, { id: string; code: string; type?: string }>>;
  routingOperationsByArticle(
    articleIds: string[]
  ): Promise<Map<string, Map<number, { id: string; costingOnly: boolean }>>>;
}

export interface RoutingCreatePlan {
  articleId: string;
  sequenceNo: number;
  workCenterId: string;
  /** Minutes, as on the article card's Beredning tab. */
  setupTime: number;
  /** Minutes per unit. */
  runTimePerUnit: number;
  /** Display preference saved with the operation (see convertRoutingTimes). */
  timeUnit: "minutes_per_unit" | "units_per_hour";
  costingOnly: boolean;
  /** "Kommentar" — Monitor's "Instruktion". Null when the cell is empty. */
  comment: string | null;
  /** From the wizard's file-level checkbox — the file itself has no column. */
  printOnWorkCard: boolean;
  /** "Beskrivning" — Monitor's "Operationens benämning". Null when empty. */
  description: string | null;
  /** "Packinstruktion" — same field as the article card's Beredning-flik. Null when empty. */
  packingInstructions: string | null;
}

// An existing operation rewritten under input.updateExisting. The required
// columns (resource, times, unit) and Kalkyl are always set; the text fields
// only when the file's cell is non-empty — an empty cell never blanks a
// stored value (same rule as the article import). printOnWorkCard follows
// the comment: a row without one leaves the stored flag alone.
export interface RoutingUpdatePlan {
  id: string;
  patch: {
    workCenterId: string;
    setupTime: number;
    runTimePerUnit: number;
    timeUnit: "minutes_per_unit" | "units_per_hour";
    costingOnly: boolean;
    comment?: string;
    printOnWorkCard?: boolean;
    description?: string;
    packingInstructions?: string;
  };
}

export interface RoutingImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Always empty — this import creates nothing in any register. The shape is
  // shared with the article import's preview/commit response.
  willCreate: { units: string[]; articleGroups: string[] };
  creates: RoutingCreatePlan[];
  updates: RoutingUpdatePlan[];
  hasErrors: boolean;
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch.
export async function planRoutingImport(
  input: ImportCommitInput,
  deps: RoutingImportDeps
): Promise<RoutingImportPlan> {
  // Not a per-row error: the two options contradict each other for EVERY
  // existing row, so the wizard's combination is refused up front (400).
  if (input.skipExisting && input.updateExisting) {
    throw new ImportMappingError(
      "Välj antingen Hoppa över rader som redan finns eller Uppdatera befintliga operationer, inte båda"
    );
  }
  const columns = resolveColumns(input.mapping, [...ROUTING_IMPORT_FIELDS], REQUIRED_FIELDS);

  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const numbers = records.map((r) => r["articleNumber"] ?? "").filter((n) => n !== "");
  const articlesByNumber = await deps.articlesByNumber(numbers);
  const workCenters = await deps.workCentersByCode();
  const existingOperations = await deps.routingOperationsByArticle([...articlesByNumber.values()].map((a) => a.id));

  const rows: ImportRowResult[] = [];
  const creates: RoutingCreatePlan[] = [];
  const updates: RoutingUpdatePlan[] = [];
  // "<articleId>#<sequenceNo>" for every row that named both — recorded even
  // for failed rows, so a triplicate blames rows 2 AND 3.
  const seen = new Set<string>();

  records.forEach((record, index) => {
    // 1-based data rows, +1 for the header line — matches what the user sees
    // when the file is open in Excel.
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const articleNumber = record["articleNumber"] ?? "";
    values["articleNumber"] = articleNumber;
    const article = articlesByNumber.get(articleNumber);
    if (articleNumber === "") {
      errors.push("Artikelnummer saknas");
    } else if (!article) {
      errors.push(`Artikeln ${articleNumber} finns inte i artikelregistret`);
    } else if (article.type !== "manufactured") {
      warnings.push(`Artikeln ${articleNumber} är inte tillverkad — operationen används inte vid tillverkning`);
    }

    const rawSequence = record["sequenceNo"] ?? "";
    values["sequenceNo"] = rawSequence;
    let sequenceNo: number | null = null;
    if (rawSequence === "") {
      errors.push("Sekvensnr saknas");
    } else {
      const parsed = normalizeDecimal(rawSequence);
      if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) {
        errors.push(`Ogiltigt sekvensnr: "${rawSequence}" (ange ett heltal större än 0)`);
      } else {
        sequenceNo = parsed;
      }
    }

    // Set when the row rewrites an existing operation (input.updateExisting).
    let existingOperationId: string | null = null;
    if (article && sequenceNo !== null) {
      const key = `${article.id}#${sequenceNo}`;
      const existingOperation = existingOperations.get(article.id)?.get(sequenceNo);
      if (existingOperation) {
        if (input.skipExisting) {
          // Short-circuit: nothing is written for this row, so the remaining
          // cells (resurs, tider, Kalkyl) are not validated — a bad cell on a
          // row we are not importing must not block the file. `seen` is still
          // recorded, but the in-file duplicate stays silent here: with the
          // operation already on the article, BOTH rows are skipped and no
          // conflict is possible.
          seen.add(key);
          rows.push(
            skippedRow(rowNumber, `Operation ${sequenceNo} finns redan på artikel ${articleNumber}`, {
              ...record,
            })
          );
          return;
        }
        if (input.updateExisting) {
          existingOperationId = existingOperation.id;
        } else {
          errors.push(`Operation ${sequenceNo} finns redan på artikel ${articleNumber} — ta bort raden ur filen`);
        }
      }
      if (seen.has(key)) {
        errors.push(`Operation ${sequenceNo} för artikel ${articleNumber} förekommer flera gånger i filen`);
      }
      seen.add(key);
    }

    const rawCode = record["workCenterCode"] ?? "";
    values["workCenterCode"] = rawCode;
    let workCenterId: string | null = null;
    let isSubcontract = false;
    if (rawCode === "") {
      errors.push("Resurs saknas");
    } else {
      // 7 from an unformatted Excel column is 007 (padWorkCenterCode).
      const code = padWorkCenterCode(rawCode);
      if (!WORK_CENTER_CODE_PATTERN.test(code)) {
        errors.push(`Ogiltig resurskod: "${rawCode}" (ange tre siffror, t.ex. 110)`);
      } else {
        const workCenter = workCenters.get(code);
        if (!workCenter) {
          errors.push(`Resursen ${code} finns inte i resursregistret`);
        } else {
          workCenterId = workCenter.id;
          isSubcontract = workCenter.type === "subcontract";
        }
      }
    }

    const times: Partial<Record<"setupTime" | "runTimePerUnit", number>> = {};
    const timeLabels = { setupTime: "Ställtid", runTimePerUnit: "Tid per enhet" } as const;
    const negativeMessages = {
      setupTime: "Ställtiden kan inte vara negativ",
      runTimePerUnit: "Tiden per enhet kan inte vara negativ",
    } as const;
    for (const field of ["setupTime", "runTimePerUnit"] as const) {
      const raw = record[field] ?? "";
      values[field] = raw;
      if (raw === "") {
        errors.push(`${timeLabels[field]} saknas`);
        continue;
      }
      const parsed = normalizeDecimal(raw);
      if (parsed === null) errors.push(`Ogiltig ${timeLabels[field].toLowerCase()}: "${raw}"`);
      else if (parsed < 0) errors.push(negativeMessages[field]);
      else times[field] = parsed;
    }

    // Time unit — unmapped/empty means minutes (today's behaviour); a mapped
    // cell must be a known unit, since guessing here would quietly wreck the
    // pre-calculation for the whole file.
    const rawTimeUnit = record["timeUnit"] ?? "";
    values["timeUnit"] = rawTimeUnit;
    let fileTimeUnit: RoutingFileTimeUnit = "minutes_per_unit";
    if (rawTimeUnit !== "") {
      const parsed = parseRoutingTimeUnit(rawTimeUnit);
      if (parsed === null) {
        errors.push(`Okänd tidsenhet: "${rawTimeUnit}" (antal/timme, minuter/enhet, timmar/enhet eller sekunder/enhet)`);
      } else {
        fileTimeUnit = parsed;
      }
    }
    let converted: ReturnType<typeof convertRoutingTimes> | null = null;
    if (times.setupTime !== undefined && times.runTimePerUnit !== undefined) {
      if (isSubcontract) {
        // A lego operation is bought, not timed — the dialog hides the time
        // fields and stores 0/minutes, and the import keeps that invariant.
        converted = { setupTime: 0, runTimePerUnit: 0, timeUnit: "minutes_per_unit" };
        if (times.setupTime !== 0 || times.runTimePerUnit !== 0) {
          warnings.push("Legoresurs — tiderna sätts till 0 (lego-operationer har inga tider)");
        }
      } else {
        converted = convertRoutingTimes(fileTimeUnit, times.setupTime, times.runTimePerUnit);
        if (converted.warning) warnings.push(converted.warning);
      }
    }

    const rawCostingOnly = record["costingOnly"] ?? "";
    values["costingOnly"] = rawCostingOnly;
    let costingOnly = false;
    if (rawCostingOnly !== "") {
      const parsed = parseCostingOnly(rawCostingOnly);
      if (parsed === null) {
        errors.push(`Ogiltigt värde för Kalkyl: "${rawCostingOnly}" (Ja/Nej/1/0/true/false)`);
      } else {
        costingOnly = parsed;
      }
    }

    // Same 1000-character ceiling as createRoutingOperationSchema — a file
    // that overruns it is a row error rather than a silent truncation.
    const rawComment = record["comment"] ?? "";
    values["comment"] = rawComment;
    let comment: string | null = null;
    if (rawComment !== "") {
      if (rawComment.length > 1000) {
        errors.push(`Kommentaren är för lång (${rawComment.length} tecken, max 1000)`);
      } else {
        comment = rawComment;
      }
    }

    // Same 255-character ceiling as createRoutingOperationSchema.
    const rawDescription = record["description"] ?? "";
    values["description"] = rawDescription;
    let description: string | null = null;
    if (rawDescription !== "") {
      if (rawDescription.length > 255) {
        errors.push(`Beskrivningen är för lång (${rawDescription.length} tecken, max 255)`);
      } else {
        description = rawDescription;
      }
    }

    // Same 1000-character ceiling as createRoutingOperationSchema's
    // routingPackingInstructionsSchema — a row error, never a silent
    // truncation (same rule as the comment field).
    const rawPackingInstructions = record["packingInstructions"] ?? "";
    values["packingInstructions"] = rawPackingInstructions;
    let packingInstructions: string | null = null;
    if (rawPackingInstructions !== "") {
      if (rawPackingInstructions.length > 1000) {
        errors.push(`Packinstruktionen är för lång (${rawPackingInstructions.length} tecken, max 1000)`);
      } else {
        packingInstructions = rawPackingInstructions;
      }
    }

    rows.push({ rowNumber, action: existingOperationId ? "update" : "create", errors, warnings, values });

    if (errors.length === 0 && article && sequenceNo !== null && workCenterId !== null && converted !== null) {
      if (existingOperationId) {
        const patch: RoutingUpdatePlan["patch"] = {
          workCenterId,
          setupTime: converted.setupTime,
          runTimePerUnit: converted.runTimePerUnit,
          timeUnit: converted.timeUnit,
          costingOnly,
        };
        if (comment !== null) {
          patch.comment = comment;
          patch.printOnWorkCard = input.printCommentOnWorkCard === true;
        }
        if (description !== null) patch.description = description;
        if (packingInstructions !== null) patch.packingInstructions = packingInstructions;
        updates.push({ id: existingOperationId, patch });
      } else {
        creates.push({
          articleId: article.id,
          sequenceNo,
          workCenterId,
          setupTime: converted.setupTime,
          runTimePerUnit: converted.runTimePerUnit,
          timeUnit: converted.timeUnit,
          costingOnly,
          comment,
          // A row without a comment has nothing to print, so the flag stays off
          // there whatever the checkbox says.
          printOnWorkCard: comment !== null && input.printCommentOnWorkCard === true,
          description,
          packingInstructions,
        });
      }
    }
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: { units: [], articleGroups: [] },
    creates,
    updates,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
