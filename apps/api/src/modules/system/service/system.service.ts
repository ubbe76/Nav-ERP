import { Readable } from "node:stream";
import type {
  CostingMaterialSource,
  CostingSupplierPriceTier,
  CreateArticleNumberSeriesInput,
  CreateCompanyCarrierInput,
  ExtraDescriptionDocument,
  ManufacturingMaterialShortage,
  PalletCardCode,
  UpdateCompanyCarrierInput,
  UpdateCompanyInfoInput,
  UpdateNumberSeriesInput,
  UpdateSystemSettingsInput,
} from "@navet/shared";
import { EXTRA_DESCRIPTION_DOCUMENTS, round2 } from "@navet/shared";
import { randomUUID } from "node:crypto";
import { DEFAULT_ARTICLE_SERIES_KEY } from "./number-series.js";
import type { SystemRepository } from "../repository/system.repository.js";
import { createDatabaseBackup } from "./backup.js";
import { decodeDeliveryDefaults, DELIVERY_SETTING_KEYS, type DeliveryDefaults } from "./delivery-days.js";
import {
  codeSetting,
  decodePostingSettings,
  PAYMENT_TOLERANCE_KEY,
  POSTING_ACCOUNTS_PAYABLE_KEY,
  POSTING_ACCOUNTS_RECEIVABLE_KEY,
  POSTING_BANK_KEY,
  POSTING_DEFAULT_COST_KEY,
  POSTING_PAYMENT_WRITEOFF_KEY,
  POSTING_REMINDER_FEE_ACCOUNT_KEY,
  POSTING_VAT_SETTLEMENT_KEY,
  POSTING_INVENTORY_KEY,
  POSTING_INVENTORY_CHANGE_KEY,
  POSTING_FX_GAIN_KEY,
  POSTING_FX_LOSS_KEY,
  POSTING_BANK_FEES_KEY,
  REMINDER_FEE_KEY,
  LATE_INTEREST_ENABLED_KEY,
  LATE_INTEREST_MARGIN_KEY,
  LATE_INTEREST_MIN_AMOUNT_KEY,
  LATE_FEE_ENABLED_KEY,
  POSTING_LATE_INTEREST_KEY,
  POSTING_LATE_FEE_KEY,
} from "./posting-settings.js";
import { isUniqueViolation } from "./db-errors.js";
import { decodeLongOperationWeeks, PLANNING_LONG_OPERATION_WEEKS_KEY } from "./plan-settings.js";
import {
  ALERT_DIGEST_TIME_KEY,
  ALERT_QUOTE_FOLLOWUP_DAYS_KEY,
  ALERT_SUPPLIER_INVOICE_DAYS_KEY,
  decodeAlertDigestTime,
  decodeAlertQuoteFollowupDays,
  decodeAlertSupplierInvoiceDays,
  decodePublicBaseUrl,
  PUBLIC_BASE_URL_KEY,
} from "./alert-settings.js";
import { decodeQuoteValidityDays, QUOTE_VALIDITY_DAYS_KEY } from "./quote-settings.js";
import { decodeDefaultTheme, DEFAULT_THEME_KEY, THEME_CHOICE_LOCKED_KEY } from "./theme-settings.js";
import { UnknownThemeError } from "./themes.errors.js";
// G1: append-only audit trail. system_settings/company_info are singletons —
// entityId is null (no natural per-row id); number_series/company_carrier
// use their own readable key/code. updateSettings NEVER logs values — only
// the changed key names — and smtp_password is treated exactly like every
// other key here (no special case needed: since only keys are logged, its
// value never even reaches the detail object).
import type { AuditWriter } from "../repository/audit.repository.js";
import type { ExportedFile } from "../repository/file-export.js";
import { safeSegment, UniquePaths, ZipStreamWriter } from "./zip-stream.js";

