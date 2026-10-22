# Importmallar

<!-- Genererad av `npm run generate:import-templates -w apps/api` ur apps/api/src/modules/import/service/field-help.ts — redigera inte för hand. -->

Varje import i Nav har en **Excelmall** att utgå från. Mallen laddas ned med **Ladda ned mall** i importguidens flik, eller här nedan. Den har två blad:

- **Import** — en rad med kolumnrubriker, i fetstil. Varje rubrik har en kommentar som förklarar kolumnen (håll muspekaren över cellen); kommentaren börjar med *Obligatorisk.* när kolumnen måste finnas med. Fyll i dina rader under rubrikerna.
- **Instruktioner** — samma förklaringar i en tabell, med ett exempelvärde per kolumn. Bladet läses aldrig in.

Att känna till:

- Importen läser bara det **första bladet** i en arbetsbok — låt **Import** ligga först.
- Kolumner du inte behöver kan **tas bort eller lämnas tomma**. En tom cell skriver aldrig över ett sparat värde på en befintlig post.
- Kolumnernas **ordning spelar ingen roll** — guiden känner igen rubrikerna och kopplar dem till rätt fält.
- Tal skrivs med **decimalkomma eller punkt** (1 250,50 eller 1250.50).
- Ja/Nej-kolumner förstår **Ja/Nej**, **1/0** och **true/false** (de flesta även **X** för Ja); exakt vilka ord som gäller står vid kolumnen.
- **Textformatera nummerkolumner** i Excel (artikelnummer, resursnummer, postnummer) så att inledande nollor inte försvinner.

Förklaringarna nedan visas också i importguidens steg **Kolumner**, under varje fält. Reglerna för själva importen — vad som skapas, uppdateras eller hoppas över — står i respektive kapitel, länkat från varje avsnitt.

## Artiklar

