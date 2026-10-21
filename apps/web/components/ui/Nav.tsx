"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Wordmark } from "./Wordmark";
import {
  BarChartIcon,
  BellIcon,
  CartIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CubeIcon,
  FactoryIcon,
  HelpIcon,
  HomeIcon,
  LayersIcon,
  LedgerIcon,
  MonitorIcon,
  TrendingUpIcon,
} from "./NavIcons";
import { canOpen } from "../../lib/pageAccess";
import type { Permission } from "../../lib/permissions";
import styles from "./Nav.module.css";

// The sidebar is flat: one entry per module, no submenus (TODO2 #14). Every
// function inside a module is reached from that module's own page, which
// renders a grid of grouped cards built from lib/moduleNav.ts — that file is
// the single source of truth for the structure, and this one deliberately
// knows nothing about it beyond the module list.

const NAV_ITEMS = [
  "Översikt",
  "Aviseringar",
  "Artiklar",
  "Inköp",
  "Försäljning",
  "Tillverkning",
  "Lager",
  "Ekonomi",
  "Rapporter",
  "System",
  "Hjälp",
] as const;

type NavItem = (typeof NAV_ITEMS)[number];

// Only items with a built page get a real link — the rest stay inert until
// their page exists, rather than linking to a 404.
const NAV_LINKS: Partial<Record<NavItem, string>> = {
  Översikt: "/",
  Aviseringar: "/aviseringar",
  Artiklar: "/artiklar",
  Inköp: "/inkop",
  Försäljning: "/forsaljning",
  Tillverkning: "/tillverkning",
  Lager: "/lager",
  Ekonomi: "/ekonomi",
  Rapporter: "/rapporter",
  System: "/system",
  Hjälp: "/hjalp",
};

const NAV_ICONS: Record<NavItem, ReactNode> = {
  Översikt: <HomeIcon />,
  Aviseringar: <BellIcon />,
  Artiklar: <CubeIcon />,
  Inköp: <CartIcon />,
  Försäljning: <TrendingUpIcon />,
  Tillverkning: <FactoryIcon />,
  Lager: <LayersIcon />,
  Ekonomi: <LedgerIcon />,
  Rapporter: <BarChartIcon />,
  System: <MonitorIcon />,
  Hjälp: <HelpIcon />,
};

// Same localStorage-after-mount pattern as ThemeToggle: the server always
// renders expanded, then the stored preference is applied on hydration.
const COLLAPSED_STORAGE_KEY = "nav-erp-sidebar-collapsed";

interface NavProps {
  active: NavItem;
  userName: string;
  userRole: string;
  role: "admin" | "supervisor" | "user";
  permissions: readonly Permission[];
}

export function Nav({ active, userName, userRole, role, permissions }: NavProps) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Width animates only after the stored state has painted, so restoring a
  // collapsed sidebar on page load snaps instead of sliding.
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true");
    const raf = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
  }

  const initials = userName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // Behörighetsgrupper: an entry shows when its hub page is openable
  // (pageAccess.ts — the same table the proxy guards pages with).
  const visibleItems = NAV_ITEMS.filter((item) => {
    const href = NAV_LINKS[item];
    return href !== undefined && canOpen({ role, permissions }, href);
  });

  return (
    <>
      <button type="button" className={styles.menuButton} onClick={() => setOpen(true)} aria-label="Öppna meny">
        <span className={styles.menuBar} />
        <span className={styles.menuBar} />
        <span className={styles.menuBar} />
      </button>

      {open && <div className={styles.backdrop} onClick={() => setOpen(false)} />}

      <nav className={styles.sidebar} data-open={open} data-collapsed={collapsed} data-animated={animated}>
        <div className={styles.header}>
          <span className={styles.wordmarkFull}>
            <Wordmark />
          </span>
          <span className={styles.wordmarkCompact}>
            <Wordmark symbolOnly height={26} />
          </span>
          <button
            type="button"
            className={styles.collapseButton}
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Visa menyn" : "Fäll ihop menyn"}
          >
            {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </button>
        </div>

        <ul className={styles.list}>
          {visibleItems.map((item) => {
            const href = NAV_LINKS[item];
            return (
              <li key={item}>
                {href ? (
                  <Link
                    href={href}
                    className={styles.item}
                    data-active={item === active}
                    title={collapsed ? item : undefined}
                    onClick={() => setOpen(false)}
                  >
                    <span className={styles.icon}>{NAV_ICONS[item]}</span>
                    <span className={styles.label}>{item}</span>
                  </Link>
                ) : (
                  <span className={styles.item} data-disabled="true" title={collapsed ? item : undefined}>
                    <span className={styles.icon}>{NAV_ICONS[item]}</span>
                    <span className={styles.label}>{item}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <div className={styles.footer}>
          <div className={styles.avatar} title={collapsed ? `${userName} · ${userRole}` : undefined}>
            {initials}
          </div>
          <div className={styles.userText}>
            <div className={styles.userName}>{userName}</div>
            <div className={styles.userRole}>{userRole}</div>
            <a
              className={styles.version}
              href="https://naverp.se/versioner/"
              target="_blank"
              rel="noopener noreferrer"
              title="Vad är nytt i versionerna"
            >
              Version {process.env.NEXT_PUBLIC_APP_VERSION}
            </a>
          </div>
        </div>
      </nav>
    </>
  );
}
