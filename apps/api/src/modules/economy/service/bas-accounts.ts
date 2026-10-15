import type { VatBoxSetting } from "@navet/shared";

// BAS-kontoplanen (BAS 2025), curated subset for a smaller Swedish
// manufacturing AB — accounting-firm-relevant scope only, not the full BAS
// register. Seeded via POST /accounts/generate-bas (createEconomyRepository.
// seedAccounts). This list is authoritative: no additions/removals without
// updating the B1 task brief.
// vatBox is each account's default momsruta — it MUST equal what the 0102
// backfill assigns under the default posting settings
// (vat-box-backfill.test.ts pins it).
export const BAS_STANDARD_ACCOUNTS: { number: string; name: string; vatBox?: VatBoxSetting }[] = [
  { number: "1010", name: "Utvecklingsutgifter" },
  { number: "1110", name: "Byggnader" },
  { number: "1119", name: "Ack avskrivningar byggnader" },
  { number: "1130", name: "Mark" },
  { number: "1210", name: "Maskiner och andra tekniska anläggningar" },
  { number: "1219", name: "Ack avskrivningar maskiner" },
  { number: "1220", name: "Inventarier och verktyg" },
  { number: "1229", name: "Ack avskrivningar inventarier" },
  { number: "1240", name: "Bilar och andra transportmedel" },
  { number: "1249", name: "Ack avskrivningar bilar" },
  { number: "1250", name: "Datorer" },
  { number: "1259", name: "Ack avskrivningar datorer" },
  { number: "1410", name: "Lager av råvaror" },
  { number: "1440", name: "Produkter i arbete" },
  { number: "1450", name: "Lager av färdiga varor" },
  { number: "1460", name: "Lager av handelsvaror" },
  { number: "1510", name: "Kundfordringar" },
  { number: "1513", name: "Kundfordringar – delad faktura" },
  { number: "1610", name: "Kortfristiga fordringar hos anställda" },
  { number: "1630", name: "Avräkning för skatter och avgifter (skattekonto)" },
  { number: "1650", name: "Momsfordran" },
  { number: "1680", name: "Andra kortfristiga fordringar" },
  { number: "1710", name: "Förutbetalda hyreskostnader" },
  { number: "1730", name: "Förutbetalda försäkringspremier" },
  { number: "1790", name: "Övriga förutbetalda kostnader och upplupna intäkter" },
  { number: "1910", name: "Kassa" },
  { number: "1930", name: "Företagskonto/checkkonto" },
  { number: "1940", name: "Övriga bankkonton" },
  { number: "2081", name: "Aktiekapital" },
  { number: "2091", name: "Balanserad vinst eller förlust" },
  { number: "2098", name: "Vinst eller förlust från föregående år" },
  { number: "2099", name: "Årets resultat" },
  { number: "2110", name: "Periodiseringsfonder" },
  { number: "2150", name: "Ack överavskrivningar" },
  { number: "2330", name: "Checkräkningskredit" },
  { number: "2350", name: "Andra långfristiga skulder till kreditinstitut" },
  { number: "2390", name: "Övriga långfristiga skulder" },
  { number: "2410", name: "Kortfristiga låneskulder" },
  { number: "2440", name: "Leverantörsskulder" },
  { number: "2510", name: "Skatteskulder" },
  { number: "2610", name: "Utgående moms 25 %", vatBox: "10" },
  { number: "2620", name: "Utgående moms 12 %", vatBox: "11" },
  { number: "2630", name: "Utgående moms 6 %", vatBox: "12" },
  { number: "2640", name: "Ingående moms", vatBox: "48" },
  { number: "2650", name: "Redovisningskonto för moms", vatBox: "none" },
  { number: "2710", name: "Personalskatt" },
  { number: "2731", name: "Avräkning lagstadgade sociala avgifter" },
  { number: "2740", name: "Avtalade sociala avgifter" },
  { number: "2890", name: "Övriga kortfristiga skulder" },
  { number: "2898", name: "Outtagen vinstutdelning" },
  { number: "2910", name: "Upplupna löner" },
  { number: "2920", name: "Upplupna semesterlöner" },
  { number: "2940", name: "Upplupna lagstadgade sociala och andra avgifter" },
  { number: "2990", name: "Övriga upplupna kostnader och förutbetalda intäkter" },
  { number: "3001", name: "Försäljning inom Sverige 25 %", vatBox: "05" },
  { number: "3002", name: "Försäljning inom Sverige 12 %", vatBox: "05" },
  { number: "3003", name: "Försäljning inom Sverige 6 %", vatBox: "05" },
  { number: "3004", name: "Försäljning inom Sverige momsfri", vatBox: "42" },
  { number: "3105", name: "Försäljning varor till land utanför EU", vatBox: "36" },
  { number: "3108", name: "Försäljning varor till annat EU-land", vatBox: "35" },
  { number: "3540", name: "Faktureringsavgifter", vatBox: "none" },
  { number: "3590", name: "Övriga fakturerade kostnader", vatBox: "05" },
  { number: "3740", name: "Öres- och kronutjämning", vatBox: "none" },
  { number: "3910", name: "Hyres- och arrendeintäkter", vatBox: "none" },
  { number: "3960", name: "Valutakursvinster på fordringar och skulder av rörelsekaraktär", vatBox: "none" },
  { number: "3973", name: "Vinst vid avyttring av maskiner och inventarier", vatBox: "none" },
  { number: "3990", name: "Övriga ersättningar och intäkter", vatBox: "none" },
  { number: "4010", name: "Inköp material och varor" },
  { number: "4515", name: "Inköp varor från annat EU-land 25 %" },
  { number: "4531", name: "Inköp tjänster från annat EU-land 25 %" },
  { number: "4600", name: "Legoarbeten och underentreprenader" },
  { number: "4990", name: "Förändring av lager" },
  { number: "5010", name: "Lokalhyra" },
  { number: "5020", name: "El för belysning" },
  { number: "5060", name: "Städning och renhållning" },
  { number: "5090", name: "Övriga lokalkostnader" },
  { number: "5210", name: "Hyra av maskiner och andra tekniska anläggningar" },
  { number: "5410", name: "Förbrukningsinventarier" },
  { number: "5460", name: "Förbrukningsmaterial" },
  { number: "5500", name: "Reparation och underhåll" },
  { number: "5611", name: "Drivmedel för personbilar" },
  { number: "5615", name: "Leasing av personbilar" },
  { number: "5710", name: "Frakter och transporter" },
  { number: "5800", name: "Resekostnader" },
  { number: "5910", name: "Annonsering" },
  { number: "5990", name: "Övriga försäljningskostnader" },
  { number: "6071", name: "Representation avdragsgill" },
  { number: "6072", name: "Representation ej avdragsgill" },
  { number: "6110", name: "Kontorsmaterial" },
  { number: "6212", name: "Mobiltelefon" },
  { number: "6230", name: "Datakommunikation" },
  { number: "6250", name: "Porto" },
  { number: "6310", name: "Företagsförsäkringar" },
  { number: "6420", name: "Ersättningar till revisor" },
  { number: "6530", name: "Redovisningstjänster" },
  { number: "6540", name: "IT-tjänster" },
  { number: "6570", name: "Bankkostnader" },
  { number: "6970", name: "Tidningar, tidskrifter och facklitteratur" },
  { number: "6990", name: "Övriga externa kostnader" },
  { number: "7010", name: "Löner till kollektivanställda" },
  { number: "7210", name: "Löner till tjänstemän" },
  { number: "7220", name: "Löner till företagsledare" },
  { number: "7281", name: "Sjuklöner till tjänstemän" },
  { number: "7285", name: "Semesterlöner till tjänstemän" },
  { number: "7290", name: "Förändring av semesterlöneskuld" },
  { number: "7310", name: "Kontanta extraersättningar" },
  { number: "7331", name: "Skattefria bilersättningar" },
  { number: "7390", name: "Övriga kostnadsersättningar och förmåner" },
  { number: "7410", name: "Pensionsförsäkringspremier" },
  { number: "7510", name: "Arbetsgivaravgifter" },
  { number: "7519", name: "Arbetsgivaravgifter för semester- och löneskulder" },
  { number: "7533", name: "Särskild löneskatt på pensionskostnader" },
  { number: "7570", name: "Premier för arbetsmarknadsförsäkringar" },
  { number: "7610", name: "Utbildning" },
  { number: "7620", name: "Sjuk- och hälsovård" },
  { number: "7690", name: "Övriga personalkostnader" },
  { number: "7810", name: "Avskrivningar på immateriella anläggningstillgångar" },
  { number: "7820", name: "Avskrivningar på byggnader" },
  { number: "7830", name: "Avskrivningar på maskiner och inventarier" },
  { number: "7970", name: "Förlust vid avyttring av anläggningstillgångar" },
  { number: "7990", name: "Övriga rörelsekostnader" },
  { number: "8310", name: "Ränteintäkter från omsättningstillgångar" },
  { number: "8410", name: "Räntekostnader för skulder" },
  { number: "8423", name: "Räntekostnader för skatter och avgifter" },
  { number: "8811", name: "Avsättning till periodiseringsfond" },
  { number: "8819", name: "Återföring från periodiseringsfond" },
  { number: "8850", name: "Förändring av överavskrivningar" },
  { number: "8910", name: "Skatt på årets resultat" },
  { number: "8999", name: "Årets resultat" },
];

