"use client";

import { useUnsavedGuard } from "../../lib/unsavedGuard";
import { useState } from "react";
import type {
  Article,
  ArticleGroup,
  ArticleLocations,
  BomComponent,
  BomTreeNode,
  CostCalculation,
  RoutingOperation,
  StockBalance,
  WorkCenter,
} from "../../lib/types";
import type { ArticleType } from "../../lib/types";
import { AllmantTab } from "./AllmantTab";
import { BeredningTab } from "./BeredningTab";
import { InkopTab } from "./InkopTab";
import { ForsaljningTab } from "./ForsaljningTab";
import { LagerTab } from "./LagerTab";
import { KalkylTab } from "./KalkylTab";
import { KonfiguratorTab } from "./KonfiguratorTab";
import { FilerTab } from "./FilerTab";
import { RevisionerTab } from "./RevisionerTab";
import { PluginTabContent, pluginTabId, usePluginTabs } from "../plugins/PluginTabs";
import styles from "./ArticleTabs.module.css";

type Tab = "Allmänt" | "Konfigurator" | "Beredning" | "Inköp" | "Försäljning" | "Lager" | "Kalkyl" | "Revisioner" | "Filer";

// Monitor-style: the flikar depend on the article type. Beredning (BOM + rutt)
// is only relevant for a manufactured article; a purchased article gets an
// Inköp tab instead. A service article is bought but never stocked, so it also
// drops the Lager tab. Konfigurator is only for manufactured articles.
function tabsForType(type: ArticleType): Tab[] {
  switch (type) {
    case "manufactured":
      return ["Allmänt", "Konfigurator", "Beredning", "Försäljning", "Lager", "Kalkyl", "Revisioner", "Filer"];
    case "purchased":
      return ["Allmänt", "Inköp", "Försäljning", "Lager", "Kalkyl", "Revisioner", "Filer"];
    case "service":
      return ["Allmänt", "Inköp", "Försäljning", "Kalkyl", "Revisioner", "Filer"];
  }
}

interface ArticleTabsProps {
  article: Article;
  bom: BomComponent[];
  bomTree: BomTreeNode;
  balances: StockBalance[];
  calculations: CostCalculation[];
  routing: RoutingOperation[];
  workCenters: WorkCenter[];
  groups: ArticleGroup[];
  articleLocations: ArticleLocations;
}

export function ArticleTabs({
  article,
  bom,
  bomTree,
  balances,
  calculations,
  routing,
  workCenters,
  groups,
  articleLocations,
}: ArticleTabsProps) {
  const tabs = tabsForType(article.type);
  const [activeTab, setActiveTabState] = useState<string>("Allmänt");
  // Allmänt, Försäljning and Lager stay mounted (hidden) once opened, so a half-typed form
  // survives a tab switch — before, switching to Lager dropped Allmänt's
  // changes without a word (webbgranskningen 2026-11-11, same as the partner
  // card). Allmänt and Försäljning report unsaved changes; leaving the page asks first.
  const [openedTabs, setOpenedTabs] = useState<Set<string>>(() => new Set(["Allmänt"]));
  const setActiveTab = (tab: string) => {
    setActiveTabState(tab);
    setOpenedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  };
  const [allmantDirty, setAllmantDirty] = useState(false);
  const [forsaljningDirty, setForsaljningDirty] = useState(false);
  useUnsavedGuard(allmantDirty || forsaljningDirty);
  // Tillägg add their own tabs last.
  const pluginTabs = usePluginTabs("article");
  const activePluginTab = pluginTabs.find((t) => pluginTabId(t) === activeTab);

  return (
    <div>
      <div className={styles.tabStrip}>
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={styles.tab}
            data-active={tab === activeTab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
        {pluginTabs.map((tab) => (
          <button
            key={pluginTabId(tab)}
            type="button"
            className={styles.tab}
            data-active={pluginTabId(tab) === activeTab}
            title={`Tillägget ${tab.pluginName}`}
            onClick={() => setActiveTab(pluginTabId(tab))}
          >
            {tab.title}
          </button>
        ))}
      </div>

      {openedTabs.has("Allmänt") && (
        <div hidden={activeTab !== "Allmänt"}>
          <AllmantTab article={article} groups={groups} onDirtyChange={setAllmantDirty} />
        </div>
      )}
      {activeTab === "Konfigurator" && tabs.includes("Konfigurator") && <KonfiguratorTab article={article} />}
      {activeTab === "Beredning" && tabs.includes("Beredning") && (
        <BeredningTab
          article={article}
          tree={bomTree}
          initialBom={bom}
          initialRouting={routing}
          workCenters={workCenters}
          groups={groups}
        />
      )}
      {activeTab === "Inköp" && tabs.includes("Inköp") && <InkopTab articleId={article.id} />}
      {openedTabs.has("Försäljning") && (
        <div hidden={activeTab !== "Försäljning"}>
          <ForsaljningTab article={article} onDirtyChange={setForsaljningDirty} />
        </div>
      )}
      {openedTabs.has("Lager") && tabs.includes("Lager") && (
        <div hidden={activeTab !== "Lager"}>
          <LagerTab article={article} balances={balances} articleLocations={articleLocations} />
        </div>
      )}
      {activeTab === "Kalkyl" && (
        <KalkylTab articleId={article.id} calculations={calculations} salesPrice={article.salesPrice} />
      )}
      {activeTab === "Revisioner" && <RevisionerTab articleId={article.id} />}
      {activeTab === "Filer" && <FilerTab articleId={article.id} />}
      {activePluginTab && <PluginTabContent key={pluginTabId(activePluginTab)} tab={activePluginTab} entityId={article.id} />}
    </div>
  );
}
