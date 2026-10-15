import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { customers, db, invoices } from "@navet/db";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import {
  createMailService,
  MailSendError,
  SmtpNotConfiguredError,
  type MailTransportFactory,
} from "../src/modules/mail/service/mail.service.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";

const sentMails: { from: string; to: string; subject: string }[] = [];
let failNextSend = false;
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("Invalid login");
    }
    sentMails.push(opts);
  },
});

const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE customers, invoices, email_log CASCADE`);
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'smtp_%'`);
  sentMails.length = 0;
  failNextSend = false;
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE customers, invoices, email_log CASCADE`);
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'smtp_%'`);
});

describe("mail service", () => {
  it("refuses to send while SMTP is unconfigured", async () => {
    await expect(mailService.sendTestMail("nagon@example.com")).rejects.toThrow(SmtpNotConfiguredError);
    const log = await mailService.listEmailLog({ limit: 50, offset: 0 });
    expect(log.total).toBe(0);
  });

  it("sends a test mail with the configured from-address and logs it", async () => {
    await systemService.updateSettings({
      smtpHost: "smtp.test.local",
      smtpFromName: "Nav-ERP Test",
      smtpFromEmail: "erp@test.local",
    });

    await mailService.sendTestMail("nagon@example.com");

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.from).toBe('"Nav-ERP Test" <erp@test.local>');
    expect(sentMails[0]?.to).toBe("nagon@example.com");

    const log = await mailService.listEmailLog({ limit: 50, offset: 0 });
    expect(log.total).toBe(1);
    expect(log.rows[0]?.documentType).toBe("test");
    expect(log.rows[0]?.status).toBe("sent");
  });

  it("logs failed sends with the SMTP error and filters the log by status", async () => {
    await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });

    failNextSend = true;
    await expect(mailService.sendTestMail("fel@example.com")).rejects.toThrow(MailSendError);
    await mailService.sendTestMail("ratt@example.com");

    const failed = await mailService.listEmailLog({ status: ["failed"], limit: 50, offset: 0 });
    expect(failed.total).toBe(1);
    expect(failed.rows[0]?.recipient).toBe("fel@example.com");
    expect(failed.rows[0]?.error).toContain("Invalid login");

    const searched = await mailService.listEmailLog({ search: "ratt@", limit: 50, offset: 0 });
    expect(searched.total).toBe(1);
    expect(searched.rows[0]?.status).toBe("sent");
  });

  it("masks the SMTP password in getSettings but keeps it on blank updates", async () => {
    await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpPassword: "hemligt" });

    let settings = await systemService.getSettings();
    expect(settings.smtpPasswordSet).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("hemligt");

    // Blank password on PATCH = keep the stored one.
    await systemService.updateSettings({ smtpHost: "smtp2.test.local", smtpPassword: "" });
    settings = await systemService.getSettings();
    expect(settings.smtpPasswordSet).toBe(true);

    const config = await systemService.getSmtpConfig();
    expect(config?.password).toBe("hemligt");
    expect(config?.host).toBe("smtp2.test.local");
  });

  // Bug fix: documentType "invoice" rows aren't all the same — old (pre-C1)
  // rows were stamped with a sales order id since real invoices didn't exist
  // yet, while post-C1 rows carry a real invoices.id. The list query derives
  // linkKind by probing for a matching invoices row so the web can route the
  // Dokument column link correctly without a migration on the enum.
  it("derives linkKind for invoice rows by probing whether documentId is a real invoice", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ customerNumber: `TEST-${crypto.randomUUID()}`, name: "Kund AB" })
      .returning();
    const [invoice] = await db.insert(invoices).values({ customerId: customer!.id }).returning();

    const repo = createMailRepository(db);
    await repo.logEmail({
      documentType: "invoice",
      documentId: invoice!.id,
      recipient: "faktura@example.com",
      subject: "Faktura",
      message: "",
      attachDrawings: false,
      status: "sent",
      error: null,
    });
    // No real sales order needed — any id that isn't in `invoices` exercises
    // the "old row, no matching invoice" branch just as well.
    const legacyOrderId = crypto.randomUUID();
    await repo.logEmail({
      documentType: "invoice",
      documentId: legacyOrderId,
      recipient: "gammal@example.com",
      subject: "Orderbekräftelse",
      message: "",
      attachDrawings: false,
      status: "sent",
      error: null,
    });
    // A non-"invoice" documentType should pass straight through untouched.
    await repo.logEmail({
      documentType: "quote",
      documentId: legacyOrderId,
      recipient: "offert@example.com",
      subject: "Offert",
      message: "",
      attachDrawings: false,
      status: "sent",
      error: null,
    });

    const log = await mailService.listEmailLog({ limit: 50, offset: 0 });
    expect(log.total).toBe(3);

    const invoiceRow = log.rows.find((r) => r.recipient === "faktura@example.com");
    expect(invoiceRow?.linkKind).toBe("invoice");

    const legacyRow = log.rows.find((r) => r.recipient === "gammal@example.com");
    expect(legacyRow?.linkKind).toBe("sales_order");

    const quoteRow = log.rows.find((r) => r.recipient === "offert@example.com");
    expect(quoteRow?.linkKind).toBe("quote");
  });
});
