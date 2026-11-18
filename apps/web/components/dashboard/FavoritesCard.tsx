"use client";

import { useState } from "react";
import Link from "next/link";
import { Modal } from "../ui/Modal";
import { FavoritesEditor } from "../FavoritesEditor";
import { useFavorites } from "../FavoritesProvider";
import { useCanOpen } from "../PermissionsProvider";
import { favoriteIcon } from "../ui/Nav";
import { groupFavorites } from "../../lib/favoriteGroups";
import cardStyles from "./DashboardCard.module.css";
import styles from "./FavoritesCard.module.css";

// Översikten's Favoriter card: the same list as the sidebar's group (and
// the only place it shows when the user turned the group off), as compact
// rows of links grouped by module (lib/favoriteGroups.ts).
// A favourite the user may no longer open is hidden, not removed — as in the
// sidebar.
export function FavoritesCard() {
  const { favorites } = useFavorites();
  const canOpen = useCanOpen();
  const [editing, setEditing] = useState(false);
  const visible = favorites?.filter((f) => canOpen(f.href)) ?? [];

  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.header}>
        <div className={cardStyles.title}>Favoriter</div>
        {favorites !== null && (
          <button type="button" className={styles.edit} onClick={() => setEditing(true)}>
            Ändra
          </button>
        )}
      </div>
      {favorites === null ? (
        <p className={styles.empty}>Kunde inte läsa favoriterna just nu.</p>
      ) : visible.length === 0 ? (
        <p className={styles.empty}>
          Inga favoriter än. Lägg till med stjärnan vid en funktion på modulsidorna eller med <strong>Favorit</strong> i
          toppremsan.
        </p>
      ) : (
        <div className={styles.groups}>
          {groupFavorites(visible).map((group) => (
            <section key={group.title} className={styles.group}>
              <h3 className={styles.groupTitle}>{group.title}</h3>
              <ul className={styles.list}>
                {group.favorites.map((favorite) => (
                  <li key={favorite.href}>
                    <Link href={favorite.href} className={styles.link} title={favorite.title}>
                      <span className={styles.icon}>{favoriteIcon(favorite.href)}</span>
                      <span className={styles.label}>{favorite.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <Modal open={editing} onClose={() => setEditing(false)} title="Ändra favoriter">
        <FavoritesEditor onDone={() => setEditing(false)} />
      </Modal>
    </div>
  );
}
