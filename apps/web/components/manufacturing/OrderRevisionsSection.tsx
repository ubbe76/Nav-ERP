"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { FormError, FormNotice } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { apiFetch, API_URL } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { confirmDialog } from "../../lib/confirm";
import { notify } from "../../lib/notice";
import type { OrderDrawingRevision, OrderRevisions, RevisionFile } from "../../lib/types";
import styles from "./OrderRevisionsSection.module.css";

// Ritningar på TO-kortet (0200): the revisions the order is built from —
// snapshotted at release — beside today's. A newer revision since is flagged,
// and Uppdatera takes today's (released/in progress). Every file opens (and
// prints) from here, also an older revision's. Nothing is shown when the
// article has neither revisions, drawings nor files.
export function OrderRevisionsSection({
  orderId,
  canRefresh,
  onRefreshed,
}: {
  orderId: string;
  canRefresh: boolean;
  onRefreshed: () => void;
}) {
  const [view, setView] = useState<OrderRevisions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await apiFetch<OrderRevisions>(`/api/v1/manufacturing-orders/${orderId}/revisions`));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta ritningarna"));
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    if (!(await confirmDialog("Ordern tar de gällande revisionerna och deras filer. Utskriften och terminalen följer.", { confirmLabel: "Uppdatera" })))
      return;
    setPending(true);
    setError(null);
    try {
      setView(await apiFetch<OrderRevisions>(`/api/v1/manufacturing-orders/${orderId}/revisions/refresh`, { method: "POST" }));
      notify({ message: "Ordern följer nu de gällande revisionerna." });
      onRefreshed();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte uppdatera revisionerna"));
    } finally {
      setPending(false);
    }
  }

  if (!view) return error ? <FormError margin="below">{error}</FormError> : null;
  const empty = !view.articleRevision && !view.currentArticleRevision && view.drawings.length === 0 && view.looseFiles.length === 0;
  if (empty) return null;

  const fileLink = (file: RevisionFile | null) =>
    file ? (
      <a
        className={styles.fileLink}
        href={`${API_URL}/api/v1/manufacturing-orders/${orderId}/files/${file.id}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {file.filename}
      </a>
    ) : (
      <span className={styles.none}>–</span>
    );

  const articleChanged = view.snapshotAt !== null && view.articleRevision !== view.currentArticleRevision;
  const changedDrawings = view.drawings.filter((d) => d.changed);

  return (
    <section className={styles.section} aria-label="Ritningar">
      <SectionHeading
        actions={
          canRefresh &&
          view.changed && (
            <Button type="button" variant="secondary" size="small" disabled={pending} onClick={() => void refresh()}>
              {pending ? "Uppdaterar…" : "Uppdatera till gällande revisioner"}
            </Button>
          )
        }
      >
        Ritningar
      </SectionHeading>
      <FormError margin="below">{error}</FormError>
      {view.changed && (
        <FormNotice style={{ marginBottom: 12 }} role="status">
          <strong>Ny revision sedan frisläpp.</strong>{" "}
          {[
            articleChanged ? `Artikeln: revision ${view.currentArticleRevision ?? "ingen"} (ordern ${view.articleRevision ?? "ingen"})` : null,
            ...changedDrawings.map((d) => changeText(d)),
          ]
            .filter(Boolean)
            .join(" · ")}
        </FormNotice>
      )}
      {(view.articleRevision || view.currentArticleRevision) && (
        <p className={styles.articleRevision}>
          Artikelrevision: <strong>{view.articleRevision ?? "ingen"}</strong>
        </p>
      )}
      {view.drawings.length > 0 && (
        <Table<OrderDrawingRevision & { id: string }>
          columns={[
            { key: "drawingNumber", label: "Ritning", width: "minmax(120px, 1fr)" },
            { key: "revision", label: "Revision", width: "100px" },
            { key: "file", label: "Fil", width: "minmax(140px, 1.5fr)" },
            { key: "current", label: "Gällande nu", width: "minmax(140px, 1fr)" },
          ]}
          rows={view.drawings.map((d) => ({ ...d, id: d.drawingId ?? d.drawingNumber }))}
          renderCell={(d, key) => {
            switch (key) {
              case "drawingNumber":
                return <span className={styles.drawingNumber}>{d.drawingNumber}</span>;
              case "revision":
                return d.added ? <span className={styles.none}>ny ritning</span> : (d.revision ?? <span className={styles.none}>–</span>);
              case "file":
                return d.added ? <span className={styles.none}>–</span> : fileLink(d.file);
              case "current":
                if (!d.changed) return <span className={styles.none}>samma</span>;
                if (!d.current) return <span className={styles.none}>borttagen</span>;
                return (
                  <span className={styles.current}>
                    rev {d.current.revision ?? "–"}
                    {d.current.file && <> · {fileLink(d.current.file)}</>}
                  </span>
                );
              default:
                return null;
            }
          }}
        />
      )}
      {view.looseFiles.length > 0 && (
        <p className={styles.looseFiles}>
          Övriga filer:{" "}
          {view.looseFiles.map((f, i) => (
            <span key={f.id}>
              {i > 0 && ", "}
              {fileLink(f)}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function changeText(d: OrderDrawingRevision): string {
  if (d.added) return `${d.drawingNumber} är ny`;
  if (!d.current) return `${d.drawingNumber} är borttagen`;
  return `${d.drawingNumber} rev ${d.current.revision ?? "–"} (ordern ${d.revision ?? "–"})`;
}
