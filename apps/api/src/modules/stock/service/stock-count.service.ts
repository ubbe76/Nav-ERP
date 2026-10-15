import type {
  AddStockCountRowInput,
  CreateStockCountInput,
  ListStockCountsQuery,
  UpdateStockCountRowInput,
} from "@navet/shared";
import type { StockCountRepository } from "../repository/stock-count.repository.js";
import type { StockCountSheetPdfInput } from "../../mail/service/document-pdf.js";
import { StockCountNotFoundError } from "./stock.errors.js";
// G1: append-only audit trail. Only the session-level status transitions
// (posted/cancelled) are logged here — plain stock_transactions/transfers
// are NOT (stock_transactions is already an append-only ledger with its own
// created_by column, so a second audit trail over the same rows would be
// redundant noise).
import type { AuditWriter } from "../../system/repository/audit.repository.js";

// Narrow DI like valuation's ValuationPdfRenderer — the renderer itself is
// implemented in mail/document-pdf.ts (task 8), tests build the service
// without it. The interface stays local — it's the DI seam — while the
// input/row shapes it speaks live in document-pdf.ts (mail owns the paper).
export interface StockCountPdfRenderer {
  renderStockCountSheet(input: StockCountSheetPdfInput): Promise<Buffer>;
}

export function createStockCountService(deps: {
  repo: StockCountRepository;
  pdf?: StockCountPdfRenderer;
  audit: AuditWriter;
}) {
  const { repo, audit } = deps;
  function renderer(): StockCountPdfRenderer {
    if (!deps.pdf) throw new Error("stock-count service was created without a PDF renderer");
    return deps.pdf;
  }

  const service = {
    async createSession(input: CreateStockCountInput, createdBy: string | null) {
      return repo.createSession(input, createdBy);
    },

    async listSessions(query: ListStockCountsQuery) {
      return repo.listSessions(query);
    },

    async getSession(id: string) {
      const session = await repo.getSession(id);
      if (!session) throw new StockCountNotFoundError(id);
      return session;
    },

    async addRow(sessionId: string, input: AddStockCountRowInput) {
      return repo.addRow(sessionId, input);
    },

    async updateRow(sessionId: string, rowId: string, input: UpdateStockCountRowInput) {
      return repo.updateRow(sessionId, rowId, input);
    },

    async deleteRow(sessionId: string, rowId: string) {
      return repo.deleteRow(sessionId, rowId);
    },

    async postSession(id: string, postedBy: string | null) {
      const result = await repo.postSession(id, postedBy);
      await audit.log({
        entityType: "stock_count_session",
        entityId: result.session.countNumber,
        action: "posted",
        detail: { adjustments: result.adjustments, counted: result.counted, skipped: result.skipped },
        userId: postedBy,
      });
      return result;
    },

    async cancelSession(id: string, userId: string | null = null) {
      const updated = await repo.cancelSession(id);
      await audit.log({
        entityType: "stock_count_session",
        entityId: updated.countNumber,
        action: "cancelled",
        userId,
      });
      return updated;
    },

    // Räknelistan — blind by default: booked balances print only when asked
    // for, so the counter isn't biased by the expected answer.
    async getCountSheetPdf(id: string, showBalances: boolean) {
      const session = await service.getSession(id);
      const content = await renderer().renderStockCountSheet({
        documentNumber: session.countNumber,
        printedAt: new Date(),
        warehouseName: session.warehouseName,
        locationName: session.locationName,
        blocksTransactions: session.blocksTransactions,
        note: session.note,
        showBalances,
        rows: session.rows.map((r) => ({
          articleNumber: r.articleNumber,
          articleName: r.articleName,
          unit: r.unit,
          snapshotQuantity: showBalances ? Number(r.snapshotQuantity) : null,
        })),
      });
      return { filename: `raknelista-${session.countNumber}.pdf`, content };
    },
  };
  return service;
}

export type StockCountService = ReturnType<typeof createStockCountService>;
