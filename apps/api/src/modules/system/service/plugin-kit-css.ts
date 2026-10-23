import { BUILTIN_THEME_VALUES, BUILTIN_THEMES, THEME_TOKENS } from "@navet/shared";

// Tillägg — GET /plugin-kit.css: every theme's tokens (the built-in ones from
// the catalogue's BUILTIN_THEME_VALUES, the custom ones as the theme service
// builds them for /theme-boot) plus a small base style that uses only those
// tokens. A plugin links it and sets data-theme from the context token, and
// looks like Nav in every theme. Pure: the custom CSS comes in as a string
// the theme service already built from validated values.

function builtinBlocks(): string {
  return BUILTIN_THEMES.map((theme) => {
    const values = BUILTIN_THEME_VALUES[theme.id];
    const lines = THEME_TOKENS.filter((token) => values[token.name] !== undefined).map(
      (token) => `  --${token.name}: ${values[token.name]};`
    );
    // The first built-in (light) is also the default without data-theme.
    const selector = theme.id === BUILTIN_THEMES[0]!.id ? `:root,\n:root[data-theme="${theme.id}"]` : `:root[data-theme="${theme.id}"]`;
    return `${selector} {\n  color-scheme: ${theme.scheme};\n${lines.join("\n")}\n}`;
  }).join("\n");
}

// Theme-independent sizes (like tokens.css's shared :root) and the base style.
const BASE = `:root {
  --nav-radius-control: 10px;
  --nav-radius-card: 16px;
  --nav-radius-pill: 999px;
  --nav-space-1: 4px;
  --nav-space-2: 8px;
  --nav-space-3: 12px;
  --nav-space-4: 16px;
  --nav-font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
html, body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text-primary);
  font-family: var(--nav-font);
  font-size: 14px;
  line-height: 1.45;
}
h1, h2, h3 { color: var(--color-heading-accent); margin: 0 0 var(--nav-space-3); }
a { color: var(--accent-fg); }
.nav-muted { color: var(--color-text-secondary); }
.nav-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--nav-radius-card);
  padding: var(--nav-space-4);
}
.nav-button {
  display: inline-flex;
  align-items: center;
  gap: var(--nav-space-2);
  padding: 7px 14px;
  border-radius: var(--nav-radius-control);
  border: 1px solid var(--color-border-control);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font: inherit;
  cursor: pointer;
}
.nav-button:hover { background: var(--color-divider); }
.nav-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.nav-button--primary {
  background: var(--btn-primary-bg);
  border-color: var(--btn-primary-bg);
  color: var(--btn-primary-text);
}
.nav-button--primary:hover { background: var(--btn-primary-bg); filter: brightness(1.05); }
.nav-button:disabled { opacity: 0.55; cursor: default; }
.nav-table { width: 100%; border-collapse: collapse; }
.nav-table th {
  text-align: left;
  font-weight: 600;
  color: var(--color-text-label);
  border-bottom: 1px solid var(--color-border);
  padding: var(--nav-space-2) var(--nav-space-3);
}
.nav-table td { border-bottom: 1px solid var(--color-divider); padding: var(--nav-space-2) var(--nav-space-3); }
.nav-field { display: flex; flex-direction: column; gap: var(--nav-space-1); margin-bottom: var(--nav-space-3); }
.nav-field label { color: var(--color-text-label); font-weight: 500; }
.nav-field input, .nav-field select, .nav-field textarea {
  font: inherit;
  color: var(--color-text-primary);
  background: var(--color-input-surface);
  border: 1px solid var(--color-border-control);
  border-radius: var(--nav-radius-control);
  padding: 7px 10px;
}
.nav-field input:focus-visible, .nav-field select:focus-visible, .nav-field textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.nav-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--nav-radius-pill);
  font-size: 12px;
  font-weight: 600;
  background: var(--status-draft-bg);
  color: var(--status-draft-text);
}
.nav-badge--running { background: var(--status-running-bg); color: var(--status-running-text); }
.nav-badge--delayed { background: var(--status-delayed-bg); color: var(--status-delayed-text); }
.nav-badge--stopped { background: var(--status-stopped-bg); color: var(--status-stopped-text); }
.nav-badge--done { background: var(--status-done-bg); color: var(--status-done-text); }`;

export function buildPluginKitCss(customThemeCss: string): string {
  return ["/* Nav plugin kit — themes and base style */", builtinBlocks(), customThemeCss, BASE].filter((part) => part.length > 0).join("\n");
}
