import type { StorageUsage } from "../../lib/types";
import { Card } from "../ui/Card";
import { FormHint, FormStack } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";

// Above this much in files, moving the article files out of the database is
// worth considering (the manual's Lagringsutrymme section says why).
const FILES_GUIDELINE_BYTES = 50 * 1024 ** 3;

// Binary units with one decimal from MB up, sv-SE decimal comma.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${value.toLocaleString("sv-SE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}

// Lagringsutrymme: every uploaded file lives in the database, so its size is
// what the backup grows with. Kinds without files are left out.
export function StorageSection({ usage }: { usage: StorageUsage }) {
  const rows = usage.kinds.filter((k) => k.count > 0).map((k) => ({ ...k, id: k.key }));
  return (
    <Card maxWidth={640} style={{ marginBottom: 20 }}>
      <FormStack>
        <SectionHeading>Lagringsutrymme</SectionHeading>
        <Table
          columns={[
            { key: "label", label: "Filer", width: "1fr" },
            { key: "count", label: "Antal", width: "80px", align: "right" },
            { key: "bytes", label: "Storlek", width: "100px", align: "right" },
          ]}
          rows={rows}
          emptyText="Inga uppladdade filer"
          renderCell={(row, key) =>
            key === "label" ? row.label : key === "count" ? row.count.toLocaleString("sv-SE") : formatBytes(row.bytes)
          }
          footer={{ label: "Summa filer", bytes: formatBytes(usage.filesBytes) }}
        />
        <p style={{ margin: 0 }}>
          Databasen tar totalt <strong>{formatBytes(usage.databaseBytes)}</strong> — ungefär så stor blir en
          säkerhetskopia innan komprimering. Filerna ligger i databasen och följer med i varje säkerhetskopia.
        </p>
        {usage.filesBytes >= FILES_GUIDELINE_BYTES && (
          <FormHint>
            Filerna tar över 50 GB. Säkerhetskopiorna blir stora och tar lång tid att återställa — se
            Lagringsutrymme i hjälpen.
          </FormHint>
        )}
      </FormStack>
    </Card>
  );
}
