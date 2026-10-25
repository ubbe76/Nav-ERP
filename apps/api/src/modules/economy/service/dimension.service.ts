import type {
  CostCenterView,
  CreateCostCenterInput,
  CreateProjectInput,
  ListCostCentersQuery,
  ListProjectsQuery,
  ProjectView,
  UpdateCostCenterInput,
  UpdateProjectInput,
} from "@navet/shared";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { InvalidReplacementError, RegisterEntryInUseError, type RegisterUsage } from "../../register/service/register.errors.js";
import type { CostCenterRow, DimensionRepository, ProjectRow } from "../repository/dimension.repository.js";
import { CostCenterNotFoundError, DimensionBookedError, ProjectNotFoundError } from "./dimension-check.js";

// Kostnadsställen och projekt (etapp 5 del A): the two registers under
// Ekonomi. The code is the SIE object code and unique per register (409
// *-code-taken); deletion follows the base-data registers (usage, move to a
// replacement, 409 when referenced without one) with one extra rule — an
// object on booked verification rows cannot be deleted at all
// (DimensionBookedError), since booked bookkeeping is immutable.

export { InvalidReplacementError, RegisterEntryInUseError } from "../../register/service/register.errors.js";
export { CostCenterNotFoundError, DimensionBookedError, ProjectNotFoundError } from "./dimension-check.js";

export class CostCenterCodeTakenError extends Error {
  constructor(code: string) {
    super(`A cost center with code ${code} already exists`);
    this.name = "CostCenterCodeTakenError";
  }
}

export class ProjectCodeTakenError extends Error {
  constructor(code: string) {
    super(`A project with code ${code} already exists`);
    this.name = "ProjectCodeTakenError";
  }
}

