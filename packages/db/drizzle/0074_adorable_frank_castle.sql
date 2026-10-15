ALTER TABLE "mo_operations" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "print_on_work_card" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD COLUMN "print_on_work_card" boolean DEFAULT false NOT NULL;