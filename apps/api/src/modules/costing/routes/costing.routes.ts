import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import { articleCardWrite } from "../../auth/middleware/access-rules.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { ForbiddenError } from "../../auth/middleware/permission.middleware.js";
import {
  postCalculateSchema,
  preCalculateSchema,
  postCalculationBatchSaveSchema,
  postCalculationBatchSchema,
  preCalculationBatchListSchema,
  preCalculationBatchSaveSchema,
  preCalculationBatchSchema,
  satisfiesRule,
  workInProgressQuerySchema,
} from "@navet/shared";
import type { CostingService } from "../service/costing.service.js";
import { PreCalculationBatchTooLargeError, type PreCalculationBatchService } from "../service/pre-calculation-batch.service.js";
import { PostCalculationBatchTooLargeError, type PostCalculationBatchService } from "../service/post-calculation-batch.service.js";
import type { WorkInProgressService } from "../service/work-in-progress.service.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  ArticleNotFoundError,
  CostCalculationNotFinalError,
  CostCalculationNotFoundError,
  InvalidCalculationQuantityError,
  ManufacturingOrderNotFoundError,
  PostCalculationLockedError,
  TrialSalesPriceNotAllowedError,
} from "../service/costing.service.js";

// Endast läsning: a calculation without `save` only computes and answers, so
// a read-only account may run it — the same schema the route parses decides,
// and a body that would not parse counts as a write (refused, fail closed).
function isPreview(schema: ZodType<{ save?: boolean }>, body: unknown): boolean {
  const parsed = schema.safeParse(body);
  return parsed.success && !parsed.data.save;
}

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function costingRoutes(
  app: FastifyInstance,
  opts: {
    service: CostingService;
    workInProgress: WorkInProgressService;
    batch: PreCalculationBatchService;
    postBatch: PostCalculationBatchService;
  }
) {
  const { service, workInProgress, batch, postBatch } = opts;

  // Without `save` this only computes and returns the numbers (200, id null);
  // with it the calculation is written and answered exactly as before (201).
  // `markups` = Pröva påslag (#16): a preview with tried price markups is
  // still a preview, so a read-only account may try them.
  app.post<{ Params: { id: string } }>(
    "/articles/:id/cost-calculations/pre-calculate",
    { config: { access: articleCardWrite(["tillverkning"]), readOnlySafe: (req) => isPreview(preCalculateSchema, req.body) } },
    async (req, reply) => {
      const input = preCalculateSchema.parse(req.body);
      const trial = input.markups ?? null;
      try {
        if (input.save) {
          return reply
            .code(201)
            .send(await service.preCalculate(req.params.id, input.quantity, true, input.multiLevel ?? false, trial));
        }
        return reply.send(await service.preCalculate(req.params.id, input.quantity, false, input.multiLevel ?? false, trial));
      } catch (err) {
        if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // The body may be absent entirely — apiFetch omits it for body-less action
  // calls — so a missing body parses as an empty object, i.e. a preview.
  app.post<{ Params: { id: string } }>(
    "/manufacturing-orders/:id/cost-calculations/post-calculate",
    { config: { readOnlySafe: (req) => isPreview(postCalculateSchema, req.body ?? {}) } },
    async (req, reply) => {
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
    }
  );

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
        if (err instanceof CostCalculationNotFinalError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  // Pröva påslag (#16): a calculation saved with tried markups writes a price
  // its author chose freely, so it takes Artiklar — the permission the
  // article card's own price field needs. Tillverkning alone gets 403.
  app.post<{ Params: { id: string } }>(
    "/cost-calculations/:id/apply-sales-price",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      try {
        const mayApplyTrial = satisfiesRule(req.user!, ["artiklar"]);
        return { article: await service.applySalesPriceFromCalculation(req.params.id, { mayApplyTrial }) };
      } catch (err) {
        if (err instanceof TrialSalesPriceNotAllowedError) return reply.code(403).send(errorBody(new ForbiddenError()));
        if (err instanceof CostCalculationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidCalculationQuantityError) return reply.code(400).send(errorBody(err));
        if (err instanceof CostCalculationNotFinalError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  // Förkalkylera flera (#27). The preview computes and answers, nothing is
  // written — readOnlySafe like the card's preview. Access as the card's
  // pre-calculate route: Artiklar or Tillverkning (a menu, so the workshop
  // profile — terminal, TO i läsläge, artikelöversikt — never reaches the
  // prices in the answer). The cap is a domain error, 400 with count/max,
  // raised before any calculation. The Kopierat selection is the user's own
  // list, hence req.user.
  app.post(
    "/costing/pre-calculations/batch",
    { config: { access: articleCardWrite(["tillverkning"]), readOnlySafe: true } },
    async (req, reply) => {
      const input = preCalculationBatchSchema.parse(req.body);
      try {
        return await batch.preview(req.user!.id, input);
      } catch (err) {
        if (err instanceof PreCalculationBatchTooLargeError) {
          return reply.code(400).send({ ...errorBody(err), count: err.count, max: err.max });
        }
        throw err;
      }
    }
  );

  // Visa urval: the selection's articles before anything is calculated —
  // read-only like the preview, same access, never refused for size (the
  // answer carries count and max instead).
  app.post(
    "/costing/pre-calculations/batch/selection",
    { config: { access: articleCardWrite(["tillverkning"]), readOnlySafe: true } },
    async (req) => batch.listSelection(req.user!.id, preCalculationBatchListSchema.parse(req.body))
  );

  // The save: per ticked article the card's Spara kalkyl, then Sätt
  // standardpris / Sätt försäljningspris with the card's own functions —
  // the same access rule as those three routes. Partial success is answered
  // honestly (saved + errors), never as a 4xx.
  app.post(
    "/costing/pre-calculations/batch/save",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req) => batch.save(preCalculationBatchSaveSchema.parse(req.body))
  );

  // Efterkalkylera flera (#34). Access as the card's post-calculate route:
  // the module's write (Tillverkning) — no override. The preview computes
  // and answers, nothing is written — readOnlySafe like the card's preview.
  // The cap is a domain error, 400 with count/max, raised before any
  // calculation.
  app.post("/costing/post-calculations/batch", { config: { readOnlySafe: true } }, async (req, reply) => {
    const input = postCalculationBatchSchema.parse(req.body);
    try {
      return await postBatch.preview(input);
    } catch (err) {
      if (err instanceof PostCalculationBatchTooLargeError) {
        return reply.code(400).send({ ...errorBody(err), count: err.count, max: err.max });
      }
      throw err;
    }
  });

  // Visa urval: the selection's orders before anything is calculated —
  // read-only like the preview, never refused for size (the answer carries
  // count and max instead).
  app.post("/costing/post-calculations/batch/selection", { config: { readOnlySafe: true } }, async (req) =>
    postBatch.listSelection(postCalculationBatchSchema.parse(req.body))
  );

  // The save: per ticked order the card's Spara (postCalculate with save).
  // No price is set from here. Partial success is answered honestly
  // (saved + errors), never as a 4xx; an unknown order is one of the errors.
  app.post("/costing/post-calculations/batch/save", async (req) =>
    postBatch.save(postCalculationBatchSaveSchema.parse(req.body))
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

  // Produkter i arbete (#25): admin-only like /stock/valuation — the report
  // is cost data per order, the same audience as Lagervärdering.
  app.get("/costing/work-in-progress", { preHandler: requireRole("admin") }, async (req) =>
    workInProgress.getWorkInProgress(workInProgressQuerySchema.parse(req.query))
  );

  app.get("/costing/work-in-progress/pdf", { preHandler: requireRole("admin") }, async (req, reply) => {
    const { filename, content } = await workInProgress.getWorkInProgressPdf(workInProgressQuerySchema.parse(req.query));
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", contentDisposition(filename));
    return reply.send(content);
  });
}
