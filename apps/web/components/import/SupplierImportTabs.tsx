"use client";

import { useState } from "react";
import { ImportWizard, type ImportOptionConfig } from "./ImportWizard";
import { HelpLink } from "../ui/HelpLink";
import { FormNotice } from "../ui/Form";
import {
  SUPPLIER_CONTACT_IMPORT_FIELDS,
  SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS,
  SUPPLIER_IMPORT_FIELDS,
  type ImportFieldConfig,
} from "../../lib/importFields";
import shellStyles from "../AppShell.module.css";
// The tab strip is identical to the customer import's — same stylesheet.
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

// Supplier twin of CustomerImportTabs: Monitor's supplier export is the same
// family of files (Postadress / Lista / Referenser / Leveransadress) keyed
// by "Leverantör", minus the Fakturaadress file — suppliers have no invoice
// address in Nav.
const TABS: TabConfig[] = [
  {
    tab: "Leverantörer",
    entity: "suppliers",
    title: "Importera leverantörer",
    meta: "CSV eller Excel (.xlsx) från Monitor G5",
    anchor: "importera-leverantorer",
    fields: SUPPLIER_IMPORT_FIELDS,
    notice:
      "Monitors leverantörsexport består av flera filer. Kör den här fliken en gång per fil, i ordningen Lista → Postadress: Lista-körningen skapar leverantörerna (matchning på leverantörsnummer) med namn, organisationsnummer, VAT-nummer och vårt kundnummer, och Postadress-körningen ersätter sedan kortnamnet med det juridiska namnet och fyller i adressen. Kontakter och leveransadresser importeras efteråt på sina egna flikar.",
    skipExistingHint:
      "Leverantörer som redan finns i registret uppdateras inte — de lämnas precis som de är och listas som överhoppade i resultatet. Utan kryss uppdateras de med filens värden. Kör leverantörsfliken flera gånger (en gång per Monitor-fil) med kryssrutan avmarkerad, annars skrivs Postadress-filens fält aldrig in.",
  },
  {
    tab: "Kontakter",
    entity: "supplierContacts",
    title: "Importera kontakter",
    meta: "CSV eller Excel (.xlsx) från Monitor G5 — Referenser",
    anchor: "importera-leverantorer",
    fields: SUPPLIER_CONTACT_IMPORT_FIELDS,
    notice:
      "Importera leverantörsfliken först — en kontakt kopplas till en befintlig leverantör via leverantörsnumret och raden blir ett fel om leverantören inte finns än.",
    skipExistingHint:
      "Kontakter som redan finns hos leverantören (samma namn) hoppas över i stället för att stoppa hela importen. Befintliga kontakter ändras aldrig — det finns ingen uppdatering, bara skapande.",
  },
  {
    tab: "Leveransadresser",
    entity: "supplierDeliveryAddresses",
    title: "Importera leveransadresser",
    meta: "CSV eller Excel (.xlsx) från Monitor G5 — Leveransadress",
    anchor: "importera-leverantorer",
    fields: SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS,
    notice:
      "Importera leverantörsfliken först — en leveransadress kopplas till en befintlig leverantör via leverantörsnumret. En adress som är identisk med leverantörens egen adress hoppas alltid över.",
    skipExistingHint:
      "Leveransadresser som redan finns på leverantören (samma adress, postnummer och ort) hoppas över i stället för att stoppa hela importen. Befintliga leveransadresser ändras aldrig.",
    extraOptions: [
      {
        key: "setAsDefault",
        label: "Sätt som förvald leveransadress",
        hint:
          "En leverantör som ännu inte har någon förvald leveransadress får sin första importerade adress som förvald. En leverantör som redan har en förvald behåller den — importen sätter aldrig en ny förvald adress åt en leverantör som redan har en.",
        defaultChecked: true,
      },
    ],
  },
];

export function SupplierImportTabs() {
  const [activeTab, setActiveTab] = useState(TABS[0]!.tab);
  const active = TABS.find((t) => t.tab === activeTab) ?? TABS[0]!;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{active.title}</div>
          <div className={shellStyles.meta}>{active.meta}</div>
        </div>
        <HelpLink chapter="inkop" anchor={active.anchor} label="Hjälp om leverantörsimport" />
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
          CustomerImportTabs/ArticleImportTabs. */}
      <ImportWizard
        key={active.entity}
        entity={active.entity}
        title={active.title}
        fields={active.fields}
        backHref="/leverantorer"
        skipExistingHint={active.skipExistingHint}
        extraOptions={active.extraOptions}
      />
    </>
  );
}
