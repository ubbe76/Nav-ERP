import type { CSSProperties } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Field, Input, Toggle } from "../ui/Field";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { Wordmark } from "../ui/Wordmark";
import styles from "./ThemePreview.module.css";

interface ThemePreviewProps {
  scheme: "light" | "dark";
  // Every catalogue token (without the leading "--") — values may be var() 
  // references to each other, resolved on this element.
  tokens: Record<string, string>;
}

const ROWS = [
  { id: "1", order: "TO-2501", article: "Axel 40 mm", status: "running" as const },
  { id: "2", order: "TO-2502", article: "Fläns 120", status: "delayed" as const },
  { id: "3", order: "TO-2503", article: "Lagerhus", status: "stopped" as const },
  { id: "4", order: "TO-2504", article: "Bussning", status: "done" as const },
  { id: "5", order: "TO-2505", article: "Skruvsats", status: "draft" as const },
];

// The theme drawn with the app's own components. The tokens are set as custom
// properties on this container only (never on <html>), and the components use
// nothing but tokens, so that is all it takes.
export function ThemePreview({ scheme, tokens }: ThemePreviewProps) {
  const style: Record<string, string> = { colorScheme: scheme };
  for (const [name, value] of Object.entries(tokens)) style[`--${name}`] = value;

  return (
    <div className={styles.preview} style={style as CSSProperties} aria-label="Förhandsvisning av temat">
      <div className={styles.header}>
        <Wordmark height={24} />
        <nav className={styles.nav}>
          <span className={styles.navItem} data-active="true">
            Översikt
          </span>
          <span className={styles.navItem}>Lager</span>
          <span className={styles.navItem}>Inköp</span>
        </nav>
      </div>
      <div className={styles.body}>
        <h3 className={styles.heading}>Tillverkningsorder</h3>
        <div className={styles.buttons}>
          <Button type="button">Primär</Button>
          <Button type="button" variant="secondary">
            Sekundär
          </Button>
          <Button type="button" variant="ghost">
            Ghost
          </Button>
          <Button type="button" variant="danger">
            Ta bort
          </Button>
        </div>
        <Table
          columns={[
            { key: "order", label: "Order", width: "90px" },
            { key: "article", label: "Artikel", width: "minmax(0, 1fr)" },
            { key: "status", label: "Status", width: "110px" },
          ]}
          rows={ROWS}
          renderCell={(row, key) =>
            key === "status" ? <StatusPill status={row.status} /> : key === "order" ? row.order : row.article
          }
        />
        <Card maxWidth="none">
          <SectionHeading>Formulär</SectionHeading>
          <div className={styles.form}>
            <Field label="Benämning" htmlFor="theme-preview-name">
              <Input id="theme-preview-name" defaultValue="Axel 40 mm" />
            </Field>
            <label className={styles.inline}>
              <Checkbox defaultChecked /> Aktiv artikel
            </label>
            <label className={styles.inline}>
              <Toggle defaultChecked /> Visa priser
            </label>
            <a href="#theme-preview" className={styles.link} onClick={(e) => e.preventDefault()}>
              Länk till artikelkortet
            </a>
          </div>
        </Card>
      </div>
    </div>
  );
}
