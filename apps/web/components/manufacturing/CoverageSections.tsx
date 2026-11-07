"use client";

import { GatedLink } from "../ui/GatedLink";
import { SectionHeading } from "../ui/SectionHeading";
import { HelpLink } from "../ui/HelpLink";
import { Table } from "../ui/Table";
import { toUnitQuantity } from "../../lib/units";
import { formatQuantity } from "../../lib/format";
import type {
  CoverageAllocation,
  CoverageGoesTo,
  CoverageMaterial,
  ManufacturingOrderCoverage,
  MOMaterialConsumption,
} from "../../lib/types";
import styles from "./Pegging.module.css";

// Pegging (#9): what the quantities of a coverage are in — the component's
// BASE unit — shown in the material row's own unit, like the Material table.
function inRowUnit(q: number, row: MOMaterialConsumption): string {
  return `${formatQuantity(toUnitQuantity(q, row.unitFactor))} ${row.unitCode}`;
}

export function daysLateText(days: number): string {
  return `${days} ${days === 1 ? "dag" : "dagar"} för sent`;
}

// The coverage entry of a Material table row (rowId "mat:<moMaterialId>").
export function coverageOfRow(coverage: ManufacturingOrderCoverage | null, row: MOMaterialConsumption): CoverageMaterial | null {
  return coverage?.materials.find((m) => m.rowId === `mat:${row.id}`) ?? null;
}

function AllocationLine({ a, qty }: { a: CoverageAllocation; qty: string | null }) {
  const href =
    a.documentId === null
      ? null
      : a.kind === "purchase_order"
        ? `/inkop/ordrar/${a.documentId}`
        : `/tillverkning/ordrar/${a.documentId}`;
  const label = a.kind === "stock" ? "Lager" : (a.documentNumber ?? "–");
  return (
    <span className={styles.line}>
      {href ? <GatedLink href={href}>{label}</GatedLink> : label}
      {a.kind !== "stock" && <> · {a.undated || !a.readyDate ? "saknar datum" : a.readyDate}</>}
      {a.isDraft && " (utkast)"}
      {qty && ` · ${qty}`}
      {a.late && a.daysLate > 0 && <span className={styles.late}> · {daysLateText(a.daysLate)}</span>}
      {a.late && a.daysLate === 0 && !a.undated && <span className={styles.late}> · för sent</span>}
    </span>
  );
}

// Täcks av: one line per source, Saknas for what nothing covers. The quantity
// per line only when several sources (or a gap) share the row.
export function CoveredByCell({ row, material }: { row: MOMaterialConsumption; material: CoverageMaterial | null }) {
  if (!material) return <span className={styles.muted}>–</span>;
  const showQty = material.allocations.length > 1 || material.uncovered > 0;
  if (material.allocations.length === 0 && material.uncovered <= 0) return <span className={styles.muted}>–</span>;
  return (
    <div className={styles.lines}>
      {material.allocations.map((a, i) => (
        <AllocationLine key={i} a={a} qty={showQty ? inRowUnit(a.quantity, row) : null} />
      ))}
      {material.uncovered > 0 && <span className={`${styles.line} ${styles.late}`}>Saknas {inRowUnit(material.uncovered, row)}</span>}
    </div>
  );
}

type GoesToRow = CoverageGoesTo & { id: string };

// Går till: the demands this TO's output covers (derived at read), plus what
// is left over for stock.
export function GoesToSection({ coverage, unit }: { coverage: ManufacturingOrderCoverage | null; unit: string }) {
  if (!coverage || (coverage.goesTo.length === 0 && !(coverage.surplus > 0))) return null;
  const rows: GoesToRow[] = coverage.goesTo.map((g, i) => ({ ...g, id: String(i) }));
  return (
    <>
      <SectionHeading
        spaced
        actions={<HelpLink chapter="tillverkning" anchor="tacks-av-och-gar-till" label="Hjälp om Täcks av och Går till" />}
      >
        Går till
      </SectionHeading>
      {rows.length > 0 && (
        <Table<GoesToRow>
          columns={[
            { key: "demand", label: "Behov", width: "minmax(160px, 1fr)" },
            { key: "needDate", label: "Behovsdatum", width: "minmax(130px, 200px)" },
            { key: "quantity", label: "Antal", width: "110px", align: "right" },
          ]}
          rows={rows}
          renderCell={(row, key) => {
            switch (key) {
              case "demand": {
                if (row.kind === "stock") return "Negativt lagersaldo";
                const href =
                  row.documentId === null
                    ? null
                    : row.kind === "sales_order"
                      ? `/forsaljning/ordrar/${row.documentId}`
                      : `/tillverkning/ordrar/${row.documentId}`;
                const label = row.documentNumber ?? "–";
                return (
                  <div>
                    {href ? <GatedLink href={href}>{label}</GatedLink> : label}
                    {row.partner && <span className={styles.muted}> · {row.partner}</span>}
                  </div>
                );
              }
              case "needDate":
                return (
                  <div>
                    {row.needDate ?? "saknar datum"}
                    {row.late && row.daysLate > 0 && <span className={styles.late}> · {daysLateText(row.daysLate)}</span>}
                  </div>
                );
              default:
                return `${formatQuantity(row.quantity)} ${unit}`;
            }
          }}
        />
      )}
      {coverage.surplus > 0 && (
        <p className={styles.surplus}>
          Till lager {formatQuantity(coverage.surplus)} {unit}
        </p>
      )}
    </>
  );
}
