ALTER TABLE "inquiries" ADD COLUMN "delivery_term_id" uuid;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN "carrier_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "delivery_term_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "carrier_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "delivery_term_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "carrier_id" uuid;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_delivery_term_id_delivery_terms_id_fk" FOREIGN KEY ("delivery_term_id") REFERENCES "public"."delivery_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_delivery_term_id_delivery_terms_id_fk" FOREIGN KEY ("delivery_term_id") REFERENCES "public"."delivery_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_delivery_term_id_delivery_terms_id_fk" FOREIGN KEY ("delivery_term_id") REFERENCES "public"."delivery_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE restrict ON UPDATE no action;