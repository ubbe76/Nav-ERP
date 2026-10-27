import type { FastifyInstance, FastifyReply } from "fastify";
import { importCommitSchema, importEntitySchema, type ImportEntity } from "@navet/shared";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { ImportFileError } from "../service/csv.js";
import { importFieldHelp } from "../service/field-help.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  ImportConflictError,
  ImportMappingError,
  ImportRegisterConflictError,
  ImportValidationError,
  type ImportService,
} from "../service/import.service.js";

// Preview and commit carry the parsed rows back as JSON, and Fastify's 1 MB
// default refused a file well inside the row cap: 10 000 rows of Monitor's
// Operationslista are ~2.3 MB, the widest exports (Kundlista, Övrigt: 35
// columns) about three times that. The limit leaves room for those.
const IMPORT_ROWS_BODY_LIMIT = 16 * 1024 * 1024;

// CSV import (Monitor G5). All three endpoints are admin-only — imports can
// create register rows and overwrite article data in bulk.
export async function importRoutes(app: FastifyInstance, opts: { service: ImportService }) {
  const { service } = opts;

  // Unknown entity -> 404 (the enum is widened by the customer/supplier
  // importers later; a typo'd entity is a missing resource, not bad input).
  function parseEntity(raw: string, reply: FastifyReply): ImportEntity | null {
    const parsed = importEntitySchema.safeParse(raw);
    if (!parsed.success) {
      void reply.code(404).send({ error: `Okänd importtyp: ${raw}` });
      return null;
    }
    return parsed.data;
  }

  // Field help for the mapping step: the wizard's fields with the template's
  // column heading, the explanation and an example (field-help.ts — the same
  // source the Excel templates and the manual chapter Importmallar are
  // generated from). Admin like the rest, since the wizard is.
  app.get<{ Params: { entity: string } }>(
    "/imports/:entity/fields",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const entity = parseEntity(req.params.entity, reply);
      if (!entity) return reply;
      return importFieldHelp(entity);
    }
  );

  // Entity-less parse for the multi-file import: recognises the entity from
  // the header row (detect.ts). Same upload rules as /:entity/parse.
  app.post("/imports/detect", { preHandler: requireRole("admin") }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "Ingen fil bifogad" });
    const data = await file.toBuffer();
    if (file.file.truncated) {
      return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
    }
    try {
      return await service.detect(data);
    } catch (err) {
      if (err instanceof ImportFileError) {
        return reply.code(400).send(errorBody(err));
      }
      throw err;
    }
  });

  app.post<{ Params: { entity: string } }>(
    "/imports/:entity/parse",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const entity = parseEntity(req.params.entity, reply);
      if (!entity) return reply;
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "Ingen fil bifogad" });
      const data = await file.toBuffer();
      // fastify-multipart truncates instead of throwing once the 20 MB app
      // limit is hit — a truncated CSV must never be half-imported.
      if (file.file.truncated) {
        return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
      }
      try {
        return await service.parse(entity, data);
      } catch (err) {
        // Row limit, empty file, unreadable workbook, legacy .xls — the
        // whole ImportFileError family is a 400 about the uploaded file.
        if (err instanceof ImportFileError) {
          return reply.code(400).send(errorBody(err));
        }
        throw err;
      }
    }
  );

  app.post<{ Params: { entity: string } }>(
    "/imports/:entity/preview",
    { preHandler: requireRole("admin"), bodyLimit: IMPORT_ROWS_BODY_LIMIT },
    async (req, reply) => {
      const entity = parseEntity(req.params.entity, reply);
      if (!entity) return reply;
      const input = importCommitSchema.parse(req.body);
      try {
        return await service.preview(entity, input);
      } catch (err) {
        if (err instanceof ImportMappingError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  app.post<{ Params: { entity: string } }>(
    "/imports/:entity/commit",
    { preHandler: requireRole("admin"), bodyLimit: IMPORT_ROWS_BODY_LIMIT },
    async (req, reply) => {
      const entity = parseEntity(req.params.entity, reply);
      if (!entity) return reply;
      const input = importCommitSchema.parse(req.body);
      try {
        return await service.commit(entity, input);
      } catch (err) {
        if (err instanceof ImportValidationError) {
          // The preview-shaped payload rides along so the client can show
          // exactly which rows blocked the import.
          return reply.code(400).send({ ...errorBody(err), ...err.payload });
        }
        if (err instanceof ImportMappingError) return reply.code(400).send(errorBody(err));
        if (err instanceof ImportConflictError) return reply.code(409).send(errorBody(err));
        if (err instanceof ImportRegisterConflictError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );
}
