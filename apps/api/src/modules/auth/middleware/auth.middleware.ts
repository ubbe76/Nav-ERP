import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserRole } from "@navet/shared";
import type { AuthService, PublicUser } from "../service/auth.service.js";
import { errorBody } from "../../system/service/error-body.js";
import { ForbiddenError } from "./permission.middleware.js";

export const SESSION_COOKIE = "session";

declare module "fastify" {
  interface FastifyRequest {
    user?: PublicUser;
  }
}

export function requireAuth(authService: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await authService.verifyToken(token) : null;
    if (!user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    req.user = user;
  };
}

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return reply.code(403).send(errorBody(new ForbiddenError()));
    }
  };
}
