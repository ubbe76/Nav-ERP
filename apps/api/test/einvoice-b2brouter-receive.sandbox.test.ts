import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { like, sql } from "drizzle-orm";
import { companyInfo, db, einvoiceReceptions, invoiceScans, systemSettings } from "@navet/db";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createInvoiceScanRepository } from "../src/modules/purchase/repository/invoice-scan.repository.js";
import { createInvoiceScanService } from "../src/modules/purchase/service/invoice-scan.service.js";
import { createInvoiceScanSettingsService } from "../src/modules/purchase/service/invoice-scan-settings.service.js";
import type { EInvoiceOriginalReader } from "../src/modules/purchase/service/invoice-scan/einvoice-original.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createEinvoiceRepository } from "../src/modules/einvoice/repository/einvoice.repository.js";
import { createEinvoiceSettingsService } from "../src/modules/einvoice/service/einvoice-settings.service.js";
import { createEinvoiceReceiveService } from "../src/modules/einvoice/service/einvoice-receive.service.js";
import { createB2BrouterProvider } from "../src/modules/einvoice/service/b2brouter-provider.js";
import { buildUblDocument } from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import type { UblInvoiceInput } from "../src/modules/einvoice/service/ubl/ubl-types.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";
import { createFakeInvoiceInterpreter } from "./helpers/fake-invoice-interpreter.js";
import { FAKE_PDF } from "./helpers/ubl-fixtures.js";

// Mottagning mot B2Brouters sandlåda — körs bara med B2BROUTER_SANDBOX_API_KEY
// (spec 2026-11-05-e-faktura-mottagning, "Verifierat i sandlådan"): a
// document imported as RECEIVED (POST /accounts/{id}/invoices/import?
// issued=false, the buyer = the account's own company, whose VAT number is
// read at run time and never written down here), then the real reception
// job against the real access point: the post exists in the inbox, the
// original is stored, the document is acknowledged. Every identifier below
// except the account's is invented and Luhn-valid.
const KEY = process.env.B2BROUTER_SANDBOX_API_KEY;

const audit = createAuditRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const scanRepo = createInvoiceScanRepository(db);
const interpreter = createFakeInvoiceInterpreter();
const originalRef: { current: EInvoiceOriginalReader | null } = { current: null };
const scanService = createInvoiceScanService({
  repo: scanRepo,
  supplierInvoices: createSupplierInvoiceService(createSupplierInvoiceRepository(db), createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }), audit),
  company: systemService,
  settings: createInvoiceScanSettingsService({ repo: scanRepo, audit, interpreters: interpreter.factory }),
  audit,
  interpreters: interpreter.factory,
  einvoiceOriginals: {
    infoForScan: (id) => originalRef.current!.infoForScan(id),
    forScan: (id) => originalRef.current!.forScan(id),
    originalXml: (id) => originalRef.current!.originalXml(id),
    attachment: (id, i) => originalRef.current!.attachment(id, i),
  },
});
const repo = createEinvoiceRepository(db);
const settings = createEinvoiceSettingsService({ repo, company: systemService, audit });
const receive = createEinvoiceReceiveService({ repo, settings, scans: scanService, audit });
originalRef.current = receive;

const TRUNCATE = sql`TRUNCATE einvoice_receptions, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, suppliers CASCADE`;

function receivedInvoice(n: string, buyer: { vatNumber: string; orgNumber: string; name: string }): UblInvoiceInput {
  return {
    type: "invoice",
    invoiceNumber: n,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    currency: "SEK",
    language: "sv",
    taxCurrency: null,
    delivery: null,
    buyerReference: "Inköp",
    orderReference: "IO-1005",
    creditedInvoiceNumber: null,
    note: null,
    paymentTermsNote: "30 dagar netto",
    seller: {
      name: "Leverantören Test AB",
      orgNumber: "5565555553",
      vatNumber: "SE556555555301",
      address: { addressLines: ["Leverantörsgatan 2"], postalCode: "11151", city: "Stockholm", country: "SE" },
      email: "faktura@lev.example",
      phone: null,
      fSkatt: true,
    },
    buyer: {
      endpoint: { scheme: "0007", value: buyer.orgNumber },
      name: buyer.name,
      address: { addressLines: ["Fabriksvägen 1"], postalCode: "41107", city: "Göteborg", country: "SE" },
      orgNumber: buyer.orgNumber,
      orgNumberScheme: "0007",
      vatNumber: buyer.vatNumber,
      customerNumber: "K-77",
    },
    payment: { account: { kind: "bankgiro", account: "50501055" }, ocrNumber: null },
    lines: [{ lineNumber: 1, description: "Plåtdetalj", articleNumber: "LEV-ART-9", quantity: 4, unitCode: "st", unitPrice: 125, discountPercent: 0, lineAmount: 500, vatAmount: 125, vatRate: 25, orderLineReference: "1", properties: [] }],
    attachment: { filename: `${n}.pdf`, description: "Faktura", mimeCode: "application/pdf", content: FAKE_PDF },
  };
}

