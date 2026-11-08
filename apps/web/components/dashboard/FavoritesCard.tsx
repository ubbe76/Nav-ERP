"use client";

import { useState } from "react";
import Link from "next/link";
import { Star } from "lucide-react";
import { Modal } from "../ui/Modal";
import { FavoritesEditor } from "../FavoritesEditor";
import { useFavorites } from "../FavoritesProvider";
import { useCanOpen } from "../PermissionsProvider";
import { hubIconFor } from "../../lib/hubIcons";
import cardStyles from "./DashboardCard.module.css";
import styles from "./FavoritesCard.module.css";

// Översikten's Favoriter card: the same list as the sidebar's group (and
// the only place it shows when the user turned the group off). A favourite
// the user may no longer open is hidden, not removed — as in the sidebar.
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
        <div className={styles.grid}>
          {visible.map((favorite) => {
            const Icon = hubIconFor(favorite.href) ?? Star;
            return (
              <Link key={favorite.href} href={favorite.href} className={styles.tile} title={favorite.title}>
                <span className={styles.icon}>
                  <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
                </span>
                <span className={styles.label}>{favorite.title}</span>
              </Link>
            );
          })}
        </div>
      )}
      <Modal open={editing} onClose={() => setEditing(false)} title="Ändra favoriter">
        <FavoritesEditor onDone={() => setEditing(false)} />
      </Modal>
    </div>
  );
}
