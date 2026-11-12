import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { confirmDialog } from "./confirm";

// Unsaved-changes guard: a page with editable drafts calls
// useUnsavedGuard(hasDrafts). While drafts exist, list navigation
// (confirmLeave in useListNavigation), tab close (beforeunload) and clicks on
// in-app links all ask first. Browser back/forward is an accepted limit.
export const UNSAVED_MESSAGE = "Du har osparade ändringar — lämna ändå?";

// Every mounted guard on the page. Several can be mounted at once (the
// settings page's forms, a card and a field on it): one shared listener asks
// when ANY of them has drafts. A single global slot let the last mounted
// guard hide the others, and the first to unmount cleared it for all.
interface Guard {
  dirty: () => boolean;
  // The drafts live in client state that a change of ?search=, ?page= or a
  // filter keeps (Behovsberäkning: choices span pages) — then only leaving
  // the page asks.
  survivesListNavigation: () => boolean;
}
const guards = new Set<Guard>();
let replay: ((href: string) => void) | null = null;

const dirtyGuards = () => [...guards].filter((guard) => guard.dirty());

// Whether the page has unsaved changes right now — for an action that works
// on the SAVED document (Skicka via e-post renders the stored record).
export function hasUnsavedDrafts(): boolean {
  return dirtyGuards().length > 0;
}

// A document tab's frame (punkt 5) asks the page inside before closing it.
if (typeof window !== "undefined") {
  (window as Window & { __navHasDrafts?: () => boolean }).__navHasDrafts = hasUnsavedDrafts;
}

// Resolves true when there is nothing to lose or the user chose to leave.
// listNavigation: the list's own search/filter/page change on the same page.
export function confirmLeave({ listNavigation = false }: { listNavigation?: boolean } = {}): Promise<boolean> {
  const dirty = dirtyGuards();
  if (dirty.length === 0) return Promise.resolve(true);
  if (listNavigation && dirty.every((guard) => guard.survivesListNavigation())) return Promise.resolve(true);
  return confirmDialog(UNSAVED_MESSAGE, { confirmLabel: "Lämna sidan" });
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (hasUnsavedDrafts()) e.preventDefault();
}

// Capture phase, so it runs before Next's Link handler, which skips
// navigation when the event is defaultPrevented.
function onClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const dirty = dirtyGuards();
  if (dirty.length === 0) return;
  const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return;
  if (url.pathname === window.location.pathname && url.search === window.location.search) return;
  if (url.pathname === window.location.pathname && dirty.every((guard) => guard.survivesListNavigation())) return;
  // The question is asynchronous (in-app dialog), so the click is always
  // stopped here and the navigation replayed once the user chooses to leave.
  e.preventDefault();
  e.stopPropagation();
  void confirmLeave().then((leave) => {
    if (leave) replay?.(`${url.pathname}${url.search}${url.hash}`);
  });
}

export function useUnsavedGuard(dirty: boolean, { survivesListNavigation = false }: { survivesListNavigation?: boolean } = {}): void {
  const surviveRef = useRef(survivesListNavigation);
  surviveRef.current = survivesListNavigation;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    const guard: Guard = { dirty: () => dirtyRef.current, survivesListNavigation: () => surviveRef.current };
    if (guards.size === 0) {
      window.addEventListener("beforeunload", onBeforeUnload);
      document.addEventListener("click", onClick, true);
    }
    guards.add(guard);
    replay = (href) => routerRef.current.push(href);
    return () => {
      guards.delete(guard);
      if (guards.size === 0) {
        replay = null;
        window.removeEventListener("beforeunload", onBeforeUnload);
        document.removeEventListener("click", onClick, true);
      }
    };
  }, []);
}
