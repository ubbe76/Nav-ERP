import type { FastifyInstance } from "fastify";
import { importEntitySchema, importExportQuerySchema } from "@navet/shared";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import type { ImportExportService } from "../service/import-export.service.js";

// The register as an import file (#35): the template's columns with the
// stored values, written so that importing the file changes nothing
// (service/import-export.ts). ?format=csv|xlsx (Excel by default), and for
// the article-bound entities the article selection (copied,
// articleNumberFrom/To, groupId, type, activeOnly); the partner and resource
// entities read activeOnly only. More rows than the import takes in one file
// come as a .zip of import files. Admin-only like the import itself.
export async function importExportRoutes(app: FastifyInstance, opts: { service: ImportExportService }) {
  app.get<{ Params: { entity: string } }>(
    "/imports/:entity/export",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      // An unknown entity is a missing resource, as in the import routes.
      const entity = importEntitySchema.safeParse(req.params.entity);
      if (!entity.success) return reply.code(404).send({ error: `Okänd importtyp: ${req.params.entity}` });
      const query = importExportQuerySchema.parse(req.query);
      const file = await opts.service.exportFile(entity.data, query, req.user?.id);
      reply.header("Content-Type", file.contentType);
      reply.header("Content-Disposition", contentDisposition(file.filename));
      return reply.send(file.content);
    }
  );
}
