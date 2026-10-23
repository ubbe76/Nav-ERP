"use client";

import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";
import { Form, FormActions, FormError, FormHint } from "./ui/Form";
import { useFavorites } from "./FavoritesProvider";
import { FAVORITE_TITLE_MAX, type Favorite } from "../lib/favorites";
import styles from "./FavoritesEditor.module.css";

// Favoriter → Ändra: rename, reorder and remove, saved together as the new
// list. Rendered inside a Modal, which mounts it afresh on every open.
export function FavoritesEditor({ onDone }: { onDone: () => void }) {
  const { favorites, replace } = useFavorites();
  const [rows, setRows] = useState<Favorite[]>(favorites ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function move(index: number, step: -1 | 1) {
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      next.splice(index + step, 0, row!);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const list = rows.map((row) => ({ ...row, title: row.title.trim() }));
    if (list.some((row) => !row.title)) {
      setError("Varje favorit behöver ett namn.");
      return;
    }
    setPending(true);
    setError(null);
    const saved = await replace(list);
    setPending(false);
    // The provider's own message lands behind this dialog, so say it here too.
    if (saved) onDone();
    else setError("Favoriterna kunde inte sparas — försök igen.");
  }

  return (
    <Form onSubmit={submit}>
      {rows.length === 0 ? (
        <FormHint>Du har inga favoriter kvar.</FormHint>
      ) : (
        <ol className={styles.list}>
          {rows.map((row, index) => (
            <li key={row.href} className={styles.row}>
              <div className={styles.name}>
                <Input
                  aria-label={`Namn på favorit ${index + 1}`}
                  value={row.title}
                  maxLength={FAVORITE_TITLE_MAX}
                  onChange={(e) =>
                    setRows((current) => current.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)))
                  }
                />
                <span className={styles.href}>{row.href}</span>
              </div>
              <div className={styles.actions}>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  aria-label={`Flytta upp ${row.title}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  aria-label={`Flytta ned ${row.title}`}
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                >
                  Ta bort
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
