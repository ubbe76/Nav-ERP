import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { parseTruncate, truncatedTables, type ReferencingTables } from "./helpers/fast-truncate.js";

// The suite's quicker TRUNCATE (helpers/fast-truncate.ts, installed in
// setup.ts): the same tables as Postgres would empty, or the real TRUNCATE.

describe("parseTruncate", () => {
  it("reads the table list and CASCADE", () => {
    expect(parseTruncate("TRUNCATE articles, Article_Groups CASCADE")).toEqual({ tables: ["articles", "article_groups"], cascade: true });
    expect(parseTruncate("\n  TRUNCATE TABLE exchange_rates;\n")).toEqual({ tables: ["exchange_rates"], cascade: false });
    expect(parseTruncate("TRUNCATE users CONTINUE IDENTITY CASCADE")).toEqual({ tables: ["users"], cascade: true });
  });

  it("leaves what it does not understand to Postgres", () => {
    expect(parseTruncate("TRUNCATE users RESTART IDENTITY CASCADE")).toBeNull();
    expect(parseTruncate("TRUNCATE ONLY users")).toBeNull();
    expect(parseTruncate('TRUNCATE "Users"')).toBeNull();
    expect(parseTruncate("TRUNCATE public.users")).toBeNull();
    expect(parseTruncate("DELETE FROM users")).toBeNull();
  });
});

describe("truncatedTables", () => {
  // orders → customers, rows → orders, notes → rows; logs stands alone.
  const known = new Set(["customers", "orders", "rows", "notes", "logs"]);
  const referencing: ReferencingTables = new Map([
    ["customers", ["orders"]],
    ["orders", ["rows"]],
    ["rows", ["notes"]],
  ]);

  it("follows CASCADE through every referencing table, recursively", () => {
    expect(truncatedTables({ tables: ["customers"], cascade: true }, known, referencing)?.sort()).toEqual(["customers", "notes", "orders", "rows"]);
    expect(truncatedTables({ tables: ["logs"], cascade: true }, known, referencing)).toEqual(["logs"]);
  });

  it("without CASCADE empties exactly the list, and leaves a referenced table to Postgres", () => {
    expect(truncatedTables({ tables: ["rows", "notes"], cascade: false }, known, referencing)?.sort()).toEqual(["notes", "rows"]);
    expect(truncatedTables({ tables: ["rows"], cascade: false }, known, referencing)).toBeNull();
    expect(truncatedTables({ tables: ["nope"], cascade: true }, known, referencing)).toBeNull();
  });
});

describe("db.execute(TRUNCATE) against the test database", () => {
  afterAll(async () => {
    await db.execute(sql`TRUNCATE warehouses CASCADE`);
  });

  it("empties the listed and referencing tables and nothing else", async () => {
    const groupsBefore = (await db.execute(sql`select count(*)::int as n from permission_groups`))[0]!.n;
    await db.execute(sql`TRUNCATE warehouses CASCADE`);
    const [warehouse] = await db.execute(sql`insert into warehouses (name) values ('Snabbstädning') returning id`);
    await db.execute(sql`insert into stock_locations (warehouse_id, name) values (${warehouse!.id}, 'FT-1')`);
    // stock_locations references warehouses, so CASCADE empties both.
    await db.execute(sql`TRUNCATE warehouses CASCADE`);
    const counts = await db.execute(
      sql`select (select count(*)::int from warehouses) as warehouses, (select count(*)::int from stock_locations) as locations`
    );
    expect(counts[0]).toEqual({ warehouses: 0, locations: 0 });
    // A seeded table outside the cascade is untouched.
    expect(groupsBefore).toBeGreaterThan(0);
    expect((await db.execute(sql`select count(*)::int as n from permission_groups`))[0]!.n).toBe(groupsBefore);
  });

  it("still lets Postgres refuse a referenced table without CASCADE", async () => {
    // drizzle wraps the driver's error; Postgres's own message is the cause.
    const error = (await db.execute(sql`TRUNCATE warehouses`).catch((e: unknown) => e)) as { cause?: { message?: string } };
    expect(error.cause?.message).toMatch(/foreign key/i);
  });
});
