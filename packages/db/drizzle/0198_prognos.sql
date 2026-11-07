-- Prognos (#10 etapp 1, spec
-- private/superpowers/specs/2026-11-07-prognos-abc-design.md).
-- 1. articles.forecast_controlled (Prognosstyrd): only these articles get a
--    forecast demand in the behovsberäkning and the artikelöversikt; every
--    existing article starts off.
-- 2. article_forecasts: the article's own quantity per month (first of the
--    month by CHECK, never negative), which wins over the average. A missing
--    row = the average applies. Cascades with the article; updated_by follows
--    the user (set null).
-- The settings (planning_forecast_history_months, planning_forecast_horizon_months)
-- are system_settings keys decoded in system/service/plan-settings.ts.
CREATE TABLE "article_forecasts" (
	"article_id" uuid NOT NULL,
	"month" date NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "article_forecasts_article_id_month_pk" PRIMARY KEY("article_id","month"),
	CONSTRAINT "article_forecasts_month_first_of_month" CHECK (extract(day from "article_forecasts"."month") = 1),
	CONSTRAINT "article_forecasts_quantity_nonnegative" CHECK ("article_forecasts"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "forecast_controlled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "article_forecasts" ADD CONSTRAINT "article_forecasts_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_forecasts" ADD CONSTRAINT "article_forecasts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;