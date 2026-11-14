"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "./ui/Button";
import { Input, Select } from "./ui/Field";
import { FormHint } from "./ui/Form";
import { FAVORITE_TITLE_MAX, MAX_FAVORITES, type Favorite } from "../lib/favorites";
import styles from "./FavoritesEditor.module.css";

// A favourites list being edited: rename, reorder, remove, and add from the
// offered pages and shortcuts. Shared by Favoriter → Ändra (the user's own
// list) and a behörighetsgrupp's Förvalda favoriter (System). The caller
// owns the rows and saves them.
export function FavoriteListEditor({
  rows,
  onChange,
  choices,
  emptyText,
}: {
  rows: Favorite[];
  onChange: (rows: Favorite[]) => void;
  // Offered in "Lägg till …", grouped; entries already in the list are left out.
  choices: { label: string; options: readonly Favorite[] }[];
  emptyText: string;
}) {
  const taken = new Set(rows.map((row) => row.href));
  const offered = choices
    .map((group) => ({ ...group, options: group.options.filter((option) => !taken.has(option.href)) }))
    .filter((group) => group.options.length > 0);
  const full = rows.length >= MAX_FAVORITES;

  function move(index: number, step: -1 | 1) {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + step, 0, row!);
    onChange(next);
  }

  function add(href: string) {
    const option = offered.flatMap((group) => group.options).find((o) => o.href === href);
    if (option && !full) onChange([...rows, { ...option }]);
  }

  return (
    <>
      {rows.length === 0 ? (
        <FormHint>{emptyText}</FormHint>
      ) : (
        <ol className={styles.list}>
          {rows.map((row, index) => (
            <li key={row.href} className={styles.row}>
              <div className={styles.name}>
                <Input
                  aria-label={`Namn på favorit ${index + 1}`}
                  value={row.title}
                  maxLength={FAVORITE_TITLE_MAX}
                  onChange={(e) => onChange(rows.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)))}
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
                <Button type="button" variant="ghost" size="small" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                  Ta bort
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {offered.length > 0 && (
        <Select
          aria-label="Lägg till favorit"
          value=""
          disabled={full}
          onChange={(e) => {
            add(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">{full ? `Högst ${MAX_FAVORITES} favoriter` : "Lägg till …"}</option>
          {offered.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.href} value={option.href}>
                  {option.title}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      )}
    </>
  );
}
