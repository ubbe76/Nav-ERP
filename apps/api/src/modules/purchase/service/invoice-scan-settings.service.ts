import {
  INVOICE_SCAN_AI_MODEL_DEFAULT,
  INVOICE_SCAN_AI_MODELS,
  INVOICE_SCAN_AI_MODES,
  INVOICE_SCAN_MAIL_FOLDER_DEFAULT,
  INVOICE_SCAN_MAIL_INTERVAL_DEFAULT,
  INVOICE_SCAN_MAIL_PORT_DEFAULT,
  INVOICE_SCAN_MAIL_PROCESSED_FOLDER_DEFAULT,
  INVOICE_SCAN_MAIL_FOLDERS_EQUAL_TEXT,
  sameMailFolder,
  type InvoiceScanAiMode,
  type InvoiceScanAiModel,
  type InvoiceScanSettingsView,
  type TestInvoiceScanAiInput,
  type UpdateInvoiceScanSettingsInput,
} from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { InvoiceScanRepository } from "../repository/invoice-scan.repository.js";
import { claudeInterpreterFactory } from "./invoice-scan/claude-interpreter.js";
import { AI_TEXTS, aiErrorText, type InvoiceInterpreterFactory } from "./invoice-scan/invoice-interpreter.js";

// Fakturaskanning — the settings (System → Fakturaskanning, admin): keys
// invoice_scan_* in system_settings, the e-invoice settings' shape. The API
// key and the mail password are write-only: never returned, never logged —
// the audit trail records the changed KEY names only. The *_lease_until,
// *_last_run_at and *_last_error keys are written by the e-mail job only
// (step 3), never through update().

export const INVOICE_SCAN_SETTING_KEYS = {
  aiMode: "invoice_scan_ai_mode",
  aiApiKey: "invoice_scan_ai_api_key",
  aiModel: "invoice_scan_ai_model",
  poMatching: "invoice_scan_po_matching",
  mailEnabled: "invoice_scan_mail_enabled",
  mailHost: "invoice_scan_mail_host",
  mailPort: "invoice_scan_mail_port",
  mailTls: "invoice_scan_mail_tls",
  mailUser: "invoice_scan_mail_user",
  mailPassword: "invoice_scan_mail_password",
  mailFolder: "invoice_scan_mail_folder",
  mailProcessedFolder: "invoice_scan_mail_processed_folder",
  mailIntervalMinutes: "invoice_scan_mail_interval_minutes",
  mailLeaseUntil: "invoice_scan_mail_lease_until",
  mailLastRunAt: "invoice_scan_mail_last_run_at",
  mailLastError: "invoice_scan_mail_last_error",
} as const;

// Testa anslutning (AI) failed — the message is the Swedish text the page
// shows. 409.
export class InvoiceScanAiTestFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceScanAiTestFailedError";
  }
}

// Värd or användare changed (compared with the saved ones) without the
// password typed again: the saved password is never sent to another server
// or account. 400.
export class InvoiceScanMailPasswordRequiredError extends Error {
  constructor() {
    super("Skriv in lösenordet igen när server eller användare ändras — det sparade lösenordet skickas inte till en annan server eller användare");
    this.name = "InvoiceScanMailPasswordRequiredError";
  }
}

const sameMailAccountValue = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

// True when the saved password may be used for this host and user: they are
// the saved ones (case and surrounding space aside).
export function savedPasswordApplies(
  saved: { mailHost: string | null; mailUser: string | null },
  wanted: { mailHost: string | null; mailUser: string | null }
): boolean {
  return sameMailAccountValue(saved.mailHost, wanted.mailHost) && sameMailAccountValue(saved.mailUser, wanted.mailUser);
}

