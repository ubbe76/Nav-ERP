CREATE TYPE "public"."email_document_type" AS ENUM('inquiry', 'purchase_order', 'quote', 'order_confirmation', 'test');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_type" "email_document_type" NOT NULL,
	"document_id" uuid,
	"recipient" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"status" "email_status" NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
