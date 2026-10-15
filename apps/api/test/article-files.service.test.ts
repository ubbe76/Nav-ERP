import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import {
  ArticleFileNotFoundError,
  ArticleNotFoundError,
  createArticleService,
  InvalidFileTypeError,
} from "../src/modules/article/service/article.service.js";
import { appendFilesToPdf } from "../src/modules/mail/service/pdf-merge.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";

const articleService = createArticleService(createArticleRepository(db));
const documentPdfService = createDocumentPdfService(createSystemService(createSystemRepository(db)));

// Smallest valid 1x1 PNG.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE article_files, bom_components, articles CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE article_files, bom_components, articles CASCADE`);
});

async function makeArticle() {
  return articleService.createArticle({
    articleNumber: `ART-FILE-${crypto.randomUUID()}`,
    name: "Ritningsartikel",
    type: "manufactured",
    unit: "st",
    active: true,
  });
}

describe("article files", () => {
  it("uploads, lists and downloads a drawing without leaking bytes into the listing", async () => {
    const article = await makeArticle();

    const created = await articleService.addFile(article.id, {
      filename: "ritning.png",
      contentType: "image/png",
      data: PNG_1PX,
    });
    expect(created.sizeBytes).toBe(PNG_1PX.length);
    expect(created).not.toHaveProperty("data");

    const listed = await articleService.listFiles(article.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("data");

    const downloaded = await articleService.downloadFile(article.id, created.id);
    expect(downloaded.data.equals(PNG_1PX)).toBe(true);
  });

  it("rejects unsupported file types", async () => {
    const article = await makeArticle();

    await expect(
      articleService.addFile(article.id, {
        filename: "modell.step",
        contentType: "application/step",
        data: Buffer.from("solid"),
      })
    ).rejects.toThrow(InvalidFileTypeError);
  });

  it("scopes file ids to their article and 404s otherwise", async () => {
    const article = await makeArticle();
    const other = await makeArticle();
    const file = await articleService.addFile(article.id, {
      filename: "a.png",
      contentType: "image/png",
      data: PNG_1PX,
    });

    await expect(articleService.downloadFile(other.id, file.id)).rejects.toThrow(ArticleFileNotFoundError);
    await expect(articleService.deleteFile(other.id, file.id)).rejects.toThrow(ArticleFileNotFoundError);

    await articleService.deleteFile(article.id, file.id);
    expect(await articleService.listFiles(article.id)).toHaveLength(0);
  });

  it("404s for an unknown article", async () => {
    await expect(articleService.listFiles("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      ArticleNotFoundError
    );
  });

  it("returns file bytes for several articles at once (TO printout / email attachments)", async () => {
    const a = await makeArticle();
    const b = await makeArticle();
    await articleService.addFile(a.id, { filename: "a.png", contentType: "image/png", data: PNG_1PX });
    await articleService.addFile(b.id, { filename: "b.png", contentType: "image/png", data: PNG_1PX });

    const files = await articleService.filesWithData([a.id, b.id]);
    expect(files.map((f) => f.filename).sort()).toEqual(["a.png", "b.png"]);
    expect(await articleService.filesWithData([])).toHaveLength(0);
  });
});

describe("pdf-merge", () => {
  it("appends an image as an extra page and grows the document", async () => {
    const base = await documentPdfService.renderPickList({
      documentNumber: "KO-1",
      printedAt: new Date("2026-01-01"),
      customerName: "Kund",
      expectedDeliveryDate: null,
      note: null,
      rows: [],
    });

    const merged = await appendFilesToPdf(base, [
      { filename: "ritning.png", contentType: "image/png", data: PNG_1PX },
    ]);
    expect(merged.subarray(0, 4).toString()).toBe("%PDF");
    expect(merged.length).toBeGreaterThan(base.length);
  });

  it("merges PDF attachments and skips unreadable files instead of failing", async () => {
    const base = await documentPdfService.renderPickList({
      documentNumber: "KO-2",
      printedAt: new Date("2026-01-01"),
      customerName: "Kund",
      expectedDeliveryDate: null,
      note: null,
      rows: [],
    });

    const merged = await appendFilesToPdf(base, [
      { filename: "ritning.pdf", contentType: "application/pdf", data: base },
      { filename: "trasig.png", contentType: "image/png", data: Buffer.from("inte en bild") },
    ]);
    expect(merged.subarray(0, 4).toString()).toBe("%PDF");
    expect(merged.length).toBeGreaterThan(base.length);
  });

  it("returns the original buffer when there is nothing to append", async () => {
    const base = Buffer.from("%PDF-1.3 fake");
    expect(await appendFilesToPdf(base, [])).toBe(base);
  });
});
