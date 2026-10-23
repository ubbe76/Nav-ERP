import type { ThemeContrastFailure, ThemeIssue } from "@navet/shared";

// Egna teman. A leaf so the system service (PATCH /settings defaultTheme)
// and the auth module's user settings (PATCH /me/settings theme) can throw
// the same "no such theme" error as the theme service. Codes are derived from
// the class names (error-body.ts): theme-not-found, unknown-theme,
// theme-invalid, theme-name-taken, theme-is-default, theme-limit.

export class ThemeNotFoundError extends Error {
  constructor(id: string) {
    super(`Theme ${id} not found`);
    this.name = "ThemeNotFoundError";
  }
}

// A setting names a theme that doesn't exist (400 — the request is wrong).
export class UnknownThemeError extends Error {
  constructor(id: string) {
    super(`Det finns inget tema "${id.slice(0, 40)}".`);
    this.name = "UnknownThemeError";
  }
}

// validateTheme said no: the body carries the findings.
export class ThemeInvalidError extends Error {
  constructor(
    readonly errors: ThemeIssue[],
    readonly contrastFailures: ThemeContrastFailure[]
  ) {
    super(
      errors.length > 0
        ? "Temat innehåller fel och kan inte sparas."
        : "Temat klarar inte kontrastkravet (4,5:1) och kan inte sparas."
    );
    this.name = "ThemeInvalidError";
  }
}

export class ThemeNameTakenError extends Error {
  constructor(name: string) {
    super(`Det finns redan ett tema som heter ${name}.`);
    this.name = "ThemeNameTakenError";
  }
}

export class ThemeIsDefaultError extends Error {
  constructor(name: string) {
    super(`${name} är företagets förvalda tema — välj ett annat förval innan det tas bort.`);
    this.name = "ThemeIsDefaultError";
  }
}

export class ThemeLimitError extends Error {
  constructor(max: number) {
    super(`Det får finnas högst ${max} egna teman.`);
    this.name = "ThemeLimitError";
  }
}
