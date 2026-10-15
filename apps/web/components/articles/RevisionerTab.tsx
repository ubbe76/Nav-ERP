"use client";

import { confirmDelete } from "../../lib/confirm";
import { useEffect, useState, type FormEvent } from "react";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { ArticleDrawing, ArticleDrawingRevision, ArticleRevision } from "../../lib/types";
import { Form, FormError, FormRow } from "../ui/Form";

// Artikelrevisioner och ritningsnummer med ritningsrevisioner — pure metadata
// registers (no link to the uploaded files). At most one revision is active
// per article resp. drawing; the first one created becomes active
// automatically, "Aktivera" switches.
export function RevisionerTab({ articleId }: { articleId: string }) {
  const [revisions, setRevisions] = useState<ArticleRevision[]>([]);
  const [drawings, setDrawings] = useState<ArticleDrawing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function load() {
    try {
      const [revs, draws] = await Promise.all([
        apiFetch<ArticleRevision[]>(`/api/v1/articles/${articleId}/revisions`),
        apiFetch<ArticleDrawing[]>(`/api/v1/articles/${articleId}/drawings`),
      ]);
      setRevisions(revs);
      setDrawings(draws);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte hämta revisionerna");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    setPending(true);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <FormError>{error}</FormError>

      <SectionHeading>Artikelrevisioner</SectionHeading>
      <RevisionTable
        rows={revisions}
        pending={pending}
        onActivate={(rev) =>
          run(
            () => apiFetch(`/api/v1/articles/${articleId}/revisions/${rev.id}`, {
              method: "PATCH",
              body: JSON.stringify({ isActive: true }),
            }),
            "Kunde inte aktivera revisionen"
          )
        }
        onDelete={(rev) =>
          run(
            () => apiFetch(`/api/v1/articles/${articleId}/revisions/${rev.id}`, { method: "DELETE" }),
            "Kunde inte ta bort revisionen"
          )
        }
      />
      <AddRevisionForm
        pending={pending}
        onAdd={(revision, comment) =>
          run(
            () => apiFetch(`/api/v1/articles/${articleId}/revisions`, {
              method: "POST",
              body: JSON.stringify({ revision, comment: comment || undefined }),
            }),
            "Kunde inte lägga till revisionen"
          )
        }
      />

      <SectionHeading spaced>Ritningar</SectionHeading>
      {drawings.map((drawing) => (
        <div key={drawing.id} style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
            <strong>Ritningsnummer: {drawing.drawingNumber}</strong>
            <Button
              type="button"
              size="small"
              variant="danger"
              disabled={pending}
              onClick={async () => {
                if (!(await confirmDelete(`Ta bort ritning ${drawing.drawingNumber} med alla revisioner?`))) return;
                void run(
                  () => apiFetch(`/api/v1/articles/${articleId}/drawings/${drawing.id}`, { method: "DELETE" }),
                  "Kunde inte ta bort ritningen"
                );
              }}
            >
              Ta bort
            </Button>
          </div>
          <RevisionTable
            rows={drawing.revisions}
            pending={pending}
            onActivate={(rev) =>
              run(
                () => apiFetch(`/api/v1/articles/${articleId}/drawings/${drawing.id}/revisions/${rev.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ isActive: true }),
                }),
                "Kunde inte aktivera revisionen"
              )
            }
            onDelete={(rev) =>
              run(
                () => apiFetch(`/api/v1/articles/${articleId}/drawings/${drawing.id}/revisions/${rev.id}`, {
                  method: "DELETE",
                }),
                "Kunde inte ta bort revisionen"
              )
            }
          />
          <AddRevisionForm
            pending={pending}
            onAdd={(revision, comment) =>
              run(
                () => apiFetch(`/api/v1/articles/${articleId}/drawings/${drawing.id}/revisions`, {
                  method: "POST",
                  body: JSON.stringify({ revision, comment: comment || undefined }),
                }),
                "Kunde inte lägga till revisionen"
              )
            }
          />
        </div>
      ))}
      {drawings.length === 0 && <p>Inga ritningar tillagda än.</p>}

      <AddDrawingForm
        pending={pending}
        onAdd={(drawingNumber) =>
          run(
            () => apiFetch(`/api/v1/articles/${articleId}/drawings`, {
              method: "POST",
              body: JSON.stringify({ drawingNumber }),
            }),
            "Kunde inte lägga till ritningen"
          )
        }
      />
    </div>
  );
}

// Shared table for both revision kinds (same columns and actions).
function RevisionTable<T extends ArticleRevision | ArticleDrawingRevision>({
  rows,
  pending,
  onActivate,
  onDelete,
}: {
  rows: T[];
  pending: boolean;
  onActivate: (row: T) => void;
  onDelete: (row: T) => void;
}) {
  if (rows.length === 0) return <p>Inga revisioner än.</p>;
  return (
    <Table<T>
      columns={[
        { key: "revision", label: "Revision", width: "120px" },
        { key: "comment", label: "Kommentar", width: "1fr" },
        { key: "isActive", label: "Aktiv", width: "80px" },
        { key: "createdAt", label: "Skapad", width: "120px" },
        { key: "id", label: "", width: "180px", align: "right" },
      ]}
      rows={rows}
      renderCell={(row, key) => {
        switch (key) {
          case "comment":
            return row.comment ?? "–";
          case "isActive":
            return row.isActive ? "Ja" : "";
          case "createdAt":
            return new Date(row.createdAt).toLocaleDateString("sv-SE");
          case "id":
            return (
              <span style={{ display: "inline-flex", gap: 8 }}>
                {!row.isActive && (
                  <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => onActivate(row)}>
                    Aktivera
                  </Button>
                )}
                <Button
                  type="button"
                  size="small"
                  variant="danger"
                  disabled={pending}
                  onClick={async () => {
                    if (await confirmDelete(`Ta bort revision ${row.revision}?`)) onDelete(row);
                  }}
                >
                  Ta bort
                </Button>
              </span>
            );
          default:
            return row[key as keyof T] as string;
        }
      }}
    />
  );
}

function AddRevisionForm({
  pending,
  onAdd,
}: {
  pending: boolean;
  onAdd: (revision: string, comment: string) => void;
}) {
  const [revision, setRevision] = useState("");
  const [comment, setComment] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!revision.trim()) return;
    onAdd(revision.trim(), comment.trim());
    setRevision("");
    setComment("");
  }

  return (
    <Form onSubmit={submit} style={{ marginTop: 10 }}>
      <FormRow style={{ alignItems: "flex-end" }}>
        <Field label="Revision">
          <Input
            maxLength={20}
            size="md"
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
          />
        </Field>
        <Field label="Kommentar (valfritt)">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <Button type="submit" size="small" variant="secondary" disabled={pending || !revision.trim()}>
          Lägg till revision
        </Button>
      </FormRow>
    </Form>
  );
}

function AddDrawingForm({ pending, onAdd }: { pending: boolean; onAdd: (drawingNumber: string) => void }) {
  const [drawingNumber, setDrawingNumber] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!drawingNumber.trim()) return;
    onAdd(drawingNumber.trim());
    setDrawingNumber("");
  }

  return (
    <Form onSubmit={submit} style={{ marginTop: 16 }}>
      <FormRow style={{ alignItems: "flex-end" }}>
        <Field label="Ritningsnummer">
          <Input
            maxLength={50}
            size="md"
            value={drawingNumber}
            onChange={(e) => setDrawingNumber(e.target.value)}
          />
        </Field>
        <Button type="submit" size="small" variant="secondary" disabled={pending || !drawingNumber.trim()}>
          Lägg till ritning
        </Button>
      </FormRow>
    </Form>
  );
}
