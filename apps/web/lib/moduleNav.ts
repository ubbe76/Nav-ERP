// The application's navigation structure, in one place (TODO2 #14).
//
// The sidebar carries one entry per module and nothing more — every function
// inside a module is reached from that module's own page, rendered as a grid
// of grouped cards (HubSections). This file is what those grids are built
// from, and it is deliberately the ONLY place the structure is written down.
//
// Why one file: the sidebar submenu and the module hub pages used to be
// maintained separately, and they had already drifted — /tillverkning's hub
// was missing Behovsberäkning and Beläggning long after both shipped, because
// only the sidebar was updated. With the submenu gone the hub is the sole way
// in, so a missed entry is no longer cosmetic: the page becomes unreachable.
//
// `roles` mirrors the guard the page itself enforces server-side, exactly as
// the page's own role guard — a link the role can't open was never
// anything but a dead end. Omitted means "same audience as an unguarded page".
// Modules that are admin-only end to end (Ekonomi, Rapporter, System) carry no
// per-item roles; their whole page is gated instead.

import { canOpen } from "./pageAccess";
import type { Permission } from "./permissions";

export type NavRole = "admin" | "supervisor";

export interface ModuleNavItem {
  href: string;
  title: string;
  description: string;
  roles?: NavRole[];
}

export interface ModuleNavSection {
  title: string;
  items: ModuleNavItem[];
}

// Drops the items a user can't open — the page-access table (pageAccess.ts)
// decides, plus the item's own `roles` (mirrors the role guard some pages
// still enforce on top, e.g. Attestering) — then any section left empty.
export function sectionsForUser(
  sections: ModuleNavSection[],
  user: { role: string; permissions: readonly Permission[] }
): ModuleNavSection[] {
  const role = user.role as "admin" | "supervisor" | "user";
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          (!item.roles || role === "admin" || item.roles.includes(role as NavRole)) &&
          canOpen({ role, permissions: user.permissions }, item.href)
      ),
    }))
    .filter((section) => section.items.length > 0);
}

export const ARTIKLAR_SECTIONS: ModuleNavSection[] = [
  {
    title: "Artiklar",
    items: [
      {
        href: "/artiklar/register",
        title: "Artikelregister",
        description:
          "Alla artiklar med typ, grundenhet och status — artikelkortet bär struktur, inköp, försäljning, lager, kalkyl och ritningar.",
      },
      {
        href: "/artiklar/oversikt",
        title: "Artikelöversikt",
        description:
          "Alla öppna behov och inkommande för en artikel, rad för rad i datumordning med löpande disponibelt antal.",
      },
      {
        href: "/artiklar/import",
        title: "Importera artiklar",
        description: "Läs in artiklar, strukturer, operationer och priser från CSV- eller Excel-filer.",
        roles: ["admin"],
      },
    ],
  },
  {
    title: "Grunddata",
    items: [
      {
        href: "/artikelgrupper",
        title: "Artikelgrupper",
        description: "Grupper för kontering, statistik och rapportuppdelning — 3–4-siffrig kod per grupp.",
      },
      {
        href: "/grunddata",
        title: "Grunddata",
        description: "Enheter med omräkningsfaktor, kollityper, leverans- och betalningsvillkor samt speditörer.",
      },
    ],
  },
];

