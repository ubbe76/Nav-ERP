import { z } from "zod";
import { listQuerySchema } from "./list.js";

// Kostnadsställen och projekt (bokföringsgranskningen etapp 5 del A): the
// two fixed SIE dimensions — 1 Kostnadsställe, 6 Projekt — as registers under
// Ekonomi, and the pair of nullable ids every dimension-carrying row and
// header takes. Rules (the service enforces them): the code is the SIE
// object code, 1–20 characters, unique per register; an inactive cost center
// or a closed project cannot be picked on a NEW row but stays on the rows
// that already carry it.

const dimensionCodeSchema = z.string().trim().min(1).max(20);
const dimensionNameSchema = z.string().trim().min(1).max(100);

// NOT z.coerce.boolean() — the string "false" would become true (the same
// pitfall as every other includeInactive query param).
const includeInactiveParam = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

export const createCostCenterSchema = z.object({
  code: dimensionCodeSchema,
  name: dimensionNameSchema,
  active: z.boolean().default(true),
});
export type CreateCostCenterInput = z.infer<typeof createCostCenterSchema>;

export const updateCostCenterSchema = z
  .object({
    code: dimensionCodeSchema.optional(),
    name: dimensionNameSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateCostCenterInput = z.infer<typeof updateCostCenterSchema>;

export const listCostCentersQuerySchema = listQuerySchema.extend({ includeInactive: includeInactiveParam });
export type ListCostCentersQuery = z.infer<typeof listCostCentersQuerySchema>;

export const PROJECT_STATUSES = ["open", "closed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const projectStatusSchema = z.enum(PROJECT_STATUSES);

const projectDateSchema = z.string().date().nullable().optional();

export const createProjectSchema = z
  .object({
    code: dimensionCodeSchema,
    name: dimensionNameSchema,
    active: z.boolean().default(true),
    status: projectStatusSchema.default("open"),
    customerId: z.string().uuid().nullable().optional(),
    startDate: projectDateSchema,
    endDate: projectDateSchema,
  })
  .refine((data) => !data.startDate || !data.endDate || data.endDate >= data.startDate, {
    message: "endDate must not be before startDate",
    path: ["endDate"],
  });
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    code: dimensionCodeSchema.optional(),
    name: dimensionNameSchema.optional(),
    active: z.boolean().optional(),
    status: projectStatusSchema.optional(),
    customerId: z.string().uuid().nullable().optional(),
    startDate: projectDateSchema,
    endDate: projectDateSchema,
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const listProjectsQuerySchema = listQuerySchema.extend({
  includeInactive: includeInactiveParam,
  status: projectStatusSchema.optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

// The pair every dimension-carrying input takes: omitted = untouched (a PATCH
// keeps the row's; a new row takes its default), null = none.
export const dimensionFields = {
  costCenterId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
};
export type DimensionIds = { costCenterId: string | null; projectId: string | null };

// How a verification row, a report row or a template row shows its objects.
export type DimensionRef = { id: string; code: string; name: string };

// The register rows as GET /cost-centers and GET /projects answer them.
export interface CostCenterView {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export interface ProjectView {
  id: string;
  code: string;
  name: string;
  active: boolean;
  status: ProjectStatus;
  customerId: string | null;
  customerName: string | null;
  startDate: string | null;
  endDate: string | null;
}

// SIE-importen av verifikat: an object a #TRANS row names that the register
// lacks (dimension 1 = Kostnadsställe, 6 = Projekt); the name comes from the
// file's #OBJEKT when it has one.
export interface SieMissingObject {
  dimension: 1 | 6;
  code: string;
  name: string | null;
}

// Resultaträkningen per objekt: one column per cost center / project with
// movement in the range plus "Utan" (id null) for the rows without one.
export const INCOME_STATEMENT_GROUP_BY = ["costCenter", "project"] as const;
export type IncomeStatementGroupBy = (typeof INCOME_STATEMENT_GROUP_BY)[number];
export const incomeStatementGroupBySchema = z.enum(INCOME_STATEMENT_GROUP_BY);

// Query-string filter on the reports: a cost center and/or a project.
export const dimensionFilterQuery = {
  costCenterId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
};
