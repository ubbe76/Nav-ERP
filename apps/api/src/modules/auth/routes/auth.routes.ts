import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createUserSchema,
  listUsersQuerySchema,
  loginSchema,
  registerSchema,
  updateUserSchema,
  updateUserSettingsSchema,
} from "@navet/shared";
import type { AuthService } from "../service/auth.service.js";
import {
  DuplicateEmailError,
  InvalidCredentialsError,
  InvalidSetupCodeError,
  LastAdminError,
  PermissionGroupNotFoundError,
  PermissionGroupOwnedByPluginError,
  PluginUserManagedError,
  ReadOnlyAdminError,
  RegistrationClosedError,
  SelfDeleteError,
  UserNotFoundError,
} from "../service/auth.service.js";
import type { UserSettingsService } from "../service/user-settings.service.js";
import { requireAuth, requireRole, SESSION_COOKIE } from "../middleware/auth.middleware.js";
import { errorBody } from "../../system/service/error-body.js";
import { UnknownThemeError } from "../../system/service/themes.errors.js";
import { LoginThrottledError, type LoginThrottle } from "../service/login-throttle.js";

const COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60; // matches the JWT's 8h expiry

// Production containers set NODE_ENV=production, so defaulting Secure to that
// check is right most of the time — but the app is also reached over plain
// HTTP on the LAN (no TLS terminator in front of it there), where a Secure
// cookie would silently stop being sent and login would appear to fail with
// no error. COOKIE_SECURE lets ops override the default explicitly per
// deployment instead of us guessing from NODE_ENV alone.
function isCookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override !== undefined) return override === "true";
  return process.env.NODE_ENV === "production";
}

// Brute-force guard for the credential endpoints (login here, the OAuth2
// token endpoint in the oauth module). `account` counts failures per e-mail
// or client id and always applies; `ip` counts per client IP and is null
// unless TRUST_PROXY is configured — behind the web container's rewrite
// every request comes from the same socket, and the X-Forwarded-For Next.js
// passes on is the client's own unless a trusted proxy in front rewrote it.
export interface CredentialThrottles {
  account: LoginThrottle;
  ip: LoginThrottle | null;
}

export function sendThrottled(reply: FastifyReply, err: LoginThrottledError) {
  return reply
    .code(429)
    .header("Retry-After", String(err.retryAfterSeconds))
    .send({ ...errorBody(err), retryAfterSeconds: err.retryAfterSeconds });
}

export async function authRoutes(
  app: FastifyInstance,
  opts: { service: AuthService; settings: UserSettingsService; throttles: CredentialThrottles }
) {
  const { service, settings, throttles } = opts;

  function setSessionCookie(reply: FastifyReply, token: string) {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: isCookieSecure(),
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
  }

  app.post("/auth/register", async (req, reply) => {
    const input = registerSchema.parse(req.body);
    try {
      const { user, token } = await service.register(input);
      setSessionCookie(reply, token);
      return reply.code(201).send(user);
    } catch (err) {
      if (err instanceof RegistrationClosedError) return reply.code(403).send(errorBody(err));
      if (err instanceof InvalidSetupCodeError) return reply.code(403).send(errorBody(err));
      if (err instanceof DuplicateEmailError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const accountKey = [`login:${input.email.trim().toLowerCase()}`];
    const ipKey = [`login-ip:${req.ip}`];
    try {
      throttles.account.assertAllowed(accountKey);
      throttles.ip?.assertAllowed(ipKey);
      const { user, token } = await service.login(input);
      // Only the account key: clearing the IP key on success would let an
      // attacker with one valid account reset the counter between guesses.
      throttles.account.recordSuccess(accountKey);
      setSessionCookie(reply, token);
      return user;
    } catch (err) {
      if (err instanceof LoginThrottledError) return sendThrottled(reply, err);
      if (err instanceof InvalidCredentialsError) {
        throttles.account.recordFailure(accountKey);
        throttles.ip?.recordFailure(ipKey);
        return reply.code(401).send(errorBody(err));
      }
      throw err;
    }
  });

  // Never behind requireAuth, so a read-only account can always log out.
  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/auth/me", { preHandler: requireAuth(service) }, async (req) => {
    return req.user;
  });

  // Per-user preferences (Monitor-style, not the system-wide system_settings)
  // — first key is "rader per sida" for the register lists. GET always
  // answers with every known key, defaults filled in.
  app.get("/me/settings", { preHandler: requireAuth(service) }, async (req) => {
    return settings.getSettings(req.user!.id);
  });

  app.patch("/me/settings", { preHandler: requireAuth(service) }, async (req, reply) => {
    const input = updateUserSettingsSchema.parse(req.body);
    try {
      return await settings.updateSettings(req.user!.id, input);
    } catch (err) {
      if (err instanceof UnknownThemeError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // Admin-only: create additional users (any role) once the first admin exists.
  app.post(
    "/auth/users",
    { preHandler: [requireAuth(service), requireRole("admin")] },
    async (req, reply) => {
      const input = createUserSchema.parse(req.body);
      try {
        const user = await service.createUser(input, req.user!.id);
        return reply.code(201).send(user);
      } catch (err) {
        if (err instanceof DuplicateEmailError) return reply.code(409).send(errorBody(err));
        if (err instanceof PermissionGroupNotFoundError) return reply.code(400).send(errorBody(err));
        if (err instanceof ReadOnlyAdminError) return reply.code(400).send(errorBody(err));
        if (err instanceof PermissionGroupOwnedByPluginError) return reply.code(409).send(errorBody(err));
        if (err instanceof PluginUserManagedError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  // Admin-only: list all users, including inactive ones. includeDeleted=true
  // additionally surfaces soft-deleted accounts — used by cross-module
  // callers resolving attribution (e.g. verifikat's "bokfört av <namn>"),
  // never by the user-admin register page itself.
  app.get("/auth/users", { preHandler: [requireAuth(service), requireRole("admin")] }, async (req) => {
    const { includeDeleted } = listUsersQuerySchema.parse(req.query);
    return service.listUsers(includeDeleted);
  });

  // Admin-only: edit a user (name/email/role/active, optional password reset).
  app.patch(
    "/auth/users/:id",
    { preHandler: [requireAuth(service), requireRole("admin")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const input = updateUserSchema.parse(req.body);
      try {
        return await service.updateUser(id, input, req.user!.id);
      } catch (err) {
        if (err instanceof UserNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof DuplicateEmailError) return reply.code(409).send(errorBody(err));
        if (err instanceof LastAdminError) return reply.code(409).send(errorBody(err));
        if (err instanceof PermissionGroupNotFoundError) return reply.code(400).send(errorBody(err));
        if (err instanceof ReadOnlyAdminError) return reply.code(400).send(errorBody(err));
        if (err instanceof PermissionGroupOwnedByPluginError) return reply.code(409).send(errorBody(err));
        if (err instanceof PluginUserManagedError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  // Admin-only: soft delete — the account disappears from the list/login but
  // its history (attributions on other tables) is preserved.
  app.delete(
    "/auth/users/:id",
    { preHandler: [requireAuth(service), requireRole("admin")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await service.deleteUser(id, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof UserNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof SelfDeleteError) return reply.code(409).send(errorBody(err));
        if (err instanceof LastAdminError) return reply.code(409).send(errorBody(err));
        if (err instanceof PluginUserManagedError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );
}
