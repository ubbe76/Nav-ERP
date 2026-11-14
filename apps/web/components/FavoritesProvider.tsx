"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "../lib/api";
import { apiErrorMessage } from "../lib/errorMessages";
import { MAX_FAVORITES, type Favorite } from "../lib/favorites";
import { hasFavoritesCard, overviewCardsWithFavorites, type FavoritesPlacement } from "../lib/overviewCards";
import styles from "./FavoritesProvider.module.css";

interface FavoritesValue {
  // null = no list (no provider, or it couldn't be read): the sidebar group
  // and every star stay hidden.
  favorites: Favorite[] | null;
  // Favoriter i sidomenyn (user setting favoritesInSidebar): false hides the
  // sidebar's group — Översikten's Favoriter card shows them instead.
  inSidebar: boolean;
  setInSidebar: (value: boolean) => Promise<boolean>;
  // Översikten's Favoriter card is chosen (`overviewCards`).
  onOverview: boolean;
  // Favoriter in the user menu: both settings in one save.
  setPlacement: (placement: FavoritesPlacement) => Promise<boolean>;
  has: (href: string) => boolean;
  add: (favorite: Favorite) => Promise<boolean>;
  remove: (href: string) => Promise<boolean>;
  // Favoriter → Ändra: the edited list as a whole (order, names, removals).
  replace: (favorites: Favorite[]) => Promise<boolean>;
  // The list is the behörighetsgrupp's förvalda favoriter, not the user's own.
  fromGroup: boolean;
  // Drop the user's own list: the group's förvalda favoriter again.
  resetToGroup: () => Promise<boolean>;
}

const FavoritesContext = createContext<FavoritesValue>({
  favorites: null,
  inSidebar: true,
  setInSidebar: async () => false,
  onOverview: false,
  setPlacement: async () => false,
  has: () => false,
  add: async () => false,
  remove: async () => false,
  replace: async () => false,
  fromGroup: false,
  resetToGroup: async () => false,
});

const ERROR_VISIBLE_MS = 8000;

type Settings = { favorites: Favorite[]; favoritesFromGroup?: boolean };

