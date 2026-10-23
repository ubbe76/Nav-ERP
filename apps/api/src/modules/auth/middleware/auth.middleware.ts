import type { FastifyReply, FastifyRequest } from "fastify";
import { PLUGIN_API_KEY_PREFIX, type UserRole } from "@navet/shared";
import type { AuthService, PublicUser, RequestPlugin } from "../service/auth.service.js";
import { errorBody } from "../../system/service/error-body.js";
import { ForbiddenError } from "./permission.middleware.js";

export const SESSION_COOKIE = "session";

declare module "fastify" {
  interface FastifyRequest {
    user?: PublicUser;
    // Tillägg: set when the request authenticated with a plugin's API key
    // (req.user is then the plugin's technical user).
    plugin?: RequestPlugin;
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

// Tillägg: a plugin key in the same request as a session cookie is refused —
// a browser with a signed-in user must never be mixed up with a plugin.
export class PluginKeyWithSessionError extends Error {
  constructor() {
    super("A plugin API key cannot be combined with a session cookie");
    this.name = "PluginKeyWithSessionError";
  }
}

// A plugin never changes itself, its permissions or users: its key is
// refused on the auth, settings, OAuth and plugin routes.
export class PluginRouteForbiddenError extends Error {
  constructor() {
    super("Tilläggets API-nyckel kan inte användas mot den här adressen.");
    this.name = "PluginRouteForbiddenError";
  }
}

const PLUGIN_FORBIDDEN_PREFIXES = ["/api/v1/auth", "/api/v1/me", "/api/v1/oauth", "/api/v1/plugins"];

export function pluginRouteForbidden(url: string): boolean {
  return PLUGIN_FORBIDDEN_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
}

// The bearer token when it is a plugin key, else null.
export function pluginKeyOf(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.startsWith(PLUGIN_API_KEY_PREFIX) ? token : null;
}

// The plugin-key branch shared by requireAuth and requireAuthOrClient:
// either authenticates the request as the plugin's technical user or
// answers it (400/401/403).
export async function authenticatePluginKey(
  authService: AuthService,
  key: string,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (req.cookies[SESSION_COOKIE]) {
    return void reply.code(400).send(errorBody(new PluginKeyWithSessionError()));
  }
  const found = await authService.verifyPluginKey(key);
  if (!found) {
    return void reply.code(401).send({ error: "Authentication required" });
  }
  // The route pattern (never the raw URL, so a query string can't dodge it).
  if (pluginRouteForbidden(req.routeOptions.url ?? req.url)) {
    return void reply.code(403).send(errorBody(new PluginRouteForbiddenError()));
  }
  req.user = found.user;
  req.plugin = found.plugin;
  return readOnlyGuard(req, reply);
}

export function requireAuth(authService: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const pluginKey = pluginKeyOf(req);
    if (pluginKey) return authenticatePluginKey(authService, pluginKey, req, reply);
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
