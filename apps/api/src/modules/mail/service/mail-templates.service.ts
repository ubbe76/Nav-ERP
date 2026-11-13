import {
  DEFAULT_MAIL_TEMPLATES,
  MAIL_TEMPLATE_KIND_LABELS,
  MAIL_TEMPLATE_KINDS,
  MAIL_TEMPLATE_LANGUAGES,
  mailTemplateSchema,
  renderMailTemplate,
  unknownMailPlaceholders,
  type MailPlaceholder,
  type MailTemplate,
  type MailTemplateKind,
  type MailTemplateLanguage,
  type MailTextRequest,
} from "@navet/shared";
import { formatNumber } from "./document-pdf.js";

// E-postmallar (Mina inställningar, 2026-11-13): each user's own subject and
// text per document type and language, stored as ONE user setting (JSON
// { kind: { sv?: {subject, body}, en?: … } }) — never in GET /me/settings,
// which every page reads. The dialogs ask for the filled-in text with
// POST /me/mail-text; without a saved template the catalog's default applies.

export const MAIL_TEMPLATES_SETTING_KEY = "mail_templates";

export class MailTemplatePlaceholderError extends Error {
  readonly placeholders: string[];
  constructor(kind: MailTemplateKind, placeholders: string[]) {
    const names = placeholders.map((p) => `{${p}}`).join(", ");
    super(
      `${placeholders.length === 1 ? "Platshållaren" : "Platshållarna"} ${names} finns inte för ${MAIL_TEMPLATE_KIND_LABELS[kind].toLowerCase()}.`
    );
    this.name = "MailTemplatePlaceholderError";
    this.placeholders = placeholders;
  }
}

// The store: the user-settings repository's get/updateValue (updateValue
// creates and locks the row, so two tabs saving different templates both
// land).
export interface MailTemplateStore {
  get(userId: string, key: string): Promise<string | undefined>;
  updateValue(userId: string, key: string, change: (raw: string | undefined) => string): Promise<void>;
}

type StoredTemplates = Partial<Record<MailTemplateKind, Partial<Record<MailTemplateLanguage, MailTemplate>>>>;

// Tolerant read: anything that no longer passes the schema or the kind's
// placeholders is dropped (the default applies again).
export function decodeMailTemplates(raw: string | undefined): StoredTemplates {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const result: StoredTemplates = {};
  for (const kind of MAIL_TEMPLATE_KINDS) {
    const perLanguage = (parsed as Record<string, unknown>)[kind];
    if (!perLanguage || typeof perLanguage !== "object") continue;
    for (const language of MAIL_TEMPLATE_LANGUAGES) {
      const check = mailTemplateSchema.safeParse((perLanguage as Record<string, unknown>)[language]);
      if (!check.success) continue;
      if (unknownMailPlaceholders(kind, `${check.data.subject}\n${check.data.body}`).length > 0) continue;
      (result[kind] ??= {})[language] = check.data;
    }
  }
  return result;
}

export interface MailTemplateView extends MailTemplate {
  kind: MailTemplateKind;
  language: MailTemplateLanguage;
  // false = the catalog's default (no template of the user's own).
  custom: boolean;
}

export interface MailTextUser {
  id: string;
  name: string;
}

// {belopp}: the amount on the document's language, "1 234,50 kr" /
// "1,234.50 SEK" (the PDFs' own number format, formatNumber).
export function formatMailAmount(amount: { value: number; currency: string }, language: MailTemplateLanguage): string {
  const currency = amount.currency.toUpperCase();
  const unit = currency === "SEK" && language === "sv" ? "kr" : currency;
  return `${formatNumber(amount.value, 2, language)} ${unit}`;
}

export function createMailTemplatesService(deps: { store: MailTemplateStore; companyName: () => Promise<string | null> }) {
  const { store, companyName } = deps;

  async function stored(userId: string): Promise<StoredTemplates> {
    return decodeMailTemplates(await store.get(userId, MAIL_TEMPLATES_SETTING_KEY));
  }

  function assertPlaceholders(kind: MailTemplateKind, template: MailTemplate) {
    const unknown = unknownMailPlaceholders(kind, `${template.subject}\n${template.body}`);
    if (unknown.length > 0) throw new MailTemplatePlaceholderError(kind, unknown);
  }

  // Changes one (kind, language) under the row lock; null removes it.
  async function change(userId: string, kind: MailTemplateKind, language: MailTemplateLanguage, template: MailTemplate | null) {
    await store.updateValue(userId, MAIL_TEMPLATES_SETTING_KEY, (raw) => {
      const current = decodeMailTemplates(raw);
      const perLanguage = { ...(current[kind] ?? {}) };
      if (template) perLanguage[language] = template;
      else delete perLanguage[language];
      if (Object.keys(perLanguage).length > 0) current[kind] = perLanguage;
      else delete current[kind];
      return JSON.stringify(current);
    });
  }

  return {
    // Every kind × language, the user's own where saved, else the default.
    async list(userId: string): Promise<MailTemplateView[]> {
      const own = await stored(userId);
      return MAIL_TEMPLATE_KINDS.flatMap((kind) =>
        MAIL_TEMPLATE_LANGUAGES.map((language) => {
          const template = own[kind]?.[language];
          return { kind, language, ...(template ?? DEFAULT_MAIL_TEMPLATES[kind][language]), custom: template !== undefined };
        })
      );
    },

    async save(userId: string, kind: MailTemplateKind, language: MailTemplateLanguage, template: MailTemplate): Promise<MailTemplateView> {
      assertPlaceholders(kind, template);
      await change(userId, kind, language, template);
      return { kind, language, ...template, custom: true };
    },

    // Återställ förval.
    async reset(userId: string, kind: MailTemplateKind, language: MailTemplateLanguage): Promise<MailTemplateView> {
      await change(userId, kind, language, null);
      return { kind, language, ...DEFAULT_MAIL_TEMPLATES[kind][language], custom: false };
    },

    // The send dialog's text: the user's template (or `template`, a preview
    // of one not saved yet — checked like a save) filled with the page's
    // values, the user's name and the company's.
    async render(user: MailTextUser, request: MailTextRequest): Promise<MailTemplate> {
      const { kind, language, values } = request;
      let template: MailTemplate;
      if (request.template) {
        assertPlaceholders(kind, request.template);
        template = request.template;
      } else {
        template = (await stored(user.id))[kind]?.[language] ?? DEFAULT_MAIL_TEMPLATES[kind][language];
      }
      const filled: Record<MailPlaceholder, string | null> = {
        nummer: values.number,
        avsändare: user.name,
        företag: await companyName(),
        kund: values.customer ?? null,
        leverantör: values.supplier ?? null,
        kontakt: values.contact ?? null,
        belopp: values.amount ? formatMailAmount(values.amount, language) : null,
        förfallodatum: values.dueDate ?? null,
        giltig: values.validUntil ?? null,
        leveransdatum: values.deliveryDate ?? null,
        offertnummer: values.quoteNumber ?? null,
      };
      return { subject: renderMailTemplate(template.subject, filled).trim(), body: renderMailTemplate(template.body, filled) };
    },
  };
}

export type MailTemplatesService = ReturnType<typeof createMailTemplatesService>;
