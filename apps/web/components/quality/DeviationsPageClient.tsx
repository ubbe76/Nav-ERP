"use client";

import Link from "next/link";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Checkbox } from "../ui/Field";
import { GatedLink } from "../ui/GatedLink";
import buttonStyles from "../ui/Button.module.css";
import { HelpLink } from "../ui/HelpLink";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination, useListNavigation } from "../ui/ListControls";
import { useCan } from "../PermissionsProvider";
import shellStyles from "../AppShell.module.css";
import { formatMoney } from "../../lib/format";
import {
  DEVIATION_STATUSES,
  DEVIATION_STATUS_LABELS,
  DEVIATION_STATUS_PILL,
  DEVIATION_TYPES,
  DEVIATION_TYPE_LABELS,
  deviationHref,
  formatDeviationQuantity,
  type DeviationListRow,
  type DeviationReason,
  type ResponsibleCandidate,
} from "../../lib/quality";
import type { Paged } from "../../lib/types";
import styles from "./Deviations.module.css";

// "Försenade": the API accepts overdue=1 (the alert links with it) as well as
// "true", so the box reads both and writes the short form.
function OverdueFilter() {
  const { params, setFilter } = useListNavigation();
  const checked = params.get("overdue") === "1" || params.get("overdue") === "true";
  return (
    <label className={styles.toggle}>
      <Checkbox checked={checked} onChange={(e) => setFilter("overdue", e.target.checked ? "1" : null)} />
      Försenade
    </label>
  );
}

export function DeviationsPageClient({
  deviations,
  pageSize,
  reasons,
  responsible,
}: {
  deviations: Paged<DeviationListRow>;
  pageSize: number;
  reasons: DeviationReason[];
  responsible: ResponsibleCandidate[];
}) {
  const can = useCan();
  const canWrite = can(["kvalitet"]);
  const showCost = can(["office"]);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Avvikelser</div>
          <div className={shellStyles.meta}>
            {deviations.total.toLocaleString("sv-SE")} avvikelser · reklamationer, leverantörsavvikelser och interna avvikelser
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          {canWrite && (
            <Link href="/kvalitet/avvikelser/ny" className={`${buttonStyles.button} ${buttonStyles.primary}`}>
              + Ny avvikelse
            </Link>
          )}
          <HelpLink chapter="kvalitet" anchor="avvikelser" label="Hjälp om avvikelser" />
        </div>
      </div>

      <ListToolbar placeholder="Sök nummer, rubrik, kund, leverantör, artikel eller referens…">
        <ListFilterSelect
          param="type"
          allLabel="Alla typer"
          ariaLabel="Filtrera på typ"
          options={DEVIATION_TYPES.map((value) => ({ value, label: DEVIATION_TYPE_LABELS[value] }))}
        />
        <ListFilterSelect
          param="status"
          allLabel="Öppna"
          ariaLabel="Filtrera på status"
          options={[
            ...DEVIATION_STATUSES.map((value) => ({ value, label: DEVIATION_STATUS_LABELS[value] })),
            { value: "all", label: "Alla statusar" },
          ]}
        />
        <ListFilterSelect
          param="reasonId"
          allLabel="Alla orsaker"
          ariaLabel="Filtrera på orsak"
          options={reasons.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` }))}
        />
        <ListFilterSelect
          param="responsibleUserId"
          allLabel="Alla ansvariga"
          ariaLabel="Filtrera på ansvarig"
          options={responsible.map((r) => ({ value: r.id, label: r.name }))}
        />
        <OverdueFilter />
        <ListExportLink endpoint="/api/v1/deviations/csv" />
      </ListToolbar>

      <Table<DeviationListRow>
        columns={[
          { key: "deviationNumber", label: "Nr", width: "70px" },
          { key: "reportedDate", label: "Datum", width: "90px" },
          { key: "type", label: "Typ", width: "110px" },
          { key: "title", label: "Rubrik", width: "minmax(140px, 2fr)" },
          { key: "counterpartyName", label: "Motpart", width: "minmax(110px, 1.2fr)" },
          { key: "article", label: "Artikel", width: "minmax(80px, 0.8fr)" },
          { key: "reasonName", label: "Orsak", width: "minmax(80px, 1fr)" },
          { key: "responsibleUserName", label: "Ansvarig", width: "minmax(80px, 1fr)" },
          { key: "dueDate", label: "Åtgärd senast", width: "100px" },
          { key: "status", label: "Status", width: "110px" },
          ...(showCost ? [{ key: "netCost", label: "Nettokostnad", width: "100px", align: "right" as const }] : []),
        ]}
        rows={deviations.rows}
        emptyText="Inga avvikelser matchar urvalet"
        renderCell={(row, key) => {
          switch (key) {
            case "deviationNumber":
              return (
                <Link href={deviationHref(row.id)} className={styles.rowLink}>
                  {row.deviationNumber}
                </Link>
              );
            case "reportedDate":
              return <span className="num">{row.reportedDate}</span>;
            case "type":
              return DEVIATION_TYPE_LABELS[row.type];
            case "title":
              return (
                <Link href={deviationHref(row.id)} className={styles.titleLink}>
                  {row.title}
                </Link>
              );
            case "counterpartyName":
              if (row.customerId) {
                return (
                  <GatedLink href={`/kunder/${row.customerId}`} className={styles.plainLink}>
                    {row.counterpartyName}
                  </GatedLink>
                );
              }
              if (row.supplierId) {
                return (
                  <GatedLink href={`/leverantorer/${row.supplierId}`} className={styles.plainLink}>
                    {row.counterpartyName}
                  </GatedLink>
                );
              }
              return "–";
            case "article":
              return row.articleNumber ? (
                <span
                  title={`${row.articleName ?? ""}${row.quantity !== null ? ` · ${formatDeviationQuantity(row.quantity, row.unitCode)}` : ""}`}
                >
                  {row.articleNumber}
                </span>
              ) : (
                "–"
              );
            case "reasonName":
              return row.reasonName ?? "–";
            case "responsibleUserName":
              return row.responsibleUserName ?? "–";
            case "dueDate":
              return row.dueDate ? (
                <span className={`num ${row.overdue ? styles.overdue : ""}`}>{row.dueDate}</span>
              ) : (
                "–"
              );
            case "status": {
              const pill = DEVIATION_STATUS_PILL[row.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "netCost":
              return row.netCost === null ? "–" : <span className="num">{formatMoney(row.netCost)}</span>;
            default:
              return null;
          }
        }}
      />

      <Pagination total={deviations.total} pageSize={pageSize} />
    </>
  );
}
