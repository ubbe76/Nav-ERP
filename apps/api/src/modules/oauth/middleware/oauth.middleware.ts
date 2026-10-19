import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "../../auth/service/auth.service.js";
import { readOnlyGuard, SESSION_COOKIE } from "../../auth/middleware/auth.middleware.js";
import type { OAuthService, PublicApiClient } from "../service/oauth.service.js";

declare module "fastify" {
  interface FastifyRequest {
    apiClient?: PublicApiClient;
  }
}

// Accepts EITHER a valid session cookie (human, web UI) OR a valid client
// bearer token (machine, e.g. the external configurator). Used only on the
// small set of routes both audiences need — see configurator.routes.ts.
export function requireAuthOrClient(authService: AuthService, oauthService: OAuthService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionToken = req.cookies[SESSION_COOKIE];
    const user = sessionToken ? await authService.verifyToken(sessionToken) : null;
    if (user) {
      req.user = user;
      // Endast läsning holds here too (POST /quotes from a read-only session).
      return readOnlyGuard(req, reply);
    }

    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    const apiClient = bearerToken ? await oauthService.verifyClientToken(bearerToken) : null;
    if (apiClient) {
      req.apiClient = apiClient;
      return;
    }

    return reply.code(401).send({ error: "Authentication required" });
  };
}
