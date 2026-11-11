import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readUblInvoice } from "../src/modules/einvoice/service/ubl/ubl-reader.js";
import { EINVOICE_COPY_TITLE, renderEInvoiceCopy, unitLabel } from "../src/modules/mail/service/einvoice-copy-pdf.js";
import { formatNumber } from "../src/modules/mail/service/document-pdf.js";
import { pdfPageCount, pdfPagesText, pdfText } from "./helpers/pdf.js";

// sv-SE thousands separator as formatNumber prints it (a non-breaking space).
const n = (value: number) => formatNumber(value, 2);

// Visningskopia av e-faktura (spec 2026-11-05-e-faktura-mottagning): what it
// prints and — the invariant the inbox's sha256 duplicate guard rests on —
// that the same document gives the same bytes. PDF_DUMP_DIR=<dir> writes
// the PDF for a pdftoppm look.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ubl/${name}`, import.meta.url));

describe("renderEInvoiceCopy", () => {
  it("prints the title band, the original note, parties, rows, VAT, totals and payment — one page", async () => {
    const doc = readUblInvoice(fixture("invoice-two-rates-discount.xml"));
    const pdf = await renderEInvoiceCopy(doc, {});
    if (process.env.PDF_DUMP_DIR) {
      mkdirSync(process.env.PDF_DUMP_DIR, { recursive: true });
      writeFileSync(`${process.env.PDF_DUMP_DIR}/einvoice-copy.pdf`, pdf);
    }
    const text = pdfText(pdf);
    expect(text).toContain(EINVOICE_COPY_TITLE);
    expect(text).toContain("Originalet är e-fakturan (XML) som mottogs via Peppol");
    // No reception date: the same document another day is the same file.
    expect(text).not.toContain("2026-11-05");
    expect(text).toContain("FAKTURA FA-1001");
    for (const s of ["Exempel Verkstad AB", "Industrigatan 12", "802 22 Gävle", "Org.nr 5566778899", "Momsreg.nr SE556677889901", "Peppol-id 0007:5566778899"]) expect(text).toContain(s);
    for (const s of ["Kund & Son AB", "Box 44", "Fakturadatum", "2026-10-21", "Förfallodatum", "2026-11-20", "Er referens", "Anna Andersson", "Ordernummer", "PO-4711"]) expect(text).toContain(s);
    for (const s of ["Artikelnr", "Benämning", "Antal", "Enhet", "À-pris", "Belopp", "Moms %"]) expect(text).toContain(s);
    for (const s of ["3001", "Arbetsbord 1200×600", n(5600), n(10080), "Montering på plats", "tim", "Handbok storkök"]) expect(text).toContain(s);
    for (const s of [`Moms 25 % på ${n(12630)}`, n(3157.5), `Moms 12 % på ${n(995)}`, "119,40", "Netto", n(13625), "Att betala SEK", n(16901.9)]) expect(text).toContain(s);
    for (const s of ["Betalning", "Bankgiro 551-2348", "OCR 10012345673", "30 dagar netto", "Anteckning", "Leverans enligt orderbekräftelse."]) expect(text).toContain(s);
    expect(text).toContain("sida 1 av 1");
    expect(pdfPageCount(pdf)).toBe(1);
  });

  it("is deterministic: two renders of the same document are byte-identical, a different received date is not", async () => {
    const doc = readUblInvoice(fixture("invoice-two-rates-discount.xml"));
    const a = await renderEInvoiceCopy(doc, { remarks: ["Bilagan var för stor och finns kvar i e-fakturan"] });
    const b = await renderEInvoiceCopy(readUblInvoice(fixture("invoice-two-rates-discount.xml")), { remarks: ["Bilagan var för stor och finns kvar i e-fakturan"] });
    expect(a.equals(b)).toBe(true);
    expect(pdfText(a)).toContain("Bilagan var för stor och finns kvar i e-fakturan");
    // The CreationDate is the invoice date, never the clock.
    expect(a.toString("latin1")).toContain("D:20261021000000Z");
    // Without the remark it is another file; the same remark any day is the same file.
    const plain = await renderEInvoiceCopy(doc, {});
    expect(plain.equals(a)).toBe(false);
  });

  it("draws a credit note with the credited invoice and an IBAN/SEPA invoice with its exemption", async () => {
    const credit = pdfText(await renderEInvoiceCopy(readUblInvoice(fixture("credit-note.xml")), {}));
    expect(credit).toContain("KREDITFAKTURA FA-1003");
    expect(credit).toContain("Krediterar faktura");
    expect(credit).toContain("FA-1001");
    expect(credit).toContain("Att kreditera SEK");
    const eur = pdfText(await renderEInvoiceCopy(readUblInvoice(fixture("invoice-eu-goods-eur.xml")), {}));
    expect(eur).toContain("IBAN SE3550000000054910000003");
    expect(eur).toContain("BIC ESSESESS");
    expect(eur).toContain("Att betala EUR");
    expect(eur).toContain("Moms 0 % på");
  });

  it("breaks a long invoice over several pages with the row header repeated", async () => {
    const doc = readUblInvoice(fixture("invoice-two-rates-discount.xml"));
    doc.lines = Array.from({ length: 80 }, (_, i) => ({ ...doc.lines[i % 3]!, id: String(i + 1), description: `Rad ${i + 1} ${doc.lines[i % 3]!.description}` }));
    const pdf = await renderEInvoiceCopy(doc, {});
    expect(pdfPageCount(pdf)).toBeGreaterThan(1);
    const text = pdfText(pdf);
    expect(text).toContain("Rad 80");
    // Every page with rows starts with the row header (the totals may get a
    // page of their own).
    const pages = pdfPagesText(pdf);
    expect(pages).toHaveLength(pdfPageCount(pdf));
    for (const page of pages.filter((p) => p.includes("Rad "))) expect(page).toContain("ArtikelnrBenämningAntal");
    expect(text).toContain(`sida ${pdfPageCount(pdf)} av ${pdfPageCount(pdf)}`);
  });

  it("maps the common UN/ECE unit codes to Swedish", () => {
    expect(unitLabel("C62")).toBe("st");
    expect(unitLabel("HUR")).toBe("tim");
    expect(unitLabel("KGM")).toBe("kg");
    expect(unitLabel("ZZ")).toBe("ZZ");
    expect(unitLabel(null)).toBe("");
  });
});
