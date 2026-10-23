// Egna teman — the colour-theme contract as data and pure functions: the token
// catalogue, the value grammar, validation, the CSS builder and the editor's
// derivation. ONE self-contained file with NO imports, because the web app
// cannot import @navet/shared (Turbopack and the .js-suffixed imports): it is
// copied byte for byte to apps/web/lib/themeCore.ts, and
// apps/api/test/theme-core-copy.test.ts fails when the two differ. Edit this
// file and copy it; never edit the web copy.
//
// The built-in themes still live in apps/web/styles/tokens.css;
// theme-tokens.test.ts requires every theme block there to declare exactly
// THEME_TOKENS and BUILTIN_THEME_VALUES to equal the blocks' values. A new
// token is therefore a declaration in every block AND an entry below with a
// fallback, so themes saved before it existed keep working.

export type ThemeTokenKind = "color" | "alpha" | "shadow";
export type ThemeTokenGroup = "Ytor" | "Text" | "Kontroller" | "Status" | "Accent" | "Skuggor" | "Logotyp";
export type ThemeScheme = "light" | "dark";
export type BuiltinThemeId = "light" | "dark" | "dracula";

export interface ThemeToken {
  // Without the leading "--", e.g. "color-bg".
  readonly name: string;
  readonly kind: ThemeTokenKind;
  readonly group: ThemeTokenGroup;
  // Swedish label, shown in the editor's Avancerat and in contrast messages.
  readonly label: string;
  // What a saved theme that lacks the token gets: "var(--other-token)" or
  // "template" (the value of the built-in light/dark theme matching the
  // theme's scheme).
  readonly fallback: string;
}

const t = (name: string, kind: ThemeTokenKind, group: ThemeTokenGroup, label: string, fallback = "template"): ThemeToken => ({
  name,
  kind,
  group,
  label,
  fallback,
});

// In tokens.css order — the CSS builder writes the tokens in this order.
export const THEME_TOKENS: readonly ThemeToken[] = [
  t("color-bg", "color", "Ytor", "Bakgrund"),
  t("color-surface", "color", "Ytor", "Ytor"),
  t("color-elevated", "color", "Ytor", "Upphöjda ytor", "var(--color-surface)"),
  t("color-input-surface", "color", "Ytor", "Indataytor", "var(--color-surface)"),
  t("color-border", "color", "Ytor", "Kantlinjer"),
  t("color-border-control", "color", "Ytor", "Kantlinjer på kontroller", "var(--color-border)"),
  t("color-divider", "color", "Ytor", "Avdelare"),
  t("color-text-primary", "color", "Text", "Text"),
  t("color-text-secondary", "color", "Text", "Sekundär text"),
  t("color-text-label", "color", "Text", "Etiketter"),
  t("color-text-muted", "color", "Text", "Dämpad text"),
  t("color-track", "color", "Kontroller", "Spår"),
  t("color-track-on-tint", "alpha", "Kontroller", "Spår på tonad yta"),
  t("color-control-on", "color", "Kontroller", "Påslagen kontroll"),
  t("color-control-knob", "color", "Kontroller", "Knopp och bock"),
  t("color-overlay", "alpha", "Ytor", "Överlägg bakom dialoger"),
  t("status-running", "color", "Status", "Pågår"),
  t("status-running-bg", "color", "Status", "Pågår, bakgrund"),
  t("status-running-text", "color", "Status", "Pågår, text"),
  t("status-delayed", "color", "Status", "Försenad"),
  t("status-delayed-bg", "color", "Status", "Försenad, bakgrund"),
  t("status-delayed-text", "color", "Status", "Försenad, text"),
  t("status-stopped", "color", "Status", "Stoppad"),
  t("status-stopped-bg", "color", "Status", "Stoppad, bakgrund"),
  t("status-stopped-text", "color", "Status", "Stoppad, text"),
  t("status-done", "color", "Status", "Klar"),
  t("status-done-bg", "color", "Status", "Klar, bakgrund"),
  t("status-done-text", "color", "Status", "Klar, text"),
  t("status-draft-bg", "color", "Status", "Utkast, bakgrund"),
  t("status-draft-text", "color", "Status", "Utkast, text"),
  t("accent", "color", "Accent", "Accentfärg"),
  t("accent-fg", "color", "Accent", "Accent som text", "var(--accent)"),
  t("accent-text", "color", "Accent", "Text på accentfärg"),
  t("btn-primary-bg", "color", "Accent", "Primärknapp", "var(--accent)"),
  t("btn-primary-text", "color", "Accent", "Text på primärknapp", "var(--accent-text)"),
  t("btn-danger-border", "color", "Kontroller", "Kant på farlig knapp"),
  t("color-heading-accent", "color", "Accent", "Rubriker", "var(--accent-fg)"),
  t("shadow-frame", "shadow", "Skuggor", "Ramens skugga"),
  t("shadow-popover", "shadow", "Skuggor", "Popupskugga"),
  t("shadow-knob", "shadow", "Skuggor", "Knoppens skugga"),
  t("wordmark-color", "color", "Logotyp", "Logotypens text"),
  t("wordmark-divider", "color", "Logotyp", "Logotypens avdelare"),
  t("wordmark-erp", "color", "Logotyp", "Logotypens ERP"),
  t("wordmark-symbol", "color", "Logotyp", "Logotypens symbol"),
  t("wordmark-symbol-center", "color", "Logotyp", "Symbolens mitt"),
];

const TOKEN_BY_NAME: ReadonlyMap<string, ThemeToken> = new Map(THEME_TOKENS.map((token) => [token.name, token]));

export function themeToken(name: string): ThemeToken | undefined {
  return TOKEN_BY_NAME.get(name);
}

export function themeTokenLabel(name: string): string {
  return TOKEN_BY_NAME.get(name)?.label ?? name;
}

// WCAG AA for normal text — every text token on every surface, plus the
// fixed foreground/background pairs. The plain status-* tokens are absent on
// purpose: they are for dots, bars and strokes, never text.
export const THEME_MIN_CONTRAST = 4.5;

