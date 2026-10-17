import type { FastifyInstance } from "fastify";
import {
  capacityQuerySchema,
  createPlanningOrdersSchema,
  deliveryTimeCheckSchema,
  dueDateSuggestionQuerySchema,
  listRequirementsQuerySchema,
} from "@navet/shared";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { requirementsExportColumns } from "../service/export-columns.js";
import {
  ArticleNotFoundError,
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  CustomerNotFoundError,
  SalesOrderNotFoundError,
  SalesOrderNotOpenError,
  type PlanningService,
} from "../service/planning.service.js";
import { errorBody } from "../../system/service/error-body.js";
import { DELIVERY_CHECK, OVERVIEW_READ } from "../../auth/middleware/access-rules.js";

export async function planningRoutes(app: FastifyInstance, opts: { service: PlanningService }) {
  const { service } = opts;

  // Behovsberäkning — fully derived at read time, nothing stored.
  app.get("/planning/requirements", async (req) => {
    const query = listRequirementsQuerySchema.parse(req.query);
    return service.listRequirements(query);
  });

  registerListCsvRoute(app, {
    path: "/planning/requirements/csv",
    querySchema: listRequirementsQuerySchema,
    filenameBase: "behovsberakning",
    columns: requirementsExportColumns,
    fetch: (query) => service.listRequirements(query),
  });

  // Artikelöversikt — per-article subresource served from the module that
  // owns the data (precedent: /articles/:id/suppliers in purchase,
  // /articles/:id/routing in manufacturing). Read-only and fully derived.
  app.get<{ Params: { id: string } }>("/articles/:id/overview", { config: { access: OVERVIEW_READ } }, async (req, reply) => {
    try {
      return await service.getArticleOverview(req.params.id);
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Färdigdatumsförslag for a new TO — read by the Ny tillverkningsorder
  // form and the KO row's Skapa TO dialog. { suggestion: null } when the
  // article has no uncovered dated demand.
  app.get<{ Params: { id: string } }>("/articles/:id/due-date-suggestion", async (req, reply) => {
    const query = dueDateSuggestionQuerySchema.parse(req.query);
    try {
      return { suggestion: await service.suggestManufacturingDueDate(req.params.id, query) };
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Leveranstidskontroll — reads only (nothing is booked), a POST because
  // the rows travel in the body.
  app.post("/delivery-time-check", { config: { access: DELIVERY_CHECK } }, async (req, reply) => {
    const input = deliveryTimeCheckSchema.parse(req.body);
    try {
      return await service.checkDeliveryTime(input);
    } catch (err) {
      if (
        err instanceof ArticleNotFoundError ||
        err instanceof CustomerNotFoundError ||
        err instanceof SalesOrderNotFoundError
      ) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof ConfigurationRequiredError || err instanceof SalesOrderNotOpenError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof ConfigurationNotAllowedError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // Beläggning (E2) — whole capacity matrix, derived at read time.
  app.get("/planning/capacity", async (req) => {
    const query = capacityQuerySchema.parse(req.query);
    return service.getCapacity(query);
  });

  // Order proposals -> real orders: one draft IO per primary supplier plus
  // one planned TO per manufactured article. Partial success is reported
  // per proposal in `errors`, created orders are kept.
  app.post("/planning/orders", async (req, reply) => {
    const input = createPlanningOrdersSchema.parse(req.body);
    const result = await service.createOrdersFromProposals(input, req.user!.id);
    return reply.code(201).send(result);
  });
}
