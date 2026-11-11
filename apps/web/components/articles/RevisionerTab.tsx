"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { confirmDelete } from "../../lib/confirm";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";
import { RowMenu } from "../ui/RowMenu";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormStack } from "../ui/Form";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDate } from "../../lib/date";
import { ARTICLE_FILE_ACCEPT, articleFileHref, formatFileSize, uploadArticleFile } from "../../lib/articleFiles";
import type { ArticleDrawing, ArticleDrawingRevision, ArticleFile, ArticleRevision } from "../../lib/types";
import styles from "./RevisionerTab.module.css";

type Revision = ArticleRevision | ArticleDrawingRevision;

// What the open dialog is doing: a new revision (on the article or on one
// drawing), changing one, a new drawing or a new drawing number, or a drawing
// revision's file.
type Dialog =
  | { kind: "newRevision"; drawing: ArticleDrawing | null }
  | { kind: "editRevision"; drawing: ArticleDrawing | null; revision: Revision }
  | { kind: "newDrawing" }
  | { kind: "renameDrawing"; drawing: ArticleDrawing }
  | { kind: "revisionFile"; drawing: ArticleDrawing; revision: ArticleDrawingRevision };

// A drawing revision's file as chosen in a dialog: a new upload or one of
// the article's loose files (fliken Filer).
type FileChoiceValue = { kind: "upload"; file: File } | { kind: "loose"; fileId: string } | null;