export const INKOP_SECTIONS: ModuleNavSection[] = [
  {
    title: "Inköp",
    items: [
      {
        href: "/inkop/ordrar",
        title: "Inköpsorder",
        description: "Registrera, skicka och följ inköpsordrar från utkast till mottagen.",
      },
      {
        href: "/inkop/forfragningar",
        title: "Förfrågningar",
        description: "Prisförfrågan till leverantör som konverteras till inköpsorder när svaret kommer.",
      },
      {
        href: "/inkop/inleverans",
        title: "Inleverans",
        description: "Rapportera mottaget gods på en hel inköpsorder — restantal förifylls per rad.",
      },
    ],
  },
  {
    title: "Leverantörsfakturor",
    items: [
      {
        href: "/inkop/leverantorsfakturor",
        title: "Leverantörsfakturor",
        description: "Registrera och attestera leverantörsfakturor, med valfri matchning mot inköpsorderraden.",
      },
      {
        href: "/inkop/fakturaunderlag",
        title: "Fakturaunderlag",
        description: "Inlevererade inköpsordrar som väntar på leverantörsfaktura.",
      },
    ],
  },
  {
    title: "Reskontra",
    items: [
      {
        href: "/inkop/reskontra",
        title: "Öppna poster",
        description: "Obetalda leverantörsfakturor med förfallodatum och återstående belopp.",
      },
      {
        href: "/inkop/betalningar",
        title: "Betalningar",
        description: "Registrera utbetalningar mot öppna poster — bokförs automatiskt i serie U.",
      },
      {
        href: "/inkop/betalfiler",
        title: "Betalfiler",
        description: "Betalningsomgångar till banken (pain.001) — skapas från Öppna poster och bokförs när banken bekräftat.",
      },
      {
        href: "/inkop/bankfiler",
        title: "Bankfiler",
        description: "Läs in bankens debiteringsavier (camt.054) och bokför utförda betalningar.",
      },
    ],
  },
  {
    title: "Register",
    items: [
      {
        href: "/leverantorer",
        title: "Leverantörer",
        description: "Leverantörsregistret med villkor, frakt, kontakter och vårt kundnummer hos leverantören.",
      },
      {
        href: "/grunddata",
        title: "Grunddata",
        description: "Leveransvillkor, betalningsvillkor och speditörer som delas med försäljningssidan.",
      },
    ],
  },
];

export const FORSALJNING_SECTIONS: ModuleNavSection[] = [
  {
    title: "Order",
    items: [
      {
        href: "/forsaljning/offerter",
        title: "Offerter",
        description:
          "Offerter med giltighetstid, uppföljning och förlorade affärer — bekräftad offert blir kundorder med eget KO-nummer.",
      },
      {
        href: "/forsaljning/ordrar",
        title: "Kundorder",
        description: "Kundorder och orderbekräftelse — från bekräftad order till levererad och fakturerad.",
      },
      {
        href: "/forsaljning/utleverans",
        title: "Utleverans",
        description: "Rapportera levererat gods på en hel kundorder och skapa följesedel.",
      },
      {
        href: "/forsaljning/leveranstidskontroll",
        title: "Leveranstidskontroll",
        description: "Tidigaste avsändnings- och leveransdag för valfria artiklar och antal — lager, inköp och kapacitet.",
      },
      {
        href: "/forsaljning/forsandelser",
        title: "Försändelser",
        description: "Transportbokning via Sendify — priser, bokning, fraktsedel och avbokning.",
      },
    ],
  },
  {
    title: "Fakturering",
    items: [
      {
        href: "/forsaljning/fakturor",
        title: "Fakturor",
        description: "Kundfakturor med delfakturering, samlingsfaktura och kreditfaktura.",
      },
      {
        href: "/forsaljning/samlingsfakturering",
        title: "Samlingsfakturering",
        description: "En faktura per kund för alla levererade, ofakturerade order hos kunder med Samlingsfaktura.",
      },
      {
        href: "/forsaljning/rantefakturering",
        title: "Räntefakturering",
        description: "Dröjsmålsränta och förseningsersättning på förfallna och sent betalda fakturor — en räntefaktura per kund.",
      },
      {
        href: "/forsaljning/prislistor",
        title: "Prislistor",
        description: "Prislistor med staffelpriser som kunder kopplas till — grunden i priskedjan.",
      },
    ],
  },
  {
    title: "Reskontra",
    items: [
      {
        href: "/forsaljning/reskontra",
        title: "Öppna poster",
        description: "Obetalda kundfakturor med förfallodatum, påminnelser och återstående belopp.",
      },
      {
        href: "/forsaljning/betalningar",
        title: "Betalningar",
        description: "Registrera inbetalningar med OCR-uppslag, tolerans och kvittning.",
      },
      {
        href: "/forsaljning/bankfiler",
        title: "Bankfiler",
        description: "Läs in inbetalningar (camt.054) — matchas på OCR och bokförs i serie K.",
      },
    ],
  },
  {
    title: "Register",
    items: [
      {
        href: "/kunder",
        title: "Kunder",
        description: "Kundregistret med villkor, adresser, kontakter och kundspecifika priser.",
      },
      {
        href: "/grunddata",
        title: "Grunddata",
        description: "Leveransvillkor, betalningsvillkor och speditörer som delas med inköpssidan.",
      },
    ],
  },
];

