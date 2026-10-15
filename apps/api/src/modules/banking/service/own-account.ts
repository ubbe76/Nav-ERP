// Is a camt.054 notification's account (Ntfctn/Acct/Id) one of the company's
// own? Pure — the bank file page warns when it is not (a file for another
// company, or the wrong export). Hyphens, spaces and case never matter.
export interface CompanyAccounts {
  iban: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
}

const compact = (value: string) => value.replace(/[\s-]/g, "").toUpperCase();
const withoutLeadingZeros = (digits: string) => digits.replace(/^0+/, "");

export function isOwnAccount(account: string, company: CompanyAccounts): boolean {
  const id = compact(account);
  const iban = company.iban ? compact(company.iban) : null;
  if (iban && id === iban) return true;
  if (!/^\d+$/.test(id)) return false;
  if ([company.bankgiro, company.plusgiro].some((giro) => giro && compact(giro) === id)) return true;
  // A Swedish IBAN is SEkk + a 3-digit bank code + the account (BBAN)
  // zero-padded to 17 digits, so Swedbank's BBAN "82149 1234567890" is the
  // tail of SE.. 800 00821491234567890. Some banks leave the clearing out of
  // the IBAN, hence the suffix match both ways.
  if (iban?.startsWith("SE") && iban.length === 24) {
    const fromIban = withoutLeadingZeros(iban.slice(7));
    const bban = withoutLeadingZeros(id);
    const [shorter, longer] = fromIban.length <= bban.length ? [fromIban, bban] : [bban, fromIban];
    if (shorter.length >= 7 && longer.endsWith(shorter)) return true;
  }
  return false;
}

export function notificationAccountWarning(accounts: string[], company: CompanyAccounts): string | null {
  const foreign = accounts.filter((a) => !isOwnAccount(a, company));
  if (foreign.length === 0) return null;
  const which = foreign.length === 1 ? `kontot ${foreign[0]}, som inte är något` : `kontona ${foreign.join(", ")}, som inte är några`;
  return `Avin gäller ${which} av företagets konton i Företagsinformation (IBAN, bankgiro, plusgiro). Kontrollera att filen hör till företaget.`;
}
