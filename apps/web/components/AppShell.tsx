import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";
import { LogoutButton } from "./LogoutButton";
import { Nav } from "./ui/Nav";
import { PermissionsProvider } from "./PermissionsProvider";
import { ArticleOverviewProvider } from "./articles/ArticleOverviewProvider";
import { ConfirmDialogHost } from "./ui/ConfirmDialogHost";
import { ReadOnlyBanner } from "./ReadOnlyBanner";
import { FavoritesProvider } from "./FavoritesProvider";
import { FavoriteToggle } from "./FavoriteToggle";
import { getCurrentUser } from "../lib/api";
import { loadFavorites } from "../lib/favorites";
import styles from "./AppShell.module.css";

const ROLE_LABELS: Record<string, string> = { admin: "Administratör", supervisor: "Arbetsledare", user: "Användare" };

type NavActive = Parameters<typeof Nav>[0]["active"];

interface AppShellProps {
  active: NavActive;
  children: ReactNode;
}

// Shared frame (sidebar nav with Favoriter, the page's Favorit star, theme
// toggle, logout, auth redirect) for pages beyond the dashboard. app/page.tsx
// keeps its own inline copy — it already worked before this existed and isn't
// worth touching just to deduplicate.
export async function AppShell({ active, children }: AppShellProps) {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [user, favorites] = await Promise.all([getCurrentUser(cookieHeader), loadFavorites(cookieHeader)]);
  if (!user) redirect("/login");

  return (
    <FavoritesProvider initial={favorites}>
      <div className={styles.frame}>
        <Nav
          active={active}
          userName={user.name}
          userRole={ROLE_LABELS[user.role] ?? user.role}
          role={user.role}
          permissions={user.permissions}
        />
        <main className={styles.main}>
          <ReadOnlyBanner readOnly={user.readOnly} />
          <div className={styles.themeRow}>
            <FavoriteToggle />
            <LogoutButton />
            <ThemeToggle />
          </div>
          {/* One floating Artikelöversikt panel per page, opened from any
              row's ArticleOverviewButton. The dashboard (own inline shell)
              deliberately has none. */}
          <PermissionsProvider role={user.role} permissions={user.permissions}>
            <ArticleOverviewProvider>{children}</ArticleOverviewProvider>
          </PermissionsProvider>
          <ConfirmDialogHost />
        </main>
      </div>
    </FavoritesProvider>
  );
}