export const THEME_TEXT_TOKENS: readonly string[] = [
  "color-text-primary",
  "color-text-secondary",
  "color-text-label",
  "color-text-muted",
  "accent-fg",
  "color-heading-accent",
  "status-running-text",
  "status-delayed-text",
  "status-stopped-text",
  "status-done-text",
  "status-draft-text",
];

export const THEME_SURFACE_TOKENS: readonly string[] = [
  "color-bg",
  "color-surface",
  "color-elevated",
  "color-input-surface",
  "color-divider",
];

export const THEME_CONTRAST_PAIRS: readonly (readonly [fg: string, bg: string])[] = [
  ...THEME_TEXT_TOKENS.flatMap((fg) => THEME_SURFACE_TOKENS.map((bg) => [fg, bg] as const)),
  ["status-running-text", "status-running-bg"],
  ["status-delayed-text", "status-delayed-bg"],
  ["status-stopped-text", "status-stopped-bg"],
  ["status-done-text", "status-done-bg"],
  ["status-draft-text", "status-draft-bg"],
  ["accent-text", "accent"],
  ["btn-primary-text", "btn-primary-bg"],
];

// --- Built-in themes ------------------------------------------------------

export const BUILTIN_THEMES: readonly { readonly id: BuiltinThemeId; readonly label: string; readonly scheme: ThemeScheme }[] = [
  { id: "light", label: "Ljust", scheme: "light" },
  { id: "dark", label: "Mörkt", scheme: "dark" },
  { id: "dracula", label: "Dracula", scheme: "dark" },
];

export function isBuiltinThemeId(value: unknown): value is BuiltinThemeId {
  return BUILTIN_THEMES.some((theme) => theme.id === value);
}

// Exactly the values of the theme blocks in tokens.css (theme-tokens.test.ts
// compares them): the export of a built-in theme, the editor's templates and
// the "template" fallback.
export const BUILTIN_THEME_VALUES: Readonly<Record<BuiltinThemeId, Readonly<Record<string, string>>>> = {
  light: {
    "color-bg": "#f6f7f9",
    "color-surface": "#ffffff",
    "color-elevated": "#ffffff",
    "color-input-surface": "#ffffff",
    "color-border": "#e7eaef",
    "color-border-control": "#dce0e7",
    "color-divider": "#f1f3f6",
    "color-text-primary": "#1c2026",
    "color-text-secondary": "#5c6470",
    "color-text-label": "#444b55",
    "color-text-muted": "#68707c",
    "color-track": "#f1f3f6",
    "color-track-on-tint": "rgba(0, 0, 0, 0.14)",
    "color-control-on": "#1c2026",
    "color-control-knob": "#ffffff",
    "color-overlay": "rgba(15, 17, 21, 0.45)",
    "status-running": "#4a9e77",
    "status-running-bg": "#e9f4ee",
    "status-running-text": "#2b7552",
    "status-delayed": "#c79a3a",
    "status-delayed-bg": "#f7efdc",
    "status-delayed-text": "#8a6516",
    "status-stopped": "#c25b52",
    "status-stopped-bg": "#f7e7e5",
    "status-stopped-text": "#a5443c",
    "status-done": "#5e7bb0",
    "status-done-bg": "#edf1f7",
    "status-done-text": "#46587c",
    "status-draft-bg": "#f1f3f6",
    "status-draft-text": "#5c6470",
    accent: "#337a58",
    "accent-fg": "var(--accent)",
    "accent-text": "#ffffff",
    "btn-primary-bg": "var(--accent)",
    "btn-primary-text": "var(--accent-text)",
    "btn-danger-border": "#eac9c5",
    "color-heading-accent": "var(--accent-fg)",
    "shadow-frame": "0 24px 60px -30px rgba(20, 23, 28, 0.28)",
    "shadow-popover": "0 8px 24px rgba(0, 0, 0, 0.12)",
    "shadow-knob": "0 1px 3px rgba(0, 0, 0, 0.25)",
    "wordmark-color": "#22312a",
    "wordmark-divider": "#2e9e6b",
    "wordmark-erp": "#6e7d74",
    "wordmark-symbol": "#2e9e6b",
    "wordmark-symbol-center": "#1f7a50",
  },
  dark: {
    "color-bg": "#15171b",
    "color-surface": "#1b1e24",
    "color-elevated": "#22262e",
    "color-input-surface": "#20242b",
    "color-border": "#2a2e37",
    "color-border-control": "#2e333c",
    "color-divider": "#2a2e37",
    "color-text-primary": "#edeef1",
    "color-text-secondary": "#a8aeb8",
    "color-text-label": "#c4c9d1",
    "color-text-muted": "#8f96a1",
    "color-track": "#2a2f38",
    "color-track-on-tint": "rgba(255, 255, 255, 0.16)",
    "color-control-on": "#5c6470",
    "color-control-knob": "#ffffff",
    "color-overlay": "rgba(0, 0, 0, 0.6)",
    "status-running": "#4fb284",
    "status-running-bg": "#1b3127",
    "status-running-text": "#7dd3a8",
    "status-delayed": "#d6a84a",
    "status-delayed-bg": "#352c19",
    "status-delayed-text": "#e6c172",
    "status-stopped": "#dd6f64",
    "status-stopped-bg": "#3a2120",
    "status-stopped-text": "#f09a91",
    "status-done": "#7b97cf",
    "status-done-bg": "#1f293b",
    "status-done-text": "#a9bde3",
    "status-draft-bg": "#2a2f38",
    "status-draft-text": "#a8aeb8",
    accent: "#337a58",
    "accent-fg": "#48c58c",
    "accent-text": "#ffffff",
    "btn-primary-bg": "var(--accent)",
    "btn-primary-text": "var(--accent-text)",
    "btn-danger-border": "#5a2f2b",
    "color-heading-accent": "var(--accent-fg)",
    "shadow-frame": "0 24px 60px -30px rgba(0, 0, 0, 0.6)",
    "shadow-popover": "0 8px 24px rgba(0, 0, 0, 0.45)",
    "shadow-knob": "0 1px 3px rgba(0, 0, 0, 0.5)",
    "wordmark-color": "#f1eee7",
    "wordmark-divider": "#48c58c",
    "wordmark-erp": "#a7b3aa",
    "wordmark-symbol": "#48c58c",
    "wordmark-symbol-center": "#8fd8b4",
  },
  dracula: {
    "color-bg": "#21222c",
    "color-surface": "#282a36",
    "color-elevated": "#303241",
    "color-input-surface": "#2d2f3d",
    "color-border": "#3b3e4f",
    "color-border-control": "#44475a",
    "color-divider": "#343746",
    "color-text-primary": "#f8f8f2",
    "color-text-secondary": "#c3c6d8",
    "color-text-label": "#e2e3ec",
    "color-text-muted": "#9aa3cc",
    "color-track": "#44475a",
    "color-track-on-tint": "rgba(248, 248, 242, 0.18)",
    "color-control-on": "#7c59bd",
    "color-control-knob": "#f8f8f2",
    "color-overlay": "rgba(14, 15, 20, 0.65)",
    "status-running": "#50fa7b",
    "status-running-bg": "#2e4b41",
    "status-running-text": "#50fa7b",
    "status-delayed": "#ffb86c",
    "status-delayed-bg": "#4a413f",
    "status-delayed-text": "#ffb86c",
    "status-stopped": "#ff5555",
    "status-stopped-bg": "#4a313b",
    "status-stopped-text": "#ff8a8a",
    "status-done": "#8be9fd",
    "status-done-bg": "#384956",
    "status-done-text": "#8be9fd",
    "status-draft-bg": "#44475a",
    "status-draft-text": "#e2e3ec",
    accent: "#bd93f9",
    "accent-fg": "#bd93f9",
    "accent-text": "#21222c",
    "btn-primary-bg": "var(--accent)",
    "btn-primary-text": "var(--accent-text)",
    "btn-danger-border": "#6b3240",
    "color-heading-accent": "#ff79c6",
    "shadow-frame": "0 24px 60px -30px rgba(0, 0, 0, 0.7)",
    "shadow-popover": "0 8px 24px rgba(0, 0, 0, 0.5)",
    "shadow-knob": "0 1px 3px rgba(0, 0, 0, 0.5)",
    "wordmark-color": "#f8f8f2",
    "wordmark-divider": "#48c58c",
    "wordmark-erp": "#a7b3aa",
    "wordmark-symbol": "#48c58c",
    "wordmark-symbol-center": "#8fd8b4",
  },
};

