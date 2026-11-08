import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INSTALL_PROMPT_EVENT,
  installOffer,
  installPromptBootScript,
  SAFARI_IOS_HINT,
  SAFARI_MAC_HINT,
  type InstallEnvironment,
} from "../../web/lib/installApp";

// Installera som app (Nav som program, punkt 8): when the user menu offers
// Installera Nav, a Safari instruction or nothing.
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const EDGE = `${CHROME} Edg/141.0.0.0`;
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
const SAFARI_MAC_16 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";
const CHROME_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1";

function env(userAgent: string, overrides: Partial<InstallEnvironment> = {}): InstallEnvironment {
  return { userAgent, maxTouchPoints: 0, standalone: false, secureContext: true, hasPrompt: false, ...overrides };
}

describe("installOffer", () => {
  it("offers the button when the browser has made its offer", () => {
    expect(installOffer(env(CHROME, { hasPrompt: true }))).toEqual({ kind: "prompt" });
    expect(installOffer(env(EDGE, { hasPrompt: true }))).toEqual({ kind: "prompt" });
  });

  it("offers nothing in Chromium without the browser's offer, or in Firefox", () => {
    expect(installOffer(env(CHROME))).toBeNull();
    expect(installOffer(env(EDGE))).toBeNull();
    expect(installOffer(env(FIREFOX))).toBeNull();
    expect(installOffer(env(CHROME_IPHONE))).toBeNull();
  });

  it("explains Safari's own command on a Mac (Safari 17+) and on iPhone/iPad", () => {
    expect(installOffer(env(SAFARI_MAC))).toEqual({ kind: "hint", text: SAFARI_MAC_HINT });
    expect(installOffer(env(SAFARI_MAC_16))).toBeNull();
    expect(installOffer(env(SAFARI_IPHONE))).toEqual({ kind: "hint", text: SAFARI_IOS_HINT });
    // iPadOS says Macintosh; the touch screen gives it away.
    expect(installOffer(env(SAFARI_MAC, { maxTouchPoints: 5 }))).toEqual({ kind: "hint", text: SAFARI_IOS_HINT });
  });

  it("offers nothing in the installed app or without HTTPS", () => {
    expect(installOffer(env(CHROME, { hasPrompt: true, standalone: true }))).toBeNull();
    expect(installOffer(env(SAFARI_MAC, { standalone: true }))).toBeNull();
    expect(installOffer(env(SAFARI_MAC, { secureContext: false }))).toBeNull();
  });
});

describe("installPromptBootScript", () => {
  it("keeps the offer on window, stops the browser's own banner and tells the menu", () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const win: Record<string, unknown> = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn;
      },
    };
    const dispatched: string[] = [];
    const doc = { dispatchEvent: (e: { type: string }) => dispatched.push(e.type) };
    class FakeEvent {
      constructor(public type: string) {}
    }
    new Function("window", "document", "Event", installPromptBootScript)(win, doc, FakeEvent);
    expect(win.__navInstallPrompt).toBeNull();

    let prevented = false;
    const offer = { preventDefault: () => (prevented = true) };
    listeners.beforeinstallprompt!(offer);
    expect(prevented).toBe(true);
    expect(win.__navInstallPrompt).toBe(offer);
    expect(dispatched).toEqual([INSTALL_PROMPT_EVENT]);

    listeners.appinstalled!({});
    expect(win.__navInstallPrompt).toBeNull();
    expect(dispatched).toEqual([INSTALL_PROMPT_EVENT, INSTALL_PROMPT_EVENT]);
  });
});

describe("the manifest", () => {
  it("opens Översikten and keeps its identity across later manifest changes", () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../web/app/manifest.webmanifest", import.meta.url)), "utf8"));
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
    // Chromium installs only with a 192 and a 512 icon.
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });
});
