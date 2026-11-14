import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { companyInfo, db, emailLog, permissionGroups, salesOrders } from "@navet/db";
import { createArticleSchema, DEFAULT_MAIL_SIGNATURE_COMPANY_FIELDS, type MailSignature } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import type { MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import {
  decodeMailSignature,
  renderSignature,
  SIGNATURE_LOGO_CID,
  signatureLogo,
  signMail,
  type SignatureCompany,
  type SignatureInput,
} from "../src/modules/mail/service/mail-signature.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testSystemService } from "./helpers/services.js";

// E-postsignatur (2026-11-14): the renderer (text and HTML from the same
// lines, the user's and the admin's choices, the logo scaled into its box,
// escaping), the routes (GET/PUT /me/mail-signature, the preview, the
// company setting, Endast läsning) and every document send through the real
// app: signed as the session user in the document's language, the logo
// inline as cid:, email_log.sender_id — and Skicka om signs as the logged
// sender. All data made up.

// A real PNG of the given size (pdfkit reads it like an uploaded logo).
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const COMPANY: SignatureCompany = {
  name: "Exempelverkstaden AB",
  address: "Industrigatan 4",
  postalCode: "123 45",
  city: "Småstad",
  phone: "0123-45 67 00",
  email: "info@exempelverkstaden.invalid",
  website: "www.exempelverkstaden.invalid",
  orgNumber: "556000-0000",
  vatNumber: "SE556000000001",
  companySeat: "Småstad",
};

const SIGNATURE: MailSignature = {
  enabled: true,
  fields: ["name", "title", "phone", "mobile", "email"],
  title: "Inköpare",
  phone: "0123-45 67 10",
  mobile: "070-000 00 00",
};

function input(overrides: Partial<SignatureInput> = {}): SignatureInput {
  return {
    user: { name: "Anna Andersson", email: "anna@exempelverkstaden.invalid" },
    signature: SIGNATURE,
    company: COMPANY,
    companyFields: [...DEFAULT_MAIL_SIGNATURE_COMPANY_FIELDS],
    logo: signatureLogo(png(600, 200)),
    language: "sv",
    ...overrides,
  };
}

describe("the signature", () => {
  it("writes the chosen details, the user's first, as text and as HTML", () => {
    const signature = renderSignature(input())!;
    expect(signature.text).toBe(
      [
        "Anna Andersson",
        "Inköpare",
        "Telefon: 0123-45 67 10",
        "Mobil: 070-000 00 00",
        "anna@exempelverkstaden.invalid",
        "",
        "Exempelverkstaden AB",
        "Industrigatan 4, 123 45 Småstad",
        "Växel: 0123-45 67 00",
        "www.exempelverkstaden.invalid",
        "Org.nr: 556000-0000",
      ].join("\n")
    );
    const html = signature.html("cid:x");
    expect(html).toContain(`<img src="cid:x" width="180" height="60" alt="Exempelverkstaden AB"`);
    expect(html).toContain(`<a href="tel:0123456710"`);
    expect(html).toContain(`<a href="mailto:anna@exempelverkstaden.invalid"`);
    expect(html).toContain(`<a href="https://www.exempelverkstaden.invalid"`);
    // The admin's default leaves the company e-mail, VAT number and seat out.
    expect(html).not.toContain("info@exempelverkstaden.invalid");
    expect(html).not.toContain("SE556000000001");
  });

  it("follows the user's and the admin's choices, and leaves out what is blank", () => {
    const signature = renderSignature(
      input({
        signature: { ...SIGNATURE, fields: ["title", "email"], title: "Säljare" },
        companyFields: ["name", "email", "vatNumber", "companySeat"],
      })
    )!;
    expect(signature.text).toBe(
      [
        "Säljare",
        "anna@exempelverkstaden.invalid",
        "",
        "Exempelverkstaden AB",
        "info@exempelverkstaden.invalid",
        "VAT-nr: SE556000000001 · Säte: Småstad",
      ].join("\n")
    );
    expect(signature.logo).toBeNull();
    expect(signature.html("cid:x")).not.toContain("<img");

    const blank = renderSignature(input({ signature: { ...SIGNATURE, fields: ["title", "phone"], title: " ", phone: null }, company: null }));
    expect(blank).toBeNull();
  });

  it("is in English for an English document", () => {
    const signature = renderSignature(input({ language: "en", companyFields: ["phone", "orgNumber", "vatNumber", "companySeat"] }))!;
    expect(signature.text).toContain("Phone: 0123-45 67 10\nMobile: 070-000 00 00");
    expect(signature.text).toContain("Phone: 0123-45 67 00\nReg. no: 556000-0000 · VAT no: SE556000000001 · Registered office: Småstad");
    expect(signature.text).not.toMatch(/Telefon|Mobil:|Växel|Säte/);
  });

  it("escapes everything that comes from the data", () => {
    const signature = renderSignature(
      input({
        user: { name: `<b>Anna</b> & "Co"`, email: "a@b.invalid" },
        company: { ...COMPANY, name: `<script>x</script>`, website: "javascript:alert(1)" },
        companyFields: ["logo", "name", "website"],
      })
    )!;
    const html = signature.html(`cid:"><x`);
    expect(html).toContain("&lt;b&gt;Anna&lt;/b&gt; &amp; &quot;Co&quot;");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain(`src="cid:&quot;&gt;&lt;x"`);
    // A website without a scheme becomes an https: link, never another scheme.
    expect(html).toContain(`href="https://javascript:alert(1)"`);
  });

  it("scales the logo into its box (never up) and takes PNG and JPEG only", () => {
    expect(signatureLogo(png(600, 200))).toMatchObject({ width: 180, height: 60, contentType: "image/png", filename: "logo.png" });
    expect(signatureLogo(png(100, 400))).toMatchObject({ width: 15, height: 60 });
    expect(signatureLogo(png(90, 30))).toMatchObject({ width: 90, height: 30 });
    expect(signatureLogo(Buffer.from("GIF89a\x01\x00\x01\x00"))).toBeNull();
    expect(signatureLogo(Buffer.from("not an image"))).toBeNull();
    expect(signatureLogo(null)).toBeNull();
  });

  it("puts the message above it: escaped, line breaks kept, the logo as cid:", () => {
    const signature = renderSignature(input())!;
    const mail = signMail("Hej!\n\nSe bifogad <offert>.\n\nMed vänliga hälsningar\nAnna", signature);
    expect(mail.text).toBe(`Hej!\n\nSe bifogad <offert>.\n\nMed vänliga hälsningar\nAnna\n\n${signature.text}`);
    expect(mail.html).toContain("Hej!<br><br>Se bifogad &lt;offert&gt;.<br><br>Med vänliga hälsningar<br>Anna</div>");
    expect(mail.html).toContain(`src="cid:${SIGNATURE_LOGO_CID}"`);
    expect(mail.logo?.contentType).toBe("image/png");
    expect(signMail("", signature).text).toBe(signature.text);
  });

  it("reads a broken stored value as the default (off)", () => {
    expect(decodeMailSignature(undefined)).toMatchObject({ enabled: false, fields: ["title", "phone", "mobile", "email"] });
    expect(decodeMailSignature("{not json")).toMatchObject({ enabled: false });
    expect(decodeMailSignature(JSON.stringify({ ...SIGNATURE, fields: ["shoe size"] }))).toMatchObject({ enabled: false });
    expect(decodeMailSignature(JSON.stringify(SIGNATURE))).toEqual(SIGNATURE);
  });
});

// ---- through the real app ----

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; cid?: string; contentType?: string }[];
}
const sent: SentMail[] = [];
let failNext = false;
const fakeTransport: MailTransportFactory = () => ({
  async sendMail(opts) {
    if (failNext) {
      failNext = false;
      throw new Error("Connection refused");
    }
    sent.push(opts);
  },
});

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const articleService = createArticleService(createArticleRepository(db));
const PASSWORD = "correcthorsebattery";
const LOGO = png(300, 100);
const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series,
  accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_reminders, invoice_rows, invoices,
  sales_order_rows, sales_orders, customers, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, suppliers,
  deviations, articles, email_log, audit_log, user_settings, users CASCADE`;

let app: ReturnType<typeof buildApp>;
let originalCompany: typeof companyInfo.$inferSelect | undefined;
let originalCompanyFields: string | undefined;

beforeAll(async () => {
  app = buildApp(db, { mailTransport: fakeTransport });
  await app.ready();
  [originalCompany] = await db.select().from(companyInfo);
  const [row] = await db.execute<{ value: string }>(sql`SELECT value FROM system_settings WHERE key = 'mail_signature_company_fields'`);
  originalCompanyFields = row?.value;
});

beforeEach(async () => {
  await db.execute(TABLES);
  await db.execute(sql`DELETE FROM permission_groups WHERE code LIKE 'SIGN%'`);
  await db.execute(sql`DELETE FROM system_settings WHERE key = 'mail_signature_company_fields'`);
  await setupPostingBaseline();
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
  await db.update(companyInfo).set({ ...COMPANY, logo: LOGO, logoContentType: "image/png" });
  sent.length = 0;
  failNext = false;
});

afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
  await db.execute(sql`DELETE FROM permission_groups WHERE code LIKE 'SIGN%'`);
  await db.execute(sql`DELETE FROM system_settings WHERE key = 'mail_signature_company_fields'`);
  if (originalCompanyFields !== undefined) {
    await db.execute(
      sql`INSERT INTO system_settings (key, value) VALUES ('mail_signature_company_fields', ${originalCompanyFields}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    );
  }
  if (originalCompany) await db.update(companyInfo).set(originalCompany);
});

