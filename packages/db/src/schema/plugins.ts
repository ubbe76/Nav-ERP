import { index, integer, jsonb, pgEnum, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { permissionGroups, users } from "./auth";

// Tillägg (migration 0141): external programs an administrator installs under
// System → Tillägg. A plugin talks to Nav through the ordinary API with its
// own API key — the key belongs to a technical user (users.kind = 'plugin')
// with its own permission group — and receives thin webhook events through
// the outbox below. Nothing here is räkenskapsinformation.
export const pluginStatusEnum = pgEnum("plugin_status", ["active", "paused"]);
export const pluginDeliveryStatusEnum = pgEnum("plugin_delivery_status", ["pending", "delivered", "failed"]);

export const plugins = pgTable("plugins", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The manifest's key, unique among the installed plugins.
  key: varchar("key", { length: 40 }).notNull().unique(),
  name: varchar("name", { length: 60 }).notNull(),
  // Where the plugin runs (http/https, no trailing slash); every manifest
  // path is appended to it.
  baseUrl: varchar("base_url", { length: 255 }).notNull(),
  // The validated manifest (validatePluginManifest's output).
  manifest: jsonb("manifest").notNull(),
  // The technical user and its group. Never deleted while the plugin exists;
  // the user outlives the plugin (deactivated at uninstall — audit and
  // created_by rows point at it).
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  permissionGroupId: uuid("permission_group_id")
    .notNull()
    .references(() => permissionGroups.id, { onDelete: "restrict" }),
  // sha256 (hex) of the API key; the key itself is shown once and never stored.
  apiKeyHash: varchar("api_key_hash", { length: 64 }).notNull().unique(),
  // The key's first characters, for display.
  apiKeyPrefix: varchar("api_key_prefix", { length: 12 }).notNull(),
  // Kept in clear text: Nav signs every webhook and context token with it
  // (like the SMTP password). Write-only in the API.
  webhookSecret: varchar("webhook_secret", { length: 64 }).notNull(),
  status: pluginStatusEnum("status").notNull().default("active"),
  installedBy: uuid("installed_by").references(() => users.id, { onDelete: "set null" }),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The outbox: one row per event that at least one plugin subscribed to when
// it happened. Append-only; delivered events older than 30 days are cleaned
// up by the dispatcher.
export const pluginEvents = pgTable(
  "plugin_events",
  {
    // Sent as the event id (Nav-Event-Id).
    id: uuid("id").primaryKey().defaultRandom(),
    type: varchar("type", { length: 60 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    entityNumber: varchar("entity_number", { length: 60 }),
    // References only (e.g. deliveryId) — never amounts or personal data.
    data: jsonb("data").$type<Record<string, string | null>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("plugin_events_occurred_idx").on(table.occurredAt)]
);

// One delivery per (plugin, event). The dispatcher claims rows with a
// conditional UPDATE (claimed_until) and never holds a transaction over HTTP.
export const pluginDeliveries = pgTable(
  "plugin_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => pluginEvents.id, { onDelete: "cascade" }),
    status: pluginDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastStatusCode: integer("last_status_code"),
    // Short, never the response body.
    lastError: varchar("last_error", { length: 200 }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("plugin_deliveries_plugin_event_unique").on(table.pluginId, table.eventId),
    index("plugin_deliveries_status_next_idx").on(table.status, table.nextAttemptAt),
    index("plugin_deliveries_plugin_created_idx").on(table.pluginId, table.createdAt),
    index("plugin_deliveries_event_idx").on(table.eventId),
  ]
);
