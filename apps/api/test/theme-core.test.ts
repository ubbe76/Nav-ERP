import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEME_VALUES,
  buildThemeCss,
  buildThemeFile,
  checkTokenValue,
  contrastRatio,
  deriveTheme,
  ensureContrast,
  fillThemeTokens,
  fixContrast,
  formatContrastFailure,
  hexToOklab,
  hexToOklch,
  parseThemeFile,
  resolveThemeTokens,
  THEME_CONTRAST_PAIRS,
  THEME_FILE_MAX_BYTES,
  THEME_TOKENS,
  themeContrastFailures,
  themeSourceFromTokens,
  validateTheme,
  type ThemeScheme,
  type ThemeSource,
  type ThemeTokenKind,
} from "@navet/shared";

// Egna teman — the pure core (packages/shared/src/theme-core.ts): grammar,
// references, fallbacks, contrast, the CSS builder and the editor's
// derivation. No database.

const light = BUILTIN_THEME_VALUES.light;
const themeWith = (tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  name: "Prov",
  scheme: "light",
  tokens,
  ...extra,
});
const without = (name: string) => Object.fromEntries(Object.entries(light).filter(([k]) => k !== name));
const tokenErrors = (result: ReturnType<typeof validateTheme>) => result.errors.map((e) => e.token);

describe("contrastRatio", () => {
  it("knows the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#337a58", "#337a58")).toBe(1);
    // #767676 is the classic lightest AA grey on white; #777777 just misses.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("refuses anything but an opaque #rrggbb colour", () => {
    expect(() => contrastRatio("#fff", "#000000")).toThrow();
    expect(() => contrastRatio("rgba(0, 0, 0, 1)", "#000000")).toThrow();
  });
});

describe("the value grammar", () => {
  const accepts = (kind: ThemeTokenKind, value: string, canonical: string) => {
    const check = checkTokenValue(kind, value);
    expect({ value, check }).toEqual({ value, check: { ok: true, value: canonical, ref: null } });
  };
  const rejects = (kind: ThemeTokenKind, value: unknown) => {
    expect({ value, ok: checkTokenValue(kind, value).ok }).toEqual({ value, ok: false });
  };

  it("color: opaque #rrggbb (lower-cased) or a reference", () => {
    accepts("color", "#337A58", "#337a58");
    accepts("color", "  #ffffff ", "#ffffff");
    expect(checkTokenValue("color", "var( --accent )")).toEqual({ ok: true, value: "var(--accent)", ref: "accent" });
    for (const bad of ["#fff", "#ffffffff", "red", "rgb(0, 0, 0)", "rgba(0, 0, 0, 1)", "", "#gggggg", 42, null, ["#ffffff"]]) {
      rejects("color", bad);
    }
  });

  it("alpha: rgba with integer channels and alpha 0–1, or #rrggbbaa", () => {
    accepts("alpha", "rgba(0,0,0,.6)", "rgba(0, 0, 0, 0.6)");
    accepts("alpha", "rgba( 15 , 17 , 21 , 0.45 )", "rgba(15, 17, 21, 0.45)");
    accepts("alpha", "rgba(255, 255, 255, 1)", "rgba(255, 255, 255, 1)");
    accepts("alpha", "#0000009A", "#0000009a");
    for (const bad of ["rgba(256, 0, 0, 0.5)", "rgba(0, 0, 0, 1.5)", "rgba(0, 0, 0)", "rgba(0.5, 0, 0, 0.5)", "#000000", "rgb(0, 0, 0)", "transparent"]) {
      rejects("alpha", bad);
    }
  });

  it("shadow: one or two layers of 2–4 lengths and an alpha colour", () => {
    accepts("shadow", "0 8px 24px rgba(0, 0, 0, 0.45)", "0 8px 24px rgba(0, 0, 0, 0.45)");
    accepts("shadow", "0  24px 60px -30px rgba(20,23,28,0.28)", "0 24px 60px -30px rgba(20, 23, 28, 0.28)");
    accepts("shadow", "0 1px #00000040, 0 4px 8px rgba(0, 0, 0, 0.2)", "0 1px #00000040, 0 4px 8px rgba(0, 0, 0, 0.2)");
    for (const bad of [
      "0 8px",
      "8px rgba(0, 0, 0, 0.5)",
      "0 8 24px rgba(0, 0, 0, 0.5)", // unitless non-zero length
      "0 1000px rgba(0, 0, 0, 0.5)",
      "0 0 0 0 0 rgba(0, 0, 0, 0.5)",
      "inset 0 1px rgba(0, 0, 0, 0.5)",
      "0 1px 2px #000000",
      "0 1px rgba(0, 0, 0, 0.1), 0 1px rgba(0, 0, 0, 0.1), 0 1px rgba(0, 0, 0, 0.1)",
      "0 1px 2px 1em rgba(0, 0, 0, 0.5)",
      "none",
    ]) {
      rejects("shadow", bad);
    }
  });

  it("refuses every attempt to smuggle CSS or markup in", () => {
    const attempts = [
      "#fff;}",
      "#ffffff;}",
      "#ffffff; background: url(https://example.com/x.png)",
      "url(https://example.com/x.png)",
      "</style><script>alert(1)</script>",
      "expression(alert(1))",
      "var(--accent);} body { display: none",
      "var(--accent) !important",
      "rgba(0, 0, 0, 0.5)} html{display:none",
      "0 0 rgba(0,0,0,0.5)} body{display:none}",
      "0 0 rgba(0,0,0,0.5), url(x)",
      "#ffffff\n}",
      "/* */#ffffff",
    ];
    for (const kind of ["color", "alpha", "shadow"] as const) for (const value of attempts) rejects(kind, value);
  });

  it("a value over 200 characters is refused before any parsing", () => {
    rejects("shadow", `0 1px rgba(0, 0, 0, 0.5)${" ".repeat(200)}`);
  });
});