// --- Theme files and limits -----------------------------------------------

export const THEME_FILE_FORMAT = "nav-theme";
export const THEME_FILE_VERSION = 1;
export const THEME_FILE_MAX_BYTES = 64 * 1024;
export const THEME_NAME_MAX_LENGTH = 60;
export const MAX_CUSTOM_THEMES = 50;
// A custom theme's data-theme value. Generated by the server, never taken
// from a file, so the CSS selector can't be steered by input.
export const THEME_KEY_PATTERN = /^egen-[0-9a-f]{8}$/;

export interface ThemeStatusColors {
  running: string;
  delayed: string;
  stopped: string;
  done: string;
}

// The editor's base colours (Grundfärger), saved with the theme so it can be
// reopened in the editor. overrides are tokens the user set by hand in
// Avancerat; they win over the derivation.
export interface ThemeSource {
  base: ThemeScheme;
  bg: string;
  surface: string;
  text: string;
  accent: string;
  // null = the accent colour as text.
  heading: string | null;
  // null = the template's status hues (Standard).
  status: ThemeStatusColors | null;
  overrides: Record<string, string>;
}

export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT;
  version: typeof THEME_FILE_VERSION;
  name: string;
  scheme: ThemeScheme;
  tokens: Record<string, string>;
  source: ThemeSource | null;
}

export interface ThemeIssue {
  // The token the issue concerns (without "--"), or null for the theme as a whole.
  token: string | null;
  message: string;
}

export interface ThemeContrastFailure {
  fg: string;
  bg: string;
  // Rounded DOWN to two decimals, so a failing pair never reads as 4.5.
  ratio: number;
  required: number;
}

export interface ThemeValidationResult {
  ok: boolean;
  name: string;
  scheme: ThemeScheme | null;
  // Every catalogue token in catalogue order: the given values (canonical),
  // missing ones filled from their fallback. Only meaningful when ok.
  tokens: Record<string, string>;
  source: ThemeSource | null;
  warnings: ThemeIssue[];
  errors: ThemeIssue[];
  contrastFailures: ThemeContrastFailure[];
}

// --- Colour math ------------------------------------------------------------

type Rgb = [number, number, number];

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX6.test(value);
}

function parseHex(hex: string): Rgb | null {
  if (!HEX6.test(hex)) return null;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
}

// WCAG 2 contrast ratio of two opaque #rrggbb colours (the 0.03928 threshold
// as in the WCAG 2 text).
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const rgb = parseHex(hex);
    if (!rgb) throw new Error(`contrastRatio() needs an opaque #rrggbb colour, got ${hex}`);
    const [r, g, bl] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Oklab {
  l: number;
  a: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  // Degrees.
  h: number;
}

// sRGB ↔ OKLab (Björn Ottosson's matrices).
function linearToOklab([r, g, b]: Rgb): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinear({ l: L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function hexToOklab(hex: string): Oklab {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`hexToOklab() needs an opaque #rrggbb colour, got ${hex}`);
  return linearToOklab(rgb.map(srgbToLinear) as Rgb);
}

export function hexToOklch(hex: string): Oklch {
  const { l, a, b } = hexToOklab(hex);
  const c = Math.hypot(a, b);
  const h = c < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  return oklabToLinear({ l, a: c * Math.cos(rad), b: c * Math.sin(rad) });
}

// Out-of-gamut colours keep their lightness and hue and lose chroma until
// they fit sRGB.
export function oklchToHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l));
  let rgb = oklchToLinear({ l, c: color.c, h: color.h });
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h: color.h }))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinear({ l, c: lo, h: color.h });
  }
  return toHex(rgb.map((v) => linearToSrgb(Math.min(1, Math.max(0, v)))) as Rgb);
}

