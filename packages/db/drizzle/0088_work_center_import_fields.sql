ALTER TABLE "work_centers" ADD COLUMN "default_setup_time" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "default_operation_name" varchar(100);--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "rate_applies_to_setup" boolean;--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "rate_applies_to_run" boolean;--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "calc_rate_1" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "lead_time_days" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "queue_time_days" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "order_lead_time_days" numeric(6, 1);