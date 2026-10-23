"use client";

import { useState, type FormEvent } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Star } from "lucide-react";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { Field, Input } from "./ui/Field";
import { Form, FormActions, FormHint } from "./ui/Form";
import { useFavorites } from "./FavoritesProvider";
import { FAVORITE_TITLE_MAX, favoriteHref } from "../lib/favorites";
import shellStyles from "./AppShell.module.css";
import styles from "./FavoriteToggle.module.css";

// The page's own name as its topbar shows it (a card shows its number or
// name there), offered as the favourite's name.
function pageTitle(): string {
  const text = document.querySelector(`.${shellStyles.title}`)?.textContent?.trim() ?? "";
  return text.slice(0, FAVORITE_TITLE_MAX);
}

// **Favorit** beside Logga ut: adds the page as it is now — filters
// included, page number excluded — to Favoriter under a name the user
// confirms, or removes it again. Not on Översikten, which the sidebar
// already links.
export function FavoriteToggle() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { favorites, has, add, remove } = useFavorites();
  const [naming, setNaming] = useState<string | null>(null);

  if (favorites === null || pathname === "/") return null;
  const href = favoriteHref(pathname, searchParams);
  const active = has(href);
  const filtered = href.includes("?");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const title = (naming ?? "").trim();
    if (!title) return;
    setNaming(null);
    await add({ href, title });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="small"
        className={styles.toggle}
        aria-pressed={active}
        title={active ? "Ta bort sidan ur Favoriter" : "Lägg till sidan i Favoriter"}
        onClick={() => (active ? void remove(href) : setNaming(pageTitle()))}
      >
        <Star size={14} strokeWidth={1.9} fill={active ? "currentColor" : "none"} aria-hidden="true" />
        Favorit
      </Button>

      <Modal open={naming !== null} onClose={() => setNaming(null)} title="Lägg till i favoriter" compact>
        <Form onSubmit={submit}>
          <Field label="Namn" htmlFor="favorite-title">
            <Input
              id="favorite-title"
              value={naming ?? ""}
              maxLength={FAVORITE_TITLE_MAX}
              onChange={(e) => setNaming(e.target.value)}
              autoFocus
              required
            />
          </Field>
          <FormHint>
            {filtered
              ? "Sidan sparas med sina filter och sin sökning, så favoriten öppnar samma urval."
              : "Sidan läggs till under Favoriter överst i sidomenyn."}
          </FormHint>
          <FormActions>
            <Button type="submit" variant="primary" disabled={!(naming ?? "").trim()}>
              Lägg till
            </Button>
            <Button type="button" variant="ghost" onClick={() => setNaming(null)}>
              Avbryt
            </Button>
          </FormActions>
        </Form>
      </Modal>
    </>
  );
}
