import type { FastifyInstance, FastifyReply } from "fastify";
import { createReferenceRateSchema, fetchReferenceRatesSchema } from "@navet/shared";
import { errorBody } from "../service/error-body.js";
import { ReferenceRateRiksbankError, type ExchangeRateService } from "../service/exchange-rates.js";
import { mapExchangeRateError } from "./exchange-rates.routes.js";

// Referensränta (Ekonomi → Referensränta). Registered with the customer
// invoices' rule (read office, write forsaljning) — the Räntefakturering
// routine needs to fetch and add rates; Hämta från Riksbanken fails like the
// exchange rates' fetch (502 riksbank-unavailable).
export async function referenceRateRoutes(app: FastifyInstance, opts: { service: ExchangeRateService }) {
  const { service } = opts;

  async function run<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ReferenceRateRiksbankError) return reply.code(409).send({ ...errorBody(err), validFrom: err.validFrom });
      const sent = mapExchangeRateError(reply, err);
      if (sent) return sent;
      throw err;
    }
  }

  app.get("/reference-rates", async () => service.listReferenceRates());

  // Lägg till (manual) — upsert for the half-year.
  app.post("/reference-rates", async (req, reply) => {
    const input = createReferenceRateSchema.parse(req.body);
    return reply.code(201).send(await service.createManualReferenceRate(input, req.user!.id));
  });

  // Hämta från Riksbanken for the half-years in [from, to] (default the
  // latest four through today).
  app.post("/reference-rates/fetch", async (req, reply) => {
    const input = fetchReferenceRatesSchema.parse(req.body);
    return run(reply, () => service.fetchReferenceRates(input));
  });

  // Only a manual rate can be removed (409 reference-rate-riksbank).
  app.delete<{ Params: { id: string } }>("/reference-rates/:id", async (req, reply) => {
    return run(reply, async () => {
      const deleted = await service.deleteReferenceRate(req.params.id, req.user!.id);
      if (!deleted) return reply.code(404).send({ error: "Reference rate not found" });
      return reply.code(204).send();
    });
  });
}
