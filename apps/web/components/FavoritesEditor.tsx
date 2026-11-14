"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Field";
import { Form, FormActions, FormError, FormHint } from "./ui/Form";
import { useFavorites } from "./FavoritesProvider";
import { useAccessUser } from "./PermissionsProvider";
import { FavoriteListEditor } from "./FavoriteListEditor";
import { confirmDialog } from "../lib/confirm";
import { favoriteActionsFor } from "../lib/favoriteActions";
import type { Favorite } from "../lib/favorites";
import styles from "./FavoritesEditor.module.css";

// Favoriter → Ändra: rename, reorder, remove and add shortcuts ("+ Ny …"),
// saved together as the new list. Rendered inside a Modal, which mounts it
// afresh on every open. A list that is still the behörighetsgrupp's
// förvalda favoriter becomes the user's own on Spara; an own list can go
// back to the group's.
export function FavoritesEditor({ onDone }: { onDone: () => void }) {
  const { favorites, replace, inSidebar, setInSidebar, fromGroup, resetToGroup } = useFavorites();
  const user = useAccessUser();
  const actions = useMemo(() => (user ? favoriteActionsFor(user) : []), [user]);
  const [rows, setRows] = useState<Favorite[]>(favorites ?? []);
  const [showInSidebar, setShowInSidebar] = useState(inSidebar);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
    const ok = await confirmDialog("Ersätta dina favoriter med behörighetsgruppens förvalda favoriter?", {
      confirmLabel: "Använd gruppens favoriter",
    });
    if (!ok) return;
    setPending(true);
    const reset = await resetToGroup();
    setPending(false);
    if (reset) onDone();
    else setError("Favoriterna kunde inte återställas — försök igen.");
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
        {!fromGroup && (
          <Button type="button" variant="ghost" disabled={pending} onClick={() => void backToGroup()}>
            Använd gruppens favoriter
          </Button>
        )}
      </FormActions>
    </Form>
  );
}