describe.skipIf(!KEY)("B2Brouter-sandlådan — mottagning", () => {
  let companyBefore: typeof companyInfo.$inferSelect | undefined;

  beforeAll(async () => {
    await db.execute(TRUNCATE);
    await db.delete(systemSettings).where(like(systemSettings.key, "einvoice\\_%"));
    [companyBefore] = await db.select().from(companyInfo).limit(1);
    if (!companyBefore) await db.insert(companyInfo).values({ name: "Nav Test AB" });
  });
  afterAll(async () => {
    await db.execute(TRUNCATE);
    await db.delete(systemSettings).where(like(systemSettings.key, "einvoice\\_%"));
    if (companyBefore) {
      const { id: _id, ...rest } = companyBefore;
      await db.update(companyInfo).set(rest);
    }
  });

  it("imports a document as received at the access point, pulls it into the inbox and acknowledges it", async () => {
    const probe = createB2BrouterProvider({ environment: "sandbox", apiKey: KEY!, accountId: null });
    const account = await probe.checkKey();
    expect(account.vatNumber, "kontot saknar momsregistreringsnummer (tin_value)").toMatch(/^SE\d{12}$/);
    const buyer = { vatNumber: account.vatNumber!, orgNumber: account.vatNumber!.slice(2, 12), name: account.accountName };
    // The company is the buyer, so its own identifiers are filtered out of
    // the supplier matching.
    await db.update(companyInfo).set({ name: buyer.name, orgNumber: buyer.orgNumber, vatNumber: buyer.vatNumber });
    for (const [key, value] of [
      ["einvoice_api_key", KEY!],
      ["einvoice_account_id", account.accountId],
      ["einvoice_environment", "sandbox"],
      ["einvoice_reception_enabled", "true"],
    ]) {
      await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    }

    // Import as RECEIVED — the sandbox's stand-in for Peppol traffic in.
    const number = `LF-${String(Date.now()).slice(-6)}`;
    const xml = Buffer.from(buildUblDocument(receivedInvoice(number, buyer)), "utf8");
    const res = await fetch(`https://api.b2brouter.net/accounts/${encodeURIComponent(account.accountId)}/invoices/import?issued=false`, {
      method: "POST",
      headers: { "X-B2B-API-Key": KEY!, "X-B2B-API-Version": "2026-06-26", Accept: "application/json", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(xml),
    });
    expect(res.status, await res.text().catch(() => "")).toBeLessThan(300);

    const provider = createB2BrouterProvider({ environment: "sandbox", apiKey: KEY!, accountId: account.accountId });
    const transport = await provider.getTransport();
    expect(transport).not.toBeNull();
    expect(transport!.participantId).toBe(`0007:${buyer.orgNumber}`);

    const result = await receive.runReceiveIfDue();
    expect(result).not.toBe("disabled");
    expect(result).toMatchObject({ error: null });
    const rows = await db.select().from(einvoiceReceptions);
    const mine = rows.find((r) => r.documentNumber === number);
    expect(mine, "the imported document was listed and read").toBeDefined();
    expect(mine).toMatchObject({ environment: "sandbox", outcome: "imported", documentType: "invoice", senderEndpoint: "0007:5565555553", senderName: "Leverantören Test AB", currency: "SEK", payableAmount: "625.00" });
    expect(mine!.originalContentType).toMatch(/xml/);
    expect(mine!.invoiceScanId).not.toBeNull();
    const [scan] = await db.select().from(invoiceScans).where(sql`${invoiceScans.id} = ${mine!.invoiceScanId}`);
    expect(scan).toMatchObject({ source: "einvoice", status: "interpreted", filename: `${number}.pdf` });
    expect(scan!.data!.equals(FAKE_PDF)).toBe(true);
    const proposal = scan!.result as { invoiceNumber: { value: string }; supplier: { matchedSupplierId: string | null; name: { value: string } } };
    expect(proposal.invoiceNumber.value).toBe(number);
    expect(proposal.supplier.matchedSupplierId).toBeNull();
    expect(proposal.supplier.name.value).toBe("Leverantören Test AB");

    // Acknowledged: it is no longer listed.
    const listed = await provider.listReceived({ offset: 0, limit: 100 });
    expect(listed.documents.map((d) => d.providerInvoiceId)).not.toContain(mine!.providerInvoiceId);
  }, 180_000);
});
