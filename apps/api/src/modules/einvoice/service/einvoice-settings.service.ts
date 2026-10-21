import {
  EINVOICE_STATUS_INTERVAL_DEFAULT,
  type EinvoiceEnvironment,
  type TestEinvoiceConnectionInput,
  type UpdateEinvoiceSettingsInput,
} from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { EinvoiceRepository } from "../repository/einvoice.repository.js";
import { b2brouterProviderFactory } from "./b2brouter-provider.js";
import type { EInvoiceProvider, EInvoiceProviderFactory } from "./einvoice-provider.js";
import { EinvoiceNotConfiguredError } from "./einvoice.errors.js";

// E-fakturainställningar live as einvoice_* keys in system_settings (key–
// value, no migration per setting) — the same shape as the freight settings.
// The API key is write-only: never returned, never logged — the audit trail
// records changed KEY names only.

const KEYS = {
  enabled: "einvoice_enabled",
  environment: "einvoice_environment",
  apiKey: "einvoice_api_key",
  accountId: "einvoice_account_id",
  accountName: "einvoice_account_name",
  statusIntervalMinutes: "einvoice_status_interval_minutes",
  // Written by the status run only (repository), never through update().
  lastStatusRunAt: "einvoice_last_status_run_at",
} as const;

export interface EinvoiceSettings {
  enabled: boolean;
  environment: EinvoiceEnvironment;
  apiKey: string | null;
  accountId: string | null;
  accountName: string | null;
  statusIntervalMinutes: number;
  lastStatusRunAt: Date | null;
}

// The company data an e-invoice carries (System → Företagsuppgifter), with
// the problems that would stop a send ("Organisationsnummer saknas") or
// weaken the document (no payment account).
export interface EinvoiceCompanyView {
  name: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  bic: string | null;
  problems: string[];
}

export type EinvoiceSettingsView = Omit<EinvoiceSettings, "apiKey"> & { apiKeySet: boolean; company: EinvoiceCompanyView };

// Narrow slice of the system module (same pattern as RegisterReferenceReader).
export interface CompanyInfoReader {
  getCompanyInfo(): Promise<CompanyInfoRow | null>;
}

export interface CompanyInfoRow {
  name: string;
  orgNumber: string | null;
  vatNumber: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  bic: string | null;
  fSkatt: boolean;
}

const blankToNull = (v: string | null | undefined) => (v && v.trim() !== "" ? v.trim() : null);

// Swedish organisationsnummer: ten digits (a leading century "16" is
// tolerated and dropped). Null when it is anything else.
export function orgNumberDigits(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("16")) return digits.slice(2);
  return null;
}

export function companyProblems(company: CompanyInfoRow | null): string[] {
  const problems: string[] = [];
  if (!company || blankToNull(company.name) === null) problems.push("Företagsnamn saknas");
  if (orgNumberDigits(company?.orgNumber) === null) problems.push("Organisationsnummer saknas eller är inte tio siffror");
  if (blankToNull(company?.vatNumber) === null) problems.push("Momsregistreringsnummer saknas");
  if (blankToNull(company?.address) === null || blankToNull(company?.postalCode) === null || blankToNull(company?.city) === null) {
    problems.push("Adress, postnummer eller ort saknas");
  }
  if (blankToNull(company?.bankgiro) === null && blankToNull(company?.plusgiro) === null && blankToNull(company?.iban) === null) {
    problems.push("Bankgiro, plusgiro eller IBAN saknas — fakturan skickas utan betalningsuppgifter");
  }
  return problems;
}

