-- Kvalitetsorsaker: Benämning (engelska), skriven på ett engelskt
-- reklamationsbesked i stället för det svenska namnet (null = det svenska).
ALTER TABLE "deviation_reasons" ADD COLUMN "name_en" varchar(100);