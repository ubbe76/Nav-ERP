import type { FastifyInstance } from "fastify";
import {
  createPermissionGroupSchema,
  deletePermissionGroupQuerySchema,
  updatePermissionGroupSchema,
} from "@navet/shared";
import { requireRole } from "../middleware/auth.middleware.js";
import { PermissionGroupNotFoundError, PermissionGroupOwnedByPluginError } from "../service/auth.service.js";
import {
  DuplicatePermissionGroupCodeError,
  PermissionGroupInUseError,
  type PermissionGroupService,
} from "../service/permission-group.service.js";
import { InvalidReplacementError } from "../../register/service/register.errors.js";
import { errorBody } from "../../system/service/error-body.js";

// Behörighetsgrupper (System → Behörighetsgrupper). Admin-only end to end:
// whoever edits groups can grant themselves anything.
export async function permissionGroupRoutes(app: FastifyInstance, opts: { service: PermissionGroupService }) {
  const { service } = opts;
  const admin = { preHandler: requireRole("admin") };

  app.get("/permission-groups", admin, async () => service.list());

  app.get<{ Params: { id: string } }>("/permission-groups/:id", admin, async (req, reply) => {
    try {
      return await service.get(req.params.id);
    } catch (err) {
      if (err instanceof PermissionGroupNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post("/permission-groups", admin, async (req, reply) => {
    const input = createPermissionGroupSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input));
    } catch (err) {
      if (err instanceof DuplicatePermissionGroupCodeError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/permission-groups/:id", admin, async (req, reply) => {
    const input = updatePermissionGroupSchema.parse(req.body);
    try {
      return await service.update(req.params.id, input);
    } catch (err) {
      if (err instanceof PermissionGroupNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicatePermissionGroupCodeError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/permission-groups/:id/usage", admin, async (req, reply) => {
    try {
      return await service.usage(req.params.id);
    } catch (err) {
      if (err instanceof PermissionGroupNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/permission-groups/:id", admin, async (req, reply) => {
    const { replacementId } = deletePermissionGroupQuerySchema.parse(req.query);
    try {
      await service.remove(req.params.id, replacementId);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof PermissionGroupNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof PermissionGroupInUseError) return reply.code(409).send(errorBody(err));
      if (err instanceof PermissionGroupOwnedByPluginError) return reply.code(409).send(errorBody(err));
      if (err instanceof InvalidReplacementError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });
}
