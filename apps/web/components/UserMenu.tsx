"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "./ui/Button";
import { ThemeToggle } from "./ThemeToggle";
import { useThemeBoot } from "./ThemeBootProvider";
import { logout } from "../lib/api";
import styles from "./UserMenu.module.css";

// The user menu in the toolbar: who is logged in, the theme, the version
// (a link to the release notes) and Logga ut. Closes on Esc, on a click
// outside and when the page changes.
export function UserMenu({ userName, userRole }: { userName: string; userRole: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { boot } = useThemeBoot();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname]);

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
