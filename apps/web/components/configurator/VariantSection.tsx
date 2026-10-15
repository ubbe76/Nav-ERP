"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import { formatQuantity } from "../../lib/stampSessions";
import type { ConfiguratorGroupDetail, VariantListRow } from "../../lib/configurator";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { HelpLink } from "../ui/HelpLink";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { CreateVariantsModal } from "./CreateVariantsModal";

interface Props {
  articleId: string;
  groups: ConfiguratorGroupDetail[];
  defaultQuantity: number;
  canEdit: boolean;
}

// Stocked variants of a template in variant mode.
export function VariantSection({ articleId, groups, defaultQuantity, canEdit }: Props) {
  const [rows, setRows] = useState<VariantListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [openKey, setOpenKey] = useState(0);

  const reload = useCallback(async () => {
    try {
      setRows(await apiFetch<VariantListRow[]>(`/api/v1/articles/${articleId}/configurator/variants`));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta varianterna"));
    }
  }, [articleId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div>
      <SectionHeading
        spaced
        actions={
          <>
            {canEdit && (
              <Button
                size="small"
                variant="secondary"
                onClick={() => {
                  setOpenKey((k) => k + 1);
                  setOpen(true);
                }}
              >
                Skapa varianter
              </Button>
            )}
            <HelpLink chapter="artiklar" anchor="varianter" label="Hjälp om varianter" />
          </>
        }
      >
        Varianter
      </SectionHeading>
      <FormError margin="below">{error}</FormError>
      <Table<VariantListRow & { id: string }>
        columns={[
          { key: "number", label: "Artikelnummer", width: "minmax(120px, 1fr)" },
          { key: "name", label: "Benämning", width: "minmax(160px, 2fr)" },
          { key: "salesPrice", label: "Försäljningspris", width: "130px", align: "right" },
          { key: "standardCost", label: "Standardpris", width: "110px", align: "right" },
          { key: "onHand", label: "Saldo", width: "80px", align: "right" },
          { key: "active", label: "Aktiv", width: "60px" },
        ]}
        rows={(rows ?? []).map((r) => ({ ...r, id: r.articleId }))}
        emptyText={rows === null ? "Hämtar…" : "Inga varianter ännu"}
        renderCell={(r, key) => {
          switch (key) {
            case "number":
              return <GatedLink href={`/artiklar/${r.articleId}`}>{r.articleNumber}</GatedLink>;
            case "name":
              return r.name;
            case "salesPrice":
              return r.salesPrice === null ? "—" : formatMoney(r.salesPrice);
            case "standardCost":
              return r.standardCost === null ? "—" : formatMoney(r.standardCost);
            case "onHand":
              return formatQuantity(Number(r.onHand));
            case "active":
              return r.active ? "Ja" : "Nej";
            default:
              return null;
          }
        }}
      />
      <CreateVariantsModal
        open={open}
        openKey={openKey}
        articleId={articleId}
        groups={groups}
        defaultQuantity={defaultQuantity}
        onClose={() => setOpen(false)}
        onChanged={reload}
      />
    </div>
  );
}
