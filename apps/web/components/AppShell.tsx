import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Nav } from "./ui/Nav";
import { AppToolbar } from "./AppToolbar";
import { StatusBar } from "./StatusBar";
import { PermissionsProvider } from "./PermissionsProvider";
import { ArticleOverviewProvider } from "./articles/ArticleOverviewProvider";
import { ConfirmDialogHost } from "./ui/ConfirmDialogHost";
import { ReadOnlyBanner } from "./ReadOnlyBanner";
import { FavoritesProvider } from "./FavoritesProvider";
import { getCurrentUser } from "../lib/api";
import { loadFavorites } from "../lib/favorites";
import styles from "./AppShell.module.css";

const ROLE_LABELS: Record<string, string> = { admin: "Administratör", supervisor: "Arbetsledare", user: "Användare" };

type NavActive = Parameters<typeof Nav>[0]["active"];

interface AppShellProps {
  active: NavActive;
  children: ReactNode;
}

// Shared frame for pages beyond the dashboard: the sidebar with Favoriter,
// the toolbar (Favorit, Aviseringar, the user menu with theme and Logga ut),
// the content and the status bar — Nav som program, punkt 1. app/page.tsx
// keeps its own inline copy with the same parts.
export async function AppShell({ active, children }: AppShellProps) {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [user, favorites] = await Promise.all([getCurrentUser(cookieHeader), loadFavorites(cookieHeader)]);
  if (!user) redirect("/login");
  const roleLabel = ROLE_LABELS[user.role] ?? user.role;

  return (
    <FavoritesProvider initial={favorites.favorites} initialInSidebar={favorites.inSidebar}>
      <div className={styles.frame}>
        <Nav active={active} role={user.role} permissions={user.permissions} />
        <PermissionsProvider role={user.role} permissions={user.permissions}>
          <div className={styles.column}>
            <AppToolbar userName={user.name} userRole={roleLabel} />
            <main className={styles.main}>
              <ReadOnlyBanner readOnly={user.readOnly} />
              {/* One floating Artikelöversikt panel per page, opened from any
                  row's ArticleOverviewButton. The dashboard (own inline shell)
                  deliberately has none. */}
              <ArticleOverviewProvider>{children}</ArticleOverviewProvider>
              <ConfirmDialogHost />
            </main>
            <StatusBar userName={user.name} userRole={roleLabel} />
          </div>
        </PermissionsProvider>
      </div>
    </FavoritesProvider>
  );
}
