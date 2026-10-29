// The Excel templates and the manual chapter Importmallar, both generated
// from field-help.ts (spec docs/superpowers/specs/2026-10-22-importmallar-
// design.md). Pure: workbook descriptions and markdown in, bytes/text out;
// scripts/generate-import-templates.ts writes the files and
// import-templates-generated.test.ts checks the checked-in ones are current.
import type { ImportEntity } from "@navet/shared";
import { IMPORT_FIELD_HELP } from "./field-help.js";
import { writeXlsx, type XlsxCell, type XlsxWorkbook } from "./xlsx-writer.js";

export interface ImportTemplateInfo {
  entity: ImportEntity;
  /** ASCII file name under apps/web/public/importmallar/. */
  fileName: string;
  /** Section heading in the manual chapter and the workbook's own title. */
  title: string;
  /** Where in the app the file is imported — the wizard page and its tab. */
  guide: string;
  /** The hand-written manual section that describes the import. */
  chapterLink: string;
}

// The manual's order: the article imports in their dependency order, then
// the partner imports, then the resources.
export const IMPORT_TEMPLATES: ImportTemplateInfo[] = [
  {
    entity: "articles",
    fileName: "importmall-artiklar.xlsx",
    title: "Artiklar",
    guide: "**Artiklar → Importera**, fliken **Artiklar**",
    chapterLink: "/hjalp/artiklar#importera-artiklar",
  },
  {
    entity: "articleUnits",
    fileName: "importmall-enheter.xlsx",
    title: "Alternativa enheter",
    guide: "**Artiklar → Importera**, fliken **Enheter**",
    chapterLink: "/hjalp/artiklar#importera-alternativa-enheter",
  },
  {
    entity: "routing",
    fileName: "importmall-operationer.xlsx",
    title: "Operationer",
    guide: "**Artiklar → Importera**, fliken **Operationer**",
    chapterLink: "/hjalp/artiklar#importera-operationer",
  },
  {
    entity: "bom",
    fileName: "importmall-struktur.xlsx",
    title: "Artikelstruktur",
    guide: "**Artiklar → Importera**, fliken **Struktur**",
    chapterLink: "/hjalp/artiklar#importera-artikelstruktur",
  },
  {
    entity: "supplierPrices",
    fileName: "importmall-inkopspriser.xlsx",
    title: "Inköpspriser",
    guide: "**Artiklar → Importera**, fliken **Inköpspriser**",
    chapterLink: "/hjalp/inkop#importera-inkopspriser",
  },
  {
    entity: "customerPrices",
    fileName: "importmall-kundpriser.xlsx",
    title: "Kundpriser",
    guide: "**Artiklar → Importera**, fliken **Kundpriser**",
    chapterLink: "/hjalp/forsaljning#importera-kundpriser",
  },
  {
    entity: "stockBalances",
    fileName: "importmall-lagersaldon.xlsx",
    title: "Lagersaldon",
    guide: "**Artiklar → Importera**, fliken **Lagersaldon**",
    chapterLink: "/hjalp/lager#importera-lagersaldon",
  },
  {
    entity: "customers",
    fileName: "importmall-kunder.xlsx",
    title: "Kunder",
    guide: "**Försäljning → Kunder → Importera**, fliken **Kunder**",
    chapterLink: "/hjalp/forsaljning#importera-kunder",
  },
  {
    entity: "customerContacts",
    fileName: "importmall-kundkontakter.xlsx",
    title: "Kundkontakter",
    guide: "**Försäljning → Kunder → Importera**, fliken **Kontakter**",
    chapterLink: "/hjalp/forsaljning#fliken-kontakter",
  },
  {
    entity: "customerDeliveryAddresses",
    fileName: "importmall-kundadresser.xlsx",
    title: "Kundernas leveransadresser",
    guide: "**Försäljning → Kunder → Importera**, fliken **Leveransadresser**",
    chapterLink: "/hjalp/forsaljning#fliken-leveransadresser",
  },
  {
    entity: "suppliers",
    fileName: "importmall-leverantorer.xlsx",
    title: "Leverantörer",
    guide: "**Inköp → Leverantörer → Importera**, fliken **Leverantörer**",
    chapterLink: "/hjalp/inkop#importera-leverantorer",
  },
  {
    entity: "supplierContacts",
    fileName: "importmall-leverantorskontakter.xlsx",
    title: "Leverantörskontakter",
    guide: "**Inköp → Leverantörer → Importera**, fliken **Kontakter**",
    chapterLink: "/hjalp/inkop#fliken-kontakter",
  },
  {
    entity: "supplierDeliveryAddresses",
    fileName: "importmall-leverantorsadresser.xlsx",
    title: "Leverantörernas leveransadresser",
    guide: "**Inköp → Leverantörer → Importera**, fliken **Leveransadresser**",
    chapterLink: "/hjalp/inkop#fliken-leveransadresser",
  },
  {
    entity: "workCenters",
    fileName: "importmall-resurser.xlsx",
    title: "Resurser",
    guide: "**Tillverkning → Resurser → Importera**, fliken **Resurser**",
    chapterLink: "/hjalp/tillverkning#fliken-resurser",
  },
  {
    entity: "legoWorkCenters",
    fileName: "importmall-legoresurser.xlsx",
    title: "Legoresurser",
    guide: "**Tillverkning → Resurser → Importera**, fliken **Legoresurser**",
    chapterLink: "/hjalp/tillverkning#fliken-legoresurser",
  },
  {
    entity: "productionGroups",
    fileName: "importmall-produktionsgrupper.xlsx",
    title: "Produktionsgrupper",
    guide: "**Tillverkning → Resurser → Importera**, fliken **Produktionsgrupper**",
    chapterLink: "/hjalp/tillverkning#fliken-produktionsgrupper",
  },
];

