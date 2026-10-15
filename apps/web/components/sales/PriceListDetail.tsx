"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { SectionHeading } from "../ui/SectionHeading";
import { Modal } from "../ui/Modal";
import { Field, Input } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { apiFetch } from "../../lib/api";
import type { Article, PriceListRow, PriceListWithRows } from "../../lib/types";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormRow, FormSaved } from "../ui/Form";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

export function PriceListDetail({ priceList }: { priceList: PriceListWithRows }) {
  const router = useRouter();
  const [code, setCode] = useState(priceList.code);
  const [name, setName] = useState(priceList.name);
  const [description, setDescription] = useState(priceList.description ?? "");
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PriceListRow | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  async function saveHeader(e: FormEvent) {
    e.preventDefault();
    setHeaderError(null);
    setSaved(false);
    setSaving(true);
    try {
      // description is nullable on the API's update schema — an empty field
      // clears it back to NULL instead of storing "".
      const trimmedDescription = description.trim();
      await apiFetch(`/api/v1/price-lists/${priceList.id}`, {
        method: "PATCH",
        body: JSON.stringify({ code, name, description: trimmedDescription === "" ? null : trimmedDescription }),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setHeaderError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setSaving(false);
    }
  }

  // 409 PriceListInUseError when a customer still points at this list — the
  // message is shown, not swallowed, so the user knows why the delete failed.
  async function handleDelete() {
    if (!(await confirmDelete(`Ta bort prislistan ${priceList.code}?`))) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/price-lists/${priceList.id}`, { method: "DELETE" });
      router.push("/forsaljning/prislistor");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Kunde inte ta bort prislistan");
      setDeleting(false);
    }
  }

  async function removeRow(row: PriceListRow) {
    if (!(await confirmDelete(`Ta bort raden för ${row.articleNumber}?`))) return;
    setRowError(null);
    try {
      await apiFetch(`/api/v1/price-lists/${priceList.id}/rows/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Kunde inte ta bort raden");
    }
  }

  return (
    <div>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>
            {priceList.code} · {priceList.name}
          </div>
          <div className={shellStyles.meta}>Prislista</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="danger" disabled={deleting} onClick={handleDelete}>
            {deleting ? "Tar bort…" : "Ta bort prislista"}
          </Button>
          <HelpLink chapter="forsaljning" anchor="prislistor" label="Hjälp om prislistor" />
        </div>
      </div>

      <FormError margin="below">{deleteError}</FormError>

      <Card style={{ marginBottom: 24 }}>
        <Form onSubmit={saveHeader}>
          <FormError>{headerError}</FormError>

          <FormRow>
            <Field label="Kod" htmlFor="priceListCode">
              <Input
                id="priceListCode"
                size="md"
                required
                maxLength={20}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <Field label="Namn" htmlFor="priceListName">
              <Input
                id="priceListName"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          </FormRow>

          <Field label="Beskrivning" htmlFor="priceListDescription">
            <Input
              id="priceListDescription"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <FormActions>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Sparar…" : "Spara"}
            </Button>
            {saved && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        </Form>
      </Card>

      <SectionHeading
        spaced
        actions={
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            + Lägg till rad
          </Button>
        }
      >
        Prisrader
      </SectionHeading>

      <FormError>{rowError}</FormError>

      <Table<PriceListRow>
        columns={[
          { key: "article", label: "Artikel", width: "1.4fr" },
          { key: "fromQuantity", label: "Från antal", width: "140px", align: "right" },
          { key: "unitPrice", label: "À-pris (kr)", width: "140px", align: "right" },
          { key: "id", label: "", width: "160px", align: "right" },
        ]}
        rows={priceList.rows}
        emptyText="Inga prisrader registrerade"
        renderCell={(row, key) => {
          switch (key) {
            case "article":
              return (
                <span>
                  <strong>{row.articleNumber}</strong> — {row.articleName}
                </span>
              );
            case "fromQuantity":
              return Number(row.fromQuantity).toLocaleString("sv-SE");
            case "unitPrice":
              return Number(row.unitPrice).toLocaleString("sv-SE", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setEditing(row);
                      setModalOpen(true);
                    }}
                  >
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => removeRow(row)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Redigera ${editing.articleNumber}` : "Ny prisrad"}
      >
        <PriceListRowForm
          priceListId={priceList.id}
          existing={editing}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </div>
  );
}

// Adds a price-break row, or edits fromQuantity/unitPrice on an existing one
// — the article link is fixed once created (updatePriceListRowSchema has no
// articleId field; change = remove + add), same pattern as InkopTab's
// ArticleSupplierForm.
function PriceListRowForm({
  priceListId,
  existing,
  onSuccess,
}: {
  priceListId: string;
  existing: PriceListRow | null;
  onSuccess: () => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  // Canonicalize the raw numeric strings from the API ("1.0000") the same
  // way CustomerPricesTab's edit prefill does — String(Number(...)) so the
  // input shows "1" instead of trailing zeros.
  const [fromQuantity, setFromQuantity] = useState(existing ? String(Number(existing.fromQuantity)) : "1");
  const [unitPrice, setUnitPrice] = useState(existing?.unitPrice != null ? String(Number(existing.unitPrice)) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!existing && !article) {
      setError("Välj en artikel");
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (existing) {
        await apiFetch(`/api/v1/price-lists/${priceListId}/rows/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            fromQuantity: Number(fromQuantity),
            unitPrice: Number(unitPrice),
          }),
        });
      } else {
        await apiFetch(`/api/v1/price-lists/${priceListId}/rows`, {
          method: "POST",
          body: JSON.stringify({
            articleId: article!.id,
            fromQuantity: Number(fromQuantity),
            unitPrice: Number(unitPrice),
          }),
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara raden");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      {existing ? (
        <Field label="Artikel">
          <Input value={`${existing.articleNumber} — ${existing.articleName}`} disabled />
        </Field>
      ) : (
        <Field label="Artikel" htmlFor="priceListRowArticle">
          <ArticlePicker id="priceListRowArticle" value={article} onChange={setArticle} />
        </Field>
      )}

      <FormRow>
        <Field label="Från antal" htmlFor="priceListRowFromQuantity">
          <Input
            id="priceListRowFromQuantity"
            type="number"
            min="0"
            step="any"
            size="sm"
            required
            value={fromQuantity}
            onChange={(e) => setFromQuantity(e.target.value)}
          />
        </Field>
        <Field label="À-pris (kr)" htmlFor="priceListRowUnitPrice">
          <Input
            id="priceListRowUnitPrice"
            type="number"
            min="0"
            step="0.01"
            size="sm"
            required
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
          />
        </Field>
      </FormRow>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : existing ? "Spara" : "Lägg till"}
        </Button>
      </FormActions>
    </Form>
  );
}