[Ladda ned mallen](/importmallar/importmall-artiklar.xlsx) — importeras på **Artiklar → Importera**, fliken **Artiklar**. Reglerna beskrivs i [Artiklar](/hjalp/artiklar#importera-artiklar).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Artikelnummer** | Ja | Artikelns unika nummer, max 50 tecken. Finns numret redan uppdateras artikeln, annars skapas en ny. Textformatera kolumnen i Excel så att inledande nollor behålls. | SB-1200 |
| **Benämning** | Nej | Artikelns namn, max 255 tecken. Krävs för nya artiklar. Tom cell lämnar fältet orört på en befintlig post. | Diskbänk 1200 mm, rostfri |
| **Artikeltyp** | Nej | Tillverkad (även M), Köpt (även P eller K), Tjänst (även Lego) eller Fiktiv (även F) — Fiktiv ger en tillverkad fantomartikel. Tom cell ger guidens Standardtyp för nya artiklar. Typen och fantomflaggan ändras aldrig på befintliga artiklar — en avvikelse ger en varning. | Tillverkad |
| **Enhet** | Nej | Grundenhetens kod, max 20 tecken (t.ex. st, kg, m). En okänd kod skapas i enhetsregistret med koden som namn; tom cell ger st för nya artiklar. Grundenheten ändras aldrig på befintliga artiklar. | st |
| **Artikelgrupp (kod)** | Nej | Artikelgruppens kod, 3–4 siffror. En kod som saknas i registret skapas med koden som namn. Tom cell lämnar fältet orört på en befintlig post. | 300 |
| **Standardpris** | Nej | Standardkostnad per grundenhet i SEK, decimalkomma eller punkt, aldrig negativ (t.ex. 1 250,50). Tom cell lämnar fältet orört; ett annat värde än det sparade uppdaterar artikeln. | 1250,50 |
| **Vikt (kg)** | Nej | Vikt i kilogram per grundenhet, decimalkomma eller punkt, aldrig negativ. Tom cell lämnar fältet orört på en befintlig post. | 18,5 |
| **Ytbehandling** | Nej | Fritext, max 200 tecken. Tom cell lämnar fältet orört på en befintlig post. | Borstad |
| **Färg** | Nej | Fritext, max 200 tecken. Tom cell lämnar fältet orört på en befintlig post. | Rostfri |
| **Aktiv** | Nej | Ja/Nej, 1/0 eller true/false. Tom cell betyder aktiv för nya artiklar och lämnar befintliga orörda. | Ja |
| **Beställningspunkt** | Nej | Saldo i grundenhet där behovsberäkningen föreslår påfyllnad, decimalkomma eller punkt, aldrig negativt. 0 betyder ingen beställningspunkt och tömmer fältet; tom cell lämnar det orört. | 10 |
| **Orderkvantitet** | Nej | Fast orderstorlek i grundenhet — förslag rundas upp till en multipel av den. Importeras bara när Partiformningsregel är Fast orderstorlek (eller den kolumnen inte är mappad). 0 tömmer fältet; tom cell lämnar det orört. | 25 |
| **Avrundning** | Nej | Steg i grundenhet som orderantal rundas upp till, större än 0 och högst 3 decimaler (fler avrundas med en varning). 0 tömmer fältet; tom cell lämnar det orört. | 1 |
| **Partiformningsregel** | Nej | Lagras inte — styr bara om Orderkvantitet läses: Fast orderstorlek betyder att kvantiteten importeras, allt annat (t.ex. Mot behov) att den hoppas över på raden. | Fast orderstorlek |

## Alternativa enheter

[Ladda ned mallen](/importmallar/importmall-enheter.xlsx) — importeras på **Artiklar → Importera**, fliken **Enheter**. Reglerna beskrivs i [Artiklar](/hjalp/artiklar#importera-alternativa-enheter).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Artikelnummer** | Ja | Numret på en artikel som redan finns i artikelregistret. | RS-12 |
| **Enhet** | Ja | Den alternativa enhetens kod, max 20 tecken. En okänd kod skapas i enhetsregistret. Samma enhet och artikel får bara förekomma en gång i filen. | m |
| **Omräkningsfaktor** | Ja | Antal grundenheter per en alternativ enhet, större än 0, decimalkomma eller punkt — med grundenhet kg betyder 0,89 på raden m att en meter väger 0,89 kg. Lagras inverterat som alternativa enheter per grundenhet med sex decimaler. Faktor 1 markerar grundenhetsraden, som hoppas över (ska ha artikelns grundenhet, annars en varning). | 0,89 |
| **Inköpsenhet** | Nej | Ja/Nej, 1/0, X eller true/false; tom cell betyder Nej. Ja gör enheten till artikelns inköpsenhet (förvalet på inköpsorderrader) — högst en per artikel i filen. | Ja |
| **Försäljningsenhet** | Nej | Ja/Nej, 1/0, X eller true/false; tom cell betyder Nej. Ja gör enheten till artikelns försäljningsenhet (förvalet på kundorderrader) — högst en per artikel i filen. | Nej |

## Operationer

[Ladda ned mallen](/importmallar/importmall-operationer.xlsx) — importeras på **Artiklar → Importera**, fliken **Operationer**. Reglerna beskrivs i [Artiklar](/hjalp/artiklar#importera-operationer).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Artikelnummer** | Ja | Numret på en artikel som redan finns i artikelregistret. En artikel som inte är tillverkad importeras med en varning — operationen används inte vid tillverkning. | SB-1200 |
| **Sekvensnr** | Ja | Operationens ordningsnummer på artikeln, heltal större än 0 (t.ex. 10, 20, 30). Artikel + sekvensnr är nyckeln: finns operationen redan blir raden ett fel, hoppas över med Hoppa över rader som redan finns, eller skrivs över med Uppdatera befintliga operationer. | 10 |
| **Resurs** | Ja | Resursens tresiffriga nummer i resursregistret (Tillverkning → Resurser) — resursen måste finnas. 1–2 siffror fylls på med nollor (7 blir 007). En legoresurs ger en lego-operation med tiderna 0. | 110 |
| **Ställtid** | Ja | Omställningstid per order i den enhet Tidsenhet anger — minuter när den kolumnen saknas eller är tom, timmar vid antal/timme. Decimalkomma eller punkt, aldrig negativ. Skriv 0 när momentet saknar ställtid; kolumnen måste finnas med. | 15 |
| **Stycktid** | Ja | Tid per styck i den enhet Tidsenhet anger — minuter per styck när den kolumnen saknas; vid antal/timme är värdet i stället antal styck per timme (360 blir 0,1667 min/st). Decimalkomma eller punkt, aldrig negativ. Skriv 0 när momentet saknar stycktid; kolumnen måste finnas med. | 2,5 |
| **Tidsenhet** | Nej | Enheten för Ställtid och Stycktid på raden: minuter/enhet (även min), antal/timme (även st/h — ställtiden då i timmar), timmar/enhet (även tim eller h) eller sekunder/enhet (även sek eller s). Tom cell betyder minuter; ett okänt ord ger ett fel. Lagringen är alltid minuter; antal/timme sparas med visningsenheten st/h. | minuter/enhet |
| **Kalkyl** | Nej | Ja/Nej, 1/0, X eller true/false; tom cell betyder Nej. Ja gör operationen till en kalkyloperation som bara räknas i förkalkylen och aldrig frisläpps eller rapporteras. | Nej |
| **Kommentar** | Nej | Operationens instruktionstext, max 1 000 tecken. Kryssrutan Skriv ut kommentaren på arbetskortet i guiden avgör om den skrivs ut på TO-utskriften. Tom cell lämnar en befintlig kommentar orörd vid uppdatering. | Kontrollera måtten mot ritningen före kantpressning |
| **Beskrivning** | Nej | Operationens namn, max 255 tecken (t.ex. Kantpressning). Tom cell lämnar ett befintligt namn orört vid uppdatering. | Laserskärning |
| **Packinstruktion** | Nej | Packinstruktion för operationen, max 1 000 tecken. Tom cell lämnar en befintlig orörd vid uppdatering. | Mellanlägg av papp mellan varje enhet |

## Artikelstruktur

[Ladda ned mallen](/importmallar/importmall-struktur.xlsx) — importeras på **Artiklar → Importera**, fliken **Struktur**. Reglerna beskrivs i [Artiklar](/hjalp/artiklar#importera-artikelstruktur).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Artikelnummer** | Ja | Den överordnade (tillverkade) artikeln — måste redan finnas i artikelregistret; importera artiklarna först. En artikel som inte är tillverkad ger en varning. | SB-1200 |
| **Komponentnummer** | Ja | Den ingående artikeln. Måste finnas i artikelregistret om inte Skapa saknade artiklar är ikryssat — då skapas den ur radens egna kolumner. Samma komponent kan bara ligga en gång per artikel: finns den redan i strukturen blir raden ett fel (eller hoppas över med Hoppa över rader som redan finns). En artikel kan inte ingå i sin egen struktur, inte heller via flera led. | PL-2-1500 |
| **Antal** | Ja | Antal av komponenten per en enhet av den överordnade artikeln, större än 0, decimalkomma eller punkt. Anges i kolumnen Enhet (annars komponentens grundenhet) och lagras alltid i grundenheten. | 2 |
| **Enhet** | Nej | En av komponentens enheter: grundenheten eller en upplagd alternativ enhet (annars ett fel). Tom cell betyder grundenheten. För en komponent som skapas av importen blir det i stället den nya artikelns grundenhet (tom = st; en okänd kod skapas). | st |
| **Operation** | Nej | Sekvensnumret (heltal större än 0) på en av den överordnade artikelns operationer, som materialet dras vid. Tom cell, eller en operation som inte finns, ger ingen koppling — materialet dras vid slutrapporteringen (varning). En kalkyloperation ger ett fel. | 10 |
| **Komponentbenämning** | Nej | Läses bara för komponenter som saknas i registret när Skapa saknade artiklar är ikryssat — då obligatorisk, max 255 tecken. Befintliga artiklar ändras aldrig av strukturimporten. | Plåt 2 mm 1500×3000 |
| **Komponenttyp** | Nej | Artikeltyp för en komponent som skapas: Tillverkad (även M), Köpt (även P eller K), Tjänst (även Lego) eller Fiktiv (även F) — Fiktiv ger en tillverkad fantomartikel. Tom cell ger guidens Standardtyp, annars Köpt. Läses bara med Skapa saknade artiklar. | Köpt |
| **Komponentens standardpris** | Nej | Standardkostnad per grundenhet för en komponent som skapas, decimalkomma eller punkt, aldrig negativ. Läses bara med Skapa saknade artiklar. | 890 |

## Inköpspriser

[Ladda ned mallen](/importmallar/importmall-inkopspriser.xlsx) — importeras på **Artiklar → Importera**, fliken **Inköpspriser**. Reglerna beskrivs i [Inköp](/hjalp/inkop#importera-inkopspriser).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Artikelnummer** | Ja | Numret på en artikel som redan finns i artikelregistret. | PL-2-1500 |
| **Leverantörsnummer** | Ja | Numret på en leverantör som redan finns i leverantörsregistret. Alla rader med samma artikel och leverantör bildar en katalograd: den första raden ger pris och övriga uppgifter, varje rad kan bära ett staffelsteg. | 2001 |
| **Leverantörens artikelnummer** | Nej | Leverantörens eget nummer på artikeln, max 100 tecken. Tom cell lämnar fältet orört på en befintlig post. | LEV-4471 |
| **Pris** | Nej | Pris per grundenhet (antal 1) i leverantörens valuta, decimalkomma eller punkt, aldrig negativt; fyra decimaler sparas. Tom cell lämnar priset orört på en befintlig katalograd. | 245,00 |
| **Rabatt (%)** | Nej | Procentavdrag från 0 upp till (men inte med) 100 som bakas in i radens pris och staffelpris — Pris × (1 − Rabatt/100) — med en varning, eftersom katalogen saknar rabattfält. Tom cell betyder ingen rabatt. | 10 |
| **Huvudleverantör** | Nej | Ja/Nej, 1/0, X eller true/false; tom cell betyder Nej när kolumnen är mappad. Ja gör leverantören till artikelns huvudleverantör och tar bort markeringen från en tidigare — högst en per artikel i filen. | Ja |
| **Staffel: från antal** | Nej | Antalet i grundenhet där staffelpriset börjar gälla, större än 1 — ett gränsvärde på 1 eller lägre ignoreras med en varning (antal 1 är grundpriset). Är kolumnen mappad ersätts katalogradens staffel helt av filens steg (inga steg = staffeln tas bort); är den inte mappad rörs staffeln inte. | 100 |
| **Staffel: pris** | Nej | Priset per grundenhet från och med gränsvärdet, decimalkomma eller punkt, aldrig negativt. Krävs på varje rad som har ett gränsvärde. | 219,00 |

## Kundpriser

[Ladda ned mallen](/importmallar/importmall-kundpriser.xlsx) — importeras på **Artiklar → Importera**, fliken **Kundpriser**. Reglerna beskrivs i [Försäljning](/hjalp/forsaljning#importera-kundpriser).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Artikelnummer** | Ja | Numret på en artikel som redan finns i artikelregistret. | SB-1200 |
| **Kundnummer** | Ja | Numret på en kund som redan finns i kundregistret. Samma kund och artikel får bara förekomma en gång i filen. | 1001 |
| **Pris** | Ja | Kundens pris per grundenhet i SEK, decimalkomma eller punkt, aldrig negativt. Sparas med fyra decimaler som kundens artikelpris från antal 1 och ersätter ett tidigare pris på samma artikel. | 1890,00 |
| **Rabatt (%)** | Nej | Procentavdrag från 0 upp till (men inte med) 100 som bakas in i priset — Pris × (1 − Rabatt/100) — med en varning, eftersom kundpriset lagras som nettopris. Tom cell betyder ingen rabatt. | 5 |

## Kunder

[Ladda ned mallen](/importmallar/importmall-kunder.xlsx) — importeras på **Försäljning → Kunder → Importera**, fliken **Kunder**. Reglerna beskrivs i [Försäljning](/hjalp/forsaljning#importera-kunder).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Kundnummer** | Ja | Kundens unika nummer, max 50 tecken. Finns numret redan uppdateras kunden, annars skapas en ny. Nummerserien för kunder flyttas fram förbi filens högsta rent numeriska nummer. | 1001 |
| **Namn** | Nej | Kundens namn, max 255 tecken. Krävs för nya kunder. Tom cell lämnar fältet orört på en befintlig post. | Restaurang Exempelkrogen AB |
| **Organisationsnummer** | Nej | Max 20 tecken. Tom cell lämnar fältet orört på en befintlig post. | 556123-4567 |
| **VAT-nummer** | Nej | Momsregistreringsnummer, max 30 tecken. Tom cell lämnar fältet orört på en befintlig post. | SE556123456701 |
| **Kontaktperson** | Nej | Kontaktpersonens namn på kundkortets Allmänt-flik, max 255 tecken — kontaktregistret importeras separat som kundkontakter. | Anna Andersson |
| **E-post** | Nej | Kundens e-postadress, max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt med en varning. | info@example.com |
| **Telefon** | Nej | Max 50 tecken. Tom cell lämnar fältet orört på en befintlig post. | 010-200 10 10 |
| **Adress** | Nej | Besöksadressens första rad. Adress, Adressrad 2 och Adressrad 3 slås ihop till en adress med radbrytningar; är alla tre tomma lämnas adressen orörd. | Storgatan 8 |
| **Adressrad 2** | Nej | Besöksadressens andra rad, valfri — slås ihop med Adress. | Hus B |
| **Adressrad 3** | Nej | Besöksadressens tredje rad, valfri — slås ihop med Adress. | Ingång 2 |
| **Postnummer** | Nej | Max 20 tecken. Tom cell lämnar fältet orört på en befintlig post. | 123 50 |
| **Postort** | Nej | Max 100 tecken. Tom cell lämnar fältet orört på en befintlig post. | Exempelby |
| **Land** | Nej | Landskod med två bokstäver (t.ex. SE, NO, DK, DE); små bokstäver godtas. Tom cell ger SE för nya kunder och lämnar befintliga orörda. | SE |
| **Betalningsvillkor** | Nej | Betalningsvillkorets kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som nytt villkor; börjar namnet med ett antal dagar (30 dagar netto) blir dagarna villkorets kod. | 30 dagar netto |
| **Leveransvillkor** | Nej | Leveransvillkorets kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som nytt villkor. | Fritt vårt lager |
| **Leveranssätt/speditör** | Nej | Speditörens kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som ny speditör. | Exempelfrakt |
| **Prislista** | Nej | Prislistans kod eller namn (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som ny prislista. | Grossist |
| **Kundrabatt (%)** | Nej | Kundens generella rabatt i procent, 0–100, decimalkomma eller punkt. Tom cell lämnar fältet orört på en befintlig post. | 5 |
| **Avvikande fakturaadress** | Nej | Ja/Nej, 1/0, X eller true/false. Nej betyder att radens fakturaadresskolumner (namn, adress, postnummer, postort, land) ignoreras — kunden faktureras på besöksadressen; Ja eller tom cell använder dem som de är. Lagras inte. | Ja |
| **Fakturanamn** | Nej | Namnet på fakturan när det skiljer sig från kundens namn, max 255 tecken. Tom cell lämnar fältet orört på en befintlig post. | Exempelkrogen AB, ekonomiavdelningen |
| **Fakturaadress** | Nej | Fakturaadressens första rad. Fakturaadress, Fakturaadressrad 2 och Fakturaadressrad 3 slås ihop med radbrytningar; är alla tre tomma lämnas fakturaadressen orörd. | Box 100 |
| **Fakturaadressrad 2** | Nej | Fakturaadressens andra rad, valfri — slås ihop med Fakturaadress. | Att: Ekonomi |
| **Fakturaadressrad 3** | Nej | Fakturaadressens tredje rad, valfri — slås ihop med Fakturaadress. | Våning 3 |
| **Fakturapostnummer** | Nej | Max 20 tecken. Tom cell lämnar fältet orört på en befintlig post. | 123 51 |
| **Fakturapostort** | Nej | Max 100 tecken. Tom cell lämnar fältet orört på en befintlig post. | Exempelby |
| **Fakturaland** | Nej | Landskod med två bokstäver (t.ex. SE); små bokstäver godtas. Tom cell lämnar fältet orört på en befintlig post. | SE |
| **E-post för faktura** | Nej | E-postadress som fakturor skickas till, max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt med en varning. | faktura@example.com |
| **Vårt leverantörsnummer** | Nej | Det nummer kunden har på oss som leverantör, max 50 tecken — skrivs ut på offert, orderbekräftelse och faktura. | L-4711 |
| **Samlingsfaktura** | Nej | Ja/Nej, 1/0, X eller true/false — Ja gör att kundens leveranser faktureras genom samlingsfakturering; ett värde som börjar med Per (t.ex. Per kund) räknas också som Ja. Tom cell lämnar fältet orört på en befintlig post. | Nej |
| **Privatperson** | Nej | Ja/Nej, 1/0, X eller true/false — Ja visar priser inklusive moms på kundens offerter, orderbekräftelser och fakturor. Tom cell lämnar fältet orört på en befintlig post. | Nej |
| **Webbsida** | Nej | Max 255 tecken. Tom cell lämnar fältet orört på en befintlig post. | https://www.example.com |

## Kundkontakter

[Ladda ned mallen](/importmallar/importmall-kundkontakter.xlsx) — importeras på **Försäljning → Kunder → Importera**, fliken **Kontakter**. Reglerna beskrivs i [Försäljning](/hjalp/forsaljning#fliken-kontakter).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Kundnummer** | Ja | Numret på en kund som redan finns i kundregistret — importera kunderna först. | 1001 |
| **Kontaktperson** | Ja | Kontaktens namn, max 255 tecken. Finns redan en kontakt med samma namn på kunden (skiftlägesokänsligt) hoppas raden över — befintliga kontakter uppdateras aldrig — och samma namn två gånger i filen importeras en gång. | Anna Andersson |
| **Förvald** | Nej | Ja/Nej, 1/0, X eller true/false; tom cell betyder Nej. Ja gör kontakten till kundens huvudkontakt; har kunden redan en importeras kontakten som vanlig kontakt med en varning. | Ja |
| **Telefon** | Nej | Max 50 tecken. | 010-200 10 11 |
| **Mobiltelefon** | Nej | Max 50 tecken. | 070-000 00 01 |
| **E-post** | Nej | Max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt med en varning. | anna@example.com |
| **Anmärkning** | Nej | Fritext om kontakten. | Beställer för köket |
| **Faxnummer** | Nej | Max 50 tecken. Kontakten har inget eget faxfält — numret läggs i anmärkningen som Fax 010-200 10 19. | 010-200 10 19 |

## Kundernas leveransadresser

[Ladda ned mallen](/importmallar/importmall-kundadresser.xlsx) — importeras på **Försäljning → Kunder → Importera**, fliken **Leveransadresser**. Reglerna beskrivs i [Försäljning](/hjalp/forsaljning#fliken-leveransadresser).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Kundnummer** | Ja | Numret på en kund som redan finns i kundregistret — importera kunderna först. | 1001 |
| **Adressnamn** | Nej | Leveransadressens benämning på kundkortet, max 100 tecken. Tom cell ger Leveransadress. | Exempelskolan, köket |
| **Adressrad 1** | Nej | Första adressraden. Raderna 1–3 slås ihop till en adress med radbrytningar. En rad utan någon adressrad hoppas över, liksom en adress som är samma som kundens besöksadress eller en leveransadress som redan finns. Den första nya adressen blir kundens förvalda om kunden saknar en och guidens Sätt som förvald leveransadress är ikryssad. | Skolvägen 5 |
| **Adressrad 2** | Nej | Andra adressraden, valfri — slås ihop med Adressrad 1. | Varumottagningen |
| **Adressrad 3** | Nej | Tredje adressraden, valfri — slås ihop med Adressrad 1. | Port 3 |
| **Postnummer** | Nej | Max 20 tecken. | 123 42 |
| **Stad** | Nej | Max 100 tecken. | Exempelby |
| **Land** | Nej | Landskod med två bokstäver (t.ex. SE); små bokstäver godtas. Tom cell ger SE. | SE |

## Leverantörer

[Ladda ned mallen](/importmallar/importmall-leverantorer.xlsx) — importeras på **Inköp → Leverantörer → Importera**, fliken **Leverantörer**. Reglerna beskrivs i [Inköp](/hjalp/inkop#importera-leverantorer).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Leverantörsnummer** | Ja | Leverantörens unika nummer, max 50 tecken. Finns numret redan uppdateras leverantören, annars skapas en ny. Nummerserien för leverantörer flyttas fram förbi filens högsta rent numeriska nummer. | 2001 |
| **Namn** | Nej | Leverantörens namn, max 255 tecken. Krävs för nya leverantörer. Tom cell lämnar fältet orört på en befintlig post. | Exempel Stålhandel AB |
| **Organisationsnummer** | Nej | Max 20 tecken. Tom cell lämnar fältet orört på en befintlig post. | 556987-6543 |
| **VAT-nummer** | Nej | Momsregistreringsnummer, max 30 tecken. Tom cell lämnar fältet orört på en befintlig post. | SE556987654301 |
| **Kontaktperson** | Nej | Kontaktpersonens namn på leverantörskortets Allmänt-flik, max 255 tecken — kontaktregistret importeras separat som leverantörskontakter. | Bo Bengtsson |
| **E-post** | Nej | Leverantörens e-postadress (dit förfrågningar och inköpsorder skickas), max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt med en varning. | order@example.com |
| **Telefon** | Nej | Max 50 tecken. Tom cell lämnar fältet orört på en befintlig post. | 010-100 10 10 |
| **Adress** | Nej | Postadressens första rad. Adress, Adressrad 2 och Adressrad 3 slås ihop till en adress med radbrytningar; är alla tre tomma lämnas adressen orörd. | Valsverksgatan 4 |
| **Adressrad 2** | Nej | Postadressens andra rad, valfri — slås ihop med Adress. | Port C |
| **Adressrad 3** | Nej | Postadressens tredje rad, valfri — slås ihop med Adress. | Godsmottagningen |
| **Postnummer** | Nej | Max 20 tecken. Tom cell lämnar fältet orört på en befintlig post. | 123 45 |
| **Postort** | Nej | Max 100 tecken. Tom cell lämnar fältet orört på en befintlig post. | Exempelby |
| **Valuta** | Nej | Valutakod med tre bokstäver (SEK, EUR, NOK …); små bokstäver godtas, annat ger ett fel. Leverantörens katalogpriser och inköpsorder anges i valutan. Tom cell ger SEK för nya leverantörer och lämnar befintliga orörda. | SEK |
| **Vårt kundnummer** | Nej | Det kundnummer leverantören har på oss, max 50 tecken — skrivs ut på förfrågan och inköpsorder. Tom cell lämnar fältet orört på en befintlig post. | K-1234 |
| **Betalningsvillkor** | Nej | Betalningsvillkorets kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som nytt villkor; börjar namnet med ett antal dagar (30 dagar netto) blir dagarna villkorets kod och styr förfallodatum på leverantörsfakturor. | 30 dagar netto |
| **Leveransvillkor** | Nej | Leveransvillkorets kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som nytt villkor. | Fritt vårt lager |
| **Leveranssätt/speditör** | Nej | Speditörens kod eller namn i registret (skiftlägesokänsligt), max 100 tecken. Ett okänt värde skapas som ny speditör. | Exempelfrakt |
| **Kundnummer hos speditör** | Nej | Vårt kundnummer hos leverantörens speditör, max 50 tecken. Tom cell lämnar fältet orört på en befintlig post. | F-98765 |

## Leverantörskontakter

[Ladda ned mallen](/importmallar/importmall-leverantorskontakter.xlsx) — importeras på **Inköp → Leverantörer → Importera**, fliken **Kontakter**. Reglerna beskrivs i [Inköp](/hjalp/inkop#fliken-kontakter).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Leverantörsnummer** | Ja | Numret på en leverantör som redan finns i leverantörsregistret — importera leverantörerna först. | 2001 |
| **Kontaktperson** | Ja | Kontaktens namn, max 255 tecken. Finns redan en kontakt med samma namn på leverantören (skiftlägesokänsligt) hoppas raden över — befintliga kontakter uppdateras aldrig — och samma namn två gånger i filen importeras en gång. | Bo Bengtsson |
| **Förvald** | Nej | Ja/Nej, 1/0, X eller true/false; tom cell betyder Nej. Ja gör kontakten till leverantörens huvudkontakt; har leverantören redan en importeras kontakten som vanlig kontakt med en varning. | Ja |
| **Telefon** | Nej | Max 50 tecken. | 010-100 10 11 |
| **Mobiltelefon** | Nej | Max 50 tecken. | 070-000 00 02 |
| **E-post** | Nej | Max 255 tecken. En ogiltig adress stoppar inte raden — fältet lämnas tomt med en varning. | bo@example.com |
| **Anmärkning** | Nej | Fritext om kontakten. | Säljare, plåt och profiler |
| **Faxnummer** | Nej | Max 50 tecken. Kontakten har inget eget faxfält — numret läggs i anmärkningen som Fax 010-100 10 19. | 010-100 10 19 |

## Leverantörernas leveransadresser

[Ladda ned mallen](/importmallar/importmall-leverantorsadresser.xlsx) — importeras på **Inköp → Leverantörer → Importera**, fliken **Leveransadresser**. Reglerna beskrivs i [Inköp](/hjalp/inkop#fliken-leveransadresser).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Leverantörsnummer** | Ja | Numret på en leverantör som redan finns i leverantörsregistret — importera leverantörerna först. | 2001 |
| **Adressnamn** | Nej | Leveransadressens benämning på leverantörskortet, max 100 tecken. Tom cell ger Leveransadress. | Lagret i Exempelstad |
| **Adressrad 1** | Nej | Första adressraden. Raderna 1–3 slås ihop till en adress med radbrytningar. En rad utan någon adressrad hoppas över, liksom en adress som är samma som leverantörens postadress eller en leveransadress som redan finns. Den första nya adressen blir leverantörens förvalda om leverantören saknar en och guidens Sätt som förvald leveransadress är ikryssad. | Hamngatan 12 |
| **Adressrad 2** | Nej | Andra adressraden, valfri — slås ihop med Adressrad 1. | Godsmottagningen |
| **Adressrad 3** | Nej | Tredje adressraden, valfri — slås ihop med Adressrad 1. | Port 2 |
| **Postnummer** | Nej | Max 20 tecken. | 234 56 |
| **Stad** | Nej | Max 100 tecken. | Exempelstad |

## Resurser

[Ladda ned mallen](/importmallar/importmall-resurser.xlsx) — importeras på **Tillverkning → Resurser → Importera**, fliken **Resurser**. Reglerna beskrivs i [Tillverkning](/hjalp/tillverkning#fliken-resurser).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Nummer** | Ja | Resursens nummer, exakt tre siffror (textformatera kolumnen i Excel så att 110 inte blir 110,0 och 007 inte 7). Finns numret redan uppdateras resursen; används det av en legoresurs blir raden ett fel — den importeras på fliken Legoresurser. | 110 |
| **Namn** | Nej | Resursens namn, max 100 tecken. Krävs för nya resurser. Tom cell lämnar fältet orört på en befintlig post. | Laserskärning |
| **Typ** | Nej | Maskin eller Personal (även Manuellt arbete). Lego, Underleverantör eller Extern hoppar över raden med hänvisning till fliken Legoresurser. Ett okänt ord ger Maskin för nya resurser och lämnar befintliga orörda, med en varning; tom cell likaså utan varning. | Maskin |
| **Avdelning** | Nej | Koden på den produktionsgrupp resursen tillhör, max 20 tecken (skiftlägesokänsligt). En okänd kod skapas som ny produktionsgrupp, med Avdelningens namn eller koden som namn. Tom cell lämnar fältet orört. | PV |
| **Avdelningens namn** | Nej | Produktionsgruppens namn, max 100 tecken — används bara när gruppen skapas av importen; en befintlig grupp byter inte namn. | Plåtverkstad |
| **Timkostnad** | Nej | Resursens kostnad per timme i SEK, decimalkomma eller punkt, aldrig negativ — används i för- och efterkalkylen. Tom cell lämnar fältet orört på en befintlig post. | 950 |
| **Kalkylpris 1** | Nej | Alternativt timpris i SEK, decimalkomma eller punkt, aldrig negativt. Sparas på resursen men används inte av kalkylen ännu. | 900 |
| **Gäller ställ** | Nej | Ja/Nej, 1/0, X eller true/false — om timkostnaden gäller ställtiden. Sparas på resursen som förvalsvärde; tom cell lämnar fältet orört. | Ja |
| **Gäller styck** | Nej | Ja/Nej, 1/0, X eller true/false — om timkostnaden gäller stycktiden. Sparas på resursen som förvalsvärde; tom cell lämnar fältet orört. | Ja |
| **Förvald ställtid** | Nej | Ställtid i minuter som föreslås för nya operationer på resursen, decimalkomma eller punkt, aldrig negativ. Sparas som förvalsvärde; tom cell lämnar fältet orört. | 15 |
| **Förvald operationsbenämning** | Nej | Operationsnamn som föreslås för nya operationer på resursen, max 100 tecken. Sparas som förvalsvärde; tom cell lämnar fältet orört. | Laserskärning |
| **Kostnadsrad** | Nej | Styrkolumn för filer med flera kostnadsrader per resurs: bara raden vars värde börjar med Ordinarie importeras; saknar resursen en sådan tas dess första rad med en varning. Lagras inte — ta bort kolumnen när filen har en rad per resurs. | Ordinarie |

## Legoresurser

[Ladda ned mallen](/importmallar/importmall-legoresurser.xlsx) — importeras på **Tillverkning → Resurser → Importera**, fliken **Legoresurser**. Reglerna beskrivs i [Tillverkning](/hjalp/tillverkning#fliken-legoresurser).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Nummer** | Ja | Legoresursens nummer, exakt tre siffror (textformatera kolumnen i Excel). Finns numret redan uppdateras legoresursen; används det av en maskin- eller personalresurs blir raden ett fel. | 910 |
| **Namn** | Nej | Legoresursens namn, max 100 tecken. Krävs för nya legoresurser. Tom cell lämnar fältet orört på en befintlig post. | Pulverlackering, extern |
| **Leverantörsnummer** | Nej | Numret på den leverantör som utför legoarbetet — måste finnas i leverantörsregistret, importera leverantörerna först. Tom cell lämnar fältet orört. | 2003 |
| **Ledtid (dagar)** | Nej | Arbetsdagar hos leverantören från avsändning till retur, decimalkomma eller punkt, aldrig negativ — används av planeringen och leveranstidskontrollen. Tom cell lämnar fältet orört. | 5 |
| **Kötid (dagar)** | Nej | Dagar innan arbetet påbörjas hos leverantören, decimalkomma eller punkt, aldrig negativ. Sparas som förvalsvärde; tom cell lämnar fältet orört. | 1 |
| **Ledtid beställning (dagar)** | Nej | Dagar från beställning till att leverantören kan ta emot godset, decimalkomma eller punkt, aldrig negativ. Sparas som förvalsvärde; tom cell lämnar fältet orört. | 2 |

## Produktionsgrupper

[Ladda ned mallen](/importmallar/importmall-produktionsgrupper.xlsx) — importeras på **Tillverkning → Resurser → Importera**, fliken **Produktionsgrupper**. Reglerna beskrivs i [Tillverkning](/hjalp/tillverkning#fliken-produktionsgrupper).

| Kolumn | Obligatorisk | Förklaring | Exempel |
| --- | --- | --- | --- |
| **Kod** | Ja | Produktionsgruppens kod, max 20 tecken (skiftlägesokänsligt). Finns koden redan uppdateras gruppen, annars skapas en ny; en kod som upprepas i filen hoppas över efter första raden. | PV |
| **Namn** | Nej | Produktionsgruppens namn, max 100 tecken. En ny grupp utan namn får koden som namn; tom cell lämnar ett befintligt namn orört. | Plåtverkstad |
| **Beskrivning** | Nej | Fritext, max 2 000 tecken. Tom cell lämnar fältet orört. | Laser, kantpress och svets |
