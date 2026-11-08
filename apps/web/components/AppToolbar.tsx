"use client";

import { FavoriteToggle } from "./FavoriteToggle";
import { AlertsBell } from "./AlertsBell";
import { UserMenu } from "./UserMenu";
import { CommandPalette } from "./CommandPalette";
import { SaveShortcut } from "./SaveShortcut";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { TabStrip } from "./tabs/TabStrip";
import styles from "./AppToolbar.module.css";

// The fixed band above every page (Nav som program, punkt 1): the search
// (Ctrl+K, punkt 2), the page's Favorit star, Aviseringar with a count and
// the user menu (theme, version, Logga ut) — what used to sit in a row at the
// top of each page's content. Inside PermissionsProvider (the bell and the
// palette read the access profile).
export function AppToolbar({ userName, userRole }: { userName: string; userRole: string }) {
  return (
    // data-app-chrome: hidden inside a tab (punkt 5) — the shortcuts, the
    // palette and Ctrl+S still run there, the frame around draws nothing.
    <header className={styles.toolbar} data-app-chrome="">
      <div className={styles.row}>
        <div className={styles.search}>
          <CommandPalette />
        </div>
        <SaveShortcut />
        <KeyboardShortcuts />
        <div className={styles.actions}>
          <FavoriteToggle />
          <AlertsBell />
          <UserMenu userName={userName} userRole={userRole} />
        </div>
      </div>
      <TabStrip />
    </header>
  );
}
