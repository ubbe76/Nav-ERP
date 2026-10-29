import type { FastifyInstance } from "fastify";
import { scanQuerySchema } from "@navet/shared";
import type { ScanService } from "../service/scan.service.js";

// Skanning (#4): GET /scan?code= answers what a scanned code is. Read only,
// office like the registers it reads; no match is an empty list, not a 404.
export async function scanRoutes(app: FastifyInstance, opts: { service: ScanService }) {
  app.get("/scan", async (req) => {
    const { code } = scanQuerySchema.parse(req.query);
    return opts.service.resolve(code);
  });
}
