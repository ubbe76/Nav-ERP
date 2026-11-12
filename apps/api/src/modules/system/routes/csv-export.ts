import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions, preHandlerHookHandler } from "fastify";
import type { z } from "zod";
import { CSV_EXPORT_MAX_ROWS, exportTable, type CsvColumn } from "@navet/shared";
import { contentDisposition } from "../service/content-disposition.js";
import {
  EXPORT_FORMATS,
  renderExport,
  xlsxTwinPath,
  type ExportFormat,
  type NamedTable,
  type RenderedExport,
} from "../service/table-export.js";

// F2: one registration helper gives any { rows, total } list endpoint a /csv
// sibling — same filters as the JSON route (the module's own query schema),
// pagination stripped, the whole (capped) result set as an Excel-friendly
// Swedish CSV attachment. Truncation fails loudly (400) instead of silently
// cutting the export.
//
// #35: every such route gets an Excel twin — "/articles/csv" also registers
// "/articles/xlsx" — through the SAME handler: same query schema, same
// fetch, same cap and same columns, only the rendering differs
// (table-export.ts). Registered the same way, the twin inherits the CSV
// route's access rule (the module's read rule, or the preHandler).

export interface ListCsvRouteOptions<Q, T> {
  path: string; // e.g. "/articles/csv" — must end in /csv (the twin is …/xlsx)
  preHandler?: preHandlerHookHandler | preHandlerHookHandler[];
  querySchema: z.ZodType<Q, z.ZodTypeDef, unknown>;
  // "artiklar" -> artiklar-2026-08-22.csv; a function when the name follows
  // the filter (Offerter vs Kundorder share one list endpoint).
  filenameBase: string | ((query: Q) => string);
  // A function when the columns/rows depend on who asks (e.g. cost columns
  // only for the ekonomi audience) or on the filter (a balance column only
  // with an article filter) — receives the request and the PARSED query.
  columns: CsvColumn<T>[] | ((req: FastifyRequest, query: Q) => CsvColumn<T>[]);
  fetch: (
    query: Q & { limit: number; offset: number },
    req: FastifyRequest
  ) => Promise<{ rows: T[]; total?: number }>;
}

const stockholmDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });

// Sends a rendered export (table-export.ts' renderExport) as an attachment —
// the one place the bespoke report routes and the list routes set the
// headers.
export function sendExport(reply: FastifyReply, rendered: RenderedExport) {
  reply.header("Content-Type", rendered.contentType);
  reply.header("Content-Disposition", contentDisposition(rendered.filename));
  return reply.send(rendered.content);
}

export function registerListCsvRoute<Q, T>(app: FastifyInstance, opts: ListCsvRouteOptions<Q, T>): void {
  const register = (path: string, format: ExportFormat) =>
    app.get(
      path,
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
        const columns = typeof opts.columns === "function" ? opts.columns(req, parsed.data) : opts.columns;
        return sendExport(
          reply,
          renderExport(exportTable(columns, result.rows), `${base}-${stockholmDate.format(new Date())}`, format)
        );
      }
    );

  register(opts.path, "csv");
  register(xlsxTwinPath(opts.path), "xlsx");
}

// A report's own export (the reports, the financial reports, budget,
// avskrivningsplan, löneunderlag): `produce` builds the table ONCE and the
// two routes — `csvPath` and its …/xlsx twin, with the same route options —
// only differ in the rendering. Anything else `produce` returns — the reply
// it has already answered through (a 400/404 from the report's own error
// mapping) — is passed on untouched.
function isNamedTable(value: unknown): value is NamedTable {
  return typeof value === "object" && value !== null && "basename" in value && "table" in value;
}

export function registerTableExportRoutes(
  app: FastifyInstance,
  csvPath: string,
  options: RouteShorthandOptions,
  produce: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
): void {
  for (const format of EXPORT_FORMATS) {
    app.get(format === "csv" ? csvPath : xlsxTwinPath(csvPath), options, async (req, reply) => {
      const result = await produce(req, reply);
      if (!isNamedTable(result)) return result;
      return sendExport(reply, renderExport(result.table, result.basename, format));
    });
  }
}
