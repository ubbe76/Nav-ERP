-- A kreditfaktura / leverantörskreditnota is linked to at most one case: its
-- amount is a derived cost line (Kreditering/Ersättning) and two cases would
-- count it twice. 0153 is not released, so no existing duplicates to merge.
CREATE UNIQUE INDEX "deviation_links_one_case_per_invoice" ON "deviation_links" USING btree ("document_type","document_id") WHERE "deviation_links"."document_type" in ('credit_invoice', 'supplier_invoice');