// Mix two colours in OKLab: amount 0 = a, 1 = b.
export function mixColors(a: string, b: string, amount: number): string {
  const x = hexToOklab(a);
  const y = hexToOklab(b);
  const lab = { l: x.l + (y.l - x.l) * amount, a: x.a + (y.a - x.a) * amount, b: x.b + (y.b - x.b) * amount };
  return toHex(oklabToLinear(lab).map((v) => linearToSrgb(Math.min(1, Math.max(0, v)))) as Rgb);
}

// Moves the foreground's lightness away from the backgrounds — keeping hue
// and chroma — until it clears `min` against every one of them, choosing the
// direction that needs the smaller change. When neither black nor white
// clears every background, the one with the best worst-case ratio is
// returned (the pair stays a failure).
export function ensureContrast(fg: string, bgs: readonly string[], min: number = THEME_MIN_CONTRAST): string {
  const start = fg.toLowerCase();
  const backgrounds = bgs.filter(isHexColor);
  if (!isHexColor(start) || backgrounds.length === 0) return start;
  const worst = (hex: string) => Math.min(...backgrounds.map((bg) => contrastRatio(hex, bg)));
  if (worst(start) >= min) return start;
  const base = hexToOklch(start);
  let best: { hex: string; delta: number } | null = null;
  for (const target of [0, 1]) {
    const extreme = target === 0 ? "#000000" : "#ffffff";
    if (worst(extreme) < min) continue;
    const at = (amount: number) => oklchToHex({ l: base.l + (target - base.l) * amount, c: base.c, h: base.h });
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (worst(at(mid)) >= min) hi = mid;
      else lo = mid;
    }
    // Rounding to 8 bits can land just short — step on until it clears.
    let amount = hi;
    let hex = at(amount);
    while (worst(hex) < min && amount < 1) {
      amount = Math.min(1, amount + 0.005);
      hex = at(amount);
    }
    if (worst(hex) < min) hex = extreme;
    const delta = Math.abs(hexToOklch(hex).l - base.l);
    if (!best || delta < best.delta) best = { hex, delta };
  }
  if (best) return best.hex;
  return worst("#000000") >= worst("#ffffff") ? "#000000" : "#ffffff";
}

// --- Value grammar ------------------------------------------------------------

const HEX8 = /^#[0-9a-fA-F]{8}$/;
const REF = /^var\(\s*--([a-z][a-z0-9-]{0,63})\s*\)$/;
const RGBA = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d(?:\.\d{1,4})?|\.\d{1,4})\s*\)$/;
// Lengths: 0, or up to three digits in px (unitless non-zero lengths are
// invalid CSS in box-shadow).
const LENGTH = /^(?:-?0|-?\d{1,3}px)$/;
const MAX_VALUE_LENGTH = 200;

export type ThemeValueCheck = { ok: true; value: string; ref: string | null } | { ok: false; message: string };

const KIND_HINT: Record<ThemeTokenKind, string> = {
  color: "ange en färg som #rrggbb eller var(--token)",
  alpha: "ange rgba(r, g, b, a) eller #rrggbbaa",
  shadow: "ange en eller två skuggor som \"x y [oskärpa [spridning]] färg\", t.ex. 0 8px 24px rgba(0, 0, 0, 0.45)",
};

function checkAlphaColour(value: string): string | null {
  if (HEX8.test(value)) return value.toLowerCase();
  const m = RGBA.exec(value);
  if (!m) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const a = Number(m[4]);
  if (r > 255 || g > 255 || b > 255 || !(a >= 0 && a <= 1)) return null;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function checkShadow(value: string): string | null {
  // Split layers on commas outside parentheses (rgba has its own).
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) return null;
    if (ch === "," && depth === 0) {
      layers.push(current);
      current = "";
    } else current += ch;
  }
  layers.push(current);
  if (depth !== 0 || layers.length > 2) return null;
  const out: string[] = [];
  for (const raw of layers) {
    const layer = raw.trim();
    const colourStart = Math.max(layer.lastIndexOf("rgba("), layer.lastIndexOf("#"));
    if (colourStart <= 0) return null;
    const colour = checkAlphaColour(layer.slice(colourStart).trim());
    const lengths = layer.slice(0, colourStart).trim().split(/\s+/);
    if (!colour || lengths.length < 2 || lengths.length > 4 || !lengths.every((l) => LENGTH.test(l))) return null;
    out.push(`${lengths.join(" ")} ${colour}`);
  }
  return out.join(", ");
}

// One token value against its kind's grammar. Returns the canonical form
// (trimmed, lower-case hex, normalised rgba spacing) and the referenced token
// for var(--x). Anything else is refused — a value can therefore never carry
// ";", "}", "url(", "</style>" or other CSS.
export function checkTokenValue(kind: ThemeTokenKind, value: unknown): ThemeValueCheck {
  if (typeof value !== "string") return { ok: false, message: `värdet måste vara text — ${KIND_HINT[kind]}` };
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > MAX_VALUE_LENGTH) {
    return { ok: false, message: `ogiltigt värde — ${KIND_HINT[kind]}` };
  }
  const ref = REF.exec(trimmed);
  if (ref) return { ok: true, value: `var(--${ref[1]})`, ref: ref[1]! };
  const canonical =
    kind === "color" ? (HEX6.test(trimmed) ? trimmed.toLowerCase() : null) : kind === "alpha" ? checkAlphaColour(trimmed) : checkShadow(trimmed);
  if (canonical === null) return { ok: false, message: `ogiltigt värde "${trimmed.slice(0, 60)}" — ${KIND_HINT[kind]}` };
  return { ok: true, value: canonical, ref: null };
}

