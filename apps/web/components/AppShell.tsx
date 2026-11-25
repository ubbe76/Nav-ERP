import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Nav } from "./ui/Nav";
import { AppToolbar } from "./AppToolbar";
import { StatusBar } from "./StatusBar";
import { PermissionsProvider } from "./PermissionsProvider";
import { ArticleOverviewProvider } from "./articles/ArticleOverviewProvider";
import { ConfirmDialogHost } from "./ui/ConfirmDialogHost";
import { NoticeHost } from "./ui/NoticeHost";
import { EmbeddedBridge } from "./tabs/EmbeddedBridge";
import { TabbedContent } from "./tabs/DocumentTabs";
import { TabStrip } from "./tabs/TabStrip";
import { ReadOnlyBanner } from "./ReadOnlyBanner";
import { FavoritesProvider } from "./FavoritesProvider";
import { getCurrentUser } from "../lib/api";
import { loadShellSettings } from "../lib/favorites";
import { loadNavPanel } from "../lib/navPanel";
import { UserPrefsProvider } from "./UserPrefsProvider";
import { WarehouseModeProvider } from "./stock/WarehouseMode";
import { loadMultipleWarehouses } from "../lib/warehouseMode";
import styles from "./AppShell.module.css";

const ROLE_LABELS: Record<string, string> = { admin: "Administratör", supervisor: "Arbetsledare", user: "Användare" };

interface AppShellProps {
  children: ReactNode;
  // The floating Artikelöversikt panel, opened from any row's
  // ArticleOverviewButton — Översikten deliberately has none.
  articleOverview?: boolean;
}

// The app frame around every page (Programramen, 2026-11-20): the toolbar
// across the window (logo, Ctrl+K, Favorit, Aviseringar, Meddelanden, the
// user menu), under it the icon rail with the module panel (Nav) and the
// content column — the tab strip and the page — and the status bar at the
// bottom. With the tabs on, the page itself is shown in its tab
// (TabbedContent).
export async function AppShell({ children, articleOverview = true }: AppShellProps) {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [user, settings, multipleWarehouses] = await Promise.all([
    getCurrentUser(cookieHeader),
    loadShellSettings(cookieHeader),
    loadMultipleWarehouses(cookieHeader),
  ]);
  if (!user) redirect("/login");
  const roleLabel = ROLE_LABELS[user.role] ?? user.role;
  const navPanel = await loadNavPanel(user, cookieHeader);
  const page = <WarehouseModeProvider multipleWarehouses={multipleWarehouses}>{children}</WarehouseModeProvider>;

  return (
    <FavoritesProvider initial={settings.favorites} initialInSidebar={settings.inSidebar} initialOnOverview={settings.onOverview} initialFromGroup={settings.fromGroup}>
      <UserPrefsProvider
        className={styles.frame}
        initialDensity={settings.density}
        initialListColumns={settings.listColumns}
        initialDocumentTabs={settings.documentTabs}
        initialNavPanelCollapsed={settings.navPanelCollapsed}
        initialNavLabels={settings.navLabels}
      >
        {/* The menu inside too: its Favoriter → Ändra offers shortcuts by the user's access. */}
        <PermissionsProvider role={user.role} permissions={user.permissions}>
          <AppToolbar userName={user.name} userRole={roleLabel} />
          <div className={styles.body}>
            <Nav role={user.role} permissions={user.permissions} modules={navPanel} />
            <div className={styles.column} data-app-column="">
              <TabStrip />
              <main className={styles.main} data-app-main="">
                <TabbedContent>
                  <ReadOnlyBanner readOnly={user.readOnly} />
                  {/* Flera lager: whether a place is shown with its warehouse. */}
                  {articleOverview ? <ArticleOverviewProvider>{page}</ArticleOverviewProvider> : page}
                </TabbedContent>
                <ConfirmDialogHost />
                <NoticeHost />
                <EmbeddedBridge />
              </main>
            </div>
          </div>
          <StatusBar userName={user.name} userRole={roleLabel} />
        </PermissionsProvider>
      </UserPrefsProvider>
    </FavoritesProvider>
  );
}
