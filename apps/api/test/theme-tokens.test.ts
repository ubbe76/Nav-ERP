import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEME_VALUES,
  BUILTIN_THEMES,
  contrastRatio,
  THEME_CONTRAST_PAIRS,
  THEME_MIN_CONTRAST,
  THEME_TOKENS,
  validateTheme,
} from "@navet/shared";

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
    // foreground/background pairs — THEME_CONTRAST_PAIRS, the same rule the
    // server applies to custom themes. The plain --status-* tokens are absent
    // on purpose: they're for dots, bars and strokes, never text.
    const failures: string[] = [];
    for (const [id, decls] of themeBlocks) {
      const resolve = (name: string): string => {
        const value = decls.get(name);
        if (value === undefined) throw new Error(`${id}: ${name} is not defined`);
        const ref = /^var\((--[\w-]+)\)$/.exec(value);
        return ref ? resolve(ref[1]!) : value;
      };
      for (const [fg, bg] of THEME_CONTRAST_PAIRS) {
        const ratio = contrastRatio(resolve(`--${fg}`), resolve(`--${bg}`));
        if (ratio < THEME_MIN_CONTRAST) failures.push(`${id}: --${fg} on --${bg} = ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // Egna teman: the catalogue in packages/shared/src/theme-core.ts is the
  // other half of the contract — custom themes are validated and built
  // against it, and BUILTIN_THEME_VALUES serves the built-in themes' export
  // and the editor's templates.
  it("every theme block declares exactly the catalogue's tokens", () => {
    const catalogue = THEME_TOKENS.map((t) => `--${t.name}`).sort();
    for (const [id, decls] of themeBlocks) {
      expect({ theme: id, tokens: [...decls.keys()].sort() }).toEqual({ theme: id, tokens: catalogue });
    }
  });

  it("BUILTIN_THEME_VALUES and BUILTIN_THEMES are exactly the theme blocks", () => {
    expect(BUILTIN_THEMES.map((t) => t.id).sort()).toEqual([...themeBlocks.keys()].sort());
    for (const [id, decls] of themeBlocks) {
      const values = Object.fromEntries([...decls.entries()].map(([name, value]) => [name.slice(2), value]));
      expect({ theme: id, values: BUILTIN_THEME_VALUES[id as keyof typeof BUILTIN_THEME_VALUES] }).toEqual({ theme: id, values });
    }
  });

  it("each built-in theme's color-scheme matches BUILTIN_THEMES", () => {
    for (const b of tokenBlocks) {
      for (const m of b.selector.matchAll(/\[data-theme="([\w-]+)"\]/g)) {
        const scheme = /color-scheme:\s*(\w+)/.exec(b.body)?.[1];
        expect({ theme: m[1], scheme }).toEqual({ theme: m[1], scheme: BUILTIN_THEMES.find((t) => t.id === m[1])!.scheme });
      }
    }
  });

  it("the built-in themes pass validateTheme, values unchanged", () => {
    for (const theme of BUILTIN_THEMES) {
      const result = validateTheme({ name: theme.label, scheme: theme.scheme, tokens: BUILTIN_THEME_VALUES[theme.id] });
      expect({ theme: theme.id, ok: result.ok, errors: result.errors, warnings: result.warnings, contrast: result.contrastFailures }).toEqual({
        theme: theme.id,
        ok: true,
        errors: [],
        warnings: [],
        contrast: [],
      });
      expect(result.tokens).toEqual(BUILTIN_THEME_VALUES[theme.id]);
    }
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
