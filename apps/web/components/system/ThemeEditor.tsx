"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_VALUES,
  THEME_TOKENS,
  alignThemeSource,
  buildThemeFile,
  checkTokenValue,
  deriveTheme,
  editableThemeSource,
  fixContrast,
  formatContrastFailure,
  isBuiltinThemeId,
  isHexColor,
  themeSourceFromTokens,
} from "../../lib/themeCore";
import type { ThemeDetail, ThemeIssue, ThemeScheme, ThemeSource } from "../../lib/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { ThemePreview } from "./ThemePreview";
import styles from "./ThemeEditor.module.css";

const SCHEME_OPTIONS = [
  { value: "light" as const, label: "Ljust" },
  { value: "dark" as const, label: "Mörkt" },
];

const STATUS_FIELDS = [
  { key: "running", label: "Pågår" },
  { key: "delayed", label: "Försenad" },
  { key: "stopped", label: "Stoppad" },
  { key: "done", label: "Klar" },
] as const;

// Only for the colour picker when a value is not a hex colour.
const FALLBACK_HEX = BUILTIN_THEME_VALUES.light["color-text-muted"]!;

// The template's own base colours for a scheme, no overrides.
function templateSource(scheme: ThemeScheme): ThemeSource {
  return { ...themeSourceFromTokens(scheme, BUILTIN_THEME_VALUES[scheme]), overrides: {} };
}

function templateStatus(scheme: ThemeScheme) {
  const value = (key: string) => {
    const v = BUILTIN_THEME_VALUES[scheme][`status-${key}`];
    return isHexColor(v) ? v : FALLBACK_HEX;
  };
  return { running: value("running"), delayed: value("delayed"), stopped: value("stopped"), done: value("done") };
}

interface Initial {
  name: string;
  source: ThemeSource;
  advancedOpen: boolean;
}

// Whether a source is exactly the template's base colours for its base —
// nothing chosen yet, so switching Utgå från loses nothing.
function isTemplateSource(source: ThemeSource): boolean {
  const template = templateSource(source.base);
  return (
    source.bg === template.bg &&
    source.surface === template.surface &&
    source.text === template.text &&
    source.accent === template.accent &&
    source.heading === null &&
    source.status === null &&
    Object.keys(source.overrides).length === 0
  );
}

const withAdvanced = (name: string, source: ThemeSource): Initial => ({
  name,
  source,
  advancedOpen: Object.keys(source.overrides).length > 0,
});

function initialState(theme: ThemeDetail | null, copyOf: string | null): Initial {
  if (theme) {
    // A saved source: every token the base colours don't reproduce becomes
    // an override, so the editor shows — and Spara keeps — exactly the
    // stored colours (a hand-edited theme file, or a theme saved before
    // deriveTheme was tuned). The server stores sources the same way.
    const aligned = theme.source ? alignThemeSource(theme.source, theme.tokens) : null;
    if (aligned) return { name: theme.name, source: aligned, advancedOpen: false };
    // An uploaded theme (no source): base colours from its tokens, only what
    // they don't reproduce as overrides.
    return withAdvanced(theme.name, editableThemeSource(theme.scheme, theme.tokens));
  }
  if (copyOf && isBuiltinThemeId(copyOf)) {
    const builtin = BUILTIN_THEMES.find((t) => t.id === copyOf)!;
    return withAdvanced(`${builtin.label} (kopia)`, editableThemeSource(builtin.scheme, BUILTIN_THEME_VALUES[copyOf]));
  }
  return { name: "", source: templateSource("light"), advancedOpen: false };
}

// <input type="color"> + a hex field bound to the same value. optional: an
// empty hex field means "none" (null).
function ColorField({
  label,
  id,
  value,
  fallback,
  optional,
  onChange,
}: {
  label: string;
  id: string;
  value: string | null;
  fallback: string;
  optional?: boolean;
  onChange: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);

  return (
    <Field label={label} htmlFor={id}>
      <div className={styles.colorField}>
        <input
          type="color"
          className={styles.colorInput}
          aria-label={`${label}, färgväljare`}
          value={isHexColor(value) ? value.toLowerCase() : isHexColor(fallback) ? fallback.toLowerCase() : FALLBACK_HEX}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          id={id}
          className={styles.hex}
          value={draft}
          spellCheck={false}
          placeholder={optional ? "Som accent" : "#rrggbb"}
          onChange={(e) => {
            const next = e.target.value.trim();
            setDraft(e.target.value);
            if (isHexColor(next)) onChange(next.toLowerCase());
            else if (optional && next === "") onChange(null);
          }}
        />
      </div>
    </Field>
  );
}

