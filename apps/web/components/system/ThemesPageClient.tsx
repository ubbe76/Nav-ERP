"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { API_URL, apiFetch } from "../../lib/api";
import { confirmDelete } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { parseThemeFile } from "../../lib/themeCore";
import type { SystemSettings, ThemeListRow, ThemeOrigin, ThemeValidationResult } from "../../lib/types";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Checkbox, Field, Select } from "../ui/Field";
import { FormError } from "../ui/Form";
import { Table } from "../ui/Table";
import { UploadThemeDialog } from "./UploadThemeDialog";
import styles from "./ThemesPageClient.module.css";

const ORIGIN_LABELS: Record<ThemeOrigin, string> = {
  builtin: "Inbyggt",
  uploaded: "Uppladdat",
  editor: "Redigerare",
};

const linkButton = `${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.small}`;

export function ThemesPageClient({
  initialThemes,
  defaultTheme,
  themeChoiceLocked,
}: {
  initialThemes: ThemeListRow[];
  defaultTheme: string;
  themeChoiceLocked: boolean;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [themes, setThemes] = useState(initialThemes);
  const [defaultKey, setDefaultKey] = useState(defaultTheme);
  const [locked, setLocked] = useState(themeChoiceLocked);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ result: ThemeValidationResult; input: unknown; fileName: string } | null>(null);

  async function reload() {
    setThemes(await apiFetch<ThemeListRow[]>("/api/v1/themes"));
    // The picker and the boot CSS come from the root layout.
    router.refresh();
  }

  async function saveSettings(patch: Partial<Pick<SystemSettings, "defaultTheme" | "themeChoiceLocked">>) {
    setError(null);
    try {
      await apiFetch("/api/v1/settings", { method: "PATCH", body: JSON.stringify(patch) });
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara inställningen"));
      // Back to what the server has.
      try {
        const current = await apiFetch<SystemSettings>("/api/v1/settings");
        setDefaultKey(current.defaultTheme);
        setLocked(current.themeChoiceLocked);
      } catch {
        // Keep what the controls show.
      }
    }
  }

  async function handleFile(file: File) {
    setError(null);
    const text = await file.text();
    const parsed = parseThemeFile(text);
    if (!parsed.ok) {
      setError(parsed.errors.map((e) => e.message).join(" "));
      return;
    }
    try {
      const result = await apiFetch<ThemeValidationResult>("/api/v1/themes/validate", {
        method: "POST",
        body: JSON.stringify(parsed.input),
      });
      setUpload({ result, input: parsed.input, fileName: file.name });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte läsa temafilen"));
    }
  }

  async function handleDelete(theme: ThemeListRow) {
    if (!(await confirmDelete(`Ta bort temat ${theme.name}? Användare som valt det får företagets förvalda tema.`))) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/themes/${theme.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort temat"));
    }
  }

  return (
    <>
      <div className={styles.settings}>
        <Field label="Förvalt tema för företaget" htmlFor="default-theme">
          <Select
            id="default-theme"
            value={defaultKey}
            onChange={(e) => {
              setDefaultKey(e.target.value);
              void saveSettings({ defaultTheme: e.target.value });
            }}
          >
            {themes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <label className={styles.check}>
          <Checkbox
            checked={locked}
            onChange={(e) => {
              setLocked(e.target.checked);
              void saveSettings({ themeChoiceLocked: e.target.checked });
            }}
          />
          Lås temat för alla användare
        </label>
      </div>

      <div className={styles.toolbar}>
        <Button type="button" onClick={() => fileInput.current?.click()}>
          Ladda upp tema…
        </Button>
        <Link href="/system/teman/ny" className={`${buttonStyles.button} ${buttonStyles.secondary}`}>
          Nytt tema
        </Link>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className={styles.hidden}
          aria-label="Temafil"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>

      {error && <FormError>{error}</FormError>}

      <Table
        columns={[
          { key: "name", label: "Namn", width: "minmax(180px, 2fr)" },
          { key: "scheme", label: "Typ", width: "80px" },
          { key: "origin", label: "Skapat", width: "110px" },
          { key: "usedBy", label: "Används av", width: "120px" },
          { key: "actions", label: "", width: "minmax(240px, 1.5fr)" },
        ]}
        rows={themes}
        renderCell={(theme, key) => {
          switch (key) {
            case "name":
              return (
                <>
                  <span className={styles.name}>{theme.name}</span>
                  <span className={styles.marks}>
                    {theme.isDefault && <span className={styles.mark}>Förval</span>}
                    {theme.needsReview && <span className={`${styles.mark} ${styles.markReview}`}>Behöver ses över</span>}
                  </span>
                </>
              );
            case "scheme":
              return theme.scheme === "dark" ? "Mörkt" : "Ljust";
            case "origin":
              return ORIGIN_LABELS[theme.origin];
            case "usedBy":
              return `${theme.usedBy} användare`;
            default: {
              const exportHref = theme.builtIn
                ? `${API_URL}/api/v1/themes/builtin/${theme.id}/export`
                : `${API_URL}/api/v1/themes/${theme.id}/export`;
              return (
                <div className={styles.actions}>
                  {theme.builtIn ? (
                    <Link href={`/system/teman/ny?kopia=${theme.id}`} className={linkButton}>
                      Skapa kopia
                    </Link>
                  ) : (
                    <Link href={`/system/teman/${theme.id}`} className={linkButton}>
                      Redigera
                    </Link>
                  )}
                  <a href={exportHref} download className={linkButton}>
                    Exportera
                  </a>
                  {!theme.builtIn && (
                    <Button type="button" variant="ghost" size="small" onClick={() => handleDelete(theme)}>
                      Ta bort
                    </Button>
                  )}
                </div>
              );
            }
          }
        }}
      />

      <UploadThemeDialog
        upload={upload}
        onClose={() => setUpload(null)}
        onInstalled={async () => {
          setUpload(null);
          await reload();
        }}
      />
    </>
  );
}
