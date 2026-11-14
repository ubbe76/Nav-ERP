import type { FastifyInstance } from "fastify";
import { mailSignaturePreviewSchema, mailSignatureSchema } from "@navet/shared";
import type { AuthService } from "../../auth/service/auth.service.js";
import { requireAuth } from "../../auth/middleware/auth.middleware.js";
import type { MailSignatureService } from "../service/mail-signature.js";

// E-postsignatur (Mina inställningar): the signed-in user's own signature.
// Like /me/mail-templates these sit outside the permission gate — they reach
// only the session user's own row (permissions-coverage.test.ts lists them).
// Saving and the preview are writes for the read-only guard: an Endast
// läsning account sends no documents and gets 403 (the page shows it none).
export async function mailSignatureRoutes(app: FastifyInstance, opts: { auth: AuthService; service: MailSignatureService }) {
  const { auth, service } = opts;
  const preHandler = requireAuth(auth);

  // The saved signature plus the account's name and e-mail (the two details
  // that come from the account, shown read-only on the page).
  app.get("/me/mail-signature", { preHandler }, async (req) => ({
    ...(await service.get(req.user!.id)),
    name: req.user!.name,
    email: req.user!.email,
  }));

  app.put("/me/mail-signature", { preHandler }, async (req) => {
    const signature = mailSignatureSchema.parse(req.body);
    return { ...(await service.save(req.user!.id, signature)), name: req.user!.name, email: req.user!.email };
  });

  // Förhandsvisning: the signature as written (saved or not), as HTML for a
  // sandboxed frame (the logo inline as a data: URL) and as text.
  app.post("/me/mail-signature/preview", { preHandler }, async (req) => {
    const { language, ...signature } = mailSignaturePreviewSchema.parse(req.body);
    return service.preview({ name: req.user!.name, email: req.user!.email }, signature, language);
  });
}
