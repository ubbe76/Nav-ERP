import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  DEFAULT_MAIL_TEMPLATES,
  MAIL_PLACEHOLDERS,
  MAIL_TEMPLATE_KINDS,
  MAIL_TEMPLATE_LANGUAGES,
  MAIL_TEMPLATE_PLACEHOLDERS,
  renderMailTemplate,
  unknownMailPlaceholders,
  type MailTemplateKind,
} from "@navet/shared";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { decodeMailTemplates } from "../src/modules/mail/service/mail-templates.service.js";

// E-postmallar (Mina inställningar, 2026-11-13): the catalog (shared, copied
// byte for byte to the web), the defaults = the texts the send dialogs had
// before plus the sender's name, and GET/PUT/DELETE /me/mail-templates and
// POST /me/mail-text through the real app.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const TRUNCATE = sql`TRUNCATE user_settings, audit_log, users CASCADE`;
const PASSWORD = "correcthorsebattery";

let app: ReturnType<typeof buildApp>;
let originalCompanyName = "";

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  const [row] = await db.execute<{ name: string }>(sql`SELECT name FROM company_info LIMIT 1`);
  originalCompanyName = row?.name ?? "";
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM permission_groups WHERE code LIKE 'MALL%'`);
  await db.execute(sql`UPDATE company_info SET name = 'Exempelverkstaden AB'`);
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM permission_groups WHERE code LIKE 'MALL%'`);
  await db.execute(sql`UPDATE company_info SET name = ${originalCompanyName}`);
});

async function session(options: { name?: string; readOnly?: boolean } = {}) {
  const email = `mall-${crypto.randomUUID()}@example.com`;
  let permissionGroupId: string | undefined;
  if (options.readOnly) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `MALL${Math.floor(Math.random() * 1e6)}`, name: "Läs", permissions: ["forsaljning"] })
      .returning();
    permissionGroupId = group!.id;
  }
  await authService.createUser({
    email,
    password: PASSWORD,
    name: options.name ?? "Anna Andersson",
    role: options.readOnly ? "user" : "admin",
    ...(permissionGroupId ? { permissionGroupId, readOnly: true } : {}),
  });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

const mailText = (cookie: string, payload: object) =>
  app.inject({ method: "POST", url: "/api/v1/me/mail-text", headers: { cookie }, payload });

