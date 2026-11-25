"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronsLeft, Star } from "lucide-react";
import { Modal } from "./Modal";
import { useFavorites } from "../FavoritesProvider";
import { FavoritesEditor } from "../FavoritesEditor";
import { useUserPrefs } from "../UserPrefsProvider";
import {
  BarChartIcon,
  BellIcon,
  CartIcon,
  CubeIcon,
  FactoryIcon,
  HelpIcon,
  HomeIcon,
  LayersIcon,
  LedgerIcon,
  MonitorIcon,
  QualityIcon,
  TrendingUpIcon,
  UsersIcon,
} from "./NavIcons";
import { canOpen } from "../../lib/pageAccess";
import { favoriteHref } from "../../lib/favorites";
import { hubIconFor } from "../../lib/hubIcons";
import { functionOf } from "../../lib/navFunctions";
import type { NavPanelModule } from "../../lib/navPanel";
import type { Permission } from "../../lib/permissions";
import styles from "./Nav.module.css";

// Programramen (2026-11-20, the user's own sketch): an icon rail with one
// entry per module, and beside it the module panel — the shown module's
// functions, grouped as on its module page (lib/moduleNav.ts, read for the
// user by lib/navPanel.ts), with the module page itself first as Översikt.
// A click on a module's icon shows its panel without leaving the page; a
// click on the icon of the module already shown folds the panel away (the
// user's choice, saved as navPanelCollapsed). Översikt, Aviseringar and
// Hjälp are pages of their own. The user's Favoriter are a panel of their
// own (the star) when they show in the menu. On a narrow screen rail and
// panel are the drawer behind the hamburger. Namn under ikonerna (the
// user's setting navLabels, 2026-11-25) shows each entry's name under its
// icon in one of three sizes; off, the name is the tooltip.

type RailPage = "Översikt" | "Aviseringar" | "Hjälp";

const PAGE_LINKS: Record<RailPage, string> = {
  Översikt: "/",
  Aviseringar: "/aviseringar",
  Hjälp: "/hjalp",
};

const MODULE_ICONS: Record<string, ReactNode> = {
  "/": <HomeIcon />,
  "/aviseringar": <BellIcon />,
  "/hjalp": <HelpIcon />,
  "/artiklar": <CubeIcon />,
  "/inkop": <CartIcon />,
  "/forsaljning": <TrendingUpIcon />,
  "/tillverkning": <FactoryIcon />,
  "/lager": <LayersIcon />,
  "/personal": <UsersIcon />,
  "/kvalitet": <QualityIcon />,
  "/ekonomi": <LedgerIcon />,
  "/rapporter": <BarChartIcon />,
  "/system": <MonitorIcon />,
};

// The rail's order: Översikt and the favourites first, then the modules,
// Aviseringar before System, Hjälp last.
const RAIL_ORDER = [
  "/",
  "favoriter",
  "/artiklar",
  "/inkop",
  "/forsaljning",
  "/tillverkning",
  "/lager",
  "/personal",
  "/kvalitet",
  "/ekonomi",
  "/rapporter",
  "/aviseringar",
  "/system",
  "/hjalp",
] as const;

const FAVORITES = "favoriter";

// A favourite's icon (and a tab's): the module's own for a module page, else
// the hub row's (or the row it lies under — a card under its register), else
// a star. Also Översikten's Favoriter card, which sizes it down with CSS.
export function favoriteIcon(href: string): ReactNode {
  const path = href.split("?")[0]!;
  if (MODULE_ICONS[path]) return MODULE_ICONS[path];
  const Icon = hubIconFor(href) ?? Star;
  return <Icon size={18} strokeWidth={1.7} aria-hidden="true" />;
}

function pathOf(href: string): string {
  return href.split("?")[0]!;
}

interface NavProps {
  role: "admin" | "supervisor" | "user";
  permissions: readonly Permission[];
  modules: NavPanelModule[];
}

