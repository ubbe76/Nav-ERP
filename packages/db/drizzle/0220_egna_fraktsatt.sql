-- Egna fraktsätt: en försändelse kan ha ett eget fraktsätt (provider
-- 'manual') i stället för att bokas via Sendify — Egen bil, Kunden hämtar
-- eller ett eget avtal med en transportör. Den registreras direkt som skickad
-- med en speditör ur registret (carrier_id), har inget upphämtningsfönster och
-- är aldrig ett utkast. Befintliga försändelser blir 'sendify'.
ALTER TABLE "shipments" ALTER COLUMN "pickup_from" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "pickup_to" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "provider" varchar(20) DEFAULT 'sendify' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "carrier_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_shipments_carrier" ON "shipments" USING btree ("carrier_id");--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_provider_known" CHECK ("shipments"."provider" IN ('sendify', 'manual'));--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_manual_carrier" CHECK ("shipments"."provider" <> 'manual' OR "shipments"."carrier_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_pickup_window" CHECK ("shipments"."provider" = 'manual' OR ("shipments"."pickup_from" IS NOT NULL AND "shipments"."pickup_to" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_manual_not_draft" CHECK ("shipments"."provider" <> 'manual' OR "shipments"."status" <> 'draft');