# Kvalitet

Menyn **Kvalitet** samlar reklamationer och avvikelser: kundens reklamation på något vi levererat, ett fel i det vi fått från en leverantör och ett fel vi hittar själva i produktionen. Varje avvikelse är ett ärende med orsak, utredning, åtgärd, kostnad och koppling till kund eller leverantör, order, artikel och tillverkningsorder. Menyn har tre delar: **Avvikelser**, uppföljningen i rapporterna **Leveransprecision** och **Kassation**, och registret **Kvalitetsorsaker** under Grunddata.

Avvikelsen bokför ingenting och flyttar inget lager. Kostnaderna på ärendet är underlag för uppföljning, och dokumenten som ärendet leder till — kreditfaktura, ersättningsorder, inköpsorder, tillverkningsorder — skapas med de vanliga rutinerna och kopplas till ärendet.

Menyn kräver rättigheten **Kvalitet** (se [Behörighet](#behorighet)).

## Avvikelser

**Kvalitet → Avvikelser** är listan över alla ärenden. Den visar som förval de öppna (**Registrerad** och **Utreds**). Sök på nummer, rubrik, kund, leverantör, artikel eller referens, och filtrera på **Typ**, **Status** (**Öppna**, en enskild status eller **Alla statusar**), **Orsak** och **Ansvarig**. Rutan **Försenade** visar ärenden där **Åtgärd senast** har passerat. **Exportera CSV** hämtar samma urval som en fil.

Kolumnerna är **Nr**, **Datum**, **Typ**, **Rubrik**, **Motpart**, **Artikel**, **Orsak**, **Ansvarig**, **Åtgärd senast** (röd när datumet har passerat och ärendet är öppet), **Status** och **Nettokostnad**. Klicka på numret eller rubriken för att öppna kortet.

Ärendena numreras **AV-1**, **AV-2** och så vidare. Nummerserien heter **Avvikelse** och ändras i **System → Nummerserier** som övriga serier.

### Typer

- **Kundreklamation** — kunden reklamerar något vi levererat. Kräver en kund; kan kopplas till kundorder, orderrad, faktura och tillverkningsorder.
- **Leverantörsavvikelse** — något vi fått från en leverantör är fel. Kräver en leverantör; kan kopplas till inköpsorder, orderrad och tillverkningsorder.
- **Intern avvikelse** — ett fel vi hittar själva, till exempel ett produktionsfel. Har ingen kund eller leverantör; kan kopplas till en tillverkningsorder.

Typen väljs när ärendet skapas och kan inte ändras efteråt.

## Ny avvikelse

Skapa ett ärende med **+ Ny avvikelse** i listan, eller med knapparna som fyller i sammanhanget åt dig:

- **Ny reklamation** på kundorderkortet, kundfakturakortet och kundkortet.
- **Ny avvikelse** på inköpsorderkortet, leverantörskortet och tillverkningsorderkortet.
- **Reklamera** på en orderrad på kundordern, och **Avvikelse** på en orderrad på inköpsordern. Raden, ordern och artikeln fylls i.
- **Skapa avvikelse** på en rad under **Kassationer** på tillverkningsordern. Tillverkningsordern, operationen, artikeln, kasserat antal och rubriken fylls i, och kassationens orsak om den också gäller interna avvikelser.

Knapparna finns bara för den som har rättigheten **Kvalitet**.

Välj **Typ** först (hoppas över när du kommer från ett kort) och fyll sedan i fälten på kortet nedan. **Rubrik** och — för kund och leverantör — **Kund** respektive **Leverantör** är obligatoriska. **Skapa avvikelse** öppnar det nya kortet.

## Avvikelsekortet

Överst på kortet visas **Status**, typen och vem som registrerade ärendet, samt knapparna **Ladda ner PDF**, **Skriv ut** och statusknapparna.

I ett öppet ärende är fälten redigerbara; spara med **Spara**. Osparade ändringar varnar innan du lämnar sidan, och statusknapparna väntar tills du sparat.

- **Rubrik**, **Datum** (förval i dag), **Orsak**, **Ansvarig** och **Åtgärd senast**. **Orsak** visar de aktiva [Kvalitetsorsaker](#kvalitetsorsaker) som gäller ärendets typ. Listan **Ansvarig** visar alla aktiva användare.
- **Kund** eller **Leverantör** och **Kundens referens** respektive **Leverantörens referens** — motpartens eget ärendenummer.
- **Gäller**: **Kundorder** och **Orderrad**, **Faktura** (kund), **Inköpsorder** och **Orderrad** (leverantör), **Tillverkningsorder** och **Operation**, **Artikel** och **Antal**. Antalet anges i artikelns lagerenhet. Väljer du en orderrad eller en tillverkningsorder sätts artikeln till radens respektive ordens artikel; byter du rad eller order nollställs eller byts artikeln. Dokumenten måste höra ihop: kundordern och fakturan till kunden, inköpsordern till leverantören, raden till sin order och operationen till sin tillverkningsorder — annars visas ett felmeddelande som säger vilket fält det gäller. Kunden eller leverantören kan inte bytas så länge ärendet har kopplade dokument; ta bort kopplingarna först.
- **Beskrivning**, **Orsaksanalys**, **Åtgärd** och **Förebyggande åtgärd**.
- **Beslut** (kund och leverantör): **Godkänd** eller **Avslagen**. Vid en kundreklamation betyder Godkänd att vi godkänner kundens reklamation. Vid en leverantörsavvikelse betyder Godkänd att leverantören har godkänt vår reklamation.

Är ärendet **Avslutad** eller **Makulerad**, eller saknar du rättigheten **Kvalitet**, visas uppgifterna som text. Kunden, leverantören, dokumenten och artikeln är länkar till de som du får öppna.

### Status och flöde

Ett ärende går **Registrerad** → **Utreds** → **Avslutad**. Knapparna överst på kortet är:

- **Börja utreda** — från Registrerad till Utreds.
- **Avsluta** — från Registrerad eller Utreds. Ärendet måste ha en **Åtgärd** ifylld och sparad, och en kundreklamation eller leverantörsavvikelse måste ha ett **Beslut**; dialogen **Avsluta AV-n** frågar efter beslutet. En intern avvikelse har inget beslut.
- **Makulera** — från Registrerad eller Utreds. Dialogen kräver en **Orsak till makuleringen**, som stannar på ärendet. Makulerade ärenden räknas inte i rapporterna.
- **Öppna igen** — från Avslutad tillbaka till Utreds. Beslut och texter behålls.

Fälten, kostnaderna, kopplingarna och filerna kan bara ändras i ett öppet ärende; i ett avslutat ärende ändrar du dem efter **Öppna igen**. En makulerad avvikelse kan inte öppnas igen.

### Kostnader

Sektionen **Kostnader** (bara för den som får se priser) listar kostnadsraderna och **Nettokostnad**. Lägg till en rad med **Typ**, **Beskrivning (valfritt)** och **Belopp (SEK)**, sedan **Lägg till**:

- **Material**, **Arbete**, **Frakt**, **Kreditering** och **Övrigt** är kostnader.
- **Ersättning** — till exempel leverantörens kreditering — minskar nettokostnaden.

**Nettokostnad** är kostnaderna minus ersättningarna. Två slags rader räknas automatiskt och märks **Härledd**:

- en kopplad **utfärdad kreditfaktura** räknas som en Kreditering med kreditfakturans nettobelopp, märkt *Från kreditfaktura …*;
- en kopplad **leverantörskreditnota** (en attesterad eller betald leverantörsfaktura med negativt nettobelopp) räknas som en Ersättning, märkt *Från leverantörsfaktura …*.

Utkast räknas aldrig. De härledda raderna går inte att ta bort — ta bort kopplingen till dokumentet i stället.

### Kopplade dokument

Sektionen **Kopplade dokument** visar dokumenten som ärendet har lett till, med nummer, status och när de kopplades. Knapparna skapar dokumenten med de vanliga rutinerna och kopplar dem i samma steg. De visas bara för den som har både **Kvalitet** och den modulens meny, och i ett öppet ärende:

- **Skapa kreditfaktura** (kundreklamation med en utfärdad eller betald faktura) — frågar och skapar en kreditfakturakladd mot fakturan och öppnar den. Kreditfakturan räknas som en härledd kostnad när den är utfärdad.
- **Skapa ersättningsorder** (kundreklamation) — en ny kundorder för kunden med artikeln och antalet från ärendet, à-pris 0 och noteringen *Ersättning för AV-n*.
- **Skapa inköpsorder** (leverantörsavvikelse) — en ny inköpsorder hos leverantören med artikeln och antalet som första rad och noteringen *Ersättning för AV-n*. Priset hämtas ur leverantörens priser om de finns, annars 0 — kontrollera raden.
- **Skapa tillverkningsorder** (kundreklamation eller intern avvikelse) — en ny tillverkningsorder för omarbete eller ersättning på artikeln och antalet från ärendet.
- **Koppla dokument** — för ett följddokument som skapats på annat sätt. Välj **Dokumenttyp** (**Kreditfaktura**, **Kundorder**, **Inköpsorder**, **Tillverkningsorder** eller **Leverantörsfaktura**, beroende på typ) och sök fram dokumentet. Det måste höra till samma kund eller leverantör. En och samma kreditfaktura eller leverantörsfaktura kan bara kopplas till ett ärende.

**Ta bort koppling** tar bort kopplingen men aldrig dokumentet. Ett dokument som har tagits bort visas som *borttaget*.

### Bilder och filer

Sektionen **Bilder och filer** tar emot foton och dokument till ärendet: PDF, JPEG eller PNG, högst 20 MB. Ladda upp med filväljaren, eller tryck **Fota** på mobilen för att ta ett foto direkt med kameran. Filnamnet öppnar filen. Filerna kan tas bort med **Ta bort** så länge ärendet är öppet; de är inte räkenskapsinformation.

### Historik

**Historik** är ärendets egen logg, äldst först: skapat, statusbyten, ändrade fält, kostnader, kopplingar, filer och skickade e-postmeddelanden, med tid och användare.

## Skriva ut och skicka

**Ladda ner PDF** och **Skriv ut** överst på kortet ger ärendets rapport. Rapporten heter **Reklamationsbesked** för en kundreklamation, **Reklamation** för en leverantörsavvikelse och **Avvikelserapport** för en intern avvikelse. Den visar nummer, datum, motpart, referenser, artikel och antal, beskrivning och orsak — aldrig kostnader eller priser, och tillverkningsordernumret bara på den interna rapporten. **… med analys och åtgärd (PDF)** under **E-post** tar dessutom med orsaksanalys, åtgärd, förebyggande åtgärd och beslut.

Under **E-post** skickar du rapporten som PDF-bilaga med **Skicka reklamationsbesked** (eller **Skicka reklamation** / **Skicka avvikelserapport**) eller varianten **… med analys och åtgärd**. Mottagaren är förvald till kundens eller leverantörens kontakt. Utskicket loggas i [E-postloggen](/hjalp/system#e-postlogg) och på kortet, men ändrar inte ärendets status. Det går i alla statusar. **Skicka om** i E-postloggen kräver rättigheten **Kvalitet**.

## Kvalitetsorsaker

Orsakerna som avvikelser och kassationer väljer ur. Registret finns under **Kvalitet → Kvalitetsorsaker** och som fliken **Kvalitetsorsaker** under [Grunddata](/hjalp/grunddata#kvalitetsorsaker). Varje orsak har en **Kod** (versaler och siffror, högst 10 tecken) och en **Benämning**, och kryssrutorna **Kund**, **Leverantör**, **Intern** och **Kassation** som styr var orsaken kan väljas. Minst en måste vara ifylld.

## Kassation och orsaker

Finns minst en aktiv orsak med **Kassation** måste man välja en **Orsak** när kasserat antal rapporteras i [stämpelterminalen](/hjalp/terminal), under [Pågående arbete](/hjalp/tillverkning) och på tillverkningsordern; fritexten blir en valfri **Kommentar**. Saknas sådana orsaker anges **Kassationsorsak** som fritext som tidigare. Kassationerna på tillverkningsordern visar orsakens namn och kommentaren, och [kassationsrapporten](/hjalp/rapporter#kassationsstatistik) grupperar på orsaken.

## Uppföljning

- [**Leveransprecision**](/hjalp/rapporter#leveransprecision) kan grupperas per **Motpart** med avvikelser, andel felfria leveranser, reklamerat antal och avvikelsekostnad per leverantör och kund.
- [**Kassation**](/hjalp/rapporter#kassationsstatistik) grupperar på orsak.
- Aviseringen **Avvikelser som passerat Åtgärd senast** på [Aviseringar](/hjalp/aviseringar) listar öppna ärenden där **Åtgärd senast** har passerat. Den ses av den som har menyn **Kvalitet** och länkar till listan med rutan **Försenade** ibockad.

## Behörighet

Menyn och sidorna under **Kvalitet** öppnas med rättigheten **Kvalitet** i behörighetsgruppen (se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)). Vid uppgraderingen fick varje grupp som redan hade **Försäljning**, **Inköp** eller **Tillverkning** även **Kvalitet**; senare skapade grupper får den på vanligt sätt. Rättigheten behövs för att skapa och ändra avvikelser och orsaker, och — utöver respektive moduls meny — för genvägarna som skapar dokument åt ett ärende. Den som saknar den ser ändå sektionen **Avvikelser** på kort man får öppna, men bara som text. Att ta bort en kvalitetsorsak (**Ta bort**) är för administratörer.
