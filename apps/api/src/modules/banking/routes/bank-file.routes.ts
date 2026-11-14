import type { FastifyInstance } from "fastify";
import { bookIncomingEntriesSchema, bookOutgoingEntriesSchema, ignoreBankEntrySchema, listBankFilesQuerySchema } from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  BankEntryAlreadyBookedError,
  BankEntryDirectionError,
  BankEntryNotFoundError,
  BankFileNotFoundError,
  BankFileParseError,
  UnsupportedBankMessageError,
} from "../service/banking.errors.js";
import type { BankFileService } from "../service/bank-file.service.js";

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };
function fileError(err: unknown, reply: Reply) {
  if (err instanceof BankFileNotFoundError || err instanceof BankEntryNotFoundError) return reply.code(404).send(errorBody(err));
  if (err instanceof BankFileParseError || err instanceof UnsupportedBankMessageError) return reply.code(400).send(errorBody(err));
  if (err instanceof BankEntryAlreadyBookedError || err instanceof BankEntryDirectionError) return reply.code(409).send(errorBody(err));
  throw err;
}

// registerModule({ read: ["inkop", "forsaljning", "ekonomi"], write: ["inkop",
// "forsaljning"] }) in app.ts. Booking follows the direction: incoming =
// Försäljning, outgoing = Inköp (config.access overrides, and every route
// also carries requirePermission for the mini-app tests).
export async function bankFileRoutes(app: FastifyInstance, opts: { service: BankFileService }) {
  const { service } = opts;
  const read = { preHandler: requirePermission("inkop", "forsaljning", "ekonomi") };
  const upload = { preHandler: requirePermission("inkop", "forsaljning") };
  const incoming = { config: { access: ["forsaljning"] as const }, preHandler: requirePermission("forsaljning") };
  const outgoing = { config: { access: ["inkop"] as const }, preHandler: requirePermission("inkop") };

  app.post("/bank-files", upload, async (req, reply) => {
    let file;
    try {
      file = await req.file();
    } catch {
      file = undefined;
    }
    if (!file) return reply.code(400).send(errorBody(new BankFileParseError("Ingen fil bifogad")));
    // Over the 20 MB limit multipart either throws (FST_REQ_FILE_TOO_LARGE)
    // or truncates — both are the same 400, and a half-read bank file is
    // never stored. (Before, the throw reached the global handler as 413.)
    const tooLarge = () => reply.code(400).send(errorBody(new BankFileParseError("Filen är större än 20 MB")));
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "FST_REQ_FILE_TOO_LARGE") return tooLarge();
      throw err;
    }
    if (file.file.truncated) return tooLarge();
    try {
      const result = await service.upload({ filename: file.filename, contentType: file.mimetype, data }, req.user!.id);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (err) {
      return fileError(err, reply);
    }
  });

  app.get("/bank-files", read, async (req) => service.list(listBankFilesQuerySchema.parse(req.query)));

  app.get<{ Params: { id: string } }>("/bank-files/:id", read, async (req, reply) => {
    try {
      return await service.get(req.params.id);
    } catch (err) {
      return fileError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/bank-files/:id/download", read, async (req, reply) => {
    try {
      const file = await service.download(req.params.id);
      return reply.header("content-type", file.contentType).header("content-disposition", contentDisposition(file.filename)).send(file.data);
    } catch (err) {
      return fileError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/bank-files/:id/incoming", read, async (req, reply) => {
    try {
      return await service.incomingView(req.params.id);
    } catch (err) {
      return fileError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/bank-files/:id/incoming/book", incoming, async (req, reply) => {
    const input = bookIncomingEntriesSchema.parse(req.body);
    try {
      return await service.bookIncoming(req.params.id, input, req.user!.id);
    } catch (err) {
      return fileError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/bank-files/:id/outgoing", read, async (req, reply) => {
    try {
      return await service.outgoingView(req.params.id);
    } catch (err) {
      return fileError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/bank-files/:id/outgoing/book", outgoing, async (req, reply) => {
    const input = bookOutgoingEntriesSchema.parse(req.body);
    try {
      return await service.bookOutgoing(req.params.id, input, req.user!.id);
    } catch (err) {
      return fileError(err, reply);
    }
  });

  for (const [direction, guard] of [
    ["incoming", incoming],
    ["outgoing", outgoing],
  ] as const) {
    app.post<{ Params: { id: string; entryId: string } }>(`/bank-files/:id/${direction}/entries/:entryId/ignore`, guard, async (req, reply) => {
      const input = ignoreBankEntrySchema.parse(req.body);
      try {
        await service.ignore(req.params.id, direction, req.params.entryId, input, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        return fileError(err, reply);
      }
    });
    app.delete<{ Params: { id: string; entryId: string } }>(`/bank-files/:id/${direction}/entries/:entryId/ignore`, guard, async (req, reply) => {
      try {
        await service.restore(req.params.id, direction, req.params.entryId, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        return fileError(err, reply);
      }
    });
  }
}
