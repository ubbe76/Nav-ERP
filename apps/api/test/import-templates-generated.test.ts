import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IMPORT_TEMPLATES,
  buildImportTemplate,
  buildImportTemplateManual,
} from "../src/modules/import/service/import-template.js";

// The Excel templates under apps/web/public/importmallar and the manual
// chapter docs/manual/importmallar.md are generated from field-help.ts and
// checked in. A changed explanation without regeneration fails here — the
// writer is deterministic, so "identical" is byte for byte.
const REGENERATE = "npm run generate:import-templates -w apps/api";
const REPO_ROOT = new URL("../../../", import.meta.url);
const TEMPLATE_DIR = new URL("apps/web/public/importmallar/", REPO_ROOT);
const MANUAL_FILE = new URL("docs/manual/importmallar.md", REPO_ROOT);

describe("generated import templates are current", () => {
  it.each(IMPORT_TEMPLATES.map((t) => [t.fileName, t.entity] as const))("%s", (fileName, entity) => {
    const target = new URL(fileName, TEMPLATE_DIR);
    expect(existsSync(target), `${fileName} saknas — kör ${REGENERATE}`).toBe(true);
    const onDisk = readFileSync(target);
    const generated = buildImportTemplate(entity);
    expect(onDisk.equals(generated), `${fileName} är inaktuell — kör ${REGENERATE}`).toBe(true);
  });

  it("docs/manual/importmallar.md", () => {
    expect(existsSync(MANUAL_FILE), `importmallar.md saknas — kör ${REGENERATE}`).toBe(true);
    const onDisk = readFileSync(MANUAL_FILE, "utf8");
    expect(onDisk === buildImportTemplateManual(), `importmallar.md är inaktuell — kör ${REGENERATE}`).toBe(true);
  });

  it("the chapter links every template and escapes pipes in the tables", () => {
    const manual = buildImportTemplateManual();
    expect(manual.startsWith("# Importmallar\n")).toBe(true);
    for (const info of IMPORT_TEMPLATES) {
      expect(manual).toContain(`\n## ${info.title}\n`);
      expect(manual).toContain(`[Ladda ned mallen](/importmallar/${info.fileName})`);
    }
    // No unescaped pipe inside a table cell: every table line has exactly 5
    // pipes once escaped ones are removed.
    for (const line of manual.split("\n")) {
      if (!line.startsWith("| ")) continue;
      expect(line.replace(/\\\|/g, "").split("|"), line).toHaveLength(6);
    }
  });
});
