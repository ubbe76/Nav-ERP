import type { FastifyInstance } from "fastify";
import { createAtfTransactionSchema } from "@navet/shared";
import type { AtfService } from "../service/atf.service.js";
import { AtfTransactionNotFoundError } from "../service/atf.service.js";
import { EmployeeNotFoundError } from "../service/timereport.service.js";
import { PayrollPeriodLockedError } from "../../payroll/service/period-lock.js";
import { satisfiesRule } from "@navet/shared";
import { errorBody } from "../../system/service/error-body.js";
import { ATF_WITHDRAW, PERSONAL, PERSONNEL_CARD_WRITE, TERMINAL_READ } from "../../auth/middleware/access-rules.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { ForbiddenError } from "../../auth/middleware/permission.middleware.js";

// Registered inside app.ts's protected route scope — requireAuth has run.
export async function atfRoutes(app: FastifyInstance, opts: { service: AtfService }) {
  const { service } = opts;

  app.get<{ Params: { id: string } }>("/employees/:id/atf", { config: { access: TERMINAL_READ } }, async (req, reply) => {
    try {
      return await service.getAtfStatus(req.params.id);
    } catch (err) {
      if (err instanceof EmployeeNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Made from the terminal (Ta ut ATF) and from the personnel card's ATF tab
  // (Personal & lön). The gate admits both, so the type decides here: a
  // withdrawal (1–1440 min) is anyone's who may stamp, but an adjustment
  // rewrites the balance by up to ±100 000 min and is the personnel card's
  // alone — Personal & lön AND admin/supervisor, like the card itself.
  app.post<{ Params: { id: string } }>("/employees/:id/atf-transactions", { config: { access: ATF_WITHDRAW } }, async (req, reply) => {
    const input = createAtfTransactionSchema.parse(req.body);
    if (input.type === "adjustment") {
      const user = req.user!;
      const supervises = user.role === "admin" || user.role === "supervisor";
      if (!supervises || !satisfiesRule(user, PERSONAL)) return reply.code(403).send(errorBody(new ForbiddenError()));
    }
    try {
      const transaction = await service.createAtfTransaction(req.params.id, input, req.user!.id);
      return reply.code(201).send(transaction);
    } catch (err) {
      if (err instanceof EmployeeNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof PayrollPeriodLockedError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.delete<{ Params: { id: string; transactionId: string } }>(
    "/employees/:id/atf-transactions/:transactionId",
    // The personnel card's own action: the card is admin/supervisor only.
    { config: { access: PERSONNEL_CARD_WRITE }, preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      try {
        await service.deleteAtfTransaction(req.params.id, req.params.transactionId);
        return reply.code(204).send(null);
      } catch (err) {
        if (err instanceof EmployeeNotFoundError || err instanceof AtfTransactionNotFoundError) {
          return reply.code(404).send(errorBody(err));
        }
        if (err instanceof PayrollPeriodLockedError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );
}
