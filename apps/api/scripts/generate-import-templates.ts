// Writes the Excel import templates and the manual chapter Importmallar from
// field-help.ts:
//
//   npm run generate:import-templates -w apps/api
//
// Outputs (checked in; import-templates-generated.test.ts fails when they
// are stale):
//   apps/web/public/importmallar/importmall-<namn>.xlsx  — one per entity
//   docs/manual/importmallar.md                           — the chapter
//
// The writer is deterministic (fixed zip timestamp), so re-running without a
// content change leaves git clean.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMPORT_TEMPLATES,
  buildImportTemplate,
  buildImportTemplateManual,
} from "../src/modules/import/service/import-template.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const TEMPLATE_DIR = path.join(repoRoot, "apps", "web", "public", "importmallar");
const MANUAL_FILE = path.join(repoRoot, "docs", "manual", "importmallar.md");

mkdirSync(TEMPLATE_DIR, { recursive: true });
for (const info of IMPORT_TEMPLATES) {
  const target = path.join(TEMPLATE_DIR, info.fileName);
  writeFileSync(target, buildImportTemplate(info.entity));
  console.log(`wrote ${path.relative(repoRoot, target)}`);
}
writeFileSync(MANUAL_FILE, buildImportTemplateManual(), "utf8");
console.log(`wrote ${path.relative(repoRoot, MANUAL_FILE)}`);
