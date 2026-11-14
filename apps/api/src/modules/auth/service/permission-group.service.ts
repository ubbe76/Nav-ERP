import type { CreatePermissionGroupInput, UpdatePermissionGroupInput } from "@navet/shared";
import type { PermissionGroupRepository } from "../repository/permission-group.repository.js";
import { PermissionGroupNotFoundError, PermissionGroupOwnedByPluginError } from "./auth.service.js";
import { InvalidReplacementError } from "../../register/service/register.errors.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";

export class DuplicatePermissionGroupCodeError extends Error {
  constructor(code: string) {
    super(`A permission group with code ${code} already exists`);
    this.name = "DuplicatePermissionGroupCodeError";
  }
}

export class PermissionGroupInUseError extends Error {
  constructor(readonly users: number) {
    super(`Permission group is used by ${users} user(s) — pass a replacement to move them`);
    this.name = "PermissionGroupInUseError";
  }
}

export function createPermissionGroupService(repo: PermissionGroupRepository) {
  async function existing(id: string) {
    const row = await repo.get(id);
    if (!row) throw new PermissionGroupNotFoundError(id);
    return row;
  }

  return {
    list: () => repo.list(),
    get: existing,

    async create(input: CreatePermissionGroupInput, userId: string | null = null) {
      try {
        return await repo.create(input, userId);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicatePermissionGroupCodeError(input.code);
        throw err;
      }
    },

    async update(id: string, input: UpdatePermissionGroupInput, userId: string | null = null) {
      await existing(id);
      // Tillägg: a plugin's group changes on the plugin's card (System →
      // Tillägg), where the change is logged as the plugin's.
      if (await repo.ownedByPlugin(id)) throw new PermissionGroupOwnedByPluginError();
      try {
        const row = await repo.update(id, input, userId);
        if (!row) throw new PermissionGroupNotFoundError(id);
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicatePermissionGroupCodeError(input.code ?? "");
        throw err;
      }
    },

    // Förvalda favoriter: what a member of the group starts with. A plugin's
    // group has no one to log in, so it has none (refused like an update).
    async setDefaultFavorites(id: string, favorites: { href: string; title: string }[], userId: string | null = null) {
      await existing(id);
      if (await repo.ownedByPlugin(id)) throw new PermissionGroupOwnedByPluginError();
      const row = await repo.setDefaultFavorites(id, favorites, userId);
      if (!row) throw new PermissionGroupNotFoundError(id);
      return row;
    },

    async usage(id: string) {
      await existing(id);
      return { users: await repo.liveUsers(id) };
    },

    async remove(id: string, replacementId?: string, userId: string | null = null) {
      await existing(id);
      // Tillägg: a plugin's group goes with the plugin (Avinstallera), and
      // no person is moved into one.
      if (await repo.ownedByPlugin(id)) throw new PermissionGroupOwnedByPluginError();
      if (replacementId !== undefined) {
        if (replacementId === id) throw new InvalidReplacementError("same");
        if (!(await repo.get(replacementId))) throw new InvalidReplacementError("unknown");
        if (await repo.ownedByPlugin(replacementId)) throw new PermissionGroupOwnedByPluginError();
      }
      const removed = await repo.removeWithReplacement(id, replacementId, userId);
      if (!removed) throw new PermissionGroupInUseError(await repo.liveUsers(id));
    },
  };
}

export type PermissionGroupService = ReturnType<typeof createPermissionGroupService>;
