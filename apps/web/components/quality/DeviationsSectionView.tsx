"use client";

import Link from "next/link";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { GatedLink } from "../ui/GatedLink";
import { SectionHeading } from "../ui/SectionHeading";
import buttonStyles from "../ui/Button.module.css";
import { useCan } from "../PermissionsProvider";
import {
  DEVIATION_STATUS_PILL,
  DEVIATION_TYPE_LABELS,
  deviationHref,
  type DeviationListRow,
} from "../../lib/quality";
import styles from "./Deviations.module.css";

export function DeviationsSectionView({
  rows,
  total,
  newHref,
  buttonLabel,
  allHref,
}: {
  rows: DeviationListRow[];
  total: number;
  newHref: string;
  buttonLabel: string;
  allHref: string;
}) {
  const canWrite = useCan()(["kvalitet"]);
  if (rows.length === 0 && !canWrite) return null;

  return (
    <div className={styles.section}>
      <SectionHeading
        actions={
          canWrite ? (
            <Link href={newHref} className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.small}`}>
              {buttonLabel}
            </Link>
          ) : undefined
        }
      >
        Avvikelser
      </SectionHeading>
      {rows.length === 0 ? (
        <p>Inga avvikelser.</p>
      ) : (
        <Table<DeviationListRow>
          columns={[
            { key: "deviationNumber", label: "Nr", width: "90px" },
            { key: "type", label: "Typ", width: "160px" },
            { key: "title", label: "Rubrik", width: "minmax(160px, 1fr)" },
            { key: "status", label: "Status", width: "140px" },
          ]}
          rows={rows}
          renderCell={(row, key) => {
            switch (key) {
              case "deviationNumber":
                return (
                  <GatedLink href={deviationHref(row.id)} className={styles.rowLink}>
                    {row.deviationNumber}
                  </GatedLink>
                );
              case "type":
                return DEVIATION_TYPE_LABELS[row.type];
              case "title":
                return row.title;
              case "status": {
                const pill = DEVIATION_STATUS_PILL[row.status];
                return <StatusPill status={pill.status} label={pill.label} compact />;
              }
              default:
                return null;
            }
          }}
        />
      )}
      {total > rows.length && (
        <p>
          <GatedLink href={allHref} className={styles.rowLink}>
            Visa alla {total} avvikelser
          </GatedLink>
        </p>
      )}
    </div>
  );
}
