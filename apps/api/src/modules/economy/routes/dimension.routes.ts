import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createCostCenterSchema,
  createProjectSchema,
  listCostCentersQuerySchema,
  listProjectsQuerySchema,
  updateCostCenterSchema,
  updateProjectSchema,
} from "@navet/shared";
import { errorBody } from "../../system/service/error-body.js";
import {
  CostCenterCodeTakenError,
  CostCenterNotFoundError,
  DimensionBookedError,
  InvalidReplacementError,
  ProjectCodeTakenError,
  ProjectCustomerNotFoundError,
  ProjectDatesError,
  ProjectNotFoundError,
  RegisterEntryInUseError,
  type DimensionService,
} from "../service/dimension.service.js";

// Kostnadsställen och projekt (etapp 5 del A): the two registers under
// Ekonomi. Registered with registerModule({ read: office, write: ekonomi })
// in app.ts — every office user may read the lists (the pickers on orders,
// invoices and article groups need them), only Ekonomi writes.

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

// The replacement may come in the query string (the register convention) or
// the body — the web sends both.
const deleteSchema = z.object({ replacementId: z.string().uuid().optional() });

export async function dimensionRoutes(app: FastifyInstance, opts: { service: DimensionService }) {
  const { service } = opts;

  function dimensionError(err: unknown, reply: Reply) {
    if (err instanceof CostCenterNotFoundError || err instanceof ProjectNotFoundError || err instanceof ProjectCustomerNotFoundError) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof CostCenterCodeTakenError || err instanceof ProjectCodeTakenError || err instanceof DimensionBookedError) {
      return reply.code(409).send(errorBody(err));
    }
    if (err instanceof RegisterEntryInUseError) return reply.code(409).send({ ...errorBody(err), usage: err.usage });
    if (err instanceof InvalidReplacementError || err instanceof ProjectDatesError) return reply.code(400).send(errorBody(err));
    throw err;
  }

  function replacementOf(req: { query: unknown; body: unknown }): string | null {
    const fromQuery = deleteSchema.parse(req.query ?? {}).replacementId;
    const fromBody = deleteSchema.parse(req.body ?? {}).replacementId;
    return fromQuery ?? fromBody ?? null;
  }

  // --- Kostnadsställen ---

  app.get("/cost-centers", async (req) => service.costCenters.list(listCostCentersQuerySchema.parse(req.query)));

  app.get<{ Params: { id: string } }>("/cost-centers/:id", async (req, reply) => {
    try {
      return await service.costCenters.get(req.params.id);
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  app.post("/cost-centers", async (req, reply) => {
    const input = createCostCenterSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.costCenters.create(input, req.user?.id ?? null));
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/cost-centers/:id", async (req, reply) => {
    const input = updateCostCenterSchema.parse(req.body);
    try {
      return await service.costCenters.update(req.params.id, input, req.user?.id ?? null);
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/cost-centers/:id/usage", async (req, reply) => {
    try {
      return await service.costCenters.usage(req.params.id);
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/cost-centers/:id", async (req, reply) => {
    try {
      await service.costCenters.remove(req.params.id, replacementOf(req), req.user?.id ?? null);
      return reply.code(204).send();
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  // --- Projekt ---

  app.get("/projects", async (req) => service.projects.list(listProjectsQuerySchema.parse(req.query)));

  app.get<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    try {
      return await service.projects.get(req.params.id);
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  app.post("/projects", async (req, reply) => {
    const input = createProjectSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.projects.create(input, req.user?.id ?? null));
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    const input = updateProjectSchema.parse(req.body);
    try {
      return await service.projects.update(req.params.id, input, req.user?.id ?? null);
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/projects/:id/usage", async (req, reply) => {
    try {
      return await service.projects.usage(req.params.id);
    } catch (err) {
      return dimensionError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    try {
      await service.projects.remove(req.params.id, replacementOf(req), req.user?.id ?? null);
      return reply.code(204).send();
    } catch (err) {
      return dimensionError(err, reply);
    }
  });
}