export function createEinvoiceSettingsService(deps: {
  repo: EinvoiceRepository;
  company: CompanyInfoReader;
  audit: AuditWriter;
  providerFactory?: EInvoiceProviderFactory;
}) {
  const { repo, company, audit } = deps;
  const providerFactory = deps.providerFactory ?? b2brouterProviderFactory;

  async function read(): Promise<EinvoiceSettings> {
    const raw = await repo.readSettings();
    const apiKey = raw.get(KEYS.apiKey);
    const interval = Number(raw.get(KEYS.statusIntervalMinutes));
    const last = raw.get(KEYS.lastStatusRunAt);
    const lastMs = last ? Date.parse(last) : NaN;
    return {
      enabled: raw.get(KEYS.enabled) === "true",
      environment: raw.get(KEYS.environment) === "production" ? "production" : "sandbox",
      apiKey: apiKey && apiKey !== "" ? apiKey : null,
      accountId: blankToNull(raw.get(KEYS.accountId)),
      accountName: blankToNull(raw.get(KEYS.accountName)),
      statusIntervalMinutes: Number.isInteger(interval) && interval >= 5 ? interval : EINVOICE_STATUS_INTERVAL_DEFAULT,
      lastStatusRunAt: Number.isFinite(lastMs) ? new Date(lastMs) : null,
    };
  }

  async function companyView(): Promise<EinvoiceCompanyView> {
    const c = await company.getCompanyInfo();
    return {
      name: blankToNull(c?.name),
      orgNumber: blankToNull(c?.orgNumber),
      vatNumber: blankToNull(c?.vatNumber),
      address: blankToNull(c?.address),
      postalCode: blankToNull(c?.postalCode),
      city: blankToNull(c?.city),
      bankgiro: blankToNull(c?.bankgiro),
      plusgiro: blankToNull(c?.plusgiro),
      iban: blankToNull(c?.iban),
      bic: blankToNull(c?.bic),
      problems: companyProblems(c),
    };
  }

  async function view(): Promise<EinvoiceSettingsView> {
    const { apiKey, ...rest } = await read();
    return { ...rest, apiKeySet: apiKey !== null, company: await companyView() };
  }

  // requireEnabled: sending needs the feature on; the directory lookup and
  // Validera only need a key. requireAccount: import needs the account id.
  async function provider(opts: { requireEnabled: boolean; requireAccount?: boolean }): Promise<EInvoiceProvider> {
    const settings = await read();
    if (opts.requireEnabled && !settings.enabled) throw new EinvoiceNotConfiguredError("disabled");
    if (!settings.apiKey) throw new EinvoiceNotConfiguredError("no-key");
    if (opts.requireAccount && !settings.accountId) throw new EinvoiceNotConfiguredError("no-account");
    return providerFactory({ environment: settings.environment, apiKey: settings.apiKey, accountId: settings.accountId });
  }

  return {
    read,
    view,
    provider,
    companyView,

    async update(input: UpdateEinvoiceSettingsInput, userId: string | null) {
      const changed: string[] = [];
      const set = async (key: string, value: string) => {
        changed.push(key);
        await repo.setSetting(key, value);
      };
      if (input.enabled !== undefined) await set(KEYS.enabled, String(input.enabled));
      if (input.environment !== undefined) await set(KEYS.environment, input.environment);
      // "" = leave the stored key (the form never sees it), null = remove.
      if (input.apiKey === null) {
        changed.push(KEYS.apiKey);
        await repo.deleteSetting(KEYS.apiKey);
      } else if (input.apiKey !== undefined && input.apiKey !== "") {
        await set(KEYS.apiKey, input.apiKey);
      }
      if (input.accountId !== undefined) await set(KEYS.accountId, input.accountId ?? "");
      if (input.statusIntervalMinutes !== undefined) await set(KEYS.statusIntervalMinutes, String(input.statusIntervalMinutes));
      if (changed.length > 0) {
        changed.sort();
        await audit.log({ entityType: "einvoice_settings", entityId: null, action: "updated", detail: { keys: changed }, userId });
      }
      return view();
    },

    // The key typed in the form when given, else the saved one — so a new
    // key can be checked before it is stored. Nothing is saved here; the
    // form sends the account id back through update().
    async testConnection(input: TestEinvoiceConnectionInput = {}) {
      const saved = await read();
      const apiKey = input.apiKey && input.apiKey !== "" ? input.apiKey : saved.apiKey;
      if (!apiKey) throw new EinvoiceNotConfiguredError("no-key");
      const environment = input.environment ?? saved.environment;
      const result = await providerFactory({ environment, apiKey, accountId: saved.accountId }).checkKey();
      return { ...result, environment };
    },

    // The account name is informational and only ever set from a successful
    // Testa anslutning (the form calls this after the test).
    async rememberAccountName(name: string) {
      await repo.setSetting(KEYS.accountName, name);
    },
  };
}

export type EinvoiceSettingsService = ReturnType<typeof createEinvoiceSettingsService>;
