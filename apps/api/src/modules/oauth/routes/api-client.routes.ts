import type { FastifyInstance } from "fastify";
import { createApiClientSchema } from "@navet/shared";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import type { OAuthService } from "../service/oauth.service.js";
import { ApiClientNotFoundError } from "../service/oauth.service.js";
import { errorBody } from "../../system/service/error-body.js";

// Registered inside app.ts's protected route scope (requireAuth already ran),
// admin-only — same pattern as POST /auth/users.
export async function apiClientRoutes(app: FastifyInstance, opts: { service: OAuthService }) {
  const { service } = opts;

  app.post("/api-clients", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = createApiClientSchema.parse(req.body);
    const result = await service.createApiClient(input, req.user!.id);
    return reply.code(201).send(result);
  });

  app.get("/api-clients", { preHandler: requireRole("admin") }, async () => {
    return service.listApiClients();
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
