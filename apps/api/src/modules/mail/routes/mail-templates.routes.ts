import type { FastifyInstance } from "fastify";
import { mailTemplateParamsSchema, mailTemplateSchema, mailTextRequestSchema } from "@navet/shared";
import type { AuthService } from "../../auth/service/auth.service.js";
import { requireAuth } from "../../auth/middleware/auth.middleware.js";
import { errorBody } from "../../system/service/error-body.js";
import { MailTemplatePlaceholderError, type MailTemplatesService } from "../service/mail-templates.service.js";

// E-postmallar (Mina inställningar): the signed-in user's own templates.
// Like /me/settings these sit outside the permission gate — they reach only
// the session user's own rows (permissions-coverage.test.ts lists them).
// Saving and resetting are writes, so an Endast läsning account gets 403;
// POST /me/mail-text only fills in a text and is readOnlySafe.
export async function mailTemplatesRoutes(app: FastifyInstance, opts: { auth: AuthService; service: MailTemplatesService }) {
  const { auth, service } = opts;
  const preHandler = requireAuth(auth);

  app.get("/me/mail-templates", { preHandler }, async (req) => service.list(req.user!.id));

  app.put("/me/mail-templates/:kind/:language", { preHandler }, async (req, reply) => {
    const { kind, language } = mailTemplateParamsSchema.parse(req.params);
    const template = mailTemplateSchema.parse(req.body);
    try {
      return await service.save(req.user!.id, kind, language, template);
    } catch (err) {
      if (err instanceof MailTemplatePlaceholderError) {
        return reply.code(400).send({ ...errorBody(err), placeholders: err.placeholders });
      }
      throw err;
    }
  });

  // Återställ förval: answers with the default now in force.
  app.delete("/me/mail-templates/:kind/:language", { preHandler }, async (req) => {
    const { kind, language } = mailTemplateParamsSchema.parse(req.params);
    return service.reset(req.user!.id, kind, language);
  });

  app.post("/me/mail-text", { preHandler, config: { readOnlySafe: true } }, async (req, reply) => {
    const input = mailTextRequestSchema.parse(req.body);
    try {
      return await service.render({ id: req.user!.id, name: req.user!.name }, input);
    } catch (err) {
      if (err instanceof MailTemplatePlaceholderError) {
        return reply.code(400).send({ ...errorBody(err), placeholders: err.placeholders });
      }
      throw err;
    }
  });
}
