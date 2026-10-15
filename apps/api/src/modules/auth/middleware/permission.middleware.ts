import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { satisfiesRule, type AccessRule, type AccessToken, type ApiClientScope } from "@navet/shared";
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
    // Behörigheter per OAuth-klient: the scope a client token needs on this
    // route. Absent = no client may call it (fail closed).
    clientScope?: ApiClientScope;
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super("Insufficient permissions");
    this.name = "ForbiddenError";
  }
}

export class ClientScopeMissingError extends Error {
  constructor(scope: string | undefined) {
    super(scope ? `The client lacks the scope ${scope}` : "The route is not open to API clients");
    this.name = "ClientScopeMissingError";
  }
}

export class ClientCustomerMismatchError extends Error {
  constructor() {
    super("The client is bound to another customer");
    this.name = "ClientCustomerMismatchError";
  }
}

// For routes that take a customer: a client bound to a customer may only act
// on that customer. Sessions and unbound clients pass.
export function clientCustomerAllowed(req: FastifyRequest, customerId: string): boolean {
  const bound = req.apiClient?.customerId ?? null;
  return bound === null || bound === customerId;
}

export function clientHasScope(req: FastifyRequest, scope: ApiClientScope): boolean {
  return !req.apiClient || req.apiClient.scopes.includes(scope);
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
    // The configurator scope also admits OAuth clients (no user): a client
    // needs the route's config.clientScope in its own list — a route without
    // one is closed to clients. A human session always has req.user here;
    // neither (unreachable after the auth hooks) is denied.
    if (!req.user) {
      if (req.apiClient) {
        const scope = req.routeOptions.config.clientScope;
        if (!scope || !req.apiClient.scopes.includes(scope)) {
          return reply.code(403).send(errorBody(new ClientScopeMissingError(scope)));
        }
        return;
      }
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