// Mapp and Mapp för inlästa are the same folder (a letter would be moved
// onto itself and read again every run). 400; the shared zod refine catches
// it when both come in the same body.
export class InvoiceScanMailFoldersEqualError extends Error {
  constructor() {
    super(INVOICE_SCAN_MAIL_FOLDERS_EQUAL_TEXT);
    this.name = "InvoiceScanMailFoldersEqualError";
  }
}

export interface InvoiceScanSettings {
  aiMode: InvoiceScanAiMode;
  aiApiKey: string | null;
  aiModel: InvoiceScanAiModel;
  poMatching: boolean;
  mailEnabled: boolean;
  mailHost: string | null;
  mailPort: number;
  mailTls: boolean;
  mailUser: string | null;
  mailPassword: string | null;
  mailFolder: string;
  mailProcessedFolder: string;
  mailIntervalMinutes: number;
  mailLastRunAt: Date | null;
  mailLastError: string | null;
}

const blankToNull = (v: string | null | undefined) => (v && v.trim() !== "" ? v.trim() : null);

export function createInvoiceScanSettingsService(deps: {
  repo: InvoiceScanRepository;
  audit: AuditWriter;
  // The AI interpretation (Testa anslutning): Claude by default, a fake in tests.
  interpreters?: InvoiceInterpreterFactory;
}) {
  const { repo, audit } = deps;
  const interpreters = deps.interpreters ?? claudeInterpreterFactory;
  const K = INVOICE_SCAN_SETTING_KEYS;

  async function read(): Promise<InvoiceScanSettings> {
    const raw = await repo.readSettings();
    const mode = raw.get(K.aiMode);
    const model = raw.get(K.aiModel);
    const port = Number(raw.get(K.mailPort));
    const interval = Number(raw.get(K.mailIntervalMinutes));
    const last = raw.get(K.mailLastRunAt);
    const lastMs = last ? Date.parse(last) : NaN;
    return {
      aiMode: (INVOICE_SCAN_AI_MODES as readonly string[]).includes(mode ?? "") ? (mode as InvoiceScanAiMode) : "off",
      aiApiKey: blankToNull(raw.get(K.aiApiKey)),
      aiModel: (INVOICE_SCAN_AI_MODELS as readonly string[]).includes(model ?? "") ? (model as InvoiceScanAiModel) : INVOICE_SCAN_AI_MODEL_DEFAULT,
      // Matcha mot inköpsorder: on unless explicitly turned off.
      poMatching: raw.get(K.poMatching) !== "false",
      mailEnabled: raw.get(K.mailEnabled) === "true",
      mailHost: blankToNull(raw.get(K.mailHost)),
      mailPort: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : INVOICE_SCAN_MAIL_PORT_DEFAULT,
      mailTls: raw.get(K.mailTls) !== "false",
      mailUser: blankToNull(raw.get(K.mailUser)),
      mailPassword: blankToNull(raw.get(K.mailPassword)),
      mailFolder: blankToNull(raw.get(K.mailFolder)) ?? INVOICE_SCAN_MAIL_FOLDER_DEFAULT,
      mailProcessedFolder: blankToNull(raw.get(K.mailProcessedFolder)) ?? INVOICE_SCAN_MAIL_PROCESSED_FOLDER_DEFAULT,
      mailIntervalMinutes:
        Number.isInteger(interval) && interval >= 1 && interval <= 60 ? interval : INVOICE_SCAN_MAIL_INTERVAL_DEFAULT,
      mailLastRunAt: Number.isFinite(lastMs) ? new Date(lastMs) : null,
      mailLastError: blankToNull(raw.get(K.mailLastError)),
    };
  }

  async function view(): Promise<InvoiceScanSettingsView> {
    const { aiApiKey, mailPassword, mailLastRunAt, ...rest } = await read();
    return {
      ...rest,
      aiApiKeySet: aiApiKey !== null,
      mailPasswordSet: mailPassword !== null,
      mailLastRunAt: mailLastRunAt ? mailLastRunAt.toISOString() : null,
    };
  }

  return {
    read,
    view,

    async update(input: UpdateInvoiceScanSettingsInput, userId: string | null) {
      const changed: string[] = [];
      const set = async (key: string, value: string) => {
        changed.push(key);
        await repo.setSetting(key, value);
      };
      // "" = leave the stored secret, null = remove it.
      const secret = async (key: string, value: string | null | undefined) => {
        if (value === null) {
          changed.push(key);
          await repo.deleteSetting(key);
        } else if (value !== undefined && value.trim() !== "") {
          await set(key, value.trim());
        }
      };
      // Checked before anything is written: the saved password never follows
      // a changed server or user, and the two folders are never the same.
      const before = await read();
      const nextHost = input.mailHost !== undefined ? blankToNull(input.mailHost) : before.mailHost;
      const nextUser = input.mailUser !== undefined ? blankToNull(input.mailUser) : before.mailUser;
      const typedPassword = input.mailPassword !== undefined && input.mailPassword !== null && input.mailPassword.trim() !== "";
      if (
        before.mailPassword !== null &&
        input.mailPassword !== null &&
        !typedPassword &&
        nextHost !== null &&
        nextUser !== null &&
        !savedPasswordApplies(before, { mailHost: nextHost, mailUser: nextUser })
      ) {
        throw new InvoiceScanMailPasswordRequiredError();
      }
      const nextFolder = input.mailFolder ?? before.mailFolder;
      const nextProcessed = input.mailProcessedFolder ?? before.mailProcessedFolder;
      if (sameMailFolder(nextFolder, nextProcessed)) throw new InvoiceScanMailFoldersEqualError();

      if (input.aiMode !== undefined) await set(K.aiMode, input.aiMode);
      await secret(K.aiApiKey, input.aiApiKey);
      if (input.aiModel !== undefined) await set(K.aiModel, input.aiModel);
      if (input.poMatching !== undefined) await set(K.poMatching, String(input.poMatching));
      if (input.mailEnabled !== undefined) await set(K.mailEnabled, String(input.mailEnabled));
      if (input.mailHost !== undefined) await set(K.mailHost, input.mailHost ?? "");
      if (input.mailPort !== undefined) await set(K.mailPort, String(input.mailPort));
      if (input.mailTls !== undefined) await set(K.mailTls, String(input.mailTls));
      if (input.mailUser !== undefined) await set(K.mailUser, input.mailUser ?? "");
      await secret(K.mailPassword, input.mailPassword);
      if (input.mailFolder !== undefined) await set(K.mailFolder, input.mailFolder);
      if (input.mailProcessedFolder !== undefined) await set(K.mailProcessedFolder, input.mailProcessedFolder);
      if (input.mailIntervalMinutes !== undefined) await set(K.mailIntervalMinutes, String(input.mailIntervalMinutes));
      if (changed.length > 0) {
        changed.sort();
        await audit.log({ entityType: "invoice_scan_settings", entityId: null, action: "updated", detail: { keys: changed }, userId });
      }
      return view();
    },

    // Testa anslutning: a minimal call with the key typed in the form (else
    // the saved one) and the chosen model (else the saved one). Nothing is
    // saved — the form stores the key through update() on Spara.
    async testAi(input: TestInvoiceScanAiInput = {}) {
      const saved = await read();
      const apiKey = input.apiKey && input.apiKey.trim() !== "" ? input.apiKey.trim() : saved.aiApiKey;
      if (!apiKey) throw new InvoiceScanAiTestFailedError(AI_TEXTS.testNoKey);
      const model = input.model ?? saved.aiModel;
      try {
        await interpreters({ apiKey, model }).testConnection();
      } catch (err) {
        throw new InvoiceScanAiTestFailedError(aiErrorText(err));
      }
      return { ok: true as const, model };
    },
  };
}

export type InvoiceScanSettingsService = ReturnType<typeof createInvoiceScanSettingsService>;