describe("the catalog", () => {
  it("is copied byte for byte to the web", () => {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    expect(read("../../web/lib/mailTemplateCatalog.ts")).toBe(read("../../../packages/shared/src/mail-template-catalog.ts"));
  });

  it("keeps the texts the dialogs had before, with the sender's name after the greeting", () => {
    const sv = (text: string) => `Hej!\n\n${text}\n\nMed vänliga hälsningar\nAnna`;
    const en = (text: string) => `Hello,\n\n${text}\n\nBest regards\nAnna`;
    const fill = (kind: MailTemplateKind, language: "sv" | "en") => {
      const t = DEFAULT_MAIL_TEMPLATES[kind][language];
      const values = { nummer: "N1", avsändare: "Anna" };
      return { subject: renderMailTemplate(t.subject, values), body: renderMailTemplate(t.body, values) };
    };
    expect(fill("quote", "sv")).toEqual({ subject: "Offert N1", body: sv("Se bifogad offert N1.") });
    expect(fill("orderConfirmation", "sv")).toEqual({
      subject: "Orderbekräftelse N1",
      body: sv("Tack för er order. Se bifogad orderbekräftelse N1."),
    });
    expect(fill("invoice", "sv")).toEqual({ subject: "Faktura N1", body: sv("Se bifogad faktura N1.") });
    expect(fill("creditNote", "sv")).toEqual({ subject: "Kreditfaktura N1", body: sv("Se bifogad kreditfaktura N1.") });
    expect(fill("paymentReminder", "sv")).toEqual({
      subject: "Betalningspåminnelse faktura N1",
      body: sv("Vi har tyvärr ännu inte mottagit betalning för faktura N1. Se bifogad påminnelse."),
    });
    expect(fill("inquiry", "sv")).toEqual({ subject: "Förfrågan N1", body: sv("Se bifogad förfrågan N1.") });
    expect(fill("purchaseOrder", "sv")).toEqual({ subject: "Inköpsorder N1", body: sv("Se bifogad inköpsorder N1.") });
    expect(fill("deviationCustomer", "sv")).toEqual({
      subject: "Reklamationsbesked N1",
      body: sv("Se bifogat reklamationsbesked N1."),
    });
    // "bifogad reklamation/avvikelserapport" — the old text said "bifogat".
    expect(fill("deviationSupplier", "sv").body).toBe(sv("Se bifogad reklamation N1."));
    expect(fill("deviationInternal", "sv").body).toBe(sv("Se bifogad avvikelserapport N1."));
    expect(fill("quote", "en")).toEqual({ subject: "Quotation N1", body: en("Please find attached quotation N1.") });
    expect(fill("paymentReminder", "en")).toEqual({
      subject: "Payment reminder for invoice N1",
      body: en("We have unfortunately not yet received payment for invoice N1. Please find the reminder attached."),
    });
    expect(fill("deviationCustomer", "en").subject).toBe("Complaint notice N1");
  });

  it("writes the English defaults with no Swedish left", () => {
    for (const kind of MAIL_TEMPLATE_KINDS) {
      const t = DEFAULT_MAIL_TEMPLATES[kind].en;
      const body = renderMailTemplate(t.body, { nummer: "N1", avsändare: "Anna" });
      expect(body.startsWith("Hello,\n\n")).toBe(true);
      expect(body.endsWith("\n\nBest regards\nAnna")).toBe(true);
      expect(`${renderMailTemplate(t.subject, { nummer: "N1" })} ${body}`).not.toMatch(
        /[åäöÅÄÖ]|Hej|bifogad|Offert|Faktura|Förfrågan|Inköpsorder/
      );
    }
    expect(renderMailTemplate(DEFAULT_MAIL_TEMPLATES.creditNote.en.subject, { nummer: "F2" })).toBe("Credit note F2");
  });

  it("gives every kind a default per language that only uses the kind's own placeholders", () => {
    for (const kind of MAIL_TEMPLATE_KINDS) {
      expect(MAIL_TEMPLATE_PLACEHOLDERS[kind]).toEqual(expect.arrayContaining(["nummer", "avsändare", "företag"]));
      for (const placeholder of MAIL_TEMPLATE_PLACEHOLDERS[kind]) expect(MAIL_PLACEHOLDERS).toContain(placeholder);
      for (const language of MAIL_TEMPLATE_LANGUAGES) {
        const t = DEFAULT_MAIL_TEMPLATES[kind][language];
        expect(unknownMailPlaceholders(kind, `${t.subject}\n${t.body}`)).toEqual([]);
      }
    }
  });

  it("finds the placeholders a kind does not offer, each once", () => {
    expect(unknownMailPlaceholders("inquiry", "{nummer} {kund} {nummmer} {kund} {förfallodatum}")).toEqual([
      "kund",
      "nummmer",
      "förfallodatum",
    ]);
    expect(unknownMailPlaceholders("quote", "Hej {kontakt}! {belopp} {giltig}")).toEqual([]);
    // Not a placeholder at all: an empty pair, a line break inside.
    expect(unknownMailPlaceholders("quote", "{} {a\nb}")).toEqual([]);
  });

  it("fills known placeholders, makes a missing value empty and leaves other braces as written", () => {
    expect(renderMailTemplate("Hej {kontakt}! {nummer} {okänd} {nummer}", { nummer: "OF-1", kontakt: null })).toBe(
      "Hej ! OF-1 {okänd} OF-1"
    );
  });

  it("drops a stored template that no longer passes when read", () => {
    const raw = JSON.stringify({
      quote: { sv: { subject: "Offert {nummer}", body: "ok" }, en: { subject: "", body: "tom rubrik" } },
      inquiry: { sv: { subject: "Förfrågan", body: "{kund}" } },
      nonsense: { sv: { subject: "x", body: "y" } },
    });
    expect(decodeMailTemplates(raw)).toEqual({ quote: { sv: { subject: "Offert {nummer}", body: "ok" } } });
    expect(decodeMailTemplates("not json")).toEqual({});
  });
});

