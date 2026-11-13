-- Stycktiden (Tid/enhet) och Cykeltid i minuter per enhet med åtta decimaler
-- i stället för fyra: 0,05 s/st sparades som 0,0008 min (0,048 s — kalkyl
-- och beläggning 4 % för låga) och 36 000 st/h visades som 35 294 st/h.
-- Heltalsdelen är oförändrad (sex siffror); befintliga värden behålls exakt.
ALTER TABLE "mo_operation_resources" ALTER COLUMN "run_time_per_unit" SET DATA TYPE numeric(14, 8);--> statement-breakpoint
ALTER TABLE "mo_operations" ALTER COLUMN "run_time_per_unit" SET DATA TYPE numeric(14, 8);--> statement-breakpoint
ALTER TABLE "routing_operation_alternatives" ALTER COLUMN "run_time_per_unit" SET DATA TYPE numeric(14, 8);--> statement-breakpoint
ALTER TABLE "routing_operations" ALTER COLUMN "run_time_per_unit" SET DATA TYPE numeric(14, 8);--> statement-breakpoint
ALTER TABLE "routing_operations" ALTER COLUMN "cycle_time_per_unit" SET DATA TYPE numeric(14, 8);--> statement-breakpoint
ALTER TABLE "configurator_operations" ALTER COLUMN "run_time_per_unit" SET DATA TYPE numeric(14, 8);--> statement-breakpoint
-- Beredningens tider som skrevs i st/h eller sek/st och sparades med fyra
-- decimaler (7 st/h = 8,5714 min, 0,05 s = 0,0008 min) räknas om från det
-- inskrivna talet till åtta decimaler (8,57142857 / 0,00083333).
--
-- st/h: det inskrivna talet är det KORTASTE (högst 2 decimaler) som med fyra
-- decimaler gav det sparade värdet — samma regel som visningen
-- (minutesPerUnitToUnitsPerHour). 360 st/h sparades som 0,1667 och visades
-- som 359,93; skalan går från grövst (-6) till 2 decimaler och första
-- träffen vinner. En tid skriven i minuter och bara visad i st/h (13 min/st
-- = 4,62 st/h) har inget sådant tal och lämnas.
-- sek/st: felet är högst 0,003 s, så det inskrivna talet är sekunderna
-- avrundade till 2 decimaler.
-- Tillverkningsordrarnas ögonblicksbilder och konfiguratorns operationer
-- rörs inte.
UPDATE "routing_operations" AS o
SET "run_time_per_unit" = round(60 / t."per_hour", 8)
FROM (
  SELECT DISTINCT ON (r."id") r."id", round(60 / r."run_time_per_unit", d."scale") AS "per_hour"
  FROM "routing_operations" AS r
  CROSS JOIN LATERAL generate_series(-6, 2) AS d("scale")
  WHERE r."time_unit" = 'units_per_hour' AND r."run_time_per_unit" > 0
    AND round(60 / nullif(round(60 / nullif(r."run_time_per_unit", 0), d."scale"), 0), 4) = r."run_time_per_unit"
  ORDER BY r."id", d."scale"
) AS t
WHERE o."id" = t."id";--> statement-breakpoint
UPDATE "routing_operations" AS o
SET "cycle_time_per_unit" = round(60 / t."per_hour", 8)
FROM (
  SELECT DISTINCT ON (r."id") r."id", round(60 / r."cycle_time_per_unit", d."scale") AS "per_hour"
  FROM "routing_operations" AS r
  CROSS JOIN LATERAL generate_series(-6, 2) AS d("scale")
  WHERE r."time_unit" = 'units_per_hour' AND r."cycle_time_per_unit" > 0
    AND round(60 / nullif(round(60 / nullif(r."cycle_time_per_unit", 0), d."scale"), 0), 4) = r."cycle_time_per_unit"
  ORDER BY r."id", d."scale"
) AS t
WHERE o."id" = t."id";--> statement-breakpoint
UPDATE "routing_operation_alternatives" AS a
SET "run_time_per_unit" = round(60 / t."per_hour", 8)
FROM (
  SELECT DISTINCT ON (x."id") x."id", round(60 / x."run_time_per_unit", d."scale") AS "per_hour"
  FROM "routing_operation_alternatives" AS x
  JOIN "routing_operations" AS r ON r."id" = x."routing_operation_id"
  CROSS JOIN LATERAL generate_series(-6, 2) AS d("scale")
  WHERE r."time_unit" = 'units_per_hour' AND x."run_time_per_unit" > 0
    AND round(60 / nullif(round(60 / nullif(x."run_time_per_unit", 0), d."scale"), 0), 4) = x."run_time_per_unit"
  ORDER BY x."id", d."scale"
) AS t
WHERE a."id" = t."id";--> statement-breakpoint
UPDATE "routing_operations"
SET "run_time_per_unit" = round(round("run_time_per_unit" * 60, 2) / 60, 8)
WHERE "time_unit" = 'seconds_per_unit'
  AND round(round("run_time_per_unit" * 60, 2) / 60, 4) = "run_time_per_unit";--> statement-breakpoint
UPDATE "routing_operations"
SET "cycle_time_per_unit" = round(round("cycle_time_per_unit" * 60, 2) / 60, 8)
WHERE "time_unit" = 'seconds_per_unit' AND "cycle_time_per_unit" IS NOT NULL
  AND round(round("cycle_time_per_unit" * 60, 2) / 60, 4) = "cycle_time_per_unit";--> statement-breakpoint
UPDATE "routing_operation_alternatives" AS a
SET "run_time_per_unit" = round(round(a."run_time_per_unit" * 60, 2) / 60, 8)
FROM "routing_operations" AS o
WHERE o."id" = a."routing_operation_id" AND o."time_unit" = 'seconds_per_unit' AND a."run_time_per_unit" IS NOT NULL
  AND round(round(a."run_time_per_unit" * 60, 2) / 60, 4) = a."run_time_per_unit";