describe("validateTheme", () => {
  it("accepts a complete, legible theme", () => {
    const result = validateTheme(themeWith(light, { format: "nav-theme", version: 1, extra: "ignored" }));
    expect(result).toMatchObject({ ok: true, name: "Prov", scheme: "light", errors: [], warnings: [], contrastFailures: [], source: null });
    expect(Object.keys(result.tokens)).toEqual(THEME_TOKENS.map((t) => t.name));
  });

  it("errors per token on an invalid value, with a Swedish message naming the token", () => {
    const result = validateTheme(themeWith({ ...light, "color-bg": "#fff;}", "shadow-knob": "url(x)" }));
    expect(result.ok).toBe(false);
    expect(tokenErrors(result)).toEqual(["color-bg", "shadow-knob"]);
    expect(result.errors[0]!.message).toMatch(/^Bakgrund \(--color-bg\): ogiltigt värde/);
    // No contrast check on a theme with errors.
    expect(result.contrastFailures).toEqual([]);
  });

  it("ignores an unknown token with a warning", () => {
    const result = validateTheme(themeWith({ ...light, "color-sparkle": "#ff00ff" }));
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.message)).toEqual([expect.stringContaining("--color-sparkle ignoreras")]);
    expect(result.tokens).not.toHaveProperty("color-sparkle");
  });

  it("fills a missing token from its fallback with a warning: a reference, or the template of the scheme", () => {
    const ref = validateTheme(themeWith(without("accent-fg")));
    expect(ref.ok).toBe(true);
    expect(ref.tokens["accent-fg"]).toBe("var(--accent)");
    expect(ref.warnings).toEqual([{ token: "accent-fg", message: expect.stringContaining("saknas") }]);

    const darkTokens = Object.fromEntries(Object.entries(BUILTIN_THEME_VALUES.dark).filter(([k]) => k !== "shadow-frame"));
    const template = validateTheme({ name: "Mörk prov", scheme: "dark", tokens: darkTokens });
    expect(template.tokens["shadow-frame"]).toBe(BUILTIN_THEME_VALUES.dark["shadow-frame"]);
    expect(template.ok).toBe(true);
  });

  it("checks references: unknown target, other kind, cycles and depth", () => {
    expect(tokenErrors(validateTheme(themeWith({ ...light, accent: "var(--nope)" })))).toEqual(["accent"]);
    expect(tokenErrors(validateTheme(themeWith({ ...light, accent: "var(--shadow-knob)" })))).toEqual(["accent"]);
    expect(tokenErrors(validateTheme(themeWith({ ...light, accent: "var(--color-overlay)" })))).toEqual(["accent"]);
    const cycle = validateTheme(themeWith({ ...light, accent: "var(--accent-fg)", "accent-fg": "var(--accent)" }));
    expect(cycle.errors.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringContaining("cirkel")]));
    expect(tokenErrors(validateTheme(themeWith({ ...light, accent: "var(--accent)" })))).toContain("accent");

    // Three levels are fine: heading → accent-fg → accent → color-text-primary.
    const three = validateTheme(themeWith({ ...light, accent: "var(--color-text-primary)", "accent-text": "#ffffff" }));
    expect(three.errors).toEqual([]);
    // Four are not: heading → accent-fg → accent → color-control-on → color-text-primary.
    const four = validateTheme(
      themeWith({ ...light, accent: "var(--color-control-on)", "color-control-on": "var(--color-text-primary)" })
    );
    expect(four.errors.map((e) => e.token)).toEqual(["color-heading-accent"]);
    expect(four.errors[0]!.message).toContain("högst 3");
  });

  it("reports contrast failures (not errors) and formats them in Swedish", () => {
    const result = validateTheme(themeWith({ ...light, "color-text-muted": "#999999" }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.contrastFailures.map((f) => f.bg)).toEqual(THEME_CONTRAST_PAIRS.filter(([fg]) => fg === "color-text-muted").map(([, bg]) => bg));
    const onInput = result.contrastFailures.find((f) => f.bg === "color-input-surface")!;
    expect(onInput).toEqual({ fg: "color-text-muted", bg: "color-input-surface", ratio: 2.84, required: 4.5 });
    expect(formatContrastFailure(onInput)).toBe("Dämpad text på Indataytor: 2,8:1, kräver 4,5:1");
    // Rounded down: a ratio just under the bar never reads as 4,5.
    expect(formatContrastFailure({ fg: "accent-text", bg: "accent", ratio: 4.49, required: 4.5 })).toBe(
      "Text på accentfärg på Accentfärg: 4,4:1, kräver 4,5:1"
    );
  });

  it("checks the theme as a whole: object, name, scheme, format, version, tokens", () => {
    expect(validateTheme("nope").errors).toHaveLength(1);
    expect(validateTheme(null).ok).toBe(false);
    const messages = (input: unknown) => validateTheme(input).errors.map((e) => e.message).join(" | ");
    expect(messages(themeWith(light, { name: "  " }))).toContain("namn");
    expect(messages(themeWith(light, { name: "x".repeat(61) }))).toContain("högst 60");
    expect(messages(themeWith(light, { scheme: "dracula" }))).toContain("scheme");
    expect(messages(themeWith(light, { format: "other" }))).toContain("Nav-temafil");
    expect(messages(themeWith(light, { version: 2 }))).toContain("version 2");
    expect(messages({ name: "x", scheme: "light" })).toContain("saknar tokens");
    expect(validateTheme(themeWith(light, { name: "  Fabriksblå  " })).name).toBe("Fabriksblå");
  });

  it("checks the editor's source: shape, colours, override grammar; unknown overrides warn", () => {
    const source = { base: "light", bg: "#F6F7F9", surface: "#ffffff", text: "#1c2026", accent: "#337a58", heading: null, status: null, overrides: { accent: "#2b6b4c" } };
    const ok = validateTheme(themeWith(light, { source }));
    expect(ok.ok).toBe(true);
    expect(ok.source).toEqual({ ...source, bg: "#f6f7f9" });
    expect(validateTheme(themeWith(light, { source: { ...source, bg: "blue" } })).ok).toBe(false);
    expect(validateTheme(themeWith(light, { source: { ...source, base: "dracula" } })).ok).toBe(false);
    expect(validateTheme(themeWith(light, { source: { ...source, status: { running: "#ff0000" } } })).ok).toBe(false);
    expect(validateTheme(themeWith(light, { source: { ...source, overrides: { accent: "#fff;}" } } })).ok).toBe(false);
    const unknown = validateTheme(themeWith(light, { source: { ...source, overrides: { sparkle: "#ffffff" } } }));
    expect(unknown.ok).toBe(true);
    expect(unknown.warnings).toHaveLength(1);
    expect(unknown.source!.overrides).toEqual({});
  });
});

