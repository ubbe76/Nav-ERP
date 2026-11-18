"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "./ui/Button";
import { Input, Select } from "./ui/Field";
import { FormHint } from "./ui/Form";
import { FAVORITE_TITLE_MAX, MAX_FAVORITES, type Favorite } from "../lib/favorites";
import { groupFavorites, moveFavoriteGroup, moveFavoriteInGroup, withFavorite } from "../lib/favoriteGroups";
import styles from "./FavoritesEditor.module.css";

// A favourites list being edited: rename, reorder, remove, and add from the
// offered pages and shortcuts. Shared by Favoriter → Ändra (the user's own
// list) and a behörighetsgrupp's Förvalda favoriter (System). The caller
// owns the rows and saves them. Shown grouped by module as on Översikten
// (lib/favoriteGroups.ts): a group moves as a whole, a favourite only within
// its group, and a move saves the list module by module.
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

  function add(href: string) {
    const option = offered.flatMap((group) => group.options).find((o) => o.href === href);
    if (option && !full) onChange(withFavorite(rows, { ...option }));
  }

  const groups = groupFavorites(rows);
  // "Namn på favorit 3": the row's place in the list as shown.
  const shownOrder = groups.flatMap((group) => group.favorites.map((f) => f.href));

  return (
    <>
      {rows.length === 0 ? (
        <FormHint>{emptyText}</FormHint>
      ) : (
        <div className={styles.groups}>
          {groups.map((group, groupIndex) => (
            <section key={group.title} className={styles.group}>
              <div className={styles.groupHeader}>
                <h3 className={styles.groupTitle}>{group.title}</h3>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    aria-label={`Flytta upp gruppen ${group.title}`}
                    title="Flytta upp gruppen"
                    disabled={groupIndex === 0}
                    onClick={() => onChange(moveFavoriteGroup(rows, groupIndex, -1))}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    aria-label={`Flytta ned gruppen ${group.title}`}
                    title="Flytta ned gruppen"
                    disabled={groupIndex === groups.length - 1}
                    onClick={() => onChange(moveFavoriteGroup(rows, groupIndex, 1))}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <ol className={styles.list}>
                {group.favorites.map((row, index) => {
                  const position = shownOrder.indexOf(row.href) + 1;
                  return (
                    <li key={row.href} className={styles.row}>
                      <div className={styles.name}>
                        <Input
                          aria-label={`Namn på favorit ${position}`}
                          value={row.title}
                          maxLength={FAVORITE_TITLE_MAX}
                          onChange={(e) =>
                            onChange(rows.map((r) => (r.href === row.href ? { ...r, title: e.target.value } : r)))
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
                          onClick={() => onChange(moveFavoriteInGroup(rows, groupIndex, index, -1))}
                        >
                          <ArrowUp size={14} aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          aria-label={`Flytta ned ${row.title}`}
                          disabled={index === group.favorites.length - 1}
                          onClick={() => onChange(moveFavoriteInGroup(rows, groupIndex, index, 1))}
                        >
                          <ArrowDown size={14} aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          onClick={() => onChange(rows.filter((r) => r.href !== row.href))}
                        >
                          Ta bort
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
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