// One list per page, shared by the sidebar group, the stars on the module
// hubs and the page's own star (FavoriteToggle). The server reads the list
// with the page (AppShell); every change is a PATCH of the whole list, so a
// star click first re-reads it — another tab may have changed it since this
// page loaded — and the changes run one at a time.
export function FavoritesProvider({
  initial,
  initialInSidebar = true,
  initialOnOverview = false,
  initialFromGroup = false,
  children,
}: {
  initial: Favorite[] | null;
  initialInSidebar?: boolean;
  initialOnOverview?: boolean;
  initialFromGroup?: boolean;
  children: ReactNode;
}) {
  const [favorites, setFavorites] = useState(initial);
  const [fromGroup, setFromGroup] = useState(initialFromGroup);
  useEffect(() => setFromGroup(initialFromGroup), [initialFromGroup]);
  const [inSidebar, setInSidebarState] = useState(initialInSidebar);
  useEffect(() => setInSidebarState(initialInSidebar), [initialInSidebar]);
  // Anpassa on Översikten changes the card list and re-renders the page.
  const [onOverview, setOnOverviewState] = useState(initialOnOverview);
  useEffect(() => setOnOverviewState(initialOnOverview), [initialOnOverview]);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // The list as shown, kept beside the state for the queued saves: they run
  // after the render that started them and need the list as it is by then.
  const shown = useRef(initial);
  const show = useCallback((list: Favorite[] | null) => {
    shown.current = list;
    setFavorites(list);
  }, []);

  // A server re-render (navigation, router.refresh) hands over a fresh list.
  const initialKey = JSON.stringify(initial);
  useEffect(() => {
    show(initial);
    // initial is keyed by its JSON: a new array with the same entries is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), ERROR_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const save = useCallback(
    (change: (current: Favorite[]) => Favorite[], reread: boolean): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const previous = shown.current;
        if (previous === null) return false;
        // Shown at once; put back if the save fails.
        show(change(previous));
        try {
          const base = reread ? (await apiFetch<Settings>("/api/v1/me/settings")).favorites : [];
          const next = change(base);
          if (next.length > MAX_FAVORITES) {
            show(base);
            setError(`Du kan ha högst ${MAX_FAVORITES} favoriter — ta bort någon först.`);
            return false;
          }
          const saved = await apiFetch<Settings>("/api/v1/me/settings", {
            method: "PATCH",
            body: JSON.stringify({ favorites: next }),
          });
          show(saved.favorites);
          setFromGroup(saved.favoritesFromGroup === true);
          setError(null);
          return true;
        } catch (err) {
          show(previous);
          setError(apiErrorMessage(err, "Favoriterna kunde inte sparas."));
          return false;
        }
      };
      const result = queue.current.then(run);
      queue.current = result;
      return result;
    },
    [show]
  );

  // Queued with the list's saves, like them.
  const resetToGroup = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      try {
        const saved = await apiFetch<Settings>("/api/v1/me/settings", {
          method: "PATCH",
          body: JSON.stringify({ favorites: null }),
        });
        show(saved.favorites);
        setFromGroup(saved.favoritesFromGroup === true);
        setError(null);
        return true;
      } catch (err) {
        setError(apiErrorMessage(err, "Favoriterna kunde inte återställas."));
        return false;
      }
    };
    const result = queue.current.then(run);
    queue.current = result;
    return result;
  }, [show]);

  const setInSidebar = useCallback(async (next: boolean): Promise<boolean> => {
    try {
      const saved = await apiFetch<{ favoritesInSidebar: boolean }>("/api/v1/me/settings", {
        method: "PATCH",
        body: JSON.stringify({ favoritesInSidebar: next }),
      });
      setInSidebarState(saved.favoritesInSidebar);
      return true;
    } catch (err) {
      setError(apiErrorMessage(err, "Valet kunde inte sparas."));
      return false;
    }
  }, []);

  // The card list is read first — Anpassa may have changed it since this page
  // loaded — and only sent when the Favoriter card comes or goes. Queued with
  // the list's saves.
  const setPlacement = useCallback((placement: FavoritesPlacement): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const sidebar = placement !== "overview";
      const card = placement !== "sidebar";
      try {
        const current = await apiFetch<{ overviewCards: unknown }>("/api/v1/me/settings");
        const overviewCards = overviewCardsWithFavorites(current.overviewCards, card);
        const saved = await apiFetch<{ favoritesInSidebar: boolean; overviewCards: unknown }>("/api/v1/me/settings", {
          method: "PATCH",
          body: JSON.stringify(overviewCards ? { favoritesInSidebar: sidebar, overviewCards } : { favoritesInSidebar: sidebar }),
        });
        setInSidebarState(saved.favoritesInSidebar);
        setOnOverviewState(hasFavoritesCard(saved.overviewCards));
        return true;
      } catch (err) {
        setError(apiErrorMessage(err, "Valet kunde inte sparas."));
        return false;
      }
    };
    const result = queue.current.then(run);
    queue.current = result;
    return result;
  }, []);

  const value = useMemo<FavoritesValue>(
    () => ({
      favorites,
      inSidebar,
      setInSidebar,
      onOverview,
      setPlacement,
      has: (href) => favorites?.some((f) => f.href === href) ?? false,
      add: (favorite) =>
        save((current) => (current.some((f) => f.href === favorite.href) ? current : [...current, favorite]), true),
      remove: (href) => save((current) => current.filter((f) => f.href !== href), true),
      replace: (list) => save(() => list, false),
      fromGroup,
      resetToGroup,
    }),
    [favorites, save, inSidebar, setInSidebar, onOverview, setPlacement, fromGroup, resetToGroup]
  );

  return (
    <FavoritesContext.Provider value={value}>
      {children}
      {error && (
        <div role="alert" className={styles.toast}>
          <span>{error}</span>
          <button type="button" className={styles.close} onClick={() => setError(null)} aria-label="Stäng">
            ✕
          </button>
        </div>
      )}
    </FavoritesContext.Provider>
  );
}

export function useFavorites(): FavoritesValue {
  return useContext(FavoritesContext);
}
