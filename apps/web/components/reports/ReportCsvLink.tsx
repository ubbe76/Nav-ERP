import { API_URL } from "../../lib/api";
import { ExportMenu } from "../ui/ExportMenu";

// A report's export: Exportera with CSV / Excel (ExportMenu, the same
// control as the list pages' ListExportLink) — `path` is the CSV endpoint
// including its query string, already built by the caller since every
// report's params differ (kind/groupBy/from/to).
export function ReportCsvLink({ path }: { path: string }) {
  return <ExportMenu csvHref={`${API_URL}${path}`} />;
}
