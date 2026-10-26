"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Field, Input, Select } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { apiFetch } from "../../lib/api";
import { currencyLabel, SEK } from "../../lib/currency";
import type { Article, ArticleGroup, CustomerPrice } from "../../lib/types";
import { Form, FormActions, FormError } from "../ui/Form";

// C3 Kundpriser — fliken Priser: kundens egna pris-/rabattregler
// (customer_prices). Server-fetched like KontakterTab (prices/articleGroups
// arrive as props from the customer page and CRUD refreshes via
// router.refresh()), not client-fetched like InkopTab.
export function CustomerPricesTab({
  prices,
  pricesBase,
  articleGroups,
  currency,
}: {
  prices: CustomerPrice[];
  pricesBase: string;
  articleGroups: ArticleGroup[];
  // Valuta: the customer's currency — a special price (Specialpris) is in it.
  currency: string;
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerPrice | null>(null);
  const [error, setError] = useState<string | null>(null);

  function targetLabel(price: CustomerPrice): string {
    return price.articleId
      ? `${price.articleNumber} — ${price.articleName}`
      : `${price.articleGroupName} (grupp)`;
  }

  async function removePrice(price: CustomerPrice) {
    if (!(await confirmDelete(`Ta bort prisregeln för ${targetLabel(price)}?`))) return;
    setError(null);
    try {
      await apiFetch(`${pricesBase}/${price.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort prisregeln");
    }
  }

  return (
    <div>
      <FormError>{error}</FormError>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
          + Ny prisregel
        </Button>
      </div>

      <Table<CustomerPrice>
        columns={[
          { key: "target", label: "Artikel/Grupp", width: "1.6fr" },
          { key: "fromQuantity", label: "Från antal", width: "120px" },
          { key: "unitPrice", label: currency === SEK ? "Pris" : `Pris (${currency})`, width: "120px" },
          { key: "discountPercent", label: "Rabatt %", width: "120px" },
          { key: "id", label: "", width: "160px", align: "right" },
        ]}
        rows={prices}
        emptyText="Inga prisregler registrerade"
        renderCell={(price, key) => {
          switch (key) {
            case "target":
              return targetLabel(price);
            case "fromQuantity":
              return Number(price.fromQuantity).toLocaleString("sv-SE");
            case "unitPrice":
              return price.unitPrice != null
                ? Number(price.unitPrice).toLocaleString("sv-SE", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
                : "–";
            case "discountPercent":
              return price.discountPercent != null
                ? `${Number(price.discountPercent).toLocaleString("sv-SE")} %`
                : "–";
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <Button type="button" size="small" variant="ghost" onClick={() => setEditing(price)}>
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => removePrice(price)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny prisregel">
        <CustomerPriceForm
          pricesBase={pricesBase}
          articleGroups={articleGroups}
          currency={currency}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title="Redigera prisregel">
        {editing && (
          <CustomerPriceForm
            pricesBase={pricesBase}
            articleGroups={articleGroups}
            currency={currency}
            price={editing}
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

type TargetType = "article" | "group";
type ValueType = "price" | "discount";

// Creates a price rule, or edits one when `price` is passed. The target
// (article/group) is immutable server-side once created — the API's
// updateCustomerPriceSchema has no articleId/articleGroupId fields — so the
// radio/picker for it is only shown while creating; editing shows it read-only.
function CustomerPriceForm({
  pricesBase,
  articleGroups,
  currency,
  price,
  onSuccess,
}: {
  pricesBase: string;
  articleGroups: ArticleGroup[];
  currency: string;
  price?: CustomerPrice;
  onSuccess: () => void;
}) {
  const isEdit = price !== undefined;
  const [targetType, setTargetType] = useState<TargetType>(price?.articleGroupId ? "group" : "article");
  const [article, setArticle] = useState<Article | null>(null);
  const [articleGroupId, setArticleGroupId] = useState("");
  // Prefill as canonical numbers (String(Number(...))), not the raw DB
  // strings ("1.0000", "199.0000") — otherwise the field shows "1.0000"
  // instead of "1" the moment the edit modal opens.
  const [fromQuantity, setFromQuantity] = useState(price ? String(Number(price.fromQuantity)) : "1");
  const [valueType, setValueType] = useState<ValueType>(price?.discountPercent != null ? "discount" : "price");
  const [unitPrice, setUnitPrice] = useState(price?.unitPrice != null ? String(Number(price.unitPrice)) : "");
  const [discountPercent, setDiscountPercent] = useState(
    price?.discountPercent != null ? String(Number(price.discountPercent)) : ""
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isEdit && targetType === "article" && !article) {
      setError("Välj en artikel");
      return;
    }
    if (!isEdit && targetType === "group" && !articleGroupId) {
      setError("Välj en varugrupp");
      return;
    }
    if (valueType === "price" && unitPrice.trim() === "") {
      setError("Ange ett pris");
      return;
    }
    if (valueType === "discount" && discountPercent.trim() === "") {
      setError("Ange en rabatt");
      return;
    }

    setPending(true);
    try {
      if (isEdit && price) {
        await apiFetch(`${pricesBase}/${price.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            fromQuantity,
            ...(valueType === "price" ? { unitPrice } : { discountPercent }),
          }),
        });
      } else {
        await apiFetch(pricesBase, {
          method: "POST",
          body: JSON.stringify({
            articleId: targetType === "article" ? article!.id : undefined,
            articleGroupId: targetType === "group" ? articleGroupId : undefined,
            fromQuantity,
            unitPrice: valueType === "price" ? unitPrice : undefined,
            discountPercent: valueType === "discount" ? discountPercent : undefined,
          }),
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara prisregeln");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      {isEdit && price ? (
        <Field label="Artikel/Grupp" htmlFor="customerPriceTargetReadonly">
          <Input
            id="customerPriceTargetReadonly"
            disabled
            value={
              price.articleId ? `${price.articleNumber} — ${price.articleName}` : `${price.articleGroupName} (grupp)`
            }
          />
        </Field>
      ) : (
        <>
          <Field label="Måltyp" htmlFor="customerPriceTargetType">
            <div style={{ display: "flex", gap: 16 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name="customerPriceTargetType"
                  checked={targetType === "article"}
                  onChange={() => setTargetType("article")}
                />
                Artikel
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name="customerPriceTargetType"
                  checked={targetType === "group"}
                  onChange={() => setTargetType("group")}
                />
                Varugrupp
              </label>
            </div>
          </Field>

          {targetType === "article" ? (
            <Field label="Artikel" htmlFor="customerPriceArticle">
              <ArticlePicker id="customerPriceArticle" value={article} onChange={setArticle} />
            </Field>
          ) : (
            <Field label="Varugrupp" htmlFor="customerPriceArticleGroup">
              <Select
                id="customerPriceArticleGroup"
                value={articleGroupId}
                onChange={(e) => setArticleGroupId(e.target.value)}
              >
                <option value="">— Välj varugrupp —</option>
                {articleGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.code} · {group.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </>
      )}

      <Field label="Från antal" htmlFor="customerPriceFromQuantity">
        <Input
          id="customerPriceFromQuantity"
          type="number"
          min="0"
          step="any"
          size="sm"
          value={fromQuantity}
          onChange={(e) => setFromQuantity(e.target.value)}
        />
      </Field>

      <Field label="Pristyp" htmlFor="customerPriceValueType">
        <div style={{ display: "flex", gap: 16 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="radio"
              name="customerPriceValueType"
              checked={valueType === "price"}
              onChange={() => setValueType("price")}
            />
            Specialpris ({currencyLabel(currency)})
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="radio"
              name="customerPriceValueType"
              checked={valueType === "discount"}
              onChange={() => setValueType("discount")}
            />
            Rabatt (%)
          </label>
        </div>
      </Field>

      {valueType === "price" ? (
        <Field label={`Specialpris (${currencyLabel(currency)})`} htmlFor="customerPriceUnitPrice">
          <Input
            id="customerPriceUnitPrice"
            type="number"
            min="0"
            step="0.01"
            size="sm"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
          />
        </Field>
      ) : (
        <Field label="Rabatt (%)" htmlFor="customerPriceDiscountPercent">
          <Input
            id="customerPriceDiscountPercent"
            type="number"
            min="0"
            step="any"
            size="xs"
            value={discountPercent}
            onChange={(e) => setDiscountPercent(e.target.value)}
          />
        </Field>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : isEdit ? "Spara prisregel" : "Skapa prisregel"}
        </Button>
      </FormActions>
    </Form>
  );
}
