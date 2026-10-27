import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getTableName, sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { readStorageUsage, STORED_FILE_KINDS } from "../src/modules/system/repository/storage.js";
import { FILE_EXPORT_KINDS } from "../src/modules/system/repository/file-export.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { readStoredZipEntries } from "../src/modules/import/service/xlsx-writer.js";

// Lagringsutrymme: the file sizes per kind, read without fetching the bytes,
// and a guard that every bytea column in the schema is counted.

const articleService = createArticleService(createArticleRepository(db));

beforeEach(async () => {
  await db.execute(sql`TRUNCATE article_files, bom_components, articles CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE article_files, bom_components, articles CASCADE`);
});

describe("readStorageUsage", () => {
  it("counts the stored files and their bytes per kind, and the database size", async () => {
    const article = await articleService.createArticle({
      articleNumber: `STOR-${crypto.randomUUID().slice(0, 8)}`,
      name: "Lagrad",
      type: "purchased",
    });
    await articleService.addFile(article.id, { filename: "a.pdf", contentType: "application/pdf", data: Buffer.alloc(3000, 1) });
    await articleService.addFile(article.id, { filename: "b.pdf", contentType: "application/pdf", data: Buffer.alloc(500, 2) });

    const usage = await readStorageUsage(db);
    expect(usage.kinds.find((k) => k.key === "articleFiles")).toEqual({
      key: "articleFiles",
      label: "Artikelfiler och ritningar",
      count: 2,
      bytes: 3500,
    });
    expect(usage.filesBytes).toBe(usage.kinds.reduce((sum, k) => sum + k.bytes, 0));
    expect(usage.filesBytes).toBeGreaterThanOrEqual(3500);
    expect(usage.databaseBytes).toBeGreaterThan(usage.filesBytes);
  });

  it("covers every bytea column in the schema", async () => {
    const rows = (await db.execute(
      sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type = 'bytea' order by 1, 2`
    )) as unknown as { table_name: string; column_name: string }[];
    const listed = STORED_FILE_KINDS.map((k) => `${getTableName(k.table)}.${k.column.name}`).sort();
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual(listed);
  });

  it("exports the same kinds of files it counts", () => {
    expect(FILE_EXPORT_KINDS.map((k) => k.key)).toEqual(STORED_FILE_KINDS.map((k) => k.key));
  });
});

describe("exportFiles", () => {
  it("streams every stored file into a zip under its kind and article number, numbering repeated names", async () => {
    const article = await articleService.createArticle({ articleNumber: "EXP-1/A", name: "Exporterad", type: "purchased" });
    await articleService.addFile(article.id, { filename: "ritning.pdf", contentType: "application/pdf", data: Buffer.from("ett") });
    await articleService.addFile(article.id, { filename: "ritning.pdf", contentType: "application/pdf", data: Buffer.from("två") });

    const { filename, stream } = createSystemService(createSystemRepository(db)).exportFiles(new Date("2026-10-27T08:05:00Z"));
    expect(filename).toBe("nav-filer-2026-10-27_0805.zip");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const entries = readStoredZipEntries(Buffer.concat(chunks));
    // The slash in the article number cannot open a sub-folder.
    expect(entries.get("Artikelfiler/EXP-1_A/ritning.pdf")?.toString()).toBe("ett");
    expect(entries.get("Artikelfiler/EXP-1_A/ritning (2).pdf")?.toString()).toBe("två");
  });
});