// The templates' public URL prefix — served statically from
// apps/web/public/importmallar (exempted in apps/web/proxy.ts).
export const IMPORT_TEMPLATE_URL_PREFIX = "/importmallar/";

export function importTemplateInfo(entity: ImportEntity): ImportTemplateInfo {
  const info = IMPORT_TEMPLATES.find((t) => t.entity === entity);
  if (!info) throw new Error(`No import template registered for ${entity}`);
  return info;
}

// The comment on a heading cell: "Obligatorisk." first when the wizard
// requires the column, then the explanation.
export function headerComment(help: { required: boolean; description: string }): string {
  return help.required ? `Obligatorisk. ${help.description}` : help.description;
}

// The columns where an EMPTY cell is a value rather than "leave it alone" —
// the planners' rules (supplier-prices.ts, articles.ts, routing.ts), named
// in the template and the chapter so nobody keeps such a column by accident.
const EMPTY_MEANS_SOMETHING =
  "Huvudleverantör och Staffel: från antal/Staffel: pris (Inköpspriser), Partiformningsregel (Artiklar) samt Kalkyl och Tidsenhet med Uppdatera befintliga operationer (Operationer)";

const INSTRUCTION_LINES = [
  "Fyll i bladet Import — det är det enda bladet som läses in; det här bladet är bara en förklaring.",
  "Ta bort kolumner du inte använder. Kolumnernas ordning spelar ingen roll.",
  `En tom cell lämnar normalt värdet orört på en befintlig post, utom i kolumner där tomt betyder något: ${EMPTY_MEANS_SOMETHING}. Vad tomt betyder står vid varje kolumn.`,
  "Tal skrivs med decimalkomma eller punkt. Obligatoriska kolumner måste finnas med och vara ifyllda på varje rad.",
];

export function buildImportTemplateWorkbook(entity: ImportEntity): XlsxWorkbook {
  const info = importTemplateInfo(entity);
  const fields = IMPORT_FIELD_HELP[entity];

  const importSheet = {
    name: "Import",
    freezeHeader: true,
    columnWidths: fields.map((f) => Math.min(40, Math.max(14, f.header.length + 4))),
    // Numbers, codes, postal codes, phone numbers and percentages are Text,
    // so Excel keeps 007 and 0123 as written (field-help.ts's `text`).
    textColumns: fields.flatMap((f, i) => (f.text ? [i] : [])),
    rows: [fields.map((f): XlsxCell => ({ value: f.header, bold: true, comment: headerComment(f) }))],
  };

  const instructionRows: (XlsxCell | string | null)[][] = [
    [{ value: `Importmall: ${info.title}`, bold: true }],
    ...INSTRUCTION_LINES.map((line) => [line]),
    [],
    [
      { value: "Kolumn", bold: true },
      { value: "Obligatorisk", bold: true },
      { value: "Förklaring", bold: true },
      { value: "Exempel", bold: true },
    ],
    ...fields.map((f): (XlsxCell | string)[] => [
      { value: f.header, wrap: true },
      { value: f.required ? "Ja" : "Nej", wrap: true },
      { value: f.description, wrap: true },
      { value: f.example, wrap: true },
    ]),
  ];

  return {
    commentAuthor: "Nav",
    sheets: [
      importSheet,
      {
        name: "Instruktioner",
        columnWidths: [30, 12, 90, 32],
        rows: instructionRows,
      },
    ],
  };
}

