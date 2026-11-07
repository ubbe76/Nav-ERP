import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Vakttest, Datum är Stockholmsdagar: nothing in the API may read the
// process's own time zone. The container may run UTC (and the suite does, on
// purpose — test/setup.ts); docker-compose.yml's TZ=Europe/Stockholm is only a
// second safety. The Swedish day and wall clock come from
// system/service/delivery-days.ts (stockholmToday, stockholmDateOf,
// stockholmInstant), localDateOf, or an Intl formatter with
// timeZone: "Europe/Stockholm". Pure date arithmetic on YYYY-MM-DD goes
// through UTC (`${date}T00:00:00Z`, getUTCDay, setUTCDate) and is fine.
//
// What the guard sees, in code (comments stripped):
// - toLocaleDateString(…) / toLocaleTimeString(…), new Date(…).toLocaleString(…)
//   and new Intl.DateTimeFormat(…) without a timeZone in the same call — a
//   number's toLocaleString is no date and is not looked at;
// - the local getters and setters (getFullYear, getMonth, getDate, getDay,
//   getHours, getMinutes, getYear, getTimezoneOffset and their set*), not the
//   getUTC*/setUTC* ones;
// - new Date(year, month, …), the local component constructor (Date.UTC is
//   fine);
// - new Date / Date.parse of a date-time literal without Z or an offset
//   ("2026-06-10T07:00", `${date}T${clock}:00`) — read in the local zone;
// - CURRENT_DATE, CURRENT_TIME, LOCALTIMESTAMP, LOCALTIME and now()::date in
//   SQL — the database session's zone, the postgres container's (UTC).
//
// It cannot see a zone-less string in a variable (new Date(value)), nor a
// Date variable's toLocaleString — review those by hand.
//
// The count per file is a fingerprint, as in stock-on-hand-readers.test.ts:
// a new hit in a listed file changes it, and the test asks for it to be
// classified too.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

// Deliberate uses of the process's zone, with why. Empty: every reader of
// the day or the clock names its zone. A new entry needs a reason the day or
// the clock cannot be Stockholm's (or does not matter).
const ALLOWED: Record<string, { hits: number; why: string }> = {};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

// Comments read no clock ("not the server's CURRENT_DATE").
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

// The text between the parenthesis at `open` and its partner.
function callArgs(body: string, open: number): string {
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    const c = body[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  return body.slice(open + 1);
}

// A comma outside any nested bracket: more than one argument.
function hasTopLevelComma(args: string): boolean {
  let depth = 0;
  for (const c of args) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return true;
  }
  return false;
}

