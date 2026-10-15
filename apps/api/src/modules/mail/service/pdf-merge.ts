import { PDFDocument } from "pdf-lib";

// Appends article drawings to a generated document. PDF attachments have
// their pages copied in; JPEG/PNG become one A4 page each, scaled to fit
// with a margin. A file that can't be parsed is skipped rather than failing
// the whole document — a broken drawing shouldn't block a printout.

export interface AttachableFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 40;

// Concatenates whole documents in the given order — the batch printouts
// ("alla skapade inköpsorder" from the behovsberäkning) are just the single
// order PDFs back to back. A thin wrapper over appendFilesToPdf so both
// paths share one pdf-lib code path.
export async function mergePdfs(documents: Buffer[]): Promise<Buffer> {
  const [first, ...rest] = documents;
  if (!first) throw new Error("mergePdfs needs at least one document");
  return appendFilesToPdf(
    first,
    rest.map((data, i) => ({ filename: `document-${i + 2}.pdf`, contentType: "application/pdf", data }))
  );
}

export async function appendFilesToPdf(base: Buffer, files: AttachableFile[]): Promise<Buffer> {
  if (files.length === 0) return base;

  const merged = await PDFDocument.load(base);

  for (const file of files) {
    try {
      if (file.contentType === "application/pdf") {
        const source = await PDFDocument.load(file.data);
        const pages = await merged.copyPages(source, source.getPageIndices());
        for (const page of pages) merged.addPage(page);
        continue;
      }

      const image =
        file.contentType === "image/png" ? await merged.embedPng(file.data) : await merged.embedJpg(file.data);
      const page = merged.addPage([A4.width, A4.height]);
      const maxWidth = A4.width - MARGIN * 2;
      const maxHeight = A4.height - MARGIN * 2;
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawImage(image, {
        x: (A4.width - width) / 2,
        y: (A4.height - height) / 2,
        width,
        height,
      });
    } catch {
      // Unreadable or unsupported file — skip it and keep the document usable.
    }
  }

  return Buffer.from(await merged.save());
}
