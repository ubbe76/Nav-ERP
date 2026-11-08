// Installera som app (Nav som program, punkt 8). Nav stays an ordinary web
// page; installing it is optional. Chromium (Chrome, Edge, Chromium on
// Linux) offers the installation through the beforeinstallprompt event —
// only on HTTPS and only when the manifest qualifies — so the user menu's
// Installera Nav shows exactly when the browser would install. Safari has no
// such event: there the menu explains the browser's own command instead.
// Firefox on the computer cannot install and gets nothing.

// The browser's offer. Not in TypeScript's DOM types (Chromium only).
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    __navInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

// The event fires once per page load, often before React has hydrated, so
// an inline script in <head> (app/layout.tsx) catches it and keeps it on
// window; the menu reads it from there. preventDefault stops Chrome on
// Android from showing its own banner — the menu offers the installation.
export const INSTALL_PROMPT_EVENT = "nav-install-prompt";
export const installPromptBootScript = `(function(){window.__navInstallPrompt=null;window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__navInstallPrompt=e;document.dispatchEvent(new Event("${INSTALL_PROMPT_EVENT}"))});window.addEventListener("appinstalled",function(){window.__navInstallPrompt=null;document.dispatchEvent(new Event("${INSTALL_PROMPT_EVENT}"))})})();`;

// What the user menu offers.
export type InstallOffer =
  | { kind: "prompt" } // Chromium: the Installera Nav button
  | { kind: "hint"; text: string } // Safari: the browser's own command
  | null; // installed already, Firefox, or not on HTTPS

export interface InstallEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  // Running as the installed app (display-mode: standalone, or iOS's
  // navigator.standalone).
  standalone: boolean;
  secureContext: boolean;
  hasPrompt: boolean;
}

export const SAFARI_MAC_HINT = "Installera Nav: välj Arkiv → Lägg till i Dock i Safari.";
export const SAFARI_IOS_HINT = "Installera Nav: tryck på Dela och välj Lägg till på hemskärmen.";

// Pure, so the rule is tested without a browser (web-install-app.test.ts).
export function installOffer(env: InstallEnvironment): InstallOffer {
  if (env.standalone || !env.secureContext) return null;
  if (env.hasPrompt) return { kind: "prompt" };
  const ua = env.userAgent;
  // Chrome, Edge, Firefox and the iOS shells all carry "Safari" too.
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|EdgiOS|FxiOS|Firefox|OPR|OPiOS/.test(ua);
  if (!safari) return null;
  // iPadOS reports itself as a Mac; the touch screen gives it away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  if (ios) return { kind: "hint", text: SAFARI_IOS_HINT };
  // Lägg till i Dock came with Safari 17 (macOS Sonoma).
  const version = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
  if (/Macintosh/.test(ua) && version >= 17) return { kind: "hint", text: SAFARI_MAC_HINT };
  return null;
}
