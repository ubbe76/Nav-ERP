import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { z } from "zod";
import { buildCsv, CSV_EXPORT_MAX_ROWS, type CsvColumn } from "@navet/shared";
import { contentDisposition } from "../service/content-disposition.js";

// F2: one registration helper gives any { rows, total } list endpoint a /csv
// sibling — same filters as the JSON route (the module's own query schema),
// pagination stripped, the whole (capped) result set as an Excel-friendly
// Swedish CSV attachment. Truncation fails loudly (400) instead of silently
// cutting the export.

export interface ListCsvRouteOptions<Q, T> {
  path: string; // e.g. "/articles/csv"
  preHandler?: preHandlerHookHandler | preHandlerHookHandler[];
  querySchema: z.ZodType<Q, z.ZodTypeDef, unknown>;
  // "artiklar" -> artiklar-2026-08-22.csv; a function when the name follows
  // the filter (Offerter vs Kundorder share one list endpoint).
  filenameBase: string | ((query: Q) => string);
  // A function when the columns/rows depend on who asks (e.g. cost columns
  // only for the ekonomi audience) — receives the request.
  columns: CsvColumn<T>[] | ((req: FastifyRequest) => CsvColumn<T>[]);
  fetch: (
    query: Q & { limit: number; offset: number },
    req: FastifyRequest
  ) => Promise<{ rows: T[]; total?: number }>;
}

const stockholmDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });

export function registerListCsvRoute<Q, T>(app: FastifyInstance, opts: ListCsvRouteOptions<Q, T>): void {
  app.get(
    opts.path,
    opts.preHandler ? { preHandler: opts.preHandler } : {},
    async (req, reply) => {
      // Pagination params belong to the list view — the export always covers
      // the whole (capped) filtered set from the top.
      const { limit: _limit, offset: _offset, page: _page, ...filters } = (req.query ?? {}) as Record<string, unknown>;
      const parsed = opts.querySchema.safeParse(filters);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Ogiltiga filterparametrar", details: parsed.error.issues });
      }

      const result = await opts.fetch({ ...parsed.data, limit: CSV_EXPORT_MAX_ROWS, offset: 0 }, req);
      if ((result.total ?? result.rows.length) > CSV_EXPORT_MAX_ROWS) {
        return reply
          .code(400)
          .send({ error: "Exporten överstiger 10 000 rader — avgränsa med filter" });
      }

      const base = typeof opts.filenameBase === "function" ? opts.filenameBase(parsed.data) : opts.filenameBase;
      const filename = `${base}-${stockholmDate.format(new Date())}.csv`;
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(buildCsv(typeof opts.columns === "function" ? opts.columns(req) : opts.columns, result.rows));
    }
  );
}
