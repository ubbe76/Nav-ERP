-- Strukturradernas ordning (importgranskningen 2026-11-11). bom_components
-- has no sort column: the card and the import's row matching order by
-- created_at, id. created_at defaults to now() — the transaction's start
-- time — so every writer of several rows in one transaction (the structure
-- import, Kopiera från, the configurator's variants) gave them the same
-- instant and the order fell to the uuid. The writers now stamp one
-- microsecond per row in writing order (bomRowCreatedAt in bom-write.ts);
-- this puts the rows already stored in an order too.
--
-- The user's decision: rows of one parent that share a created_at are
-- ordered by Pos. — numerically where it starts with a number (2 before
-- 10), then by its text, rows without a Pos. last in the order they have
-- today (id). The group keeps its instant; row n gets it plus n − 1
-- microseconds, so the first row is untouched and a row alone on its
-- instant is never read as a group. numeric, not int: Pos. is 20 characters.
WITH ranked AS (
  SELECT
    id,
    created_at AS group_at,
    row_number() OVER (
      PARTITION BY parent_article_id, created_at
      ORDER BY
        (position IS NULL OR btrim(position) = ''),
        (substring(btrim(position) from '^[0-9]+'))::numeric NULLS LAST,
        nullif(btrim(position), ''),
        id
    ) AS rank
  FROM bom_components
)
UPDATE bom_components b
SET created_at = r.group_at + (r.rank - 1) * interval '1 microsecond'
FROM ranked r
WHERE r.id = b.id
  AND r.rank > 1;
