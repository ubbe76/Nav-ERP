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
  interface FastifyContextConfig {
    // Endast läsning: a non-GET route that only computes and answers (a
    // preview, a check) and writes nothing — open to a read-only account.
    // A function decides per request (e.g. "only without save"); it runs
    // after body parsing. Absent = the route writes (fail closed).
    readOnlySafe?: true | ((req: FastifyRequest) => boolean);
  }
}

// Endast läsning: every write from a read-only account is refused centrally
// (403 read-only-account), not per route. The message is Swedish on purpose:
// it reaches web screens that show the raw message (uploads, the terminal)
// as well as those that map the code.
export class ReadOnlyAccountError extends Error {
  constructor() {
    super("Kontot kan bara läsa — ändringar är avstängda.");
    this.name = "ReadOnlyAccountError";
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// True when the session user is read-only and this request may change
// something: any method but GET/HEAD/OPTIONS on a route without readOnlySafe.
export function readOnlyBlocks(req: FastifyRequest): boolean {
  if (!req.user?.readOnly || READ_METHODS.has(req.method)) return false;
  const safe = req.routeOptions.config.readOnlySafe;
  if (safe === true) return false;
  if (typeof safe === "function") return !safe(req);
  return true;
}

// Runs inside every session check (requireAuth here, requireAuthOrClient in
// the oauth module) right after req.user is set, so no authenticated route —
// in the protected scope, the configurator scope or the auth routes' own
// preHandlers (/me/settings, /auth/users) — can be reached around it. Login,
// register and logout never authenticate and so stay open.
export async function readOnlyGuard(req: FastifyRequest, reply: FastifyReply) {
  if (readOnlyBlocks(req)) return reply.code(403).send(errorBody(new ReadOnlyAccountError()));
}

export function requireAuth(authService: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await authService.verifyToken(token) : null;
    if (!user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    req.user = user;
    return readOnlyGuard(req, reply);
  };
}

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return reply.code(403).send(errorBody(new ForbiddenError()));
    }
  };
}
