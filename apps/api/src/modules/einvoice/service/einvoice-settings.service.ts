import {
  EINVOICE_RECEIVE_INTERVAL_DEFAULT,
  EINVOICE_STATUS_INTERVAL_DEFAULT,
  type EinvoiceEnvironment,
  type EinvoiceReceptionView,
  type SetEinvoiceReceptionInput,
  type TestEinvoiceConnectionInput,
  type UpdateEinvoiceSettingsInput,
} from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { EinvoiceRepository } from "../repository/einvoice.repository.js";
import { b2brouterProviderFactory } from "./b2brouter-provider.js";
import { EInvoiceProviderError, type EInvoiceProvider, type EInvoiceProviderFactory, type PeppolTransport } from "./einvoice-provider.js";
import { EinvoiceKeyEnvironmentMismatchError, EinvoiceNotConfiguredError } from "./einvoice.errors.js";
import { orgNumberDigits } from "./peppol-schemes.js";

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
  // Skicka e-faktura automatiskt vid Utfärda — absent = on.
  autoSend: "einvoice_auto_send",
  // Written by the status run only (repository), never through update().
  lastStatusRunAt: "einvoice_last_status_run_at",
  // Statusbesked direkt (webhook): written by registerWebhook/
  // unregisterWebhook and the webhook receiver only. The secret never
  // leaves the API.
  webhookId: "einvoice_webhook_id",
  webhookSecret: "einvoice_webhook_secret",
  webhookEnvironment: "einvoice_webhook_environment",
  webhookUrl: "einvoice_webhook_url",
  webhookLastReceivedAt: "einvoice_webhook_last_received_at",
  // Mottagning (spec 2026-11-05-e-faktura-mottagning): the switch mirrors
  // the transport's `reception` at the access point; the run keys are
  // written by the reception job only (repository), never through update().
  receptionEnabled: "einvoice_reception_enabled",
  receiveIntervalMinutes: "einvoice_receive_interval_minutes",
  lastReceiveRunAt: "einvoice_last_receive_run_at",
  receiveLastSuccessAt: "einvoice_receive_last_success_at",
  receiveLastError: "einvoice_receive_last_error",
} as const;

// The path B2Brouter posts status changes to, under the public address.
export const EINVOICE_WEBHOOK_PATH = "/api/v1/einvoice/webhook";
// Aktivera statusbesked registers both: the issued invoices' state changes
// and a received document (which starts a reception run).
export const EINVOICE_WEBHOOK_EVENTS = ["issued_invoice.state_change", "received_invoice.created"];

export class EinvoiceWebhookPublicUrlError extends Error {
  constructor() {
    super("Ange Navs adress med https under System → Inställningar innan statusbesked kan slås på");
    this.name = "EinvoiceWebhookPublicUrlError";
  }
}

export interface EinvoiceWebhookSettings {
  id: string | null;
  secret: string | null;
  environment: EinvoiceEnvironment | null;
  url: string | null;
  lastReceivedAt: Date | null;
}

