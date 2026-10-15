ALTER TABLE "carriers" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "delivery_terms" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "package_types" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "payment_terms" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "description" text;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Köparen hämtar godset hos säljaren och står för hela transporten, exportklareringen och alla kostnader och risker.' WHERE "code" = 'EXW' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Säljaren lämnar godset exportklarerat till köparens fraktförare på angiven plats; därefter tar köparen över risk och kostnad.' WHERE "code" = 'FCA' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Säljaren levererar godset vid fartygets sida i avskeppningshamnen; köparen står för lastning, sjöfrakt och risk därifrån.' WHERE "code" = 'FAS' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Säljaren lastar godset ombord på fartyget i avskeppningshamnen; köparen står för sjöfrakt och risk från ombordlastningen.' WHERE "code" = 'FOB' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Säljaren betalar frakten till ankomsthamnen, men risken går över till köparen redan vid ombordlastningen.' WHERE "code" = 'CFR' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Som CFR, men säljaren tecknar även transportförsäkring för godset till ankomsthamnen.' WHERE "code" = 'CIF' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Säljaren betalar frakten till angiven destination, men risken går över när godset lämnas till den förste fraktföraren.' WHERE "code" = 'CPT' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Som CPT, men säljaren tecknar även transportförsäkring för godset till destinationen.' WHERE "code" = 'CIP' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Säljaren står för transporten till angiven plats; köparen sköter lossning och importklarering.' WHERE "code" = 'DAP' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Säljaren står för transporten och lossningen på angiven plats; köparen sköter importklareringen.' WHERE "code" = 'DPU' AND "description" IS NULL;--> statement-breakpoint
UPDATE "delivery_terms" SET "description" = 'Säljaren står för hela transporten inklusive importklarering och tull; köparen tar bara emot på angiven plats.' WHERE "code" = 'DDP' AND "description" IS NULL;
