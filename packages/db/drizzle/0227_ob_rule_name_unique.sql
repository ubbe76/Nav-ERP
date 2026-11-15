-- The OB rule's name is unique (the service's pre-check alone let two
-- simultaneous saves through). Any duplicates are renamed first — the oldest
-- keeps its name, the others get " (2)", " (3)" … within the column's 100
-- characters — so the constraint never stops a deploy.
UPDATE "ob_rules" AS o
SET "name" = left(o."name", 100 - length(' (' || d.rn || ')')) || ' (' || d.rn || ')'
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "name" ORDER BY "created_at", "id") AS rn
  FROM "ob_rules"
) AS d
WHERE d."id" = o."id" AND d.rn > 1;--> statement-breakpoint
ALTER TABLE "ob_rules" ADD CONSTRAINT "ob_rules_name_unique" UNIQUE("name");