export interface EinvoiceReceptionSettings {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

export interface EinvoiceSettings {
  enabled: boolean;
  environment: EinvoiceEnvironment;
  apiKey: string | null;
  accountId: string | null;
  accountName: string | null;
  statusIntervalMinutes: number;
  lastStatusRunAt: Date | null;
  autoSend: boolean;
  webhook: EinvoiceWebhookSettings;
  reception: EinvoiceReceptionSettings;
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

// The page's view of the web hook: never its secret or id.
export interface EinvoiceWebhookView {
  active: boolean;
  environment: EinvoiceEnvironment | null;
  url: string | null;
  lastReceivedAt: Date | null;
  // Registered for the other environment than the one now chosen: its
  // deliveries are no longer acted on — register again.
  environmentMismatch: boolean;
  // The address a registration would use now (null without a public https
  // address under System → Inställningar).
  proposedUrl: string | null;
}

export type EinvoiceSettingsView = Omit<EinvoiceSettings, "apiKey" | "webhook" | "reception"> & {
  apiKeySet: boolean;
  company: EinvoiceCompanyView;
  webhook: EinvoiceWebhookView;
  reception: EinvoiceReceptionView;
};

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
const dateOf = (v: string | undefined) => {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : null;
};

// The web hook's address: the public base URL (System → Inställningar) + the
// receiver's path. B2Brouter only delivers to a public https endpoint.
export function webhookUrlFor(publicBaseUrl: string | null | undefined): string | null {
  const base = (publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+/i.test(base)) return null;
  return `${base}${EINVOICE_WEBHOOK_PATH}`;
}

// Swedish organisationsnummer: one implementation, in the pure scheme file.
export { orgNumberDigits };

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

// Which B2Brouter environment a key belongs to, read from its prefix
// (b2brouter-provider.ts): "test_" sandbox, "prod_" production, "stag_"
// their staging host. A key without a known prefix is an older production
// key — or a test fixture — and is not judged (null): only an explicit
// contradiction is refused.
export function keyEnvironment(apiKey: string): "sandbox" | "production" | "staging" | null {
  const key = apiKey.trim();
  if (key.startsWith("test_")) return "sandbox";
  if (key.startsWith("prod_")) return "production";
  if (key.startsWith("stag_")) return "staging";
  return null;
}

function keyContradicts(apiKey: string, environment: "sandbox" | "production"): boolean {
  const owner = keyEnvironment(apiKey);
  return owner !== null && owner !== environment;
}

function assertKeyMatchesEnvironment(apiKey: string, environment: "sandbox" | "production"): void {
  const owner = keyEnvironment(apiKey);
  if (owner !== null && owner !== environment) throw new EinvoiceKeyEnvironmentMismatchError(owner, environment);
}

export function createEinvoiceSettingsService(deps: {
  repo: EinvoiceRepository;
  company: CompanyInfoReader;
  audit: AuditWriter;
  providerFactory?: EInvoiceProviderFactory;
  // System → Inställningar → Publik adress (the web hook's base).
  publicBaseUrl?: () => Promise<string | null>;
}) {
  const { repo, company, audit } = deps;
  const publicBaseUrl = deps.publicBaseUrl ?? (async () => null);
  const providerFactory = deps.providerFactory ?? b2brouterProviderFactory;

  async function read(): Promise<EinvoiceSettings> {
    const raw = await repo.readSettings();
    const apiKey = raw.get(KEYS.apiKey);
    const interval = Number(raw.get(KEYS.statusIntervalMinutes));
    const receiveInterval = Number(raw.get(KEYS.receiveIntervalMinutes));
    const webhookEnvironment = raw.get(KEYS.webhookEnvironment);
    return {
      enabled: raw.get(KEYS.enabled) === "true",
      environment: raw.get(KEYS.environment) === "production" ? "production" : "sandbox",
      apiKey: apiKey && apiKey !== "" ? apiKey : null,
      accountId: blankToNull(raw.get(KEYS.accountId)),
      accountName: blankToNull(raw.get(KEYS.accountName)),
      statusIntervalMinutes: Number.isInteger(interval) && interval >= 5 ? interval : EINVOICE_STATUS_INTERVAL_DEFAULT,
      lastStatusRunAt: dateOf(raw.get(KEYS.lastStatusRunAt)),
      autoSend: raw.get(KEYS.autoSend) !== "false",
      webhook: {
        id: blankToNull(raw.get(KEYS.webhookId)),
        secret: blankToNull(raw.get(KEYS.webhookSecret)),
        environment: webhookEnvironment === "production" || webhookEnvironment === "sandbox" ? webhookEnvironment : null,
        url: blankToNull(raw.get(KEYS.webhookUrl)),
        lastReceivedAt: dateOf(raw.get(KEYS.webhookLastReceivedAt)),
      },
      reception: {
        enabled: raw.get(KEYS.receptionEnabled) === "true",
        intervalMinutes: Number.isInteger(receiveInterval) && receiveInterval >= 5 ? receiveInterval : EINVOICE_RECEIVE_INTERVAL_DEFAULT,
        lastRunAt: dateOf(raw.get(KEYS.lastReceiveRunAt)),
        lastSuccessAt: dateOf(raw.get(KEYS.receiveLastSuccessAt)),
        lastError: blankToNull(raw.get(KEYS.receiveLastError)),
      },
    };
  }

  // The reception as the page shows it: the stored switch and run stamps,
  // plus the transport's publication state read LIVE from the access point
  // — null when there is no key/account or it did not answer (never an
  // error: the page must open even when B2Brouter is down).
  async function receptionView(settings: EinvoiceSettings, transport?: PeppolTransport | null): Promise<EinvoiceReceptionView> {
    let live = transport ?? null;
    // A key that contradicts the selected Miljö would read the other
    // environment's publication state — shown as unknown instead.
    const apiKey = settings.apiKey !== null && !keyContradicts(settings.apiKey, settings.environment) ? settings.apiKey : null;
    if (transport === undefined && apiKey && settings.accountId) {
      try {
        live = await providerFactory({ environment: settings.environment, apiKey, accountId: settings.accountId }).getTransport();
      } catch {
        live = null;
      }
    }
    const r = settings.reception;
    return {
      enabled: r.enabled,
      smlStatus: live?.smlStatus ?? null,
      directoryStatus: live?.directoryStatus ?? null,
      migrationPending: live?.migrationPending ?? null,
      documentTypes: live?.documentTypes ?? [],
      participantId: live?.participantId ?? null,
      intervalMinutes: r.intervalMinutes,
      lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
      lastSuccessAt: r.lastSuccessAt ? r.lastSuccessAt.toISOString() : null,
      lastError: r.lastError,
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

  async function view(transport?: PeppolTransport | null): Promise<EinvoiceSettingsView> {
    const settings = await read();
    const { apiKey, webhook, reception: _reception, ...rest } = settings;
    const active = webhook.id !== null && webhook.secret !== null;
    return {
      ...rest,
      apiKeySet: apiKey !== null,
      company: await companyView(),
      reception: await receptionView(settings, transport),
      webhook: {
        active,
        environment: active ? webhook.environment : null,
        url: active ? webhook.url : null,
        lastReceivedAt: active ? webhook.lastReceivedAt : null,
        environmentMismatch: active && webhook.environment !== rest.environment,
        proposedUrl: webhookUrlFor(await publicBaseUrl()),
      },
    };
  }

  async function clearWebhook() {
    for (const key of [KEYS.webhookId, KEYS.webhookSecret, KEYS.webhookEnvironment, KEYS.webhookUrl, KEYS.webhookLastReceivedAt]) {
      await repo.deleteSetting(key);
    }
  }

  // requireEnabled: sending needs the feature on; the directory lookup and
  // Validera only need a key. requireAccount: import needs the account id.
  // A key that contradicts the selected Miljö is never used — saved before
  // the check existed, it would send real invoices labelled sandbox.
  async function provider(opts: { requireEnabled: boolean; requireAccount?: boolean }): Promise<EInvoiceProvider> {
    const settings = await read();
    if (opts.requireEnabled && !settings.enabled) throw new EinvoiceNotConfiguredError("disabled");
    if (!settings.apiKey) throw new EinvoiceNotConfiguredError("no-key");
    if (opts.requireAccount && !settings.accountId) throw new EinvoiceNotConfiguredError("no-account");
    assertKeyMatchesEnvironment(settings.apiKey, settings.environment);
    return providerFactory({ environment: settings.environment, apiKey: settings.apiKey, accountId: settings.accountId });
  }

  return {
    read,
    view,
    provider,
    companyView,

    async update(input: UpdateEinvoiceSettingsInput, userId: string | null) {
      // Checked before anything is written: the key and the Miljö the save
      // leaves behind must not contradict each other.
      // A save that removes the key (apiKey null) leaves nothing to check.
      if (input.apiKey !== null && (input.environment !== undefined || (input.apiKey !== undefined && input.apiKey !== ""))) {
        const saved = await read();
        const apiKey = input.apiKey && input.apiKey !== "" ? input.apiKey : saved.apiKey;
        if (apiKey) assertKeyMatchesEnvironment(apiKey, input.environment ?? saved.environment);
      }
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
      // The account name only ever describes the stored account id: it is
      // written together with a new id and cleared whenever the id goes
      // away or changes without a name, so the two can never drift apart.
      if (input.accountId !== undefined || input.accountName !== undefined) {
        const stored = await read();
        let name: string | null | undefined = input.accountName;
        if (input.accountId !== undefined) {
          await set(KEYS.accountId, input.accountId ?? "");
          if (input.accountId === null) name = null;
          else if (name === undefined && input.accountId !== stored.accountId) name = null;
        }
        if (name !== undefined && name !== stored.accountName) await set(KEYS.accountName, name ?? "");
      }
      if (input.statusIntervalMinutes !== undefined) await set(KEYS.statusIntervalMinutes, String(input.statusIntervalMinutes));
      if (input.autoSend !== undefined) await set(KEYS.autoSend, String(input.autoSend));
      if (input.receiveIntervalMinutes !== undefined) await set(KEYS.receiveIntervalMinutes, String(input.receiveIntervalMinutes));
      if (changed.length > 0) {
        changed.sort();
        await audit.log({ entityType: "einvoice_settings", entityId: null, action: "updated", detail: { keys: changed }, userId });
      }
      return view();
    },

    // Aktivera statusbesked: registers the web hook at the access point with
    // the saved key and environment. A hook registered earlier for the SAME
    // environment is removed first (best effort — one left behind only gets
    // 401 from us); one for the other environment cannot be reached with
    // this key and is simply forgotten.
    async registerWebhook(userId: string | null) {
      const url = webhookUrlFor(await publicBaseUrl());
      if (!url) throw new EinvoiceWebhookPublicUrlError();
      const current = await read();
      const p = await provider({ requireEnabled: false });
      if (current.webhook.id && current.webhook.environment === current.environment) {
        try {
          await p.deleteWebhook(current.webhook.id);
        } catch {
          // see above
        }
      }
      const created = await p.createWebhook({ url, events: EINVOICE_WEBHOOK_EVENTS, description: "Nav ERP — statusbesked för e-fakturor" });
      await clearWebhook();
      await repo.setSetting(KEYS.webhookId, created.id);
      await repo.setSetting(KEYS.webhookSecret, created.secret);
      await repo.setSetting(KEYS.webhookEnvironment, current.environment);
      await repo.setSetting(KEYS.webhookUrl, url);
      await audit.log({
        entityType: "einvoice_settings",
        entityId: null,
        action: "webhook_registered",
        detail: { environment: current.environment, url, webhookId: created.id },
        userId,
      });
      return view();
    },

    // Stäng av statusbesked: removes the hook at the access point (already
    // gone is fine) and forgets it. A hook registered for the other
    // environment cannot be reached with this key and is only forgotten.
    async unregisterWebhook(userId: string | null) {
      const current = await read();
      if (current.webhook.id && current.webhook.environment === current.environment && current.apiKey) {
        try {
          await (await provider({ requireEnabled: false })).deleteWebhook(current.webhook.id);
        } catch (err) {
          if (!(err instanceof EInvoiceProviderError && err.kind === "not-found")) throw err;
        }
      }
      await clearWebhook();
      await audit.log({
        entityType: "einvoice_settings",
        entityId: null,
        action: "webhook_removed",
        detail: { environment: current.webhook.environment, webhookId: current.webhook.id },
        userId,
      });
      return view();
    },

    async recordWebhookReceived(at: Date) {
      await repo.setSetting(KEYS.webhookLastReceivedAt, at.toISOString());
    },

    // Ta emot e-faktura: flips the transport's reception at the access
    // point (which publishes/unpublishes the participant in SML and the
    // Peppol directory) and mirrors the answer in einvoice_reception_enabled.
    // The migration code travels only with enabled: true. A hook already
    // registered for this environment is given the received event (best
    // effort — a hook that cannot be updated only delays the pull to the
    // job's next run). A 409 from the access point reaches the route as
    // EinvoiceReceptionRegisteredElsewhereError (through fromProviderError).
    async setReception(input: SetEinvoiceReceptionInput, userId: string | null): Promise<EinvoiceReceptionView> {
      const current = await read();
      const p = await provider({ requireEnabled: false, requireAccount: true });
      const transport = await p.setReception({ enabled: input.enabled, migrationCode: input.enabled ? input.migrationCode : undefined });
      await repo.setSetting(KEYS.receptionEnabled, String(transport.reception));
      let webhookUpdated = false;
      if (transport.reception && current.webhook.id && current.webhook.environment === current.environment) {
        try {
          await p.updateWebhook(current.webhook.id, { events: EINVOICE_WEBHOOK_EVENTS });
          webhookUpdated = true;
        } catch {
          // see above
        }
      }
      await audit.log({
        entityType: "einvoice_settings",
        entityId: null,
        action: transport.reception ? "reception_enabled" : "reception_disabled",
        detail: { environment: current.environment, participantId: transport.participantId, migrationCode: Boolean(input.enabled && input.migrationCode), webhookUpdated },
        userId,
      });
      return receptionView(await read(), transport);
    },

    receptionView: async () => receptionView(await read()),

    // The key typed in the form when given, else the saved one — so a new
    // key can be checked before it is stored. Nothing is saved here; the
    // form sends the account id and name back through update() on Spara.
    async testConnection(input: TestEinvoiceConnectionInput = {}) {
      const saved = await read();
      const apiKey = input.apiKey && input.apiKey !== "" ? input.apiKey : saved.apiKey;
      if (!apiKey) throw new EinvoiceNotConfiguredError("no-key");
      const environment = input.environment ?? saved.environment;
      assertKeyMatchesEnvironment(apiKey, environment);
      const result = await providerFactory({ environment, apiKey, accountId: saved.accountId }).checkKey();
      return { ...result, environment };
    },
  };
}

export type EinvoiceSettingsService = ReturnType<typeof createEinvoiceSettingsService>;