export const TILLVERKNING_SECTIONS: ModuleNavSection[] = [
  {
    title: "Ordrar",
    items: [
      {
        href: "/tillverkning/ordrar",
        title: "Tillverkningsordrar",
        description: "Planera, frisläpp och färdigrapportera tillverkningsordrar med material och operationer.",
      },
    ],
  },
  {
    title: "Verkstad",
    items: [
      {
        href: "/tillverkning/terminal",
        title: "Stämpelterminal",
        description: "Helskärmsvy för verkstaden: personal stämplar in och ut på order, närvaro och ATF.",
      },
      {
        href: "/tillverkning/pagaende",
        title: "Pågående arbete",
        description: "Vem som är instämplad på vilken order just nu, och vem som är på plats utan arbete.",
      },
      {
        href: "/tillverkning/tidrapporter",
        title: "Tidrapporter",
        description: "Rapportera och följ upp arbetad tid per operation.",
      },
    ],
  },
  {
    title: "Planering",
    items: [
      {
        href: "/tillverkning/behovsberakning",
        title: "Behovsberäkning",
        description: "Nettobehov per artikel med beställningspunkt — skapar inköps- och tillverkningsförslag.",
      },
      {
        href: "/tillverkning/belaggning",
        title: "Beläggning",
        description: "Last per resurs och vecka mot schemalagd kapacitet.",
      },
      {
        href: "/tillverkning/scheman",
        title: "Scheman",
        description: "Dagsscheman, veckoscheman och helgdagar — grunden för kalendrar och löneunderlag.",
      },
    ],
  },
  {
    title: "Resurser",
    items: [
      {
        href: "/tillverkning/resurser",
        title: "Resurser",
        description: "Maskiner och personal med timkostnad och omkostnadspåslag, används i operationer och kalkyl.",
      },
      {
        href: "/tillverkning/grupper",
        title: "Produktionsgrupper",
        description: "Grupper av resurser för planering och tidrapportering.",
      },
      {
        href: "/tillverkning/legoresurser",
        title: "Legoresurser",
        description: "Externa leverantörer som utför operationer — ställ- och styckpris per operation, inköp via behovsberäkningen.",
      },
    ],
  },
];

export const PERSONAL_SECTIONS: ModuleNavSection[] = [
  {
    title: "Personal",
    items: [
      {
        href: "/personal/anstallda",
        title: "Anställda",
        description: "Anställda med kontakt- och anställningsuppgifter, scheman, frånvaro och ATF.",
        roles: ["admin", "supervisor"],
      },
    ],
  },
  {
    title: "Löneperiod",
    items: [
      {
        href: "/personal/attestering",
        title: "Attestering",
        description: "Gå igenom och attestera personalens närvaro, frånvaro och tid per löneperiod.",
        roles: ["admin", "supervisor"],
      },
      {
        href: "/personal/loneunderlag",
        title: "Löneunderlag",
        description: "Periodens löneunderlag per anställd med lönekoder och PAXml-export.",
        roles: ["admin", "supervisor"],
      },
    ],
  },
  {
    title: "Inställningar",
    items: [
      {
        href: "/personal/lonekoder",
        title: "Lönekoder",
        description: "Frånvarokoder, OB-tillägg och avvikelseorsaker för löneunderlaget och stämpelterminalen.",
        roles: ["admin"],
      },
      {
        // The panel lives under System → Inställningar (admin-only end to end).
        href: "/system/installningar",
        title: "Lön & PAXml",
        description: "Tidkoder för PAXml-exporten, övertidsregler och anledning vid sen ankomst — panelen Lön & PAXml under System → Inställningar.",
        roles: ["admin"],
      },
    ],
  },
];

