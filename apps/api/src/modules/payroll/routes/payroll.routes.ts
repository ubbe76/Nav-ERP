import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createAbsenceSchema,
  createAbsenceTypeSchema,
  createAttendanceDeviationReasonSchema,
  updateAttendanceDeviationReasonSchema,
  createObRuleSchema,
  setOvertimeDispositionSchema,
  updateAbsenceTypeSchema,
  updateObRuleSchema,
} from "@navet/shared";
import { TERMINAL_READ } from "../../auth/middleware/access-rules.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { EmployeeNotFoundError } from "../../timereport/service/timereport.service.js";
import type { PayrollService } from "../service/payroll.service.js";
import {
  AbsenceNotFoundError,
  AbsenceTypeNotFoundError,
  AlreadyAttestedError,
  AttendanceDeviationReasonNotFoundError,
  AttestationNotFoundError,
  DuplicateAbsenceError,
  DuplicatePayrollCodeError,
  InactiveAbsenceTypeError,
  InvalidObWindowError,
  ObRuleNotFoundError,
  OvertimeDispositionNotFoundError,
  PeriodNotEndedError,
  PeriodNotLockedError,
  UnattestedEmployeesError,
  UnfinishedAttendanceError,
} from "../service/payroll.service.js";
import { PayrollPeriodLockedError } from "../service/period-lock.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";

// NOT z.coerce.boolean() — that turns the string "false" into true (same
// pitfall as stock locations' includeInactive query param).
const listQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

// Calendar-month params for the period summary routes. Out-of-range values
// (year outside 2000–2100, month outside 1–12) fail here and are turned into
// a 400 by the app-wide ZodError handler in app.ts, same as every other
// zod-validated route in the API.
const periodParamsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

const attestBodySchema = z.object({ employeeId: z.string().uuid() });

function isNotFound(err: unknown): err is Error {
  return (
    err instanceof AbsenceTypeNotFoundError ||
    err instanceof AttendanceDeviationReasonNotFoundError ||
    err instanceof ObRuleNotFoundError ||
    err instanceof AbsenceNotFoundError ||
    err instanceof AttestationNotFoundError ||
    err instanceof EmployeeNotFoundError ||
    err instanceof OvertimeDispositionNotFoundError
  );
}

// Status-flow conflicts: the period/attestation is not in a state that
// allows the requested transition.
function isStatusConflict(err: unknown): err is Error {
  return (
    err instanceof PayrollPeriodLockedError ||
    err instanceof AlreadyAttestedError ||
    err instanceof UnfinishedAttendanceError ||
    err instanceof PeriodNotEndedError ||
    err instanceof PeriodNotLockedError
  );
}

