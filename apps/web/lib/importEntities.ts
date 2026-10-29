// The article page's import entities — one config per Monitor G5 article
// export — shared by the single-file tabs (ArticleImportTabs) and the
// multi-file wizard ("Alla filer"). IMPORT_ENTITY_ORDER mirrors
// packages/shared/src/import.ts (the web app cannot import @navet/shared):
// the order the multi-file wizard commits in, each later entity depending
// on the earlier ones (units/prices need the articles, the structure
// resolves its Operation column against the routing).
import type { ImportOptionConfig } from "../components/import/ImportOptionsPanel";
import {
  ARTICLE_IMPORT_FIELDS,
  ARTICLE_UNIT_IMPORT_FIELDS,
  BOM_IMPORT_FIELDS,
  CUSTOMER_PRICE_IMPORT_FIELDS,
  ROUTING_IMPORT_FIELDS,
  STOCK_BALANCE_IMPORT_FIELDS,
  SUPPLIER_PRICE_IMPORT_FIELDS,
  type ImportFieldConfig,
} from "./importFields";

export interface ImportEntityConfig {
  entity: string;
  /** Short name — the tab label and the multi-file wizard's badge. */
  label: string;
  title: string;
  meta: string;
  // Manual chapter for the HelpLink — "artiklar" unless the entity is
  // documented in the purchase/sales chapter (the price imports).
  chapter: "artiklar" | "inkop" | "forsaljning" | "lager";
  anchor: string;
  fields: ImportFieldConfig[];
  defaults?: Record<string, string>;
  notice?: string;
  skipExistingHint: string;
  extraOptions?: ImportOptionConfig[];
}

export const IMPORT_ENTITY_ORDER = ["articles", "articleUnits", "routing", "bom", "supplierPrices", "customerPrices", "stockBalances"];

