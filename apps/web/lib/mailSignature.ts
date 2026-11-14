// E-postsignatur (2026-11-14): the web's copy of the field lists in
// packages/shared/src/mail-signature.ts (the web cannot import @navet/shared;
// web-mail-signature.test.ts compares the lists), plus the Swedish labels.

export const MAIL_SIGNATURE_USER_FIELDS = ["name", "title", "phone", "mobile", "email"] as const;
export type MailSignatureUserField = (typeof MAIL_SIGNATURE_USER_FIELDS)[number];

export const MAIL_SIGNATURE_COMPANY_FIELDS = [
  "logo",
  "name",
  "address",
  "phone",
  "email",
  "website",
  "orgNumber",
  "vatNumber",
  "companySeat",
] as const;
export type MailSignatureCompanyField = (typeof MAIL_SIGNATURE_COMPANY_FIELDS)[number];

export const MAIL_SIGNATURE_USER_FIELD_LABELS: Record<MailSignatureUserField, string> = {
  name: "Namn",
  title: "Befattning",
  phone: "Telefon",
  mobile: "Mobil",
  email: "E-post",
};

export const MAIL_SIGNATURE_COMPANY_FIELD_LABELS: Record<MailSignatureCompanyField, string> = {
  logo: "Logotyp",
  name: "Företagsnamn",
  address: "Adress",
  phone: "Telefon (växel)",
  email: "E-post",
  website: "Webbplats",
  orgNumber: "Organisationsnummer",
  vatNumber: "VAT-nummer",
  companySeat: "Säte",
};

// The user's signature as GET /me/mail-signature answers: what is saved,
// plus the two details that come from the account.
export interface MailSignatureView {
  enabled: boolean;
  fields: MailSignatureUserField[];
  title: string | null;
  phone: string | null;
  mobile: string | null;
  name: string;
  email: string;
}