describe("/me/mail-templates and /me/mail-text", () => {
  it("lists every kind and language with the defaults until the user saves their own", async () => {
    const cookie = await session();
    const res = await app.inject({ method: "GET", url: "/api/v1/me/mail-templates", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { kind: string; language: string; subject: string; body: string; custom: boolean }[];
    expect(list).toHaveLength(MAIL_TEMPLATE_KINDS.length * MAIL_TEMPLATE_LANGUAGES.length);
    expect(list.every((t) => !t.custom)).toBe(true);
    expect(list.find((t) => t.kind === "quote" && t.language === "sv")).toMatchObject(DEFAULT_MAIL_TEMPLATES.quote.sv);
  });

  it("fills the default with the page's values, the user's name and the company's", async () => {
    const cookie = await session({ name: "Anna Andersson" });
    const res = await mailText(cookie, { kind: "quote", language: "sv", values: { number: "OF-1002" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      subject: "Offert OF-1002",
      body: "Hej!\n\nSe bifogad offert OF-1002.\n\nMed vänliga hälsningar\nAnna Andersson",
    });
  });

  it("saves the user's own template, uses it in the dialog and formats the amount on the document's language", async () => {
    const cookie = await session({ name: "Anna Andersson" });
    const template = {
      subject: "Offert {nummer} från {företag}",
      body: "Hej {kontakt}!\n\nHär är offerten till {kund} på {belopp}, giltig t.o.m. {giltig}.\n\n/{avsändare}",
    };
    const saved = await app.inject({ method: "PUT", url: "/api/v1/me/mail-templates/quote/sv", headers: { cookie }, payload: template });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ kind: "quote", language: "sv", ...template, custom: true });

    const values = {
      number: "OF-1002",
      customer: "Hotell Exempel AB",
      contact: "Eva",
      amount: { value: 12345.5, currency: "SEK" },
      validUntil: "2026-11-30",
    };
    const sv = await mailText(cookie, { kind: "quote", language: "sv", values });
    expect(sv.json().subject).toBe("Offert OF-1002 från Exempelverkstaden AB");
    expect(sv.json().body).toMatch(/^Hej Eva!\n\nHär är offerten till Hotell Exempel AB på 12\s345,50 kr, giltig t\.o\.m\. 2026-11-30\.\n\n\/Anna Andersson$/);

    // English still has the default; the amount there is "12,345.50 EUR".
    const en = await mailText(cookie, {
      kind: "quote",
      language: "en",
      template: { subject: "{belopp}", body: "" },
      values: { ...values, amount: { value: 12345.5, currency: "EUR" } },
    });
    expect(en.json().subject).toBe("12,345.50 EUR");
    const enDefault = await mailText(cookie, { kind: "quote", language: "en", values });
    expect(enDefault.json().subject).toBe("Quotation OF-1002");

    const list = (await app.inject({ method: "GET", url: "/api/v1/me/mail-templates", headers: { cookie } })).json() as {
      kind: string;
      language: string;
      custom: boolean;
    }[];
    expect(list.filter((t) => t.custom).map((t) => `${t.kind}/${t.language}`)).toEqual(["quote/sv"]);
  });

  it("refuses a placeholder the document type does not offer, and saves nothing", async () => {
    const cookie = await session();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/mail-templates/inquiry/sv",
      headers: { cookie },
      payload: { subject: "Förfrågan {nummmer}", body: "Till {kund}" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "mail-template-placeholder",
      placeholders: ["nummmer", "kund"],
      error: "Platshållarna {nummmer}, {kund} finns inte för förfrågan.",
    });
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM user_settings`);
    expect(row!.n).toBe(0);
    // The preview is checked the same way.
    const preview = await mailText(cookie, {
      kind: "inquiry",
      language: "sv",
      template: { subject: "{belopp}", body: "" },
      values: { number: "FF-1" },
    });
    expect(preview.statusCode).toBe(400);
    expect(preview.json().code).toBe("mail-template-placeholder");
  });

  it("refuses an empty subject, an unknown kind and an unknown language", async () => {
    const cookie = await session();
    const put = (url: string, payload: object) => app.inject({ method: "PUT", url, headers: { cookie }, payload });
    expect((await put("/api/v1/me/mail-templates/quote/sv", { subject: " ", body: "x" })).statusCode).toBe(400);
    expect((await put("/api/v1/me/mail-templates/order/sv", { subject: "x", body: "x" })).statusCode).toBe(400);
    expect((await put("/api/v1/me/mail-templates/quote/de", { subject: "x", body: "x" })).statusCode).toBe(400);
  });

  it("resets to the default with Återställ förval", async () => {
    const cookie = await session({ name: "Bo" });
    await app.inject({
      method: "PUT",
      url: "/api/v1/me/mail-templates/invoice/sv",
      headers: { cookie },
      payload: { subject: "Fakturan {nummer}", body: "{förfallodatum}" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/me/mail-templates/invoice/en",
      headers: { cookie },
      payload: { subject: "Your invoice {nummer}", body: "" },
    });
    const reset = await app.inject({ method: "DELETE", url: "/api/v1/me/mail-templates/invoice/sv", headers: { cookie } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ kind: "invoice", language: "sv", ...DEFAULT_MAIL_TEMPLATES.invoice.sv, custom: false });
    expect((await mailText(cookie, { kind: "invoice", language: "sv", values: { number: "F1" } })).json().subject).toBe("Faktura F1");
    // The other language is left as saved.
    expect((await mailText(cookie, { kind: "invoice", language: "en", values: { number: "F1" } })).json().subject).toBe(
      "Your invoice F1"
    );
  });

  it("keeps each user's templates to themselves", async () => {
    const anna = await session({ name: "Anna" });
    const bo = await session({ name: "Bo" });
    await app.inject({
      method: "PUT",
      url: "/api/v1/me/mail-templates/purchaseOrder/sv",
      headers: { cookie: anna },
      payload: { subject: "IO {nummer} till {leverantör}", body: "" },
    });
    const values = { number: "IO-5", supplier: "Bult AB" };
    expect((await mailText(anna, { kind: "purchaseOrder", language: "sv", values })).json().subject).toBe("IO IO-5 till Bult AB");
    expect((await mailText(bo, { kind: "purchaseOrder", language: "sv", values })).json().subject).toBe("Inköpsorder IO-5");
  });

  it("lets an Endast läsning account fill in a text but not save a template", async () => {
    const cookie = await session({ readOnly: true });
    expect((await mailText(cookie, { kind: "quote", language: "sv", values: { number: "OF-1" } })).statusCode).toBe(200);
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/me/mail-templates/quote/sv",
      headers: { cookie },
      payload: { subject: "x", body: "" },
    });
    expect(put.statusCode).toBe(403);
    expect(put.json().code).toBe("read-only-account");
  });

  it("needs a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/me/mail-templates" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/me/mail-text", payload: { kind: "quote", language: "sv", values: { number: "1" } } }))
        .statusCode
    ).toBe(401);
  });
});
