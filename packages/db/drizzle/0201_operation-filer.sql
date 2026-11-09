-- Filer per operation (spec private/superpowers/specs/2026-11-09-ritningar-revisioner-filer-design.md,
-- tillägg): which of the article's loose files an operation is worked from,
-- beside its chosen drawings (routing_operation_drawings, 0200).
CREATE TABLE "routing_operation_article_files" (
	"routing_operation_id" uuid NOT NULL,
	"article_file_id" uuid NOT NULL,
	CONSTRAINT "routing_operation_article_files_routing_operation_id_article_file_id_pk" PRIMARY KEY("routing_operation_id","article_file_id")
);
--> statement-breakpoint
ALTER TABLE "routing_operation_article_files" ADD CONSTRAINT "routing_operation_article_files_routing_operation_id_routing_operations_id_fk" FOREIGN KEY ("routing_operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operation_article_files" ADD CONSTRAINT "routing_operation_article_files_article_file_id_article_files_id_fk" FOREIGN KEY ("article_file_id") REFERENCES "public"."article_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_routing_operation_article_files_file" ON "routing_operation_article_files" USING btree ("article_file_id");