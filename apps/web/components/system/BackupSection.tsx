"use client";

import { API_URL } from "../../lib/api";
import buttonStyles from "../ui/Button.module.css";
import { Card } from "../ui/Card";
import { FormHint, FormStack } from "../ui/Form";

// Downloads a complete database backup. A plain <a download> lets the API's
// Content-Disposition drive the filename; the session cookie is sent
// automatically (same origin, proxied to the api container).
export function BackupSection() {
  return (
    <Card maxWidth={640}>
      <FormStack>
        <p style={{ margin: 0 }}>
          En säkerhetskopia är en <strong>komplett</strong> kopia av hela databasen — artiklar,
          lager, ordrar, förfrågningar, leverantörsfakturor, ritningar, företagslogga och
          inställningar — som en komprimerad SQL-fil (<code>.sql.gz</code>). Den kan användas för att
          återställa systemet eller flytta hela ERP:en till en annan server.
        </p>

        <div>
          <a className={`${buttonStyles.button} ${buttonStyles.primary}`} href={`${API_URL}/api/v1/backup`} download>
            Ladda ner säkerhetskopia
          </a>
        </div>

        <FormHint>
          Filen innehåller alla uppgifter i systemet, inklusive lösenord och andra hemligheter —
          förvara den säkert. Återställning och flytt till en annan server görs enligt drift-guiden
          (se <a href="/hjalp/drift-utveckling">Drift &amp; utveckling</a>). En automatisk
          säkerhetskopia körs dessutom varje natt på servern.
        </FormHint>
      </FormStack>
    </Card>
  );
}