function TokenRow({
  name,
  label,
  kind,
  value,
  changed,
  onSet,
  onReset,
}: {
  name: string;
  label: string;
  kind: "color" | "alpha" | "shadow";
  value: string;
  changed: boolean;
  onSet: (value: string) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const check = checkTokenValue(kind, draft);
  const invalid = !check.ok && draft !== value;

  return (
    <div className={styles.tokenRow}>
      <label className={styles.tokenLabel} htmlFor={`token-${name}`}>
        {label}
        <span className={styles.tokenName}>--{name}</span>
      </label>
      <div className={styles.tokenValue}>
        <Input
          id={`token-${name}`}
          className={styles.tokenInput}
          value={draft}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            const c = checkTokenValue(kind, e.target.value);
            if (c.ok) onSet(c.value);
          }}
        />
        {changed && (
          <>
            <span className={styles.changed}>Ändrad</span>
            <Button type="button" variant="ghost" size="small" onClick={onReset}>
              Återställ
            </Button>
          </>
        )}
        {invalid && !check.ok && <span className={styles.invalid}>{check.message}</span>}
      </div>
    </div>
  );
}

export function ThemeEditor({ theme, copyOf }: { theme: ThemeDetail | null; copyOf: string | null }) {
  const router = useRouter();
  const [initial] = useState(() => initialState(theme, copyOf));
  const [name, setName] = useState(initial.name);
  const [source, setSource] = useState<ThemeSource>(initial.source);
  const [advancedOpen, setAdvancedOpen] = useState(initial.advancedOpen);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<string[]>([]);

  const derived = useMemo(() => deriveTheme(source), [source]);
  const hasFailures = derived.unmet.length > 0;
  const canSave = !pending && name.trim().length > 0 && !hasFailures;

  const patch = (changes: Partial<ThemeSource>) => setSource((s) => ({ ...s, ...changes }));

  async function changeBase(next: ThemeScheme) {
    if (next === source.base) return;
    if (
      !isTemplateSource(source) &&
      !(await confirmDialog("Att byta utgångspunkt återställer grundfärgerna och tar bort alla ändringar under Avancerat. Fortsätta?", {
        confirmLabel: "Byt utgångspunkt",
      }))
    )
      return;
    setSource(templateSource(next));
  }

  function setOverride(tokenName: string, value: string) {
    setSource((s) => ({ ...s, overrides: { ...s.overrides, [tokenName]: value } }));
  }

  function resetOverride(tokenName: string) {
    setSource((s) => {
      const overrides = { ...s.overrides };
      delete overrides[tokenName];
      return { ...s, overrides };
    });
  }

  function adjust(fg: string) {
    const fixed = fixContrast(derived.tokens, fg);
    if (fixed) setOverride(fg, fixed);
  }

  async function save() {
    setPending(true);
    setError(null);
    setServerIssues([]);
    const body = JSON.stringify({ name: name.trim(), scheme: derived.scheme, tokens: derived.tokens, source });
    try {
      if (theme) {
        await apiFetch<ThemeDetail>(`/api/v1/themes/${theme.id}`, { method: "PATCH", body });
        router.refresh();
        setPending(false);
      } else {
        const created = await apiFetch<ThemeDetail>("/api/v1/themes", { method: "POST", body });
        router.replace(`/system/teman/${created.id}`);
        router.refresh();
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara temat"));
      const errBody = (err as { body?: { errors?: ThemeIssue[] } }).body;
      setServerIssues((errBody?.errors ?? []).map((e) => e.message));
      setPending(false);
    }
  }

  function exportFile() {
    const file = buildThemeFile({ name: name.trim() || "Tema", scheme: derived.scheme, tokens: derived.tokens, source });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tema-${file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, typeof THEME_TOKENS[number][]>();
    for (const token of THEME_TOKENS) {
      if (!byGroup.has(token.group)) {
        byGroup.set(token.group, []);
        order.push(token.group);
      }
      byGroup.get(token.group)!.push(token);
    }
    return order.map((group) => ({ group, tokens: byGroup.get(group)! }));
  }, []);

  const customStatus = source.status !== null;
  const base = source.base;
  const overrideCount = Object.keys(source.overrides).length;

  return (
    <div className={styles.layout}>
      <div className={styles.settings}>
        <Card maxWidth="none">
          <SectionHeading>Grundfärger</SectionHeading>
          <div className={styles.settings}>
            {overrideCount > 0 && (
              <FormHint>
                {overrideCount === 1
                  ? "1 färg är ändrad under Avancerat och följer inte grundfärgerna."
                  : `${overrideCount} färger är ändrade under Avancerat och följer inte grundfärgerna.`}
              </FormHint>
            )}
            <Field label="Namn" htmlFor="theme-name">
              <Input id="theme-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Utgå från">
              <SegmentedToggle value={base} options={SCHEME_OPTIONS} onChange={changeBase} ariaLabel="Utgå från" />
            </Field>
            <div className={styles.colorGrid}>
              <ColorField label="Bakgrund" id="theme-bg" value={source.bg} fallback={source.bg} onChange={(v) => v && patch({ bg: v })} />
              <ColorField
                label="Ytor"
                id="theme-surface"
                value={source.surface}
                fallback={source.surface}
                onChange={(v) => v && patch({ surface: v })}
              />
              <ColorField label="Text" id="theme-text" value={source.text} fallback={source.text} onChange={(v) => v && patch({ text: v })} />
              <ColorField
                label="Accentfärg"
                id="theme-accent"
                value={source.accent}
                fallback={source.accent}
                onChange={(v) => v && patch({ accent: v })}
              />
              <ColorField
                label="Rubrikfärg"
                id="theme-heading"
                value={source.heading}
                fallback={source.accent}
                optional
                onChange={(v) => patch({ heading: v })}
              />
            </div>
            <FormHint>Ytor används för kort och tabeller. Rubrikfärg är valfri — tom betyder accentfärgen som text.</FormHint>
            <Field label="Statusfärger">
              <SegmentedToggle
                value={customStatus ? "own" : "default"}
                options={[
                  { value: "default" as const, label: "Standard" },
                  { value: "own" as const, label: "Egna" },
                ]}
                onChange={(v) => patch({ status: v === "own" ? templateStatus(base) : null })}
                ariaLabel="Statusfärger"
              />
            </Field>
            {source.status && (
              <div className={styles.colorGrid}>
                {STATUS_FIELDS.map((f) => (
                  <ColorField
                    key={f.key}
                    label={f.label}
                    id={`theme-status-${f.key}`}
                    value={source.status![f.key]}
                    fallback={source.status![f.key]}
                    onChange={(v) => v && patch({ status: { ...source.status!, [f.key]: v } })}
                  />
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card maxWidth="none">
          <SectionHeading>Kontrast</SectionHeading>
          {hasFailures ? (
            <ul className={styles.failures}>
              {derived.unmet.map((f) => (
                <li key={`${f.fg}-${f.bg}`} className={styles.failure}>
                  <span>{formatContrastFailure(f)}</span>
                  <Button type="button" variant="secondary" size="small" onClick={() => adjust(f.fg)}>
                    Justera
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.ok}>Alla textfärger klarar kontrastkravet (4,5:1).</div>
          )}
        </Card>

        <Card maxWidth="none">
          <details open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
            <summary className={styles.summary}>Avancerat</summary>
            <div className={styles.advanced}>
              <FormHint>
                Här ställer du in varje färg för sig. En ändrad färg följer inte längre grundfärgerna — välj Återställ för att
                låta Nav räkna fram den igen.
              </FormHint>
              {advancedOpen &&
                groups.map(({ group, tokens }) => (
                  <div key={group} className={styles.advanced}>
                    <h4 className={styles.group}>{group}</h4>
                    {tokens.map((token) => (
                      <TokenRow
                        key={token.name}
                        name={token.name}
                        label={token.label}
                        kind={token.kind}
                        value={derived.tokens[token.name]!}
                        changed={token.name in source.overrides}
                        onSet={(v) => setOverride(token.name, v)}
                        onReset={() => resetOverride(token.name)}
                      />
                    ))}
                  </div>
                ))}
            </div>
          </details>
        </Card>

        {error && <FormError>{error}</FormError>}
        {serverIssues.length > 0 && (
          <FormError>
            <ul className={styles.issues}>
              {serverIssues.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </FormError>
        )}
        <FormActions>
          <Button type="button" onClick={save} disabled={!canSave}>
            Spara
          </Button>
          <Button type="button" variant="secondary" onClick={exportFile}>
            Exportera
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push("/system/teman")}>
            Tillbaka
          </Button>
        </FormActions>
        {hasFailures && <FormHint>Spara är avstängd så länge kontrastbrister finns — använd Justera.</FormHint>}
      </div>

      <div className={styles.previewColumn}>
        <ThemePreview scheme={derived.scheme} tokens={derived.tokens} />
      </div>
    </div>
  );
}
