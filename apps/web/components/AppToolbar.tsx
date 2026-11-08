"use client";

import { FavoriteToggle } from "./FavoriteToggle";
import { AlertsBell } from "./AlertsBell";
import { UserMenu } from "./UserMenu";
import styles from "./AppToolbar.module.css";

// The fixed band above every page (Nav som program, punkt 1): the page's
// Favorit star, Aviseringar with a count and the user menu (theme, version,
// Logga ut) — what used to sit in a row at the top of each page's content.
// Inside PermissionsProvider (the bell reads useCanOpen).
export function AppToolbar({ userName, userRole }: { userName: string; userRole: string }) {
  return (
    <header className={styles.toolbar}>
      <span className={styles.spacer} />
      <div className={styles.actions}>
        <FavoriteToggle />
        <AlertsBell />
        <UserMenu userName={userName} userRole={userRole} />
      </div>
    </header>
  );
}