// The registers, their loading and the dialogs — shared by the Revisioner
// tab and the Beredning's Ritningar panel.
function useRevisionRegisters(articleId: string) {
  const [revisions, setRevisions] = useState<ArticleRevision[] | null>(null);
  const [drawings, setDrawings] = useState<ArticleDrawing[] | null>(null);
  // The article's loose files — the ones a drawing revision can take.
  const [looseFiles, setLooseFiles] = useState<ArticleFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const base = `/api/v1/articles/${articleId}`;

  async function load() {
    try {
      const [revs, draws, files] = await Promise.all([
        apiFetch<ArticleRevision[]>(`${base}/revisions`),
        apiFetch<ArticleDrawing[]>(`${base}/drawings`),
        apiFetch<ArticleFile[]>(`${base}/files`),
      ]);
      setRevisions(revs);
      setDrawings(draws);
      setLooseFiles(files.filter((f) => !f.drawingRevisionId));
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

  // The chosen file onto the drawing revision (a file it had is replaced).
  async function saveRevisionFile(drawing: ArticleDrawing, revisionId: string, choice: FileChoiceValue) {
    if (!choice) return;
    if (choice.kind === "upload") await uploadArticleFile(articleId, choice.file, revisionId);
    else
      await apiFetch(`${base}/drawings/${drawing.id}/revisions/${revisionId}/file`, {
        method: "PUT",
        body: JSON.stringify({ fileId: choice.fileId }),
      });
  }

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
      drawing && {
        label: (revision as ArticleDrawingRevision).file ? "Byt fil" : "Lägg till fil",
        onSelect: () => setDialog({ kind: "revisionFile", drawing, revision: revision as ArticleDrawingRevision }),
      },
      drawing &&
        (revision as ArticleDrawingRevision).file && {
          label: "Ta bort filen",
          danger: true,
          onSelect: async () => {
            const file = (revision as ArticleDrawingRevision).file!;
            if (!(await confirmDelete(`Ta bort filen ${file.filename} från ${drawing.drawingNumber} rev ${revision.revision}?`))) return;
            void run(() => apiFetch(`${base}/files/${file.id}`, { method: "DELETE" }), "Kunde inte ta bort filen");
          },
        },
      {
        label: "Ta bort",
        danger: true,
        onSelect: async () => {
          const where = drawing ? ` på ritning ${drawing.drawingNumber}` : "";
          const file = drawing ? (revision as ArticleDrawingRevision).file : null;
          const withFile = file ? ` Filen ${file.filename} tas också bort.` : "";
          if (!(await confirmDelete(`Ta bort revision ${revision.revision}${where}?${withFile}`))) return;
          void run(() => apiFetch(revisionPath(drawing, revision), { method: "DELETE" }), "Kunde inte ta bort revisionen");
        },
      },
    ];
  }

  const loaded = revisions !== null && drawings !== null;

  const dialogs = (
    <Modal open={dialog !== null} onClose={() => setDialog(null)} title={dialogTitle(dialog)} compact>
      {dialog?.kind === "newRevision" || dialog?.kind === "editRevision" ? (
        <RevisionForm
          key={dialog.kind === "editRevision" ? dialog.revision.id : `new-${dialog.drawing?.id ?? "article"}`}
          revision={dialog.kind === "editRevision" ? dialog.revision : null}
          hasOthers={
            (dialog.drawing ? dialog.drawing.revisions.length : (revisions?.length ?? 0)) > 0
          }
          // Only a NEW drawing revision takes a file here; an existing one
          // has ⋯ Lägg till fil / Byt fil.
          looseFiles={dialog.kind === "newRevision" && dialog.drawing ? looseFiles : null}
          onCancel={() => setDialog(null)}
          onSave={async (values) => {
            if (dialog.kind === "editRevision") {
              await apiFetch(revisionPath(dialog.drawing, dialog.revision), {
                method: "PATCH",
                body: JSON.stringify({ revision: values.revision, comment: values.comment || null }),
              });
            } else {
              const created = await apiFetch<ArticleDrawingRevision>(revisionPath(dialog.drawing), {
                method: "POST",
                body: JSON.stringify({
                  revision: values.revision,
                  comment: values.comment || undefined,
                  isActive: values.makeActive,
                }),
              });
              // The revision stands even if its file is refused; the dialog
              // closes and the error shows above the cards.
              if (dialog.drawing && values.file) {
                try {
                  await saveRevisionFile(dialog.drawing, created.id, values.file);
                } catch (err) {
                  setError(apiErrorMessage(err, "Revisionen lades till, men inte filen"));
                }
              }
            }
            setDialog(null);
            await load();
          }}
        />
      ) : dialog?.kind === "newDrawing" || dialog?.kind === "renameDrawing" ? (
        <DrawingForm
          key={dialog.kind === "renameDrawing" ? dialog.drawing.id : "new"}
          drawing={dialog.kind === "renameDrawing" ? dialog.drawing : null}
          looseFiles={looseFiles}
          onCancel={() => setDialog(null)}
          onSave={async ({ drawingNumber, revision, file }) => {
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
                  const first = await apiFetch<ArticleDrawingRevision>(`${base}/drawings/${created.id}/revisions`, {
                    method: "POST",
                    body: JSON.stringify({ revision }),
                  });
                  await saveRevisionFile(created, first.id, file);
                } catch (err) {
                  setError(apiErrorMessage(err, "Ritningen lades till, men inte revisionen eller filen"));
                }
              }
            }
            setDialog(null);
            await load();
          }}
        />
      ) : dialog?.kind === "revisionFile" ? (
        <RevisionFileForm
          key={dialog.revision.id}
          current={dialog.revision.file ?? null}
          looseFiles={looseFiles}
          onCancel={() => setDialog(null)}
          onSave={async (choice) => {
            await saveRevisionFile(dialog.drawing, dialog.revision.id, choice);
            // The file the earlier "lades till, men inte filen" error was about is in.
            setError(null);
            setDialog(null);
            await load();
          }}
        />
      ) : null}
    </Modal>
  );

  return { revisions, drawings, looseFiles, error, pending, loaded, base, setDialog, run, revisionMenu, dialogs };
}

// Artikelrevisioner och ritningsnummer med ritningsrevisioner. At most one
// revision is active per article resp. drawing; the first one created
// becomes active automatically, a new one can take over at once, and
// Aktivera (⋯) switches. A drawing revision can have a file (0200): the
// active revision's rides along on the TO printout and the mails, an older
// one's is only opened here (print on demand). Article revisions have none.
export function RevisionerTab({ articleId }: { articleId: string }) {
  const canEdit = useCan()(["artiklar"]);
  const { revisions, drawings, error, pending, loaded, base, setDialog, run, revisionMenu, dialogs } = useRevisionRegisters(articleId);

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
          <RevisionTable rows={revisions} pending={pending} menu={canEdit ? revisionMenu(null) : null} fileArticleId={null} />
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
                  <RevisionTable
                    rows={drawing.revisions}
                    pending={pending}
                    menu={canEdit ? revisionMenu(drawing) : null}
                    fileArticleId={articleId}
                  />
                )}
              </section>
            );
          })
        )}
      </Card>


      {dialogs}
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
    case "revisionFile":
      return `${dialog.revision.file ? "Byt fil på" : "Fil till"} ${dialog.drawing.drawingNumber} rev ${dialog.revision.revision}`;
    default:
      return "";
  }
}

