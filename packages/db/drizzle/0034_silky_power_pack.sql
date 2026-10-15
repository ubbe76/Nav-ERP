ALTER TABLE "company_info" ADD COLUMN "bankgiro" varchar(20);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "plusgiro" varchar(20);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "bank_name" varchar(100);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "iban" varchar(40);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "bic" varchar(15);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "vat_number" varchar(30);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "company_seat" varchar(100);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "f_skatt" boolean DEFAULT false NOT NULL;