export const LAGER_SECTIONS: ModuleNavSection[] = [
  {
    title: "Saldon & rörelser",
    items: [
      {
        href: "/lager/saldon",
        title: "Saldon",
        description: "Saldo per artikel och lagerplats, härlett ur transaktionsloggen.",
      },
      {
        href: "/lager/transaktioner",
        title: "Transaktioner",
        description: "Hela lagerloggen — varje in- och utflöde med typ, antal, plats och referens.",
      },
    ],
  },
  {
    title: "Lagerstruktur",
    items: [
      {
        href: "/lager/platser",
        title: "Lagerplatser",
        description: "Lager och lagerplatser, inklusive avställda platser med historik.",
      },
      {
        href: "/lager/flytta",
        title: "Lagerflytt",
        description: "Flytta saldo mellan lagerplatser — bokförs som två transaktioner med gemensam referens.",
      },
    ],
  },
  {
    title: "Avstämning",
    items: [
      {
        href: "/lager/inventering",
        title: "Inventering",
        description: "Inventeringssessioner per lagerplats med blind räknelista och valfri spärr under räkning.",
        roles: ["admin"],
      },
      {
        href: "/lager/justering",
        title: "Justering",
        description: "Enstaka lagerjustering av en artikel med orsak och lagerplats.",
      },
      {
        href: "/rapporter/marginal",
        title: "Marginal",
        description: "Täckningsbidrag på fakturerad omsättning per månad, kund eller artikel.",
      },
      {
        href: "/rapporter/projektrapport",
        title: "Projektrapport",
        description: "Intäkter, kostnader och resultat per projekt ur bokföringen, med månadsfördelning, konton och länkade kundordrar.",
      },
      {
        href: "/lager/vardering",
        title: "Lagervärdering",
        description: "Lagervärde per valfritt datum — standardpris, senaste inköp eller vägt snitt.",
        roles: ["admin"],
      },
    ],
  },
];