// Ritningar och filer i Beredningen: the article's drawings with the active
// revision and its file (+ Ny ritning / + Ny revision with the same dialogs
// as the Revisioner tab, which keeps the history and the older revisions'
// files), and the article's other files — the Filer tab's, uploaded and
// removed here too.
export function DrawingsPanel({ articleId }: { articleId: string }) {
  const canEdit = useCan()(["artiklar"]);
  const { drawings, looseFiles, error, pending, setDialog, run, base, dialogs } = useRevisionRegisters(articleId);
  const uploadRef = useRef<HTMLInputElement>(null);
  if (drawings === null) return error ? <FormError>{error}</FormError> : null;
  return (
    <section className={styles.panel} aria-label="Ritningar och filer">
      <SectionHeading
        actions={
          canEdit && (
            <>
              <Button type="button" size="small" variant="ghost" onClick={() => setDialog({ kind: "newDrawing" })}>
                + Ny ritning
              </Button>
              <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => uploadRef.current?.click()}>
                + Ladda upp fil
              </Button>
              <input
                ref={uploadRef}
                type="file"
                accept={ARTICLE_FILE_ACCEPT}
                hidden
                aria-label="Välj fil att ladda upp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void run(() => uploadArticleFile(articleId, file), "Uppladdningen misslyckades");
                }}
              />
            </>
          )
        }
      >
        Ritningar och filer
      </SectionHeading>
      <FormError>{error}</FormError>
      {drawings.length === 0 && looseFiles.length === 0 && (
        <p className={styles.empty}>
          Inga ritningar eller filer. Ritningar med revisioner läggs till med + Ny ritning (eller under fliken Revisioner), andra
          filer — PDF, JPEG eller PNG, högst 20 MB — med + Ladda upp fil.
        </p>
      )}
      {drawings.length > 0 && (
        <ul className={styles.panelList}>
          {drawings.map((drawing) => {
            const active = drawing.revisions.find((r) => r.isActive);
            return (
              <li key={drawing.id} className={styles.panelRow}>
                <span className={styles.panelTitle}>
                  <span className={styles.drawingNumber}>{drawing.drawingNumber}</span>
                  <span className={styles.drawingMeta}>{active ? `rev ${active.revision}` : "ingen aktiv revision"}</span>
                  {active?.file ? (
                    <a
                      className={styles.fileLink}
                      href={articleFileHref(articleId, active.file.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {active.file.filename}
                    </a>
                  ) : active ? (
                    <span className={styles.none}>ingen fil</span>
                  ) : null}
                </span>
                {canEdit && (
                  <span className={styles.drawingActions}>
                    {active && !active.file && (
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setDialog({ kind: "revisionFile", drawing, revision: active })}
                      >
                        Lägg till fil
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setDialog({ kind: "newRevision", drawing })}
                    >
                      + Ny revision
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* The article's other files (fliken Filer): they ride along on the TO
          printout, with operations that chose them and with operations that
          chose nothing. */}
      {looseFiles.length > 0 && (
        <ul className={styles.panelList} aria-label="Filer">
          {looseFiles.map((file) => (
            <li key={file.id} className={styles.panelRow}>
              <span className={styles.panelTitle}>
                <span className={styles.drawingMeta}>Fil</span>
                <a className={styles.fileLink} href={articleFileHref(articleId, file.id)} target="_blank" rel="noopener noreferrer">
                  {file.filename}
                </a>
                <span className={styles.none}>{formatFileSize(file.sizeBytes)}</span>
              </span>
              {canEdit && (
                <span className={styles.drawingActions}>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    disabled={pending}
                    onClick={async () => {
                      if (!(await confirmDelete(`Ta bort ${file.filename}?`))) return;
                      void run(() => apiFetch(`${base}/files/${file.id}`, { method: "DELETE" }), "Kunde inte ta bort filen");
                    }}
                  >
                    Ta bort
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {dialogs}
    </section>
  );
}

// Shared table for both revision kinds (same columns and actions). `menu`
// null = read only: no ⋯ column. `fileArticleId` set = drawing revisions,
// with the Fil column (the link opens the file — print it from there, also
// an older revision's).
function RevisionTable({
  rows,
  pending,
  menu,
  fileArticleId,
}: {
  rows: Revision[];
  pending: boolean;
  menu: ((row: Revision) => Parameters<typeof RowMenu>[0]["items"]) | null;
  fileArticleId: string | null;
}) {
  return (
    <Table<Revision>
      columns={[
        { key: "revision", label: "Revision", width: "minmax(90px, 140px)" },
        { key: "comment", label: "Kommentar", width: "1fr" },
        ...(fileArticleId ? [{ key: "file", label: "Fil", width: "minmax(140px, 1fr)" }] : []),
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
          case "file": {
            const file = (row as ArticleDrawingRevision).file;
            if (!file || !fileArticleId) return <span className={styles.none}>–</span>;
            return (
              <a
                className={styles.fileLink}
                href={articleFileHref(fileArticleId, file.id)}
                target="_blank"
                rel="noopener noreferrer"
                title={`Öppna ${file.filename} (${formatFileSize(file.sizeBytes)})`}
              >
                {file.filename}
              </a>
            );
          }
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
  looseFiles,
  onSave,
  onCancel,
}: {
  revision: Revision | null;
  // A first revision becomes active by itself — the choice only matters
  // when there are others.
  hasOthers: boolean;
  // Set = a new drawing revision, which can take a file here.
  looseFiles: ArticleFile[] | null;
  onSave: (values: { revision: string; comment: string; makeActive: boolean; file: FileChoiceValue }) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(revision?.revision ?? "");
  const [comment, setComment] = useState(revision?.comment ?? "");
  const [makeActive, setMakeActive] = useState(true);
  const [file, setFile] = useState<FileChoiceValue>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ revision: value.trim(), comment: comment.trim(), makeActive, file });
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
        {looseFiles && <FileChoice looseFiles={looseFiles} value={file} onChange={setFile} optional />}
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
  looseFiles,
  onSave,
  onCancel,
}: {
  drawing: ArticleDrawing | null;
  looseFiles: ArticleFile[];
  onSave: (values: { drawingNumber: string; revision: string; file: FileChoiceValue }) => Promise<void>;
  onCancel: () => void;
}) {
  const [drawingNumber, setDrawingNumber] = useState(drawing?.drawingNumber ?? "");
  const [revision, setRevision] = useState("");
  const [file, setFile] = useState<FileChoiceValue>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!drawingNumber.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ drawingNumber: drawingNumber.trim(), revision: revision.trim(), file: revision.trim() ? file : null });
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
        {/* The first revision's file — only with a first revision. */}
        {!drawing && revision.trim() && <FileChoice looseFiles={looseFiles} value={file} onChange={setFile} optional />}
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

// The file for a drawing revision: upload a new one, or take one of the
// article's loose files (fliken Filer). Choosing one clears the other.
function FileChoice({
  looseFiles,
  value,
  onChange,
  optional,
}: {
  looseFiles: ArticleFile[];
  value: FileChoiceValue;
  onChange: (value: FileChoiceValue) => void;
  optional?: boolean;
}) {
  return (
    <>
      <Field label={optional ? "Fil (valfritt)" : "Ladda upp en fil"} htmlFor="revisionFileUpload">
        <input
          id="revisionFileUpload"
          type="file"
          accept={ARTICLE_FILE_ACCEPT}
          className={styles.fileInput}
          // Uncontrolled: picking "Välj bland artikelns filer" clears it by key.
          key={value?.kind === "loose" ? "cleared" : "file"}
          onChange={(e) => {
            const picked = e.target.files?.[0];
            onChange(picked ? { kind: "upload", file: picked } : null);
          }}
        />
      </Field>
      {looseFiles.length > 0 && (
        <Field label="eller välj bland artikelns filer" htmlFor="revisionFileLoose">
          <Select
            id="revisionFileLoose"
            value={value?.kind === "loose" ? value.fileId : ""}
            onChange={(e) => onChange(e.target.value ? { kind: "loose", fileId: e.target.value } : null)}
          >
            <option value="">— Ingen —</option>
            {looseFiles.map((f) => (
              <option key={f.id} value={f.id}>
                {f.filename}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className={styles.hint}>PDF, JPEG eller PNG, högst 20 MB. Den aktiva revisionens fil följer med TO-utskriften och mejlen.</p>
    </>
  );
}

function RevisionFileForm({
  current,
  looseFiles,
  onSave,
  onCancel,
}: {
  current: ArticleDrawingRevision["file"] | null;
  looseFiles: ArticleFile[];
  onSave: (choice: FileChoiceValue) => Promise<void>;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<FileChoiceValue>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(choice);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara filen"));
      setSaving(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormStack>
        {current && <p className={styles.hint}>Den nuvarande filen {current.filename} ersätts och tas bort.</p>}
        <FileChoice looseFiles={looseFiles} value={choice} onChange={setChoice} />
      </FormStack>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" variant="primary" disabled={saving || !choice}>
          {saving ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