// Registered inside app.ts's protected route scope — requireAuth has run.
// Löneunderlag base-data registers: frånvarokoder and OB-regler. GETs are
// open to any logged-in user; writes (incl. the standard seeder) are
// admin-only, same split as the system module.
export async function payrollRoutes(app: FastifyInstance, opts: { service: PayrollService }) {
  const { service } = opts;

  // Shared error mapping: 404 for missing entities, 409 for duplicate
  // code/name/booking or a locked payroll period, 400 for a semantically
  // invalid OB window or an inactive absence type.
  async function handle<T>(reply: { code(status: number): { send(body: unknown): unknown } }, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (isNotFound(err)) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicatePayrollCodeError || err instanceof DuplicateAbsenceError) {
        return reply.code(409).send(errorBody(err));
      }
      // Carries the blocking employees so the UI can list them directly.
      if (err instanceof UnattestedEmployeesError) {
        return reply.code(409).send({ ...errorBody(err), names: err.names });
      }
      if (isStatusConflict(err)) return reply.code(409).send(errorBody(err));
      if (err instanceof InvalidObWindowError || err instanceof InactiveAbsenceTypeError) {
        return reply.code(400).send(errorBody(err));
      }
      throw err;
    }
  }

  // Frånvarokoder
  app.get("/absence-types", async (req) => {
    const { includeInactive } = listQuerySchema.parse(req.query);
    return service.listAbsenceTypes(includeInactive);
  });

  app.post("/absence-types", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = createAbsenceTypeSchema.parse(req.body);
    return handle(reply, async () => reply.code(201).send(await service.createAbsenceType(input)));
  });

  app.patch<{ Params: { id: string } }>(
    "/absence-types/:id",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const input = updateAbsenceTypeSchema.parse(req.body);
      return handle(reply, () => service.updateAbsenceType(req.params.id, input));
    }
  );

  // Idempotent pre-fill with the standard Swedish absence codes.
  app.post("/absence-types/generate-standard", { preHandler: requireRole("admin") }, async () => {
    return service.seedStandardAbsenceTypes();
  });

  // Avvikelseorsaker: readable by office and the stamp terminal (which offers
  // the active ones); writes are admin-only. No DELETE — sessions keep the
  // reason as history, so a reason is only inactivated.
  app.get("/attendance-deviation-reasons", { config: { access: TERMINAL_READ } }, async (req) => {
    const { includeInactive } = listQuerySchema.parse(req.query);
    return service.listAttendanceDeviationReasons(includeInactive);
  });

  app.post("/attendance-deviation-reasons", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = createAttendanceDeviationReasonSchema.parse(req.body);
    return handle(reply, async () => reply.code(201).send(await service.createAttendanceDeviationReason(input)));
  });

  app.patch<{ Params: { id: string } }>(
    "/attendance-deviation-reasons/:id",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const input = updateAttendanceDeviationReasonSchema.parse(req.body);
      return handle(reply, () => service.updateAttendanceDeviationReason(req.params.id, input));
    }
  );

  // OB-regler
  app.get("/ob-rules", async (req) => {
    const { includeInactive } = listQuerySchema.parse(req.query);
    return service.listObRules(includeInactive);
  });

  app.post("/ob-rules", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = createObRuleSchema.parse(req.body);
    return handle(reply, async () => reply.code(201).send(await service.createObRule(input)));
  });

  app.patch<{ Params: { id: string } }>("/ob-rules/:id", { preHandler: requireRole("admin") }, async (req, reply) => {
    const input = updateObRuleSchema.parse(req.body);
    return handle(reply, () => service.updateObRule(req.params.id, input));
  });

  // Frånvaro — per-employee absence bookings. Admin/supervisor only, both
  // read and write: this is health data, and the only web consumer of the
  // GET (personalkortet) is itself gated to admin/supervisor — there is no
  // legitimate plain-user path to an employee's absence history.
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/employees/:id/absences",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const { from, to } = req.query;
      const isDateString = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
      if ((from && !isDateString(from)) || (to && !isDateString(to))) {
        return reply.code(400).send({ error: "Query params 'from' and 'to' must be YYYY-MM-DD dates" });
      }
      return handle(reply, () => service.listEmployeeAbsences(req.params.id, from, to));
    }
  );

  app.post<{ Params: { id: string } }>(
    "/employees/:id/absences",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const input = createAbsenceSchema.parse(req.body);
      return handle(reply, async () =>
        reply.code(201).send(await service.createAbsence(req.params.id, input, req.user!.id))
      );
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/absences/:id",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      return handle(reply, async () => {
        await service.deleteAbsence(req.params.id, req.user!.id);
        return reply.code(204).send(null);
      });
    }
  );

  // Övertidsdispositioner — per-dag-avvikelse från personalkortets
  // overtime_compensation-default. Same audience as absence bookings.
  app.put<{ Params: { id: string; date: string } }>(
    "/employees/:id/overtime-disposition/:date",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
        return reply.code(400).send({ error: "Param 'date' must be a YYYY-MM-DD date" });
      }
      const input = setOvertimeDispositionSchema.parse(req.body);
      return handle(reply, async () =>
        reply.send(await service.setOvertimeDisposition(req.params.id, req.params.date, input.disposition, req.user!.id))
      );
    }
  );

  app.delete<{ Params: { id: string; date: string } }>(
    "/employees/:id/overtime-disposition/:date",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
        return reply.code(400).send({ error: "Param 'date' must be a YYYY-MM-DD date" });
      }
      return handle(reply, async () => {
        await service.clearOvertimeDisposition(req.params.id, req.params.date, req.user!.id);
        return reply.code(204).send(null);
      });
    }
  );

  // Löneperiod-sammanställning — read-only, admin/supervisor only (same
  // audience as period locking will be in Task 8).
  app.get<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month",
    { preHandler: requireRole("admin", "supervisor") },
    async (req) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      return service.getPeriodSummary(year, month);
    }
  );

  app.get<{ Params: { year: string; month: string; employeeId: string } }>(
    "/periods/:year/:month/employees/:employeeId/days",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      return handle(reply, () => service.getEmployeePeriodDays(req.params.employeeId, year, month));
    }
  );

  // Export av löneunderlag — same audience as the summary they export.
  // PAXml is the payroll program's import file (locked periods only, enforced
  // in the service); the CSV is a spreadsheet-friendly preview.
  app.get<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/paxml",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      return handle(reply, async () => {
        const { filename, content } = await service.getPaxmlExport(year, month, req.user!.id);
        reply.header("Content-Type", "application/xml");
        reply.header("Content-Disposition", contentDisposition(filename));
        return reply.send(content);
      });
    }
  );

  app.get<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/csv",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      return handle(reply, async () => {
        const { filename, content } = await service.getCsvExport(year, month);
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", contentDisposition(filename));
        return reply.send(content);
      });
    }
  );

  // Printable löneunderlag PDF — same audience/period-availability as the
  // CSV above (allowed on an open period, unlike PAXml).
  app.get<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/pdf",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      return handle(reply, async () => {
        const { filename, content } = await service.getPayrollPdf(year, month);
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", contentDisposition(filename));
        return reply.send(content);
      });
    }
  );

  // Attestering — per employee, same audience as the summary itself.
  app.post<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/attest",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      const { employeeId } = attestBodySchema.parse(req.body);
      return handle(reply, async () => {
        await service.attest(year, month, employeeId, req.user!.id);
        return reply.code(204).send(null);
      });
    }
  );

  app.delete<{ Params: { year: string; month: string; employeeId: string } }>(
    "/periods/:year/:month/attest/:employeeId",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      return handle(reply, async () => {
        await service.unattest(year, month, req.params.employeeId, req.user!.id);
        return reply.code(204).send(null);
      });
    }
  );

  // Låsning/upplåsning — admin only: locking freezes the basis for everyone
  // and blocks every write into the month.
  app.post<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/lock",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      return handle(reply, () => service.lockPeriod(year, month, req.user!.id));
    }
  );

  app.post<{ Params: { year: string; month: string } }>(
    "/periods/:year/:month/unlock",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const { year, month } = periodParamsSchema.parse(req.params);
      return handle(reply, async () => {
        await service.unlockPeriod(year, month, req.user!.id);
        return reply.code(204).send(null);
      });
    }
  );
}
