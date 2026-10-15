import type { FastifyInstance } from "fastify";
import {
  createDayScheduleSchema,
  createHolidaySchema,
  createWeekScheduleSchema,
  generateSwedishHolidaysSchema,
  setDayOverrideSchema,
  setWeekOverrideSchema,
  updateDayScheduleSchema,
  updateWeekScheduleSchema,
} from "@navet/shared";
import type { ScheduleService } from "../service/schedule.service.js";
import {
  DayScheduleNotFoundError,
  DuplicateHolidayDateError,
  DuplicateScheduleCodeError,
  HolidayNotFoundError,
  InvalidScheduleError,
  ScheduleOverrideNotFoundError,
} from "../service/schedule.service.js";
import { EmployeeNotFoundError, WeekScheduleNotFoundError } from "../service/timereport.service.js";
import { PayrollPeriodLockedError } from "../../payroll/service/period-lock.js";
import { errorBody } from "../../system/service/error-body.js";
import { TERMINAL_READ } from "../../auth/middleware/access-rules.js";

function isNotFound(err: unknown): err is Error {
  return (
    err instanceof DayScheduleNotFoundError ||
    err instanceof WeekScheduleNotFoundError ||
    err instanceof HolidayNotFoundError ||
    err instanceof ScheduleOverrideNotFoundError ||
    err instanceof EmployeeNotFoundError
  );
}

// Registered inside app.ts's protected route scope — requireAuth has run.
export async function scheduleRoutes(app: FastifyInstance, opts: { service: ScheduleService }) {
  const { service } = opts;

  // Shared error mapping: 404 for missing entities, 409 for duplicate
  // code/date or a locked payroll period, 400 for semantically invalid
  // schedules.
  async function handle<T>(reply: { code(status: number): { send(body: unknown): unknown } }, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (isNotFound(err)) return reply.code(404).send(errorBody(err));
      if (
        err instanceof DuplicateScheduleCodeError ||
        err instanceof DuplicateHolidayDateError ||
        err instanceof PayrollPeriodLockedError
      ) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof InvalidScheduleError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  }

  // Dagsscheman
  app.get("/day-schedules", async () => service.listDaySchedules());

  app.post("/day-schedules", async (req, reply) => {
    const input = createDayScheduleSchema.parse(req.body);
    return handle(reply, async () => reply.code(201).send(await service.createDaySchedule(input)));
  });

  app.patch<{ Params: { id: string } }>("/day-schedules/:id", async (req, reply) => {
    const input = updateDayScheduleSchema.parse(req.body);
    return handle(reply, () => service.updateDaySchedule(req.params.id, input));
  });

  // Veckoscheman
  app.get("/week-schedules", async () => service.listWeekSchedules());

  app.post("/week-schedules", async (req, reply) => {
    const input = createWeekScheduleSchema.parse(req.body);
    return handle(reply, async () => reply.code(201).send(await service.createWeekSchedule(input)));
  });

  app.patch<{ Params: { id: string } }>("/week-schedules/:id", async (req, reply) => {
    const input = updateWeekScheduleSchema.parse(req.body);
    return handle(reply, () => service.updateWeekSchedule(req.params.id, input));
  });

  // Helgdagar
  app.get<{ Querystring: { year?: string } }>("/holidays", async (req) => {
    const year = req.query.year ? Number(req.query.year) : undefined;
    return service.listHolidays(Number.isNaN(year) ? undefined : year);
  });

  app.post("/holidays", async (req, reply) => {
    const input = createHolidaySchema.parse(req.body);
    return handle(reply, async () => reply.code(201).send(await service.createHoliday(input)));
  });

  app.post("/holidays/generate-swedish", async (req) => {
    const input = generateSwedishHolidaysSchema.parse(req.body);
    return service.generateSwedishHolidays(input.year);
  });

  app.delete<{ Params: { id: string } }>("/holidays/:id", async (req, reply) => {
    return handle(reply, async () => {
      await service.deleteHoliday(req.params.id);
      return reply.code(204).send(null);
    });
  });

  // Personalkalender — overrides + resolved calendar per employee.
  app.get<{ Params: { id: string } }>("/employees/:id/schedule-overrides", async (req, reply) => {
    return handle(reply, () => service.getEmployeeScheduleOverrides(req.params.id));
  });

  app.post<{ Params: { id: string } }>("/employees/:id/week-overrides", async (req, reply) => {
    const input = setWeekOverrideSchema.parse(req.body);
    return handle(reply, async () => reply.code(201).send(await service.setWeekOverride(req.params.id, input)));
  });

  app.delete<{ Params: { id: string; overrideId: string } }>(
    "/employees/:id/week-overrides/:overrideId",
    async (req, reply) => {
      return handle(reply, async () => {
        await service.deleteWeekOverride(req.params.id, req.params.overrideId);
        return reply.code(204).send(null);
      });
    }
  );

  app.post<{ Params: { id: string } }>("/employees/:id/day-overrides", async (req, reply) => {
    const input = setDayOverrideSchema.parse(req.body);
    return handle(reply, async () => reply.code(201).send(await service.setDayOverride(req.params.id, input)));
  });

  app.delete<{ Params: { id: string; overrideId: string } }>(
    "/employees/:id/day-overrides/:overrideId",
    async (req, reply) => {
      return handle(reply, async () => {
        await service.deleteDayOverride(req.params.id, req.params.overrideId);
        return reply.code(204).send(null);
      });
    }
  );

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/employees/:id/schedule-calendar",
    { config: { access: TERMINAL_READ } },
    async (req, reply) => {
      const { from, to } = req.query;
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return reply.code(400).send({ error: "Query params 'from' and 'to' must be YYYY-MM-DD dates" });
      }
      return handle(reply, () => service.resolveEmployeeCalendar(req.params.id, from, to));
    }
  );
}
