// Egna teman: the system settings (Förvalt tema för företaget, Lås temat för
// alla användare) and the user setting key. A leaf like quote-settings.ts so
// the system service, the theme service, the theme repository and the auth
// module's user settings read the same keys and defaults.
export const DEFAULT_THEME_KEY = "default_theme";
export const THEME_CHOICE_LOCKED_KEY = "theme_choice_locked";
export const FALLBACK_DEFAULT_THEME = "light";
// user_settings key — the user's own choice; absent = the company default.
export const USER_THEME_SETTING_KEY = "theme";

const THEME_ID = /^[a-z0-9-]{1,40}$/;

// A stored id that isn't even well-formed falls back to the built-in light
// theme. Whether a custom key still exists is the theme service's concern
// (a deleted theme can never be the default — deletion refuses it).
export function decodeDefaultTheme(raw: string | null | undefined): string {
  return raw && THEME_ID.test(raw) ? raw : FALLBACK_DEFAULT_THEME;
}

export function decodeUserTheme(raw: string | null | undefined): string | null {
  return raw && THEME_ID.test(raw) ? raw : null;
}
