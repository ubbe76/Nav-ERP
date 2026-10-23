"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatStockholmDateTime } from "../../lib/date";
import { PLUGIN_STATUS_LABELS, type PluginInstallResult, type PluginListRow } from "../../lib/plugins";
import { Button } from "../ui/Button";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { InstallPluginDialog } from "./InstallPluginDialog";
import styles from "./Plugins.module.css";

export function PluginsPageClient({ initialPlugins }: { initialPlugins: PluginListRow[] }) {
  const router = useRouter();
  const [plugins, setPlugins] = useState(initialPlugins);
  const [installOpen, setInstallOpen] = useState(false);

  async function reload() {
    setPlugins(await apiFetch<PluginListRow[]>("/api/v1/plugins"));
    // Hubs and cards read the plugin list on the server / on mount.
    router.refresh();
  }

  return (
    <>
      <div className={styles.toolbar}>
        <Button type="button" onClick={() => setInstallOpen(true)}>
          Installera tillägg…
        </Button>
      </div>

      <Table
        columns={[
          { key: "name", label: "Namn", width: "minmax(160px, 1.4fr)" },
          { key: "url", label: "Adress", width: "minmax(180px, 1.6fr)" },
          { key: "status", label: "Status", width: "110px" },
          { key: "last", label: "Senaste leverans", width: "150px" },
          { key: "failed", label: "Misslyckade (7 dagar)", width: "150px", align: "right" },
        ]}
        rows={plugins}
        emptyText="Inga tillägg är installerade"
        renderCell={(plugin, key) => {
          switch (key) {
            case "name":
              return (
                <Link href={`/system/tillagg/${plugin.id}`} className={styles.name}>
                  {plugin.name}
                </Link>
              );
            case "url":
              return <span className={styles.mutedLine}>{plugin.baseUrl}</span>;
            case "status":
              return <StatusPill status={plugin.status === "active" ? "done" : "draft"} label={PLUGIN_STATUS_LABELS[plugin.status]} />;
            case "last":
              return formatStockholmDateTime(plugin.lastDeliveredAt);
            default:
              return plugin.failedLast7Days > 0 ? <strong>{plugin.failedLast7Days}</strong> : "0";
          }
        }}
      />

      <InstallPluginDialog
        open={installOpen}
        onClose={() => {
          setInstallOpen(false);
          // Closing after an install without "Klar" still shows the new plugin.
          void reload();
        }}
        onInstalled={(result: PluginInstallResult) => {
          setInstallOpen(false);
          void reload();
          router.push(`/system/tillagg/${result.plugin.id}`);
        }}
      />
    </>
  );
}
