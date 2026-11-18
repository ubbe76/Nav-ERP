"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Field";
import { Form, FormActions, FormError, FormHint } from "./ui/Form";
import { useFavorites } from "./FavoritesProvider";
import { useAccessUser } from "./PermissionsProvider";
import { FavoriteListEditor } from "./FavoriteListEditor";
import { apiFetch } from "../lib/api";
import { confirmDialog } from "../lib/confirm";
import { favoriteActionsFor } from "../lib/favoriteActions";
import type { Favorite } from "../lib/favorites";
import { notify } from "../lib/notice";
import styles from "./FavoritesEditor.module.css";

// Favoriter → Ändra: rename, reorder, remove and add shortcuts ("+ Ny …"),
// saved together as the new list. Rendered inside a Modal, which mounts it
// afresh on every open. A list that is still the behörighetsgrupp's
// förvalda favoriter becomes the user's own on Spara; an own list can go
// back to the group's — offered only when the group has a list (on a group
// without one the button emptied the user's favourites, 2026-11-18), with
// Ångra in a notice afterwards.

function favoritesCount(n: number): string {
  return n === 1 ? "1 favorit" : `${n} favoriter`;
}
export function FavoritesEditor({ onDone }: { onDone: () => void }) {
  const { favorites, replace, inSidebar, setInSidebar, fromGroup, resetToGroup } = useFavorites();
  const user = useAccessUser();
  const actions = useMemo(() => (user ? favoriteActionsFor(user) : []), [user]);
  const [rows, setRows] = useState<Favorite[]>(favorites ?? []);
  const [showInSidebar, setShowInSidebar] = useState(inSidebar);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The behörighetsgrupp's förvalda favoriter, read when the dialog opens
  // (the Modal mounts the editor afresh) — null until then, 0 on a failed
  // read, so the button stays hidden unless there is a list to go back to.
  const [groupCount, setGroupCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<{ groupFavoritesCount?: number }>("/api/v1/me/settings")
      .then((settings) => {
        if (live) setGroupCount(settings.groupFavoritesCount ?? 0);
      })
      .catch(() => {
        if (live) setGroupCount(0);
      });
    return () => {
      live = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const list = rows.map((row) => ({ ...row, title: row.title.trim() }));
    if (list.some((row) => !row.title)) {
      setError("Varje favorit behöver ett namn.");
      return;
    }
    setPending(true);
    setError(null);
    const saved = (await replace(list)) && (showInSidebar === inSidebar || (await setInSidebar(showInSidebar)));
    setPending(false);
    // The provider's own message lands behind this dialog, so say it here too.
    if (saved) onDone();
    else setError("Favoriterna kunde inte sparas — försök igen.");
  }

  async function backToGroup() {
    if (!groupCount) return;
    // The saved list — what Ångra puts back (unsaved edits in the dialog are
    // dropped either way).
    const previous = favorites ?? [];
    const own = previous.length === 0 ? "din tomma favoritlista" : `dina ${favoritesCount(previous.length)}`;
    const ok = await confirmDialog(
      `Ersätta ${own} med behörighetsgruppens ${favoritesCount(groupCount)}? Du kan ångra direkt efteråt.`,
      { confirmLabel: "Använd gruppens favoriter" }
    );
    if (!ok) return;
    setPending(true);
    const reset = await resetToGroup();
    setPending(false);
    if (!reset) {
      setError("Favoriterna kunde inte återställas — försök igen.");
      return;
    }
    onDone();
    notify({
      message: `Favoriterna är nu behörighetsgruppens ${favoritesCount(groupCount)}.`,
      tone: "success",
      action:
        previous.length > 0
          ? {
              label: "Ångra",
              run: async () => {
                if (!(await replace(previous))) throw new Error("Favoriterna kunde inte läggas tillbaka — försök igen.");
                return "Dina favoriter är tillbaka.";
              },
            }
          : undefined,
    });
  }

  return (
    <Form onSubmit={submit}>
      {fromGroup && (
        <FormHint>Listan är behörighetsgruppens förvalda favoriter. Sparar du en ändring blir den din egen.</FormHint>
      )}
      <FavoriteListEditor
        rows={rows}
        onChange={setRows}
        choices={[{ label: "Genvägar", options: actions }]}
        emptyText="Du har inga favoriter. Lägg till en genväg nedan, eller stjärnmärk en sida med Favorit uppe till höger."
      />
      <label className={styles.placement}>
        <Checkbox checked={showInSidebar} onChange={(e) => setShowInSidebar(e.target.checked)} />
        Visa favoriterna i sidomenyn
      </label>
      <FormHint>
        Utan bocken visas favoriterna bara på Översikten, om kortet Favoriter är valt. Båda valen finns också under
        Favoriter i användarmenyn uppe till höger.
      </FormHint>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Avbryt
        </Button>
        {!fromGroup && groupCount !== null && groupCount > 0 && (
          <Button type="button" variant="ghost" disabled={pending} onClick={() => void backToGroup()}>
            Använd gruppens favoriter
          </Button>
        )}
      </FormActions>
    </Form>
  );
}
