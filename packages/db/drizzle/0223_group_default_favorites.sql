-- Förvalda favoriter per behörighetsgrupp: listan en medlem får tills
-- hen sparar en egen (user_settings favorites); null = inga.
ALTER TABLE "permission_groups" ADD COLUMN "default_favorites" jsonb;