// Calls that format in the process's zone unless the call names one.
const FORMATTERS = [/\.toLocaleDateString\(/g, /\.toLocaleTimeString\(/g, /new Date\([^()]*\)\.toLocaleString\(/g, /new Intl\.DateTimeFormat\(/g];
const LOCAL_ACCESSORS = /\.(?:get|set)(?:FullYear|Month|Date|Day|Hours|Minutes|Year|TimezoneOffset)\(/g;
const DATE_CONSTRUCTOR = /new Date\(/g;
// A date-time literal (a clock after T, or an interpolated one) handed to the
// parser; the zone is the last thing in it.
const PARSED_LITERAL = /(?:new Date|Date\.parse)\(\s*(`[^`]*`|"[^"]*"|'[^']*')\s*\)/g;
const HAS_TIME = /T(?:\d|\$\{)/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})["'`]$/;
// Upper or lower case as SQL is written; a camelCase localTime variable is no SQL.
const SQL_SESSION_CLOCK =
  /\b(?:CURRENT_DATE|CURRENT_TIME|LOCALTIMESTAMP|LOCALTIME|current_date|current_time|localtimestamp|localtime)\b|now\(\)\s*::\s*date\b/g;

function hitsIn(text: string): string[] {
  const body = code(text);
  const hits: string[] = [];
  for (const pattern of FORMATTERS) {
    for (const m of body.matchAll(pattern)) {
      const args = callArgs(body, m.index! + m[0].length - 1);
      if (!/\btimeZone\b/.test(args)) hits.push(`${m[0]}${args})`);
    }
  }
  for (const m of body.matchAll(LOCAL_ACCESSORS)) hits.push(m[0]);
  for (const m of body.matchAll(DATE_CONSTRUCTOR)) {
    const args = callArgs(body, m.index! + m[0].length - 1);
    if (hasTopLevelComma(args)) hits.push(`new Date(${args})`);
  }
  for (const m of body.matchAll(PARSED_LITERAL)) {
    const literal = m[1]!;
    if (HAS_TIME.test(literal) && !HAS_ZONE.test(literal)) hits.push(m[0]);
  }
  for (const m of body.matchAll(SQL_SESSION_CLOCK)) hits.push(m[0]);
  return hits;
}

describe("the process's time zone", () => {
  const found = new Map(
    sourceFiles(SRC)
      .map((path) => [relative(SRC, path).split("\\").join("/"), hitsIn(readFileSync(path, "utf8"))] as const)
      .filter(([, hits]) => hits.length > 0)
  );

  it("no file reads the day or the clock in the process's zone unless listed with a reason", () => {
    const unlisted = [...found.entries()].filter(([file]) => !(file in ALLOWED)).map(([file, hits]) => `${file}: ${hits.join(" | ")}`);
    expect(
      unlisted,
      "use stockholmToday/stockholmDateOf/stockholmInstant (system/service/delivery-days.ts) or an Intl formatter with timeZone: \"Europe/Stockholm\" — or list the file with why"
    ).toEqual([]);
  });

  it("each listed file still has as many hits as it was classified with", () => {
    const changed = Object.entries(ALLOWED)
      .filter(([file, entry]) => (found.get(file)?.length ?? 0) !== entry.hits)
      .map(([file, entry]) => `${file}: listed ${entry.hits}, found ${found.get(file)?.length ?? 0}`);
    expect(changed, "classify the new or removed hits, then update the count").toEqual([]);
  });

  it("the patterns see a local-zone read (the guard is not blind)", () => {
    // Formatting without a zone — and with one, on one line and spread over several.
    expect(hitsIn('const today = new Date().toLocaleDateString("sv-SE");')).toHaveLength(1);
    expect(hitsIn('d.toLocaleTimeString("sv-SE", { hour: "2-digit" })')).toHaveLength(1);
    expect(hitsIn('new Date(at).toLocaleString("sv-SE")')).toHaveLength(1);
    expect(hitsIn('new Intl.DateTimeFormat("sv-SE", { year: "numeric" })')).toHaveLength(1);
    expect(hitsIn('d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" })')).toHaveLength(0);
    expect(
      hitsIn('const F = new Intl.DateTimeFormat("sv-SE", {\n  timeZone: "Europe/Stockholm",\n  hour: "2-digit",\n});')
    ).toHaveLength(0);
    // A number's toLocaleString is no date.
    expect(hitsIn('n.toLocaleString("sv-SE", { maximumFractionDigits: 2 })')).toHaveLength(0);
    // Local accessors; the UTC ones are fine.
    expect(hitsIn("const year = new Date().getFullYear();")).toHaveLength(1);
    expect(hitsIn("cursor.setDate(cursor.getDate() + 1);")).toHaveLength(2);
    expect(hitsIn("const h = at.getHours();")).toHaveLength(1);
    expect(hitsIn("d.setUTCDate(d.getUTCDate() + days); d.getUTCDay();")).toHaveLength(0);
    // The local component constructor; Date.UTC and a single argument are fine.
    expect(hitsIn("new Date(year, month - 1, day)")).toHaveLength(1);
    expect(hitsIn("new Date(Date.UTC(year, month - 1, day))")).toHaveLength(0);
    expect(hitsIn("new Date(now + i)")).toHaveLength(0);
    // Zone-less date-time literals; a date alone or a zone is fine.
    expect(hitsIn("new Date(`${date}T${clock}:00`)")).toHaveLength(1);
    expect(hitsIn('Date.parse("2026-06-10T07:00")')).toHaveLength(1);
    expect(hitsIn("new Date(`${date}T00:00:00Z`)")).toHaveLength(0);
    expect(hitsIn('new Date("2026-06-10T07:00:00+02:00")')).toHaveLength(0);
    expect(hitsIn('new Date("2026-06-10")')).toHaveLength(0);
    // The database session's clock.
    expect(hitsIn("sql`${invoices.dueDate} < CURRENT_DATE`")).toHaveLength(1);
    expect(hitsIn("sql`select now()::date`")).toHaveLength(1);
    expect(hitsIn("sql`where due_date < current_date`")).toHaveLength(1);
    expect(hitsIn("const localTime = stockholmNow(at).time;")).toHaveLength(0);
    expect(hitsIn("sql`(${t.createdAt} AT TIME ZONE 'Europe/Stockholm')::date`")).toHaveLength(0);
    // Comments read no clock.
    expect(hitsIn("// not new Date().toLocaleDateString(\"sv-SE\") nor CURRENT_DATE")).toHaveLength(0);
  });
});