export const EKONOMI_SECTIONS: ModuleNavSection[] = [
  {
    title: "Bokföring",
    items: [
      {
        href: "/ekonomi/verifikat",
        title: "Verifikat",
        description: "Grundboken — manuella verifikat och alla automatkonterade verifikat per serie.",
      },
      {
        href: "/ekonomi/verifikatmallar",
        title: "Verifikatmallar",
        description: "Färdiga uppsättningar rader för verifikat du bokför ofta — används av Ny från mall och återkommande verifikat.",
      },
      {
        href: "/ekonomi/aterkommande-verifikat",
        title: "Återkommande verifikat",
        description: "Verifikat som skapas varje månad ur en mall, och kostnader eller intäkter som fördelas över flera perioder.",
      },
      {
        href: "/ekonomi/huvudbok",
        title: "Huvudbok",
        description: "Bokförda transaktioner per konto med ingående och utgående balans.",
      },
      {
        href: "/ekonomi/bankavstamning",
        title: "Bankavstämning",
        description: "Importera kontoutdrag från banken, matcha posterna mot bokföringen, bokför det som saknas och markera kontot som avstämt.",
      },
      {
        href: "/ekonomi/anlaggningar",
        title: "Anläggningsregister",
        description: "Anläggningstillgångar med planenlig avskrivning i serie AV.",
      },
      {
        href: "/ekonomi/bokslut",
        title: "Bokslut",
        description: "Årsbokslut steg för steg — lager, avskrivningar, periodiseringar, valutaomvärdering, resultatöverföring och stängning av räkenskapsåret.",
      },
    ],
  },
  {
    title: "Rapporter",
    items: [
      {
        href: "/ekonomi/balansrakning",
        title: "Balansräkning",
        description: "Tillgångar, eget kapital och skulder per valfritt datum, i BAS-uppställning.",
      },
      {
        href: "/ekonomi/resultatrakning",
        title: "Resultaträkning",
        description: "Intäkter och kostnader för en vald period, i BAS-uppställning.",
      },
      {
        href: "/ekonomi/momsrapport",
        title: "Momsrapport",
        description: "Momsdeklarationens alla rutor per månad, kvartal eller helår — med fil till Skatteverket, momsomföring i serie M och importmoms.",
      },
      {
        href: "/ekonomi/budget",
        title: "Budget",
        description: "Planerade intäkter och kostnader per konto och månad, med kostnadsställen — jämförs mot utfallet i resultaträkningen.",
      },
      {
        href: "/ekonomi/periodisk-sammanstallning",
        title: "Periodisk sammanställning",
        description: "EU-försäljning per köparens momsnummer för månad eller kvartal, avstämd mot momsrapporten, med fil till Skatteverket.",
      },
      {
        href: "/ekonomi/avskrivningsplan",
        title: "Avskrivningsplan",
        description: "Anskaffningsvärden, årets avskrivningar och bokfört värde per grupp, med avstämning mot huvudboken.",
      },
    ],
  },
  {
    title: "Grunddata",
    items: [
      {
        href: "/ekonomi/kontoplan",
        title: "Kontoplan",
        description: "Konton med BAS-urval — namn, typ och om kontot är aktivt.",
      },
      {
        href: "/ekonomi/rakenskapsar",
        title: "Räkenskapsår",
        description: "Räkenskapsår med månadsperioder som låses när perioden är klar.",
      },
      {
        href: "/ekonomi/konteringsregler",
        title: "Konteringsregler",
        description: "Styr vilket konto en rad hamnar på, per artikelgrupp och momskod.",
      },
      {
        href: "/ekonomi/momskoder",
        title: "Momskoder",
        description: "Hur en rad beskattas — svensk moms, EU-handel, export, omvänd moms och import — med konton, momsrutor och fakturatext.",
      },
      {
        href: "/ekonomi/bankkonton",
        title: "Bankkonton",
        description: "Företagets bankkonton med IBAN eller kontonummer, huvudbokskonto och sparad CSV-mappning.",
      },
      {
        href: "/ekonomi/bankregler",
        title: "Bankregler",
        description: "Känner igen återkommande poster på kontoutdraget — avgifter, ränta, skattekonto — och föreslår konto och momskod.",
      },
      {
        href: "/ekonomi/valutakurser",
        title: "Valutakurser",
        description: "Dagskurser från Riksbanken och egna kurser för fakturor och utbetalningar i utländsk valuta.",
      },
      {
        href: "/ekonomi/referensranta",
        title: "Referensränta",
        description: "Riksbankens referensränta per halvår — grunden för dröjsmålsräntan på räntefakturorna.",
      },
      {
        href: "/ekonomi/anlaggningsgrupper",
        title: "Anläggningsgrupper",
        description: "Tillgångsgrupper med konton och förvald nyttjandetid.",
      },
      {
        href: "/ekonomi/kostnadsstallen",
        title: "Kostnadsställen",
        description: "Avdelningar att följa resultatet per — väljs på verifikatrader, fakturor och orderhuvuden.",
      },
      {
        href: "/ekonomi/projekt",
        title: "Projekt",
        description: "Projekt med kund, start och slut, som öppna eller stängda — resultatet följs i resultaträkningen och Projektrapporten.",
      },
      {
        href: "/ekonomi/sie",
        title: "SIE-filer",
        description: "Exportera räkenskapsåret som SIE 4 eller importera ingående balanser och verifikat, till exempel lönejournalen.",
      },
    ],
  },
];

export const RAPPORTER_SECTIONS: ModuleNavSection[] = [
  {
    title: "Rapporter",
    items: [
      {
        href: "/rapporter/orderforteckning-kundorder",
        title: "Orderförteckning kundorder",
        description: "Kundordrar med ordervärde och restvärde, per order eller med rader — urval på datum, kund, status och artikel.",
      },
      {
        href: "/rapporter/orderforteckning-inkop",
        title: "Orderförteckning inköp",
        description: "Inköpsordrar med ordervärde och restvärde, per order eller med rader — urval på datum, leverantör, status och artikel.",
      },
      {
        href: "/rapporter/offertuppfoljning",
        title: "Offertuppföljning",
        description: "Hur stor andel av offerterna som blir order — hit rate per kund, månad och förlustorsak.",
      },
      {
        href: "/rapporter/leveransprecision",
        title: "Leveransprecision",
        description: "Hur väl lovade leveransdatum hålls, för kundordrar och inköpsordrar var för sig.",
      },
      {
        href: "/rapporter/forsaljningsstatistik",
        title: "Försäljningsstatistik",
        description: "Fakturerad nettoomsättning ur kundfakturorna, per månad, kund eller artikel.",
      },
      {
        href: "/rapporter/inkopsstatistik",
        title: "Inköpsstatistik",
        description: "Leverantörsfakturorna summerade per månad, leverantör eller artikel.",
      },
      {
        href: "/rapporter/kassation",
        title: "Kassationsstatistik",
        description: "Kassationer från tillverkningens avrapporteringar, per månad, artikel, resurs eller orsak.",
      },
      {
        href: "/rapporter/kalkylutfall",
        title: "Kalkylutfall",
        description: "Förkalkyl mot efterkalkyl per tillverkningsorder — styck-TVK och avvikelse.",
      },
      {
        href: "/rapporter/marginal",
        title: "Marginal",
        description: "Täckningsbidrag på fakturerad omsättning per månad, kund eller artikel.",
      },
      {
        href: "/lager/vardering",
        title: "Lagervärdering",
        description: "Lagervärde per valfritt datum — standardpris, senaste inköp eller vägt snitt.",
        roles: ["admin"],
      },
    ],
  },
];

