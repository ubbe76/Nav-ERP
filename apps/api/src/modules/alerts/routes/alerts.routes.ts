import type { FastifyInstance } from "fastify";
import type { AlertsService } from "../service/alerts.service.js";

// Aviseringar: one read. The module is registered with the office read
// rule; which KINDS the user sees is the catalog's business (visibleKinds).
export async function alertsRoutes(app: FastifyInstance, opts: { service: AlertsService }) {
  app.get("/alerts", async (req) => opts.service.alertsForUser(req.user!));
}
