"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "./ui/Button";
import Link from "next/link";
import { AppearanceControls } from "./settings/AppearanceControls";
import { logout } from "../lib/api";
import { clearBrowserTraces } from "../lib/commandPalette";
import { INSTALL_PROMPT_EVENT, installOffer, type InstallOffer } from "../lib/installApp";
import styles from "./UserMenu.module.css";

// The user menu in the toolbar: who is logged in, the theme, Täthet, Dokument
// i flikar, Favoriter (the sidebar and/or Översikten) — AppearanceControls,
// also on Mina inställningar —, a link to Mina inställningar, Installera Nav
// (when the browser can install it), the version (a link to the release
// notes) and Logga ut. Closes on Esc, on a click outside and when the page
// changes.
export function UserMenu({ userName, userRole }: { userName: string; userRole: string }) {
  const router = useRouter();
  const pathname = usePathname();
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
    clearBrowserTraces();
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
          <AppearanceControls classes={{ section: styles.section, label: styles.label }} />
          <div className={styles.section}>
            <Link href="/mina-installningar" className={styles.settingsLink}>
              Mina inställningar
            </Link>
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
