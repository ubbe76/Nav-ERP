import { describe, expect, it } from "vitest";
import { FALLBACK_THEME_BOOT, fetchThemeBoot, selectTheme, THEME_STORAGE_KEY, themeBootScript } from "../../web/lib/themes";
import type { ThemeBoot } from "../../web/lib/types";

// Egna teman, the web side of the boot (apps/web/lib/themes.ts): the one
// selection rule shared by the inline boot script and ThemeBootProvider, the
// script built from it, and fetchThemeBoot's fallback.

const IDS = ["light", "dark", "dracula", "egen-0000abcd"];

describe("selectTheme", () => {
  it("locked ⇒ the company default, whatever the user or the browser chose", () => {
    expect(selectTheme(IDS, "dracula", true, "dark", "egen-0000abcd")).toBe("dracula");
  });

  it("unlocked: the user's saved choice ⇒ the browser's stored choice ⇒ the default", () => {
    expect(selectTheme(IDS, "light", false, "egen-0000abcd", "dark")).toBe("egen-0000abcd");
    expect(selectTheme(IDS, "light", false, null, "dark")).toBe("dark");
    expect(selectTheme(IDS, "light", false, undefined, "dark")).toBe("dark");
    expect(selectTheme(IDS, "dracula", false, null, null)).toBe("dracula");
  });

  it("an id that isn't in the list (a deleted theme) falls through, finally to light", () => {
    expect(selectTheme(IDS, "light", false, "egen-deadbeef", "dark")).toBe("dark");
    expect(selectTheme(IDS, "dark", false, "egen-deadbeef", "egen-deadbeef")).toBe("dark");
    expect(selectTheme(IDS, "egen-deadbeef", false, null, null)).toBe("light");
    expect(selectTheme(IDS, "egen-deadbeef", true, "dark", "dark")).toBe("light");
  });

  it("a read-only account (GET /theme-boot answers userTheme null) gets the browser's choice", () => {
    expect(selectTheme(IDS, "light", false, null, "dracula")).toBe("dracula");
  });
});

describe("themeBootScript", () => {
  // Runs the inline script against a fake <html> and localStorage.
  function run(boot: Omit<ThemeBoot, "css">, stored: Record<string, string> | "throws") {
    let applied: string | null = null;
    const document = { documentElement: { setAttribute: (name: string, value: string) => name === "data-theme" && (applied = value) } };
    const localStorage = {
      getItem: (key: string) => {
        if (stored === "throws") throw new Error("SecurityError");
        return stored[key] ?? null;
      },
    };
    new Function("document", "localStorage", themeBootScript(boot))(document, localStorage);
    return applied;
  }

  const boot = { themes: FALLBACK_THEME_BOOT.themes, defaultTheme: "dark", locked: false };

  it("applies the same rule as selectTheme before first paint", () => {
    expect(run({ ...boot, userTheme: "dracula" }, { [THEME_STORAGE_KEY]: "light" })).toBe("dracula");
    expect(run({ ...boot, userTheme: null }, { [THEME_STORAGE_KEY]: "light" })).toBe("light");
    expect(run({ ...boot, locked: true, userTheme: "dracula" }, { [THEME_STORAGE_KEY]: "light" })).toBe("dark");
    expect(run(boot, { [THEME_STORAGE_KEY]: "egen-deadbeef" })).toBe("dark");
  });

  it("survives blocked storage", () => {
    expect(run(boot, "throws")).toBe("dark");
  });

  it("can't be closed by a theme name or id", () => {
    const script = themeBootScript({ ...boot, themes: [{ id: "</script><b>", label: "</script>", scheme: "light", builtIn: false }] });
    expect(script).not.toContain("</script");
  });
});

describe("fetchThemeBoot", () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("returns the API's answer", async () => {
    const body: ThemeBoot = { css: "", themes: FALLBACK_THEME_BOOT.themes, defaultTheme: "dracula", locked: true, userTheme: null };
    expect(await fetchThemeBoot("session=x", { fetchImpl: answer(200, body) })).toEqual(body);
  });

  it("falls back to the built-in themes on a non-200, a malformed body or a network error", async () => {
    expect(await fetchThemeBoot(undefined, { fetchImpl: answer(500, { error: "boom" }) })).toBe(FALLBACK_THEME_BOOT);
    expect(await fetchThemeBoot(undefined, { fetchImpl: answer(200, { themes: "nope" }) })).toBe(FALLBACK_THEME_BOOT);
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchThemeBoot(undefined, { fetchImpl: failing })).toBe(FALLBACK_THEME_BOOT);
  });

  it("falls back when the API doesn't answer in time", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    expect(await fetchThemeBoot(undefined, { fetchImpl: hanging, timeoutMs: 30 })).toBe(FALLBACK_THEME_BOOT);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