describe("parseThemeFile / buildThemeFile", () => {
  it("round-trips a theme file", () => {
    const file = buildThemeFile({ name: "Prov", scheme: "light", tokens: light });
    const parsed = parseThemeFile(JSON.stringify(file, null, 2));
    expect(parsed.ok).toBe(true);
    expect(validateTheme(parsed.ok ? parsed.input : null)).toMatchObject({ ok: true, name: "Prov", tokens: light });
    expect(file).toMatchObject({ format: "nav-theme", version: 1, source: null });
  });

  it("refuses a file over 64 kB (counted in UTF-8 bytes) and invalid JSON", () => {
    expect(parseThemeFile("{")).toEqual({ ok: false, errors: [{ token: null, message: "Filen är inte giltig JSON." }] });
    const big = JSON.stringify({ name: "å".repeat(THEME_FILE_MAX_BYTES / 2 + 1) });
    expect(big.length).toBeLessThan(THEME_FILE_MAX_BYTES);
    expect(parseThemeFile(big).ok).toBe(false);
  });
});

// Parses buildThemeCss output back into { key → { scheme, tokens } }.
function parseCss(css: string) {
  const out = new Map<string, { scheme: string; tokens: Record<string, string> }>();
  for (const m of css.matchAll(/:root\[data-theme="([^"]+)"\] \{\n([^}]*)\}/g)) {
    const scheme = /color-scheme: (\w+);/.exec(m[2]!)![1]!;
    const tokens = Object.fromEntries([...m[2]!.matchAll(/ {2}--([\w-]+): ([^;\n]+);/g)].map((d) => [d[1]!, d[2]!]));
    out.set(m[1]!, { scheme, tokens });
  }
  return out;
}

