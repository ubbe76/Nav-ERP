import type { FastifyInstance } from "fastify";
import { evaluateConfigurationSchema, listPublicTemplatesQuerySchema } from "@navet/shared";
import type { ConfiguratorService } from "../service/configurator.service.js";
import { run } from "./configurator.routes.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  ClientCustomerMismatchError,
  ClientScopeMissingError,
  clientCustomerAllowed,
  clientHasScope,
} from "../../auth/middleware/permission.middleware.js";

// Delprojekt 5: the external configurator's read side, registered in app.ts's
// OAuth scope (requireAuthOrClient) — reachable by a session and by a client
// token. A client only ever sees published templates on active articles (a
// hidden one is the same 404 as an unknown one); a session sees what it sees
// today. The answers are the public shapes (public-template.ts), never the
// internal ConfiguratorTemplateDetail. Every route is an office read for a
// session (evaluate is a POST but a READ); a client needs configurator:read
// (and prices:read for a customer's price, see evaluate below).
export async function publicConfiguratorRoutes(app: FastifyInstance, opts: { service: ConfiguratorService }) {
  const { service } = opts;
  // The static segment outranks `:articleId` in find-my-way.
  app.get("/configurator/templates", { config: { access: ["office"], clientScope: "configurator:read" } }, async (req) =>
    service.listPublicTemplates(listPublicTemplatesQuerySchema.parse(req.query)));
  app.get<{ Params: { articleId: string } }>("/configurator/:articleId", { config: { access: ["office"], clientScope: "configurator:read" } }, (req, reply) =>
    run(reply, () => service.getPublicTemplate(req.params.articleId, { client: Boolean(req.apiClient) })));
  // A customerId prices the choice through that customer's price chain — a
  // price lookup like GET /price-quote, so for a client it needs prices:read
  // and, for a client bound to a customer, that very customer. Without a
  // customer the answer is the template's own price (configurator:read).
  app.post<{ Params: { articleId: string } }>("/configurator/:articleId/evaluate", { config: { access: ["office"], clientScope: "configurator:read" } }, (req, reply) => {
    const input = evaluateConfigurationSchema.parse(req.body ?? {});
    if (input.customerId) {
      if (!clientHasScope(req, "prices:read")) return reply.code(403).send(errorBody(new ClientScopeMissingError("prices:read")));
      if (!clientCustomerAllowed(req, input.customerId)) return reply.code(403).send(errorBody(new ClientCustomerMismatchError()));
    }
    return run(reply, () => service.evaluatePublic(req.params.articleId, input, { client: Boolean(req.apiClient) }));
  });
}
