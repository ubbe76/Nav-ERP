import type { FastifyInstance } from "fastify";
import {
  applyDeliveryTimeSchema,
  capacityQuerySchema,
  createPlanningOrdersSchema,
  deliveryTimeCheckSchema,
  dueDateSuggestionQuerySchema,
  listRequirementsQuerySchema,
  moveOperationSchema,
} from "@navet/shared";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { requirementsExportColumns } from "../service/export-columns.js";
import {
  ArticleNotFoundError,
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  CustomerNotFoundError,
  DeliveryTimeChangedError,
  NothingToReserveError,
  OperationNotFoundError,
  OperationNotPlannableError,
  PlanWeekInPastError,
  SalesOrderNotFoundError,
  SalesOrderNotOpenError,
  type PlanningService,
} from "../service/planning.service.js";
import {
  LinkedOrderStatusError,
  LinkedRowArticleMismatchError,
  LinkedRowNotFoundError,
  LinkedRowNotManufacturedError,
} from "../../manufacturing/service/manufacturing.service.js";
import { ArticleIsTemplateError } from "../../article/service/article.service.js";
// The sales module's configuration errors — the manufacturing service throws
// these (not planning's own classes of the same name) from prepareCreate.
import {
  ConfigurationNotAllowedError as SalesConfigurationNotAllowedError,
  ConfigurationRequiredError as SalesConfigurationRequiredError,
  RowConfigurationChangedError,
} from "../../sales/service/sales.errors.js";
import { ConfiguratorInvalidConfigurationError, ConfiguratorNotToOrderModeError } from "../../configurator/service/configurator.errors.js";
import { InvalidStatusTransitionError as SalesStatusError } from "../../sales/service/sales.service.js";
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

  // Reservationen — Skapa tillverkningsordrar för det som saknas: the check
  // run again under the production_plan lock, one TO per shortage batch
  // planned in the weeks it booked, and the KO's Förväntat leveransdatum.
  // Access: DELIVERY_CHECK, although this WRITES (KO date, TOs) — the
  // point is that the seller promises a date that holds; the KO status
  // guard and the manufacturing service's own rules are the double check.
  // 409 delivery-time-changed carries the new result in `result`.
  app.post("/delivery-time-check/apply", { config: { access: DELIVERY_CHECK } }, async (req, reply) => {
    const input = applyDeliveryTimeSchema.parse(req.body);
    try {
      return await service.applyDeliveryTime(input, req.user!.id);
    } catch (err) {
      if (err instanceof DeliveryTimeChangedError) return reply.code(409).send({ ...errorBody(err), result: err.result });
      if (
        err instanceof ArticleNotFoundError ||
        err instanceof CustomerNotFoundError ||
        err instanceof SalesOrderNotFoundError ||
        err instanceof LinkedRowNotFoundError
      ) {
        return reply.code(404).send(errorBody(err));
      }
      if (
        err instanceof SalesOrderNotOpenError ||
        err instanceof NothingToReserveError ||
        err instanceof ConfigurationRequiredError ||
        // The manufacturing service's own guards on the linked row (the row
        // was reconfigured meanwhile, the order's status, the template's
        // mode) — mapped exactly as POST /manufacturing-orders maps them —
        // and the sales header's status guard.
        err instanceof RowConfigurationChangedError ||
        err instanceof LinkedOrderStatusError ||
        err instanceof ArticleIsTemplateError ||
        err instanceof SalesConfigurationRequiredError ||
        err instanceof ConfiguratorNotToOrderModeError ||
        err instanceof SalesStatusError
      ) {
        return reply.code(409).send(errorBody(err));
      }
      if (
        err instanceof ConfigurationNotAllowedError ||
        err instanceof SalesConfigurationNotAllowedError ||
        err instanceof LinkedRowArticleMismatchError ||
        err instanceof LinkedRowNotManufacturedError
      ) {
        return reply.code(400).send(errorBody(err));
      }
      if (err instanceof ConfiguratorInvalidConfigurationError) {
        return reply.code(400).send({ ...errorBody(err), details: err.details });
      }
      throw err;
    }
  });

  // Beläggning (E2) — whole capacity matrix, derived at read time.
  app.get("/planning/capacity", async (req) => {
    const query = capacityQuerySchema.parse(req.query);
    return service.getCapacity(query);
  });

  // Produktionsplanering — the three plan writes, each one transaction under
  // the production_plan lock. Module default: write = tillverkning.
  // Planera: every open TO replanned on free capacity, hand-moved weeks kept.
  app.post("/planning/plan", async (req) => service.planProductionRun(req.user!.id));

  // Flytta: start the operation in a chosen week (locked); the TO's later
  // unlocked operations follow when moveFollowing is set.
  app.post<{ Params: { opId: string } }>("/planning/operations/:opId/move", async (req, reply) => {
    const input = moveOperationSchema.parse(req.body);
    try {
      return await service.moveOperation(req.params.opId, input, req.user!.id);
    } catch (err) {
      if (err instanceof OperationNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof PlanWeekInPastError) return reply.code(400).send(errorBody(err));
      if (err instanceof OperationNotPlannableError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // Lås upp: the weeks stay until the next Planera. Idempotent.
  app.post<{ Params: { opId: string } }>("/planning/operations/:opId/unlock", async (req, reply) => {
    try {
      return await service.unlockOperation(req.params.opId, req.user!.id);
    } catch (err) {
      if (err instanceof OperationNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
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