// The project's customer must exist (the FK is set null on delete, but an
// unknown id on create/PATCH is the client's mistake, not a 500).
export class ProjectCustomerNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer ${id} not found`);
    this.name = "ProjectCustomerNotFoundError";
  }
}

export function costCenterView(row: CostCenterRow): CostCenterView {
  return { id: row.id, code: row.code, name: row.name, active: row.active };
}

export function projectView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    status: row.status,
    customerId: row.customerId,
    customerName: row.customerName,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

export function createDimensionService(repo: DimensionRepository, audit: AuditWriter) {
  // Deletion shared by both registers: the replacement must be another
  // entry of the same register, and a referenced entry needs one.
  async function remove<TRow extends { id: string; code: string }>(
    entries: {
      findById(id: string): Promise<TRow | null>;
      countReferences(id: string): Promise<RegisterUsage>;
      hasBookedRows(id: string): Promise<boolean>;
      deleteWithReassign(entry: { id: string; code: string }, replacementId: string | null): Promise<{ moved: { table: string; count: number }[] }>;
    },
    kind: "costCenter" | "project",
    notFound: (id: string) => Error,
    id: string,
    replacementId: string | null
  ) {
    const entry = await entries.findById(id);
    if (!entry) throw notFound(id);
    if (replacementId) {
      if (replacementId === id) throw new InvalidReplacementError("same");
      if (!(await entries.findById(replacementId))) throw new InvalidReplacementError("unknown");
    }
    // Booked rows first: that object can never be deleted, replacement or not.
    if (await entries.hasBookedRows(id)) throw new DimensionBookedError(kind, entry.code);
    const usage = await entries.countReferences(id);
    if (usage.total > 0 && !replacementId) throw new RegisterEntryInUseError(entry.code, usage);
    return entries.deleteWithReassign(entry, replacementId);
  }

  return {
    costCenters: {
      async list(query: ListCostCentersQuery) {
        const { rows, total } = await repo.costCenters.list(query);
        return { rows: rows.map(costCenterView), total };
      },

      async get(id: string) {
        const row = await repo.costCenters.findById(id);
        if (!row) throw new CostCenterNotFoundError(id);
        return costCenterView(row);
      },

      async create(input: CreateCostCenterInput, userId: string | null) {
        if (await repo.costCenters.findByCode(input.code)) throw new CostCenterCodeTakenError(input.code);
        let row;
        try {
          row = await repo.costCenters.create({ code: input.code, name: input.name, active: input.active });
        } catch (err) {
          if (isUniqueViolation(err)) throw new CostCenterCodeTakenError(input.code);
          throw err;
        }
        await audit.log({ entityType: "cost_center", entityId: row.code, action: "created", detail: { name: row.name }, userId });
        return costCenterView(row);
      },

      async update(id: string, input: UpdateCostCenterInput, userId: string | null) {
        const existing = await repo.costCenters.findById(id);
        if (!existing) throw new CostCenterNotFoundError(id);
        if (input.code !== undefined) {
          const byCode = await repo.costCenters.findByCode(input.code);
          if (byCode && byCode.id !== id) throw new CostCenterCodeTakenError(input.code);
        }
        let row;
        try {
          row = await repo.costCenters.update(id, input);
        } catch (err) {
          if (isUniqueViolation(err)) throw new CostCenterCodeTakenError(input.code ?? existing.code);
          throw err;
        }
        if (!row) throw new CostCenterNotFoundError(id);
        await audit.log({ entityType: "cost_center", entityId: row.code, action: "updated", detail: { before: costCenterView(existing), after: costCenterView(row) }, userId });
        return costCenterView(row);
      },

      async usage(id: string) {
        if (!(await repo.costCenters.findById(id))) throw new CostCenterNotFoundError(id);
        return repo.costCenters.countReferences(id);
      },

      async remove(id: string, replacementId: string | null, userId: string | null) {
        const result = await remove(repo.costCenters, "costCenter", (missing) => new CostCenterNotFoundError(missing), id, replacementId);
        await audit.log({ entityType: "cost_center", entityId: id, action: "deleted", detail: { replacementId, moved: result.moved }, userId });
        return result;
      },
    },

    projects: {
      async list(query: ListProjectsQuery) {
        const { rows, total } = await repo.projects.list(query);
        return { rows: rows.map(projectView), total };
      },

      async get(id: string) {
        const row = await repo.projects.findById(id);
        if (!row) throw new ProjectNotFoundError(id);
        return projectView(row);
      },

      async create(input: CreateProjectInput, userId: string | null) {
        if (await repo.projects.findByCode(input.code)) throw new ProjectCodeTakenError(input.code);
        if (input.customerId && !(await repo.projects.customerExists(input.customerId))) throw new ProjectCustomerNotFoundError(input.customerId);
        let row;
        try {
          row = await repo.projects.create({
            code: input.code,
            name: input.name,
            active: input.active,
            status: input.status,
            customerId: input.customerId ?? null,
            startDate: input.startDate ?? null,
            endDate: input.endDate ?? null,
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw new ProjectCodeTakenError(input.code);
          throw err;
        }
        await audit.log({ entityType: "project", entityId: row.code, action: "created", detail: { name: row.name }, userId });
        return projectView(row);
      },

      async update(id: string, input: UpdateProjectInput, userId: string | null) {
        const existing = await repo.projects.findById(id);
        if (!existing) throw new ProjectNotFoundError(id);
        if (input.code !== undefined) {
          const byCode = await repo.projects.findByCode(input.code);
          if (byCode && byCode.id !== id) throw new ProjectCodeTakenError(input.code);
        }
        if (input.customerId && !(await repo.projects.customerExists(input.customerId))) throw new ProjectCustomerNotFoundError(input.customerId);
        // The date rule holds on the MERGED state, like the create refine.
        const startDate = input.startDate !== undefined ? input.startDate : existing.startDate;
        const endDate = input.endDate !== undefined ? input.endDate : existing.endDate;
        if (startDate && endDate && endDate < startDate) throw new ProjectDatesError();
        let row;
        try {
          row = await repo.projects.update(id, input);
        } catch (err) {
          if (isUniqueViolation(err)) throw new ProjectCodeTakenError(input.code ?? existing.code);
          throw err;
        }
        if (!row) throw new ProjectNotFoundError(id);
        await audit.log({ entityType: "project", entityId: row.code, action: "updated", detail: { before: projectView(existing), after: projectView(row) }, userId });
        return projectView(row);
      },

      async usage(id: string) {
        if (!(await repo.projects.findById(id))) throw new ProjectNotFoundError(id);
        return repo.projects.countReferences(id);
      },

      async remove(id: string, replacementId: string | null, userId: string | null) {
        const result = await remove(repo.projects, "project", (missing) => new ProjectNotFoundError(missing), id, replacementId);
        await audit.log({ entityType: "project", entityId: id, action: "deleted", detail: { replacementId, moved: result.moved }, userId });
        return result;
      },
    },
  };
}

// 400: a PATCH that would put the end date before the start date.
export class ProjectDatesError extends Error {
  constructor() {
    super("endDate must not be before startDate");
    this.name = "ProjectDatesError";
  }
}

export type DimensionService = ReturnType<typeof createDimensionService>;
