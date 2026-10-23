import { sql } from "drizzle-orm";
import { boolean, check, index, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

// Roles: admin (everything, incl. System), supervisor (attest powers),
// user. What a non-admin may open is decided by their permission group.
export const userRoleEnum = pgEnum("user_role", ["admin", "supervisor", "user"]);

// Tillägg (0141): person = a human account; plugin = the technical user of an
// installed plugin (System → Tillägg), which authenticates with the plugin's
// API key only and is never an administrator.
export const userKindEnum = pgEnum("user_kind", ["person", "plugin"]);

// Behörighetsgrupper: a user belongs to one group, whose permission list
// (codes from @navet/shared's catalog, validated in the API layer — no DB
// CHECK, so adding a permission needs no schema change) decides which main
// menus they can write in and whether they get the workshop profile.
export const permissionGroups = pgTable("permission_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Mjuk radering: raden behålls (attribution via created_by/locked_by/attested_by
// m.fl. på ~30 tabeller ska inte nollas), men kontot försvinner ur listan/login
// och e-postadressen frigörs — därav partiellt unikt index i stället för .unique().
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    role: userRoleEnum("role").notNull().default("user"),
    permissionGroupId: uuid("permission_group_id").references(() => permissionGroups.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
    // Endast läsning: the account may open everything its permission group
    // gives but change nothing — the API refuses every write for it (see
    // requireAuth / readOnlyGuard). For demo logins and auditors. Never on an
    // admin: System's own reads (users with e-mails, API clients) would stay
    // open, so the combination is refused in the service and here.
    readOnly: boolean("read_only").notNull().default(false),
    kind: userKindEnum("kind").notNull().default("person"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email).where(sql`${table.deletedAt} is null`),
    index("users_permission_group_idx").on(table.permissionGroupId),
    check("users_read_only_not_admin", sql`not (${table.readOnly} and ${table.role} = 'admin')`),
    check("users_plugin_not_admin", sql`${table.kind} = 'person' or ${table.role} <> 'admin'`),
  ]
);

// Per-user KV preferences (Monitor-style personal settings, distinct from the
// system-wide system_settings table) — first key is list_page_size (see
// @navet/shared's user-settings.ts). Composite PK: one row per user per key.
export const userSettings = pgTable(
  "user_settings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 50 }).notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })]
);
