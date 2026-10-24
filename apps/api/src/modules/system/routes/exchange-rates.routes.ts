import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createExchangeRateSchema,
  exchangeRateQuerySchema,
  fetchExchangeRatesSchema,
  listExchangeRatesQuerySchema,
  updateExchangeRateSettingsSchema,
} from "@navet/shared";
import { errorBody } from "../service/error-body.js";
import {
  ExchangeRateUnavailableError,
  RiksbankUnavailableError,
  type ExchangeRateService,
} from "../service/exchange-rates.js";

// Valutakurser. Registered with read: office (a document form looks up its
// rate), write: ekonomi (Ny kurs, Hämta från Riksbanken); the settings
// (källa, API-nyckel) are admin-only overrides.
const ADMIN = { config: { access: ["admin"] as const } };

export function mapExchangeRateError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof ExchangeRateUnavailableError) {
    return reply.code(409).send({ ...errorBody(err), currency: err.currency, date: err.date });
  }
  if (err instanceof RiksbankUnavailableError) {
    return reply.code(err.reason === "unauthorized" ? 409 : 502).send({ ...errorBody(err), reason: err.reason });
  }
  return null;
}

export async function exchangeRateRoutes(app: FastifyInstance, opts: { service: ExchangeRateService }) {
  const { service } = opts;

  async function run<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      const sent = mapExchangeRateError(reply, err);
      if (sent) return sent;
      throw err;
    }
  }

  // The rate for a currency and day (the latest banking day ≤ day), fetched
  // from Riksbanken when the table cannot answer. 409 exchange-rate-unavailable
  // when there is none.
  app.get("/exchange-rates", async (req, reply) => {
    const { currency, date } = exchangeRateQuerySchema.parse(req.query);
    return run(reply, () => service.getRate(currency, date));
  });

  app.get("/exchange-rates/list", async (req) => service.list(listExchangeRatesQuerySchema.parse(req.query)));

  // Ny kurs (manual). Replaces an earlier manual rate for the same day.
  app.post("/exchange-rates", async (req, reply) => {
    const input = createExchangeRateSchema.parse(req.body);
    return reply.code(201).send(await service.createManualRate(input, req.user!.id));
  });

  // Hämta från Riksbanken for an interval (at most 93 days).
  app.post("/exchange-rates/fetch", async (req, reply) => {
    const input = fetchExchangeRatesSchema.parse(req.body);
    return run(reply, () => service.fetchRange(input));
  });

  app.get("/exchange-rate-settings", ADMIN, async () => service.viewSettings());
  app.patch("/exchange-rate-settings", ADMIN, async (req) => {
    const input = updateExchangeRateSettingsSchema.parse(req.body);
    return service.updateSettings(input, req.user!.id);
  });
}
