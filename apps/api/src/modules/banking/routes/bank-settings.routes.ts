import type { FastifyInstance } from "fastify";
import { updateBankSettingsSchema } from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { errorBody } from "../../system/service/error-body.js";
import type { BankSettingsService } from "../service/bank-settings.service.js";
import { InvalidBankSettingError } from "../service/banking.errors.js";

// Registered with registerModule({ read: ["inkop","forsaljning","ekonomi"],
// write: ["admin"] }) in app.ts; each route ALSO carries requirePermission so
// the guard holds in a mini-app test without the module gate.
export async function bankSettingsRoutes(app: FastifyInstance, opts: { service: BankSettingsService }) {
  const { service } = opts;
  const read = { preHandler: requirePermission("inkop", "forsaljning", "ekonomi") };
  const admin = { preHandler: requirePermission("admin") };

  app.get("/bank-settings", read, async () => service.read());

  app.patch("/bank-settings", admin, async (req, reply) => {
    const input = updateBankSettingsSchema.parse(req.body);
    try {
      return await service.update(input, req.user!.id);
    } catch (err) {
      if (err instanceof InvalidBankSettingError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });
}
