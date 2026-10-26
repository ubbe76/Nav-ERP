import {
  INVOICE_SCAN_AI_MODEL_DEFAULT,
  INVOICE_SCAN_AI_MODELS,
  INVOICE_SCAN_AI_MODES,
  INVOICE_SCAN_MAIL_FOLDER_DEFAULT,
  INVOICE_SCAN_MAIL_INTERVAL_DEFAULT,
  INVOICE_SCAN_MAIL_PORT_DEFAULT,
  INVOICE_SCAN_MAIL_PROCESSED_FOLDER_DEFAULT,
  type InvoiceScanAiMode,
  type InvoiceScanAiModel,
  type InvoiceScanSettingsView,
  type UpdateInvoiceScanSettingsInput,
} from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { InvoiceScanRepository } from "../repository/invoice-scan.repository.js";

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

export function createInvoiceScanSettingsService(deps: { repo: InvoiceScanRepository; audit: AuditWriter }) {
  const { repo, audit } = deps;
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
  };
}

export type InvoiceScanSettingsService = ReturnType<typeof createInvoiceScanSettingsService>;
