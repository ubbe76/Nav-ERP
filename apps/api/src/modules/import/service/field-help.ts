// Field help for the import wizard, the Excel templates and the manual
// chapter Importmallar — ONE source for all three (spec
// docs/superpowers/specs/2026-10-22-importmallar-design.md). Pure data: no
// DB, no planner imports; the entity field lists it mirrors live in each
// planner (ARTICLE_IMPORT_FIELDS in articles.ts and so on) and
// import-field-help.test.ts keeps the two in step both ways.
//
// Every text describes what the planner ACTUALLY does — formats, accepted
// words, what an empty cell means, what a new versus an existing record
// needs — so a change to a planner rule is a change here too. `header` is
// the template's column heading and must be recognised by the entity's own
// alias dictionary (suggest…Mapping) so a filled-in template maps itself;
// `label` and `required` mirror apps/web/lib/importFields.ts. Examples are
// made up (a stainless-steel catering furniture maker, like the demo data).
import type { ImportEntity, ImportFieldHelp } from "@navet/shared";

// The template-only extra: `text` columns get Excel's Text cell format in the
// template (xlsx-writer's textColumns), because Excel would otherwise turn
// what is typed there into a number or a date — 007 into 7, 0123 into 123, a
// postal code or phone number into a number, 10 % into 0,1. Numbers, codes,
// postal codes, phone numbers, org/VAT numbers and percentages. Not part of
// the /fields answer (importFieldHelp strips it).
export interface FieldHelpEntry extends ImportFieldHelp {
  text?: boolean;
}

// Shared phrases — the planners' vocabularies are shared the same way.
const DECIMAL = "decimalkomma eller punkt";
const DECIMAL_CAP = "Decimalkomma eller punkt";
const YES_NO = "Ja/Nej, 1/0 eller true/false";
const YES_NO_X = "Ja/Nej, 1/0, X eller true/false";
const UNTOUCHED = "Tom cell lämnar fältet orört på en befintlig post.";

const ARTICLE_TYPE_WORDS =
  "Tillverkad (även M), Köpt (även P eller K), Tjänst (även Lego) eller Fiktiv (även F) — Fiktiv ger en tillverkad fantomartikel.";

