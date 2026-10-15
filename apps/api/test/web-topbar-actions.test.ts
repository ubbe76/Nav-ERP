import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A page's topbar button row must wrap: on a phone a non-wrapping row is wider
// than the screen and iOS Safari zooms the whole page out to fit it (the Lager
// page with five buttons did exactly that). Rows use the shared
// shellStyles.topbarActions; an inline flex row in the topbar has to wrap too.
const WEB = fileURLToPath(new URL("../../web/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

describe("web topbars", () => {
  it("never has a non-wrapping inline flex row as the topbar's button row", () => {
    const offenders: string[] = [];
    for (const path of ["app", "components"].flatMap((d) => walk(join(WEB, d)))) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("className={shellStyles.topbar}")) return;
        // The topbar's direct children: the title block, then the actions.
        for (const next of lines.slice(i + 1, i + 8)) {
          if (/<div style=\{\{[^}]*display: "flex"/.test(next) && !next.includes('flexWrap: "wrap"') && !next.includes('flexDirection: "column"')) {
            offenders.push(`${relative(WEB, path)}:${i + 1}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
