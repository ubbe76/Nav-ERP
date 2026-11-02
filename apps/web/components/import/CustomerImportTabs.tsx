"use client";

import { useState } from "react";
import { ImportWizard } from "./ImportWizard";
import { MultiFileImportWizard } from "./MultiFileImportWizard";
import { HelpLink } from "../ui/HelpLink";
import { FormNotice } from "../ui/Form";
import {
  CUSTOMER_IMPORT_ENTITIES,
  CUSTOMER_IMPORT_ENTITY_ORDER,
  type ImportEntityConfig,
} from "../../lib/importEntities";
import shellStyles from "../AppShell.module.css";
import styles from "./CustomerImportTabs.module.css";

// The first tab takes every Monitor customer export at once; the rest are the
// single-file wizards. Every entity config lives in lib/importEntities.ts so
// the two wizards share it.
const ALL_FILES_TAB = {
  tab: "Alla filer",
  title: "Importera alla kundfiler",
  meta: "Alla kundexporter på en gång",
  chapter: "forsaljning" as const,
  anchor: "importera-alla-kundfiler",
  notice:
    "Välj alla kundexporter på en gång — filerna känns igen på sina rubriker och importeras i rätt ordning. Varje fil förhandsgranskas som den ser ut när de tidigare filerna har importerats, och inget sparas förrän du klickar Importera alla.",
};

const ENTITY_TABS: ImportEntityConfig[] = CUSTOMER_IMPORT_ENTITY_ORDER.map((entity) => CUSTOMER_IMPORT_ENTITIES[entity]!);

const ALL_FILES_INTRO = (
  <p>
    Välj alla kundexporter på en gång. Varje fil känns igen på sina kolumnrubriker: Lista, Övrigt, Postadress
    och Fakturaadress som <strong>Kunder</strong>, Referenser som <strong>Kontakter</strong>, Leveransadress
    och Alternativa leveransadresser som <strong>Leveransadresser</strong>. Besöksadress känns inte igen — Nav
    har ingen besöksadress — och hoppas över. Filerna importeras i ordningen kunderna först (Lista och Övrigt
    före Postadress och Fakturaadress, så att det juridiska namnet står kvar), sedan kontakter och sist
    leveransadresser.
  </p>
);

export function CustomerImportTabs() {
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
        <HelpLink chapter={active.chapter} anchor={active.anchor} label="Hjälp om kundimport" />
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

      <FormNotice>{activeEntity ? (activeEntity.tabNotice ?? activeEntity.notice) : ALL_FILES_TAB.notice}</FormNotice>

      {/* The key remounts the wizard on every tab change, which resets ALL of
          its state — step, file, mapping, preview, result — without a manual
          reset effect a future state variable could be forgotten from. Same
          pattern as ArticleImportTabs. */}
      {activeEntity ? (
        <ImportWizard
          key={activeEntity.entity}
          entity={activeEntity.entity}
          title={activeEntity.title}
          fields={activeEntity.fields}
          backHref="/kunder"
          skipExistingHint={activeEntity.skipExistingHint}
          extraOptions={activeEntity.extraOptions}
        />
      ) : (
        <MultiFileImportWizard
          key="all"
          title={ALL_FILES_TAB.title}
          backHref="/kunder"
          entities={CUSTOMER_IMPORT_ENTITIES}
          order={CUSTOMER_IMPORT_ENTITY_ORDER}
          intro={ALL_FILES_INTRO}
        />
      )}
    </>
  );
}
