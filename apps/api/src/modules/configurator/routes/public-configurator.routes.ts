import type { FastifyInstance } from "fastify";
import { evaluateConfigurationSchema, listPublicTemplatesQuerySchema } from "@navet/shared";
import type { ConfiguratorService } from "../service/configurator.service.js";
import { run } from "./configurator.routes.js";

// Delprojekt 5: the external configurator's read side, registered in app.ts's
// OAuth scope (requireAuthOrClient) — reachable by a session and by a client
// token. A client only ever sees published templates on active articles (a
// hidden one is the same 404 as an unknown one); a session sees what it sees
// today. The answers are the public shapes (public-template.ts), never the
// internal ConfiguratorTemplateDetail. Every route is an office read for a
// session (evaluate is a POST but a READ); a client passes enforceAccess.
export async function publicConfiguratorRoutes(app: FastifyInstance, opts: { service: ConfiguratorService }) {
  const { service } = opts;
  // The static segment outranks `:articleId` in find-my-way.
  app.get("/configurator/templates", { config: { access: ["office"] } }, async (req) =>
    service.listPublicTemplates(listPublicTemplatesQuerySchema.parse(req.query)));
  app.get<{ Params: { articleId: string } }>("/configurator/:articleId", { config: { access: ["office"] } }, (req, reply) =>
    run(reply, () => service.getPublicTemplate(req.params.articleId, { client: Boolean(req.apiClient) })));
  app.post<{ Params: { articleId: string } }>("/configurator/:articleId/evaluate", { config: { access: ["office"] } }, (req, reply) =>
    run(reply, () =>
      service.evaluatePublic(req.params.articleId, evaluateConfigurationSchema.parse(req.body ?? {}), { client: Boolean(req.apiClient) })
    ));
}