export const IMPORT_FIELD_HELP: Record<ImportEntity, FieldHelpEntry[]> = {
  articles: [
    {
      field: "articleNumber",
      label: "Artikelnummer",
      required: true,
      header: "Artikelnummer",
      text: true,
      description:
        "Artikelns unika nummer, max 50 tecken. Finns numret redan uppdateras artikeln, annars skapas en ny. Mallens kolumn är textformaterad så att inledande nollor behålls.",
      example: "SB-1200",
    },
    {
      field: "name",
      label: "Benämning",
      required: false,
      header: "Benämning",
      description: `Artikelns namn, max 255 tecken. Krävs för nya artiklar. ${UNTOUCHED}`,
      example: "Diskbänk 1200 mm, rostfri",
    },
    {
      field: "type",
      label: "Artikeltyp",
      required: false,
      header: "Artikeltyp",
      description: `${ARTICLE_TYPE_WORDS} Tom cell ger guidens Standardtyp för nya artiklar. Typen och fantomflaggan ändras aldrig på befintliga artiklar — en avvikelse ger en varning.`,
      example: "Tillverkad",
    },
    {
      field: "unitCode",
      label: "Enhet",
      required: false,
      header: "Enhet",
      text: true,
      description:
        "Grundenhetens kod, max 20 tecken (t.ex. st, kg, m). En okänd kod skapas i enhetsregistret med koden som namn; tom cell ger st för nya artiklar. Grundenheten ändras aldrig på befintliga artiklar.",
      example: "st",
    },
    {
      field: "groupCode",
      label: "Varugrupp (kod)",
      required: false,
      header: "Varugrupp (kod)",
      text: true,
      description: `Varugruppens kod, 1–4 siffror. Varugruppen styr artikelns kontering och momssats. En kod som saknas i registret skapas med koden som namn och 25 % moms. ${UNTOUCHED}`,
      example: "1",
    },
    {
      field: "articleCode",
      label: "Artikelkod",
      required: false,
      header: "Artikelkod",
      text: true,
      description: `Artikelkodens kod, max 20 tecken — ett urvals- och grupperingsbegrepp i listorna (Grunddata → Artikelkoder). En kod som saknas i registret skapas med koden som namn. ${UNTOUCHED}`,
      example: "100",
    },
    {
      field: "standardCost",
      label: "Standardpris",
      required: false,
      header: "Standardpris",
      description: `Standardkostnad per grundenhet i SEK, ${DECIMAL}, aldrig negativ (t.ex. 1 250,50). Tom cell lämnar fältet orört; ett annat värde än det sparade uppdaterar artikeln.`,
      example: "1250,50",
    },
    {
      field: "weight",
      label: "Vikt (kg)",
      required: false,
      header: "Vikt (kg)",
      description: `Vikt i kilogram per grundenhet, ${DECIMAL}, aldrig negativ. ${UNTOUCHED}`,
      example: "18,5",
    },
    {
      field: "surfaceTreatment",
      label: "Ytbehandling",
      required: false,
      header: "Ytbehandling",
      description: `Fritext, max 200 tecken. ${UNTOUCHED}`,
      example: "Borstad",
    },
    {
      field: "colour",
      label: "Färg",
      required: false,
      header: "Färg",
      description: `Fritext, max 200 tecken. ${UNTOUCHED}`,
      example: "Rostfri",
    },
    {
      field: "extraDescription",
      label: "Extra benämning",
      required: false,
      header: "Extra benämning",
      description: `Fritext bredvid benämningen, max 2 000 tecken — radbrytningar i cellen behålls (Alt+Enter i Excel). Skrivs ut på de dokument som valts under System → Inställningar. ${UNTOUCHED}`,
      example: "Rostfritt slipat, levereras i delar",
    },
    {
      field: "active",
      label: "Aktiv",
      required: false,
      header: "Aktiv",
      description: `${YES_NO}. Tom cell betyder aktiv för nya artiklar och lämnar befintliga orörda.`,
      example: "Ja",
    },
    {
      field: "reorderPoint",
      label: "Beställningspunkt",
      required: false,
      header: "Beställningspunkt",
      description: `Nivån i grundenhet som behovsberäkningen fyller upp till: den jämför med det beräknade saldot (lager + inkommande − behov) och föreslår skillnaden när saldot ligger under. ${DECIMAL_CAP}, aldrig negativ. 0 betyder ingen beställningspunkt och tömmer fältet; tom cell lämnar det orört.`,
      example: "10",
    },
    {
      field: "orderQuantity",
      label: "Orderkvantitet",
      required: false,
      header: "Orderkvantitet",
      description:
        "Fast orderstorlek i grundenhet — förslag rundas upp till en multipel av den. Importeras bara när Partiformningsregel är Fast orderstorlek eller den kolumnen saknas; finns kolumnen men är regeln något annat eller tom hoppas Orderkvantitet över med en varning. 0 tömmer fältet; tom cell lämnar det orört.",
      example: "25",
    },
    {
      field: "rounding",
      label: "Avrundning",
      required: false,
      header: "Avrundning",
      description:
        "Steg i grundenhet som orderantal rundas upp till, större än 0 och högst 3 decimaler (fler avrundas med en varning). 0 tömmer fältet; tom cell lämnar det orört.",
      example: "1",
    },
    {
      field: "lotSizingRule",
      label: "Partiformningsregel",
      required: false,
      header: "Partiformningsregel",
      description:
        "Lagras inte — styr bara om Orderkvantitet läses: Fast orderstorlek betyder att kvantiteten importeras, allt annat (t.ex. Mot behov) och tom cell att den hoppas över på raden, med en varning. Ta bort kolumnen för att alltid läsa Orderkvantitet.",
      example: "Fast orderstorlek",
    },
    {
      field: "articleRevision",
      label: "Artikelrevision",
      required: false,
      header: "Artikelrevision",
      description:
        "Artikelns aktiva revision, max 20 tecken. Saknar artikeln revisionen läggs den till; den blir aktiv och den tidigare aktiva ligger kvar som inaktiv (förhandsgranskningen varnar när den aktiva byts). Importen tar aldrig bort en revision. Tom cell lämnar revisionerna orörda.",
      example: "B",
      text: true,
    },
    {
      field: "drawingNumber",
      label: "Ritningsnummer",
      required: false,
      header: "Ritningsnummer",
      description:
        "Ett ritningsnummer på artikeln, max 50 tecken. Saknar artikeln numret läggs det till — artikelns andra ritningsnummer ligger kvar, importen tar aldrig bort något. Varje rad ger ett ritningsnummer, och ett artikelnummer får bara förekomma en gång per fil — har en artikel flera ritningar importeras de övriga i en ny körning. Tom cell lämnar ritningarna orörda.",
      example: "R-63010",
      text: true,
    },
    {
      field: "drawingRevision",
      label: "Ritningsrevision",
      required: false,
      header: "Ritningsrevision",
      description:
        "Den aktiva revisionen för ritningsnumret på samma rad, max 20 tecken — kräver Ritningsnummer på raden. Saknas revisionen läggs den till; den blir aktiv och den tidigare aktiva ligger kvar som inaktiv. Tom cell lämnar ritningens revisioner orörda.",
      example: "C",
      text: true,
    },
    {
      field: "quantityPerPackage",
      label: "Antal per förpackning",
      required: false,
      header: "Antal per förpackning",
      description: `Hur många av artikelns grundenhet som ryms i en förpackning (Inköp-fliken). ${DECIMAL_CAP}, högst 4 decimaler — fler avrundas med en varning. 0 tömmer fältet. ${UNTOUCHED}`,
      example: "25",
    },
    {
      field: "primarySupplierNumber",
      label: "Leverantörsnr",
      required: false,
      header: "Leverantörsnummer",
      text: true,
      description:
        "Artikelns förvalda leverantör på Inköp-fliken. Leverantören måste finnas i leverantörsregistret — importera leverantörerna först. Har artikeln ingen rad för leverantören läggs en till utan pris (priserna kommer med inköpsprislistan); den tidigare förvalda leverantören blir kvar men inte förvald. Tom cell lämnar leverantörerna orörda.",
      example: "20015",
    },
  ],

  articleUnits: [
    {
      field: "articleNumber",
      label: "Artikelnummer",
      required: true,
      header: "Artikelnummer",
      text: true,
      description: "Numret på en artikel som redan finns i artikelregistret.",
      example: "RS-12",
    },
    {
      field: "unitCode",
      label: "Enhet",
      required: true,
      header: "Enhet",
      text: true,
      description:
        "Den alternativa enhetens kod, max 20 tecken. En okänd kod skapas i enhetsregistret. Samma enhet och artikel får bara förekomma en gång i filen.",
      example: "m",
    },
    {
      field: "factor",
      label: "Omräkningsfaktor",
      required: true,
      header: "Omräkningsfaktor",
      description: `Antal grundenheter per en alternativ enhet, större än 0, ${DECIMAL} — med grundenhet kg betyder 0,89 på raden m att en meter väger 0,89 kg. Lagras inverterat som alternativa enheter per grundenhet med sex decimaler. Faktor 1 markerar grundenhetsraden, som hoppas över (ska ha artikelns grundenhet, annars en varning).`,
      example: "0,89",
    },
    {
      field: "isPurchaseUnit",
      label: "Inköpsenhet (Inköpsorder)",
      required: false,
      header: "Inköpsenhet",
      description: `${YES_NO_X}; tom cell betyder Nej. Ja gör enheten till artikelns inköpsenhet (förvalet på inköpsorderrader) — högst en per artikel i filen.`,
      example: "Ja",
    },
    {
      field: "isSalesUnit",
      label: "Försäljningsenhet (Kundorder)",
      required: false,
      header: "Försäljningsenhet",
      description: `${YES_NO_X}; tom cell betyder Nej. Ja gör enheten till artikelns försäljningsenhet (förvalet på kundorderrader) — högst en per artikel i filen.`,
      example: "Nej",
    },
  ],

  routing: [
    {
      field: "articleNumber",
      label: "Artikelnummer",
      required: true,
      header: "Artikelnummer",
      text: true,
      description:
        "Numret på en artikel som redan finns i artikelregistret. En artikel som inte är tillverkad importeras med en varning — operationen används inte vid tillverkning.",
      example: "SB-1200",
    },
    {
      field: "sequenceNo",
      label: "Sekvensnr",
      required: true,
      header: "Sekvensnr",
      description:
        "Operationens ordningsnummer på artikeln, heltal större än 0 (t.ex. 10, 20, 30). Artikel + sekvensnr är nyckeln: finns operationen redan blir raden ett fel, hoppas över med Hoppa över rader som redan finns, eller skrivs över med Uppdatera befintliga operationer.",
      example: "10",
    },
    {
      field: "workCenterCode",
      label: "Resurs",
      required: true,
      header: "Resurs",
      text: true,
      description:
        "Resursens tresiffriga nummer i resursregistret (Tillverkning → Resurser) — resursen måste finnas. 1–2 siffror fylls ut med nollor (7 blir 007). En legoresurs ger en lego-operation med tiderna 0.",
      example: "110",
    },
    {
      field: "setupTime",
      label: "Ställtid",
      required: false,
      header: "Ställtid",
      description: `Omställningstid per order i den enhet Tidsenhet anger — minuter när den kolumnen saknas eller är tom, timmar vid antal/timme. ${DECIMAL_CAP}, aldrig negativ. Skriv 0 när momentet saknar ställtid — en rad på en vanlig resurs utan ställtid blir ett radfel. På en legoresurs sparas alltid 0, och kolumnen behövs inte.`,
      example: "15",
    },
    {
      field: "runTimePerUnit",
      label: "Stycktid / Tid per enhet",
      required: false,
      header: "Stycktid",
      description: `Tid per styck i den enhet Tidsenhet anger — minuter per styck när den kolumnen saknas; vid antal/timme är värdet i stället antal styck per timme (360 blir 0,1667 min/st). ${DECIMAL_CAP}, aldrig negativ. Skriv 0 när momentet saknar stycktid — en rad på en vanlig resurs utan stycktid blir ett radfel. På en legoresurs sparas alltid 0, och kolumnen behövs inte.`,
      example: "2,5",
    },
    {
      field: "timeUnit",
      label: "Tidsenhet",
      required: false,
      header: "Tidsenhet",
      description:
        "Enheten för Ställtid och Stycktid på raden: minuter/enhet (även min), antal/timme (även st/h — ställtiden då i timmar), timmar/enhet (även tim eller h) eller sekunder/enhet (även sek eller s). Tom cell betyder minuter — även med Uppdatera befintliga operationer, där en befintlig operation då får tidsenheten minuter. Ett okänt ord ger ett fel. Lagringen är alltid minuter; antal/timme sparas med visningsenheten st/h.",
      example: "minuter/enhet",
    },
    {
      field: "costingOnly",
      label: "Kalkyl",
      required: false,
      header: "Kalkyl",
      description: `${YES_NO_X}; tom cell betyder Nej — även med Uppdatera befintliga operationer, där en befintlig kalkyloperation då blir en vanlig operation. Ja gör operationen till en kalkyloperation som bara räknas i förkalkylen och aldrig frisläpps eller rapporteras.`,
      example: "Nej",
    },
    {
      field: "comment",
      label: "Kommentar",
      required: false,
      header: "Kommentar",
      description:
        "Operationens instruktionstext, max 1 000 tecken. Kryssrutan Skriv ut kommentaren på arbetskortet i guiden avgör om den skrivs ut på TO-utskriften. Tom cell lämnar en befintlig kommentar orörd vid uppdatering.",
      example: "Kontrollera måtten mot ritningen före kantpressning",
    },
    {
      field: "description",
      label: "Beskrivning",
      required: false,
      header: "Beskrivning",
      description:
        "Operationens namn, max 255 tecken (t.ex. Kantpressning). Tom cell lämnar ett befintligt namn orört vid uppdatering.",
      example: "Laserskärning",
    },
    {
      field: "packingInstructions",
      label: "Packinstruktion",
      required: false,
      header: "Packinstruktion",
      description:
        "Packinstruktion för operationen, max 1 000 tecken. Tom cell lämnar en befintlig orörd vid uppdatering.",
      example: "Mellanlägg av papp mellan varje enhet",
    },
    {
      field: "subcontractSupplierNumber",
      label: "Legoleverantör",
      required: false,
      header: "Leverantör",
      text: true,
      description:
        "Bara för operationer på en legoresurs: leverantören som utför arbetet. Måste finnas i leverantörsregistret. Tom cell ger legoresursens egen leverantör på en ny operation och lämnar en befintlig orörd. På en vanlig resurs ignoreras kolumnen med en varning.",
      example: "20015",
    },
    {
      field: "setupPrice",
      label: "Ställpris",
      required: false,
      header: "Ställpris",
      description: `Bara för legooperationer: engångskostnaden per order i kronor. ${DECIMAL_CAP}, aldrig negativ, högst 2 decimaler — fler avrundas med en varning. ${UNTOUCHED}`,
      example: "150",
    },
    {
      field: "unitPrice",
      label: "Styckpris",
      required: false,
      header: "Styckpris",
      description: `Bara för legooperationer: kostnaden per styck i kronor. ${DECIMAL_CAP}, aldrig negativ, högst 4 decimaler — fler avrundas med en varning. ${UNTOUCHED}`,
      example: "4,50",
    },
    {
      field: "cycleTimePerUnit",
      label: "Cykeltid",
      required: false,
      header: "Cykeltid",
      description: `Operationens produktiva tid per styck, i samma enhet som Stycktid (Tidsenhet). ${DECIMAL_CAP}, aldrig negativ; 0 betyder ingen cykeltid. Ignoreras på legoresurser. ${UNTOUCHED}`,
      example: "1,5",
    },
  ],

  bom: [
    {
      field: "articleNumber",
      label: "Artikelnummer",
      required: true,
      header: "Artikelnummer",
      text: true,
      description:
        "Den överordnade (tillverkade) artikeln — måste redan finnas i artikelregistret; importera artiklarna först. En artikel som inte är tillverkad ger en varning.",
      example: "SB-1200",
    },
    {
      field: "componentNumber",
      label: "Komponentnummer",
      required: true,
      header: "Komponentnummer",
      text: true,
      description:
        "Den ingående artikeln. Måste finnas i artikelregistret om inte Skapa saknade artiklar är ikryssat — då skapas den ur radens egna kolumner. Samma komponent kan bara ligga en gång per artikel: finns den redan i strukturen blir raden ett fel (eller hoppas över med Hoppa över rader som redan finns). En artikel kan inte ingå i sin egen struktur, inte heller via flera led.",
      example: "PL-2-1500",
    },
    {
      field: "quantity",
      label: "Antal",
      required: true,
      header: "Antal",
      description: `Antal av komponenten per en enhet av den överordnade artikeln, större än 0, ${DECIMAL}. Anges i kolumnen Enhet (annars komponentens grundenhet) och lagras alltid i grundenheten.`,
      example: "2",
    },
    {
      field: "unitCode",
      label: "Enhet",
      required: false,
      header: "Enhet",
      text: true,
      description:
        "En av komponentens enheter: grundenheten eller en upplagd alternativ enhet (annars ett fel). Tom cell betyder grundenheten. För en komponent som skapas av importen blir det i stället den nya artikelns grundenhet (tom = st; en okänd kod skapas).",
      example: "st",
    },
    {
      field: "operationSequenceNo",
      label: "Operation",
      required: false,
      header: "Operation",
      description:
        "Sekvensnumret (heltal större än 0) på en av den överordnade artikelns operationer, som materialet dras vid. Tom cell, eller en operation som inte finns, ger ingen koppling — materialet dras då i takt med inleveransen av färdiga varor (en operation som inte finns ger en varning). En kalkyloperation ger ett fel.",
      example: "10",
    },
    {
      field: "position",
      label: "Pos.",
      required: false,
      header: "Pos.",
      text: true,
      description:
        "Radens position på ritningen, max 20 tecken (siffror eller text). Visas i strukturen på artikelkortets Beredning-flik. Med Uppdatera befintliga strukturrader lämnar en tom cell det sparade värdet orört.",
      example: "3",
    },
    {
      field: "componentName",
      label: "Artikelbenämning (komponenten)",
      required: false,
      header: "Komponentbenämning",
      description:
        "Läses bara för komponenter som saknas i registret när Skapa saknade artiklar är ikryssat — då obligatorisk, max 255 tecken. Befintliga artiklar ändras aldrig av strukturimporten.",
      example: "Plåt 2 mm 1500×3000",
    },
    {
      field: "componentType",
      label: "Komponentens artikeltyp",
      required: false,
      header: "Komponenttyp",
      description: `Artikeltyp för en komponent som skapas: ${ARTICLE_TYPE_WORDS} Tom cell ger guidens Standardtyp, annars Köpt. Läses bara med Skapa saknade artiklar.`,
      example: "Köpt",
    },
    {
      field: "componentStandardCost",
      label: "Komponentens standardpris",
      required: false,
      header: "Komponentens standardpris",
      description: `Standardkostnad per grundenhet för en komponent som skapas, ${DECIMAL}, aldrig negativ. Läses bara med Skapa saknade artiklar.`,
      example: "890",
    },
  ],

  supplierPrices: [
    {
      field: "articleNumber",
      label: "Artikelnummer",
      required: true,
      header: "Artikelnummer",
      text: true,
      description: "Numret på en artikel som redan finns i artikelregistret.",
      example: "PL-2-1500",
    },
    {
      field: "supplierNumber",
      label: "Leverantörsnummer",
      required: true,
      header: "Leverantörsnummer",
      text: true,
      description:
        "Numret på en leverantör som redan finns i leverantörsregistret. Alla rader med samma artikel och leverantör bildar en katalograd: den första raden ger pris och övriga uppgifter, varje rad kan bära ett staffelsteg.",
      example: "2001",
    },
    {
      field: "supplierArticleNumber",
      label: "Leverantörens artikelnummer",
      required: false,
      header: "Leverantörens artikelnummer",
      text: true,
      description: `Leverantörens eget nummer på artikeln, max 100 tecken. ${UNTOUCHED}`,
      example: "LEV-4471",
    },
    {
      field: "price",
      label: "Pris",
      required: false,
      header: "Pris",
      description: `Pris per grundenhet (antal 1) i katalogradens valuta — en ny katalograd får leverantörens valuta, en befintlig behåller sin. ${DECIMAL_CAP}, aldrig negativt; fyra decimaler sparas. Tom cell lämnar priset orört på en befintlig katalograd.`,
      example: "245,00",
    },
    {
      field: "discountPercent",
      label: "Rabatt (%)",
      required: false,
      header: "Rabatt (%)",
      text: true,
      description:
        "Procentavdrag från 0 upp till (men inte med) 100 som bakas in i radens pris och staffelpris — Pris × (1 − Rabatt/100) — med en varning, eftersom katalogen saknar rabattfält. Skriv bara talet — 10 betyder 10 %; skriv inte procenttecken. Tom cell betyder ingen rabatt.",
      example: "10",
    },
    {
      field: "isPrimary",
      label: "Huvudleverantör (Förvald)",
      required: false,
      header: "Huvudleverantör",
      description: `${YES_NO_X}; tom cell betyder Nej. Ja gör leverantören till artikelns huvudleverantör och tar bort markeringen från en tidigare — högst en per artikel i filen. Tom cell tar bort markeringen från en befintlig katalograd — ta bort kolumnen för att lämna den orörd.`,
      example: "Ja",
    },
    {
      field: "breakQuantity",
      label: "Staffel: från antal (Gränsvärde)",
      required: false,
      header: "Staffel: från antal",
      description:
        "Antalet i grundenhet där staffelpriset börjar gälla, större än 1 — ett gränsvärde på 1 eller lägre ignoreras med en varning (antal 1 är grundpriset). Finns kolumnen ersätts katalogradens staffel helt av filens steg — tomma celler betyder att staffeln tas bort; ta bort kolumnen för att lämna staffeln orörd.",
      example: "100",
    },
    {
      field: "breakPrice",
      label: "Staffel: pris",
      required: false,
      header: "Staffel: pris",
      description: `Priset per grundenhet från och med gränsvärdet, ${DECIMAL}, aldrig negativt. Krävs på varje rad som har ett gränsvärde; utan Staffel: från antal läses kolumnen inte.`,
      example: "219,00",
    },
  ],

  customerPrices: [
    {
      field: "articleNumber",
      label: "Artikelnummer",
      required: true,
      header: "Artikelnummer",
      text: true,
      description: "Numret på en artikel som redan finns i artikelregistret.",
      example: "SB-1200",
    },
    {
      field: "customerNumber",
      label: "Kundnummer",
      required: true,
      header: "Kundnummer",
      text: true,
      description:
        "Numret på en kund som redan finns i kundregistret. Samma kund och artikel får bara förekomma en gång i filen.",
      example: "1001",
    },
    {
      field: "price",
      label: "Pris",
      required: false,
      header: "Pris",
      description: `Kundens pris per grundenhet i SEK, ${DECIMAL}, aldrig negativt. Sparas med fyra decimaler som kundens artikelpris från antal 1 och ersätter ett tidigare pris på samma artikel. Tom cell lämnar priset orört — en rad med varken pris eller kundens artikelnummer hoppas över.`,
      example: "1890,00",
    },
    {
      field: "discountPercent",
      label: "Rabatt (%)",
      required: false,
      header: "Rabatt (%)",
      text: true,
      description:
        "Procentavdrag från 0 upp till (men inte med) 100 som bakas in i priset — Pris × (1 − Rabatt/100) — med en varning, eftersom kundpriset lagras som nettopris. Skriv bara talet — 10 betyder 10 %; skriv inte procenttecken. Tom cell betyder ingen rabatt.",
      example: "5",
    },
    {
      field: "customerArticleNumber",
      label: "Kundens artikelnummer",
      required: false,
      header: "Kundens artikelnummer",
      text: true,
      description:
        "Vad kunden kallar artikeln, max 50 tecken. Sparas på kundkortet och skrivs ut som \"Ert art.nr\" på offert, orderbekräftelse, plocklista, följesedel och faktura. Ersätter ett tidigare nummer för samma kund och artikel; tom cell lämnar det orört.",
      example: "KND-4711",
    },
  ],

  customers: [
    {
      field: "customerNumber",
      label: "Kundnummer",
      required: true,
      header: "Kundnummer",
      text: true,
      description:
        "Kundens unika nummer, max 50 tecken. Finns numret redan uppdateras kunden, annars skapas en ny. Nummerserien för kunder flyttas fram förbi filens högsta rent numeriska nummer.",
      example: "1001",
    },
    {
      field: "name",
      label: "Namn",
      required: false,
      header: "Namn",
      description: `Kundens namn, max 255 tecken. Krävs för nya kunder. ${UNTOUCHED}`,
      example: "Restaurang Exempelkrogen AB",
    },
    {
      field: "orgNumber",
      label: "Organisationsnummer",
      required: false,
      header: "Organisationsnummer",
      text: true,
      description: `Max 20 tecken. ${UNTOUCHED}`,
      example: "556123-4567",
    },
    {
      field: "vatNumber",
      label: "VAT-nummer",
      required: false,
      header: "VAT-nummer",
      text: true,
      description: `Momsregistreringsnummer, max 30 tecken. ${UNTOUCHED}`,
      example: "SE556123456701",
    },
    {
      field: "contactName",
      label: "Kontaktperson",
      required: false,
      header: "Kontaktperson",
      description:
        "Kontaktpersonens namn på kundkortets Allmänt-flik, max 255 tecken — kontaktregistret importeras separat som kundkontakter.",
      example: "Anna Andersson",
    },
    {
      field: "email",
      label: "E-post",
      required: false,
      header: "E-post",
      description:
        "Kundens e-postadress, max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt på en ny post och orört på en befintlig, med en varning.",
      example: "info@example.com",
    },
    {
      field: "phone",
      label: "Telefon",
      required: false,
      header: "Telefon",
      text: true,
      description: `Max 50 tecken. ${UNTOUCHED}`,
      example: "010-200 10 10",
    },
    {
      field: "address",
      label: "Adress",
      required: false,
      header: "Adress",
      description:
        "Besöksadressens första rad. Adress, Adressrad 2 och Adressrad 3 slås ihop till en adress med radbrytningar; är alla tre tomma lämnas adressen orörd.",
      example: "Storgatan 8",
    },
    {
      field: "address2",
      label: "Adressrad 2",
      required: false,
      header: "Adressrad 2",
      description: "Besöksadressens andra rad, valfri — slås ihop med Adress.",
      example: "Hus B",
    },
    {
      field: "address3",
      label: "Adressrad 3",
      required: false,
      header: "Adressrad 3",
      description: "Besöksadressens tredje rad, valfri — slås ihop med Adress.",
      example: "Ingång 2",
    },
    {
      field: "postalCode",
      label: "Postnummer",
      required: false,
      header: "Postnummer",
      text: true,
      description: `Max 20 tecken. ${UNTOUCHED}`,
      example: "123 50",
    },
    {
      field: "city",
      label: "Postort",
      required: false,
      header: "Postort",
      description: `Max 100 tecken. ${UNTOUCHED}`,
      example: "Exempelby",
    },
    {
      field: "country",
      label: "Land",
      required: false,
      header: "Land",
      description:
        "Landskod med två bokstäver (t.ex. SE, NO, DK, DE); små bokstäver godtas. Tom cell ger SE för nya kunder och lämnar befintliga orörda.",
      example: "SE",
    },
    {
      field: "paymentTerm",
      label: "Betalningsvillkor",
      required: false,
      header: "Betalningsvillkor",
      text: true,
      description:
        "Betalningsvillkorets kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som nytt villkor; börjar namnet med ett antal dagar (30 dagar netto) blir dagarna villkorets kod.",
      example: "30 dagar netto",
    },
    {
      field: "deliveryTerm",
      label: "Leveransvillkor",
      required: false,
      header: "Leveransvillkor",
      text: true,
      description:
        "Leveransvillkorets kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som nytt villkor.",
      example: "Fritt vårt lager",
    },
    {
      field: "carrier",
      label: "Leveranssätt/speditör",
      required: false,
      header: "Leveranssätt/speditör",
      text: true,
      description:
        "Speditörens kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som ny speditör.",
      example: "Exempelfrakt",
    },
    {
      field: "priceList",
      label: "Prislista",
      required: false,
      header: "Prislista",
      text: true,
      description:
        "Prislistans kod eller namn (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som ny prislista.",
      example: "Grossist",
    },
    {
      field: "discountPercent",
      label: "Kundrabatt (%)",
      required: false,
      header: "Kundrabatt (%)",
      text: true,
      description: `Kundens generella rabatt i procent, 0–100, ${DECIMAL}. Skriv bara talet — 10 betyder 10 %; skriv inte procenttecken. ${UNTOUCHED}`,
      example: "5",
    },
    {
      field: "invoiceAddressDiffers",
      label: "Avviker från postadress",
      required: false,
      header: "Avvikande fakturaadress",
      description: `${YES_NO_X}. Nej betyder att radens fakturaadresskolumner (namn, adress, postnummer, postort, land) ignoreras — en ny kund får ingen fakturaadress och en befintlig kunds sparade fakturaadress ändras inte. Ja eller tom cell använder kolumnerna som de är. Lagras inte.`,
      example: "Ja",
    },
    {
      field: "invoiceName",
      label: "Fakturanamn",
      required: false,
      header: "Fakturanamn",
      description: `Namnet på fakturan när det skiljer sig från kundens namn, max 255 tecken. ${UNTOUCHED}`,
      example: "Exempelkrogen AB, ekonomiavdelningen",
    },
    {
      field: "invoiceAddress",
      label: "Fakturaadress",
      required: false,
      header: "Fakturaadress",
      description:
        "Fakturaadressens första rad. Fakturaadress, Fakturaadressrad 2 och Fakturaadressrad 3 slås ihop med radbrytningar; är alla tre tomma lämnas fakturaadressen orörd.",
      example: "Box 100",
    },
    {
      field: "invoiceAddress2",
      label: "Fakturaadressrad 2",
      required: false,
      header: "Fakturaadressrad 2",
      description: "Fakturaadressens andra rad, valfri — slås ihop med Fakturaadress.",
      example: "Att: Ekonomi",
    },
    {
      field: "invoiceAddress3",
      label: "Fakturaadressrad 3",
      required: false,
      header: "Fakturaadressrad 3",
      description: "Fakturaadressens tredje rad, valfri — slås ihop med Fakturaadress.",
      example: "Våning 3",
    },
    {
      field: "invoicePostalCode",
      label: "Fakturapostnummer",
      required: false,
      header: "Fakturapostnummer",
      text: true,
      description: `Max 20 tecken. ${UNTOUCHED}`,
      example: "123 51",
    },
    {
      field: "invoiceCity",
      label: "Fakturapostort",
      required: false,
      header: "Fakturapostort",
      description: `Max 100 tecken. ${UNTOUCHED}`,
      example: "Exempelby",
    },
    {
      field: "invoiceCountry",
      label: "Fakturaland",
      required: false,
      header: "Fakturaland",
      description: `Landskod med två bokstäver (t.ex. SE); små bokstäver godtas. ${UNTOUCHED}`,
      example: "SE",
    },
    {
      field: "invoiceEmail",
      label: "E-post för faktura",
      required: false,
      header: "E-post för faktura",
      description:
        "E-postadress som fakturor skickas till, max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt på en ny post och orört på en befintlig, med en varning.",
      example: "faktura@example.com",
    },
    {
      field: "ourSupplierNumber",
      label: "Vårt leverantörsnummer",
      required: false,
      header: "Vårt leverantörsnummer",
      text: true,
      description:
        "Det nummer kunden har på oss som leverantör, max 50 tecken — skrivs ut på offert, orderbekräftelse och faktura.",
      example: "L-4711",
    },
    {
      field: "collectiveInvoicing",
      label: "Samlingsfaktura",
      required: false,
      header: "Samlingsfaktura",
      description: `${YES_NO_X} — Ja gör att kundens leveranser faktureras genom samlingsfakturering; ett värde som börjar med Per (t.ex. Per kund) räknas också som Ja. ${UNTOUCHED}`,
      example: "Nej",
    },
    {
      field: "privatePerson",
      label: "Privatperson",
      required: false,
      header: "Privatperson",
      description: `${YES_NO_X} — Ja visar priser inklusive moms på kundens offerter, orderbekräftelser och fakturor. ${UNTOUCHED}`,
      example: "Nej",
    },
    {
      field: "website",
      label: "Webbsida",
      required: false,
      header: "Webbsida",
      description: `Max 255 tecken. ${UNTOUCHED}`,
      example: "https://www.example.com",
    },
    {
      field: "currency",
      label: "Valuta",
      required: false,
      header: "Valuta",
      text: true,
      description:
        "Valutakod med tre bokstäver (SEK, EUR, NOK …); små bokstäver godtas, annat ger ett fel. Nya offerter och kundordrar får kundens valuta och dagens kurs, och kundens kundpriser gäller i den valutan; befintliga ordrar behåller sin. Tom cell ger SEK för nya kunder och lämnar befintliga orörda.",
      example: "SEK",
    },
  ],

  customerContacts: [
    {
      field: "customerNumber",
      label: "Kundnummer",
      required: true,
      header: "Kundnummer",
      text: true,
      description: "Numret på en kund som redan finns i kundregistret — importera kunderna först.",
      example: "1001",
    },
    {
      field: "name",
      label: "Namn",
      required: true,
      header: "Kontaktperson",
      description:
        "Kontaktens namn, max 255 tecken. Finns redan en kontakt med samma namn på kunden (skiftlägesokänsligt) hoppas raden över — befintliga kontakter uppdateras aldrig — och samma namn två gånger i filen importeras en gång.",
      example: "Anna Andersson",
    },
    {
      field: "isPrimary",
      label: "Förvald",
      required: false,
      header: "Förvald",
      description: `${YES_NO_X}; tom cell betyder Nej. Ja gör kontakten till kundens huvudkontakt; har kunden redan en importeras kontakten som vanlig kontakt med en varning.`,
      example: "Ja",
    },
    {
      field: "phone",
      label: "Telefon",
      required: false,
      header: "Telefon",
      text: true,
      description: "Max 50 tecken.",
      example: "010-200 10 11",
    },
    {
      field: "mobile",
      label: "Mobiltelefon",
      required: false,
      header: "Mobiltelefon",
      text: true,
      description: "Max 50 tecken.",
      example: "070-000 00 01",
    },
    {
      field: "email",
      label: "E-post",
      required: false,
      header: "E-post",
      description:
        "Max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt på en ny post och orört på en befintlig, med en varning.",
      example: "anna@example.com",
    },
    {
      field: "comment",
      label: "Anmärkning",
      required: false,
      header: "Anmärkning",
      description: "Fritext om kontakten.",
      example: "Beställer för köket",
    },
    {
      field: "fax",
      label: "Faxnummer",
      required: false,
      header: "Faxnummer",
      text: true,
      description:
        "Max 50 tecken. Kontakten har inget eget faxfält — numret läggs i anmärkningen som Fax 010-200 10 19.",
      example: "010-200 10 19",
    },
  ],

  customerDeliveryAddresses: [
    {
      field: "customerNumber",
      label: "Kundnummer",
      required: true,
      header: "Kundnummer",
      text: true,
      description: "Numret på en kund som redan finns i kundregistret — importera kunderna först.",
      example: "1001",
    },
    {
      field: "label",
      label: "Namn",
      required: false,
      header: "Adressnamn",
      description:
        "Leveransadressens benämning på kundkortet, max 100 tecken. Tom cell ger Leveransadress.",
      example: "Exempelskolan, köket",
    },
    {
      field: "address",
      label: "Adressrad 1",
      required: false,
      header: "Adressrad 1",
      description:
        "Första adressraden. Raderna 1–3 slås ihop till en adress med radbrytningar. En rad utan någon adressrad hoppas över, liksom en adress som är samma som kundens besöksadress eller en leveransadress som redan finns. Den första nya adressen blir kundens förvalda om kunden saknar en och guidens Sätt som förvald leveransadress är ikryssad.",
      example: "Skolvägen 5",
    },
    {
      field: "address2",
      label: "Adressrad 2",
      required: false,
      header: "Adressrad 2",
      description: "Andra adressraden, valfri — slås ihop med Adressrad 1.",
      example: "Varumottagningen",
    },
    {
      field: "address3",
      label: "Adressrad 3",
      required: false,
      header: "Adressrad 3",
      description: "Tredje adressraden, valfri — slås ihop med Adressrad 1.",
      example: "Port 3",
    },
    {
      field: "postalCode",
      label: "Postnummer",
      required: false,
      header: "Postnummer",
      text: true,
      description: "Max 20 tecken.",
      example: "123 42",
    },
    {
      field: "city",
      label: "Stad",
      required: false,
      header: "Stad",
      description: "Max 100 tecken.",
      example: "Exempelby",
    },
    {
      field: "country",
      label: "Land",
      required: false,
      header: "Land",
      description: "Landskod med två bokstäver (t.ex. SE); små bokstäver godtas. Tom cell ger SE.",
      example: "SE",
    },
  ],

  suppliers: [
    {
      field: "supplierNumber",
      label: "Leverantörsnummer",
      required: true,
      header: "Leverantörsnummer",
      text: true,
      description:
        "Leverantörens unika nummer, max 50 tecken. Finns numret redan uppdateras leverantören, annars skapas en ny. Nummerserien för leverantörer flyttas fram förbi filens högsta rent numeriska nummer.",
      example: "2001",
    },
    {
      field: "name",
      label: "Namn",
      required: false,
      header: "Namn",
      description: `Leverantörens namn, max 255 tecken. Krävs för nya leverantörer. ${UNTOUCHED}`,
      example: "Exempel Stålhandel AB",
    },
    {
      field: "orgNumber",
      label: "Organisationsnummer",
      required: false,
      header: "Organisationsnummer",
      text: true,
      description: `Max 20 tecken. ${UNTOUCHED}`,
      example: "556987-6543",
    },
    {
      field: "vatNumber",
      label: "VAT-nummer",
      required: false,
      header: "VAT-nummer",
      text: true,
      description: `Momsregistreringsnummer, max 30 tecken. ${UNTOUCHED}`,
      example: "SE556987654301",
    },
    {
      field: "contactName",
      label: "Kontaktperson",
      required: false,
      header: "Kontaktperson",
      description:
        "Kontaktpersonens namn på leverantörskortets Allmänt-flik, max 255 tecken — kontaktregistret importeras separat som leverantörskontakter.",
      example: "Bo Bengtsson",
    },
    {
      field: "email",
      label: "E-post",
      required: false,
      header: "E-post",
      description:
        "Leverantörens e-postadress (dit förfrågningar och inköpsorder skickas), max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt på en ny post och orört på en befintlig, med en varning.",
      example: "order@example.com",
    },
    {
      field: "phone",
      label: "Telefon",
      required: false,
      header: "Telefon",
      text: true,
      description: `Max 50 tecken. ${UNTOUCHED}`,
      example: "010-100 10 10",
    },
    {
      field: "address",
      label: "Adress",
      required: false,
      header: "Adress",
      description:
        "Postadressens första rad. Adress, Adressrad 2 och Adressrad 3 slås ihop till en adress med radbrytningar; är alla tre tomma lämnas adressen orörd.",
      example: "Valsverksgatan 4",
    },
    {
      field: "address2",
      label: "Adressrad 2",
      required: false,
      header: "Adressrad 2",
      description: "Postadressens andra rad, valfri — slås ihop med Adress.",
      example: "Port C",
    },
    {
      field: "address3",
      label: "Adressrad 3",
      required: false,
      header: "Adressrad 3",
      description: "Postadressens tredje rad, valfri — slås ihop med Adress.",
      example: "Godsmottagningen",
    },
    {
      field: "postalCode",
      label: "Postnummer",
      required: false,
      header: "Postnummer",
      text: true,
      description: `Max 20 tecken. ${UNTOUCHED}`,
      example: "123 45",
    },
    {
      field: "city",
      label: "Postort",
      required: false,
      header: "Postort",
      description: `Max 100 tecken. ${UNTOUCHED}`,
      example: "Exempelby",
    },
    {
      field: "country",
      label: "Land",
      required: false,
      header: "Land",
      description: `Landskod med två bokstäver (t.ex. SE); små bokstäver godtas. Styr leverantörsfakturans förvalda momskod när leverantören saknar egen: SE ger svensk moms, ett annat EU-land omvänd moms på varor och övriga länder varor utanför EU. Tom cell ger SE på en ny leverantör. ${UNTOUCHED}`,
      example: "SE",
    },
    {
      field: "currency",
      label: "Valuta",
      required: false,
      header: "Valuta",
      text: true,
      description:
        "Valutakod med tre bokstäver (SEK, EUR, NOK …); små bokstäver godtas, annat ger ett fel. Nya inköpsorder och nya katalograder (även de som Inköpspriser-importen skapar) får leverantörens valuta; befintliga behåller sin. Tom cell ger SEK för nya leverantörer och lämnar befintliga orörda.",
      example: "SEK",
    },
    {
      field: "ourCustomerNumber",
      label: "Vårt kundnummer",
      required: false,
      header: "Vårt kundnummer",
      text: true,
      description: `Det kundnummer leverantören har på oss, max 50 tecken — skrivs ut på förfrågan och inköpsorder. ${UNTOUCHED}`,
      example: "K-1234",
    },
    {
      field: "paymentTerm",
      label: "Betalningsvillkor",
      required: false,
      header: "Betalningsvillkor",
      text: true,
      description:
        "Betalningsvillkorets kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som nytt villkor; börjar namnet med ett antal dagar (30 dagar netto) blir dagarna villkorets kod och styr förfallodatum på leverantörsfakturor.",
      example: "30 dagar netto",
    },
    {
      field: "deliveryTerm",
      label: "Leveransvillkor",
      required: false,
      header: "Leveransvillkor",
      text: true,
      description:
        "Leveransvillkorets kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som nytt villkor.",
      example: "Fritt vårt lager",
    },
    {
      field: "carrier",
      label: "Leveranssätt/speditör",
      required: false,
      header: "Leveranssätt/speditör",
      text: true,
      description:
        "Speditörens kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som ny speditör.",
      example: "Exempelfrakt",
    },
    {
      field: "carrierCustomerNumber",
      label: "Kundnummer hos speditör",
      required: false,
      header: "Kundnummer hos speditör",
      text: true,
      description: `Vårt kundnummer hos leverantörens speditör, max 50 tecken. ${UNTOUCHED}`,
      example: "F-98765",
    },
  ],

  supplierContacts: [
    {
      field: "supplierNumber",
      label: "Leverantörsnummer",
      required: true,
      header: "Leverantörsnummer",
      text: true,
      description:
        "Numret på en leverantör som redan finns i leverantörsregistret — importera leverantörerna först.",
      example: "2001",
    },
    {
      field: "name",
      label: "Namn",
      required: true,
      header: "Kontaktperson",
      description:
        "Kontaktens namn, max 255 tecken. Finns redan en kontakt med samma namn på leverantören (skiftlägesokänsligt) hoppas raden över — befintliga kontakter uppdateras aldrig — och samma namn två gånger i filen importeras en gång.",
      example: "Bo Bengtsson",
    },
    {
      field: "isPrimary",
      label: "Förvald",
      required: false,
      header: "Förvald",
      description: `${YES_NO_X}; tom cell betyder Nej. Ja gör kontakten till leverantörens huvudkontakt; har leverantören redan en importeras kontakten som vanlig kontakt med en varning.`,
      example: "Ja",
    },
    {
      field: "phone",
      label: "Telefon",
      required: false,
      header: "Telefon",
      text: true,
      description: "Max 50 tecken.",
      example: "010-100 10 11",
    },
    {
      field: "mobile",
      label: "Mobiltelefon",
      required: false,
      header: "Mobiltelefon",
      text: true,
      description: "Max 50 tecken.",
      example: "070-000 00 02",
    },
    {
      field: "email",
      label: "E-post",
      required: false,
      header: "E-post",
      description:
        "Max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt på en ny post och orört på en befintlig, med en varning.",
      example: "bo@example.com",
    },
    {
      field: "comment",
      label: "Anmärkning",
      required: false,
      header: "Anmärkning",
      description: "Fritext om kontakten.",
      example: "Säljare, plåt och profiler",
    },
    {
      field: "fax",
      label: "Faxnummer",
      required: false,
      header: "Faxnummer",
      text: true,
      description:
        "Max 50 tecken. Kontakten har inget eget faxfält — numret läggs i anmärkningen som Fax 010-100 10 19.",
      example: "010-100 10 19",
    },
  ],

  supplierDeliveryAddresses: [
    {
      field: "supplierNumber",
      label: "Leverantörsnummer",
      required: true,
      header: "Leverantörsnummer",
      text: true,
      description:
        "Numret på en leverantör som redan finns i leverantörsregistret — importera leverantörerna först.",
      example: "2001",
    },
    {
      field: "label",
      label: "Namn",
      required: false,
      header: "Adressnamn",
      description:
        "Leveransadressens benämning på leverantörskortet, max 100 tecken. Tom cell ger Leveransadress.",
      example: "Lagret i Exempelstad",
    },
    {
      field: "address",
      label: "Adressrad 1",
      required: false,
      header: "Adressrad 1",
      description:
        "Första adressraden. Raderna 1–3 slås ihop till en adress med radbrytningar. En rad utan någon adressrad hoppas över, liksom en adress som är samma som leverantörens postadress eller en leveransadress som redan finns. Den första nya adressen blir leverantörens förvalda om leverantören saknar en och guidens Sätt som förvald leveransadress är ikryssad.",
      example: "Hamngatan 12",
    },
    {
      field: "address2",
      label: "Adressrad 2",
      required: false,
      header: "Adressrad 2",
      description: "Andra adressraden, valfri — slås ihop med Adressrad 1.",
      example: "Godsmottagningen",
    },
    {
      field: "address3",
      label: "Adressrad 3",
      required: false,
      header: "Adressrad 3",
      description: "Tredje adressraden, valfri — slås ihop med Adressrad 1.",
      example: "Port 2",
    },
    {
      field: "postalCode",
      label: "Postnummer",
      required: false,
      header: "Postnummer",
      text: true,
      description: "Max 20 tecken.",
      example: "234 56",
    },
    {
      field: "city",
      label: "Stad",
      required: false,
      header: "Stad",
      description: "Max 100 tecken.",
      example: "Exempelstad",
    },
  ],

  workCenters: [
    {
      field: "code",
      label: "Nummer",
      required: true,
      header: "Nummer",
      text: true,
      description:
        "Resursens nummer, tre siffror. 1–2 siffror fylls ut med nollor (7 blir 007). Finns numret redan uppdateras resursen; används det av en legoresurs blir raden ett fel — den importeras på fliken Legoresurser.",
      example: "110",
    },
    {
      field: "name",
      label: "Namn",
      required: false,
      header: "Namn",
      description: `Resursens namn, max 100 tecken. Krävs för nya resurser. ${UNTOUCHED}`,
      example: "Laserskärning",
    },
    {
      field: "type",
      label: "Typ",
      required: false,
      header: "Typ",
      description:
        "Maskin eller Personal (även Manuellt arbete). Lego, Underleverantör eller Extern hoppar över raden med hänvisning till fliken Legoresurser. Ett okänt ord ger Maskin för nya resurser och lämnar befintliga orörda, med en varning; tom cell likaså utan varning.",
      example: "Maskin",
    },
    {
      field: "productionGroupCode",
      label: "Avdelning (produktionsgrupp)",
      required: false,
      header: "Avdelning",
      text: true,
      description:
        "Koden på den produktionsgrupp resursen tillhör, max 20 tecken (skiftlägesokänsligt). En okänd kod skapas som ny produktionsgrupp, med Avdelningens namn eller koden som namn. Tom cell lämnar fältet orört.",
      example: "PV",
    },
    {
      field: "productionGroupName",
      label: "Avdelningens namn",
      required: false,
      header: "Avdelningens namn",
      description:
        "Produktionsgruppens namn, max 100 tecken — används bara när gruppen skapas av importen; en befintlig grupp byter inte namn.",
      example: "Plåtverkstad",
    },
    {
      field: "hourlyRate",
      label: "Timkostnad",
      required: false,
      header: "Timkostnad",
      description: `Resursens kostnad per timme i SEK, ${DECIMAL}, aldrig negativ — används i för- och efterkalkylen. ${UNTOUCHED}`,
      example: "950",
    },
    {
      field: "calcRate1",
      label: "Kalkylpris 1",
      required: false,
      header: "Kalkylpris 1",
      description: `Alternativt timpris i SEK, ${DECIMAL}, aldrig negativt. Sparas på resursen men används inte av kalkylen ännu.`,
      example: "900",
    },
    {
      field: "rateAppliesToSetup",
      label: "Gäller ställ",
      required: false,
      header: "Gäller ställ",
      description: `${YES_NO_X} — om timkostnaden gäller ställtiden. Sparas på resursen som förvalsvärde; används inte av beredningen eller kalkylen ännu. ${UNTOUCHED}`,
      example: "Ja",
    },
    {
      field: "rateAppliesToRun",
      label: "Gäller styck",
      required: false,
      header: "Gäller styck",
      description: `${YES_NO_X} — om timkostnaden gäller stycktiden. Sparas på resursen som förvalsvärde; används inte av beredningen eller kalkylen ännu. ${UNTOUCHED}`,
      example: "Ja",
    },
    {
      field: "defaultSetupTime",
      label: "Förvald ställtid",
      required: false,
      header: "Förvald ställtid",
      description: `Ställtid i minuter, ${DECIMAL}, aldrig negativ. Sparas på resursen som förvalsvärde; används inte av beredningen eller kalkylen ännu. ${UNTOUCHED}`,
      example: "15",
    },
    {
      field: "defaultOperationName",
      label: "Förvald operationsbenämning",
      required: false,
      header: "Förvald operationsbenämning",
      description:
        "Operationsnamn, max 100 tecken. Sparas på resursen som förvalsvärde; används inte av beredningen eller kalkylen ännu. Tom cell lämnar fältet orört på en befintlig post.",
      example: "Laserskärning",
    },
    {
      field: "costRowName",
      label: "Kostnadsrad",
      required: false,
      header: "Kostnadsrad",
      description:
        "Styrkolumn för filer med flera kostnadsrader per resurs: bara raden vars värde börjar med Ordinarie importeras; saknar resursen en sådan tas dess första rad med en varning. Lagras inte — ta bort kolumnen när filen har en rad per resurs.",
      example: "Ordinarie",
    },
  ],

  legoWorkCenters: [
    {
      field: "code",
      label: "Nummer",
      required: true,
      header: "Nummer",
      text: true,
      description:
        "Legoresursens nummer, tre siffror. 1–2 siffror fylls ut med nollor (7 blir 007). Finns numret redan uppdateras legoresursen; används det av en maskin- eller personalresurs blir raden ett fel.",
      example: "910",
    },
    {
      field: "name",
      label: "Namn",
      required: false,
      header: "Namn",
      description: `Legoresursens namn, max 100 tecken. Krävs för nya legoresurser. ${UNTOUCHED}`,
      example: "Pulverlackering, extern",
    },
    {
      field: "supplierNumber",
      label: "Leverantörsnummer",
      required: false,
      header: "Leverantörsnummer",
      text: true,
      description:
        "Numret på den leverantör som utför legoarbetet — måste finnas i leverantörsregistret, importera leverantörerna först. Tom cell lämnar fältet orört.",
      example: "2003",
    },
    {
      field: "leadTimeDays",
      label: "Ledtid (dagar)",
      required: false,
      header: "Ledtid (dagar)",
      description: `Arbetsdagar hos leverantören från avsändning till retur, ${DECIMAL}, aldrig negativ — används av planeringen och leveranstidskontrollen. Tom cell lämnar fältet orört.`,
      example: "5",
    },
    {
      field: "queueTimeDays",
      label: "Kötid (dagar)",
      required: false,
      header: "Kötid (dagar)",
      description: `Dagar innan arbetet påbörjas hos leverantören, ${DECIMAL}, aldrig negativ. Sparas som förvalsvärde; tom cell lämnar fältet orört.`,
      example: "1",
    },
    {
      field: "orderLeadTimeDays",
      label: "Ledtid beställning (dagar)",
      required: false,
      header: "Ledtid beställning (dagar)",
      description: `Dagar från beställning till att leverantören kan ta emot godset, ${DECIMAL}, aldrig negativ. Sparas som förvalsvärde; tom cell lämnar fältet orört.`,
      example: "2",
    },
  ],

  productionGroups: [
    {
      field: "code",
      label: "Kod",
      required: true,
      header: "Kod",
      text: true,
      description:
        "Produktionsgruppens kod, max 20 tecken (skiftlägesokänsligt). Finns koden redan uppdateras gruppen, annars skapas en ny; en kod som upprepas i filen hoppas över efter första raden.",
      example: "PV",
    },
    {
      field: "name",
      label: "Namn",
      required: false,
      header: "Namn",
      description:
        "Produktionsgruppens namn, max 100 tecken. En ny grupp utan namn får koden som namn; tom cell lämnar ett befintligt namn orört.",
      example: "Plåtverkstad",
    },
    {
      field: "description",
      label: "Beskrivning",
      required: false,
      header: "Beskrivning",
      description: "Fritext, max 2 000 tecken. Tom cell lämnar fältet orört.",
      example: "Laser, kantpress och svets",
    },
  ],
};

// The wizard's view: everything but the template-only `text` flag.
export function importFieldHelp(entity: ImportEntity): ImportFieldHelp[] {
  return IMPORT_FIELD_HELP[entity].map(({ text: _text, ...help }) => help);
}
