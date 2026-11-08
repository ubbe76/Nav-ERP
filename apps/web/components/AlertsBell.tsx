"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { apiFetch } from "../lib/api";
import type { AlertsResponse } from "../lib/alerts";
import { useCanOpen } from "./PermissionsProvider";
import styles from "./AlertsBell.module.css";

// Aviseringar in the toolbar: the number of things to look at, red when any
// is red. Read after the page has rendered (never delays it) and again every
// few minutes while the tab is visible; a failed read shows no badge. Hidden
// for a user who may not open Aviseringar.
const REFRESH_MS = 5 * 60 * 1000;

export function AlertsBell() {
  const canOpen = useCanOpen();
  const allowed = canOpen("/aviseringar");
  const [summary, setSummary] = useState<{ count: number; red: boolean } | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    async function load() {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await apiFetch<AlertsResponse>("/api/v1/alerts");
        if (cancelled) return;
        const groups = res.groups.filter((g) => !g.error);
        setSummary({
          count: groups.reduce((sum, g) => sum + g.count, 0),
          red: groups.some((g) => g.count > 0 && g.items.some((item) => item.severity === "red")),
        });
      } catch {
        if (!cancelled) setSummary(null);
      }
    }
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [allowed]);

  if (!allowed) return null;
  const count = summary?.count ?? 0;
  const label = count > 0 ? `Aviseringar, ${count} att bevaka` : "Aviseringar";
  return (
    <Link href="/aviseringar" className={styles.bell} aria-label={label} title={label}>
      <Bell size={19} strokeWidth={1.8} aria-hidden="true" />
      {count > 0 && (
        <span className={styles.badge} data-tone={summary!.red ? "red" : "yellow"}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
