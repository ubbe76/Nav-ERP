import { apiGet } from "./api";
import type { HubSection } from "../components/ui/HubSections";
import { pluginPageHref, type PluginPageModule, type PluginUi } from "./plugins";

// Server-side: adds the Tillägg section to a module hub — the pages the
// installed, active plugins put under this module, as the API lists them for
// the signed-in user (GET /plugin-ui already leaves out what the user may not
// see). A failing lookup never breaks the hub: the section is just missing.
export async function withPluginPages(
  sections: HubSection[],
  module: PluginPageModule,
  cookieHeader: string | undefined
): Promise<HubSection[]> {
  let ui: PluginUi;
  try {
    ui = await apiGet<PluginUi>("/api/v1/plugin-ui", cookieHeader);
  } catch {
    return sections;
  }
  const items = ui.pages
    .filter((page) => page.module === module)
    .map((page) => ({
      href: pluginPageHref(page.pluginKey, page.key),
      title: page.title,
      description: page.description ? `${page.description} (${page.pluginName})` : `Tillägget ${page.pluginName}`,
    }));
  return items.length > 0 ? [...sections, { title: "Tillägg", items }] : sections;
}
