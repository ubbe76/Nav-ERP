import type { FastifyInstance } from "fastify";
import { errorBody } from "../../system/service/error-body.js";
import { DemoDataNotAvailableError, type DemoDataService } from "../service/demo-data.service.js";

export async function demoDataRoutes(app: FastifyInstance, opts: { service: DemoDataService }) {
  const { service } = opts;

  app.get("/demo-data", async () => service.status());

  app.post("/demo-data", async (req, reply) => {
    try {
      const created = await service.create(req.user!.id);
      return reply.code(201).send({ created });
    } catch (err) {
      if (err instanceof DemoDataNotAvailableError) {
        return reply.code(409).send({ ...errorBody(err), blockers: err.blockers });
      }
      throw err;
    }
  });
}
