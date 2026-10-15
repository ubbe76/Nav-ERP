import type { FastifyInstance } from "fastify";
import {
  attendanceInSchema,
  createEmployeeSchema,
  createTimeReportSchema,
  listQuerySchema,
  stampInSchema,
  stampOutSchema,
  updateAttendanceSessionSchema,
  updateEmployeeSchema,
  updateTimeReportSchema,
} from "@navet/shared";
import type { TimeReportService } from "../service/timereport.service.js";
import {
  AlreadyPresentError,
  AlreadyStampedInError,
  AttendanceSessionAlreadyStoppedError,
  AttendanceSessionNotFoundError,
  DuplicateEmployeeNumberError,
  EmployeeNotFoundError,
  InactiveEmployeeError,
  InvalidAttendanceIntervalError,
  StampSessionAlreadyStoppedError,
  StampSessionNotFoundError,
  TimeReportNotFoundError,
  WeekScheduleNotFoundError,
} from "../service/timereport.service.js";
import {
  InvalidStatusTransitionError,
  MOOperationNotFoundError,
} from "../../manufacturing/service/manufacturing.service.js";
import { PayrollPeriodLockedError } from "../../payroll/service/period-lock.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { DIRECTORY_READ, MO_READ, TERMINAL_READ, TERMINAL_WRITE } from "../../auth/middleware/access-rules.js";
import { LocationUnderStockCountError } from "../../stock/service/stock.service.js";
import { materialShortageBody } from "../../manufacturing/service/material-shortage.js";
import { MaterialShortageError } from "../../manufacturing/service/manufacturing.service.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { timeReportExportColumns } from "../service/export-columns.js";
import { errorBody } from "../../system/service/error-body.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function timeReportRoutes(app: FastifyInstance, opts: { service: TimeReportService }) {
  const { service } = opts;

  // The full personnel record (personnummer, wage, address) is for Personal —
  // admin/supervisor only. Everyone else reads /employees/directory.
  app.get("/employees", { preHandler: requireRole("admin", "supervisor") }, async () => service.listEmployees());

  // Shop-floor view of the personnel register: no personnummer, wage or
  // address. The terminal and the MO card use this; the full record is for
  // Personal (admin/supervisor) only. Kept before /employees/:id.
  app.get("/employees/directory", { config: { access: DIRECTORY_READ } }, async () => service.listEmployeeDirectory());

  app.get<{ Params: { id: string } }>("/employees/:id", { preHandler: requireRole("admin", "supervisor") }, async (req, reply) => {
    const employee = await service.getEmployee(req.params.id);
    if (!employee) return reply.code(404).send({ error: "Employee not found" });
    return employee;
  });

  // Writes are Personal too: PATCH echoes the full row (personnummer, wage).
  app.post("/employees", { preHandler: requireRole("admin", "supervisor") }, async (req, reply) => {
    const input = createEmployeeSchema.parse(req.body);
    const employee = await service.createEmployee(input);
    return reply.code(201).send(employee);
  });

  app.patch<{ Params: { id: string } }>("/employees/:id", { preHandler: requireRole("admin", "supervisor") }, async (req, reply) => {
    const input = updateEmployeeSchema.parse(req.body);
    try {
      return await service.updateEmployee(req.params.id, input);
    } catch (err) {
      if (err instanceof EmployeeNotFoundError || err instanceof WeekScheduleNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof DuplicateEmployeeNumberError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get("/time-reports", async (req) => service.listTimeReports(listQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/time-reports/csv",
    querySchema: listQuerySchema,
    filenameBase: "tidrapporter",
    columns: timeReportExportColumns,
    fetch: (query) => service.listTimeReports(query),
  });

  app.post("/time-reports", async (req, reply) => {
    const input = createTimeReportSchema.parse(req.body);
    try {
      const report = await service.createTimeReport(input, req.user!.id);
      return reply.code(201).send(report);
    } catch (err) {
      if (err instanceof PayrollPeriodLockedError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/manufacturing-orders/:id/time-reports", { config: { access: MO_READ } }, async (req) => {
    return service.listTimeReportsByManufacturingOrder(req.params.id);
  });

  // Stämplingar — the stamp terminal's endpoints.
  app.get<{ Querystring: { open?: string } }>("/stamp-sessions", { config: { access: TERMINAL_READ } }, async (req) => {
    return service.listStampSessions(req.query.open === "true");
  });

  app.post("/stamp-sessions", { config: { access: TERMINAL_WRITE } }, async (req, reply) => {
    const input = stampInSchema.parse(req.body);
    try {
      const session = await service.stampIn(input, req.user!.id);
      return reply.code(201).send(session);
    } catch (err) {
      if (err instanceof EmployeeNotFoundError || err instanceof MOOperationNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (
        err instanceof InactiveEmployeeError ||
        err instanceof AlreadyStampedInError ||
        err instanceof InvalidStatusTransitionError
      ) {
        return reply.code(409).send(errorBody(err));
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/stamp-sessions/:id/stop", { config: { access: TERMINAL_WRITE } }, async (req, reply) => {
    const input = stampOutSchema.parse(req.body ?? {});
    try {
      return await service.stampOut(req.params.id, input, req.user!.id);
    } catch (err) {
      if (err instanceof StampSessionNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof StampSessionAlreadyStoppedError || err instanceof InvalidStatusTransitionError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
      // Materialbrist: refused before anything was written — the session is
      // still open and no time report exists.
      if (err instanceof MaterialShortageError) return reply.code(409).send(materialShortageBody(err));
      throw err;
    }
  });

  // Närvarostämpling (kom/gå) — the terminal's attendance endpoints.
  app.get<{ Querystring: { open?: string } }>("/attendance-sessions", { config: { access: TERMINAL_READ } }, async (req) => {
    return service.listAttendanceSessions(req.query.open === "true");
  });

  app.post("/attendance-sessions", { config: { access: TERMINAL_WRITE } }, async (req, reply) => {
    const input = attendanceInSchema.parse(req.body);
    try {
      const session = await service.attendanceIn(input, req.user!.id);
      return reply.code(201).send(session);
    } catch (err) {
      if (err instanceof EmployeeNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InactiveEmployeeError || err instanceof AlreadyPresentError) {
        return reply.code(409).send(errorBody(err));
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/attendance-sessions/:id/stop", { config: { access: TERMINAL_WRITE } }, async (req, reply) => {
    try {
      return await service.attendanceOut(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof AttendanceSessionNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof AttendanceSessionAlreadyStoppedError || err instanceof InvalidStatusTransitionError) {
        return reply.code(409).send(errorBody(err));
      }
      throw err;
    }
  });

  // Supervised corrections — attestation depends on these to fix stray
  // stamps/reports before a period is locked, so both routes are restricted
  // to admin/supervisor.
  app.patch<{ Params: { id: string } }>(
    "/attendance-sessions/:id",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const input = updateAttendanceSessionSchema.parse(req.body);
      try {
        return await service.updateAttendanceSession(req.params.id, input, req.user!.id);
      } catch (err) {
        if (err instanceof AttendanceSessionNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidAttendanceIntervalError) return reply.code(400).send(errorBody(err));
        if (err instanceof AlreadyPresentError || err instanceof PayrollPeriodLockedError) {
          return reply.code(409).send(errorBody(err));
        }
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/attendance-sessions/:id",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      try {
        await service.deleteAttendanceSession(req.params.id, req.user!.id);
        return reply.code(204).send(null);
      } catch (err) {
        if (err instanceof AttendanceSessionNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof PayrollPeriodLockedError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  app.patch<{ Params: { id: string } }>(
    "/time-reports/:id",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      const input = updateTimeReportSchema.parse(req.body);
      try {
        return await service.updateTimeReport(req.params.id, input, req.user!.id);
      } catch (err) {
        if (err instanceof TimeReportNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof PayrollPeriodLockedError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/time-reports/:id",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      try {
        await service.deleteTimeReport(req.params.id, req.user!.id);
        return reply.code(204).send(null);
      } catch (err) {
        if (err instanceof TimeReportNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof PayrollPeriodLockedError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );
}
