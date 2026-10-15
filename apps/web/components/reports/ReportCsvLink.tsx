import { API_URL } from "../../lib/api";
import buttonStyles from "../ui/Button.module.css";

// Same <a download> ghost-button idiom as the economy reports' "Ladda ner
// CSV" links (BalansrakningPageClient) and the list pages' ListExportLink —
// `path` is the endpoint including its query string, already built by the
// caller since every report's params differ (kind/groupBy/from/to).
export function ReportCsvLink({ path }: { path: string }) {
  return (
    <a href={`${API_URL}${path}`} download className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
      Exportera CSV
    </a>
  );
}