// Percent settings are stored as plain strings — an absent or unparsable key
// means "no markup" rather than NaN leaking into a calculation.
function percentSetting(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Same fallback as the DB client — the api container sets DATABASE_URL to the
// postgres service host.
const DATABASE_URL_FALLBACK = "postgresql://erp:erp_dev_password@localhost:5432/erp";

const ALLOW_MULTIPLE_STAMPS_KEY = "allow_multiple_stamps";
const SHOW_REVISIONS_ON_DOCUMENTS_KEY = "show_revisions_on_documents";
const SHOW_ORDER_REVISION_ON_DOCUMENTS_KEY = "show_order_revision_on_documents";
const EXTRA_DESCRIPTION_DOCUMENTS_KEY = "extra_description_documents";
const ATF_MINUTES_PER_WEEK_KEY = "atf_minutes_per_week";
const PAYROLL_OVERTIME_THRESHOLD_MINUTES_KEY = "payroll_overtime_threshold_minutes";
const ATTENDANCE_REASON_REQUIRED_KEY = "attendance_reason_required";
const ATTENDANCE_REASON_TOLERANCE_MINUTES_KEY = "attendance_reason_tolerance_minutes";
const TERMINAL_OVERTIME_CHOICE_KEY = "terminal_overtime_choice";
const PAXML_CODE_WORKED_KEY = "paxml_code_worked";
const PAXML_CODE_OVERTIME_KEY = "paxml_code_overtime";
const PAXML_CODE_OVERTIME_OFF_SCHEDULE_KEY = "paxml_code_overtime_off_schedule";
const PAXML_CODE_OVERTIME_COMP_KEY = "paxml_code_overtime_comp";
const PAXML_CODE_OVERTIME_OFF_SCHEDULE_COMP_KEY = "paxml_code_overtime_off_schedule_comp";
const PAXML_CODE_ATF_KEY = "paxml_code_atf";
const SMTP_HOST_KEY = "smtp_host";
const SMTP_PORT_KEY = "smtp_port";
const SMTP_SECURE_KEY = "smtp_secure";
const SMTP_USER_KEY = "smtp_user";
const SMTP_PASSWORD_KEY = "smtp_password";
const SMTP_FROM_NAME_KEY = "smtp_from_name";
const SMTP_FROM_EMAIL_KEY = "smtp_from_email";
const COSTING_MATERIAL_SOURCE_KEY = "costing_material_source";

// system_settings holds free text, so an unknown or absent value has to resolve
// to something. "standard" is the safe default — it is what the calculation did
// before the setting existed.
function decodeMaterialSource(raw: string | null | undefined): CostingMaterialSource {
  return raw === "supplier" || raw === "actual" ? raw : "standard";
}
// Stafflade leverantörspriser in the calculation: "base" keeps the pre-staffel
// behaviour (grundpriset), so an absent setting changes nothing.
const COSTING_SUPPLIER_PRICE_TIER_KEY = "costing_supplier_price_tier";
function decodeSupplierPriceTier(raw: string | null | undefined): CostingSupplierPriceTier {
  return raw === "tiered" ? "tiered" : "base";
}
const COSTING_MO_PERCENT_KEY = "costing_mo_percent";
const COSTING_LO_PERCENT_KEY = "costing_lo_percent";
const COSTING_AFFO_PERCENT_KEY = "costing_affo_percent";
const COSTING_GENERAL_MARKUP_PERCENT_KEY = "costing_general_markup_percent";
const COSTING_MATERIAL_MARKUP_PERCENT_KEY = "costing_material_markup_percent";
// Tillåten överleverans på inköpsorder. Three states in one text value: key
// absent ⇒ 0 % (receipts stop at the ordered quantity, exactly as before the
// setting existed), "" ⇒ null = no limit, otherwise the percent.
const PURCHASE_OVER_RECEIPT_PERCENT_KEY = "purchase_over_receipt_percent";
function decodeOverReceiptPercent(raw: string | null): number | null {
  if (raw === null) return 0;
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
// Materialbrist vid rapportering. "none" = no check, which is what every
// report did before the setting existed — so an absent or unknown value
// changes nothing at deploy (same decode shape as decodeSupplierPriceTier).
const MANUFACTURING_MATERIAL_SHORTAGE_KEY = "manufacturing_material_shortage";
function decodeMaterialShortage(raw: string | null | undefined): ManufacturingMaterialShortage {
  return raw === "warn" || raw === "block" ? raw : "none";
}
// Kod på pallkort. "none" = no codes, which is what every card printed
// before the setting existed — an absent or unknown value changes nothing.
const PALLET_CARD_CODE_KEY = "pallet_card_code";
// Tillåt utskrift av pallkort även om kollina inte stämmer — absent ⇒ false.
const PALLET_CARD_ALLOW_QUANTITY_MISMATCH_KEY = "pallet_card_allow_quantity_mismatch";
function decodePalletCardCode(raw: string | null | undefined): PalletCardCode {
  return raw === "barcode" || raw === "qr" ? raw : "none";
}

function flattenDeliveryDefaults(d: DeliveryDefaults) {
  return {
    supplierDeliveryDayMode: d.supplier.mode,
    supplierTransitDays: d.supplier.transitDays,
    customerDeliveryDayMode: d.customer.mode,
    customerTransitDays: d.customer.transitDays,
  };
}

// The 9 posting accounts + 2 kundreskontra amounts (Ekonomi →
// automatkontering) live in ./posting-settings.js, which owns their key
// constants and BAS-standard/kundreskontra defaults — imported above rather
// than duplicated here.

// Raw SMTP config for the mail service — includes the password, so it must
// never be returned from a route. getSettings() is the maskable view.
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
}

export class NumberSeriesNotFoundError extends Error {
  constructor(key: string) {
    super(`Number series "${key}" not found`);
    this.name = "NumberSeriesNotFoundError";
  }
}

// The default article series (DEFAULT_ARTICLE_SERIES_KEY) is built in like
// the order series; only the user's own article series can be renamed or
// deleted.
export class DuplicateNumberSeriesNameError extends Error {
  constructor(name: string) {
    super(`A number series named ${name} already exists`);
    this.name = "DuplicateNumberSeriesNameError";
  }
}

// Renaming or deleting a built-in series (order series, Artikelnummer).
export class BuiltInNumberSeriesError extends Error {
  constructor(key: string, action: "rename" | "delete") {
    super(
      action === "delete"
        ? `Number series "${key}" is built in and cannot be deleted`
        : `Number series "${key}" is built in and cannot be renamed`
    );
    this.name = "BuiltInNumberSeriesError";
  }
}

const isOwnArticleSeries = (row: { key: string; forArticles: boolean }) =>
  row.forArticles && row.key !== DEFAULT_ARTICLE_SERIES_KEY;

export class CarrierNotFoundError extends Error {
  constructor(id: string) {
    super(`Carrier ${id} not found`);
    this.name = "CarrierNotFoundError";
  }
}

export class CompanyCarrierNotFoundError extends Error {
  constructor(id: string) {
    super(`Company carrier ${id} not found`);
    this.name = "CompanyCarrierNotFoundError";
  }
}

export class DuplicateCompanyCarrierError extends Error {
  constructor() {
    super("This carrier is already in the company's carrier list");
    this.name = "DuplicateCompanyCarrierError";
  }
}

// system.service.ts is constructed in ~30 unrelated test files across every
// module (it's the settings reader almost everything depends on) — most of
// them have no reason to wire up a real AuditWriter just to call
// updateSettings/addCompanyCarrier once in passing. `audit` therefore
// defaults to a no-op rather than being a hard requirement like it is on
// manufacturing/stock-count/auth (whose test surface is much narrower);
// app.ts always passes the real auditRepository.
const NOOP_AUDIT: AuditWriter = { async log() {} };

// nav-filer-2026-10-27_0905.zip — UTC, like the backup's name.
export function fileExportFilename(now: Date): string {
  const iso = now.toISOString();
  return `nav-filer-${iso.slice(0, 10)}_${iso.slice(11, 16).replace(":", "")}.zip`;
}

// The stored JSON list, unknown or malformed entries dropped — never throws,
// a broken value reads as "no documents".
function decodeExtraDescriptionDocuments(raw: string | null): ExtraDescriptionDocument[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return EXTRA_DESCRIPTION_DOCUMENTS.filter((kind) => parsed.includes(kind));
  } catch {
    return [];
  }
}

