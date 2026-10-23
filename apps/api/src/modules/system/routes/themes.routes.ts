import type { FastifyInstance, FastifyReply } from "fastify";
import { createThemeSchema, THEME_FILE_MAX_BYTES, updateThemeSchema, validateThemeBodySchema, type ThemeFile } from "@navet/shared";
import type { AuthService } from "../../auth/service/auth.service.js";
import type { UserSettingsService } from "../../auth/service/user-settings.service.js";
import { SESSION_COOKIE } from "../../auth/middleware/auth.middleware.js";
import { contentDisposition } from "../service/content-disposition.js";
import { errorBody } from "../service/error-body.js";
import type { ThemesService } from "../service/themes.service.js";
import {
  ThemeInvalidError,
  ThemeIsDefaultError,
  ThemeLimitError,
  ThemeNameTakenError,
  ThemeNotFoundError,
} from "../service/themes.errors.js";

// A theme file is at most 64 kB; a little slack for the JSON wrapping the
// web adds when it re-serialises the parsed file.
const THEME_BODY_LIMIT = THEME_FILE_MAX_BYTES + 4096;

// GET /theme-boot — public: the web's root layout reads it on every page,
// /login and the stamp terminal included, so it is registered outside the
// authenticated scope. A valid session cookie adds the user's own choice;
// without one (or with an expired one) the answer simply leaves it out. An
// Endast läsning account can't store a choice (PATCH /me/settings is a 403),
// so it answers null: the choice it made in this browser (localStorage)
// then decides, instead of an older stored one overriding it on every load.
export async function themeBootRoutes(
  app: FastifyInstance,
  opts: { service: ThemesService; auth: AuthService; userSettings: UserSettingsService }
) {
  const { service, auth, userSettings } = opts;

  app.get("/theme-boot", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await auth.verifyToken(token) : null;
    const userTheme = !user ? undefined : user.readOnly ? null : (await userSettings.getSettings(user.id)).theme;
    reply.header("Cache-Control", "no-store");
    return service.boot(userTheme);
  });
}

function sendThemeFile(reply: FastifyReply, file: ThemeFile) {
  // Characters file systems refuse become "-".
  const filename = `tema-${file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")}.json`;
  reply.header("Content-Type", "application/json; charset=utf-8");
  reply.header("Content-Disposition", contentDisposition(filename));
  return reply.send(JSON.stringify(file, null, 2));
}

function mapThemeError(reply: FastifyReply, err: unknown) {
  if (err instanceof ThemeInvalidError) {
    return reply.code(400).send({ ...errorBody(err), errors: err.errors, contrastFailures: err.contrastFailures });
  }
  if (err instanceof ThemeNotFoundError) return reply.code(404).send(errorBody(err));
  if (err instanceof ThemeNameTakenError || err instanceof ThemeIsDefaultError || err instanceof ThemeLimitError) {
    return reply.code(409).send(errorBody(err));
  }
  throw err;
}

// System → Teman. Registered with the admin-only module rule in app.ts.
export async function themeRoutes(app: FastifyInstance, opts: { service: ThemesService }) {
  const { service } = opts;

  app.get("/themes", async () => service.list());

  // Upload preview: runs validateTheme and saves nothing.
  app.post("/themes/validate", { bodyLimit: THEME_BODY_LIMIT, config: { readOnlySafe: true } }, async (req) => {
    return service.validate(validateThemeBodySchema.parse(req.body));
  });

  app.post("/themes", { bodyLimit: THEME_BODY_LIMIT }, async (req, reply) => {
    const input = createThemeSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input, req.user!.id));
    } catch (err) {
      return mapThemeError(reply, err);
    }
  });

  // The built-in theme's parameter is not a uuid, so it is :name, never
  // :…Id (rejectMalformedIds would 400 it).
  app.get<{ Params: { name: string } }>("/themes/builtin/:name/export", async (req, reply) => {
    try {
      return sendThemeFile(reply, service.exportBuiltinTheme(req.params.name));
    } catch (err) {
      return mapThemeError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/themes/:id", async (req, reply) => {
    try {
      return await service.get(req.params.id);
    } catch (err) {
      return mapThemeError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/themes/:id/export", async (req, reply) => {
    try {
      return sendThemeFile(reply, await service.exportTheme(req.params.id));
    } catch (err) {
      return mapThemeError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/themes/:id", { bodyLimit: THEME_BODY_LIMIT }, async (req, reply) => {
    const input = updateThemeSchema.parse(req.body);
    try {
      return await service.update(req.params.id, input, req.user!.id);
    } catch (err) {
      return mapThemeError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/themes/:id", async (req, reply) => {
    try {
      await service.remove(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return mapThemeError(reply, err);
    }
  });
}
