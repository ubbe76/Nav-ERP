import type { FastifyInstance } from "fastify";
import { articleCardWrite } from "../../auth/middleware/access-rules.js";
import { postCalculateSchema, preCalculateSchema } from "@navet/shared";
import type { CostingService } from "../service/costing.service.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  ArticleNotFoundError,
  CostCalculationNotFoundError,
  InvalidCalculationQuantityError,
  ManufacturingOrderNotFoundError,
  PostCalculationLockedError,
} from "../service/costing.service.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function costingRoutes(app: FastifyInstance, opts: { service: CostingService }) {
  const { service } = opts;

  // Without `save` this only computes and returns the numbers (200, id null);
  // with it the calculation is written and answered exactly as before (201).
  app.post<{ Params: { id: string } }>(
    "/articles/:id/cost-calculations/pre-calculate",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      const input = preCalculateSchema.parse(req.body);
      try {
        if (input.save) {
          return reply
            .code(201)
            .send(await service.preCalculate(req.params.id, input.quantity, true, input.multiLevel ?? false));
        }
        return reply.send(await service.preCalculate(req.params.id, input.quantity, false, input.multiLevel ?? false));
      } catch (err) {
        if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // The body may be absent entirely — apiFetch omits it for body-less action
  // calls — so a missing body parses as an empty object, i.e. a preview.
  app.post<{ Params: { id: string } }>("/manufacturing-orders/:id/cost-calculations/post-calculate", async (req, reply) => {
    const input = postCalculateSchema.parse(req.body ?? {});
    try {
      if (input.save) {
        return reply.code(201).send(await service.postCalculate(req.params.id, true));
      }
      return reply.send(await service.postCalculate(req.params.id));
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/articles/:id/cost-calculations", async (req) => {
    return service.listCostCalculations(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/manufacturing-orders/:id/cost-calculations", async (req) => {
    return service.listCostCalculationsForOrder(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/cost-calculations/:id", async (req, reply) => {
    const calculation = await service.getCostCalculation(req.params.id);
    if (!calculation) return reply.code(404).send({ error: "Cost calculation not found" });
    return calculation;
  });

  // 409 rather than 403: the calculation exists and the caller may well be an
  // admin — it is the post-calculation itself that is not removable.
  // The article card's Kalkyl tab deletes/applies calculations too, so the
  // Artiklar menu may do this as well as Tillverkning (articleCardWrite).
  app.delete<{ Params: { id: string } }>(
    "/cost-calculations/:id",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      try {
        await service.deleteCostCalculation(req.params.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof CostCalculationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof PostCalculationLockedError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  // Prisåterföring — write a SAVED calculation's figures back onto the
  // article. Only a saved calculation: a preview has no id, and the resulting
  // standard cost should be traceable to a calculation that still exists and
  // can be opened. No body — the server derives everything from the stored row.
  app.post<{ Params: { id: string } }>(
    "/cost-calculations/:id/apply-standard-cost",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      try {
        return { article: await service.applyStandardCostFromCalculation(req.params.id) };
      } catch (err) {
        if (err instanceof CostCalculationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidCalculationQuantityError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/cost-calculations/:id/apply-sales-price",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      try {
        return { article: await service.applySalesPriceFromCalculation(req.params.id) };
      } catch (err) {
        if (err instanceof CostCalculationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidCalculationQuantityError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  // The self cost an order row's margin is measured against. Needed as its own
  // endpoint because a row is priced BEFORE it exists — the order card's saved
  // rows get theirs attached by listRows instead.
  //
  // Deliberately NOT folded into GET /price-quote: that lives in the
  // configurator's OAuth scope, and our self cost is not something an external
  // integration should be handed.
  app.get<{ Params: { id: string } }>("/articles/:id/self-cost", async (req) => {
    const found = await service.latestPreCalculationSelfCost([req.params.id]);
    return found.get(req.params.id) ?? null;
  });
}
