"use client";

import { useState } from "react";
import { ImportWizard, type ImportOptionConfig } from "./ImportWizard";
import { HelpLink } from "../ui/HelpLink";
import { FormNotice } from "../ui/Form";
import {
  CUSTOMER_CONTACT_IMPORT_FIELDS,
  CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS,
  CUSTOMER_IMPORT_FIELDS,
  type ImportFieldConfig,
} from "../../lib/importFields";
import shellStyles from "../AppShell.module.css";
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

const TABS: TabConfig[] = [
  {
    tab: "Kunder",
    entity: "customers",
    title: "Importera kunder",
    meta: "CSV eller Excel (.xlsx)",
    anchor: "importera-kunder",
    fields: CUSTOMER_IMPORT_FIELDS,
    notice:
      "Består kundexporten av flera filer, kör den här fliken en gång per fil, i ordningen Lista → Postadress → Fakturaadress: Lista-körningen skapar kunderna (matchning på kundnummer) med namn, organisationsnummer och VAT-nummer — och villkor, speditör, prislista och rabatt om de kolumnerna finns med i filen. Postadress-körningen ersätter sedan kortnamnet med det juridiska namnet och fyller i adressen, och Fakturaadress-körningen fakturaadressen. Kontakter och leveransadresser importeras efteråt på sina egna flikar.",
    skipExistingHint:
      "Kunder som redan finns i registret uppdateras inte — de lämnas precis som de är och listas som överhoppade i resultatet. Utan kryss uppdateras de med filens värden. Kör kundfliken flera gånger (en gång per fil) med kryssrutan avmarkerad, annars skrivs Postadress- och Fakturaadress-filernas fält aldrig in.",
  },
  {
    tab: "Kontakter",
    entity: "customerContacts",
    title: "Importera kontakter",
    meta: "CSV eller Excel (.xlsx) — en rad per kontakt",
    anchor: "importera-kunder",
    fields: CUSTOMER_CONTACT_IMPORT_FIELDS,
    notice:
      "Importera kundfliken först — en kontakt kopplas till en befintlig kund via kundnumret och raden blir ett fel om kunden inte finns än.",
    skipExistingHint:
      "Kontakter som redan finns hos kunden (samma namn) hoppas över i stället för att stoppa hela importen. Befintliga kontakter ändras aldrig — det finns ingen uppdatering, bara skapande.",
  },
  {
    tab: "Leveransadresser",
    entity: "customerDeliveryAddresses",
    title: "Importera leveransadresser",
    meta: "CSV eller Excel (.xlsx) — en rad per leveransadress",
    anchor: "importera-kunder",
    fields: CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS,
    notice:
      "Importera kundfliken först — en leveransadress kopplas till en befintlig kund via kundnumret. En adress som är identisk med kundens egen adress hoppas alltid över.",
    skipExistingHint:
      "Leveransadresser som redan finns på kunden (samma adress, postnummer, ort och land) hoppas över i stället för att stoppa hela importen. Befintliga leveransadresser ändras aldrig.",
    extraOptions: [
      {
        key: "setAsDefault",
        label: "Sätt som förvald leveransadress",
        hint:
          "En kund som ännu inte har någon förvald leveransadress får sin första importerade adress som förvald. En kund som redan har en förvald behåller den — importen sätter aldrig en ny förvald adress åt en kund som redan har en.",
        defaultChecked: true,
      },
    ],
  },
];

export function CustomerImportTabs() {
  const [activeTab, setActiveTab] = useState(TABS[0]!.tab);
  const active = TABS.find((t) => t.tab === activeTab) ?? TABS[0]!;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{active.title}</div>
          <div className={shellStyles.meta}>{active.meta}</div>
        </div>
        <HelpLink chapter="forsaljning" anchor={active.anchor} label="Hjälp om kundimport" />
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
          its state — step, file, mapping, preview, result — without a manual
          reset effect a future state variable could be forgotten from. Same
          pattern as ArticleImportTabs. */}
      <ImportWizard
        key={active.entity}
        entity={active.entity}
        title={active.title}
        fields={active.fields}
        backHref="/kunder"
        skipExistingHint={active.skipExistingHint}
        extraOptions={active.extraOptions}
      />
    </>
  );
}
