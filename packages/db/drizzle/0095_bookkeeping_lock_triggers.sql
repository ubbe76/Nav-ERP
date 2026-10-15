-- Databasspärr för bokförd räkenskapsinformation (bokföringslagen 5 kap 5 §,
-- 7 kap). The application already refuses these writes; these triggers make
-- the database refuse them too, for every writer — a bug, a script or a
-- direct SQL session. Refusals raise SQLSTATE NV001 (mapped to 409
-- "bookkeeping-record-locked" by the API's error handler).
--
-- A verification booked in the CURRENT transaction may still receive rows:
-- the automatkontering (verification-poster.ts) inserts a verification that
-- is already "booked" and then its rows, in one transaction. The guard on
-- verifications stamps booked_at := now() — the DATABASE's transaction start
-- time — whenever a verification becomes booked, and rows count as locked
-- only when booked_at differs from the current transaction's now(). No later
-- transaction can share that timestamp, and booked_at itself can never be
-- changed once booked, so the exception cannot be forged from a session.
-- (The table owner can still disable triggers — the lock guards against
-- bugs, scripts and mistakes; deliberate tampering is what the audit log
-- and the encrypted backups are for.)
--
-- TRUNCATE (the test suite's cleanup) fires no row triggers and is unaffected.

CREATE OR REPLACE FUNCTION nav_verification_locked(v_id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_booked_at timestamptz;
BEGIN
  SELECT status::text, booked_at INTO v_status, v_booked_at FROM verifications WHERE id = v_id;
  IF v_status IS NULL OR v_status = 'draft' THEN
    RETURN false; -- a draft, or a parent being deleted in this statement
  END IF;
  -- Booked in THIS transaction (the automatkontering's header-then-rows).
  RETURN v_booked_at IS DISTINCT FROM now();
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nav_verifications_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      NEW.booked_at := now(); -- see the header: the booking transaction's mark
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Bokfört verifikat kan inte raderas — rätta med en omföring (id %)', OLD.id
        USING ERRCODE = 'NV001';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'draft' THEN
    IF NEW.status <> 'draft' THEN
      NEW.booked_at := now();
    END IF;
    RETURN NEW;
  END IF;
  -- Booked: the only permitted change is the FK's ON DELETE SET NULL of the
  -- user columns (a deleted login) — never any bookkeeping content.
  IF (to_jsonb(NEW) - 'created_by' - 'booked_by') = (to_jsonb(OLD) - 'created_by' - 'booked_by')
     AND (NEW.created_by IS NULL OR NEW.created_by = OLD.created_by)
     AND (NEW.booked_by IS NULL OR NEW.booked_by = OLD.booked_by) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Bokfört verifikat kan inte ändras — rätta med en omföring (id %)', OLD.id
    USING ERRCODE = 'NV001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER verifications_bookkeeping_lock
  BEFORE INSERT OR UPDATE OR DELETE ON verifications
  FOR EACH ROW EXECUTE FUNCTION nav_verifications_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nav_verification_rows_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND nav_verification_locked(OLD.verification_id) THEN
    RAISE EXCEPTION 'Rader på ett bokfört verifikat kan inte ändras (verifikat %)', OLD.verification_id
      USING ERRCODE = 'NV001';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND nav_verification_locked(NEW.verification_id) THEN
    RAISE EXCEPTION 'Rader kan inte läggas till på ett bokfört verifikat (verifikat %)', NEW.verification_id
      USING ERRCODE = 'NV001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER verification_rows_bookkeeping_lock
  BEFORE INSERT OR UPDATE OR DELETE ON verification_rows
  FOR EACH ROW EXECUTE FUNCTION nav_verification_rows_guard();
--> statement-breakpoint
-- Underlag: removable only while the document is a draft; never edited
-- (except the uploader FK being nulled by a deleted login).
CREATE OR REPLACE FUNCTION nav_verification_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nav_verification_locked(OLD.verification_id) THEN
      RAISE EXCEPTION 'Underlag på ett bokfört verifikat kan inte tas bort (verifikat %)', OLD.verification_id
        USING ERRCODE = 'NV001';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE
  IF (to_jsonb(NEW) - 'uploaded_by') = (to_jsonb(OLD) - 'uploaded_by')
     AND (NEW.uploaded_by IS NULL OR NEW.uploaded_by = OLD.uploaded_by) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Underlag kan inte ändras (fil %)', OLD.id USING ERRCODE = 'NV001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER verification_files_bookkeeping_lock
  BEFORE UPDATE OR DELETE ON verification_files
  FOR EACH ROW EXECUTE FUNCTION nav_verification_files_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nav_supplier_invoice_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status::text INTO v_status FROM supplier_invoices WHERE id = OLD.supplier_invoice_id;
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'Underlag på en attesterad eller avbruten leverantörsfaktura kan inte tas bort (faktura %)',
        OLD.supplier_invoice_id USING ERRCODE = 'NV001';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE
  IF (to_jsonb(NEW) - 'uploaded_by') = (to_jsonb(OLD) - 'uploaded_by')
     AND (NEW.uploaded_by IS NULL OR NEW.uploaded_by = OLD.uploaded_by) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Underlag kan inte ändras (fil %)', OLD.id USING ERRCODE = 'NV001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER supplier_invoice_files_bookkeeping_lock
  BEFORE UPDATE OR DELETE ON supplier_invoice_files
  FOR EACH ROW EXECUTE FUNCTION nav_supplier_invoice_files_guard();
--> statement-breakpoint
-- Arkiverade fakturadokument are insert-only, full stop.
CREATE OR REPLACE FUNCTION nav_invoice_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ett arkiverat fakturadokument kan inte ändras eller raderas (dokument %)', OLD.id
    USING ERRCODE = 'NV001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_documents_bookkeeping_lock
  BEFORE UPDATE OR DELETE ON invoice_documents
  FOR EACH ROW EXECUTE FUNCTION nav_invoice_documents_guard();