const BAS_VAT_BOX = new Map(
  BAS_STANDARD_ACCOUNTS.flatMap((account) => (account.vatBox ? [[account.number, account.vatBox] as const] : []))
);

// The momsruta a new account gets when none is given: the BAS default for
// its number, otherwise null (not classified — the VAT report warns on
// movement rather than guessing).
export function defaultVatBox(number: string): VatBoxSetting | null {
  return BAS_VAT_BOX.get(number) ?? null;
}

// Anläggningsregister (ekonomi etapp 2, delprojekt 2): the five tillgångs-
// grupper "Förifyll BAS-grupper" creates, by account NUMBER (resolved to ids
// at seed time). Useful lives are defaults the user edits freely; Byggnader
// 600 months = 2 %/år. Every number below must exist in BAS_STANDARD_ACCOUNTS.
export const BAS_FIXED_ASSET_CATEGORIES: {
  name: string;
  assetAccount: string;
  accumulatedAccount: string;
  expenseAccount: string;
  gainAccount: string;
  lossAccount: string;
  usefulLifeMonths: number;
}[] = [
  { name: "Maskiner och andra tekniska anläggningar", assetAccount: "1210", accumulatedAccount: "1219", expenseAccount: "7830", gainAccount: "3973", lossAccount: "7970", usefulLifeMonths: 60 },
  { name: "Inventarier och verktyg", assetAccount: "1220", accumulatedAccount: "1229", expenseAccount: "7830", gainAccount: "3973", lossAccount: "7970", usefulLifeMonths: 60 },
  { name: "Bilar och andra transportmedel", assetAccount: "1240", accumulatedAccount: "1249", expenseAccount: "7830", gainAccount: "3973", lossAccount: "7970", usefulLifeMonths: 60 },
  { name: "Datorer", assetAccount: "1250", accumulatedAccount: "1259", expenseAccount: "7830", gainAccount: "3973", lossAccount: "7970", usefulLifeMonths: 36 },
  { name: "Byggnader", assetAccount: "1110", accumulatedAccount: "1119", expenseAccount: "7820", gainAccount: "3973", lossAccount: "7970", usefulLifeMonths: 600 },
];
