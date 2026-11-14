"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { FavoriteListEditor } from "../FavoriteListEditor";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { groupFavoriteChoices } from "../../lib/favoriteActions";
import type { Favorite } from "../../lib/favorites";
import type { PermissionGroup } from "../../lib/types";

// Förvalda favoriter for a behörighetsgrupp (PUT /permission-groups/:id/
// default-favorites): what a member sees until they save a list of their
// own. Only pages and shortcuts the group's permissions open are offered.
export function GroupFavoritesForm({ group, onSuccess }: { group: PermissionGroup; onSuccess: () => void }) {
  const choices = useMemo(() => groupFavoriteChoices(group.permissions), [group.permissions]);
  const [rows, setRows] = useState<Favorite[]>(group.defaultFavorites ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const favorites = rows.map((row) => ({ ...row, title: row.title.trim() }));
    if (favorites.some((row) => !row.title)) {
      setError("Varje favorit behöver ett namn.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/permission-groups/${group.id}/default-favorites`, {
        method: "PUT",
        body: JSON.stringify({ favorites }),
      });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Favoriterna kunde inte sparas."));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormHint>
        Medlemmarna i gruppen får de här favoriterna tills de ändrar sina egna. En ändring här når alla som inte har
        gjort listan till sin egen.
      </FormHint>
      <FavoriteListEditor
        rows={rows}
        onChange={setRows}
        choices={[
          { label: "Sidor", options: choices.pages },
          { label: "Genvägar", options: choices.actions },
        ]}
        emptyText="Gruppen har inga förvalda favoriter."
      />
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
      </FormActions>
    </Form>
  );
}
