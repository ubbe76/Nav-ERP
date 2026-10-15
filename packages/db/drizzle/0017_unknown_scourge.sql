ALTER TABLE "work_centers" ADD COLUMN "code" varchar(3);--> statement-breakpoint
-- Backfill existing work centers with auto codes 100, 200, ... in name order;
-- the user adjusts them to their real resource numbers in the UI afterwards.
UPDATE "work_centers" w
SET "code" = lpad((n.rn * 100)::text, 3, '0')
FROM (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM "work_centers") n
WHERE w.id = n.id;--> statement-breakpoint
ALTER TABLE "work_centers" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_centers" ADD CONSTRAINT "work_centers_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "work_centers" ADD CONSTRAINT "work_center_code_three_digits" CHECK ("work_centers"."code" ~ '^[0-9]{3}$');
