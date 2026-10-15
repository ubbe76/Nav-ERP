import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { satisfiesRule, type AccessRule, type AccessToken } from "@navet/shared";
import { errorBody } from "../../system/service/error-body.js";

// Behörighetsgrupper — every route under the protected scope resolves to ONE
// rule: a per-route `config.access` wins, otherwise the module default the
// route was registered under (registerModule) — `read` for GET/HEAD, `write`
// for the rest. No rule = 403 (fail closed); permissions-coverage.test.ts
// asserts no route is left without one. Existing requireRole guards still run
// after this and are unchanged.

export interface ModuleAccess {
  read: AccessRule;
  write: AccessRule;
}

declare module "fastify" {
  interface FastifyContextConfig {
    access?: AccessRule | "public";
    moduleAccess?: ModuleAccess;
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super("Insufficient permissions");
    this.name = "ForbiddenError";
  }
}

export function resolveRule(
  config: { access?: AccessRule | "public"; moduleAccess?: ModuleAccess } | undefined,
  method: string
): AccessRule | "public" | null {
  if (config?.access) return config.access;
  if (!config?.moduleAccess) return null;
  return method === "GET" || method === "HEAD" ? config.moduleAccess.read : config.moduleAccess.write;
}

export function enforceAccess() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // The configurator scope also admits OAuth clients, which carry their own
    // scope check and no user; a human session always has req.user here.
    // Neither (should be unreachable after the auth hooks) is denied.
    if (!req.user) {
      if (req.apiClient) return;
      return reply.code(403).send(errorBody(new ForbiddenError()));
    }
    const rule = resolveRule(req.routeOptions.config, req.method);
    if (rule === "public") return;
    if (rule === null || !satisfiesRule(req.user, rule)) {
      return reply.code(403).send(errorBody(new ForbiddenError()));
    }
  };
}

// For routes whose own preHandler must hold even in a mini-app test that
// registers the plugin without the module gate (economy, reports).
export function requirePermission(...rule: AccessToken[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !satisfiesRule(req.user, rule)) {
      return reply.code(403).send(errorBody(new ForbiddenError()));
    }
  };
}

// Registers a module's routes in their own encapsulated scope whose onRoute
// hook stamps the module default onto every route that doesn't set its own.
export async function registerModule<O extends Record<string, unknown>>(
  parent: FastifyInstance,
  plugin: FastifyPluginAsync<O>,
  opts: O,
  access: ModuleAccess
) {
  await parent.register(async (scope) => {
    scope.addHook("onRoute", (route) => {
      route.config = { ...(route.config ?? {}), moduleAccess: access };
    });
    await scope.register(plugin, opts);
  });
}
