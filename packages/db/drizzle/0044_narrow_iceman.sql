ALTER TABLE "cost_calculations" ADD COLUMN "material_overhead" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "subcontract_cost" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "subcontract_overhead" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "business_overhead" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "general_markup" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "sales_price" numeric(14, 4) DEFAULT '0' NOT NULL;