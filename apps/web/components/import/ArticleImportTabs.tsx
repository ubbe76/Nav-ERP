"use client";

import { useState } from "react";
import { ImportWizard } from "./ImportWizard";
import { MultiFileImportWizard } from "./MultiFileImportWizard";
import { HelpLink } from "../ui/HelpLink";
import { FormNotice } from "../ui/Form";
import { IMPORT_ENTITIES, IMPORT_ENTITY_ORDER, type ImportEntityConfig } from "../../lib/importEntities";
import shellStyles from "../AppShell.module.css";
import styles from "./ArticleImportTabs.module.css";

// The first tab takes every Monitor export at once; the rest are the
// single-file wizards, one per entity, in dependency order. Every entity
// config lives in lib/importEntities.ts so the two wizards share it.
const ALL_FILES_TAB = {
  tab: "Alla filer",
  title: "Importera alla artikelfiler",
  meta: "Alla exportfiler på en gång — filerna känns igen på sina rubriker",
  chapter: "artiklar" as const,
  anchor: "importera-alla-filer",
};

const ENTITY_TABS: ImportEntityConfig[] = IMPORT_ENTITY_ORDER.map((entity) => IMPORT_ENTITIES[entity]!);

export function ArticleImportTabs() {
  const [activeTab, setActiveTab] = useState(ALL_FILES_TAB.tab);
  const activeEntity = ENTITY_TABS.find((t) => t.label === activeTab) ?? null;
  const active = activeEntity ?? ALL_FILES_TAB;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{active.title}</div>
          <div className={shellStyles.meta}>{active.meta}</div>
        </div>
        <HelpLink chapter={active.chapter} anchor={active.anchor} label="Hjälp om import" />
      </div>

      <div className={styles.tabStrip}>
        {[ALL_FILES_TAB.tab, ...ENTITY_TABS.map((tab) => tab.label)].map((tab) => (
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
      </div>

      {activeEntity?.notice && <FormNotice>{activeEntity.notice}</FormNotice>}

      {/* The key remounts the wizard on every tab change, which resets ALL of
          its state — step, file, mapping, preview, result — without a manual
          reset effect a future state variable could be forgotten from. Same
          pattern as GrunddataPageClient. */}
      {activeEntity ? (
        <ImportWizard
          key={activeEntity.entity}
          entity={activeEntity.entity}
          title={activeEntity.title}
          fields={activeEntity.fields}
          backHref="/artiklar/register"
          defaults={activeEntity.defaults}
          skipExistingHint={activeEntity.skipExistingHint}
          extraOptions={activeEntity.extraOptions}
        />
      ) : (
        <MultiFileImportWizard key="all" title={ALL_FILES_TAB.title} backHref="/artiklar/register" />
      )}
    </>
  );
}
