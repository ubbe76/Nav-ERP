import { z } from "zod";
import {
  MAIL_BODY_MAX,
  MAIL_SUBJECT_MAX,
  MAIL_TEMPLATE_KINDS,
  MAIL_TEMPLATE_LANGUAGES,
} from "./mail-template-catalog.js";

export * from "./mail-template-catalog.js";

// E-postmallar: the API's input. The catalog (kinds, placeholders, defaults,
// the check and the fill) is mail-template-catalog.ts.

export const mailTemplateKindSchema = z.enum(MAIL_TEMPLATE_KINDS);
export const mailTemplateLanguageSchema = z.enum(MAIL_TEMPLATE_LANGUAGES);

// PUT /me/mail-templates/:kind/:language — the template as written. The
// placeholders are checked against the kind in the service (400
// mail-template-placeholder).
export const mailTemplateSchema = z
  .object({
    subject: z.string().trim().min(1).max(MAIL_SUBJECT_MAX),
    body: z.string().max(MAIL_BODY_MAX),
  })
  .strict();

export const mailTemplateParamsSchema = z.object({
  kind: mailTemplateKindSchema,
  language: mailTemplateLanguageSchema,
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().max(max).nullish();

// POST /me/mail-text — the document's own values from the page that opens
// the send dialog; the server adds {avsändare} (the signed-in user) and
// {företag} (Företagsinformation) and formats {belopp} on the document's
// language. `template` = preview an unsaved template instead of the saved one.
export const mailTextRequestSchema = z
  .object({
    kind: mailTemplateKindSchema,
    language: mailTemplateLanguageSchema,
    values: z
      .object({
        number: z.string().trim().max(100),
        customer: text(300),
        supplier: text(300),
        contact: text(300),
        amount: z.object({ value: z.number().finite(), currency: z.string().trim().length(3) }).nullish(),
        dueDate: isoDate.nullish(),
        validUntil: isoDate.nullish(),
        deliveryDate: isoDate.nullish(),
        quoteNumber: text(100),
      })
      .strict(),
    template: mailTemplateSchema.optional(),
  })
  .strict();
export type MailTextRequest = z.infer<typeof mailTextRequestSchema>;

// Byt lösenord (Mina inställningar): the signed-in user's own password. The
// new one has the same rule as when an account is created.
export const changeOwnPasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(255),
    newPassword: z.string().min(8).max(255),
  })
  .strict();
export type ChangeOwnPasswordInput = z.infer<typeof changeOwnPasswordSchema>;