async function* zipStoredFiles(files: AsyncIterable<ExportedFile>): AsyncGenerator<Buffer> {
  const zip = new ZipStreamWriter();
  const paths = new UniquePaths();
  for await (const file of files) {
    const folder = file.folder.map((segment) => safeSegment(segment, "okänd")).join("/");
    yield* zip.add(paths.claim(folder, safeSegment(file.filename)), file.data, file.modified);
  }
  yield zip.finish();
}

export function createSystemService(repo: SystemRepository, audit: AuditWriter = NOOP_AUDIT) {
  // Typed view over the system_settings key–value rows. Absent keys fall
  // back to Monitor-like defaults: one stamp at a time, ATF off (0 min),
  // costing unchanged (standard cost, no markups). ONE query
  // (repo.getAllSettings()) instead of ~30 separate getSetting() round trips —
  // every field below decodes from the same in-memory map, including the
  // posting/kundreskontra slice via posting-settings.js's decodePostingSettings
  // (the single source of truth for those keys' defaults).
  async function getSettings() {
    const rows = await repo.getAllSettings();
    const byKey = new Map(rows.map((row) => [row.key, row.value] as const));
    const get = (key: string) => byKey.get(key) ?? null;

    return {
      allowMultipleStamps: get(ALLOW_MULTIPLE_STAMPS_KEY) === "true",
      showRevisionsOnDocuments: get(SHOW_REVISIONS_ON_DOCUMENTS_KEY) === "true",
      // Unlike the other toggles this one defaults ON when never set.
      showOrderRevisionOnDocuments: get(SHOW_ORDER_REVISION_ON_DOCUMENTS_KEY) !== "false",
      extraDescriptionDocuments: decodeExtraDescriptionDocuments(get(EXTRA_DESCRIPTION_DOCUMENTS_KEY)),
      atfMinutesPerWeek: get(ATF_MINUTES_PER_WEEK_KEY) === null ? 0 : Number(get(ATF_MINUTES_PER_WEEK_KEY)),
      payrollOvertimeThresholdMinutes:
        get(PAYROLL_OVERTIME_THRESHOLD_MINUTES_KEY) === null ? 0 : Number(get(PAYROLL_OVERTIME_THRESHOLD_MINUTES_KEY)),
      attendanceReasonRequired: get(ATTENDANCE_REASON_REQUIRED_KEY) === "true",
      attendanceReasonToleranceMinutes:
        get(ATTENDANCE_REASON_TOLERANCE_MINUTES_KEY) === null ? 5 : Number(get(ATTENDANCE_REASON_TOLERANCE_MINUTES_KEY)),
      terminalOvertimeChoice: get(TERMINAL_OVERTIME_CHOICE_KEY) === "true",
      paxmlCodeWorked: codeSetting(get(PAXML_CODE_WORKED_KEY), "TID"),
      paxmlCodeOvertime: codeSetting(get(PAXML_CODE_OVERTIME_KEY), "ÖT1"),
      paxmlCodeOvertimeOffSchedule: codeSetting(get(PAXML_CODE_OVERTIME_OFF_SCHEDULE_KEY), "ÖT2"),
      paxmlCodeOvertimeComp: codeSetting(get(PAXML_CODE_OVERTIME_COMP_KEY), "ÖK1"),
      paxmlCodeOvertimeOffScheduleComp: codeSetting(get(PAXML_CODE_OVERTIME_OFF_SCHEDULE_COMP_KEY), "ÖK2"),
      paxmlCodeAtf: codeSetting(get(PAXML_CODE_ATF_KEY), "ATF"),
      smtpHost: get(SMTP_HOST_KEY) ?? "",
      smtpPort: get(SMTP_PORT_KEY) === null ? 587 : Number(get(SMTP_PORT_KEY)),
      smtpSecure: get(SMTP_SECURE_KEY) === "true",
      smtpUser: get(SMTP_USER_KEY) ?? "",
      // Write-only: the stored password never leaves the API.
      smtpPasswordSet: get(SMTP_PASSWORD_KEY) !== null && get(SMTP_PASSWORD_KEY) !== "",
      smtpFromName: get(SMTP_FROM_NAME_KEY) ?? "",
      smtpFromEmail: get(SMTP_FROM_EMAIL_KEY) ?? "",
      // Costing (System → Kalkyler) — see updateSystemSettingsSchema for the
      // markup chain. Defaults keep the calculation exactly as it was.
      // A real decode, not a two-way ternary: the previous
      // `=== "supplier" ? … : "standard"` shape would have swallowed every new
      // member of the enum, storing the setting and then never reading it back.
      costingMaterialSource: decodeMaterialSource(get(COSTING_MATERIAL_SOURCE_KEY)),
      costingSupplierPriceTier: decodeSupplierPriceTier(get(COSTING_SUPPLIER_PRICE_TIER_KEY)),
      costingMoPercent: percentSetting(get(COSTING_MO_PERCENT_KEY)),
      costingLoPercent: percentSetting(get(COSTING_LO_PERCENT_KEY)),
      costingAffoPercent: percentSetting(get(COSTING_AFFO_PERCENT_KEY)),
      costingGeneralMarkupPercent: percentSetting(get(COSTING_GENERAL_MARKUP_PERCENT_KEY)),
      costingMaterialMarkupPercent: percentSetting(get(COSTING_MATERIAL_MARKUP_PERCENT_KEY)),
      purchaseOverReceiptPercent: decodeOverReceiptPercent(get(PURCHASE_OVER_RECEIPT_PERCENT_KEY)),
      manufacturingMaterialShortage: decodeMaterialShortage(get(MANUFACTURING_MATERIAL_SHORTAGE_KEY)),
      palletCardCode: decodePalletCardCode(get(PALLET_CARD_CODE_KEY)),
      // Missing ⇒ allowed: the dialog warns, printing is not blocked.
      palletCardAllowQuantityMismatch: get(PALLET_CARD_ALLOW_QUANTITY_MISMATCH_KEY) !== "false",
      // Orimligt mycket tid (Planera, ny TO) — plan-settings.ts owns the default.
      planningLongOperationWeeks: decodeLongOperationWeeks(get(PLANNING_LONG_OPERATION_WEEKS_KEY)),
      // Fasta leveransdagar — the default mode/transit days for partners
      // without their own; junk decodes to the default (delivery-days.ts).
      ...flattenDeliveryDefaults(decodeDeliveryDefaults(get)),
      // Aviseringar — alert-settings.ts owns the keys and defaults.
      alertDigestTime: decodeAlertDigestTime(get(ALERT_DIGEST_TIME_KEY)),
      alertSupplierInvoiceDays: decodeAlertSupplierInvoiceDays(get(ALERT_SUPPLIER_INVOICE_DAYS_KEY)),
      alertQuoteFollowupDays: decodeAlertQuoteFollowupDays(get(ALERT_QUOTE_FOLLOWUP_DAYS_KEY)),
      publicBaseUrl: decodePublicBaseUrl(get(PUBLIC_BASE_URL_KEY)),
      // Uppföljning av offerter — quote-settings.ts owns the key and default.
      quoteValidityDays: decodeQuoteValidityDays(get(QUOTE_VALIDITY_DAYS_KEY)),
      // Egna teman — theme-settings.ts owns the keys and defaults.
      defaultTheme: decodeDefaultTheme(get(DEFAULT_THEME_KEY)),
      themeChoiceLocked: get(THEME_CHOICE_LOCKED_KEY) === "true",
      // Automatic accounting (Ekonomi → automatkontering) — the 9 posting
      // accounts + the 2 kundreskontra amounts, decoded by the leaf that owns
      // their keys/defaults (posting-settings.js).
      ...decodePostingSettings(get),
    };
  }

  return {
    async getCompanyInfo() {
      return repo.getCompanyInfo();
    },

    async updateCompanyInfo(input: UpdateCompanyInfoInput, userId: string | null = null) {
      // Company info isn't secret (it's printed on outgoing documents), but
      // the detail still stays to changed field NAMES rather than full
      // before/after values — a singleton settings blob, same shape as
      // updateSettings' changed-keys log below, not a row edit.
      const changedFields = (Object.keys(input) as (keyof UpdateCompanyInfoInput)[]).filter(
        (key) => input[key] !== undefined
      );
      const row = await repo.updateCompanyInfo(input);
      if (changedFields.length > 0) {
        await audit.log({ entityType: "company_info", entityId: null, action: "updated", detail: { changedFields }, userId });
      }
      return row;
    },

    async getLogo() {
      return repo.getLogo();
    },

    async updateLogo(logo: Buffer, contentType: string, userId: string | null = null) {
      await repo.updateLogo(logo, contentType);
      await audit.log({
        entityType: "company_info",
        entityId: null,
        action: "logo_updated",
        detail: { contentType, sizeBytes: logo.length },
        userId,
      });
    },

    async listNumberSeries() {
      return repo.listNumberSeries();
    },

    async updateNumberSeries(key: string, input: UpdateNumberSeriesInput, userId: string | null = null) {
      const existing = await repo.getNumberSeries(key);
      if (!existing) throw new NumberSeriesNotFoundError(key);
      if (input.name !== undefined && !isOwnArticleSeries(existing)) throw new BuiltInNumberSeriesError(key, "rename");
      let row;
      try {
        row = await repo.updateNumberSeries(key, input);
      } catch (err) {
        if (isUniqueViolation(err, "number_series_name_unique")) throw new DuplicateNumberSeriesNameError(input.name!);
        throw err;
      }
      if (!row) throw new NumberSeriesNotFoundError(key);
      const names = input.name !== undefined ? [{ name: existing.name }, { name: row.name }] : [{}, {}];
      await audit.log({
        entityType: "number_series",
        entityId: key,
        action: "updated",
        detail: {
          before: { ...names[0], prefix: existing.prefix, nextNumber: existing.nextNumber, digits: existing.digits },
          after: { ...names[1], prefix: row.prefix, nextNumber: row.nextNumber, digits: row.digits },
        },
        userId,
      });
      return row;
    },

    async createArticleNumberSeries(input: CreateArticleNumberSeriesInput, userId: string | null = null) {
      // Keys are internal (they address the series in the API); the name is
      // what the user sees and picks.
      const key = `article_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      let row;
      try {
        row = await repo.createArticleNumberSeries(key, input);
      } catch (err) {
        if (isUniqueViolation(err, "number_series_name_unique")) throw new DuplicateNumberSeriesNameError(input.name);
        throw err;
      }
      await audit.log({
        entityType: "number_series",
        entityId: key,
        action: "created",
        detail: { name: row.name, prefix: row.prefix, nextNumber: row.nextNumber, digits: row.digits },
        userId,
      });
      return row;
    },

    async deleteNumberSeries(key: string, userId: string | null = null) {
      const existing = await repo.getNumberSeries(key);
      if (!existing) throw new NumberSeriesNotFoundError(key);
      if (!isOwnArticleSeries(existing)) throw new BuiltInNumberSeriesError(key, "delete");
      const row = await repo.deleteNumberSeries(key);
      if (!row) throw new NumberSeriesNotFoundError(key);
      await audit.log({
        entityType: "number_series",
        entityId: key,
        action: "deleted",
        detail: { name: existing.name, prefix: existing.prefix, nextNumber: existing.nextNumber },
        userId,
      });
    },

    getSettings,

    // A complete gzipped pg_dump of the whole database, streamed to the
    // download. Admin-only at the route.
    createBackup() {
      return createDatabaseBackup(process.env.DATABASE_URL ?? DATABASE_URL_FALLBACK, new Date());
    },

    // Lagringsutrymme: the database size and the stored files per kind.
    async storageUsage() {
      return repo.storageUsage();
    },

    // Exportera filer: every stored file as a streamed zip, one folder per
    // kind (Artikelfiler/<artikelnummer>/…). Nothing is held in memory but
    // the batch being written and the zip's central directory.
    exportFiles(now: Date = new Date()) {
      return { filename: fileExportFilename(now), stream: Readable.from(zipStoredFiles(repo.storedFiles()), { objectMode: false }) };
    },

    // --- Company carrier accounts (Företagsinformation → Speditörer) ---

    async listCompanyCarriers() {
      return repo.listCompanyCarriers();
    },

    async addCompanyCarrier(input: CreateCompanyCarrierInput, userId: string | null = null) {
      const carrier = await repo.getCarrierById(input.carrierId);
      if (!carrier) throw new CarrierNotFoundError(input.carrierId);
      let row;
      try {
        row = await repo.createCompanyCarrier(input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateCompanyCarrierError();
        throw err;
      }
      await audit.log({
        entityType: "company_carrier",
        entityId: carrier.code,
        action: "created",
        detail: { customerNumber: input.customerNumber },
        userId,
      });
      return row;
    },

    async updateCompanyCarrier(id: string, input: UpdateCompanyCarrierInput, userId: string | null = null) {
      const existing = await repo.findCompanyCarrier(id);
      if (!existing) throw new CompanyCarrierNotFoundError(id);
      const row = await repo.updateCompanyCarrier(id, input.customerNumber);
      if (!row) throw new CompanyCarrierNotFoundError(id);
      const carrier = await repo.getCarrierById(existing.carrierId);
      await audit.log({
        entityType: "company_carrier",
        entityId: carrier?.code ?? id,
        action: "updated",
        detail: { before: { customerNumber: existing.customerNumber }, after: { customerNumber: row.customerNumber } },
        userId,
      });
      return row;
    },

    async removeCompanyCarrier(id: string, userId: string | null = null) {
      const existing = await repo.findCompanyCarrier(id);
      if (!existing) throw new CompanyCarrierNotFoundError(id);
      const row = await repo.deleteCompanyCarrier(id);
      if (!row) throw new CompanyCarrierNotFoundError(id);
      const carrier = await repo.getCarrierById(existing.carrierId);
      await audit.log({
        entityType: "company_carrier",
        entityId: carrier?.code ?? id,
        action: "deleted",
        userId,
      });
    },

    // For document rendering (purchase service) — the company's number at a
    // carrier, or null.
    async getCompanyCarrierNumber(carrierId: string) {
      return repo.getCompanyCarrierNumber(carrierId);
    },

    // Raw SMTP config for the mail service. Returns null until a host is
    // configured, so callers can answer "SMTP är inte konfigurerat".
    async getSmtpConfig(): Promise<SmtpConfig | null> {
      const [host, port, secure, user, password, fromName, fromEmail] = await Promise.all([
        repo.getSetting(SMTP_HOST_KEY),
        repo.getSetting(SMTP_PORT_KEY),
        repo.getSetting(SMTP_SECURE_KEY),
        repo.getSetting(SMTP_USER_KEY),
        repo.getSetting(SMTP_PASSWORD_KEY),
        repo.getSetting(SMTP_FROM_NAME_KEY),
        repo.getSetting(SMTP_FROM_EMAIL_KEY),
      ]);
      if (!host) return null;
      return {
        host,
        port: port === null ? 587 : Number(port),
        secure: secure === "true",
        user: user ?? "",
        password: password ?? "",
        fromName: fromName ?? "",
        fromEmail: fromEmail ?? "",
      };
    },

    async updateSettings(input: UpdateSystemSettingsInput, userId: string | null = null) {
      // G1 masking: `set` records only the KEY that changed, never the
      // value — so smtp_password (and everything else here) never has a
      // value anywhere near the audit detail. This mirrors the DB storage
      // key rather than the request field name, since that's the actual
      // durable identity of the setting.
      const changedKeys: string[] = [];
      const set = async (key: string, value: string) => {
        changedKeys.push(key);
        await repo.setSetting(key, value);
      };

      // Egna teman: first, so an unknown theme refuses the whole request
      // before anything is written. The write locks the theme row against a
      // concurrent delete (themes.repository's lockThemeForSetting).
      if (input.defaultTheme !== undefined) {
        if (!(await repo.setDefaultTheme(input.defaultTheme))) throw new UnknownThemeError(input.defaultTheme);
        changedKeys.push(DEFAULT_THEME_KEY);
      }
      if (input.themeChoiceLocked !== undefined) await set(THEME_CHOICE_LOCKED_KEY, String(input.themeChoiceLocked));

      if (input.allowMultipleStamps !== undefined) {
        await set(ALLOW_MULTIPLE_STAMPS_KEY, String(input.allowMultipleStamps));
      }
      if (input.showRevisionsOnDocuments !== undefined) {
        await set(SHOW_REVISIONS_ON_DOCUMENTS_KEY, String(input.showRevisionsOnDocuments));
      }
      if (input.showOrderRevisionOnDocuments !== undefined) {
        await set(SHOW_ORDER_REVISION_ON_DOCUMENTS_KEY, String(input.showOrderRevisionOnDocuments));
      }
      if (input.extraDescriptionDocuments !== undefined) {
        // Stored in the catalog's order, without duplicates.
        const chosen = new Set(input.extraDescriptionDocuments);
        await set(
          EXTRA_DESCRIPTION_DOCUMENTS_KEY,
          JSON.stringify(EXTRA_DESCRIPTION_DOCUMENTS.filter((kind) => chosen.has(kind)))
        );
      }
      if (input.atfMinutesPerWeek !== undefined) {
        await set(ATF_MINUTES_PER_WEEK_KEY, String(input.atfMinutesPerWeek));
      }
      if (input.payrollOvertimeThresholdMinutes !== undefined) {
        await set(PAYROLL_OVERTIME_THRESHOLD_MINUTES_KEY, String(input.payrollOvertimeThresholdMinutes));
      }
      if (input.attendanceReasonRequired !== undefined) {
        await set(ATTENDANCE_REASON_REQUIRED_KEY, String(input.attendanceReasonRequired));
      }
      if (input.attendanceReasonToleranceMinutes !== undefined) {
        await set(ATTENDANCE_REASON_TOLERANCE_MINUTES_KEY, String(input.attendanceReasonToleranceMinutes));
      }
      if (input.terminalOvertimeChoice !== undefined) {
        await set(TERMINAL_OVERTIME_CHOICE_KEY, String(input.terminalOvertimeChoice));
      }
      if (input.paxmlCodeWorked !== undefined) await set(PAXML_CODE_WORKED_KEY, input.paxmlCodeWorked);
      if (input.paxmlCodeOvertime !== undefined) await set(PAXML_CODE_OVERTIME_KEY, input.paxmlCodeOvertime);
      if (input.paxmlCodeOvertimeOffSchedule !== undefined) {
        await set(PAXML_CODE_OVERTIME_OFF_SCHEDULE_KEY, input.paxmlCodeOvertimeOffSchedule);
      }
      if (input.paxmlCodeOvertimeComp !== undefined) {
        await set(PAXML_CODE_OVERTIME_COMP_KEY, input.paxmlCodeOvertimeComp);
      }
      if (input.paxmlCodeOvertimeOffScheduleComp !== undefined) {
        await set(PAXML_CODE_OVERTIME_OFF_SCHEDULE_COMP_KEY, input.paxmlCodeOvertimeOffScheduleComp);
      }
      if (input.paxmlCodeAtf !== undefined) await set(PAXML_CODE_ATF_KEY, input.paxmlCodeAtf);
      if (input.smtpHost !== undefined) await set(SMTP_HOST_KEY, input.smtpHost);
      if (input.smtpPort !== undefined) await set(SMTP_PORT_KEY, String(input.smtpPort));
      if (input.smtpSecure !== undefined) await set(SMTP_SECURE_KEY, String(input.smtpSecure));
      if (input.smtpUser !== undefined) await set(SMTP_USER_KEY, input.smtpUser);
      // Empty string means "leave the stored password as-is" — the settings
      // form always posts the field but never sees the current value.
      if (input.smtpPassword !== undefined && input.smtpPassword !== "") {
        await set(SMTP_PASSWORD_KEY, input.smtpPassword);
      }
      if (input.smtpFromName !== undefined) await set(SMTP_FROM_NAME_KEY, input.smtpFromName);
      if (input.smtpFromEmail !== undefined) await set(SMTP_FROM_EMAIL_KEY, input.smtpFromEmail);
      if (input.costingMaterialSource !== undefined) {
        await set(COSTING_MATERIAL_SOURCE_KEY, input.costingMaterialSource);
      }
      if (input.costingSupplierPriceTier !== undefined) {
        await set(COSTING_SUPPLIER_PRICE_TIER_KEY, input.costingSupplierPriceTier);
      }
      if (input.costingMoPercent !== undefined) await set(COSTING_MO_PERCENT_KEY, String(input.costingMoPercent));
      if (input.costingLoPercent !== undefined) await set(COSTING_LO_PERCENT_KEY, String(input.costingLoPercent));
      if (input.costingAffoPercent !== undefined) await set(COSTING_AFFO_PERCENT_KEY, String(input.costingAffoPercent));
      if (input.costingGeneralMarkupPercent !== undefined) {
        await set(COSTING_GENERAL_MARKUP_PERCENT_KEY, String(input.costingGeneralMarkupPercent));
      }
      if (input.costingMaterialMarkupPercent !== undefined) {
        await set(COSTING_MATERIAL_MARKUP_PERCENT_KEY, String(input.costingMaterialMarkupPercent));
      }
      if (input.purchaseOverReceiptPercent !== undefined) {
        await set(
          PURCHASE_OVER_RECEIPT_PERCENT_KEY,
          input.purchaseOverReceiptPercent === null ? "" : String(input.purchaseOverReceiptPercent)
        );
      }
      if (input.manufacturingMaterialShortage !== undefined) {
        await set(MANUFACTURING_MATERIAL_SHORTAGE_KEY, input.manufacturingMaterialShortage);
      }
      if (input.palletCardCode !== undefined) await set(PALLET_CARD_CODE_KEY, input.palletCardCode);
      if (input.palletCardAllowQuantityMismatch !== undefined) {
        await set(PALLET_CARD_ALLOW_QUANTITY_MISMATCH_KEY, String(input.palletCardAllowQuantityMismatch));
      }
      if (input.planningLongOperationWeeks !== undefined) {
        await set(PLANNING_LONG_OPERATION_WEEKS_KEY, String(input.planningLongOperationWeeks));
      }
      if (input.supplierDeliveryDayMode !== undefined) {
        await set(DELIVERY_SETTING_KEYS.supplierMode, input.supplierDeliveryDayMode);
      }
      if (input.supplierTransitDays !== undefined) {
        await set(DELIVERY_SETTING_KEYS.supplierTransit, String(input.supplierTransitDays));
      }
      if (input.customerDeliveryDayMode !== undefined) {
        await set(DELIVERY_SETTING_KEYS.customerMode, input.customerDeliveryDayMode);
      }
      if (input.customerTransitDays !== undefined) {
        await set(DELIVERY_SETTING_KEYS.customerTransit, String(input.customerTransitDays));
      }
      // Aviseringar.
      if (input.alertDigestTime !== undefined) await set(ALERT_DIGEST_TIME_KEY, input.alertDigestTime);
      if (input.alertSupplierInvoiceDays !== undefined) {
        await set(ALERT_SUPPLIER_INVOICE_DAYS_KEY, String(input.alertSupplierInvoiceDays));
      }
      if (input.alertQuoteFollowupDays !== undefined) {
        await set(ALERT_QUOTE_FOLLOWUP_DAYS_KEY, String(input.alertQuoteFollowupDays));
      }
      if (input.quoteValidityDays !== undefined) await set(QUOTE_VALIDITY_DAYS_KEY, String(input.quoteValidityDays));
      if (input.publicBaseUrl !== undefined) await set(PUBLIC_BASE_URL_KEY, decodePublicBaseUrl(input.publicBaseUrl));
      if (input.postingAccountsReceivable !== undefined) {
        await set(POSTING_ACCOUNTS_RECEIVABLE_KEY, input.postingAccountsReceivable);
      }
      if (input.postingAccountsPayable !== undefined) {
        await set(POSTING_ACCOUNTS_PAYABLE_KEY, input.postingAccountsPayable);
      }
      if (input.postingDefaultCost !== undefined) await set(POSTING_DEFAULT_COST_KEY, input.postingDefaultCost);
      // Kundreskontra (B3).
      if (input.postingBank !== undefined) await set(POSTING_BANK_KEY, input.postingBank);
      if (input.postingReminderFeeAccount !== undefined) {
        await set(POSTING_REMINDER_FEE_ACCOUNT_KEY, input.postingReminderFeeAccount);
      }
      if (input.postingPaymentWriteOff !== undefined) {
        await set(POSTING_PAYMENT_WRITEOFF_KEY, input.postingPaymentWriteOff);
      }
      // Momsrapport (B5).
      if (input.postingVatSettlement !== undefined) {
        await set(POSTING_VAT_SETTLEMENT_KEY, input.postingVatSettlement);
      }
      // Årsbokslut (steg 2).
      if (input.postingInventory !== undefined) await set(POSTING_INVENTORY_KEY, input.postingInventory);
      if (input.postingInventoryChange !== undefined) await set(POSTING_INVENTORY_CHANGE_KEY, input.postingInventoryChange);
      // Valuta.
      if (input.postingFxGain !== undefined) await set(POSTING_FX_GAIN_KEY, input.postingFxGain);
      if (input.postingFxLoss !== undefined) await set(POSTING_FX_LOSS_KEY, input.postingFxLoss);
      if (input.postingBankFees !== undefined) await set(POSTING_BANK_FEES_KEY, input.postingBankFees);
      if (input.paymentTolerance !== undefined) {
        await set(PAYMENT_TOLERANCE_KEY, String(round2(input.paymentTolerance)));
      }
      if (input.reminderFee !== undefined) await set(REMINDER_FEE_KEY, String(round2(input.reminderFee)));
      // Dröjsmålsränta och förseningsersättning.
      if (input.lateInterestEnabled !== undefined) await set(LATE_INTEREST_ENABLED_KEY, String(input.lateInterestEnabled));
      if (input.lateInterestMargin !== undefined) await set(LATE_INTEREST_MARGIN_KEY, String(round2(input.lateInterestMargin)));
      if (input.lateInterestMinAmount !== undefined) {
        await set(LATE_INTEREST_MIN_AMOUNT_KEY, String(round2(input.lateInterestMinAmount)));
      }
      if (input.lateFeeEnabled !== undefined) await set(LATE_FEE_ENABLED_KEY, String(input.lateFeeEnabled));
      if (input.postingLateInterest !== undefined) await set(POSTING_LATE_INTEREST_KEY, input.postingLateInterest);
      if (input.postingLateFee !== undefined) await set(POSTING_LATE_FEE_KEY, input.postingLateFee);

      if (changedKeys.length > 0) {
        await audit.log({ entityType: "system_settings", entityId: null, action: "updated", detail: { changedKeys }, userId });
      }
      return getSettings();
    },
  };
}

export type SystemService = ReturnType<typeof createSystemService>;
