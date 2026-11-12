"use client";

import buttonStyles from "./Button.module.css";
import { RowMenu } from "./RowMenu";

// "/api/v1/articles/csv?search=x" → "/api/v1/articles/xlsx?search=x": every
// CSV export in the API has an Excel twin at the same path with the last
// segment swapped (registerListCsvRoute / registerTableExportRoutes).
export function xlsxHrefOf(csvHref: string): string {
  const queryStart = csvHref.indexOf("?");
  const path = queryStart === -1 ? csvHref : csvHref.slice(0, queryStart);
  const query = queryStart === -1 ? "" : csvHref.slice(queryStart);
  if (!path.endsWith("/csv")) throw new Error(`Not a CSV export link: ${csvHref}`);
  return `${path.slice(0, -"csv".length)}xlsx${query}`;
}

// THE export control (#35): the button Exportera with the choice CSV /
// Excel. Every place that offers a table export — the list toolbars
// (ListExportLink), the reports (ReportCsvLink), the financial reports,
// budget, avskrivningsplan, löneunderlag — renders this, so the labels and
// the pair of formats never drift. `csvHref` is the full link to the CSV
// export, query string included; the Excel link is derived from it.
export function ExportMenu({
  csvHref,
  variant = "ghost",
  size,
}: {
  csvHref: string;
  variant?: "ghost" | "secondary";
  size?: "small";
}) {
  const className = [buttonStyles.button, buttonStyles[variant], size ? buttonStyles[size] : ""].filter(Boolean).join(" ");
  return (
    <RowMenu
      label="Exportera"
      button={{ text: "Exportera", className }}
      items={[
        { label: "CSV", href: csvHref, download: true },
        { label: "Excel", href: xlsxHrefOf(csvHref), download: true },
      ]}
    />
  );
}
