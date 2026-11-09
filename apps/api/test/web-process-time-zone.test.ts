import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hitsIn } from "./helpers/time-zone-guard.js";

// Vakttest, Datum är Stockholmsdagar, webbens sida: nothing under apps/web
// app/, components/ and lib/ may read the zone of the process it runs in.
// Next renders the page on the server first (a container in UTC) and the
// browser then hydrates it in the user's zone: formatted in the local zone the
// two texts differ, React reports a hydration error and redraws the whole
// root. And the day is the Swedish day whatever zone the browser is in. Use
// stockholmToday / formatStockholmDate / formatStockholmDateTime
// (apps/web/lib/date.ts) or an Intl formatter with timeZone: "Europe/Stockholm";
// pure calendar arithmetic on YYYY-MM-DD goes through UTC.
//
// The scanner is the API guard's (test/helpers/time-zone-guard.ts), so what it
// sees and cannot see is described in process-time-zone.test.ts. The count per
// file is a fingerprint: a new hit in a listed file changes it.

const WEB = fileURLToPath(new URL("../../web", import.meta.url));
const ROOTS = ["app", "components", "lib"];

// Deliberate uses of the browser's zone, with why. A new entry needs a reason
// the day or the clock cannot be Stockholm's (or never runs on the server).
const ALLOWED: Record<string, { hits: number; why: string }> = {
  "lib/date.ts": {
    hits: 5,
    why:
      "toDateTimeLocalValue fills <input type=\"datetime-local\"> in the browser's zone because every reader parses the value back with the " +
      "browser-local new Date(value) (InProgressPageClient, EmployeePeriodModal, StampTerminal's forgotten stop), so the pair round-trips in any zone; " +
      "it is only called from editors opened by a click, never in the server render, so it cannot cause a hydration mismatch",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the web's time zone", () => {
  const found = new Map(
    ROOTS.flatMap((root) => sourceFiles(join(WEB, root)))
      .map((path) => [relative(WEB, path).split("\\").join("/"), hitsIn(readFileSync(path, "utf8"))] as const)
      .filter(([, hits]) => hits.length > 0)
  );

  it("no web file reads the day or the clock in the process's zone unless listed with a reason", () => {
    const unlisted = [...found.entries()].filter(([file]) => !(file in ALLOWED)).map(([file, hits]) => `${file}: ${hits.join(" | ")}`);
    expect(
      unlisted,
      "use stockholmToday/formatStockholmDate/formatStockholmDateTime (lib/date.ts) or an Intl formatter with timeZone: \"Europe/Stockholm\" — or list the file with why"
    ).toEqual([]);
  });

  it("each listed file still has as many hits as it was classified with", () => {
    const changed = Object.entries(ALLOWED)
      .filter(([file, entry]) => (found.get(file)?.length ?? 0) !== entry.hits)
      .map(([file, entry]) => `${file}: listed ${entry.hits}, found ${found.get(file)?.length ?? 0}`);
    expect(changed, "classify the new or removed hits, then update the count").toEqual([]);
  });

  it("the scanner sees a local-zone read in web code (the guard is not blind)", () => {
    expect(hitsIn('const today = new Date().toLocaleDateString("sv-SE");')).toHaveLength(1);
    expect(hitsIn('new Date(iso).toLocaleString("sv-SE", { dateStyle: "short" })')).toHaveLength(1);
    expect(hitsIn("const year = new Date().getFullYear();")).toHaveLength(1);
    expect(hitsIn('d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" })')).toHaveLength(0);
    expect(hitsIn("new Date(`${date}T00:00:00Z`).getUTCDay()")).toHaveLength(0);
  });

  it("scans the three web directories", () => {
    expect(ROOTS.every((root) => sourceFiles(join(WEB, root)).length > 0)).toBe(true);
  });
});