describe("buildThemeCss", () => {
  it("writes one block per theme that parses back to the same tokens, in catalogue order", () => {
    const dark = validateTheme({ name: "Mörk", scheme: "dark", tokens: BUILTIN_THEME_VALUES.dracula }).tokens;
    const css = buildThemeCss([
      { key: "egen-0123abcd", scheme: "light", tokens: light },
      { key: "egen-ffff0000", scheme: "dark", tokens: dark },
    ]);
    const parsed = parseCss(css);
    expect([...parsed.keys()]).toEqual(["egen-0123abcd", "egen-ffff0000"]);
    expect(parsed.get("egen-0123abcd")).toEqual({ scheme: "light", tokens: light });
    expect(parsed.get("egen-ffff0000")).toEqual({ scheme: "dark", tokens: dark });
    expect(Object.keys(parsed.get("egen-0123abcd")!.tokens)).toEqual(THEME_TOKENS.map((t) => t.name));
    expect(buildThemeCss([])).toBe("");
  });

  it("never takes the selector from input: only generated keys are accepted", () => {
    for (const key of ["light", "dark", "egen-XYZ01234", 'egen-0123abcd"] body { display: none } [x="', "egen-0123abcde", ""]) {
      expect(() => buildThemeCss([{ key, scheme: "light", tokens: light }])).toThrow();
    }
  });

  it("re-checks stored values: invalid or injected ones become the fallback, unknown tokens are dropped", () => {
    const css = buildThemeCss([
      {
        key: "egen-00000001",
        scheme: "dark",
        tokens: { ...light, "color-bg": "#000;} body{display:none", accent: "var(--nope)", "x;}": "#ffffff", "shadow-knob": 7 },
      },
    ]);
    expect(css).not.toMatch(/display|x;\}/);
    const tokens = parseCss(css).get("egen-00000001")!.tokens;
    expect(tokens["color-bg"]).toBe(BUILTIN_THEME_VALUES.dark["color-bg"]);
    expect(tokens.accent).toBe(BUILTIN_THEME_VALUES.dark.accent);
    expect(tokens["shadow-knob"]).toBe(BUILTIN_THEME_VALUES.dark["shadow-knob"]);
    expect(parseCss(css).get("egen-00000001")!.scheme).toBe("dark");
  });

  it("fills tokens a theme saved before they existed, and breaks fallback cycles with template literals", () => {
    // accent points at accent-fg, whose fallback points back at accent.
    const { tokens, filled } = fillThemeTokens("light", { ...without("accent-fg"), accent: "var(--accent-fg)" });
    expect(filled).toEqual(["accent", "accent-fg"]);
    expect(tokens.accent).toBe("#337a58");
    expect(themeContrastFailures(tokens)).toEqual([]);
    const resolved = resolveThemeTokens(tokens);
    for (const token of THEME_TOKENS) expect(resolved[token.name]).not.toMatch(/^var\(/);
  });
});

