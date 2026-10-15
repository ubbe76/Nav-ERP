import {
  BANK_PROFILE_IDS,
  DEBIT_ACCOUNT_KINDS,
  isLuhnValid,
  isValidIban,
  normalizeDigits,
  type BankProfileId,
  type DebitAccountKind,
  type UpdateBankSettingsInput,
} from "@navet/shared";
import type { Db, Tx } from "@navet/db";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { BankSettingsRepository } from "../repository/bank-settings.repository.js";
import { BankSettingsIncompleteError, InvalidBankSettingError } from "./banking.errors.js";
import { BANK_PROFILES, bankProfile, type BankProfile } from "./iso20022/bank-profiles.js";
import { townName } from "./iso20022/pain001-builder.js";

const KEYS = {
  profile: "bank_profile",
  initiatingPartyId: "bank_initiating_party_id",
  debtorAgreementId: "bank_debtor_agreement_id",
  debitAccountKind: "bank_debit_account_kind",
} as const;

export interface BankSettings {
  profile: BankProfileId | null;
  initiatingPartyId: string | null;
  debtorAgreementId: string | null;
  debitAccountKind: DebitAccountKind | null;
}
export interface CompanyBankFields {
  name: string;
  orgNumber: string | null;
  postalCode: string | null;
  city: string | null;
  iban: string | null;
  bic: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
}
export interface BankReady {
  profile: BankProfile;
  settings: BankSettings;
  company: CompanyBankFields;
  debitAccount: { kind: DebitAccountKind; value: string };
  // The initiating-party id the file carries: the stored one, else the
  // profile's fallback (org number), always normalized.
  initiatingPartyId: string;
}
export interface BankProfileView {
  id: BankProfileId;
  name: string;
  verified: boolean;
  initiatingPartyLabel: string;
  initiatingPartyRequired: boolean;
  debtorAgreementLabel: string | null;
  debitAccountKinds: readonly DebitAccountKind[];
}
export interface BankSettingsView extends BankSettings {
  profiles: BankProfileView[];
  company: CompanyBankFields;
  missing: string[];
}

// Hyphens, spaces and case never reach the file or the format checks — same
// rule as the supplier payment details (normalizeSupplierPaymentDetails).
function normalizeId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const id = value.replace(/[\s-]/g, "").toUpperCase();
  return id === "" ? null : id;
}

const KIND_LABEL: Record<DebitAccountKind, string> = { iban: "IBAN", bankgiro: "Bankgiro", plusgiro: "Plusgiro" };

function companyValue(company: CompanyBankFields, kind: DebitAccountKind): string | null {
  const raw = company[kind];
  if (!raw || raw.trim() === "") return null;
  return kind === "iban" ? raw.replace(/\s/g, "").toUpperCase() : normalizeDigits(raw);
}

function resolveInitiatingPartyId(profile: BankProfile, settings: BankSettings, company: CompanyBankFields): string | null {
  return settings.initiatingPartyId ?? (profile.initiatingParty.fallback === "orgNumber" ? (company.orgNumber ?? "").replace(/\D/g, "") || null : null);
}

// The checklist /system/bank shows and BankSettingsIncompleteError carries.
export function bankSettingsProblems(settings: BankSettings, company: CompanyBankFields): string[] {
  if (!settings.profile) return ["Bank är inte vald"];
  const profile = bankProfile(settings.profile);
  const problems: string[] = [];
  const id = resolveInitiatingPartyId(profile, settings, company);
  if (!id) problems.push(`${profile.initiatingParty.label} saknas`);
  // Max35Text in the file — the same limit checkPain001 applies, which the
  // free-text banks' (SEB, Handelsbanken) missing pattern would not catch.
  else if (id.length > 35) problems.push(`${profile.initiatingParty.label} har fel format`);
  else if (settings.initiatingPartyId && profile.initiatingParty.pattern && !profile.initiatingParty.pattern.test(settings.initiatingPartyId)) {
    problems.push(`${profile.initiatingParty.label} har fel format`);
  }
  if (!settings.debitAccountKind) problems.push("Debiteringskonto är inte valt");
  else if (!profile.debitAccountKinds.includes(settings.debitAccountKind)) {
    problems.push(`${profile.name} tar inte ${KIND_LABEL[settings.debitAccountKind]} som debiteringskonto`);
  } else if (!companyValue(company, settings.debitAccountKind)) {
    problems.push(`${KIND_LABEL[settings.debitAccountKind]} saknas i Företagsinformation`);
  } else {
    // The same validity checkPain001 applies to the debit account, so a
    // "ready" company never yields a file the structural check rejects.
    const value = companyValue(company, settings.debitAccountKind)!;
    const label = KIND_LABEL[settings.debitAccountKind];
    if (settings.debitAccountKind === "iban") {
      if (!isValidIban(value)) problems.push(`${label} är ogiltigt i Företagsinformation`);
      else if (!value.startsWith("SE")) problems.push("Bara svenskt IBAN (SE…) stöds som debiteringskonto i Företagsinformation");
    } else {
      const shape = settings.debitAccountKind === "bankgiro" ? /^\d{7,8}$/ : /^\d{2,8}$/;
      if (!(shape.test(value) && isLuhnValid(value))) problems.push(`${label} är ogiltigt i Företagsinformation`);
    }
  }
  if (!company.name || company.name.trim() === "") problems.push("Företagets namn saknas i Företagsinformation");
  // The same test checkPain001 applies: a city nothing of which survives the
  // bank's character set ("   ", an emoji) is written as no TwnNm at all.
  if (profile.address.creditorTownRequired && townName(company.city, profile) === "") problems.push("Ort saknas i Företagsinformation");
  return problems;
}

