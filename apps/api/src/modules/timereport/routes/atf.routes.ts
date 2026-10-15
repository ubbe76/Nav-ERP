import type { FastifyInstance } from "fastify";
import { createAtfTransactionSchema } from "@navet/shared";
import type { AtfService } from "../service/atf.service.js";
import { AtfTransactionNotFoundError } from "../service/atf.service.js";
import { EmployeeNotFoundError } from "../service/timereport.service.js";
import { PayrollPeriodLockedError } from "../../payroll/service/period-lock.js";
import { errorBody } from "../../system/service/error-body.js";
import { TERMINAL_READ, TERMINAL_WRITE } from "../../auth/middleware/access-rules.js";

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

  app.post<{ Params: { id: string } }>("/employees/:id/atf-transactions", { config: { access: TERMINAL_WRITE } }, async (req, reply) => {
    const input = createAtfTransactionSchema.parse(req.body);
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
