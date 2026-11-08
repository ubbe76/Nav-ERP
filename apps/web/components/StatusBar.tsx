"use client";

import { isEmbedded } from "../lib/documentTabs";
import { useEffect, useState } from "react";
import Link from "next/link";
import { API_URL } from "../lib/api";
import styles from "./StatusBar.module.css";

type State = "online" | "expired" | "offline";

const LABELS: Record<State, string> = {
  online: "Ansluten",
  expired: "Sessionen har gått ut",
  offline: "Ingen kontakt med servern",
};

// How often the bar asks the server whether it is there and the session
// still valid — GET /auth/me, the same read the pages start with.
const CHECK_MS = 60 * 1000;

// The status bar at the bottom (Nav som program, punkt 1): whether the server
// answers and the session is valid, who is logged in, and the version.
export function StatusBar({ userName, userRole }: { userName: string; userRole: string }) {
  const [state, setState] = useState<State>("online");

  useEffect(() => {
    // Inside a document tab (punkt 5) the bar is hidden: the frame checks.
    if (isEmbedded()) return;
    let cancelled = false;
    async function check() {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch(`${API_URL}/api/v1/auth/me`, { credentials: "include", cache: "no-store" });
        if (!cancelled) setState(res.ok ? "online" : res.status === 401 ? "expired" : "offline");
      } catch {
        if (!cancelled) setState("offline");
      }
    }
    const timer = window.setInterval(check, CHECK_MS);
    const onChange = () => void check();
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, []);

  return (
    <footer className={styles.bar} data-app-chrome="">
      <span className={styles.state} data-state={state} role="status">
        <span className={styles.dot} aria-hidden="true" />
        {LABELS[state]}
        {state === "expired" && (
          <>
            {" · "}
            <Link href="/login" className={styles.link}>
              Logga in
            </Link>
          </>
        )}
      </span>
      <span>
        {userName} · {userRole}
      </span>
      <a className={styles.version} href="https://naverp.se/versioner/" target="_blank" rel="noopener noreferrer">
        Version {process.env.NEXT_PUBLIC_APP_VERSION}
      </a>
    </footer>
  );
}
