"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "./ui/Button";
import { ThemeToggle } from "./ThemeToggle";
import { useUserPrefs } from "./UserPrefsProvider";
import { DENSITY_LABELS, TABLE_DENSITIES } from "../lib/listColumns";
import segmentedStyles from "./ThemeToggle.module.css";
import { useThemeBoot } from "./ThemeBootProvider";
import { logout } from "../lib/api";
import { INSTALL_PROMPT_EVENT, installOffer, type InstallOffer } from "../lib/installApp";
import styles from "./UserMenu.module.css";

// The user menu in the toolbar: who is logged in, the theme, Täthet, Installera Nav
// (when the browser can install it), the version (a link to the release
// notes) and Logga ut. Closes on Esc, on a click outside and when the page
// changes.
export function UserMenu({ userName, userRole }: { userName: string; userRole: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { boot } = useThemeBoot();
  const { density, setDensity, documentTabs, setDocumentTabs } = useUserPrefs();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname]);

  // Installera som app: re-read whenever the browser's offer comes or goes
  // (the head script in app/layout.tsx keeps it on window).
  const [install, setInstall] = useState<InstallOffer>(null);
  useEffect(() => {
    function read() {
      setInstall(
        installOffer({
          userAgent: navigator.userAgent,
          maxTouchPoints: navigator.maxTouchPoints ?? 0,
          standalone:
            window.matchMedia?.("(display-mode: standalone)").matches === true ||
            (navigator as Navigator & { standalone?: boolean }).standalone === true,
          secureContext: window.isSecureContext,
          hasPrompt: !!window.__navInstallPrompt,
        })
      );
    }
    read();
    document.addEventListener(INSTALL_PROMPT_EVENT, read);
    return () => document.removeEventListener(INSTALL_PROMPT_EVENT, read);
  }, []);

  async function handleInstall() {
    const prompt = window.__navInstallPrompt;
    if (!prompt) return;
    setOpen(false);
    // The offer can be used once; the browser fires a new one if the user
    // says no and it may ask again later.
    window.__navInstallPrompt = null;
    await prompt.prompt().catch(() => {});
    document.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleLogout() {
    await logout();
    router.push("/login");
    router.refresh();
  }

  const initials = userName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Användarmeny för ${userName}`}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initials}
        </span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.panel}>
          <div className={styles.who}>
            <span className={styles.name}>{userName}</span>
            <span className={styles.role}>{userRole}</span>
          </div>
          {/* An administrator may lock the theme (System → Teman). */}
          {!boot.locked && (
            <div className={styles.section}>
              <span className={styles.label}>Tema</span>
              <ThemeToggle />
            </div>
          )}
          {/* Täthet (Nav som program, punkt 6): the row height of the tables. */}
          <div className={styles.section}>
            <span className={styles.label}>Täthet</span>
            <div className={segmentedStyles.segmented} role="radiogroup" aria-label="Täthet">
              {TABLE_DENSITIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={density === d}
                  data-active={density === d}
                  onClick={() => setDensity(d)}
                >
                  {DENSITY_LABELS[d]}
                </button>
              ))}
            </div>
          </div>
          {/* Flikar (punkt 5): documents as tabs on a wide screen. */}
          <div className={styles.section}>
            <span className={styles.label}>Dokument i flikar</span>
            <div className={segmentedStyles.segmented} role="radiogroup" aria-label="Dokument i flikar">
              {[true, false].map((on) => (
                <button
                  key={String(on)}
                  type="button"
                  role="radio"
                  aria-checked={documentTabs === on}
                  data-active={documentTabs === on}
                  onClick={() => setDocumentTabs(on)}
                >
                  {on ? "På" : "Av"}
                </button>
              ))}
            </div>
          </div>
          {install && (
            <div className={styles.section}>
              {install.kind === "prompt" ? (
                <Button variant="secondary" size="small" onClick={handleInstall}>
                  Installera Nav
                </Button>
              ) : (
                <span className={styles.hint}>{install.text}</span>
              )}
            </div>
          )}
          <div className={`${styles.section} ${styles.row}`}>
            <a
              className={styles.version}
              href="https://naverp.se/versioner/"
              target="_blank"
              rel="noopener noreferrer"
              title="Vad är nytt i versionerna"
            >
              Version {process.env.NEXT_PUBLIC_APP_VERSION}
            </a>
            <Button variant="secondary" size="small" onClick={handleLogout}>
              Logga ut
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
