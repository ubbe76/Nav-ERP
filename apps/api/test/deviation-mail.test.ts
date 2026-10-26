import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, deviationEvents, emailLog } from "@navet/db";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, MailSendError, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { resendAccessRule } from "../src/modules/mail/service/resend-access.js";
import { createQualityRepository } from "../src/modules/quality/repository/quality.repository.js";
import { createQualityService } from "../src/modules/quality/service/quality.service.js";
import { pdfText } from "./helpers/pdf.js";
import { testDocumentPdfService } from "./helpers/services.js";

// Skicka (reklamationsrapporten) through the mail module with a fake SMTP
// transport: the PDF is attached, email_log gets the document type
// "deviation" with the details choice, the case's history an email_sent row,
// nothing about the status changes. A failed send is logged as failed and
// leaves no history row. All data made up.

const sent: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
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
const smtp = {
  getSmtpConfig: async () => ({ host: "smtp.example.invalid", port: 587, secure: false, user: "", password: "", fromName: "Nav", fromEmail: "nav@example.invalid" }),
};
const mail = createMailService(createMailRepository(db), smtp, fakeTransport);
const quality = createQualityService({ repo: createQualityRepository(db), pdf: testDocumentPdfService, mail });

const TRUNCATE = sql`TRUNCATE deviations, email_log, customers CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
  sent.length = 0;
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

describe("Skicka reklamationsrapporten", () => {
  it("attaches the PDF, logs email_log with the details choice and a history row; the status is unchanged", async () => {
    const c = await quality.create(
      { type: "internal", title: "Sprucken svets", causeAnalysis: "För låg ström", correctiveAction: "Omsvetsad" },
      null,
      { seePrices: true }
    );
    const logged = await quality.sendEmail(c.id, { to: "kvalitet@example.com", subject: `Avvikelse ${c.deviationNumber}`, message: "Se bifogad rapport", includeDetails: true }, null);
    expect(logged).toMatchObject({ documentType: "deviation", documentId: c.id, status: "sent", includeDetails: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments![0]!.filename).toBe(`Avvikelserapport-${c.deviationNumber}.pdf`);
    const text = pdfText(sent[0]!.attachments![0]!.content);
    expect(text).toContain("Avvikelserapport");
    expect(text).toContain("För låg ström");

    const card = await quality.get(c.id, { seePrices: true });
    expect(card.status).toBe("registered");
    const email = card.events.find((e) => e.event === "email_sent");
    expect(email?.detail).toMatchObject({ to: "kvalitet@example.com", includeDetails: true, emailLogId: logged.id });

    // A failed send: logged as failed, no history row.
    failNext = true;
    await expect(
      quality.sendEmail(c.id, { to: "kvalitet@example.com", subject: "Igen", message: "", includeDetails: false }, null)
    ).rejects.toBeInstanceOf(MailSendError);
    const rows = await db.select().from(emailLog).where(eq(emailLog.documentId, c.id));
    expect(rows.map((r) => [r.status, r.includeDetails])).toEqual(expect.arrayContaining([["sent", true], ["failed", false]]));
    expect(await db.select().from(deviationEvents).where(eq(deviationEvents.event, "email_sent"))).toHaveLength(1);
  });

  it("Skicka om on the e-postlogg needs Kvalitet", () => {
    expect(resendAccessRule("deviation")).toEqual(["kvalitet"]);
  });
});
