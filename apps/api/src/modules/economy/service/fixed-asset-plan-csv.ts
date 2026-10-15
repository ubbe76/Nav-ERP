import { buildCsv, type CsvColumn } from "@navet/shared";
import type { FixedAssetPlan, PlanAssetRow } from "./fixed-asset-plan.js";

// One row per asset, every plan column flat — the same conventions as the
// B6a report CSVs (financial-reports-csv.ts).
const COLUMNS: CsvColumn<PlanAssetRow>[] = [
  { label: "Grupp", value: (row) => row.categoryName },
  { label: "Nr", value: (row) => row.assetNumber },
  { label: "Benämning", value: (row) => row.name },
  { label: "Anskaffad", value: (row) => row.acquisitionDate, format: "date" },
  { label: "Avyttrad", value: (row) => row.disposalDate, format: "date" },
  { label: "IB anskaffning", value: (row) => row.acquisitionOpening, format: "money" },
  { label: "Årets anskaffningar", value: (row) => row.acquisitions, format: "money" },
  { label: "Årets avyttringar", value: (row) => row.disposals, format: "money" },
  { label: "UB anskaffning", value: (row) => row.acquisitionClosing, format: "money" },
  { label: "IB ack. avskrivning", value: (row) => row.depreciationOpening, format: "money" },
  { label: "Årets avskrivning", value: (row) => row.depreciationYear, format: "money" },
  { label: "Avyttrade ack. avskrivningar", value: (row) => row.depreciationDisposed, format: "money" },
  { label: "UB ack. avskrivning", value: (row) => row.depreciationClosing, format: "money" },
  { label: "Bokfört värde", value: (row) => row.bookValueClosing, format: "money" },
];

export function buildFixedAssetPlanCsv(plan: FixedAssetPlan): string {
  return buildCsv(
    COLUMNS,
    plan.categories.flatMap((category) => category.assets)
  );
}
