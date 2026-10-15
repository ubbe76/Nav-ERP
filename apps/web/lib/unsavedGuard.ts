import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { confirmDialog } from "./confirm";

// Unsaved-changes guard: a page with editable drafts calls
// useUnsavedGuard(hasDrafts). While drafts exist, list navigation
// (confirmLeave in useListNavigation), tab close (beforeunload) and clicks on
// in-app links all ask first. Browser back/forward is an accepted limit.
export const UNSAVED_MESSAGE = "Du har osparade ändringar — lämna ändå?";

let hasDrafts: (() => boolean) | null = null;

// Resolves true when there is nothing to lose or the user chose to leave.
export function confirmLeave(): Promise<boolean> {
  if (!hasDrafts || !hasDrafts()) return Promise.resolve(true);
  return confirmDialog(UNSAVED_MESSAGE, { confirmLabel: "Lämna sidan" });
}

export function useUnsavedGuard(dirty: boolean): void {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    hasDrafts = () => dirtyRef.current;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    // Capture phase, so it runs before Next's Link handler, which skips
    // navigation when the event is defaultPrevented.
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      // The question is asynchronous (in-app dialog), so the click is always
      // stopped here and the navigation replayed once the user chooses to leave.
      e.preventDefault();
      e.stopPropagation();
      void confirmLeave().then((leave) => {
        if (leave) routerRef.current.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      hasDrafts = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
}
