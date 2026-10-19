import type { FastifyInstance } from "fastify";
import {
  createArticleNumberSeriesSchema,
  createCompanyCarrierSchema,
  updateCompanyCarrierSchema,
  updateCompanyInfoSchema,
  updateNumberSeriesSchema,
  updatePostingSettingsSchema,
  updateSystemSettingsSchema,
} from "@navet/shared";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { TERMINAL_READ } from "../../auth/middleware/access-rules.js";
import { contentDisposition } from "../service/content-disposition.js";
import { errorBody } from "../service/error-body.js";
import type { SystemService } from "../service/system.service.js";
import {
  BuiltInNumberSeriesError,
  CarrierNotFoundError,
  CompanyCarrierNotFoundError,
  DuplicateNumberSeriesNameError,
  DuplicateCompanyCarrierError,
  NumberSeriesNotFoundError,
} from "../service/system.service.js";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

// Registered inside app.ts's protected route scope (requireAuth already ran).
// The whole System module (Integrationer/Företagsinfo/Nummerserier) is
// admin-only, both hidden in the nav and enforced here.
export async function systemRoutes(app: FastifyInstance, opts: { service: SystemService }) {
  const { service } = opts;

  app.get("/company-info", { preHandler: requireRole("admin") }, async () => {
    return service.getCompanyInfo();
  });

  app.patch("/company-info", { preHandler: requireRole("admin") }, async (req) => {
    const input = updateCompanyInfoSchema.parse(req.body);
    return service.updateCompanyInfo(input, req.user!.id);
  });

  app.post("/company-info/logo", { preHandler: requireRole("admin") }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_LOGO_BYTES } });
    if (!file) return reply.code(400).send({ error: "No file provided" });
    if (!file.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "Only image files are allowed" });
    }
    const buffer = await file.toBuffer();
    await service.updateLogo(buffer, file.mimetype, req.user!.id);
    return reply.code(204).send();
  });

  app.get("/company-info/logo", { preHandler: requireRole("admin") }, async (_req, reply) => {
    const logo = await service.getLogo();
    if (!logo?.logo) return reply.code(404).send();
    reply.header("Content-Type", logo.logoContentType ?? "application/octet-stream");
    return reply.send(logo.logo);
  });

  // The only setting the stamp terminal reads — so the workshop profile never
  // needs the full settings payload.
  app.get("/settings/terminal", { config: { access: TERMINAL_READ } }, async () => {
    const settings = await service.getSettings();
    return { allowMultipleStamps: settings.allowMultipleStamps };
  });

  // Settings are readable by every office user (module read default). Writing
  // stays admin-only.
  app.get("/settings", async () => {
    return service.getSettings();
  });

  app.patch("/settings", { preHandler: requireRole("admin") }, async (req) => {
    const input = updateSystemSettingsSchema.parse(req.body);
    return service.updateSettings(input, req.user!.id);
  });

  // Ekonomi → Konteringsregler's standard accounts and kundreskontra
  // amounts. Same service path (and audit) as PATCH /settings, but the
  // schema admits only those keys, so the Ekonomi permission suffices.
  app.patch("/settings/posting", { config: { access: ["ekonomi"] } }, async (req) => {
    const input = updatePostingSettingsSchema.parse(req.body);
    return service.updateSettings(input, req.user!.id);
  });

  app.get("/number-series", { preHandler: requireRole("admin") }, async () => {
    return service.listNumberSeries();
  });

  // Full database backup (schema + rows, incl. bytea drawings/logo) streamed
  // as a gzipped SQL dump. Admin-only — the dump contains everything.
  app.get("/backup", { preHandler: requireRole("admin") }, async (_req, reply) => {
    const { filename, stream } = service.createBackup();
    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", contentDisposition(filename));
    return reply.send(stream);
  });

  // --- Company carrier accounts (Företagsinformation → Speditörer) ---

  app.get("/company-carriers", { preHandler: requireRole("admin") }, async () => service.listCompanyCarriers());

  app.post("/company-carriers", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = createCompanyCarrierSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.addCompanyCarrier(input, req.user!.id));
    } catch (err) {
      if (err instanceof CarrierNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicateCompanyCarrierError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/company-carriers/:id",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const input = updateCompanyCarrierSchema.parse(req.body);
      try {
        return await service.updateCompanyCarrier(req.params.id, input, req.user!.id);
      } catch (err) {
        if (err instanceof CompanyCarrierNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/company-carriers/:id",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      try {
        await service.removeCompanyCarrier(req.params.id, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof CompanyCarrierNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.patch<{ Params: { key: string } }>(
    "/number-series/:key",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const input = updateNumberSeriesSchema.parse(req.body);
      try {
        return await service.updateNumberSeries(req.params.key, input, req.user!.id);
      } catch (err) {
        if (err instanceof NumberSeriesNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof BuiltInNumberSeriesError) return reply.code(400).send(errorBody(err));
        if (err instanceof DuplicateNumberSeriesNameError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  // Egna artikelnummerserier (migration 0127).
  app.post("/number-series", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = createArticleNumberSeriesSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createArticleNumberSeries(input, req.user!.id));
    } catch (err) {
      if (err instanceof DuplicateNumberSeriesNameError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.delete<{ Params: { key: string } }>(
    "/number-series/:key",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      try {
        await service.deleteNumberSeries(req.params.key, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof NumberSeriesNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof BuiltInNumberSeriesError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );
}
