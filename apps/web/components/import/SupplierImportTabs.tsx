"use client";

import { useState } from "react";
import { ImportWizard } from "./ImportWizard";
import { MultiFileImportWizard } from "./MultiFileImportWizard";
import { HelpLink } from "../ui/HelpLink";
import { FormNotice } from "../ui/Form";
import {
  SUPPLIER_IMPORT_ENTITIES,
  SUPPLIER_IMPORT_ENTITY_ORDER,
  type ImportEntityConfig,
} from "../../lib/importEntities";
import shellStyles from "../AppShell.module.css";
// The tab strip is identical to the customer import's — same stylesheet.
import styles from "./CustomerImportTabs.module.css";

// Supplier twin of CustomerImportTabs: the first tab takes every Monitor
// supplier export at once, the rest are the single-file wizards. The entity
// configs live in lib/importEntities.ts so the two wizards share them.
const ALL_FILES_TAB = {
  tab: "Alla filer",
  title: "Importera alla leverantörsfiler",
  meta: "Alla leverantörsexporter på en gång",
  chapter: "inkop" as const,
  anchor: "importera-alla-leverantorsfiler",
  notice:
    "Välj alla leverantörsexporter på en gång — filerna känns igen på sina rubriker och importeras i rätt ordning. Varje fil förhandsgranskas som den ser ut när de tidigare filerna har importerats, och inget sparas förrän du klickar Importera alla.",
};

const ENTITY_TABS: ImportEntityConfig[] = SUPPLIER_IMPORT_ENTITY_ORDER.map((entity) => SUPPLIER_IMPORT_ENTITIES[entity]!);

const ALL_FILES_INTRO = (
  <p>
    Välj alla leverantörsexporter på en gång. Varje fil känns igen på sina kolumnrubriker: Villkor, Övrigt och
    Postadress (eller en äldre exports Lista) som <strong>Leverantörer</strong>, Referenser som{" "}
    <strong>Kontakter</strong> och Leveransadress som <strong>Leveransadresser</strong>. Besöksadress känns inte
    igen — Nav har ingen besöksadress — och hoppas över. Filerna importeras i ordningen leverantörerna först
    (Villkor och Övrigt före Postadress, så att det juridiska namnet står kvar), sedan kontakter och sist
    leveransadresser.
  </p>
);

export function SupplierImportTabs() {
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
        <HelpLink chapter={active.chapter} anchor={active.anchor} label="Hjälp om leverantörsimport" />
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
          its state — step, file, mapping, preview, result — same pattern as
          CustomerImportTabs/ArticleImportTabs. */}
      {activeEntity ? (
        <ImportWizard
          key={activeEntity.entity}
          entity={activeEntity.entity}
          title={activeEntity.title}
          fields={activeEntity.fields}
          backHref="/leverantorer"
          skipExistingHint={activeEntity.skipExistingHint}
          extraOptions={activeEntity.extraOptions}
        />
      ) : (
        <MultiFileImportWizard
          key="all"
          title={ALL_FILES_TAB.title}
          backHref="/leverantorer"
          entities={SUPPLIER_IMPORT_ENTITIES}
          order={SUPPLIER_IMPORT_ENTITY_ORDER}
          intro={ALL_FILES_INTRO}
        />
      )}
    </>
  );
}
