-- Tillägg (plugin system): installed plugins with their technical user
-- (users.kind = plugin, never admin) and permission group, the API key as
-- sha256, and the webhook outbox (plugin_events + plugin_deliveries).
-- No backfill: every existing user is a person.
CREATE TYPE "public"."user_kind" AS ENUM('person', 'plugin');--> statement-breakpoint
CREATE TYPE "public"."plugin_delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."plugin_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TABLE "plugin_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "plugin_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"claimed_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" varchar(200),
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_deliveries_plugin_event_unique" UNIQUE("plugin_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(60) NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_number" varchar(60),
	"data" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(40) NOT NULL,
	"name" varchar(60) NOT NULL,
	"base_url" varchar(255) NOT NULL,
	"manifest" jsonb NOT NULL,
	"user_id" uuid NOT NULL,
	"permission_group_id" uuid NOT NULL,
	"api_key_hash" varchar(64) NOT NULL,
	"api_key_prefix" varchar(12) NOT NULL,
	"webhook_secret" varchar(64) NOT NULL,
	"status" "plugin_status" DEFAULT 'active' NOT NULL,
	"installed_by" uuid,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugins_key_unique" UNIQUE("key"),
	CONSTRAINT "plugins_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" "user_kind" DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_deliveries" ADD CONSTRAINT "plugin_deliveries_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_deliveries" ADD CONSTRAINT "plugin_deliveries_event_id_plugin_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."plugin_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_permission_group_id_permission_groups_id_fk" FOREIGN KEY ("permission_group_id") REFERENCES "public"."permission_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_deliveries_status_next_idx" ON "plugin_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "plugin_deliveries_plugin_created_idx" ON "plugin_deliveries" USING btree ("plugin_id","created_at");--> statement-breakpoint
CREATE INDEX "plugin_deliveries_event_idx" ON "plugin_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "plugin_events_occurred_idx" ON "plugin_events" USING btree ("occurred_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plugin_not_admin" CHECK ("users"."kind" = 'person' or "users"."role" <> 'admin');