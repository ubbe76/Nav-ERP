"use client";

import { useState } from "react";
import { ImportWizard, type ImportOptionConfig } from "./ImportWizard";
import { HelpLink } from "../ui/HelpLink";
import { FormNotice } from "../ui/Form";
import {
  LEGO_WORK_CENTER_IMPORT_FIELDS,
  PRODUCTION_GROUP_IMPORT_FIELDS,
  WORK_CENTER_IMPORT_FIELDS,
  type ImportFieldConfig,
} from "../../lib/importFields";
import shellStyles from "../AppShell.module.css";
// The tab strip is identical to the customer/supplier import's — same
// stylesheet.
import styles from "./CustomerImportTabs.module.css";

interface TabConfig {
  tab: string;
  entity: string;
  title: string;
  meta: string;
  anchor: string;
  fields: ImportFieldConfig[];
  notice: string;
  skipExistingHint: string;
  extraOptions?: ImportOptionConfig[];
}

// Monitor's "Produktionsgruppslista" export drives all three registers here:
// Kostnader carries the resource's cost fields and its Avdelning (which maps
// to a Nav production group), and Lista carries the default setup time and
// operation name. Produktionsgrupper first (Resurser can create missing
// ones on the fly, but importing them explicitly gives control over the
// name), then Resurser, then Legoresurser last since it needs suppliers
// already imported.
const TABS: TabConfig[] = [
  {
    tab: "Produktionsgrupper",
    entity: "productionGroups",
    title: "Importera produktionsgrupper",
    meta: "CSV eller Excel (.xlsx) från Monitor G5 — Produktionsgruppslista (Kostnader)",
    anchor: "importera-resurser",
    fields: PRODUCTION_GROUP_IMPORT_FIELDS,
    notice:
      "Monitors Avdelning är Navs produktionsgrupp. Kör Kostnader-filen — den innehåller både avdelningens kod (Avdelning) och namn (Benämning). Filen har en rad per resurs; varje avdelning importeras en gång.",
    skipExistingHint:
      "Produktionsgrupper som redan finns (samma kod) uppdateras inte — de lämnas som de är och listas som överhoppade. Utan kryss uppdateras namnet med filens värde.",
  },
  {
    tab: "Resurser",
    entity: "workCenters",
    title: "Importera resurser",
    meta: "CSV eller Excel (.xlsx) från Monitor G5 — Produktionsgruppslista (Kostnader och Lista)",
    anchor: "importera-resurser",
    fields: WORK_CENTER_IMPORT_FIELDS,
    notice:
      "Monitors Produktionsgrupp är Navs resurs (tresiffrigt nummer). Kör Kostnader-filen först (nummer, namn, typ, avdelning, timkostnad, kalkylpris) — bara raden Ordinarie per resurs importeras, Undantag-raderna hoppas över — och därefter Lista-filen (förvald ställtid, operationsbenämning) med kryssrutan avmarkerad. Avdelningar som saknas skapas som produktionsgrupper.",
    skipExistingHint:
      "Resurser som redan finns (samma nummer) uppdateras inte — de lämnas som de är och listas som överhoppade. Utan kryss uppdateras de med filens ifyllda värden; tomma celler skriver aldrig över.",
  },
  {
    tab: "Legoresurser",
    entity: "legoWorkCenters",
    title: "Importera legoresurser",
    meta: "CSV eller Excel (.xlsx) från Monitor G5 — Produktionsgruppslista (Lego)",
    anchor: "importera-resurser",
    fields: LEGO_WORK_CENTER_IMPORT_FIELDS,
    notice:
      "Importera leverantörerna först — legoresursens standardleverantör kopplas via leverantörsnumret och raden blir ett fel om leverantören inte finns.",
    skipExistingHint:
      "Legoresurser som redan finns (samma nummer) uppdateras inte — de lämnas som de är och listas som överhoppade. Utan kryss uppdateras de med filens ifyllda värden.",
  },
];

export function ResourceImportTabs() {
  const [activeTab, setActiveTab] = useState(TABS[0]!.tab);
  const active = TABS.find((t) => t.tab === activeTab) ?? TABS[0]!;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{active.title}</div>
          <div className={shellStyles.meta}>{active.meta}</div>
        </div>
        <HelpLink chapter="tillverkning" anchor={active.anchor} label="Hjälp om resursimport" />
      </div>

      <div className={styles.tabStrip}>
        {TABS.map((tab) => (
          <button
            key={tab.tab}
            type="button"
            className={styles.tab}
            data-active={tab.tab === activeTab}
            onClick={() => setActiveTab(tab.tab)}
          >
            {tab.tab}
          </button>
        ))}
      </div>

      <FormNotice>{active.notice}</FormNotice>

      {/* The key remounts the wizard on every tab change, which resets ALL of
          its state — step, file, mapping, preview, result — same pattern as
          SupplierImportTabs/CustomerImportTabs/ArticleImportTabs. */}
      <ImportWizard
        key={active.entity}
        entity={active.entity}
        title={active.title}
        fields={active.fields}
        backHref="/tillverkning/resurser"
        skipExistingHint={active.skipExistingHint}
        extraOptions={active.extraOptions}
      />
    </>
  );
}
