import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

// Migration 0229 (Detaljplanering per dag, #18) converts the existing week
// plans to day plans in plain SQL. The suite's own database is already past
// it, so the conversion is tested where it runs for real: a throwaway
// database is migrated up to 0228, week plans are written into the OLD
// tables, and then the 0229 file itself is applied — the same statements, in
// the same order, as an upgrade runs them (fresh-install.test.ts covers the
// empty database).
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));
const TAG = "0229_plan_days";

const uuid = () => crypto.randomUUID();

describe("migration 0229 — veckoplanerna blir dagplaner", () => {
  it("shares each week over its working days: the sum kept, full-day holidays left out, a tiny week on one day, locks kept", async () => {
    const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
    const index = journal.entries.findIndex((e) => e.tag === TAG);
    expect(index).toBeGreaterThan(0);
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    expect(migrations.length).toBe(journal.entries.length);

    const base = new URL(process.env.DATABASE_URL!);
    const name = `${base.pathname.slice(1)}_plan_days_${process.pid}`;
    expect(name).toMatch(/test/i);
    const maintenanceUrl = new URL(base);
    maintenanceUrl.pathname = "/postgres";
    const server = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => {} });
    const url = new URL(base);
    url.pathname = `/${name}`;
    try {
      await server.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await server.unsafe(`CREATE DATABASE "${name}"`);
      const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
      const apply = async (migration: (typeof migrations)[number]) =>
        sql.begin(async (tx) => {
          for (const statement of migration.sql) await tx.unsafe(statement);
        });
      try {
        // Each migration in its own transaction, like runMigrations.
        for (const migration of migrations.slice(0, index)) await apply(migration);

        // The operations are written without their order and resource (the
        // FK triggers are off for the fixtures only): the conversion reads
        // mo_operations, mo_operation_plan_weeks and holidays, nothing else.
        const op = {
          twoWeeks: uuid(), // W1 1200 min + W2 600.01 min, locked
          tiny: uuid(), // 0.03 min: cannot be shared
          lumped: uuid(), // 0.08 min: the parts fit, the remainder would be 0
          small: uuid(), // 0.07 min: just shareable
          shortDay: uuid(), // W3 has a short day (a holiday WITH a day schedule)
          fridayOff: uuid(), // W4's Friday is a full-day holiday
          closedWeek: uuid(), // every day of the week a full-day holiday
          unplanned: uuid(),
        };
        const plannedAt = "2030-03-01T08:00:00.000Z";
        await sql.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role = replica`;
          let seq = 0;
          const order = uuid();
          for (const id of Object.values(op)) {
            seq += 10;
            await tx`
              INSERT INTO mo_operations (id, manufacturing_order_id, sequence_no, work_center_id, setup_time, run_time_per_unit)
              VALUES (${id}, ${order}, ${seq}, ${uuid()}, 0, 1)`;
          }
          const weeks: [string, string, string][] = [
            [op.twoWeeks, "2030-03-04", "1200"],
            [op.twoWeeks, "2030-03-11", "600.01"],
            [op.tiny, "2030-03-04", "0.03"],
            [op.lumped, "2030-03-04", "0.08"],
            [op.small, "2030-03-04", "0.07"],
            [op.shortDay, "2030-03-18", "100"],
            [op.fridayOff, "2030-03-25", "100"],
            [op.closedWeek, "2030-04-01", "77.77"],
          ];
          for (const [id, monday, minutes] of weeks) {
            await tx`INSERT INTO mo_operation_plan_weeks (mo_operation_id, week_monday, minutes) VALUES (${id}, ${monday}, ${minutes})`;
          }
          await tx`
            UPDATE mo_operations o
            SET planned_start_week = w.s, planned_end_week = w.e, planned_at = ${plannedAt}::timestamptz
            FROM (SELECT mo_operation_id, min(week_monday) AS s, max(week_monday) AS e FROM mo_operation_plan_weeks GROUP BY 1) w
            WHERE w.mo_operation_id = o.id`;
          await tx`UPDATE mo_operations SET plan_locked = true WHERE id = ${op.twoWeeks}`;
          // Full-day holidays: Wednesday of W2, Friday of W4 and the whole
          // week of 1 April. Wednesday of W3 is a SHORT day (it has a day
          // schedule) — still a working day.
          for (const date of ["2030-03-13", "2030-03-29", "2030-04-01", "2030-04-02", "2030-04-03", "2030-04-04", "2030-04-05"]) {
            await tx`INSERT INTO holidays (date, name) VALUES (${date}, ${`Röd ${date}`})`;
          }
          await tx`INSERT INTO holidays (date, name, day_schedule_id) VALUES ('2030-03-20', 'Kortdag', ${uuid()})`;
        });
        const before = await sql<{ id: string; minutes: string }[]>`
          SELECT mo_operation_id AS id, sum(minutes)::text AS minutes FROM mo_operation_plan_weeks GROUP BY 1`;

        await apply(migrations[index]!);

        const rowsOf = async (id: string) =>
          (
            await sql<{ d: string; minutes: string }[]>`
              SELECT plan_date::text AS d, minutes::text AS minutes FROM mo_operation_plan_days WHERE mo_operation_id = ${id} ORDER BY plan_date`
          ).map((r) => [r.d, r.minutes]);
        const mirrorOf = async (id: string) => {
          const [row] = await sql<{ s: string | null; e: string | null; locked: boolean; at: Date | null; pos: number | null }[]>`
            SELECT planned_start_date::text AS s, planned_end_date::text AS e, plan_locked AS locked, planned_at AS at, run_position AS pos
            FROM mo_operations WHERE id = ${id}`;
          return row!;
        };

        // The sum per operation is exactly the weeks' sum.
        const after = await sql<{ id: string; minutes: string }[]>`
          SELECT mo_operation_id AS id, sum(minutes)::text AS minutes FROM mo_operation_plan_days GROUP BY 1`;
        const byId = (rows: { id: string; minutes: string }[]) => Object.fromEntries(rows.map((r) => [r.id, r.minutes]));
        expect(byId(after)).toEqual(byId(before));
        expect(Object.keys(byId(after))).toHaveLength(7);

        // Evenly over Mon–Fri; the full-day holiday (Wednesday 03-13) gets
        // nothing and the remainder lands on the week's last day.
        expect(await rowsOf(op.twoWeeks)).toEqual([
          ["2030-03-04", "240.00"],
          ["2030-03-05", "240.00"],
          ["2030-03-06", "240.00"],
          ["2030-03-07", "240.00"],
          ["2030-03-08", "240.00"],
          ["2030-03-11", "150.00"],
          ["2030-03-12", "150.00"],
          ["2030-03-14", "150.00"],
          ["2030-03-15", "150.01"],
        ]);
        // Start = the first week's Monday, end = the last week's last working
        // day (the finish day the week plan had); the lock and planned_at
        // are untouched, no run position.
        expect(await mirrorOf(op.twoWeeks)).toEqual({ s: "2030-03-04", e: "2030-03-15", locked: true, at: new Date(plannedAt), pos: null });

        // Too small to share (a part under 0.01, or nothing left for the
        // last day): everything on the week's first day — never a 0.00 row.
        expect(await rowsOf(op.tiny)).toEqual([["2030-03-04", "0.03"]]);
        expect(await rowsOf(op.lumped)).toEqual([["2030-03-04", "0.08"]]);
        expect(await mirrorOf(op.tiny)).toMatchObject({ s: "2030-03-04", e: "2030-03-04", locked: false });
        expect(await rowsOf(op.small)).toEqual([
          ["2030-03-04", "0.01"],
          ["2030-03-05", "0.01"],
          ["2030-03-06", "0.01"],
          ["2030-03-07", "0.01"],
          ["2030-03-08", "0.03"],
        ]);

        // A short day is a working day; a red Friday ends the week on Thursday.
        expect((await rowsOf(op.shortDay)).map(([d, m]) => [d, m])).toEqual(
          ["2030-03-18", "2030-03-19", "2030-03-20", "2030-03-21", "2030-03-22"].map((d) => [d, "20.00"])
        );
        expect(await rowsOf(op.fridayOff)).toEqual(["2030-03-25", "2030-03-26", "2030-03-27", "2030-03-28"].map((d) => [d, "25.00"]));
        expect(await mirrorOf(op.fridayOff)).toMatchObject({ s: "2030-03-25", e: "2030-03-28" });
        // A week of holidays only keeps its Monday.
        expect(await rowsOf(op.closedWeek)).toEqual([["2030-04-01", "77.77"]]);
        // No plan before, none after.
        expect(await rowsOf(op.unplanned)).toEqual([]);
        expect(await mirrorOf(op.unplanned)).toEqual({ s: null, e: null, locked: false, at: null, pos: null });

        // The old model is gone.
        const [oldTable] = await sql<{ t: string | null }[]>`SELECT to_regclass('public.mo_operation_plan_weeks')::text AS t`;
        expect(oldTable!.t).toBeNull();
        const columns = await sql<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'mo_operations' AND column_name IN ('planned_start_week', 'planned_end_week', 'planned_start_date', 'planned_end_date', 'run_position')
          ORDER BY column_name`;
        expect(columns.map((c) => c.column_name)).toEqual(["planned_end_date", "planned_start_date", "run_position"]);
      } finally {
        await sql.end();
      }
    } finally {
      await server.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await server.end();
    }
  }, 180_000);
});