async function session(options: { name?: string; readOnly?: boolean } = {}) {
  const email = `sign-${crypto.randomUUID()}@example.com`;
  let permissionGroupId: string | undefined;
  if (options.readOnly) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `SIGN${Math.floor(Math.random() * 1e6)}`, name: "Läs", permissions: ["forsaljning"] })
      .returning();
    permissionGroupId = group!.id;
  }
  const user = await authService.createUser({
    email,
    password: PASSWORD,
    name: options.name ?? "Anna Andersson",
    role: options.readOnly ? "user" : "admin",
    ...(permissionGroupId ? { permissionGroupId, readOnly: true } : {}),
  });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { id: user.id, email, cookie: `session=${res.cookies.find((c) => c.name === "session")!.value}` };
}

function call(cookie: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function ok<T = Record<string, unknown>>(response: Promise<{ statusCode: number; body: string; json(): unknown }>, status = 200) {
  const res = await response;
  if (res.statusCode !== status) throw new Error(`${res.statusCode}: ${res.body}`);
  return (res.statusCode === 204 ? {} : res.json()) as T;
}

const ON: MailSignature = { ...SIGNATURE, fields: ["title", "phone", "email"] };

describe("GET/PUT /me/mail-signature and the preview", () => {
  it("starts off, saves the user's choice and shows the account's name and e-mail", async () => {
    const user = await session();
    expect(await ok(call(user.cookie, "GET", "/me/mail-signature"))).toEqual({
      enabled: false,
      fields: ["title", "phone", "mobile", "email"],
      title: null,
      phone: null,
      mobile: null,
      name: "Anna Andersson",
      email: user.email,
    });
    const saved = await ok(
      call(user.cookie, "PUT", "/me/mail-signature", { ...ON, fields: ["email", "title", "email"], title: "  Inköpare ", mobile: "" })
    );
    // Stored in the catalog's order, trimmed, blank = null.
    expect(saved).toMatchObject({ enabled: true, fields: ["title", "email"], title: "Inköpare", mobile: null });
    expect(await ok(call(user.cookie, "GET", "/me/mail-signature"))).toMatchObject({ enabled: true, fields: ["title", "email"] });
    // Never part of GET /me/settings, which every page reads.
    expect(JSON.stringify(await ok(call(user.cookie, "GET", "/me/settings")))).not.toContain("Inköpare");

    expect((await call(user.cookie, "PUT", "/me/mail-signature", { ...ON, fields: ["shoe size"] })).statusCode).toBe(400);
    expect((await call(user.cookie, "PUT", "/me/mail-signature", { ...ON, colour: "red" })).statusCode).toBe(400);
    expect((await call(user.cookie, "PUT", "/me/mail-signature", { ...ON, title: "x".repeat(101) })).statusCode).toBe(400);
  });

  it("previews an unsaved signature with the logo inline, in the chosen language", async () => {
    const user = await session();
    const preview = await ok<{ html: string; text: string }>(
      call(user.cookie, "POST", "/me/mail-signature/preview", { ...ON, enabled: false, language: "en" })
    );
    expect(preview.text).toBe(
      [
        "Inköpare",
        "Phone: 0123-45 67 10",
        user.email,
        "",
        "Exempelverkstaden AB",
        "Industrigatan 4, 123 45 Småstad",
        "Phone: 0123-45 67 00",
        "www.exempelverkstaden.invalid",
        "Reg. no: 556000-0000",
      ].join("\n")
    );
    expect(preview.html).toContain(`src="data:image/png;base64,${LOGO.toString("base64")}"`);
    expect(preview.html).toContain(`width="180" height="60"`);
    // Nothing saved.
    expect(await ok(call(user.cookie, "GET", "/me/mail-signature"))).toMatchObject({ enabled: false, title: null });
  });

  it("is refused for an Endast läsning account, which sends no documents", async () => {
    const reader = await session({ readOnly: true });
    expect((await call(reader.cookie, "GET", "/me/mail-signature")).statusCode).toBe(200);
    for (const [method, url] of [
      ["PUT", "/me/mail-signature"],
      ["POST", "/me/mail-signature/preview"],
    ] as const) {
      const res = await call(reader.cookie, method, url, ON);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "read-only-account" });
    }
  });

  it("lets the admin choose the company details (GET/PATCH /settings)", async () => {
    const admin = await session();
    expect((await ok<{ mailSignatureCompanyFields: string[] }>(call(admin.cookie, "GET", "/settings"))).mailSignatureCompanyFields).toEqual([
      ...DEFAULT_MAIL_SIGNATURE_COMPANY_FIELDS,
    ]);
    const updated = await ok<{ mailSignatureCompanyFields: string[] }>(
      call(admin.cookie, "PATCH", "/settings", { mailSignatureCompanyFields: ["orgNumber", "name", "name"] })
    );
    expect(updated.mailSignatureCompanyFields).toEqual(["name", "orgNumber"]);
    expect((await call(admin.cookie, "PATCH", "/settings", { mailSignatureCompanyFields: ["bank"] })).statusCode).toBe(400);
    const preview = await ok<{ text: string }>(call(admin.cookie, "POST", "/me/mail-signature/preview", { ...ON, fields: [] }));
    expect(preview.text).toBe("Exempelverkstaden AB\nOrg.nr: 556000-0000");
    // Nothing at all: the company part empty too.
    await ok(call(admin.cookie, "PATCH", "/settings", { mailSignatureCompanyFields: [] }));
    expect(await ok(call(admin.cookie, "POST", "/me/mail-signature/preview", { ...ON, fields: [] }))).toMatchObject({ text: "" });
  });
});

