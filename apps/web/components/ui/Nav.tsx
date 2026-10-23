"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Star } from "lucide-react";
import { Wordmark } from "./Wordmark";
import { Modal } from "./Modal";
import { useFavorites } from "../FavoritesProvider";
import { FavoritesEditor } from "../FavoritesEditor";
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
  UsersIcon,
} from "./NavIcons";
import { canOpen } from "../../lib/pageAccess";
import { favoriteHref } from "../../lib/favorites";
import { hubIconFor } from "../../lib/hubIcons";
import type { Permission } from "../../lib/permissions";
import styles from "./Nav.module.css";

// The sidebar is flat: one entry per module, no submenus (TODO2 #14). Every
// function inside a module is reached from that module's own page, which
// renders a grid of grouped cards built from lib/moduleNav.ts — that file is
// the single source of truth for the structure, and this one deliberately
// knows nothing about it beyond the module list. Above the modules sits the
// user's own Favoriter group (FavoritesProvider), any page inside Nav.

const NAV_ITEMS = [
  "Översikt",
  "Aviseringar",
  "Artiklar",
  "Inköp",
  "Försäljning",
  "Tillverkning",
  "Lager",
  "Personal & lön",
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
  "Personal & lön": "/personal",
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
  "Personal & lön": <UsersIcon />,
  Ekonomi: <LedgerIcon />,
  Rapporter: <BarChartIcon />,
  System: <MonitorIcon />,
  Hjälp: <HelpIcon />,
};

// A favourite's icon: the module's own for a module page, else the hub row's
// (or the row it lies under — a card under its register), else a star.
function favoriteIcon(href: string): ReactNode {
  const path = href.split("?")[0];
  const moduleItem = NAV_ITEMS.find((item) => NAV_LINKS[item] === path);
  if (moduleItem) return NAV_ICONS[moduleItem];
  const Icon = hubIconFor(href) ?? Star;
  return <Icon size={18} strokeWidth={1.7} aria-hidden="true" />;
}

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
  const [editingFavorites, setEditingFavorites] = useState(false);
  const { favorites } = useFavorites();
  const currentHref = favoriteHref(usePathname(), useSearchParams());
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
  // A favourite the user may no longer open is hidden, not removed: it comes
  // back if the permission does.
  const visibleFavorites = favorites?.filter((f) => canOpen({ role, permissions }, f.href)) ?? null;

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

        {visibleFavorites !== null && (
          <div className={styles.favorites} aria-label="Favoriter" role="group">
            <div className={styles.groupHeader}>
              <span>Favoriter</span>
              {favorites!.length > 0 && (
                <button type="button" className={styles.groupAction} onClick={() => setEditingFavorites(true)}>
                  Ändra
                </button>
              )}
            </div>
            {visibleFavorites.length === 0 ? (
              favorites!.length === 0 && (
                <p className={styles.favoritesHint}>
                  Lägg till genvägar med stjärnan vid en funktion eller med <strong>Favorit</strong> uppe till höger.
                </p>
              )
            ) : (
              <ul className={styles.list}>
                {visibleFavorites.map((favorite) => (
                  <li key={favorite.href}>
                    <Link
                      href={favorite.href}
                      className={styles.item}
                      aria-current={favorite.href === currentHref ? "page" : undefined}
                      // Always: a long name is cut with an ellipsis.
                      title={favorite.title}
                      onClick={() => setOpen(false)}
                    >
                      <span className={styles.icon}>{favoriteIcon(favorite.href)}</span>
                      <span className={styles.label}>{favorite.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

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

      <Modal open={editingFavorites} onClose={() => setEditingFavorites(false)} title="Ändra favoriter">
        <FavoritesEditor onDone={() => setEditingFavorites(false)} />
      </Modal>
    </>
  );
}