function profileView(profile: BankProfile): BankProfileView {
  return {
    id: profile.id,
    name: profile.name,
    verified: profile.verified,
    initiatingPartyLabel: profile.initiatingParty.label,
    initiatingPartyRequired: profile.initiatingParty.required,
    debtorAgreementLabel: profile.debtorIdentification?.label ?? null,
    debitAccountKinds: profile.debitAccountKinds,
  };
}

export function createBankSettingsService(deps: { repo: BankSettingsRepository; audit: AuditWriter }) {
  const { repo, audit } = deps;

  async function readSettings(executor?: Db | Tx): Promise<BankSettings> {
    const raw = await repo.readSettings(executor);
    const profile = raw.get(KEYS.profile);
    const kind = raw.get(KEYS.debitAccountKind);
    return {
      profile: (BANK_PROFILE_IDS as readonly string[]).includes(profile ?? "") ? (profile as BankProfileId) : null,
      initiatingPartyId: normalizeId(raw.get(KEYS.initiatingPartyId)),
      debtorAgreementId: normalizeId(raw.get(KEYS.debtorAgreementId)),
      debitAccountKind: (DEBIT_ACCOUNT_KINDS as readonly string[]).includes(kind ?? "") ? (kind as DebitAccountKind) : null,
    };
  }

  const service = {
    async read(): Promise<BankSettingsView> {
      const [settings, company] = await Promise.all([readSettings(), repo.readCompany()]);
      return {
        ...settings,
        profiles: BANK_PROFILE_IDS.map((id) => profileView(BANK_PROFILES[id])),
        company,
        missing: bankSettingsProblems(settings, company),
      };
    },

    async update(input: UpdateBankSettingsInput, userId: string): Promise<BankSettingsView> {
      const current = await readSettings();
      const next: BankSettings = {
        profile: input.profile !== undefined ? input.profile : current.profile,
        initiatingPartyId: input.initiatingPartyId !== undefined ? normalizeId(input.initiatingPartyId) : current.initiatingPartyId,
        debtorAgreementId: input.debtorAgreementId !== undefined ? normalizeId(input.debtorAgreementId) : current.debtorAgreementId,
        debitAccountKind: input.debitAccountKind ?? current.debitAccountKind,
      };
      if (next.profile) {
        const profile = bankProfile(next.profile);
        if (input.debitAccountKind !== undefined && !profile.debitAccountKinds.includes(input.debitAccountKind)) {
          throw new InvalidBankSettingError(`${profile.name} tar inte ${KIND_LABEL[input.debitAccountKind]} som debiteringskonto`);
        }
        // A new bank that does not take the stored kind: its first kind.
        if (next.debitAccountKind === null || !profile.debitAccountKinds.includes(next.debitAccountKind)) {
          next.debitAccountKind = profile.debitAccountKinds[0]!;
        }
        if (next.initiatingPartyId && profile.initiatingParty.pattern && !profile.initiatingParty.pattern.test(next.initiatingPartyId)) {
          throw new InvalidBankSettingError(`${profile.initiatingParty.label} har fel format`);
        }
      }
      const changed: string[] = [];
      for (const key of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
        if (next[key] !== current[key]) {
          await repo.setSetting(KEYS[key], next[key]);
          changed.push(KEYS[key]);
        }
      }
      if (changed.length > 0) {
        // Key names only, never values — the freight settings' rule.
        await audit.log({ entityType: "bank_settings", entityId: "bank", action: "updated", detail: { changed }, userId });
      }
      return service.read();
    },

    // Every path that builds or confirms a payment file starts here (Db or
    // the caller's Tx): the settings and the company details are read live.
    async assertReady(executor?: Db | Tx): Promise<BankReady> {
      const [settings, company] = await Promise.all([readSettings(executor), repo.readCompany(executor)]);
      const missing = bankSettingsProblems(settings, company);
      if (missing.length > 0) throw new BankSettingsIncompleteError(missing);
      const kind = settings.debitAccountKind!;
      const profile = bankProfile(settings.profile!);
      return {
        profile,
        settings,
        company,
        debitAccount: { kind, value: companyValue(company, kind)! },
        initiatingPartyId: resolveInitiatingPartyId(profile, settings, company)!,
      };
    },
  };
  return service;
}

export type BankSettingsService = ReturnType<typeof createBankSettingsService>;