// ---- the sends ----

async function article() {
  const number = `SIG-${crypto.randomUUID().slice(0, 8)}`;
  return articleService.createArticle(parsed(createArticleSchema, { articleNumber: number, name: number, type: "purchased", active: true }));
}

async function lastLog() {
  const [row] = await db.select().from(emailLog).orderBy(desc(emailLog.createdAt)).limit(1);
  return row!;
}

// The mail went out signed as `title`'s owner: text and HTML, the logo as an
// inline cid: attachment after the document's own.
function expectSigned(mail: SentMail, title: string, phoneLabel = "Telefon") {
  expect(mail.text).toContain(`\n\n${title}\n${phoneLabel}: 0123-45 67 10\n`);
  expect(mail.text).toContain("\n\nExempelverkstaden AB\n");
  expect(mail.html).toContain(`<div style="color:#57606a">${title}</div>`);
  expect(mail.html).toContain(`src="cid:${SIGNATURE_LOGO_CID}"`);
  const logo = mail.attachments!.at(-1)!;
  expect(logo).toMatchObject({ cid: SIGNATURE_LOGO_CID, contentType: "image/png", filename: "logo.png" });
  expect(logo.content.equals(LOGO)).toBe(true);
  expect(mail.attachments![0]!.filename).toMatch(/\.pdf$/);
}