describe("the catalogue's fallbacks", () => {
  it("are 'template' or a reference to a catalogue token of the same kind, and resolve from nothing", () => {
    const kinds = new Map(THEME_TOKENS.map((t) => [t.name, t.kind]));
    for (const token of THEME_TOKENS) {
      if (token.fallback === "template") continue;
      const ref = /^var\(--([\w-]+)\)$/.exec(token.fallback)?.[1];
      expect({ token: token.name, kind: ref && kinds.get(ref) }).toEqual({ token: token.name, kind: token.kind });
    }
    for (const scheme of ["light", "dark"] as const) {
      const empty = validateTheme({ name: "Tom", scheme, tokens: {} });
      expect(empty.errors).toEqual([]);
      expect(empty.warnings.map((w) => w.message)).toEqual([`${THEME_TOKENS.length} av ${THEME_TOKENS.length} färger saknas i filen och fylls i automatiskt.`]);
    }
  });
});

describe("ensureContrast", () => {
  it("leaves a colour that already clears every background alone", () => {
    expect(ensureContrast("#1c2026", ["#ffffff", "#f6f7f9"])).toBe("#1c2026");
  });

  it("moves lightness away from the backgrounds, keeping the hue", () => {
    const fixed = ensureContrast("#4a9e77", ["#ffffff", "#f1f3f6"]);
    expect(contrastRatio(fixed, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fixed, "#f1f3f6")).toBeGreaterThanOrEqual(4.5);
    expect(hexToOklch(fixed).l).toBeLessThan(hexToOklch("#4a9e77").l);
    expect(Math.abs(hexToOklch(fixed).h - hexToOklch("#4a9e77").h)).toBeLessThan(5);

    const onDark = ensureContrast("#337a58", ["#15171b", "#22262e"]);
    expect(hexToOklch(onDark).l).toBeGreaterThan(hexToOklch("#337a58").l);
    expect(contrastRatio(onDark, "#22262e")).toBeGreaterThanOrEqual(4.5);
  });

  it("honours a custom minimum", () => {
    expect(contrastRatio(ensureContrast("#888888", ["#ffffff"], 7), "#ffffff")).toBeGreaterThanOrEqual(7);
  });

  it("falls back to black or white when no lightness clears every background", () => {
    const best = ensureContrast("#808080", ["#000000", "#ffffff"]);
    expect(["#000000", "#ffffff"]).toContain(best);
  });
});