const MAX_REF_DEPTH = 3;

// Broken references in a complete token set: a reference must name a
// catalogue token of the same kind, without cycles, at most three levels deep.
// Each problem is reported once, on the token whose own value is at fault (the
// one naming a missing or other-kind token, each member of a cycle, the start
// of a too-long chain) — not on every token that merely leads to it.
function referenceProblems(tokens: Readonly<Record<string, string>>): Map<string, string> {
  const problems = new Map<string, string>();
  const report = (name: string, message: string) => {
    if (!problems.has(name)) problems.set(name, message);
  };
  for (const token of THEME_TOKENS) {
    let current = token;
    const seen = new Set<string>([token.name]);
    for (let hops = 0; ; hops++) {
      const ref = REF.exec(tokens[current.name] ?? "")?.[1];
      if (ref === undefined) break;
      const target = TOKEN_BY_NAME.get(ref);
      if (!target) {
        report(current.name, `pekar på --${ref}, som inte finns`);
        break;
      }
      if (target.kind !== token.kind) {
        report(current.name, `pekar på --${ref}, som är av en annan typ`);
        break;
      }
      if (seen.has(ref)) {
        // Only a cycle through the start token is the start token's fault.
        if (ref === token.name) report(token.name, "referenserna bildar en cirkel");
        break;
      }
      if (hops + 1 > MAX_REF_DEPTH) {
        report(token.name, `för många led av referenser (högst ${MAX_REF_DEPTH})`);
        break;
      }
      seen.add(ref);
      current = target;
    }
  }
  return new Map(THEME_TOKENS.filter((t) => problems.has(t.name)).map((t) => [t.name, problems.get(t.name)!]));
}

// Every reference followed to its literal value. Assumes a complete set
// without broken references (validated or filled); a broken one is left as is.
export function resolveThemeTokens(tokens: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    let value = tokens[token.name] ?? "";
    for (let i = 0; i <= MAX_REF_DEPTH; i++) {
      const ref = REF.exec(value)?.[1];
      if (ref === undefined) break;
      value = tokens[ref] ?? value;
    }
    out[token.name] = value;
  }
  return out;
}

const templateFor = (scheme: ThemeScheme | null) => BUILTIN_THEME_VALUES[scheme === "dark" ? "dark" : "light"];
const RESOLVED_TEMPLATES = {
  light: resolveThemeTokens(BUILTIN_THEME_VALUES.light),
  dark: resolveThemeTokens(BUILTIN_THEME_VALUES.dark),
};

function fallbackValue(token: ThemeToken, scheme: ThemeScheme | null): string {
  return token.fallback === "template" ? templateFor(scheme)[token.name]! : token.fallback;
}

// A complete, always-resolvable token set from stored values: a value that
// fails the grammar (or names a token that doesn't exist) gets the token's
// fallback, and a reference that still can't be followed is replaced by the
// template's literal. Used by the CSS builder so no stored row — however old
// — can produce broken or unsafe CSS. `filled` lists the tokens not taken
// from the input.
export function fillThemeTokens(
  scheme: ThemeScheme | null,
  given: Readonly<Record<string, unknown>>
): { tokens: Record<string, string>; filled: string[] } {
  const tokens: Record<string, string> = {};
  const filled = new Set<string>();
  for (const token of THEME_TOKENS) {
    const check = checkTokenValue(token.kind, given[token.name]);
    if (check.ok) tokens[token.name] = check.value;
    else {
      tokens[token.name] = fallbackValue(token, scheme);
      filled.add(token.name);
    }
  }
  // One token at a time, first in catalogue order: breaking a cycle at one
  // token usually repairs every token that ran into it.
  for (let i = 0; i < THEME_TOKENS.length; i++) {
    const [name] = referenceProblems(tokens).keys();
    if (name === undefined) break;
    tokens[name] = RESOLVED_TEMPLATES[scheme === "dark" ? "dark" : "light"][name]!;
    filled.add(name);
  }
  return { tokens, filled: THEME_TOKENS.map((token) => token.name).filter((name) => filled.has(name)) };
}

// Contrast failures of a complete token set (references allowed), in
// THEME_CONTRAST_PAIRS order. The one rule the tests, the server, the upload
// preview and the editor share.
export function themeContrastFailures(tokens: Readonly<Record<string, string>>): ThemeContrastFailure[] {
  const resolved = resolveThemeTokens(tokens);
  const failures: ThemeContrastFailure[] = [];
  for (const [fg, bg] of THEME_CONTRAST_PAIRS) {
    const a = resolved[fg];
    const b = resolved[bg];
    if (!isHexColor(a) || !isHexColor(b)) continue;
    const ratio = contrastRatio(a, b);
    if (ratio < THEME_MIN_CONTRAST) {
      failures.push({ fg, bg, ratio: Math.floor(ratio * 100) / 100, required: THEME_MIN_CONTRAST });
    }
  }
  return failures;
}

const swedishNumber = (value: number) => value.toFixed(1).replace(".", ",");

// "Dämpad text på Indataytor: 3,9:1, kräver 4,5:1"
export function formatContrastFailure(failure: ThemeContrastFailure): string {
  return `${themeTokenLabel(failure.fg)} på ${themeTokenLabel(failure.bg)}: ${swedishNumber(
    Math.floor(failure.ratio * 10) / 10
  )}:1, kräver ${swedishNumber(failure.required)}:1`;
}

// The surfaces/backgrounds a foreground token is paired with.
export function contrastBackgroundsFor(fg: string): string[] {
  return THEME_CONTRAST_PAIRS.filter(([f]) => f === fg).map(([, bg]) => bg);
}

