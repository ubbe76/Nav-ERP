"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import type { PluginTabTarget, PluginUi, PluginUiTab } from "../../lib/plugins";
import { PluginFrame } from "./PluginFrame";

// The tabs the installed, active plugins add to a card (article, customer,
// supplier) — as GET /plugin-ui lists them for the signed-in user (it already
// leaves out what the user or the plugin may not see). A failing lookup just
// means no extra tabs.
export function usePluginTabs(on: PluginTabTarget): PluginUiTab[] {
  const [tabs, setTabs] = useState<PluginUiTab[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiFetch<PluginUi>("/api/v1/plugin-ui")
      .then((ui) => {
        if (!cancelled) setTabs(ui.tabs.filter((t) => t.on === on));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [on]);
  return tabs;
}

// The id a plugin tab has in a card's tab state (never collides with the
// fixed tab names).
export function pluginTabId(tab: PluginUiTab): string {
  return `plugin:${tab.pluginId}:${tab.key}`;
}

export function PluginTabContent({ tab, entityId }: { tab: PluginUiTab; entityId: string }) {
  return <PluginFrame pluginId={tab.pluginId} title={tab.title} request={{ tab: tab.key, entityId }} mode="tab" />;
}