export function buildImportTemplate(entity: ImportEntity): Buffer {
  return writeXlsx(buildImportTemplateWorkbook(entity));
}

// --- the manual chapter ------------------------------------------------------

// A markdown table cell: pipes and line breaks would break the row.
function tableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function buildImportTemplateManual(): string {
  const lines: string[] = [];
  lines.push("# Importmallar");
  lines.push("");
  lines.push(
    "<!-- Genererad av `npm run generate:import-templates -w apps/api` ur apps/api/src/modules/import/service/field-help.ts — redigera inte för hand. -->"
  );
  lines.push("");
  lines.push(
    "Varje import i Nav har en **Excelmall** att utgå från. Mallen laddas ned med **Ladda ned mall** i importguidens flik, eller här nedan. Den har två blad:"
  );
  lines.push("");
  lines.push(
    "- **Import** — en rad med kolumnrubriker, i fetstil. Varje rubrik har en kommentar som förklarar kolumnen (håll muspekaren över cellen); kommentaren börjar med *Obligatorisk.* när kolumnen måste finnas med. Fyll i dina rader under rubrikerna."
  );
  lines.push(
    "- **Instruktioner** — samma förklaringar i en tabell, med ett exempelvärde per kolumn. Bladet läses aldrig in."
  );
  lines.push("");
  lines.push("Att känna till:");
  lines.push("");
  lines.push("- Importen läser bara det **första bladet** i en arbetsbok — låt **Import** ligga först.");
  lines.push("- **Ta bort kolumner du inte använder.** Kolumnernas **ordning spelar ingen roll** — guiden känner igen rubrikerna och kopplar dem till rätt fält.");
  lines.push(
    `- En **tom cell** lämnar normalt värdet orört på en befintlig post, **utom** i kolumner där tomt betyder något: ${EMPTY_MEANS_SOMETHING}. Vad tomt betyder står vid varje kolumn nedan.`
  );
  lines.push("- Tal skrivs med **decimalkomma eller punkt** (1 250,50 eller 1250.50).");
  lines.push(
    "- Ja/Nej-kolumner förstår **Ja/Nej**, **1/0** och **true/false** (de flesta även **X** för Ja); exakt vilka ord som gäller står vid kolumnen."
  );
  lines.push(
    "- Mallens nummer- och kodkolumner (artikelnummer, resursnummer, postnummer, telefonnummer, procent med flera) är **textformaterade**, så att Excel inte tar bort inledande nollor eller gör om värdet till ett tal eller datum. Bygger du en egen fil bör du textformatera samma kolumner."
  );
  lines.push("");
  lines.push(
    "Förklaringarna nedan visas också i importguidens steg **Kolumner**, under det fält kolumnen är kopplad till, när **Visa förklaringar** är ikryssad (av på smala skärmar). Reglerna för själva importen — vad som skapas, uppdateras eller hoppas över — står i respektive kapitel, länkat från varje avsnitt."
  );

  for (const info of IMPORT_TEMPLATES) {
    const fields = IMPORT_FIELD_HELP[info.entity];
    lines.push("");
    lines.push(`## ${info.title}`);
    lines.push("");
    lines.push(
      `[Ladda ned mallen](${IMPORT_TEMPLATE_URL_PREFIX}${info.fileName}) — importeras på ${info.guide}. Reglerna beskrivs i [${chapterTitle(info.chapterLink)}](${info.chapterLink}).`
    );
    lines.push("");
    lines.push("| Kolumn | Obligatorisk | Förklaring | Exempel |");
    lines.push("| --- | --- | --- | --- |");
    for (const f of fields) {
      lines.push(
        `| **${tableCell(f.header)}** | ${f.required ? "Ja" : "Nej"} | ${tableCell(f.description)} | ${tableCell(f.example)} |`
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// "/hjalp/artiklar#importera-artiklar" -> "Artiklar", for the link text.
function chapterTitle(link: string): string {
  const slug = link.replace(/^\/hjalp\//, "").replace(/#.*$/, "");
  const titles: Record<string, string> = {
    artiklar: "Artiklar",
    inkop: "Inköp",
    forsaljning: "Försäljning",
    tillverkning: "Tillverkning",
  };
  return titles[slug] ?? slug;
}
