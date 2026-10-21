import type { CreateRegisterEntryInput, PackageTypeFreightInput, UpdateRegisterEntryInput } from "@navet/shared";
import type { RegisterRepository } from "../repository/register.repository.js";
import type { RegisterUsage } from "./register.errors.js";
import {
  DuplicateRegisterEntryError,
  InvalidReplacementError,
  RegisterEntryInUseError,
  RegisterEntryNotFoundError,
} from "./register.errors.js";

// The error classes live in register.errors.ts (the repository throws one of
// them too); re-exported here so routes and tests keep their import path.
export {
  DuplicateRegisterEntryError,
  InvalidReplacementError,
  RegisterEntryInUseError,
  RegisterEntryNotFoundError,
} from "./register.errors.js";
export type { RegisterUsage } from "./register.errors.js";

// Combiterms 2020 (built on the eleven Incoterms 2020 terms) — the standard
// Swedish delivery-term register content. Used to pre-fill delivery_terms;
// existing entries are never overwritten.
// The descriptions are duplicated in migration 0067's backfill UPDATEs (the
// STANDARD_UNITS/0033 precedent) — keep the two in sync if the wording moves.
export const COMBITERMS: { code: string; name: string; description: string }[] = [
  { code: "EXW", name: "Från fabrik", description: "Köparen hämtar godset hos säljaren och står för hela transporten, exportklareringen och alla kostnader och risker." },
  { code: "FCA", name: "Fritt fraktföraren", description: "Säljaren lämnar godset exportklarerat till köparens fraktförare på angiven plats; därefter tar köparen över risk och kostnad." },
  { code: "FAS", name: "Fritt fartygets sida", description: "Säljaren levererar godset vid fartygets sida i avskeppningshamnen; köparen står för lastning, sjöfrakt och risk därifrån." },
  { code: "FOB", name: "Fritt ombord", description: "Säljaren lastar godset ombord på fartyget i avskeppningshamnen; köparen står för sjöfrakt och risk från ombordlastningen." },
  { code: "CFR", name: "Kostnad och frakt", description: "Säljaren betalar frakten till ankomsthamnen, men risken går över till köparen redan vid ombordlastningen." },
  { code: "CIF", name: "Kostnad, försäkring och frakt", description: "Som CFR, men säljaren tecknar även transportförsäkring för godset till ankomsthamnen." },
  { code: "CPT", name: "Fraktfritt", description: "Säljaren betalar frakten till angiven destination, men risken går över när godset lämnas till den förste fraktföraren." },
  { code: "CIP", name: "Fraktfritt inklusive försäkring", description: "Som CPT, men säljaren tecknar även transportförsäkring för godset till destinationen." },
  { code: "DAP", name: "Levererat angiven plats", description: "Säljaren står för transporten till angiven plats; köparen sköter lossning och importklarering." },
  { code: "DPU", name: "Levererat angiven plats, urlastat", description: "Säljaren står för transporten och lossningen på angiven plats; köparen sköter importklareringen." },
  { code: "DDP", name: "Levererat förtullat", description: "Säljaren står för hela transporten inklusive importklarering och tull; köparen tar bara emot på angiven plats." },
];

// Standard units (enheter) — pre-fill for the units register; existing
// entries are never overwritten. The migration seeds the same list, so a
// fresh database always has "st" (the default base unit for new articles).
export const STANDARD_UNITS: { code: string; name: string }[] = [
  { code: "st", name: "Styck" },
  { code: "kg", name: "Kilogram" },
  { code: "g", name: "Gram" },
  { code: "m", name: "Meter" },
  { code: "m2", name: "Kvadratmeter" },
  { code: "m3", name: "Kubikmeter" },
  { code: "l", name: "Liter" },
  { code: "tim", name: "Timme" },
  { code: "förp", name: "Förpackning" },
];

// Standard kollityper (package types) — idempotent pre-fill for the register.
// Footprint + tare weight; the height depends on the load.
function pallet(lengthMm: number, widthMm: number, tareWeight: number): PackageTypeFreightInput {
  return { parcelKind: "pallet", lengthMm, widthMm, heightMm: null, tareWeight, stackable: false, loadingMeters: null };
}

export const STANDARD_PACKAGE_TYPES: { code: string; name: string; freight?: PackageTypeFreightInput }[] = [
  { code: "EUR", name: "EUR-pall", freight: pallet(1200, 800, 25) },
  { code: "HALV", name: "Halvpall", freight: pallet(800, 600, 10) },
  { code: "KVART", name: "Kvartspall", freight: pallet(600, 400, 5) },
  { code: "KRT", name: "Kartong" },
  { code: "KOLLI", name: "Kolli" },
  { code: "BUR", name: "Rullbur" },
  { code: "LÅDA", name: "Låda" },
  { code: "SÄCK", name: "Säck" },
];

// What a register's repository accessor must offer — the terms registers
// (CreateRegisterEntryInput) and förlustorsaker (QuoteLossReasonInput) both
// fit; only the row/input shapes differ.
interface RegisterEntries<TInput extends { code: string; name: string }, TRow extends { id: string; code: string }> {
  list(): Promise<TRow[]>;
  findById(id: string): Promise<TRow | null>;
  findByCode(code: string): Promise<TRow | null>;
  findByName(name: string): Promise<TRow | null>;
  create(input: TInput): Promise<TRow>;
  update(id: string, input: TInput): Promise<TRow | null>;
  exists(id: string): Promise<boolean>;
  countReferences(id: string): Promise<RegisterUsage>;
  deleteWithReassign(id: string, replacementId: string | null): Promise<{ moved: { table: string; count: number }[] } | null>;
}

