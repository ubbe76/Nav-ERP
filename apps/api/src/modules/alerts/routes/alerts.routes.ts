import type { FastifyInstance } from "fastify";
import { alertsQuerySchema } from "@navet/shared";
import type { AlertsService } from "../service/alerts.service.js";

// Aviseringar: one read. The module is registered with the office read
// rule; which KINDS the user sees is the catalog's business (visibleKinds).
// ?kinds= narrows it further (Översikten's cards), never widens it.
export async function alertsRoutes(app: FastifyInstance, opts: { service: AlertsService }) {
  app.get("/alerts", async (req) => {
    const { kinds } = alertsQuerySchema.parse(req.query);
    return opts.service.alertsForUser(req.user!, kinds);
  });
}