describe("the document mails", () => {
  it("every send signs as the session user and logs the sender", async () => {
    const user = await session();
    await ok(call(user.cookie, "PUT", "/me/mail-signature", ON));
    const item = await article();
    const mail = { to: "motpart@example.com", subject: "Dokument", message: "Hej!\n\nSe bifogat.\n\nMed vänliga hälsningar\nAnna" };

    const customer = await ok<{ id: string }>(call(user.cookie, "POST", "/customers", { name: "Kunden AB" }), 201);
    const supplier = await ok<{ id: string }>(call(user.cookie, "POST", "/suppliers", { name: "Leverantören AB", active: true }), 201);
    const { order: quote } = await ok<{ order: { id: string } }>(
      call(user.cookie, "POST", "/quotes", { customerId: customer.id, rows: [{ articleId: item.id, quantity: 1, unitPrice: 100 }] }),
      201
    );
    const { inquiry } = await ok<{ inquiry: { id: string } }>(
      call(user.cookie, "POST", "/inquiries", { supplierId: supplier.id, rows: [{ articleId: item.id, quantity: 1 }] }),
      201
    );
    const order = await ok<{ id: string }>(call(user.cookie, "POST", "/purchase-orders", { supplierId: supplier.id }), 201);
    const deviation = await ok<{ id: string }>(call(user.cookie, "POST", "/deviations", { type: "internal", title: "Sprucken svets" }), 201);
    const draft = await ok<{ id: string }>(
      call(user.cookie, "POST", "/invoices", {
        customerId: customer.id,
        rows: [{ description: "Leverans", quantity: 1, unitPrice: 100, vatRate: 25 }],
      }),
      201
    );
    await ok(call(user.cookie, "POST", `/invoices/${draft.id}/issue`));

    const sends: [string, unknown, number][] = [
      [`/sales-orders/${quote.id}/send-email`, { ...mail, variant: "quote" }, 200],
      [`/inquiries/${inquiry.id}/send-email`, mail, 200],
      [`/purchase-orders/${order.id}/send-email`, mail, 200],
      [`/deviations/${deviation.id}/email`, mail, 204],
      [`/invoices/${draft.id}/send-email`, mail, 204],
      [`/invoices/${draft.id}/reminders`, mail, 200],
    ];
    for (const [url, payload, status] of sends) {
      sent.length = 0;
      await ok(call(user.cookie, "POST", url, payload), status);
      expect(sent, url).toHaveLength(1);
      expectSigned(sent[0]!, "Inköpare");
      expect(sent[0]!.text.startsWith(`${mail.message}\n\n`), url).toBe(true);
      expect((await lastLog()).senderId, url).toBe(user.id);
      // The log keeps the message as written — Skicka om signs it again.
      expect((await lastLog()).message, url).toBe(mail.message);
    }

    // The old invoice mail from the sales order (an order invoiced before C1).
    await db.update(salesOrders).set({ status: "invoiced", invoiceNumber: "F-SIG-1" }).where(eq(salesOrders.id, quote.id));
    sent.length = 0;
    await ok(call(user.cookie, "POST", `/sales-orders/${quote.id}/send-invoice-email`, mail));
    expectSigned(sent[0]!, "Inköpare");
    expect((await lastLog()).senderId).toBe(user.id);
  });

  it("follows the document's language", async () => {
    const user = await session();
    await ok(call(user.cookie, "PUT", "/me/mail-signature", ON));
    const supplier = await ok<{ id: string }>(
      call(user.cookie, "POST", "/suppliers", { name: "Supplier Ltd", active: true, language: "en" }),
      201
    );
    const order = await ok<{ id: string }>(call(user.cookie, "POST", "/purchase-orders", { supplierId: supplier.id }), 201);
    await ok(call(user.cookie, "POST", `/purchase-orders/${order.id}/send-email`, { to: "s@example.com", subject: "PO", message: "Hello" }));
    expectSigned(sent[0]!, "Inköpare", "Phone");
    expect(sent[0]!.text).toContain("Reg. no: 556000-0000");
  });

  it("without a signature (off) the mail is text only, as before — the sender is still logged", async () => {
    const user = await session();
    await ok(call(user.cookie, "PUT", "/me/mail-signature", { ...ON, enabled: false }));
    const deviation = await ok<{ id: string }>(call(user.cookie, "POST", "/deviations", { type: "internal", title: "Glapp" }), 201);
    await ok(call(user.cookie, "POST", `/deviations/${deviation.id}/email`, { to: "k@example.com", subject: "AV", message: "Se bifogad." }), 204);
    expect(sent[0]).toMatchObject({ text: "Se bifogad.", html: undefined });
    expect(sent[0]!.attachments).toHaveLength(1);
    expect((await lastLog()).senderId).toBe(user.id);

    // The test mail never carries one, even with the signature on.
    await ok(call(user.cookie, "PUT", "/me/mail-signature", ON));
    sent.length = 0;
    await ok(call(user.cookie, "POST", "/mail/test", { to: "admin@example.com" }));
    expect(sent[0]!.html).toBeUndefined();
    expect((await lastLog()).senderId).toBeNull();
  });

  it("without a logo (or with the admin's logo off) the HTML has no image and nothing extra is attached", async () => {
    const user = await session();
    await ok(call(user.cookie, "PUT", "/me/mail-signature", ON));
    await db.update(companyInfo).set({ logo: null, logoContentType: null });
    const deviation = await ok<{ id: string }>(call(user.cookie, "POST", "/deviations", { type: "internal", title: "Glapp" }), 201);
    await ok(call(user.cookie, "POST", `/deviations/${deviation.id}/email`, { to: "k@example.com", subject: "AV", message: "Se bifogad." }), 204);
    expect(sent[0]!.html).toContain("Exempelverkstaden AB");
    expect(sent[0]!.html).not.toContain("<img");
    expect(sent[0]!.attachments).toHaveLength(1);
  });

  it("Skicka om signs as the logged sender, not as whoever presses the button", async () => {
    const anna = await session({ name: "Anna Andersson" });
    await ok(call(anna.cookie, "PUT", "/me/mail-signature", ON));
    const bertil = await session({ name: "Bertil Berg" });
    await ok(call(bertil.cookie, "PUT", "/me/mail-signature", { ...ON, title: "Säljare" }));

    const deviation = await ok<{ id: string }>(call(anna.cookie, "POST", "/deviations", { type: "internal", title: "Glapp" }), 201);
    failNext = true;
    const failed = await call(anna.cookie, "POST", `/deviations/${deviation.id}/email`, { to: "k@example.com", subject: "AV", message: "Hej" });
    expect(failed.statusCode).toBe(502);
    const failedLog = await lastLog();
    expect(failedLog).toMatchObject({ status: "failed", senderId: anna.id });

    await ok(call(bertil.cookie, "POST", `/email-log/${failedLog.id}/resend`));
    expectSigned(sent.at(-1)!, "Inköpare");
    expect(sent.at(-1)!.text).not.toContain("Säljare");
    expect(await lastLog()).toMatchObject({ status: "sent", senderId: anna.id });

    // A row from before 0219 (no sender) goes out without, as it did.
    await db.update(emailLog).set({ senderId: null }).where(eq(emailLog.id, failedLog.id));
    sent.length = 0;
    await ok(call(bertil.cookie, "POST", `/email-log/${failedLog.id}/resend`));
    expect(sent[0]).toMatchObject({ text: "Hej", html: undefined });
  });
});