export function createRegisterService(repo: RegisterRepository) {
  function forRegister<TInput extends { code: string; name: string }, TRow extends { id: string; code: string }>(
    entries: RegisterEntries<TInput, TRow>
  ) {
    return {
      async list() {
        return entries.list();
      },

      async create(input: TInput) {
        if (await entries.findByCode(input.code)) throw new DuplicateRegisterEntryError("code", input.code);
        if (await entries.findByName(input.name)) throw new DuplicateRegisterEntryError("name", input.name);
        return entries.create(input);
      },

      async update(id: string, input: TInput) {
        // An entry may keep its own code/name — conflicts only count on a
        // different row (same rule as article groups).
        const byCode = await entries.findByCode(input.code);
        if (byCode && byCode.id !== id) throw new DuplicateRegisterEntryError("code", input.code);
        const byName = await entries.findByName(input.name);
        if (byName && byName.id !== id) throw new DuplicateRegisterEntryError("name", input.name);

        const row = await entries.update(id, input);
        if (!row) throw new RegisterEntryNotFoundError(id);
        return row;
      },

      async exists(id: string) {
        return entries.exists(id);
      },

      async findById(id: string) {
        return entries.findById(id);
      },

      // What still points at the entry — the UI decides from this whether
      // deletion needs a replacement.
      async usage(id: string) {
        if (!(await entries.exists(id))) throw new RegisterEntryNotFoundError(id);
        return entries.countReferences(id);
      },

      // Deletes the entry; when it is referenced, `replacementId` (another
      // entry of the SAME register) is required and every referencing row —
      // partners and documents alike — is moved to it first. Checking the
      // replacement against this register's own table is what enforces
      // "same register": an id from another register simply does not exist here.
      async remove(id: string, replacementId?: string | null) {
        const entry = await entries.findById(id);
        if (!entry) throw new RegisterEntryNotFoundError(id);
        if (replacementId) {
          if (replacementId === id) throw new InvalidReplacementError("same");
          if (!(await entries.exists(replacementId))) throw new InvalidReplacementError("unknown");
        }
        const usage = await entries.countReferences(id);
        if (usage.total > 0 && !replacementId) throw new RegisterEntryInUseError(entry.code, usage);
        const result = await entries.deleteWithReassign(id, replacementId ?? null);
        if (!result) throw new RegisterEntryNotFoundError(id);
        return result;
      },
    };
  }

  return {
    deliveryTerms: forRegister<CreateRegisterEntryInput, Awaited<ReturnType<RegisterRepository["deliveryTerms"]["create"]>>>(repo.deliveryTerms),
    paymentTerms: forRegister<CreateRegisterEntryInput, Awaited<ReturnType<RegisterRepository["paymentTerms"]["create"]>>>(repo.paymentTerms),
    carriers: forRegister<CreateRegisterEntryInput, Awaited<ReturnType<RegisterRepository["carriers"]["create"]>>>(repo.carriers),
    units: forRegister<CreateRegisterEntryInput, Awaited<ReturnType<RegisterRepository["units"]["create"]>>>(repo.units),
    packageTypes: forRegister<CreateRegisterEntryInput, Awaited<ReturnType<RegisterRepository["packageTypes"]["create"]>>>(repo.packageTypes),
    // Förlustorsaker (uppföljning av offerter): same CRUD/usage/delete flow,
    // its own input shape (code/name/active).
    quoteLossReasons: forRegister(repo.quoteLossReasons),

    // Idempotent: creates the Combiterms entries that are missing and skips
    // the rest, so customized codes/names survive re-runs.
    async seedCombiterms() {
      let created = 0;
      for (const term of COMBITERMS) {
        if (await repo.deliveryTerms.createIfMissing(term)) created++;
      }
      return { created, skipped: COMBITERMS.length - created };
    },

    // Same idempotent pre-fill for the units register.
    async seedStandardUnits() {
      let created = 0;
      for (const unit of STANDARD_UNITS) {
        if (await repo.units.createIfMissing(unit)) created++;
      }
      return { created, skipped: STANDARD_UNITS.length - created };
    },

    async updatePackageTypeFreight(id: string, input: PackageTypeFreightInput) {
      const row = await repo.updatePackageTypeFreight(id, input);
      if (!row) throw new RegisterEntryNotFoundError(id);
      return row;
    },

    // Same idempotent pre-fill for the package-types register.
    async seedStandardPackageTypes() {
      let created = 0;
      for (const pkg of STANDARD_PACKAGE_TYPES) {
        if (await repo.packageTypes.createIfMissing({ code: pkg.code, name: pkg.name })) {
          created++;
          if (pkg.freight) {
            const row = await repo.packageTypes.findByCode(pkg.code);
            if (row) await repo.updatePackageTypeFreight(row.id, pkg.freight);
          }
        }
      }
      return { created, skipped: STANDARD_PACKAGE_TYPES.length - created };
    },
  };
}

export type RegisterService = ReturnType<typeof createRegisterService>;

// The subset sales/purchase need to validate references on customers/suppliers
// — plus the förlustorsak lookup Förlorad needs (sales only).
export interface RegisterReferenceReader {
  deliveryTerms: { exists(id: string): Promise<boolean> };
  paymentTerms: { exists(id: string): Promise<boolean> };
  carriers: { exists(id: string): Promise<boolean> };
  quoteLossReasons: { findById(id: string): Promise<{ id: string; code: string; name: string; active: boolean } | null> };
}
