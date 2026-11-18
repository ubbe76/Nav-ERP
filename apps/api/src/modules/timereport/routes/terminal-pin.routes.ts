import type { FastifyInstance } from "fastify";
import { terminalPinInputSchema } from "@navet/shared";
import {
  TerminalPinAlreadySetError,
  TerminalPinLockedError,
  TerminalPinNotSetError,
  TerminalPinWrongError,
  type TerminalPinService,
} from "../service/terminal-pin.service.js";
import { EmployeeNotFoundError, InactiveEmployeeError } from "../service/timereport.service.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { PERSONAL, TERMINAL_PIN, TERMINAL_PIN_STATUS } from "../../auth/middleware/access-rules.js";
import { errorBody } from "../../system/service/error-body.js";

// Terminalkod — Kräv kod i stämpelterminalen (timereport.md). Registered
// inside app.ts's protected route scope. No answer here ever carries the
// code or its hash.
export async function terminalPinRoutes(app: FastifyInstance, opts: { service: TerminalPinService }) {
  const { service } = opts;
  type IdParams = { Params: { id: string } };

  // After the anställningsnummer: is a code chosen, is it locked? The
  // personnel card shows the same two facts.
  app.get<IdParams>("/employees/:id/terminal-pin", { config: { access: TERMINAL_PIN_STATUS } }, async (req, reply) => {
    try {
      return await service.status(req.params.id);
    } catch (err) {
      if (err instanceof EmployeeNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Välj en kod. Not readOnlySafe: it stores something for the employee.
  app.post<IdParams>("/employees/:id/terminal-pin", { config: { access: TERMINAL_PIN } }, async (req, reply) => {
    const { pin } = terminalPinInputSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.choose(req.params.id, pin, req.user!));
    } catch (err) {
      if (err instanceof EmployeeNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InactiveEmployeeError || err instanceof TerminalPinAlreadySetError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // The code after the number. readOnlySafe on purpose (as a login, which a
  // read-only account also makes): it changes no business data — only the
  // counter of wrong attempts — and without it a read-only account at the
  // terminal could no longer read what it reads with the setting off.
  app.post<IdParams>(
    "/employees/:id/terminal-pin/verify",
    { config: { access: TERMINAL_PIN, readOnlySafe: true } },
    async (req, reply) => {
      const { pin } = terminalPinInputSchema.parse(req.body);
      try {
        return await service.verify(req.params.id, pin, req.user!);
      } catch (err) {
        if (err instanceof EmployeeNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InactiveEmployeeError || err instanceof TerminalPinNotSetError) return reply.code(409).send(errorBody(err));
        if (err instanceof TerminalPinWrongError) return reply.code(403).send({ ...errorBody(err), attemptsLeft: err.attemptsLeft });
        if (err instanceof TerminalPinLockedError) {
          return reply.code(429).send({ ...errorBody(err), lockedUntil: err.lockedUntil.toISOString() });
        }
        throw err;
      }
    }
  );

  // Nollställ terminalkoden — the personnel card's action: Personal & lön
  // AND admin/supervisor, like the card itself.
  app.delete<IdParams>(
    "/employees/:id/terminal-pin",
    { config: { access: PERSONAL }, preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      try {
        return await service.reset(req.params.id, req.user!.id);
      } catch (err) {
        if (err instanceof EmployeeNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );
}
