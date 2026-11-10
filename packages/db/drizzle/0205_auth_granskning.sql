-- Auth-granskningen 2026-11-10.
--
-- E-post utan skiftläge: the API now lower-cases every address it stores
-- or looks up (packages/shared/src/auth.ts), so existing addresses are
-- lower-cased here and the unique index becomes lower(email). Two live
-- accounts that differ only by case cannot be merged automatically — the
-- migration stops with their addresses so an administrator can rename or
-- remove one (System → Användare) before updating again. Soft-deleted rows
-- are outside the partial index and just lower-cased.
DO $$
DECLARE
  clash text;
BEGIN
  SELECT string_agg(email, ', ' ORDER BY email) INTO clash
  FROM users u
  WHERE u.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM users o
      WHERE o.id <> u.id AND o.deleted_at IS NULL AND lower(o.email) = lower(u.email)
    );
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'Användare med samma e-postadress i olika skiftläge: %. Byt adress på eller ta bort den ena under System → Användare och uppdatera igen.', clash;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX "users_email_unique";--> statement-breakpoint
UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint
-- Sessioner: a password change bumps token_version, which every session JWT
-- carries as `ver` (0 for tokens issued before this migration).
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email")) WHERE "users"."deleted_at" is null;
