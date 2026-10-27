"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Field, Input } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { apiFetch } from "../../lib/api";
import type { Article, CustomerArticleNumber } from "../../lib/types";
import { Form, FormActions, FormError } from "../ui/Form";

// Kundens artikelnummer — what this customer calls one of our articles
// (customer_article_numbers, one per customer and article). Same shape as
// CustomerPricesTab: server-fetched rows arrive as props and CRUD refreshes
// via router.refresh(). The write permission is the customer's own prices
// (same module), which the Priser tab does not gate in the UI either — the
// server answers 403 and the message lands in the FormError.
export function CustomerArticleNumbersTab({
  numbers,
  numbersBase,
}: {
  numbers: CustomerArticleNumber[];
  numbersBase: string;
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerArticleNumber | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function removeNumber(row: CustomerArticleNumber) {
    if (
      !(await confirmDelete(
        `Ta bort kundens artikelnummer ${row.customerArticleNumber} för ${row.articleNumber} — ${row.articleName}?`
      ))
    )
      return;
    setError(null);
    try {
      await apiFetch(`${numbersBase}/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort kundens artikelnummer");
    }
  }

  return (
    <div>
      <FormError>{error}</FormError>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
          + Nytt artikelnummer
        </Button>
      </div>

      <Table<CustomerArticleNumber>
        columns={[
          { key: "articleNumber", label: "Artikelnummer", width: "1fr" },
          { key: "articleName", label: "Benämning", width: "1.6fr" },
          { key: "customerArticleNumber", label: "Kundens artikelnummer", width: "1.2fr" },
          { key: "id", label: "", width: "160px", align: "right" },
        ]}
        rows={numbers}
        emptyText="Inga artikelnummer registrerade för kunden"
        renderCell={(row, key) => {
          switch (key) {
            case "articleNumber":
              return row.articleNumber;
            case "articleName":
              return row.articleName;
            case "customerArticleNumber":
              return row.customerArticleNumber;
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <Button type="button" size="small" variant="ghost" onClick={() => setEditing(row)}>
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => removeNumber(row)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nytt artikelnummer">
        <CustomerArticleNumberForm
          numbersBase={numbersBase}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title="Redigera artikelnummer">
        {editing && (
          <CustomerArticleNumberForm
            numbersBase={numbersBase}
            row={editing}
            onSuccess={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

// Creates a customer article number, or edits one when `row` is passed. The
// article is immutable server-side (the PATCH takes only the number), so the
// picker is shown while creating and a read-only field while editing; to
// change the article, remove the row and add a new one.
function CustomerArticleNumberForm({
  numbersBase,
  row,
  onSuccess,
}: {
  numbersBase: string;
  row?: CustomerArticleNumber;
  onSuccess: () => void;
}) {
  const isEdit = row !== undefined;
  const [article, setArticle] = useState<Article | null>(null);
  const [customerArticleNumber, setCustomerArticleNumber] = useState(row?.customerArticleNumber ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isEdit && !article) {
      setError("Välj en artikel");
      return;
    }
    if (customerArticleNumber.trim() === "") {
      setError("Ange kundens artikelnummer");
      return;
    }

    setPending(true);
    try {
      if (isEdit && row) {
        await apiFetch(`${numbersBase}/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ customerArticleNumber: customerArticleNumber.trim() }),
        });
      } else {
        await apiFetch(numbersBase, {
          method: "POST",
          body: JSON.stringify({ articleId: article!.id, customerArticleNumber: customerArticleNumber.trim() }),
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara kundens artikelnummer");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      {isEdit && row ? (
        <Field label="Artikel" htmlFor="customerArticleNumberArticleReadonly">
          <Input
            id="customerArticleNumberArticleReadonly"
            disabled
            value={`${row.articleNumber} — ${row.articleName}`}
          />
        </Field>
      ) : (
        <Field label="Artikel" htmlFor="customerArticleNumberArticle">
          <ArticlePicker id="customerArticleNumberArticle" value={article} onChange={setArticle} />
        </Field>
      )}

      <Field label="Kundens artikelnummer" htmlFor="customerArticleNumberValue">
        <Input
          id="customerArticleNumberValue"
          maxLength={50}
          value={customerArticleNumber}
          onChange={(e) => setCustomerArticleNumber(e.target.value)}
        />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : isEdit ? "Spara" : "Lägg till"}
        </Button>
      </FormActions>
    </Form>
  );
}
