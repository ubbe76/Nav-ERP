"use client";

import { useEffect, useState, type FormEvent } from "react";
import { confirmDelete } from "../../lib/confirm";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";
import { RowMenu } from "../ui/RowMenu";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { Checkbox, Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormStack } from "../ui/Form";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDate } from "../../lib/date";
import type { ArticleDrawing, ArticleDrawingRevision, ArticleRevision } from "../../lib/types";
import styles from "./RevisionerTab.module.css";

type Revision = ArticleRevision | ArticleDrawingRevision;

// What the open dialog is doing: a new revision (on the article or on one
// drawing), changing one, a new drawing or a new drawing number.
type Dialog =
  | { kind: "newRevision"; drawing: ArticleDrawing | null }
  | { kind: "editRevision"; drawing: ArticleDrawing | null; revision: Revision }
  | { kind: "newDrawing" }
  | { kind: "renameDrawing"; drawing: ArticleDrawing };

// Artikelrevisioner och ritningsnummer med ritningsrevisioner — pure metadata
// registers (no link to the uploaded files). At most one revision is active
// per article resp. drawing; the first one created becomes active
// automatically, a new one can take over at once, and Aktivera (⋯) switches.
export function RevisionerTab({ articleId }: { articleId: string }) {
  const canEdit = useCan()(["artiklar"]);
  const [revisions, setRevisions] = useState<ArticleRevision[] | null>(null);
  const [drawings, setDrawings] = useState<ArticleDrawing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const base = `/api/v1/articles/${articleId}`;

  async function load() {
    try {
      const [revs, draws] = await Promise.all([
        apiFetch<ArticleRevision[]>(`${base}/revisions`),
        apiFetch<ArticleDrawing[]>(`${base}/drawings`),
      ]);
      setRevisions(revs);
      setDrawings(draws);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta revisionerna"));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  // Row actions (⋯): errors show above the cards.
  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    setPending(true);
    try {
      await action();
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, fallback));
    } finally {
      setPending(false);
    }
  }

  const revisionPath = (drawing: ArticleDrawing | null, revision?: Revision) =>
    `${base}${drawing ? `/drawings/${drawing.id}` : ""}/revisions${revision ? `/${revision.id}` : ""}`;

  function revisionMenu(drawing: ArticleDrawing | null) {
    return (revision: Revision) => [
      !revision.isActive && {
        label: "Aktivera",
        onSelect: () =>
          void run(
            () => apiFetch(revisionPath(drawing, revision), { method: "PATCH", body: JSON.stringify({ isActive: true }) }),
            "Kunde inte aktivera revisionen"
          ),
      },
      { label: "Ändra", onSelect: () => setDialog({ kind: "editRevision", drawing, revision }) },
      {
        label: "Ta bort",
        danger: true,
        onSelect: async () => {
          const where = drawing ? ` på ritning ${drawing.drawingNumber}` : "";
          if (!(await confirmDelete(`Ta bort revision ${revision.revision}${where}?`))) return;
          void run(() => apiFetch(revisionPath(drawing, revision), { method: "DELETE" }), "Kunde inte ta bort revisionen");
        },
      },
    ];
  }

  const loaded = revisions !== null && drawings !== null;

  return (
    <div className={styles.stack}>
      <FormError>{error}</FormError>

      <Card maxWidth="none">
        <SectionHeading
          actions={
            canEdit && (
              <Button
                type="button"
                size="small"
                variant="secondary"
                disabled={!loaded}
                onClick={() => setDialog({ kind: "newRevision", drawing: null })}
              >
                + Ny revision
              </Button>
            )
          }
        >
          Artikelrevisioner
        </SectionHeading>
        {revisions === null ? (
          <p className={styles.empty}>{error ? "–" : "Hämtar…"}</p>
        ) : revisions.length === 0 ? (
          <p className={styles.empty}>Inga artikelrevisioner än.</p>
        ) : (
          <RevisionTable rows={revisions} pending={pending} menu={canEdit ? revisionMenu(null) : null} />
        )}
      </Card>

      <Card maxWidth="none">
        <SectionHeading
          actions={
            canEdit && (
              <Button
                type="button"
                size="small"
                variant="secondary"
                disabled={!loaded}
                onClick={() => setDialog({ kind: "newDrawing" })}
              >
                + Ny ritning
              </Button>
            )
          }
        >
          Ritningar
        </SectionHeading>
        {drawings === null ? (
          <p className={styles.empty}>{error ? "–" : "Hämtar…"}</p>
        ) : drawings.length === 0 ? (
          <p className={styles.empty}>Inga ritningsnummer än.</p>
        ) : (
          drawings.map((drawing) => {
            const active = drawing.revisions.find((r) => r.isActive);
            return (
              <section key={drawing.id} className={styles.drawing} aria-label={`Ritning ${drawing.drawingNumber}`}>
                <div className={styles.drawingHead}>
                  <div className={styles.drawingTitle}>
                    <span className={styles.drawingNumber}>{drawing.drawingNumber}</span>
                    <span className={styles.drawingMeta}>
                      {active
                        ? `Aktiv revision ${active.revision}`
                        : drawing.revisions.length > 0
                          ? "Ingen aktiv revision"
                          : "Inga revisioner än"}
                    </span>
                  </div>
                  {canEdit && (
                    <div className={styles.drawingActions}>
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setDialog({ kind: "newRevision", drawing })}
                      >
                        + Ny revision
                      </Button>
                      <RowMenu
                        label={`Fler åtgärder för ritning ${drawing.drawingNumber}`}
                        items={[
                          { label: "Byt ritningsnummer", onSelect: () => setDialog({ kind: "renameDrawing", drawing }) },
                          {
                            label: "Ta bort ritningen",
                            danger: true,
                            onSelect: async () => {
                              const message =
                                drawing.revisions.length > 0
                                  ? `Ta bort ritning ${drawing.drawingNumber} med alla revisioner?`
                                  : `Ta bort ritning ${drawing.drawingNumber}?`;
                              if (!(await confirmDelete(message))) return;
                              void run(
                                () => apiFetch(`${base}/drawings/${drawing.id}`, { method: "DELETE" }),
                                "Kunde inte ta bort ritningen"
                              );
                            },
                          },
                        ]}
                      />
                    </div>
                  )}
                </div>
                {drawing.revisions.length > 0 && (
                  <RevisionTable rows={drawing.revisions} pending={pending} menu={canEdit ? revisionMenu(drawing) : null} />
                )}
              </section>
            );
          })
        )}
      </Card>

      <Modal open={dialog !== null} onClose={() => setDialog(null)} title={dialogTitle(dialog)} compact>
        {dialog?.kind === "newRevision" || dialog?.kind === "editRevision" ? (
          <RevisionForm
            key={dialog.kind === "editRevision" ? dialog.revision.id : `new-${dialog.drawing?.id ?? "article"}`}
            revision={dialog.kind === "editRevision" ? dialog.revision : null}
            hasOthers={
              (dialog.drawing ? dialog.drawing.revisions.length : (revisions?.length ?? 0)) > 0
            }
            onCancel={() => setDialog(null)}
            onSave={async (values) => {
              if (dialog.kind === "editRevision") {
                await apiFetch(revisionPath(dialog.drawing, dialog.revision), {
                  method: "PATCH",
                  body: JSON.stringify({ revision: values.revision, comment: values.comment || null }),
                });
              } else {
                await apiFetch(revisionPath(dialog.drawing), {
                  method: "POST",
                  body: JSON.stringify({
                    revision: values.revision,
                    comment: values.comment || undefined,
                    isActive: values.makeActive,
                  }),
                });
              }
              setDialog(null);
              await load();
            }}
          />
        ) : dialog?.kind === "newDrawing" || dialog?.kind === "renameDrawing" ? (
          <DrawingForm
            key={dialog.kind === "renameDrawing" ? dialog.drawing.id : "new"}
            drawing={dialog.kind === "renameDrawing" ? dialog.drawing : null}
            onCancel={() => setDialog(null)}
            onSave={async ({ drawingNumber, revision }) => {
              if (dialog.kind === "renameDrawing") {
                await apiFetch(`${base}/drawings/${dialog.drawing.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ drawingNumber }),
                });
              } else {
                const created = await apiFetch<ArticleDrawing>(`${base}/drawings`, {
                  method: "POST",
                  body: JSON.stringify({ drawingNumber }),
                });
                // The drawing stands even if its first revision is refused;
                // the dialog closes and the error shows above the cards.
                if (revision) {
                  try {
                    await apiFetch(`${base}/drawings/${created.id}/revisions`, {
                      method: "POST",
                      body: JSON.stringify({ revision }),
                    });
                  } catch (err) {
                    setError(apiErrorMessage(err, "Ritningen lades till, men inte revisionen"));
                  }
                }
              }
              setDialog(null);
              await load();
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function dialogTitle(dialog: Dialog | null): string {
  switch (dialog?.kind) {
    case "newRevision":
      return dialog.drawing ? `Ny revision av ${dialog.drawing.drawingNumber}` : "Ny artikelrevision";
    case "editRevision":
      return `Ändra revision ${dialog.revision.revision}`;
    case "newDrawing":
      return "Ny ritning";
    case "renameDrawing":
      return `Byt ritningsnummer på ${dialog.drawing.drawingNumber}`;
    default:
      return "";
  }
}

// Shared table for both revision kinds (same columns and actions). `menu`
// null = read only: no ⋯ column.
function RevisionTable({
  rows,
  pending,
  menu,
}: {
  rows: Revision[];
  pending: boolean;
  menu: ((row: Revision) => Parameters<typeof RowMenu>[0]["items"]) | null;
}) {
  return (
    <Table<Revision>
      columns={[
        { key: "revision", label: "Revision", width: "minmax(90px, 140px)" },
        { key: "comment", label: "Kommentar", width: "1fr" },
        { key: "isActive", label: "Status", width: "110px" },
        { key: "createdAt", label: "Skapad", width: "110px" },
        ...(menu ? [{ key: "menu", label: "", width: "48px", align: "right" as const }] : []),
      ]}
      rows={rows}
      renderCell={(row, key) => {
        switch (key) {
          case "revision":
            return <span className={styles.revision}>{row.revision}</span>;
          case "comment":
            return row.comment ? row.comment : <span className={styles.none}>–</span>;
          case "isActive":
            return row.isActive ? <StatusPill status="running" label="Aktiv" compact /> : null;
          case "createdAt":
            return formatStockholmDate(row.createdAt);
          case "menu":
            return pending ? null : <RowMenu label={`Fler åtgärder för revision ${row.revision}`} items={menu!(row)} />;
          default:
            return null;
        }
      }}
    />
  );
}

function RevisionForm({
  revision,
  hasOthers,
  onSave,
  onCancel,
}: {
  revision: Revision | null;
  // A first revision becomes active by itself — the choice only matters
  // when there are others.
  hasOthers: boolean;
  onSave: (values: { revision: string; comment: string; makeActive: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(revision?.revision ?? "");
  const [comment, setComment] = useState(revision?.comment ?? "");
  const [makeActive, setMakeActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ revision: value.trim(), comment: comment.trim(), makeActive });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara revisionen"));
      setSaving(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormStack>
        <Field label="Revision" htmlFor="revisionValue">
          <Input
            id="revisionValue"
            size="sm"
            maxLength={20}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Field label="Kommentar (valfritt)" htmlFor="revisionComment">
          <Input id="revisionComment" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        {!revision && hasOthers && (
          <label className={styles.check}>
            <Checkbox checked={makeActive} onChange={(e) => setMakeActive(e.target.checked)} />
            Gör den till aktiv revision
          </label>
        )}
      </FormStack>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" variant="primary" disabled={saving || !value.trim()}>
          {saving ? "Sparar…" : revision ? "Spara" : "Lägg till"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

function DrawingForm({
  drawing,
  onSave,
  onCancel,
}: {
  drawing: ArticleDrawing | null;
  onSave: (values: { drawingNumber: string; revision: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [drawingNumber, setDrawingNumber] = useState(drawing?.drawingNumber ?? "");
  const [revision, setRevision] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!drawingNumber.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ drawingNumber: drawingNumber.trim(), revision: revision.trim() });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara ritningen"));
      setSaving(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormStack>
        <Field label="Ritningsnummer" htmlFor="drawingNumber">
          <Input
            id="drawingNumber"
            maxLength={50}
            autoFocus
            value={drawingNumber}
            onChange={(e) => setDrawingNumber(e.target.value)}
          />
        </Field>
        {!drawing && (
          <Field label="Första revision (valfritt)" htmlFor="drawingFirstRevision">
            <Input
              id="drawingFirstRevision"
              size="sm"
              maxLength={20}
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
            />
          </Field>
        )}
      </FormStack>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" variant="primary" disabled={saving || !drawingNumber.trim()}>
          {saving ? "Sparar…" : drawing ? "Spara" : "Lägg till"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