describe("deriveTheme", () => {
  const sourceFrom = (base: ThemeScheme): ThemeSource => {
    const v = resolveThemeTokens(BUILTIN_THEME_VALUES[base]);
    return { base, bg: v["color-bg"]!, surface: v["color-surface"]!, text: v["color-text-primary"]!, accent: v.accent!, heading: null, status: null, overrides: {} };
  };
  const distance = (a: string, b: string) => {
    const x = hexToOklab(a);
    const y = hexToOklab(b);
    return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);
  };

  it.each(["light", "dark"] as const)("rebuilds the built-in %s theme from its four base colours, close to the original", (base) => {
    const derived = deriveTheme(sourceFrom(base));
    expect(derived.scheme).toBe(base);
    expect(derived.unmet).toEqual([]);
    expect(validateTheme({ name: "Prov", scheme: base, tokens: derived.tokens })).toMatchObject({ ok: true, warnings: [] });
    const got = resolveThemeTokens(derived.tokens);
    const want = resolveThemeTokens(BUILTIN_THEME_VALUES[base]);
    for (const name of ["color-bg", "color-surface", "color-text-primary", "accent", "accent-text"]) expect(got[name]).toBe(want[name]);
    const far = THEME_TOKENS.filter((t) => t.kind === "color" && distance(got[t.name]!, want[t.name]!) > 0.08).map((t) => t.name);
    // The wordmark follows the text colour by design; nothing else strays.
    expect(far.filter((name) => name !== "wordmark-color")).toEqual([]);
    for (const t of THEME_TOKENS.filter((t) => t.kind !== "color")) expect(got[t.name]).toBe(want[t.name]);
  });

  it("uses the heading and own status colours, and keeps them legible", () => {
    const derived = deriveTheme({
      ...sourceFrom("light"),
      heading: "#ff79c6",
      status: { running: "#00ff00", delayed: "#ffff00", stopped: "#ff0000", done: "#00ffff" },
    });
    expect(derived.unmet).toEqual([]);
    expect(derived.tokens["status-running"]).toBe("#00ff00");
    expect(derived.tokens["color-heading-accent"]).not.toMatch(/^var/);
    expect(contrastRatio(derived.tokens["status-delayed-text"]!, derived.tokens["status-delayed-bg"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("moves a mid-tone accent until white or near-black text clears AA on it", () => {
    const derived = deriveTheme({ ...sourceFrom("light"), accent: "#4a9e77" });
    expect(contrastRatio(derived.tokens["accent-text"]!, derived.tokens.accent!)).toBeGreaterThanOrEqual(4.5);
    const grey = deriveTheme({ ...sourceFrom("light"), accent: "#6f6f6f" });
    expect(contrastRatio(grey.tokens["accent-text"]!, grey.tokens.accent!)).toBeGreaterThanOrEqual(4.5);
  });

  it("lets overrides win, skipping invalid ones and ones that would break a reference", () => {
    const derived = deriveTheme({
      ...sourceFrom("light"),
      overrides: { "color-border": "#123456", accent: "#fff;}", "accent-fg": "var(--color-heading-accent)", sparkle: "#ffffff" },
    });
    expect(derived.tokens["color-border"]).toBe("#123456");
    expect(derived.tokens.accent).toBe("#337a58");
    expect(derived.tokens["accent-fg"]).toBe("var(--accent)");
    expect(derived.tokens).not.toHaveProperty("sparkle");
  });

  it("reports impossible combinations as unmet", () => {
    const derived = deriveTheme({ base: "dark", bg: "#000000", surface: "#ffffff", text: "#808080", accent: "#337a58", heading: null, status: null, overrides: {} });
    expect(derived.unmet.length).toBeGreaterThan(0);
  });

  it("property: unmet is empty and validateTheme accepts, or unmet is exactly what validateTheme reports (500 seeded sources)", () => {
    // Fixed-seed LCG, so a failure reproduces.
    let seed = 20261023;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const hex = () => `#${Math.floor(random() * 0x1000000).toString(16).padStart(6, "0")}`;
    const names = THEME_TOKENS.filter((t) => t.kind === "color").map((t) => t.name);
    let accepted = 0;
    for (let i = 0; i < 500; i++) {
      const overrides: Record<string, string> = {};
      if (random() < 0.3) overrides[names[Math.floor(random() * names.length)]!] = hex();
      const source: ThemeSource = {
        base: random() < 0.5 ? "light" : "dark",
        bg: hex(),
        surface: hex(),
        text: hex(),
        accent: hex(),
        heading: random() < 0.5 ? null : hex(),
        status: random() < 0.5 ? null : { running: hex(), delayed: hex(), stopped: hex(), done: hex() },
        overrides,
      };
      const derived = deriveTheme(source);
      const result = validateTheme({ name: `Slump ${i}`, scheme: derived.scheme, tokens: derived.tokens, source });
      expect({ i, errors: result.errors, warnings: result.warnings }).toEqual({ i, errors: [], warnings: [] });
      if (derived.unmet.length === 0) {
        expect({ i, ok: result.ok }).toEqual({ i, ok: true });
        accepted++;
      } else {
        expect({ i, failures: result.contrastFailures }).toEqual({ i, failures: derived.unmet });
      }
    }
    // Random colours are often unreasonable, but plenty still work out.
    expect(accepted).toBeGreaterThan(100);
  });
});

describe("the editor's helpers", () => {
  it("themeSourceFromTokens takes the base colours from the tokens and keeps every token as an override", () => {
    const source = themeSourceFromTokens("dark", BUILTIN_THEME_VALUES.dracula);
    expect(source).toMatchObject({ base: "dark", bg: "#21222c", surface: "#282a36", text: "#f8f8f2", accent: "#bd93f9", heading: null, status: null });
    expect(deriveTheme(source).tokens).toEqual(BUILTIN_THEME_VALUES.dracula);
  });

  it("fixContrast (Justera) moves the foreground until it clears all its backgrounds", () => {
    const tokens = { ...light, "color-text-muted": "#aaaaaa" };
    const fixed = fixContrast(tokens, "color-text-muted")!;
    expect(themeContrastFailures({ ...tokens, "color-text-muted": fixed })).toEqual([]);
    expect(fixContrast(tokens, "color-bg")).toBeNull();
  });
});
