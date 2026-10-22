-- Personal & lön: payroll and personnel moved out of Tillverkning into their
-- own menu permission `personal`. Every group that had Tillverkning keeps
-- exactly what it could reach before.
UPDATE "permission_groups"
SET "permissions" = array_append("permissions", 'personal')
WHERE 'tillverkning' = ANY("permissions") AND NOT ('personal' = ANY("permissions"));