export function Nav({ role, permissions, modules }: NavProps) {
  const [open, setOpen] = useState(false);
  const [editingFavorites, setEditingFavorites] = useState(false);
  const { favorites, inSidebar } = useFavorites();
  const { navPanelCollapsed: collapsed, setNavPanelCollapsed, navLabels } = useUserPrefs();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentHref = favoriteHref(pathname, searchParams);
  const currentFn = functionOf(pathname);

  const user = { role, permissions };
  const showFavorites = favorites !== null && inSidebar;
  // A favourite the user may no longer open is hidden, not removed: it comes
  // back if the permission does.
  const visibleFavorites = favorites?.filter((f) => canOpen(user, f.href)) ?? [];
  const moduleHrefs = modules.map((m) => m.href);

  // The module the page belongs to (the one already shown when the function
  // sits under several, like Grunddata); null for a page outside them.
  const shownRef = useRef<string | null>(null);
  const pageModules = modules
    .filter((m) => m.href === currentFn || m.sections.some((s) => s.items.some((i) => pathOf(i.href) === currentFn)))
    .map((m) => m.href);
  const pageModule = pageModules.includes(shownRef.current ?? "") ? shownRef.current : (pageModules[0] ?? null);

  // The panel shows the page's module, or the one the user picked in the
  // rail since the page changed, or the one shown before (Översikt,
  // Aviseringar …), else the favourites or the first module.
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [pathname]);
  const shown = chosen ?? pageModule ?? shownRef.current ?? (showFavorites ? FAVORITES : (moduleHrefs[0] ?? null));
  shownRef.current = shown;

  function pick(key: string) {
    // The drawer (narrow screen) always shows its panel.
    if (open) {
      setChosen(key);
      return;
    }
    if (key === shown && !collapsed) {
      setNavPanelCollapsed(true);
      return;
    }
    setChosen(key);
    if (collapsed) setNavPanelCollapsed(false);
  }

  const shownModule = modules.find((m) => m.href === shown) ?? null;
  const panelOpen = (open || !collapsed) && (shown === FAVORITES ? showFavorites : shownModule !== null);

  function isCurrent(href: string): boolean {
    if (href.includes("?")) return currentHref === href;
    return pathOf(href) === currentFn;
  }

  function railEntry(key: (typeof RAIL_ORDER)[number]): ReactNode {
    if (key === FAVORITES) {
      if (!showFavorites) return null;
      return (
        <li key={key}>
          <button
            type="button"
            className={styles.railItem}
            data-shown={shown === FAVORITES || undefined}
            aria-pressed={shown === FAVORITES && panelOpen}
            title="Favoriter"
            onClick={() => pick(FAVORITES)}
          >
            <Star size={20} strokeWidth={1.7} aria-hidden="true" />
            <span className={styles.railLabel}>Favoriter</span>
          </button>
        </li>
      );
    }
    const page = (Object.keys(PAGE_LINKS) as RailPage[]).find((p) => PAGE_LINKS[p] === key);
    if (page) {
      if (!canOpen(user, key)) return null;
      return (
        <li key={key}>
          <Link
            href={key}
            className={styles.railItem}
            data-active={currentFn === key || undefined}
            data-nav-menu=""
            data-nav-title={page}
            title={page}
            onClick={() => setOpen(false)}
          >
            {MODULE_ICONS[key]}
            <span className={styles.railLabel}>{page}</span>
          </Link>
        </li>
      );
    }
    const mod = modules.find((m) => m.href === key);
    if (!mod) return null;
    return (
      <li key={key}>
        <button
          type="button"
          className={styles.railItem}
          data-active={pageModule === key || undefined}
          data-shown={shown === key || undefined}
          aria-pressed={shown === key && panelOpen}
          title={mod.title}
          onClick={() => pick(key)}
        >
          {MODULE_ICONS[key]}
          <span className={styles.railLabel}>{mod.title}</span>
        </button>
      </li>
    );
  }

  return (
    <>
      {/* data-app-chrome: hidden inside a tab. */}
      <button
        type="button"
        className={styles.menuButton}
        data-app-chrome=""
        data-open={open}
        onClick={() => setOpen(true)}
        aria-label="Öppna meny"
      >
        <span className={styles.menuBar} />
        <span className={styles.menuBar} />
        <span className={styles.menuBar} />
      </button>

      {open && <div className={styles.backdrop} onClick={() => setOpen(false)} />}

      {/* data-app-sidebar: the tab layer's left edge is measured from it. */}
      <nav
        className={styles.sidebar}
        data-open={open}
        data-panel={panelOpen || undefined}
        // Namn under ikonerna: the rail shows the names, in this size.
        data-rail-labels={navLabels === "off" ? undefined : navLabels}
        data-app-chrome=""
        data-app-sidebar=""
        aria-label="Huvudmeny"
      >
        <ul className={styles.rail}>{RAIL_ORDER.map(railEntry)}</ul>

        {panelOpen && shown === FAVORITES && (
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>Favoriter</span>
              {favorites!.length > 0 && (
                <button type="button" className={styles.groupAction} onClick={() => setEditingFavorites(true)}>
                  Ändra
                </button>
              )}
              <CollapseButton onClick={() => setNavPanelCollapsed(true)} />
            </div>
            {visibleFavorites.length === 0 ? (
              favorites!.length === 0 && (
                <p className={styles.hint}>
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
                      data-nav-title={favorite.title}
                      // Always: a long name is cut with an ellipsis.
                      title={favorite.title}
                      onClick={() => setOpen(false)}
                    >
                      <span className={styles.itemIcon}>{favoriteIcon(favorite.href)}</span>
                      <span className={styles.label}>{favorite.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {panelOpen && shownModule && (
          // data-nav-menu: a menu choice shows the function's tab as it is.
          <div className={styles.panel} data-nav-menu="">
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>{shownModule.title}</span>
              <CollapseButton onClick={() => setNavPanelCollapsed(true)} />
            </div>
            <ul className={styles.list}>
              <li>
                <Link
                  href={shownModule.href}
                  className={styles.item}
                  aria-current={currentFn === shownModule.href ? "page" : undefined}
                  data-nav-title={shownModule.title}
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.label}>Översikt</span>
                </Link>
              </li>
            </ul>
            {shownModule.sections.map((section) => (
              <div key={section.title} className={styles.section} role="group" aria-label={section.title}>
                <div className={styles.sectionTitle}>{section.title}</div>
                <ul className={styles.list}>
                  {section.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={styles.item}
                        aria-current={isCurrent(item.href) ? "page" : undefined}
                        data-nav-title={item.title}
                        title={item.title}
                        onClick={() => setOpen(false)}
                      >
                        <span className={styles.label}>{item.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </nav>

      <Modal open={editingFavorites} onClose={() => setEditingFavorites(false)} title="Ändra favoriter">
        <FavoritesEditor onDone={() => setEditingFavorites(false)} />
      </Modal>
    </>
  );
}

function CollapseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={styles.collapseButton} onClick={onClick} aria-label="Fäll ihop menyn" title="Fäll ihop menyn">
      <ChevronsLeft size={16} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}