export const IMPORT_ENTITIES: Record<string, ImportEntityConfig> = {
  articles: {
    entity: "articles",
    label: "Artiklar",
    title: "Importera artiklar",
    meta: "CSV eller Excel (.xlsx)",
    chapter: "artiklar",
    anchor: "importera-artiklar",
    fields: ARTICLE_IMPORT_FIELDS,
    defaults: { articleType: "purchased" },
    skipExistingHint:
      "Artiklar som redan finns i artikelregistret uppdateras inte — de lämnas precis som de är och listas som överhoppade i resultatet. Utan kryss uppdateras de med filens värden.",
  },
  articleUnits: {
    entity: "articleUnits",
    label: "Enheter",
    title: "Importera alternativa enheter",
    meta: "CSV eller Excel (.xlsx) — en rad per artikel och enhet",
    chapter: "artiklar",
    anchor: "importera-alternativa-enheter",
    fields: ARTICLE_UNIT_IMPORT_FIELDS,
    notice:
      "Raden med omräkningsfaktor 1 är artikelns grundenhet och hoppas över — bara alternativa enheter importeras. Filens omräkningsfaktor (Omr.faktor) är antal grundenheter per alternativ enhet; Nav lagrar det omvända (alternativa enheter per grundenhet), så faktorn inverteras.",
    skipExistingHint:
      "Alternativa enheter som redan finns på artikeln behåller sin faktor. Utan kryss uppdateras faktorn med filens värde.",
  },
  routing: {
    entity: "routing",
    label: "Operationer",
    title: "Importera operationer",
    meta: "En rad per operation",
    chapter: "artiklar",
    anchor: "importera-operationer",
    fields: ROUTING_IMPORT_FIELDS,
    skipExistingHint:
      "Operationer vars sekvensnummer redan finns på artikeln hoppas över i stället för att stoppa hela importen. Befintliga operationer ändras inte.",
    extraOptions: [
      {
        key: "updateExisting",
        label: "Uppdatera befintliga operationer",
        hint:
          "Operationer som redan finns på artikeln (samma sekvensnummer) skrivs över med filens resurs, tider, tidsenhet, Kalkyl, beskrivning, kommentar och packinstruktion i stället för att stoppa importen — så rättas en rutt som importerats med fel tidsenhet. Tomma textceller lämnar det sparade värdet orört. Frisläppta tillverkningsordrar påverkas inte. Kan inte kombineras med Hoppa över rader som redan finns.",
        exclusiveWithSkipExisting: true,
      },
      {
        key: "printCommentOnWorkCard",
        label: "Skriv ut kommentaren på arbetskortet",
        hint:
          "Kommentaren från filen (kolumnen Instruktion) skrivs ut på utskriften Skriv ut TO (PDF). Filen bär ingen egen kolumn för valet, så det gäller alla rader med kommentar. Utan kryss sparas kommentaren men syns bara på artikelkortet — den kan kryssas i per operation efteråt.",
      },
    ],
  },
  bom: {
    entity: "bom",
    label: "Struktur",
    title: "Importera artikelstruktur",
    meta: "En rad per komponent",
    chapter: "artiklar",
    anchor: "importera-artikelstruktur",
    fields: BOM_IMPORT_FIELDS,
    defaults: { articleType: "purchased" },
    skipExistingHint:
      "Komponenter som redan ligger i artikelns struktur hoppas över i stället för att stoppa hela importen. Befintliga strukturrader ändras inte.",
    extraOptions: [
      {
        key: "updateExisting",
        label: "Uppdatera befintliga strukturrader",
        hint:
          "Komponenter som redan ligger i artikelns struktur skrivs över med filens antal och enhet, operationskopplingen (när kolumnen Operation är mappad) och Pos. i stället för att stoppa importen. En tom Pos.-cell lämnar det sparade värdet orört. Frisläppta tillverkningsordrar påverkas inte. Kan inte kombineras med Hoppa över rader som redan finns.",
        exclusiveWithSkipExisting: true,
      },
      {
        key: "createMissingArticles",
        label: "Skapa saknade artiklar",
        hint:
          "Komponenter som inte finns i artikelregistret läggs upp automatiskt ur kolumnerna Artikelbenämning (komponenten), Komponentens artikeltyp, Enhet och Komponentens standardpris — i stället för att stoppa importen. Befintliga artiklar ändras aldrig, och den överordnade artikeln skapas aldrig.",
        revealsDefaults: ["articleType"],
      },
    ],
    notice:
      "Importera operationerna först om strukturraderna ska kopplas till en operation — kolumnen Operation slår upp sekvensnumret på artikelns befintliga rutt. Saknas operationen importeras raden ändå, utan koppling, och materialet dras vid slutrapporteringen.",
  },
  supplierPrices: {
    entity: "supplierPrices",
    label: "Inköpspriser",
    title: "Importera inköpspriser",
    meta: "CSV eller Excel (.xlsx) — vanlig prislista eller stafflad",
    chapter: "inkop",
    anchor: "importera-inkopspriser",
    fields: SUPPLIER_PRICE_IMPORT_FIELDS,
    notice:
      "Två sorters prislistor läses med samma flik: den vanliga listan (med Förvald = huvudleverantör) och den stafflade listan (Gränsvärde antal + den andra Pris-kolumnen som staffelpris). Rabatt räknas in i priset. Ställpris och Prisdatum importeras inte.",
    skipExistingHint:
      "Leverantörer som redan finns i artikelns katalog lämnas orörda, staffel inräknad. Utan kryss uppdateras pris, artikelnummer och huvudleverantör med filens värden.",
  },
  customerPrices: {
    entity: "customerPrices",
    label: "Kundpriser",
    title: "Importera kundpriser",
    meta: "CSV eller Excel (.xlsx) — en rad per kund och artikel",
    chapter: "forsaljning",
    anchor: "importera-kundpriser",
    fields: CUSTOMER_PRICE_IMPORT_FIELDS,
    notice:
      "Priset sparas som kundens artikelpris (från antal 1). Rabatt räknas in i priset. Kundens artikelnummer sparas på kundkortet. Rader utan kund (Kundkoppling saknas) och rader med varken pris eller kundens artikelnummer hoppas över. Ställpris sparas på kundpriset (kräver pris på raden). Prisdatum importeras inte.",
    skipExistingHint:
      "Kunder som redan har ett pris eller ett artikelnummer på artikeln behåller det. Utan kryss uppdateras de med filens värden.",
  },
  stockBalances: {
    entity: "stockBalances",
    label: "Lagersaldon",
    title: "Importera lagersaldon",
    meta: "CSV eller Excel (.xlsx) — en rad per artikel och lagerplats",
    chapter: "lager",
    anchor: "importera-lagersaldon",
    fields: STOCK_BALANCE_IMPORT_FIELDS,
    notice:
      "Antal är saldot på lagerplatsen efter importen, som vid en inventering: skillnaden mot dagens saldo bokas som en lagerjustering. Samma fil två gånger ändrar alltså inget. Lager och lagerplatser som saknas skapas. En ökning värderas till À-pris, annars artikelns standardkostnad.",
    skipExistingHint:
      "Lagerplatser där artikeln redan har ett saldo lämnas orörda och listas som överhoppade. Utan kryss sätts saldot till filens antal.",
  },
};

// Excel templates, served statically from public/importmallar (generated by
// `npm run generate:import-templates -w apps/api`). Keyed by import entity for
// every import page, not just the article ones.
export const IMPORT_TEMPLATE_FILES: Record<string, string> = {
  articles: "importmall-artiklar.xlsx",
  articleUnits: "importmall-enheter.xlsx",
  routing: "importmall-operationer.xlsx",
  bom: "importmall-struktur.xlsx",
  supplierPrices: "importmall-inkopspriser.xlsx",
  customerPrices: "importmall-kundpriser.xlsx",
  stockBalances: "importmall-lagersaldon.xlsx",
  customers: "importmall-kunder.xlsx",
  customerContacts: "importmall-kundkontakter.xlsx",
  customerDeliveryAddresses: "importmall-kundadresser.xlsx",
  suppliers: "importmall-leverantorer.xlsx",
  supplierContacts: "importmall-leverantorskontakter.xlsx",
  supplierDeliveryAddresses: "importmall-leverantorsadresser.xlsx",
  workCenters: "importmall-resurser.xlsx",
  legoWorkCenters: "importmall-legoresurser.xlsx",
  productionGroups: "importmall-produktionsgrupper.xlsx",
};
