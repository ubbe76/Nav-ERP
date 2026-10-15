"use client";

import { Fragment } from "react";
import { formatMoney } from "../../lib/format";
import type { VariantPreviewRow } from "../../lib/configurator";
import { GatedLink } from "../ui/GatedLink";
import { FormHint } from "../ui/Form";
import styles from "./Variants.module.css";

function money(v: number | null): string {
  return v === null ? "—" : formatMoney(v);
}

function StatusCell({ row }: { row: VariantPreviewRow }) {
  const link = (label: string) =>
    row.articleId ? <GatedLink href={`/artiklar/${row.articleId}`}>{label}</GatedLink> : label;
  switch (row.status) {
    case "new":
      return <>Ny</>;
    case "exists":
      return <>{link("Finns redan")}</>;
    case "created":
      return <span className={styles.created}>{link("Skapad")}</span>;
    case "invalid":
      return <span className={styles.stopped}>Stoppas: {row.errors.join(" · ")}</span>;
    case "number_taken":
      return <span className={styles.stopped}>Numret finns redan</span>;
    case "too_long":
      return <span className={styles.stopped}>{row.errors[0] ?? "För långt artikelnummer eller benämning"}</span>;
  }
}

// Shared by Skapa varianter (many rows) and Skapa variant (one row).
export function VariantPreviewTable({ rows }: { rows: VariantPreviewRow[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Artikelnummer</th>
            <th>Benämning</th>
            <th className={styles.num}>Försäljningspris</th>
            <th className={styles.num}>Standardpris</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={`${r.articleNumber ?? "x"}-${i}`}>
              <tr>
                <td className={styles.nowrap}>{r.articleNumber ?? "—"}</td>
                <td>{r.name ?? "—"}</td>
                <td className={styles.num}>{money(r.salesPrice)}</td>
                <td className={styles.num}>{money(r.standardCost)}</td>
                <td>
                  <StatusCell row={r} />
                </td>
              </tr>
              {r.warnings.length > 0 && (
                <tr>
                  <td colSpan={5}>
                    {r.warnings.map((w) => (
                      <FormHint key={w}>{w}</FormHint>
                    ))}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "stoppas" = invalid + number_taken + too_long.
export function summarize(rows: VariantPreviewRow[]): string {
  const fresh = rows.filter((r) => r.status === "new" || r.status === "created").length;
  const exists = rows.filter((r) => r.status === "exists").length;
  const stopped = rows.length - fresh - exists;
  return `${fresh} nya · ${exists} finns redan · ${stopped} stoppas`;
}
