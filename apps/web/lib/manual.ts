import { readFile } from "node:fs/promises";
import path from "node:path";
import { Marked } from "marked";

// Same slugify on both sides: the renderer gives every heading an id, and
// HelpLink anchors are built from the same rule. Swedish letters fold to
// a/o so anchors stay plain ASCII.
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/é/g, "e")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const renderer = new Marked({
  renderer: {
    heading({ tokens, depth, text }) {
      const html = this.parser.parseInline(tokens);
      return `<h${depth} id="${slugifyHeading(text)}">${html}</h${depth}>\n`;
    },
  },
});

// The user manual lives as markdown in docs/manual/ (versioned with the
// code) and is rendered in-app under /hjalp. Server-side only.
export interface ManualChapter {
  slug: string;
  title: string;
  file: string;
  description: string;
  group: "Komma igång" | "Register" | "Flöden" | "System";
}

export const MANUAL_CHAPTERS: ManualChapter[] = [
  {
    slug: "komma-igang",
    title: "Komma igång",
    file: "komma-igang.md",
    description: "Inloggning, navigering och hur listorna fungerar.",
    group: "Komma igång",
  },
  {
    slug: "artiklar",
    title: "Artiklar",
    file: "artiklar.md",
    description: "Artikelregistret, artikelkortet, struktur/beredning, import från CSV och artikelgrupper.",
    group: "Register",
  },
  {
    slug: "grunddata",
    title: "Grunddata",
    file: "grunddata.md",
    description: "Leveransvillkor, betalningsvillkor och speditörer.",
    group: "Register",
  },
  {
    slug: "personal-tid",
    title: "Personal & tid",
    file: "personal-tid.md",
    description: "Personal, scheman, kalendrar, ATF och tidrapporter.",
    group: "Register",
  },
  {
    slug: "inkop",
    title: "Inköp",
    file: "inkop.md",
    description: "Leverantörer med import från CSV, förfrågningar och inköpsorder med mottagning.",
    group: "Flöden",
  },
  {
    slug: "forsaljning",
    title: "Försäljning",
    file: "forsaljning.md",
    description: "Kunder med import från CSV, offert, kundorder, leverans och fakturering.",
    group: "Flöden",
  },
  {
    slug: "tillverkning",
    title: "Tillverkning",
    file: "tillverkning.md",
    description: "Tillverkningsorder, resurser, produktionsgrupper och efterkalkyl.",
    group: "Flöden",
  },
  {
    slug: "terminal",
    title: "Stämpelterminalen",
    file: "terminal.md",
    description: "Närvarostämpling, orderstämpling och ATF-uttag i verkstaden.",
    group: "Flöden",
  },
  {
    slug: "lon",
    title: "Lön & attestering",
    file: "lon.md",
    description: "Frånvaro, OB, attestering, löneunderlag och PAXml-export.",
    group: "Flöden",
  },
  {
    slug: "lager",
    title: "Lager",
    file: "lager.md",
    description: "Saldon, transaktionslogg, lagerplatser, lagerflytt, inventering, justeringar och lagervärdering.",
    group: "Flöden",
  },
  {
    slug: "ekonomi",
    title: "Ekonomi",
    file: "ekonomi.md",
    description: "Kontoplan, räkenskapsår och perioder, verifikat, huvudboken, momsrapporten, automatkontering, konteringsregler, balansräkning, resultaträkning och SIE-filer.",
    group: "Flöden",
  },
  {
    slug: "rapporter",
    title: "Rapporter",
    file: "rapporter.md",
    description: "Leveransprecision, försäljnings- och inköpsstatistik, kassationsstatistik och kalkylutfall.",
    group: "Flöden",
  },
  {
    slug: "system",
    title: "System & inställningar",
    file: "system.md",
    description: "Användare, företagsinformation, nummerserier, integrationer och inställningar.",
    group: "System",
  },
  {
    slug: "drift-utveckling",
    title: "Drift & utveckling",
    file: "drift-utveckling.md",
    description: "Projektstruktur, manualens plats, testkörning och tekniska begränsningar.",
    group: "System",
  },
];

export function getChapter(slug: string): ManualChapter | undefined {
  return MANUAL_CHAPTERS.find((c) => c.slug === slug);
}

// docs/manual sits at the repo root, two levels above apps/web.
const MANUAL_DIR = path.join(process.cwd(), "..", "..", "docs", "manual");

export async function loadChapterHtml(chapter: ManualChapter): Promise<string> {
  const markdown = await readFile(path.join(MANUAL_DIR, chapter.file), "utf8");
  return renderer.parse(markdown, { async: false });
}
