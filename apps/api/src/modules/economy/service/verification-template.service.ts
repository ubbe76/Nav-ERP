import { round2, type CreateVerificationTemplateInput, type UpdateVerificationTemplateInput, type VerificationTemplateRowInput } from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import type {
  TemplateHeaderPatch,
  TemplateRowWrite,
  VerificationTemplateRepository,
  VerificationTemplateView,
} from "../repository/verification-template.repository.js";
import type { EconomyRepository } from "../repository/economy.repository.js";
import { VerificationNotFoundError, VerificationSeriesNotFoundError, displayNumber } from "./economy.service.js";

// Verifikatmallar (snabbare manuell bokföring, etapp 3). A template is a
// header (name, series, description) plus rows with account numbers and
// optional amounts; Ny från mall fills the editor with it, a recurring post
// books it every month. Nothing here touches verifications.

export class VerificationTemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`Verification template ${id} not found`);
    this.name = "VerificationTemplateNotFoundError";
  }
}

export class VerificationTemplateNameTakenError extends Error {
  constructor(name: string) {
    super(`Det finns redan en verifikatmall med namnet "${name}"`);
    this.name = "VerificationTemplateNameTakenError";
  }
}

// One or more rows name an account the chart lacks — `accounts` lists them so
// the editor can point at the rows.
export class VerificationTemplateAccountMissingError extends Error {
  constructor(public readonly accounts: string[]) {
    super(`Kontot ${accounts.join(", ")} finns inte i kontoplanen`);
    this.name = "VerificationTemplateAccountMissingError";
  }
}

// A recurring post still books from the template; remove the post first.
export class VerificationTemplateInUseError extends Error {
  constructor(id: string) {
    super(`Verification template ${id} is used by a recurring verification`);
    this.name = "VerificationTemplateInUseError";
  }
}

// Zod has guaranteed the shape (never both sides); null/omitted/0 all mean
// "no amount", stored as null.
export function toTemplateRowWrite(row: VerificationTemplateRowInput): TemplateRowWrite {
  const debit = row.debit !== null && row.debit !== undefined && row.debit > 0 ? round2(row.debit) : null;
  const credit = row.credit !== null && row.credit !== undefined && row.credit > 0 ? round2(row.credit) : null;
  return {
    accountNumber: row.accountNumber,
    description: row.description && row.description.length > 0 ? row.description : null,
    debit,
    credit,
    costCenterId: row.costCenterId ?? null,
    projectId: row.projectId ?? null,
  };
}

export function createVerificationTemplateService(deps: {
  repo: VerificationTemplateRepository;
  economy: EconomyRepository;
  audit: AuditWriter;
}) {
  const { repo, economy, audit } = deps;

  async function requireExistingAccounts(rows: TemplateRowWrite[]) {
    const numbers = [...new Set(rows.map((r) => r.accountNumber))];
    const existing = await repo.existingAccountNumbers(numbers);
    const missing = numbers.filter((n) => !existing.has(n));
    if (missing.length > 0) throw new VerificationTemplateAccountMissingError(missing);
  }

  // Kostnadsställen och projekt: every object a template names must exist
  // and be pickable (active / open) — the same rule as a verification row.
  async function requireDimensions(rows: TemplateRowWrite[]) {
    for (const row of rows) {
      if (row.costCenterId === null && row.projectId === null) continue;
      await economy.resolveRowDimensions({ costCenterId: row.costCenterId, projectId: row.projectId });
    }
  }

  async function requireSeries(seriesId: string) {
    if (!(await economy.findSeriesById(seriesId))) throw new VerificationSeriesNotFoundError(seriesId);
  }

  async function detail(id: string): Promise<VerificationTemplateView> {
    const template = await repo.findById(id);
    if (!template) throw new VerificationTemplateNotFoundError(id);
    return template;
  }

  const service = {
    async list(includeInactive: boolean) {
      return repo.list(includeInactive);
    },

    findById: detail,

    async create(input: CreateVerificationTemplateInput, userId: string | null) {
      await requireSeries(input.seriesId);
      const rows = input.rows.map(toTemplateRowWrite);
      await requireExistingAccounts(rows);
      await requireDimensions(rows);
      let id: string;
      try {
        id = await repo.create({ name: input.name, seriesId: input.seriesId, description: input.description }, rows, userId);
      } catch (err) {
        if (isUniqueViolation(err)) throw new VerificationTemplateNameTakenError(input.name);
        throw err;
      }
      await audit.log({ entityType: "verification_template", entityId: input.name, action: "created", userId });
      return detail(id);
    },

    async update(id: string, input: UpdateVerificationTemplateInput, userId: string | null) {
      const existing = await repo.findById(id);
      if (!existing) throw new VerificationTemplateNotFoundError(id);
      if (input.seriesId !== undefined) await requireSeries(input.seriesId);
      const rows = input.rows?.map(toTemplateRowWrite);
      if (rows) {
        await requireExistingAccounts(rows);
        await requireDimensions(rows);
      }

      const patch: TemplateHeaderPatch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.seriesId !== undefined) patch.seriesId = input.seriesId;
      if (input.description !== undefined) patch.description = input.description;
      if (input.active !== undefined) patch.active = input.active;
      try {
        const updated = await repo.update(id, patch, rows);
        if (!updated) throw new VerificationTemplateNotFoundError(id);
      } catch (err) {
        if (isUniqueViolation(err)) throw new VerificationTemplateNameTakenError(input.name ?? existing.name);
        throw err;
      }
      await audit.log({
        entityType: "verification_template",
        entityId: input.name ?? existing.name,
        action: "updated",
        detail: { fields: Object.keys(input) },
        userId,
      });
      return detail(id);
    },

    async delete(id: string, userId: string | null) {
      const existing = await repo.findById(id);
      if (!existing) throw new VerificationTemplateNotFoundError(id);
      if (await repo.usedByRecurring(id)) throw new VerificationTemplateInUseError(id);
      try {
        const deleted = await repo.delete(id);
        if (!deleted) throw new VerificationTemplateNotFoundError(id);
      } catch (err) {
        // The restrict FK is the real guard behind the pre-check above.
        if (isForeignKeyViolation(err)) throw new VerificationTemplateInUseError(id);
        throw err;
      }
      await audit.log({ entityType: "verification_template", entityId: existing.name, action: "deleted", userId });
    },

    // Spara som mall: the verification's series, description and rows
    // (account numbers + amounts) become a template. Any status.
    async saveFromVerification(verificationId: string, name: string, userId: string | null) {
      const verification = await economy.findVerificationById(verificationId);
      if (!verification) throw new VerificationNotFoundError(verificationId);
      const rows: TemplateRowWrite[] = verification.rows.map((row) => ({
        accountNumber: row.accountNumber,
        description: row.description,
        debit: Number(row.debit) > 0 ? round2(Number(row.debit)) : null,
        credit: Number(row.credit) > 0 ? round2(Number(row.credit)) : null,
        costCenterId: row.costCenterId,
        projectId: row.projectId,
      }));
      let id: string;
      try {
        id = await repo.create({ name, seriesId: verification.seriesId, description: verification.description }, rows, userId);
      } catch (err) {
        if (isUniqueViolation(err)) throw new VerificationTemplateNameTakenError(name);
        throw err;
      }
      await audit.log({
        entityType: "verification_template",
        entityId: name,
        action: "created",
        detail: { fromVerification: displayNumber(verification) },
        userId,
      });
      return detail(id);
    },
  };

  return service;
}

export type VerificationTemplateService = ReturnType<typeof createVerificationTemplateService>;
