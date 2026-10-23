"use client";

import { useState } from "react";
import type {
  Article,
  ArticleGroup,
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
import { LagerTab } from "./LagerTab";
import { KalkylTab } from "./KalkylTab";
import { KonfiguratorTab } from "./KonfiguratorTab";
import { FilerTab } from "./FilerTab";
import { RevisionerTab } from "./RevisionerTab";
import { PluginTabContent, pluginTabId, usePluginTabs } from "../plugins/PluginTabs";
import styles from "./ArticleTabs.module.css";

type Tab = "Allmänt" | "Konfigurator" | "Beredning" | "Inköp" | "Lager" | "Kalkyl" | "Revisioner" | "Filer";

// Monitor-style: the flikar depend on the article type. Beredning (BOM + rutt)
// is only relevant for a manufactured article; a purchased article gets an
// Inköp tab instead. A service article is bought but never stocked, so it also
// drops the Lager tab. Konfigurator is only for manufactured articles.
function tabsForType(type: ArticleType): Tab[] {
  switch (type) {
    case "manufactured":
      return ["Allmänt", "Konfigurator", "Beredning", "Lager", "Kalkyl", "Revisioner", "Filer"];
    case "purchased":
      return ["Allmänt", "Inköp", "Lager", "Kalkyl", "Revisioner", "Filer"];
    case "service":
      return ["Allmänt", "Inköp", "Kalkyl", "Revisioner", "Filer"];
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
}: ArticleTabsProps) {
  const tabs = tabsForType(article.type);
  const [activeTab, setActiveTab] = useState<string>("Allmänt");
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

      {activeTab === "Allmänt" && <AllmantTab article={article} groups={groups} />}
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
      {activeTab === "Lager" && tabs.includes("Lager") && <LagerTab article={article} balances={balances} />}
      {activeTab === "Kalkyl" && (
        <KalkylTab articleId={article.id} calculations={calculations} salesPrice={article.salesPrice} />
      )}
      {activeTab === "Revisioner" && <RevisionerTab articleId={article.id} />}
      {activeTab === "Filer" && <FilerTab articleId={article.id} />}
      {activePluginTab && <PluginTabContent key={pluginTabId(activePluginTab)} tab={activePluginTab} entityId={article.id} />}
    </div>
  );
}
