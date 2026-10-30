import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { CreateUserInput, LoginInput, RegisterInput, UpdateUserInput, UserKind, UserRole } from "@navet/shared";
import { effectivePermissions, type Permission } from "@navet/shared";
import type { AuthRepository } from "../repository/auth.repository.js";
// G1: append-only audit trail. entityId is the affected user's email rather
// than their uuid — it stays readable across a soft delete (softDelete never
// rewrites the email column, only deletedAt/active) and after a self-rename.
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { SetupCode } from "./setup-code.js";
import { BCRYPT_ROUNDS } from "./bcrypt-rounds.js";

const JWT_EXPIRES_IN = "8h";

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`A user with email ${email} already exists`);
    this.name = "DuplicateEmailError";
  }
}

export class RegistrationClosedError extends Error {
  constructor() {
    super("Self-registration is only available to create the first (admin) user");
    this.name = "RegistrationClosedError";
  }
}

// The bootstrap registration needs the one-time setup code from the api's
// log (or SETUP_CODE) — see setup-code.ts.
export class InvalidSetupCodeError extends Error {
  constructor() {
    super("Wrong or missing setup code — it is printed in the api log at start (docker compose logs api)");
    this.name = "InvalidSetupCodeError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}

export class UserNotFoundError extends Error {
  constructor(id: string) {
    super(`No user with id ${id}`);
    this.name = "UserNotFoundError";
  }
}

// Locking every admin out of user administration would be unrecoverable from
// the UI, so the last active admin can't be demoted or deactivated.
export class LastAdminError extends Error {
  constructor() {
    super("Cannot demote or deactivate the last active admin");
    this.name = "LastAdminError";
  }
}

// A user can't delete their own account (would end the session mid-request
// with no way back in without another admin).
export class SelfDeleteError extends Error {
  constructor() {
    super("Cannot delete your own account");
    this.name = "SelfDeleteError";
  }
}

export class PermissionGroupNotFoundError extends Error {
  constructor(id: string) {
    super(`No permission group with id ${id}`);
    this.name = "PermissionGroupNotFoundError";
  }
}

// Endast läsning on an administrator would leave System's own reads (the user
// list with e-mails, API clients) open to a shared demo login, so the
// combination is refused — a read-only account is a normal user with a
// permission group. The users table has the same CHECK as a backstop.
export class ReadOnlyAdminError extends Error {
  constructor() {
    super("A read-only account cannot be an administrator");
    this.name = "ReadOnlyAdminError";
  }
}

// Tillägg: a plugin's technical user is managed under System → Tillägg —
// never edited or deleted through the user register.
export class PluginUserManagedError extends Error {
  constructor() {
    super("Tilläggets användare hanteras under System → Tillägg.");
    this.name = "PluginUserManagedError";
  }
}

// Tillägg: a plugin's permission group belongs to that plugin alone — no
// person is placed in it, and it goes only with the plugin.
export class PermissionGroupOwnedByPluginError extends Error {
  constructor() {
    super("Behörighetsgruppen hör till ett tillägg och ändras under System → Tillägg.");
    this.name = "PermissionGroupOwnedByPluginError";
  }
}

export interface AuthTokenPayload {
  sub: string;
  role: UserRole;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  // Effective permissions — admin gets the whole catalog, implications are
  // already expanded. The web only ever reads this list.
  permissions: Permission[];
  // Endast läsning: every write is refused (requireAuth's readOnlyGuard).
  readOnly: boolean;
  // Tillägg: "plugin" = an installed plugin's technical user, authenticated
  // by the plugin's API key (never a session).
  kind: UserKind;
}

// The plugin behind an API-key request (req.plugin).
export interface RequestPlugin {
  id: string;
  key: string;
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  readOnly: boolean;
  kind: UserKind;
  groupPermissions: string[] | null;
};

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions: effectivePermissions(row.role, row.groupPermissions),
    readOnly: row.readOnly,
    kind: row.kind,
  };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The user-administration view also exposes account status — unlike
// PublicUser, which describes the (always active) session user. deletedAt is
// null for every row the default (includeDeleted: false) list returns —
// it's only ever non-null when a caller opted into seeing soft-deleted
// accounts too (e.g. resolving a verifikat's "bokfört av <namn>").
export interface AdminUserView extends PublicUser {
  active: boolean;
  createdAt: Date;
  deletedAt: Date | null;
  permissionGroupId: string | null;
  permissionGroupName: string | null;
}

function toAdminUserView(
  row: UserRow & {
    active: boolean;
    createdAt: Date;
    deletedAt: Date | null;
    permissionGroupId: string | null;
    permissionGroupName: string | null;
  }
): AdminUserView {
  return {
    ...toPublicUser(row),
    active: row.active,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    permissionGroupId: row.permissionGroupId ?? null,
    permissionGroupName: row.permissionGroupName ?? null,
  };
}

// `setupCode` guards the bootstrap registration; buildApp always passes one.
// Omitted (service-level tests), registration needs no code.
export function createAuthService(
  repo: AuthRepository,
  jwtSecret: string,
  audit: AuditWriter,
  setupCode: SetupCode | null = null
) {
  async function issueToken(payload: AuthTokenPayload) {
    return jwt.sign(payload, jwtSecret, { expiresIn: JWT_EXPIRES_IN });
  }

  return {
    // Bootstrap: only works while the users table is empty. Always creates an admin.
    async register(input: RegisterInput) {
      if ((await repo.count()) > 0) {
        throw new RegistrationClosedError();
      }
      if (setupCode && !setupCode.matches(input.setupCode)) {
        throw new InvalidSetupCodeError();
      }
      if (await repo.findByEmail(input.email)) {
        throw new DuplicateEmailError(input.email);
      }
      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
      const created = await repo.create({
        email: input.email,
        passwordHash,
        name: input.name,
        role: "admin",
      });
      // create returns the bare row; re-read through the group join.
      const user = (await repo.findById(created.id))!;
      const token = await issueToken({ sub: user.id, role: user.role });
      return { user: toPublicUser(user), token };
    },

    // True while the bootstrap registration is still open (no users at all).
    async needsSetup() {
      return (await repo.count()) === 0;
    },

    // Admin-only: creates additional users with any role.
    async createUser(input: CreateUserInput, actingUserId: string | null = null) {
      if (await repo.findByEmail(input.email)) {
        throw new DuplicateEmailError(input.email);
      }
      if (input.permissionGroupId && !(await repo.groupExists(input.permissionGroupId))) {
        throw new PermissionGroupNotFoundError(input.permissionGroupId);
      }
      if (input.permissionGroupId && (await repo.groupOwnedByPlugin(input.permissionGroupId))) {
        throw new PermissionGroupOwnedByPluginError();
      }
      const readOnly = input.readOnly ?? false;
      if (readOnly && input.role === "admin") throw new ReadOnlyAdminError();
      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
      const created = await repo.create({
        email: input.email,
        passwordHash,
        name: input.name,
        role: input.role,
        permissionGroupId: input.permissionGroupId ?? null,
        readOnly,
      });
      // create returns the bare row; re-read through the group join.
      const user = (await repo.findById(created.id))!;
      await audit.log({
        entityType: "user",
        entityId: user.email,
        action: "created",
        detail: { name: user.name, role: user.role, permissionGroupId: user.permissionGroupId, readOnly: user.readOnly },
        userId: actingUserId,
      });
      return toPublicUser(user);
    },

    // includeDeleted: the user-admin register always calls this with the
    // default false; cross-module callers that need to resolve a
    // soft-deleted account's name (e.g. verifikat's "bokfört av") pass true.
    async listUsers(includeDeleted = false): Promise<AdminUserView[]> {
      return (await repo.list(includeDeleted)).map(toAdminUserView);
    },

    // Admin-only: partial update; guards the last active admin from being
    // demoted or deactivated (would lock everyone out of user administration),
    // and refuses a soft-deleted account outright — otherwise a still-valid
    // pre-deletion JWT could PATCH itself back to active and log back in
    // while invisible in the (filtered) user list.
    async updateUser(id: string, input: UpdateUserInput, actingUserId: string | null = null): Promise<AdminUserView> {
      const existing = await repo.findById(id);
      if (!existing || existing.deletedAt) throw new UserNotFoundError(id);
      if (existing.kind === "plugin") throw new PluginUserManagedError();

      if (input.email && input.email !== existing.email && (await repo.findByEmail(input.email))) {
        throw new DuplicateEmailError(input.email);
      }

      const losesAdmin =
        existing.role === "admin" &&
        existing.active &&
        ((input.role !== undefined && input.role !== "admin") || input.active === false);
      if (losesAdmin && (await repo.countActiveAdmins()) <= 1) {
        throw new LastAdminError();
      }

      if (input.permissionGroupId && !(await repo.groupExists(input.permissionGroupId))) {
        throw new PermissionGroupNotFoundError(input.permissionGroupId);
      }
      if (input.permissionGroupId && (await repo.groupOwnedByPlugin(input.permissionGroupId))) {
        throw new PermissionGroupOwnedByPluginError();
      }

      // Judged on the resulting account: making a read-only user admin is as
      // refused as making an admin read-only.
      if ((input.readOnly ?? existing.readOnly) && (input.role ?? existing.role) === "admin") {
        throw new ReadOnlyAdminError();
      }

      const fields: Parameters<typeof repo.update>[1] = {};
      if (input.email !== undefined) fields.email = input.email;
      if (input.name !== undefined) fields.name = input.name;
      if (input.role !== undefined) fields.role = input.role;
      if (input.active !== undefined) fields.active = input.active;
      if (input.permissionGroupId !== undefined) fields.permissionGroupId = input.permissionGroupId;
      if (input.readOnly !== undefined) fields.readOnly = input.readOnly;
      if (input.password !== undefined) fields.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

      if (!(await repo.update(id, fields))) throw new UserNotFoundError(id);
      // update returns the bare row; re-read through the group join.
      const updated = await repo.findById(id);
      if (!updated) throw new UserNotFoundError(id);

      // detail: changed field NAMES only (never the old/new email or name —
      // not secrets, but not meaningful either); role/active get a before/
      // after since they're the security-relevant ones; a password reset
      // never carries a value, just the fact that it happened.
      const changedFields: string[] = [];
      const detail: Record<string, unknown> = {};
      if (input.email !== undefined && input.email !== existing.email) changedFields.push("email");
      if (input.name !== undefined && input.name !== existing.name) changedFields.push("name");
      if (input.role !== undefined && input.role !== existing.role) {
        changedFields.push("role");
        detail.role = { before: existing.role, after: input.role };
      }
      if (input.permissionGroupId !== undefined && input.permissionGroupId !== existing.permissionGroupId) {
        changedFields.push("permissionGroup");
        detail.permissionGroup = { before: existing.permissionGroupId, after: input.permissionGroupId };
      }
      if (input.active !== undefined && input.active !== existing.active) {
        changedFields.push("active");
        detail.active = { before: existing.active, after: input.active };
      }
      if (input.readOnly !== undefined && input.readOnly !== existing.readOnly) {
        changedFields.push("readOnly");
        detail.readOnly = { before: existing.readOnly, after: input.readOnly };
      }
      if (input.password !== undefined) {
        changedFields.push("password");
        detail.password_changed = true;
      }
      if (changedFields.length > 0) {
        await audit.log({
          entityType: "user",
          entityId: updated.email,
          action: "updated",
          detail: { changedFields, ...detail },
          userId: actingUserId,
        });
      }
      return toAdminUserView(updated);
    },

    // Admin-only: soft delete — the row (and its attribution on other
    // tables' created_by/locked_by/attested_by FKs) stays, but the account
    // disappears from the list/login and its email is freed up. Reuses the
    // last-admin guard from updateUser: deleting the last active admin would
    // be exactly as unrecoverable as demoting/deactivating them.
    async deleteUser(id: string, actingUserId: string): Promise<void> {
      const existing = await repo.findById(id);
      if (!existing || existing.deletedAt) throw new UserNotFoundError(id);
      if (existing.kind === "plugin") throw new PluginUserManagedError();

      if (id === actingUserId) throw new SelfDeleteError();

      if (existing.role === "admin" && existing.active && (await repo.countActiveAdmins()) <= 1) {
        throw new LastAdminError();
      }

      const deleted = await repo.softDelete(id);
      if (!deleted) throw new UserNotFoundError(id);

      await audit.log({
        entityType: "user",
        entityId: deleted.email,
        action: "deleted",
        userId: actingUserId,
      });
    },

    async login(input: LoginInput) {
      const user = await repo.findByEmail(input.email);
      // A plugin's technical user has no usable password and never logs in.
      if (!user || !user.active || user.kind !== "person") throw new InvalidCredentialsError();

      const valid = await bcrypt.compare(input.password, user.passwordHash);
      if (!valid) throw new InvalidCredentialsError();

      const token = await issueToken({ sub: user.id, role: user.role });
      return { user: toPublicUser(user), token };
    },

    async verifyToken(token: string): Promise<PublicUser | null> {
      let payload: AuthTokenPayload;
      try {
        payload = jwt.verify(token, jwtSecret) as AuthTokenPayload;
      } catch {
        return null;
      }
      const user = await repo.findById(payload.sub);
      if (!user || !user.active || user.kind !== "person") return null;
      return toPublicUser(user);
    },

    // Tillägg: Authorization: Bearer nav_plg_… — the key's sha256 is looked
    // up; the plugin must be active and its technical user active. null for
    // anything else (unknown, rotated, paused, uninstalled).
    async verifyPluginKey(key: string): Promise<{ user: PublicUser; plugin: RequestPlugin } | null> {
      const found = await repo.findByPluginKeyHash(sha256Hex(key));
      if (!found || found.pluginStatus !== "active") return null;
      if (!found.active || found.deletedAt || found.kind !== "plugin") return null;
      return { user: toPublicUser(found), plugin: { id: found.pluginId, key: found.pluginKey } };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
