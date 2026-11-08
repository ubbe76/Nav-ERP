"use client";

import { useEffect } from "react";

// Ctrl+S / ⌘S (Nav som program, punkt 3): saves the form you are in — the
// one holding the focus, as its own submit button would (requestSubmit runs
// the form's validation and onSubmit). The browser's "Save page" is never
// wanted inside Nav, so the shortcut is always taken; nothing else is.
export function SaveShortcut() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      const form = (document.activeElement as HTMLElement | null)?.closest?.("form");
      if (form && !form.querySelector('[type="submit"]:disabled')) form.requestSubmit();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
