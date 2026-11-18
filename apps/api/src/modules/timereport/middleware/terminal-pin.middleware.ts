import type { FastifyReply, FastifyRequest } from "fastify";
import { TERMINAL_PIN_HEADER } from "@navet/shared";
import { errorBody } from "../../system/service/error-body.js";
import { TerminalPinRequiredError, type TerminalPinService, type TerminalPinSubject } from "../service/terminal-pin.service.js";

declare module "fastify" {
  interface FastifyContextConfig {
    // Terminalkod: the route acts for ONE employee at the stämpelterminal
    // (stamping, reporting, the employee's messages, ATF) — how it names
    // that employee. With Kräv kod i stämpelterminalen on, a terminal
    // account needs the bevistoken for exactly that employee here.
    // terminal-pin.route.test.ts locks the list of guarded routes.
    terminalPinEmployee?: TerminalPinSubject;
  }
}

// Runs in the protected scope after enforceAccess and rejectMalformedIds
// (the body is parsed by then). Cheapest question first: a route without the
// config and an office user never read the setting.
export function enforceTerminalPin(pins: TerminalPinService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const subject = req.routeOptions.config.terminalPinEmployee;
    if (!subject || !req.user) return;
    if (!pins.guards(req.user)) return;
    if (!(await pins.required())) return;
    const employeeId = await pins.subjectOf(subject, req);
    const header = req.headers[TERMINAL_PIN_HEADER];
    const token = typeof header === "string" ? header : undefined;
    if (!employeeId || !(await pins.proves(token, req.user, employeeId))) {
      return reply.code(403).send(errorBody(new TerminalPinRequiredError()));
    }
  };
}