export const SYSTEM_SECTIONS: ModuleNavSection[] = [
  {
    title: "Användare & åtkomst",
    items: [
      {
        href: "/system/anvandare",
        title: "Användare",
        description: "Skapa och redigera användarkonton, roller och åtkomst.",
      },
      {
        href: "/system/behorighetsgrupper",
        title: "Behörighetsgrupper",
        description: "Vilka menyer varje grupp får använda, och verkstadsprofilen.",
      },
      {
        href: "/system/integrationer",
        title: "Integrationer",
        description: "API-klienter för externa system, t.ex. produktkonfiguratorn.",
      },
      {
        href: "/system/frakt",
        title: "Frakt",
        description: "Sendify-koppling, avsändare, påslag, upphämtningstider och transportörsprodukter.",
      },
      {
        href: "/system/e-faktura",
        title: "E-faktura",
        description: "B2Brouter-koppling för Peppol — nyckel, miljö, testa anslutningen och se vilka företagsuppgifter som skickas.",
      },
      {
        href: "/system/tillagg",
        title: "Tillägg",
        description: "Installera externa program som läser Nav via API:t, tar emot händelser och visar egna sidor och flikar.",
      },
    ],
  },
  {
    title: "Företagsdata",
    items: [
      {
        href: "/system/kom-igang",
        title: "Kom igång",
        description: "Checklistan för en ny installation — företag, användare, register, grunddata, ekonomi och e-post.",
      },
      {
        href: "/system/foretagsinfo",
        title: "Företagsinformation",
        description: "Företagsuppgifter och logotyp för dokument som inköpsorder och ordererkännande.",
      },
      {
        href: "/system/bank",
        title: "Bank",
        description: "Bank, avtals-ID och debiteringskonto för betalfiler och bankavier (ISO 20022).",
      },
      {
        href: "/system/nummerserier",
        title: "Nummerserier",
        description: "Prefix, nästa nummer och antal siffror för inköps-, kund- och tillverkningsorder.",
      },
      {
        href: "/system/exempeldata",
        title: "Exempeldata",
        description: "Skapa ett påhittat företag med artiklar, struktur, kunder och leverantörer att prova systemet med.",
      },
    ],
  },
  {
    title: "Beteende",
    items: [
      {
        href: "/system/installningar",
        title: "Inställningar",
        description: "Systembeteenden, t.ex. parallella stämplingar, ATF-intjäning och e-post (SMTP).",
      },
      {
        href: "/system/teman",
        title: "Teman",
        description: "Förvalt tema, lås och egna färgteman — ladda upp en temafil eller skapa ett tema i redigeraren.",
      },
      {
        href: "/system/kalkyler",
        title: "Kalkyler",
        description: "Var materialkostnaden hämtas och påslagen som ger försäljningspriset i för- och efterkalkylen.",
      },
      {
        href: "/system/e-postlogg",
        title: "E-postlogg",
        description: "Alla utgående mejl med status — skicka om misslyckade utskick.",
      },
      {
        href: "/system/sakerhetskopiering",
        title: "Säkerhetskopiering",
        description: "Ladda ner en säkerhetskopia av databasen och se när den senast togs.",
      },
      {
        href: "/system/handelselogg",
        title: "Händelselogg",
        description: "Vem gjorde vad och när — statusövergångar och radändringar i hela systemet.",
      },
    ],
  },
];
