import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the web's colour-theme contract (see the header of
// apps/web/styles/tokens.css): every colour is a theme token declared in
// EVERY :root[data-theme] block, the theme list in apps/web/lib/themes.ts
// matches those blocks, and components only use semantic tokens — no raw
// colours, no --neutral-* primitives, no references to undefined tokens.
// Without this, a new theme silently inherits light-theme leftovers and a
// fixed-colour component turns unreadable in a theme nobody checked (the
// stamp terminal's Kvar tile, 2026-10-06).
//
// Read as text, like module-nav-routes.test.ts: the web app is a separate
// build with its own module resolution.
const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const TOKENS = readFileSync(join(WEB, "styles/tokens.css"), "utf8");
const THEMES_TS = readFileSync(join(WEB, "lib/themes.ts"), "utf8");

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Top-level rule blocks only — tokens.css has no nesting.
function blocks(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(css)))) out.push({ selector: m[1]!.trim(), body: m[2]! });
  return out;
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1]!, m[2]!.trim());
  return map;
}

function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, exts);
    return exts.some((e) => name.endsWith(e)) ? [path] : [];
  });
}

const tokenBlocks = blocks(TOKENS);
const themeBlocks = new Map<string, Map<string, string>>();
for (const b of tokenBlocks) {
  for (const m of b.selector.matchAll(/\[data-theme="([\w-]+)"\]/g)) themeBlocks.set(m[1]!, declarations(b.body));
}
const sharedRoot = declarations(tokenBlocks.filter((b) => b.selector === ":root").map((b) => b.body).join("\n"));

// WCAG 2 contrast ratio of two opaque #rrggbb colours.
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) throw new Error(`contrast() needs an opaque #rrggbb colour, got ${hex}`);
    const [r, g, b] = m.slice(1).map((h) => {
      const c = parseInt(h, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const RAW_COLOUR =/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

describe("colour themes", () => {
  it("lib/themes.ts lists exactly the themes tokens.css defines", () => {
    const listed = [...THEMES_TS.matchAll(/\{\s*id:\s*"([\w-]+)"/g)].map((m) => m[1]).sort();
    expect(listed.length).toBeGreaterThan(1);
    expect(listed).toEqual([...themeBlocks.keys()].sort());
  });

  it("every theme defines the same token set", () => {
    const [first, ...rest] = [...themeBlocks.entries()];
    const expected = [...first![1].keys()].sort();
    for (const [id, decls] of rest) {
      expect({ theme: id, tokens: [...decls.keys()].sort() }).toEqual({ theme: id, tokens: expected });
    }
  });

  it("the shared :root block holds no colours except the --neutral-* primitives", () => {
    const colours = [...sharedRoot.entries()].filter(([name, value]) => !name.startsWith("--neutral-") && RAW_COLOUR.test(value));
    expect(colours).toEqual([]);
  });

  it("every text token clears WCAG AA (4.5:1) on every surface, in every theme", () => {
    // Text tokens × the surfaces they're drawn on, plus the fixed
    // foreground/background pairs. The plain --status-* tokens are absent on
    // purpose: they're for dots, bars and strokes, never text.
    const texts = [
      "--color-text-primary",
      "--color-text-secondary",
      "--color-text-label",
      "--color-text-muted",
      "--accent-fg",
      "--color-heading-accent",
      "--status-running-text",
      "--status-delayed-text",
      "--status-stopped-text",
      "--status-done-text",
      "--status-draft-text",
    ];
    const surfaces = ["--color-bg", "--color-surface", "--color-elevated", "--color-input-surface", "--color-divider"];
    const pairs: [string, string][] = [
      ...texts.flatMap((t) => surfaces.map((s): [string, string] => [t, s])),
      ["--status-running-text", "--status-running-bg"],
      ["--status-delayed-text", "--status-delayed-bg"],
      ["--status-stopped-text", "--status-stopped-bg"],
      ["--status-done-text", "--status-done-bg"],
      ["--status-draft-text", "--status-draft-bg"],
      ["--accent-text", "--accent"],
      ["--btn-primary-text", "--btn-primary-bg"],
    ];
    const failures: string[] = [];
    for (const [id, decls] of themeBlocks) {
      const resolve = (name: string): string => {
        const value = decls.get(name);
        if (value === undefined) throw new Error(`${id}: ${name} is not defined`);
        const ref = /^var\((--[\w-]+)\)$/.exec(value);
        return ref ? resolve(ref[1]!) : value;
      };
      for (const [fg, bg] of pairs) {
        const ratio = contrast(resolve(fg), resolve(bg));
        if (ratio < 4.5) failures.push(`${id}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("no token is declared both per theme and in the shared :root block", () => {
    const themed = new Set([...themeBlocks.values()].flatMap((d) => [...d.keys()]));
    expect([...sharedRoot.keys()].filter((name) => themed.has(name))).toEqual([]);
  });
});

describe("components use only semantic colour tokens", () => {
  const files = [...walk(join(WEB, "components"), [".css", ".tsx"]), ...walk(join(WEB, "app"), [".css", ".tsx"])];
  const rel = (path: string) => path.slice(WEB.length);

  it("contain no raw colours", () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = file.endsWith(".css") ? stripComments(readFileSync(file, "utf8")) : readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        // In TSX only quoted colour literals and colour functions count — a
        // bare "#abc" elsewhere is far more likely an anchor or a comment.
        const raw = file.endsWith(".css") ? RAW_COLOUR.test(line) : /["'`]#[0-9a-fA-F]{3,8}["'`]|\brgba?\(|\bhsla?\(/.test(line);
        if (raw) hits.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("never reference the theme-independent --neutral-* primitives", () => {
    const hits = files.filter((f) => /var\(--neutral-/.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });

  it("only reference tokens that are defined", () => {
    // Custom properties components define themselves (local CSS variables,
    // inline style objects) plus next/font's and body's font aliases.
    const defined = new Set<string>([
      ...[...themeBlocks.values()].flatMap((d) => [...d.keys()]),
      ...sharedRoot.keys(),
      ...declarations(stripComments(TOKENS)).keys(),
      "--font-space-grotesk",
      "--font-figtree",
    ]);
    const sources = [...files, join(WEB, "app/globals.css")];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]!);
      for (const m of text.matchAll(/["'](--[\w-]+)["']\s*:/g)) defined.add(m[1]!);
    }
    const missing: string[] = [];
    for (const file of sources) {
      const text = file.endsWith(".css") ? stripComments(readFileSync(file, "utf8")) : readFileSync(file, "utf8");
      for (const m of text.matchAll(/var\((--[\w-]+)/g)) {
        if (!defined.has(m[1]!)) missing.push(`${rel(file)}: ${m[1]}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
