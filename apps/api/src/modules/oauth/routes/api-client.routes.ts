import type { FastifyInstance } from "fastify";
import { createApiClientSchema, updateApiClientSchema } from "@navet/shared";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import type { OAuthService } from "../service/oauth.service.js";
import { ApiClientCustomerNotFoundError, ApiClientNotFoundError } from "../service/oauth.service.js";
import { errorBody } from "../../system/service/error-body.js";

// Registered inside app.ts's protected route scope (requireAuth already ran),
// admin-only — same pattern as POST /auth/users.
export async function apiClientRoutes(app: FastifyInstance, opts: { service: OAuthService }) {
  const { service } = opts;

  app.post("/api-clients", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = createApiClientSchema.parse(req.body);
    try {
      const result = await service.createApiClient(input, req.user!.id);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof ApiClientCustomerNotFoundError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.get("/api-clients", { preHandler: requireRole("admin") }, async () => {
    return service.listApiClients();
  });

  app.patch<{ Params: { id: string } }>("/api-clients/:id", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = updateApiClientSchema.parse(req.body);
    try {
      return await service.updateApiClient(req.params.id, input, req.user!.id);
    } catch (err) {
      if (err instanceof ApiClientNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof ApiClientCustomerNotFoundError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api-clients/:id/revoke",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      try {
        return await service.revokeApiClient(req.params.id);
      } catch (err) {
        if (err instanceof ApiClientNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );
}
