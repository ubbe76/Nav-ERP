// Programramen: what the module panel lists, per module, for the signed-in
// user — the module structure (lib/moduleNav.ts through NAV_MODULES and
// sectionsForUser, the same rules as the module pages) plus the pages the
// active plugins put under the module (GET /plugin-ui, as withPluginPages
// adds them to the hub). Read server-side by AppShell; a failing plugin
// lookup only leaves the Tillägg sections out. Descriptions stay on the
// module pages — the panel shows names.
import { apiGet } from "./api";
import { canOpen } from "./pageAccess";
import { sectionsForUser } from "./moduleNav";
import { NAV_MODULES } from "./navModules";
import { pluginPageHref, type PluginUi } from "./plugins";
import type { Permission } from "./permissions";

export interface NavPanelItem {
  href: string;
  title: string;
}

export interface NavPanelModule {
  // The module page's address — also the module's key.
  href: string;
  title: string;
  sections: { title: string; items: NavPanelItem[] }[];
}

export async function loadNavPanel(
  user: { role: string; permissions: readonly Permission[] },
  cookieHeader: string | undefined
): Promise<NavPanelModule[]> {
  let pluginPages: PluginUi["pages"] = [];
  try {
    pluginPages = (await apiGet<PluginUi>("/api/v1/plugin-ui", cookieHeader)).pages;
  } catch {
    // No Tillägg sections.
  }
  const role = user.role as "admin" | "supervisor" | "user";
  return NAV_MODULES.filter((m) => canOpen({ role, permissions: user.permissions }, m.href)).map((m) => {
    const sections = sectionsForUser(m.sections, user).map((s) => ({
      title: s.title,
      items: s.items.map((i) => ({ href: i.href, title: i.title })),
    }));
    const plugins = pluginPages
      .filter((page) => `/${page.module}` === m.href)
      .map((page) => ({ href: pluginPageHref(page.pluginKey, page.key), title: page.title }));
    return {
      href: m.href,
      title: m.title,
      sections: plugins.length > 0 ? [...sections, { title: "Tillägg", items: plugins }] : sections,
    };
  });
}