// Editor's Justera: the foreground's literal colour moved until it clears
// every background it is paired with (null when the token isn't a text token).
export function fixContrast(tokens: Readonly<Record<string, string>>, fg: string): string | null {
  const backgrounds = contrastBackgroundsFor(fg);
  if (backgrounds.length === 0) return null;
  const resolved = resolveThemeTokens(tokens);
  const value = resolved[fg];
  if (!isHexColor(value)) return null;
  return ensureContrast(value, backgrounds.map((bg) => resolved[bg] ?? "").filter(isHexColor));
}

const issue = (token: string | null, message: string): ThemeIssue => ({
  token,
  message: token ? `${themeTokenLabel(token)} (--${token}): ${message}` : message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The editor's base colours, checked. null/undefined = no source.
export function normalizeThemeSource(raw: unknown): { source: ThemeSource | null; errors: ThemeIssue[]; warnings: ThemeIssue[] } {
  const errors: ThemeIssue[] = [];
  const warnings: ThemeIssue[] = [];
  if (raw === null || raw === undefined) return { source: null, errors, warnings };
  const invalid = (detail: string) => ({
    source: null,
    errors: [issue(null, `Grundfärgerna (source) är ogiltiga: ${detail}.`)],
    warnings,
  });
  if (!isRecord(raw)) return invalid("ska vara ett objekt eller null");
  if (raw.base !== "light" && raw.base !== "dark") return invalid("Utgå från ska vara light eller dark");
  for (const key of ["bg", "surface", "text", "accent"] as const) {
    if (!isHexColor(raw[key])) return invalid(`${key} ska vara en färg som #rrggbb`);
  }
  if (raw.heading !== null && raw.heading !== undefined && !isHexColor(raw.heading)) {
    return invalid("heading ska vara en färg som #rrggbb eller null");
  }
  let status: ThemeStatusColors | null = null;
  if (raw.status !== null && raw.status !== undefined) {
    const s = raw.status;
    if (!isRecord(s) || !(["running", "delayed", "stopped", "done"] as const).every((k) => isHexColor(s[k]))) {
      return invalid("statusfärgerna ska vara fyra färger som #rrggbb eller null");
    }
    status = {
      running: (s.running as string).toLowerCase(),
      delayed: (s.delayed as string).toLowerCase(),
      stopped: (s.stopped as string).toLowerCase(),
      done: (s.done as string).toLowerCase(),
    };
  }
  const overrides: Record<string, string> = {};
  if (raw.overrides !== undefined && raw.overrides !== null) {
    if (!isRecord(raw.overrides)) return invalid("overrides ska vara ett objekt");
    for (const [name, value] of Object.entries(raw.overrides)) {
      const token = TOKEN_BY_NAME.get(name);
      if (!token) {
        warnings.push(issue(null, `Överskrivningen av --${name} ignoreras — den tokenen finns inte i den här versionen av Nav.`));
        continue;
      }
      const check = checkTokenValue(token.kind, value);
      if (!check.ok) errors.push(issue(name, `överskrivningen har ${check.message}`));
      else overrides[name] = check.value;
    }
  }
  if (errors.length > 0) return { source: null, errors, warnings };
  return {
    source: {
      base: raw.base,
      bg: (raw.bg as string).toLowerCase(),
      surface: (raw.surface as string).toLowerCase(),
      text: (raw.text as string).toLowerCase(),
      accent: (raw.accent as string).toLowerCase(),
      heading: isHexColor(raw.heading) ? raw.heading.toLowerCase() : null,
      status,
      overrides,
    },
    errors,
    warnings,
  };
}

// The server's check of a theme — a parsed theme file or the API body
// ({ name, scheme, tokens, source? }; format/version are checked when
// present, other top-level fields ignored). Unknown token ⇒ warning, missing
// token ⇒ filled from its fallback with a warning, invalid value or broken
// reference ⇒ error, contrast below 4.5:1 ⇒ contrastFailures. ok only
// without errors and contrast failures — the same bar as the built-in themes.
export function validateTheme(input: unknown): ThemeValidationResult {
  const errors: ThemeIssue[] = [];
  const warnings: ThemeIssue[] = [];
  const result = (scheme: ThemeScheme | null, name: string, tokens: Record<string, string>, source: ThemeSource | null) => {
    const contrastFailures = errors.length === 0 ? themeContrastFailures(tokens) : [];
    return { ok: errors.length === 0 && contrastFailures.length === 0, name, scheme, tokens, source, warnings, errors, contrastFailures };
  };
  if (!isRecord(input)) {
    errors.push(issue(null, "Temat ska vara ett JSON-objekt."));
    return result(null, "", fillThemeTokens(null, {}).tokens, null);
  }
  if (input.format !== undefined && input.format !== THEME_FILE_FORMAT) {
    errors.push(issue(null, `Filen är ingen Nav-temafil (format ska vara "${THEME_FILE_FORMAT}").`));
  }
  if (input.version !== undefined && input.version !== THEME_FILE_VERSION) {
    errors.push(
      issue(null, `Temafilen har version ${String(input.version).slice(0, 10)} — den här versionen av Nav läser version ${THEME_FILE_VERSION}.`)
    );
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) errors.push(issue(null, "Temat måste ha ett namn."));
  else if (name.length > THEME_NAME_MAX_LENGTH) errors.push(issue(null, `Namnet får vara högst ${THEME_NAME_MAX_LENGTH} tecken.`));
  else if (/[\u0000-\u001f\u007f]/.test(name)) errors.push(issue(null, "Namnet innehåller otillåtna tecken."));
  const scheme: ThemeScheme | null = input.scheme === "light" || input.scheme === "dark" ? input.scheme : null;
  if (!scheme) errors.push(issue(null, 'Typ (scheme) ska vara "light" eller "dark".'));

  const given = isRecord(input.tokens) ? input.tokens : null;
  if (!given) errors.push(issue(null, "Temat saknar tokens."));
  const tokens: Record<string, string> = {};
  const missing: ThemeToken[] = [];
  for (const token of THEME_TOKENS) {
    if (!given || !(token.name in given)) {
      tokens[token.name] = fallbackValue(token, scheme);
      if (given) missing.push(token);
      continue;
    }
    const check = checkTokenValue(token.kind, given[token.name]);
    if (check.ok) tokens[token.name] = check.value;
    else {
      errors.push(issue(token.name, check.message));
      tokens[token.name] = fallbackValue(token, scheme);
    }
  }
  // One line, not one per token: a hand-written file may set only a few.
  if (missing.length > 3) {
    warnings.push(issue(null, `${missing.length} av ${THEME_TOKENS.length} färger saknas i filen och fylls i automatiskt.`));
  } else {
    for (const token of missing) warnings.push(issue(token.name, "saknas i filen och fylls i automatiskt."));
  }
  if (given) {
    for (const name of Object.keys(given)) {
      if (!TOKEN_BY_NAME.has(name)) {
        warnings.push(issue(null, `Okänd token --${name.slice(0, 64)} ignoreras (filen kan komma från en nyare version av Nav).`));
      }
    }
  }
  for (const [name, message] of referenceProblems(tokens)) errors.push(issue(name, message));

  const source = normalizeThemeSource(input.source);
  errors.push(...source.errors);
  warnings.push(...source.warnings);
  return result(scheme, name, tokens, source.source);
}

// UTF-8 byte length without TextEncoder (not in the shared package's lib).
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// A theme file as uploaded: size and JSON only — the content goes on to
// validateTheme.
export function parseThemeFile(text: string): { ok: true; input: unknown } | { ok: false; errors: ThemeIssue[] } {
  if (utf8Length(text) > THEME_FILE_MAX_BYTES) {
    return { ok: false, errors: [issue(null, "Filen är större än 64 kB.")] };
  }
  try {
    return { ok: true, input: JSON.parse(text) };
  } catch {
    return { ok: false, errors: [issue(null, "Filen är inte giltig JSON.")] };
  }
}

// The downloadable theme file (Exportera).
export function buildThemeFile(theme: {
  name: string;
  scheme: ThemeScheme;
  tokens: Readonly<Record<string, string>>;
  source?: ThemeSource | null;
}): ThemeFile {
  const tokens: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = theme.tokens[token.name];
    if (value !== undefined) tokens[token.name] = value;
  }
  return { format: THEME_FILE_FORMAT, version: THEME_FILE_VERSION, name: theme.name, scheme: theme.scheme, tokens, source: theme.source ?? null };
}

// The CSS for the custom themes: one :root[data-theme="<key>"] block each,
// color-scheme plus every catalogue token in catalogue order. Values go
// through fillThemeTokens (the grammar again, fallbacks for missing tokens),
// and the key must be a generated one — nothing from a file reaches the CSS
// unchecked.
export function buildThemeCss(themes: readonly { key: string; scheme: string; tokens: Readonly<Record<string, unknown>> }[]): string {
  return themes
    .map((theme) => {
      if (!THEME_KEY_PATTERN.test(theme.key)) throw new Error(`Invalid theme key: ${theme.key.slice(0, 40)}`);
      const scheme: ThemeScheme = theme.scheme === "dark" ? "dark" : "light";
      const { tokens } = fillThemeTokens(scheme, theme.tokens);
      const lines = THEME_TOKENS.map((token) => `  --${token.name}: ${tokens[token.name]};`);
      return `:root[data-theme="${theme.key}"] {\n  color-scheme: ${scheme};\n${lines.join("\n")}\n}`;
    })
    .join("\n");
}

// --- The editor's derivation --------------------------------------------------

// "Nästan svart" text on a light accent.
const NEAR_BLACK = "#16181d";
const WHITE = "#ffffff";

const lighten = (hex: string, amount: number) => {
  const c = hexToOklch(hex);
  return oklchToHex({ ...c, l: c.l + amount });
};

// A dark theme's status tint: the surface a little lighter, with a third of
// the hue's chroma and its hue angle.
function darkTint(surface: string, colour: string): string {
  const s = hexToOklab(surface);
  const c = hexToOklab(colour);
  return toHex(
    oklabToLinear({ l: s.l + 0.04, a: s.a + (c.a - s.a) * 0.3, b: s.b + (c.b - s.b) * 0.3 }).map((v) =>
      linearToSrgb(Math.min(1, Math.max(0, v)))
    ) as Rgb
  );
}

// ensureContrast towards a higher ratio for looks, falling back to AA when
// the higher one can't be reached.
function preferContrast(fg: string, bgs: readonly string[], preferred: number): string {
  const strong = ensureContrast(fg, bgs, preferred);
  return bgs.every((bg) => contrastRatio(strong, bg) >= preferred) ? strong : ensureContrast(fg, bgs);
}

const lightnessDelta = (a: string, b: string) => Math.abs(hexToOklch(a).l - hexToOklch(b).l);

// The editor's base colours for a theme without a source (an uploaded one):
// the base colours from its tokens, every token as an override.
export function themeSourceFromTokens(scheme: ThemeScheme, tokens: Readonly<Record<string, string>>): ThemeSource {
  const filled = fillThemeTokens(scheme, tokens).tokens;
  const resolved = resolveThemeTokens(filled);
  return {
    base: scheme,
    bg: resolved["color-bg"]!,
    surface: resolved["color-surface"]!,
    text: resolved["color-text-primary"]!,
    accent: resolved.accent!,
    heading: null,
    status: null,
    overrides: { ...filled },
  };
}

// Every token from the editor's base colours. Computed in OKLCH: mixes for
// borders and tints, ensureContrast for every text colour, the template
// (Ljust/Mörkt) for overlays, shadows and the logo's brand greens. The
// source's overrides win (invalid ones are skipped). `unmet` is exactly what
// validateTheme would report as contrast failures — empty for every
// reasonable choice.
export function deriveTheme(source: ThemeSource): {
  scheme: ThemeScheme;
  tokens: Record<string, string>;
  unmet: ThemeContrastFailure[];
} {
  const scheme: ThemeScheme = source.base === "dark" ? "dark" : "light";
  const dark = scheme === "dark";
  const template = templateFor(scheme);
  const resolvedTemplate = RESOLVED_TEMPLATES[scheme];
  const pick = (value: unknown, fallbackToken: string) =>
    isHexColor(value) ? value.toLowerCase() : resolvedTemplate[fallbackToken]!;

  const bg = pick(source.bg, "color-bg");
  const surface = pick(source.surface, "color-surface");
  const text = pick(source.text, "color-text-primary");
  const accentBase = pick(source.accent, "accent");
  const hue = (key: keyof ThemeStatusColors, token: string) => pick(source.status?.[key], token);

  const out: Record<string, string> = {};

  // Surfaces.
  const elevated = dark ? lighten(surface, 0.03) : surface;
  const inputSurface = dark ? mixColors(surface, elevated, 0.6) : surface;
  const divider = mixColors(surface, text, 0.06);
  const track = mixColors(surface, text, 0.08);
  out["color-bg"] = bg;
  out["color-surface"] = surface;
  out["color-elevated"] = elevated;
  out["color-input-surface"] = inputSurface;
  out["color-border"] = mixColors(surface, text, 0.1);
  out["color-border-control"] = mixColors(surface, text, 0.14);
  out["color-divider"] = divider;
  const surfaces = [bg, surface, elevated, inputSurface, divider];

  // Text.
  const primary = ensureContrast(text, surfaces);
  const secondary = ensureContrast(mixColors(text, surface, 0.35), surfaces);
  out["color-text-primary"] = primary;
  out["color-text-secondary"] = secondary;
  out["color-text-label"] = ensureContrast(mixColors(text, surface, 0.2), surfaces);
  out["color-text-muted"] = ensureContrast(mixColors(text, surface, 0.45), surfaces);

  // Controls.
  const controlOn = dark ? mixColors(surface, text, 0.35) : primary;
  out["color-track"] = track;
  out["color-track-on-tint"] = template["color-track-on-tint"]!;
  out["color-control-on"] = controlOn;
  out["color-control-knob"] = ensureContrast(resolvedTemplate["color-control-knob"]!, [controlOn], 3);
  out["color-overlay"] = template["color-overlay"]!;

  // Status: the hue for dots and bars, a tint of it in the surface (12 % in
  // light; in dark the surface's lightness with a third of the hue's chroma,
  // as the Mörkt theme's deep tints), and the hue as text that clears both
  // the tint and every surface — lightened towards the text colour in dark,
  // where the plain hue reads too heavy as text.
  for (const key of ["running", "delayed", "stopped", "done"] as const) {
    const colour = hue(key, `status-${key}`);
    const tinted = dark ? darkTint(surface, colour) : mixColors(surface, colour, 0.12);
    out[`status-${key}`] = colour;
    out[`status-${key}-bg`] = tinted;
    out[`status-${key}-text`] = ensureContrast(dark ? mixColors(colour, text, 0.3) : colour, [tinted, ...surfaces]);
  }
  out["status-draft-bg"] = track;
  out["status-draft-text"] = ensureContrast(secondary, [track, ...surfaces]);

  // Accent: white or near-black text on the fill, whichever reads better; if
  // neither clears AA the fill's lightness moves until one does (the light
  // theme's #4a9e77 → #337a58).
  let accent = accentBase;
  let accentText = contrastRatio(WHITE, accent) >= contrastRatio(NEAR_BLACK, accent) ? WHITE : NEAR_BLACK;
  if (contrastRatio(accentText, accent) < THEME_MIN_CONTRAST) {
    const forWhite = ensureContrast(accentBase, [WHITE]);
    const forBlack = ensureContrast(accentBase, [NEAR_BLACK]);
    const whiteOk = contrastRatio(WHITE, forWhite) >= THEME_MIN_CONTRAST;
    const blackOk = contrastRatio(NEAR_BLACK, forBlack) >= THEME_MIN_CONTRAST;
    if (whiteOk && (!blackOk || lightnessDelta(forWhite, accentBase) <= lightnessDelta(forBlack, accentBase))) {
      accent = forWhite;
      accentText = WHITE;
    } else {
      accent = forBlack;
      accentText = NEAR_BLACK;
    }
  }
  // In dark the fill is usually too heavy as text: lifted to 7:1 when it
  // can be (the Mörkt theme's #48c58c), never below AA.
  const accentFg = dark ? preferContrast(accent, surfaces, 7) : ensureContrast(accent, surfaces);
  out.accent = accent;
  out["accent-fg"] = accentFg === accent ? "var(--accent)" : accentFg;
  out["accent-text"] = accentText;
  out["btn-primary-bg"] = "var(--accent)";
  out["btn-primary-text"] = "var(--accent-text)";
  out["btn-danger-border"] = mixColors(surface, hue("stopped", "status-stopped"), 0.3);
  out["color-heading-accent"] = isHexColor(source.heading) ? ensureContrast(source.heading.toLowerCase(), surfaces) : "var(--accent-fg)";

  for (const name of ["shadow-frame", "shadow-popover", "shadow-knob"]) out[name] = template[name]!;
  // The logo keeps its brand greens; only the wordmark text follows the theme.
  out["wordmark-color"] = primary;
  for (const name of ["wordmark-divider", "wordmark-erp", "wordmark-symbol", "wordmark-symbol-center"]) out[name] = template[name]!;

  // Overrides win, one at a time so a broken reference only drops itself.
  const overrides = isRecord(source.overrides) ? source.overrides : {};
  for (const [name, value] of Object.entries(overrides)) {
    const token = TOKEN_BY_NAME.get(name);
    if (!token) continue;
    const check = checkTokenValue(token.kind, value);
    if (!check.ok) continue;
    const previous = out[name]!;
    out[name] = check.value;
    if (referenceProblems(out).size > 0) out[name] = previous;
  }

  const tokens: Record<string, string> = {};
  for (const token of THEME_TOKENS) tokens[token.name] = out[token.name]!;
  return { scheme, tokens, unmet: themeContrastFailures(tokens) };
}
