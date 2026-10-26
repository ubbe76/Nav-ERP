---
paths:
  - "apps/api/src/modules/mail/**"
  - "apps/web/components/mail/**"
  - "apps/web/app/system/e-postlogg/**"
  - "apps/web/lib/mail.ts"
  - "packages/shared/src/mail.ts"
  - "apps/api/test/mail*"
  - "apps/api/test/document*"
---

# E-post och PDF

- `mail`-modulen äger utgående e-post (nodemailer, extern SMTP-server i `system_settings` — `smtp_password` är write-only och maskeras i `GET /settings`) och PDF-genereringen (`document-pdf.ts`, pdfkit, gemensam A4-mall med företagsinfo/logga). Tester injicerar fejktransport via `MailTransportFactory`.
- Varje utskick loggas append-only i `email_log` (`GET /email-log` med `documentType`/`documentId`-filter för kortens historik, `POST /email-log/:id/resend` för misslyckade — kräver dokumenttypens modul, `resendAccessRule`; sida `/system/e-postlogg`). Omskick återanvänder loggens val (`attachDrawings`, `show_configuration_prices`).
- **Dokumentutskicken** ligger i purchase-/sales-servicen (`sendInquiryEmail`/`sendPurchaseOrderEmail`/`sendSalesOrderEmail` + `GET .../pdf`): statusövergången (förfrågan draft→sent, IO draft→confirmed, KO-orderbekräftelse quote→confirmed) sker **efter** lyckat SMTP-anrop — ett misslyckat utskick loggas som failed utan statusändring (`SmtpNotConfiguredError` → 409, `MailSendError` → 502). Webben delar `MailSection`/`SendEmailModal` (`apps/web/components/mail/`) på de tre korten.
- **Avvikelsens reklamationsrapport** (`deviation`, Kvalitet): utskicket ligger i quality-servicen, `email_log.include_details` bär valet Orsaksanalys/Åtgärd/Beslut till Skicka om (`quality.md`).
- Utfärdade kundfakturor och påminnelser serveras ur arkivet `invoice_documents`, aldrig omrenderade (`economy.md`, Räkenskapsinformation).
- **PDF-fällor:** formatera tal med `formatNumber` — `sv-SE`:s minustecken (U+2212) saknar glyf i Helvetica-standardfonten (WinAnsi). `renderOrderRegister` är den enda liggande mallen (`startDocument({ landscape: true })`; logga och sidnumrering läser `doc.page`). Testhjälparen `pdfText` + `pdftoppm` för att verifiera PDF:er.
