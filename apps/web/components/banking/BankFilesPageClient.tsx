"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "../ui/Button";
import { FormError, FormNotice } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { ListToolbar, Pagination } from "../ui/ListControls";
import { Table } from "../ui/Table";
import { GatedLink } from "../ui/GatedLink";
import { API_URL, ApiError } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { BankFileListRow, BankFileMeta, BankFileSkippedFrom, Paged } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import listStyles from "../../app/inkop/ordrar/page.module.css";

const COPY = {
  debit: {
    base: "/inkop/bankfiler",
    title: "Bankfiler",
    meta: "Debiteringsavier (camt.054) som bekräftar betalfilernas betalningar",
    help: { chapter: "inkop", anchor: "bekrafta-betalningar", label: "Hjälp om bankfiler" },
  },
  credit: {
    base: "/forsaljning/bankfiler",
    title: "Bankfiler",
    meta: "Kreditavier (camt.054) med kundernas inbetalningar",
    help: { chapter: "forsaljning", anchor: "bankfiler-inbetalningar", label: "Hjälp om bankfiler" },
  },
} as const;

export function BankFilesPageClient({ direction, files, pageSize }: { direction: "credit" | "debit"; files: Paged<BankFileListRow>; pageSize: number }) {
  const copy = COPY[direction];
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Shown INSTEAD of navigating on. A duplicate upload or one that skipped
  // entries would otherwise lose its explanation on the very next page.
  const [notice, setNotice] = useState<{ text: string; fileId: string; skippedFrom: BankFileSkippedFrom[]; warnings: string[] } | null>(null);
  const [pending, setPending] = useState(false);

  async function upload(file: File) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_URL}/api/v1/bank-files`, { method: "POST", body: form, credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiErrorMessage(new ApiError(body.error ?? "", res.status, body.code, body), "Filen kunde inte läsas in."));
        return;
      }
      const {
        file: meta,
        created,
        skippedFrom = [],
        warnings = [],
      } = body as { file: BankFileMeta; created: boolean; skippedFrom?: BankFileSkippedFrom[]; warnings?: string[] };
      if (!created) {
        setNotice({ text: "Filen är redan inläst.", fileId: meta.id, skippedFrom: [], warnings: [] });
        router.refresh();
      } else if (meta.skippedDuplicates > 0) {
        // The file's own warnings (a PDNG entry skipped, a repeated bank
        // reference …) are shown here too — the user does not land on the
        // file's page, where they would otherwise have been read.
        setNotice({ text: `${meta.skippedDuplicates} poster var redan inlästa och hoppades över.`, fileId: meta.id, skippedFrom, warnings });
        router.refresh();
      } else {
        router.push(`${copy.base}/${meta.id}`);
      }
    } catch {
      setError("Filen kunde inte laddas upp.");
    } finally {
      setPending(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{copy.title}</div>
          <div className={shellStyles.meta}>{copy.meta}</div>
        </div>
        <HelpLink chapter={copy.help.chapter} anchor={copy.help.anchor} label={copy.help.label} />
      </div>
      <ListToolbar placeholder="Sök filnamn…">
        <input
          ref={input}
          type="file"
          accept=".xml,application/xml,text/xml"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
        />
        <Button onClick={() => input.current?.click()} disabled={pending}>
          Läs in bankfil
        </Button>
      </ListToolbar>
      {error && <FormError>{error}</FormError>}
      {notice && (
        <FormNotice>
          <div>
            {notice.text} <GatedLink href={`${copy.base}/${notice.fileId}`}>Öppna filen</GatedLink>
          </div>
          {notice.skippedFrom.map((s) => (
            <div key={s.bankFileId}>
              {s.count} {s.count === 1 ? "post" : "poster"} från <GatedLink href={`${copy.base}/${s.bankFileId}`}>{s.filename}</GatedLink>
            </div>
          ))}
          {notice.warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </FormNotice>
      )}
      <Table<BankFileListRow>
        columns={[
          { key: "filename", label: "Fil", width: "1.5fr" },
          { key: "bankCreatedAt", label: "Skapad i banken", width: "160px" },
          { key: "createdAt", label: "Inläst", width: "120px" },
          { key: "entries", label: "Poster", width: "80px", align: "right" },
          { key: "booked", label: "Hanterade", width: "100px", align: "right" },
          { key: "unhandled", label: "Ohanterade", width: "100px", align: "right" },
        ]}
        rows={files.rows}
        emptyText="Inga bankfiler inlästa än"
        renderCell={(row, key) => {
          switch (key) {
            case "filename":
              return (
                <Link href={`${copy.base}/${row.id}`} className={listStyles.rowLink}>
                  {row.filename}
                </Link>
              );
            case "bankCreatedAt":
              return row.bankCreatedAt ? row.bankCreatedAt.slice(0, 16).replace("T", " ") : "–";
            case "createdAt":
              return row.createdAt.slice(0, 10);
            case "entries":
              return row.entries;
            case "booked":
              return row.booked + row.ignored;
            case "unhandled":
              return row.unhandled;
            default:
              return null;
          }
        }}
      />
      <Pagination total={files.total} pageSize={pageSize} />
    </>
  );
}
