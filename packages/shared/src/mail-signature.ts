import { z } from "zod";
import { mailTemplateLanguageSchema } from "./mail-templates.js";

// E-postsignatur (2026-11-14): a signature under the document mails a user
// sends. The user picks which of their own details go in (Mina
// inställningar); the admin picks which company details go in for everyone
// (Företagsinfo). Name and e-mail come from the account, the other personal
// details are the signature's own.

// The user's details, in the signature's order.
export const MAIL_SIGNATURE_USER_FIELDS = ["name", "title", "phone", "mobile", "email"] as const;
export type MailSignatureUserField = (typeof MAIL_SIGNATURE_USER_FIELDS)[number];

// The company's details (from Företagsinformation), in the signature's order.
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

// What the company part holds until the admin chooses.
export const DEFAULT_MAIL_SIGNATURE_COMPANY_FIELDS: readonly MailSignatureCompanyField[] = [
  "logo",
  "name",
  "address",
  "phone",
  "website",
  "orgNumber",
];

// The name is off by default: the mail templates already put it under the
// greeting ({avsändare}).
export const DEFAULT_MAIL_SIGNATURE_USER_FIELDS: readonly MailSignatureUserField[] = ["title", "phone", "mobile", "email"];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value ? value : null));

// The user's signature as saved (PUT /me/mail-signature) and previewed.
export const mailSignatureSchema = z.object({
  enabled: z.boolean(),
  fields: z.array(z.enum(MAIL_SIGNATURE_USER_FIELDS)).max(MAIL_SIGNATURE_USER_FIELDS.length),
  title: optionalText(100),
  phone: optionalText(50),
  mobile: optionalText(50),
}).strict();
export type MailSignature = z.infer<typeof mailSignatureSchema>;

export const DEFAULT_MAIL_SIGNATURE: MailSignature = {
  enabled: false,
  fields: [...DEFAULT_MAIL_SIGNATURE_USER_FIELDS],
  title: null,
  phone: null,
  mobile: null,
};

// Förhandsvisning: a signature not saved yet, in one of the mail languages.
export const mailSignaturePreviewSchema = mailSignatureSchema.extend({
  language: mailTemplateLanguageSchema.default("sv"),
});
export type MailSignaturePreviewInput = z.infer<typeof mailSignaturePreviewSchema>;

export const mailSignatureCompanyFieldsSchema = z
  .array(z.enum(MAIL_SIGNATURE_COMPANY_FIELDS))
  .max(MAIL_SIGNATURE_COMPANY_FIELDS.length);
