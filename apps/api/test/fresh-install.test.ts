import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@navet/db";

// A fresh install migrates an EMPTY database through every migration in one
// run. The suite's own database is migrated one version at a time, so it
// never caught that drizzle's single-transaction migrator could not use an
// enum value an earlier migration in the same run had added (0084 adds
// costing_material_source 'actual', 0187's CHECK names it): Postgres answers
// 55P04 "New enum values must be committed before they can be used", and
// 0.8.2-alpha could not be installed from scratch. runMigrations now commits
// each migration on its own; this test installs into a throwaway database and
// runs the migrations a second time to prove that is a no-op.
describe("fresh install", () => {
  it("migrates an empty database from scratch, and a second run changes nothing", async () => {
    const base = new URL(process.env.DATABASE_URL!);
    const template = base.pathname.slice(1);
    const name = `${template}_fresh_install_${process.pid}`;
    expect(name).toMatch(/test/i);

    const maintenanceUrl = new URL(base);
    maintenanceUrl.pathname = "/postgres";
    const server = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => {} });
    const freshUrl = new URL(base);
    freshUrl.pathname = `/${name}`;
    try {
      await server.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await server.unsafe(`CREATE DATABASE "${name}"`);

      await runMigrations(freshUrl.toString());

      const fresh = postgres(freshUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        const [appliedRow] = await fresh<{ count: string }[]>`select count(*) from drizzle.__drizzle_migrations`;
        const applied = appliedRow!.count;
        expect(Number(applied)).toBeGreaterThan(190);

        await runMigrations(freshUrl.toString());
        const [againRow] = await fresh<{ count: string }[]>`select count(*) from drizzle.__drizzle_migrations`;
        const again = againRow!.count;
        expect(again).toBe(applied);

        // The enum value 0084 added and 0187 uses is really there.
        const values = await fresh<{ v: string }[]>`
          select unnest(enum_range(null::costing_material_source))::text as v
        `;
        expect(values.map((r) => r.v)).toContain("actual");
      } finally {
        await fresh.end();
      }
    } finally {
      await server.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await server.end();
    }
  }, 180_000);
});
