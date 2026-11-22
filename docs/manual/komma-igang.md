# Komma igång

Nav|ERP är byggt kring kärnflödet **artikel → lager → inköp/försäljning → tillverkningsorder → tidrapportering → kalkyl**. Den här manualen beskriver alla rutiner; det här kapitlet täcker det som är gemensamt för hela systemet.

## Logga in

Systemet nås i webbläsaren på serverns adress. Logga in med e-post och lösenord.

Under inloggningsrutan finns temaväljaren (**Ljust**, **Mörkt**, **Dracula** och eventuella egna teman). Ett val där sparas bara i webbläsaren, eftersom ingen är inloggad än: det gäller inloggningssidan och den som loggar in i samma webbläsare utan att ha valt ett eget tema. Har du valt ett tema i användarmenyn gäller det i stället så fort du loggat in. När administratören har låst temat visas ingen väljare.

Efter 10 misslyckade inloggningsförsök på samma konto spärras kontot i 15 minuter — även rätt lösenord avvisas då med *"För många misslyckade inloggningsförsök — försök igen om … min."* En lyckad inloggning nollställer räkningen. Spärren skyddar mot lösenordsgissning; vill en administratör släppa den tidigare räcker det att starta om API:t.

**Första gången:** systemet har inga förinstallerade konton. Gå till `/register` och skapa det första kontot — det blir automatiskt administratör och du loggas in direkt. Fältet **Engångskod** fylls i med koden som API:t skriver i sin logg när det startar (på servern: `docker compose logs api`); på så sätt kan bara den som kommer åt servern skapa administratörskontot. Koden byts vid varje omstart, om den inte är fast satt som `SETUP_CODE` i `.env`. Så fort ett konto finns stängs registreringssidan; fler användare skapas därefter av en administratör under **System → Användare**.

## Navigering

- **Menyn** till vänster har två delar. **Ikonlisten** längst ut har en ikon per modul: Översikt, Favoriter, Artiklar, Inköp, Försäljning, Tillverkning, Lager, Personal & lön, Kvalitet, Ekonomi, Rapporter, Aviseringar, System (endast administratörer) och Hjälp. Du ser bara de moduler din behörighetsgrupp ger dig (se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)), och håller du muspekaren över en ikon visas modulens namn. Klickar du på en modul visas dess funktioner i **modulpanelen** bredvid ikonlisten, grupperade som på modulens egen sida — under Försäljning till exempel **Order**, **Fakturering**, **Reskontra** och **Register**. Panelen byter modul utan att du lämnar sidan du står på, och du öppnar en funktion genom att klicka på den. Funktionen du står i är markerad i panelen, och modulen den hör till är markerad i ikonlisten. **Översikt**, **Aviseringar** och **Hjälp** öppnas direkt. Det du använder ofta kan du lägga som genvägar under [Favoriter](#favoriter), stjärnan i ikonlisten.
- **Sök i manualen:** på **Hjälp** finns fältet **Sök i manualen…** (och ovanför varje kapitel). Skriv ett eller flera ord och tryck **Sök**; träffarna visar kapitel, avsnittsrubrik och ett utdrag med sökorden markerade, och ett klick tar dig direkt till avsnittet. Alla ord måste finnas i samma avsnitt, och stora/små bokstäver samt å/ä/ö spelar ingen roll.
- **Modulens egen sida:** **Översikt** överst i modulpanelen öppnar modulens sida, där alla dess funktioner ligger i ett rutnät med en kort förklaring under varje. Rutnätet har samma grupper som panelen. Under **Tillverkning** ligger till exempel **Behovsberäkning**, **Beläggning** och **Scheman** i gruppen **Planering**. Funktioner som du inte har behörighet till visas varken i panelen eller i rutnätet.
- **Fäll ihop panelen:** klicka på ikonen för den modul som panelen redan visar, eller på **«** i panelens överkant, så syns bara ikonlisten och sidan får mer plats. Ett klick på en modulikon visar panelen igen. Valet sparas på ditt konto.
- På **mobilen** och i fönster smalare än en surfplatta ligger menyn bakom knappen med tre streck uppe till vänster.
- **Toppremsan** överst står kvar när du scrollar, liksom menyn. Längst till vänster i den finns Navs logga, som öppnar **Översikten**. Till höger i den finns **Favorit** (lägger till sidan du står på, se [Favoriter](#favoriter)), en klocka för [Aviseringar](/hjalp/aviseringar) och din användarmeny. Klockan visar hur många saker det finns att bevaka, med en röd siffra när något är rött och en gul annars. Siffran hämtas när sidan har laddats och sedan var femte minut, och ett klick öppnar sidan Aviseringar. Klockan visas bara för den som får öppna Aviseringar. Bredvid klockan finns ett kuvert för [Meddelanden](#meddelanden) med antalet olästa meddelanden.
- **Sök eller gå till** mitt i toppremsan (eller **Ctrl+K**, **⌘K** på Mac, var som helst i Nav) öppnar ett sökfält för hela systemet. Skriv ett ordernummer, ett artikelnummer, ett kundnamn eller namnet på en sida. Från två tecken söker Nav bland kundorder och offerter, inköpsorder, tillverkningsorder, kundfakturor, artiklar, kunder och leverantörer. Under **Gå till** visas sidorna vars namn matchar, till exempel *lagervärdering* för Lagervärdering. Stora och små bokstäver och å, ä och ö spelar ingen roll. Utan söktext visar fältet **Senast öppnade**, de sidor du senast har öppnat i den här webbläsaren (listan töms när du loggar ut och visar bara sidor du får öppna). **↑** och **↓** väljer, **Enter** öppnar och **Esc** stänger. Du ser bara sidor och register som din behörighetsgrupp ger dig. På mobilen är sökningen ett förstoringsglas bredvid klockan.
- **Verktygsraden på dokumenten:** på kundorder, offert, inköpsorder, förfrågan, tillverkningsorder och kundfaktura ligger knapparna för dokumentets flöde (till exempel **Lägg till rad**, **Bekräfta**, **Ta emot leverans**, **Efterkalkylera**, **Utfärda** och **Ändra status manuellt**) i en rad överst på kortet, ovanför dokumentets huvud. När du scrollar ned bland raderna står raden kvar under toppremsan och visar då dokumentets nummer och status. På mobilen följer raden med sidan som förut. Knapparna har var sin ikon, och den gröna huvudknappen, till exempel **Bekräfta** eller **Starta tillverkning**, står sist. Raden är alltid en rad: får knapparna inte plats — i ett smalt fönster eller på mobilen — samlas de som inte får plats under **⋯** (Fler åtgärder) sist i raden. Huvudknappen ligger alltid kvar, och de mer sällsynta som **Förlorad…** och **Avbryt order** flyttar först.
- **Ctrl+S** (**⌘S** på Mac) sparar formuläret du står i, precis som formulärets egen knapp, till exempel orderhuvudet på ett orderkort eller **Lägg till rad**. Frågar formuläret något innan det sparar, som om ordern ska få en ny revision, kommer frågan som vanligt. Webbläsarens egen funktion för att spara sidan används aldrig i Nav, men övriga webbläsargenvägar fungerar som vanligt.
- **Osparade ändringar:** har du ändrat en rad med **Ändra** på en kundorder, offert, inköpsorder eller förfrågan, eller skrivit ett nytt **Planerat färdigdatum** på en tillverkningsorder, utan att spara, frågar Nav *Du har osparade ändringar — lämna ändå?* innan du lämnar sidan eller stänger fliken. **Avbryt** låter dig stå kvar med det du skrivit. Att bara öppna **Ändra** utan att ändra något räknas inte.
- **Kortkommandon:** tryck **?** för att se dem. När du inte skriver i ett fält gäller också följande:
  - **N** öppnar sidans **+ Ny …**, till exempel **+ Ny kundorder**. Håller du muspekaren över knappen står kortkommandot i verktygstipset, till exempel *Ny kundorder (N)*.
  - I en lista flyttar **↑** och **↓** en markerad rad, **Enter** öppnar den och **Esc** tar bort markeringen.
  - **Högerklick** på en rad öppnar radens ⋯-meny, där en sådan finns. Högerklickar du på en länk får du webbläsarens vanliga meny, till exempel för att öppna i en ny flik.
  - På sidor som inte är listor, och när en dialog är öppen, fungerar piltangenterna som vanligt.
- **Användarmenyn** (knappen med dina initialer) visar ditt namn och din roll, **Installera Nav** när webbläsaren kan installera Nav som program (se [Installera som app](#installera-som-app)), **Täthet** för tabellerna (se [Listor: sök, filter och bläddring](#listor-sok-filter-och-bladdring)), **Flikar** (se [Flikar](#flikar)), **Favoriter** (var dina favoriter visas, se [Favoriter](#favoriter)), länken **Mina inställningar** (se [Mina inställningar](#mina-installningar)), väljaren för färgtema — **Ljust**, **Mörkt** och **Dracula** (ett mörkt tema i lila och rosa efter [Dracula](https://draculatheme.com), som används under MIT-licensen) —, vilken version av Nav|ERP du använder, t.ex. **Version 0.8.23**, och **Logga ut**. Klickar du på versionen öppnas versionssidan på naverp.se med vad som är nytt i varje version; versionen syns också i API:ets `GET /health`. Temavalet sparas på användaren och följer med mellan datorer, och gäller på alla sidor, även stämpelterminalen och inloggningen (se [Logga in](#logga-in) för väljaren där). Administratören kan välja ett förvalt tema för företaget, låsa valet (då döljs väljaren) och installera egna teman under **System → Teman** — de syns i väljaren bredvid de tre inbyggda.
- **Notiser:** efter en del rutiner — utleverans, inleverans och på en tillverkningsorder **Slutför**, **Förbruka**, **Rapportera tid** och **Slutför order** — visas en kort notis nere till höger med vad som gjordes, ofta med **Ångra** (eller **Ångra…** när det finns något att välja). Notisen försvinner efter några sekunder; håller du muspekaren över den stannar den, och **✕** stänger den direkt. Ett fel visas längre och i rött.
- **När något hämtas:** en tabell som hämtar sina rader visar grå platshållarrader i tabellens form, och när du söker, filtrerar eller bläddrar i en lista bleknar de gamla raderna tills de nya har kommit.
- **Statusraden** längst ned (på datorn) visar om Nav har kontakt med servern — **Ansluten**, **Sessionen har gått ut** (med en länk till **Logga in**) eller **Ingen kontakt med servern** —, vem som är inloggad med vilken roll, hur många flikar som är öppna och versionen. Den kontrollerar kontakten en gång i minuten.

## Flikar

På en bred skärm öppnas varje funktion i en egen **flik** i raden ovanför sidan, ungefär som i ett program: **Översikt**, **Kundorder**, **Artikelregister** och så vidare. Statusraden längst ned visar hur många flikar som är öppna.

- **Öppna en funktion** i menyn, bland **Favoriter** eller i **Sök eller gå till** (Ctrl+K) så öppnas den i en ny flik. Har funktionen redan en flik visas den fliken i stället, så som du lämnade den. Väljer du i menyn den funktion vars flik du redan står i, går fliken tillbaka till funktionens första sida, till exempel listan.
- **Dokumenten öppnas i funktionens flik:** klickar du på en order i listan **Kundorder** visas ordern i samma flik. En länk till en annan funktion — kunden på ordern, eller en kundorder i en artikels översikt — öppnar den funktionens flik, och fliken du stod i ligger kvar.
- En flik **står kvar** när du byter till en annan: var du har scrollat och det du har skrivit men inte sparat finns kvar när du kommer tillbaka.
- **Ctrl+klick** (**⌘+klick** på Mac) på ett dokument öppnar det i en egen flik bredvid funktionens flik, så att du till exempel kan ha två kundorder öppna samtidigt.
- **Ett dokument som skapas från ett annat** — **Skapa TO** på en kundorderrad, **Skapa kreditfaktura**, en förfrågan som blir inköpsorder, en försändelse, ett motverifikat, en leverantörsfaktura ur Fakturainkorgen — öppnas i sin funktions flik. Hör det till samma funktion som dokumentet du stod på, som en kreditfaktura från en faktura, får det en egen flik så att originalet ligger kvar. Det du skapar från en lista eller ett formulär **Ny …** öppnas där du står, som förut.
- **Byt flik** med siffertangenterna **1**–**9** när inget fält har fokus: **1** är den första fliken, **2** den andra och så vidare — det fungerar även inifrån en flik. (Ctrl+Tab och Ctrl+1–9 är webbläsarens egna och lämnas orörda.) Med **←** och **→** flyttar du mellan flikarna när flikraden har fokus.
- **Dra** en flik till en ny plats i raden; ett streck visar var den hamnar.
- **Stäng** en flik med **✕** eller med mittenknappen på musen. Har fliken osparade ändringar frågar Nav först. Stänger du den sista fliken öppnas Översikten.
- Högst **8** flikar kan vara öppna. Öppnar du fler stängs den flik du använde för längst sedan, men aldrig en med osparade ändringar.
- **Adressfältet** visar adressen till fliken du står i, så ett bokmärke eller en kopierad länk går till samma sida, och fönstrets namn är flikens namn. Laddar du om sidan finns flikarna kvar, men det du inte hade sparat finns då inte kvar. Flikarna gäller det webbläsarfönstret; ett nytt fönster börjar med sidan du öppnar.
- **Flikar** i användarmenyn stänger av flikarna (**Av**), så att varje sida öppnas som en vanlig sida igen. Valet sparas på ditt konto.
- På **mobilen** och i smala fönster (under 1 100 pixlar) finns inga flikar; sidorna öppnas som vanligt. Har du öppnat flikar i ett brett fönster finns de kvar, och de visas igen när fönstret blir brett.
- Mittenklick eller högerklick → **Öppna i ny flik** på en länk öppnar som vanligt en ny flik i webbläsaren.

## Installera som app

Nav är en webbsida och fungerar i alla moderna webbläsare. Vill du kan du dessutom installera Nav som ett program på datorn: det får då ett eget fönster utan webbläsarens adressfält och flikar, en egen ikon i Start-menyn, Dock eller programlistan, och öppnas alltid på **Översikten**. Det är fortfarande samma Nav — inget laddas ned, och programmet uppdateras när servern uppdateras.

- **Chrome och Edge** (Windows, Mac och Linux, även Chromium på Linux): välj **Installera Nav** i användarmenyn. Knappen visas bara när webbläsaren erbjuder installationen.
- **Safari på Mac** (Safari 17 eller senare): användarmenyn säger hur — välj **Arkiv → Lägg till i Dock**.
- **iPhone och iPad**: tryck på **Dela** och välj **Lägg till på hemskärmen**.
- **Firefox** på datorn kan inte installera webbprogram; använd Nav i en flik som vanligt.

Installationen kräver att Nav nås över **https** — en installation som öppnas med `http://` i det lokala nätet kan bara läggas som ett vanligt bokmärke, och då visas ingen knapp. Programfönstrets namnlist följer ditt färgtema.

## Favoriter

**Favoriter** är dina egna genvägar — till exempel **Kundorder**, **Inköpsorder** eller en lista med ett visst urval. Favoriterna sparas på användaren, så de följer med mellan datorer och till mobilen, och ingen annan ser dem. Klicka på stjärnan i ikonlisten så visas de i modulpanelen. Så länge du inte har några står det en kort förklaring under rubriken.

- **Lägg till en funktion:** för musen över en rad på en modulsida, till exempel **Försäljning**, och klicka på stjärnan till höger på raden. Funktionen läggs sist under **Favoriter** med samma namn som i rutnätet. Ett klick på den ifyllda stjärnan tar bort den igen. På en pekskärm syns stjärnorna hela tiden.
- **Lägg till sidan du står på:** klicka på **Favorit** i toppremsan, bredvid klockan för Aviseringar. Skriv ett **Namn** — förslaget är sidans rubrik — och klicka på **Lägg till**. Sidan sparas med sina filter och sin sökning, så en favorit som "Bekräftade kundordrar" öppnar listan med samma urval (vilken sida i listan du stod på sparas inte). Det går också att spara ett kort, till exempel en kund du ofta arbetar med. När sidan redan är en favorit är stjärnan på **Favorit** ifylld, och ett klick tar bort den.
- **Ändra:** klicka på **Ändra** vid rubriken **Favoriter** för att byta namn, flytta favoriterna eller **Ta bort** dem. Favoriterna står grupperade per modul (Försäljning, Inköp … och **Övrigt** för till exempel Aviseringar och Hjälp). Pilarna vid modulens namn flyttar hela modulen med dess favoriter, och pilarna vid en favorit flyttar den bara inom sin modul. Ordningen gäller både menyn och kortet på Översikten. En ny favorit hamnar sist i sin modul, eller sist i listan när den är först i sin modul. Ändringarna sparas när du klickar på **Spara**.
- **Genvägar:** under **Ändra** finns listan **Lägg till …** med genvägar som **+ Ny kundorder**, **+ Ny inköpsorder**, **+ Ny artikel** och **+ Ny avvikelse**. En sådan favorit öppnar listan med formuläret för en ny post direkt. Bara genvägar till sidor du får öppna visas.
- **Gruppens favoriter:** administratören kan ge en behörighetsgrupp förvalda favoriter (se [Behörighetsgrupper](/hjalp/system#forvalda-favoriter)). Så länge du inte har ändrat dina favoriter visar menyn gruppens lista, och **Ändra** säger att det är gruppens. Ändrar du något blir listan din egen. **Använd gruppens favoriter** under **Ändra** ersätter din egna lista med gruppens. Knappen visas bara när gruppen har förvalda favoriter, och frågan innan säger hur många favoriter du har och hur många gruppen har. Efteråt visas en notis med **Ångra** som lägger tillbaka din förra lista.
- Du kan ha högst 20 favoriter, och ett namn får vara högst 60 tecken.
- En favorit till en sida som din behörighetsgrupp inte längre ger dig visas inte, men den finns kvar och kommer tillbaka om du får behörigheten igen. Under **Ändra** syns alla dina favoriter.
- **Var favoriterna visas:** välj under **Favoriter** i användarmenyn (knappen med dina initialer uppe till höger): **Menyn** (stjärnan i ikonlisten), **Översikten** (kortet **Favoriter** på Översikten) eller **Båda**. Kortet läggs först på Översikten och kan flyttas under [Anpassa Översikten](#anpassa-oversikten); där visas favoriterna som korta länklistor grupperade per modul, i den ordning du har gett dem under **Ändra** och med samma ikoner som i menyn, och kortet har en egen **Ändra**. Ett sparat filter eller en genväg som **+ Ny kundorder** hamnar under sidans modul, och kunder och leverantörer under Försäljning respektive Inköp. Samma val finns också styckvis: kortet under **Anpassa** och bocken **Visa favoriterna i menyn** under **Ändra**. Har du tagit bort både kortet och bocken syns favoriterna ingenstans, och inget alternativ är markerat i användarmenyn. Valet sparas på användaren.

## Meddelanden

Med **Meddelanden** skriver du till andra användare inne i Nav — en fråga om en order, ett besked till verkstaden eller en påminnelse till en anställd. Varje meddelande startar en **konversation** med ett ämne, och svaren hamnar i samma tråd. Alla deltagare ser alla svar. Deltagarna väljs när konversationen skapas, och fler kan läggas till efteråt (se [Deltagare](#deltagare)). Inget skickas som e-post.

- **Kuvertet** i toppremsan, bredvid klockan, visar hur många olästa meddelanden du har. Siffran hämtas när sidan har laddats och sedan en gång i minuten. När det kommer ett nytt meddelande visas en notis nere i hörnet, "Nytt meddelande från …", med **Öppna** som går till konversationen. Ett klick på kuvertet ger **Inkorgen** och **+ Nytt meddelande**. Kuvertet visas för alla som har minst en meny i sin behörighetsgrupp.
- **Inkorgen** (sidan **Meddelanden**, som också nås med **Ctrl+K**) listar dina konversationer med det senaste meddelandet överst: ämnet, vilka du skriver med, början av det senaste meddelandet och tiden. Olästa står i fetstil med antalet olästa. Sök på ämne eller text i sökfältet. Ett gem visar att konversationen har en bifogad länk.
- **+ Nytt meddelande** öppnar dialogen **Nytt meddelande**. Välj en eller flera under **Mottagare** — skriv i sökfältet för att hitta rätt och kryssa i. Mottagarna är grupperade i **Användare**, **Terminaler** och **Anställda**, och en konversation får blanda dem. Fyll i **Ämne** och **Meddelande** och klicka på **Skicka** (eller **Ctrl+Enter**, **⌘+Enter** på Mac).
- **Bifoga länk till sidan du står på** visas när du öppnar dialogen från kuvertet på en annan sida, till exempel en kundorder. Länken visas överst i konversationen under **Bifogad länk** och öppnar sidan med samma filter. Står du på ett kort — en order, en artikel, en kund — är rutan förkryssad. Den som saknar behörighet till sidan ser länkens namn som vanlig text.
- **Konversationen** visar deltagarna, den bifogade länken och meddelandena med det äldsta överst. Skriv i rutan **Skriv ett svar…** och klicka på **Skicka** (eller Ctrl/⌘+Enter). En konversation räknas som läst när du öppnar den. Nya svar visas utan att du laddar om sidan, inom en minut.
- **Arkivera** tar bort konversationen ur inkorgen — bara för dig. Den ligger kvar under **Arkiverade**, och kommer tillbaka till inkorgen av sig själv när någon skriver i den igen. **Återställ** på en arkiverad konversation lägger tillbaka den direkt.
- **Radera** — papperskorgen vid dina egna meddelanden — tar bort texten för alla i konversationen. Kvar står raden "Meddelandet togs bort" med ditt namn och tiden, så att tråden går att följa. Texten går inte att få tillbaka. Du kan bara radera dina egna meddelanden, och ett raderat meddelande räknas inte längre som oläst för någon.

### Deltagare

Rutan **Deltagare** överst i konversationen visar vilka som är med.

- **Lägg till deltagare** kan alla i konversationen göra. Dialogen har samma urval som ett nytt meddelande — **Användare**, **Terminaler** och **Anställda** — utan dem som redan är med. Klicka på **Lägg till**. Den som läggs till ser hela konversationen, också det som redan är skrivet, och allt i den är oläst för hen. Lägger du till en terminal väljer du **Visas på terminalen t.o.m.**, med en vecka som förval.
- **Ta bort** — krysset vid en deltagare — finns bara för den som startade konversationen. Den som tas bort ser inte konversationen längre, men det hen har skrivit står kvar under hens namn. Tar du bort en terminal försvinner konversationen från stämpelterminalen direkt.
- **Lämna konversationen** finns för alla utom den som startade den. Du ser den inte längre och får inga nya meddelanden i den. Den som startade konversationen kan inte lämna den, eftersom ingen annan då kunde ta bort deltagare — använd **Arkivera** i stället.
- Varje ändring syns som en rad i tråden, till exempel "Anna lade till Bo och Terminal Verkstad", "Anna tog bort Bo" eller "Bo lämnade konversationen". En sådan rad gör inte konversationen oläst och tar inte fram en arkiverad konversation igen.

### Meddelanden till terminaler och anställda

- **Terminaler** är konton som bara har rättigheten **Stämpelterminal** — de konton stämpelterminalerna i verkstaden är inloggade med. Ett meddelande till en terminal visas överst på terminalens startvy, för alla som går förbi. Välj under **Visas på terminalen t.o.m.** hur länge det ska stå kvar: förvalet är en vecka och det längsta ett år. Skriver du mer i konversationen visas det också på terminalen, liksom svar från anställda som är med i den. Terminalen själv kan inte svara. I konversationen står "Visas på terminalen t.o.m." med datumet vid terminalen, och den som startade konversationen kan ta bort den från terminalen i förtid med **Ta bort från terminalen**. Raderade meddelanden och raderna om deltagare visas inte på terminalen.
- **Anställda** är personerna i personalregistret, med anställningsnummer och namn. De behöver inget användarkonto. Den anställde ser meddelandet i stämpelterminalen direkt efter att ha knappat in sitt anställningsnummer och kvitterar det med **OK, läst** (se [Stämpelterminalen](/hjalp/terminal#meddelanden-pa-terminalen)). I konversationen står "Oläst" vid den anställde tills dess, och sedan "Läst" med tiden. Skriver du mer i konversationen blir den oläst igen och visas nästa gång den anställde stämplar. Den anställde kan svara från terminalen med **Svara**: svaret står i tråden under den anställdes namn med märkningen "via terminalen", och är oläst för er på kontoret som vilket meddelande som helst. Den anställde kan inte radera meddelanden i terminalen.
- Raderas eller anonymiseras en anställd i personalregistret tas texten i den anställdes egna svar bort ("Meddelandet togs bort"). Efter en anonymisering står "Anonymiserad anställd" som avsändare, efter en radering "Borttagen anställd".
- Skriv inget känsligt i ett meddelande till en terminal — alla i verkstaden ser det. Ett meddelande till en anställd visas för den som knappar in den anställdes nummer.

## Mina inställningar

**Mina inställningar** öppnas från användarmenyn (knappen med dina initialer uppe till höger). Sidan gäller bara ditt eget konto och har fyra delar.

- **Utseende och arbetssätt:** **Tema**, **Täthet**, **Flikar** och **Favoriter** — samma val som i användarmenyn, som har kvar dem. Ett val sparas direkt och följer med dig mellan datorer.
- **Byt lösenord:** skriv **Nuvarande lösenord**, **Nytt lösenord** (minst 8 tecken) och **Upprepa nytt lösenord** och klicka på **Byt lösenord**. Du loggas ut på andra datorer och telefoner där kontot är inloggat, men inte där du bytte. Skriver du fel nuvarande lösenord tio gånger spärras bytet i 15 minuter. Konton med **Endast läsning** kan också byta sitt lösenord. Har du glömt lösenordet kan en administratör sätta ett nytt under **System → Användare** (fältet **Nytt lösenord** när användaren ändras).
- **E-postmallar:** texten som förifylls när du skickar ett dokument med e-post, se nedan.
- **E-postsignatur:** en signatur med dina och företagets uppgifter under mejlen du skickar, se [E-postsignatur](#e-postsignatur).

### E-postmallar

När du skickar en offert, orderbekräftelse, faktura, kreditfaktura, betalningspåminnelse, förfrågan, inköpsorder, ett reklamationsbesked, en reklamation till leverantör eller en avvikelserapport förifylls **Ämne** och **Meddelande** ur din mall för dokumenttypen och dokumentets språk. Du kan fortfarande ändra texten i varje utskick. Mallen gäller bara dig — en kollega har sin egen.

Utan egen mall används Navs förvalda text, till exempel *Hej! Se bifogad offert OF-1001. Med vänliga hälsningar* och ditt namn på raden efter hälsningen.

Så ändrar du en mall:

1. Välj **Dokument** och **Språk** (**Svenska** eller **Engelska**). En mall du har ändrat är märkt *(egen)*.
2. Skriv **Ämne** och **Meddelande**. Klicka på en platshållare under **Infoga** för att lägga in den där markören står.
3. **Förhandsvisning med exempeluppgifter** visar mejlet ifyllt med ditt namn, företagets namn och påhittade uppgifter för dokumentet.
4. Klicka på **Spara**. **Ångra ändringarna** tar tillbaka det som är sparat, och **Återställ förval** tar bort din egen text så att Navs förvalda text gäller igen.

Platshållarna skrivs inom klammerparenteser och fylls i när dialogen öppnas:

| Platshållare | Blir | Finns för |
|---|---|---|
| `{nummer}` | Dokumentets nummer | Alla |
| `{avsändare}` | Ditt namn | Alla |
| `{företag}` | Företagets namn ur **Företagsinformation** | Alla |
| `{kund}` | Kundens namn | Offert, orderbekräftelse, faktura, kreditfaktura, påminnelse, reklamationsbesked |
| `{leverantör}` | Leverantörens namn | Förfrågan, inköpsorder, reklamation till leverantör |
| `{kontakt}` | **Er referens** på dokumentet | Offert, orderbekräftelse, inköpsorder |
| `{belopp}` | Beloppet med valuta: offertens summa exklusive moms, fakturans och kreditfakturans belopp inklusive moms, påminnelsens belopp kvar att betala | Offert, faktura, kreditfaktura, påminnelse |
| `{förfallodatum}` | Förfallodatum | Faktura, påminnelse |
| `{giltig}` | **Giltig t.o.m.** | Offert |
| `{leveransdatum}` | Leveransdatum | Orderbekräftelse, förfrågan, inköpsorder |
| `{offertnummer}` | Offerten som ordern kommer från | Orderbekräftelse |

En platshållare som inte finns för dokumenttypen, eller som är felstavad, kan inte sparas — mallen visar vilken det gäller. Saknar dokumentet uppgiften blir platshållaren tom, så skriv till exempel inte *Hej {kontakt}!* om Er referens ofta saknas. Belopp skrivs på dokumentets språk (*12 500,00 kr* på svenska, *12,500.00 SEK* på engelska) och datum som *2026-12-31*.

Konton med **Endast läsning** skickar inga dokument och kan därför inte ändra mallarna.

### E-postsignatur

Med en e-postsignatur får mejlen du skickar dina och företagets uppgifter under meddelandet, med företagets logotyp. Signaturen kommer med när du skickar en offert, orderbekräftelse, faktura, kreditfaktura, betalningspåminnelse, förfrågan, inköpsorder, ett reklamationsbesked, en reklamation till leverantör eller en avvikelserapport. Den gäller bara dig — en kollega har sin egen.

1. Slå på **Lägg till signaturen i mejlen jag skickar**.
2. Kryssa under **Ta med** i de uppgifter som ska stå i signaturen: **Namn**, **Befattning**, **Telefon**, **Mobil** och **E-post**. Befattning, telefon och mobil skriver du här. Namn och e-post kommer från ditt konto. Mallarna skriver redan ditt namn under hälsningen (`{avsändare}`), så kryssa bara i **Namn** om du har tagit bort det ur mallarna.
3. **Förhandsvisning** visar signaturen som mottagaren ser den. Välj **Engelska** för att se den på engelska.
4. Klicka på **Spara**.

Under dina uppgifter står företagets uppgifter och logotyp. Vilka av dem som tas med väljer en administratör under [Företagsinformation](/hjalp/system#foretagsinformation). En uppgift som inte är ifylld utelämnas.

Signaturen följer dokumentets språk. Mejl med ett dokument på engelska får engelska etiketter, till exempel *Phone* och *Reg. no*. Mejlet skickas med både en formaterad del och en ren textdel, så det går att läsa även i e-postprogram som bara visar text. Logotypen följer med i mejlet och visas bara om den är en PNG- eller JPEG-bild. I skickadialogen står *Din e-postsignatur läggs till under meddelandet.* när signaturen är påslagen. När ett misslyckat utskick skickas om från e-postloggen får mejlet signaturen hos den som skickade det första gången.

Konton med **Endast läsning** skickar inga dokument och har därför ingen e-postsignatur.

## Översikten

Startsidan visar materialflödet i fyra stationer — Inköp, Lager, Tillverkning, Försäljning — med antal öppna ordrar och varningar (försenade ordrar, negativa saldon). Varje station är klickbar: Inköp, Tillverkning och Försäljning öppnar modulens sida, och Lager landar direkt på saldolistan som stationens siffror beskriver. Under den finns:

- **Att bevaka** — en sammanfattning av [Aviseringar](/hjalp/aviseringar#att-bevaka-pa-oversikten): en rad per typ med antalet (negativa saldon, försenade ordrar, förfallna fakturor och annat som behöver åtgärdas) under områdesrubriker som **Inköp** och **Försäljning**, röda före gula inom området. En rad öppnar sidan Aviseringar vid den typen. **Visa alla (N)** öppnar sidan, och finns inget att bevaka står det "Inget att bevaka just nu." Typerna du ser beror på din behörighetsgrupp. Signalerna under stationerna ("2 försenade", "3 med negativt saldo") räknas ur samma aviseringar, så kortet och stationerna visar alltid samma sak. Saknar du behörighet till en typ står det "Se Aviseringar" i stället för en siffra. En order räknas som försenad när någon av raderna som inte är fullt mottagen/levererad har passerat sitt leveransdatum; offerter och levererade ordrar räknas aldrig.
- **Pågående tillverkning** och **Senaste lagerhändelser**.

Stationerna, raderna och knappen **+ Ny order** följer din behörighetsgrupp: det du inte får öppna visas som vanlig text i stället för som länk, och **+ Ny order** visas bara för den som kan öppna tillverkningsorderlistan.

### Anpassa Översikten

Knappen **Anpassa** i Översiktens sidhuvud, bredvid **+ Ny order**, öppnar dialogen **Anpassa Översikten**. Där väljer du själv vilka kort startsidan visar och i vilken ordning. Valet sparas på ditt konto och gäller bara dig — andra användare, även i samma behörighetsgrupp, behåller sin egen Översikt.

Standardvyn har fyra kort:

| Kort | Innehåll |
|---|---|
| **Materialflöde** | De fyra stationerna Inköp, Lager, Tillverkning och Försäljning |
| **Att bevaka** | Antalet per typ ur [Aviseringar](/hjalp/aviseringar), per område |
| **Pågående tillverkning** | De första pågående och frisläppta tillverkningsordrarna |
| **Senaste lagerhändelser** | De sex senaste lagerrörelserna |

Utöver dem kan du lägga till kortet **Favoriter** (dina [favoriter](#favoriter) som rutor, hela bredden) och följande kort. Varje kort finns bara med i dialogen om du får öppna listan som kortets **Se alla** leder till, till exempel kundorderlistan för **Leveranser denna vecka**:

| Kort | Innehåll | Se alla |
|---|---|---|
| **Leveranser denna vecka** | Bekräftade kundordrar och kundordrar under tillverkning vars nästa leveransdatum infaller senast på söndag, sena först | Kundorder |
| **Inleveranser denna vecka** | Inköpsordrar i status Utkast, Bekräftad eller Delvis mottagen vars nästa leveransdatum infaller senast på söndag (ett bekräftat datum går före det önskade), sena först. Under varje order står statusen, så att ett utkast som inte är skickat syns, och om leverantören har bekräftat den ([Bekräftat leveransdatum](/hjalp/inkop#bekraftat-leveransdatum)) | Inköpsorder |
| **Beläggning denna vecka** | Resurserna med planerad tid den här veckan, mest belastade först, med timmar mot kapacitet och procent | Beläggning |
| **Förfallna kundfakturor** | Samma rader som aviseringen med samma namn | Försäljning → Öppna poster |
| **Leverantörsfakturor att betala** | Samma rader som aviseringen med samma namn | Inköp → Öppna poster |
| **Offerter att följa upp** | Samma rader som aviseringen med samma namn | Offerter |
| **Öppna avvikelser** | Öppna reklamationer och avvikelser, de vars **Åtgärd senast** har passerat först | Avvikelser |

Korten visar högst sex rader, och **Visa alla (N)** när listan är längre. En röd prick betyder försenad: leveransdatumet har passerat, fakturan har förfallit, ärendets **Åtgärd senast** har passerat eller resursen är belagd över 100 %. En gul prick betyder i dag, snart eller minst 90 % beläggning. En resurs utan veckoschema visar timmarna utan procent ("inget schema"). Kan ett korts uppgifter inte läsas står det "Kunde inte läsa … just nu." i kortet, och resten av Översikten visas som vanligt.

Dialogen har en rad per kort. Kryssrutan **Visa** bestämmer om kortet visas, och knapparna ↑ och ↓ flyttar det i ordningen. **Spara** sparar valet, **Avbryt** stänger utan att spara och **Återställ standard** tar bort ditt val, så att de fyra korten i standardvyn visas i den ordning de har ovan. Ett nytt kort visas aldrig av sig självt — bara om du väljer det. Är inget kort valt står det "Inga kort valda." tillsammans med knappen **Anpassa**.

**Materialflöde** och **Senaste lagerhändelser** tar hela sidans bredd. Alla andra kort är halva kort: står två sådana efter varandra delar de en rad, och ett ensamt halvt kort tar hela bredden. Checklistan **Kom igång** (för administratörer) ligger kvar överst och styrs av sin egen knapp **Dölj**.

Översikten hämtar bara det korten du valt behöver. Döljer du **Materialflöde** och **Att bevaka** räknar sidan därför inte fram alla aviseringar, vilket gör den snabbare att öppna — korten för fakturor och offerter hämtar då bara sina egna. Konton med **Endast läsning** kan också anpassa sin egen Översikt.

## Lista och kort

Kundorder, Offerter, Inköpsorder, Förfrågningar, Tillverkningsordrar, Fakturor, Leverantörsfakturor, Artikelregister, Kunder och Leverantörer visas med en **smal lista** till vänster och det dokument du har valt till höger, så att du kan gå från dokument till dokument utan att lämna listan.

- Listan har ett sökfält, filterknappar och två rader per dokument: kundens eller leverantörens namn, numret med datum och status. Under en öppen inköpsorder står på en tredje rad om leverantören har bekräftat den. Längst ned står hur många som visas av hur många det finns, och fler rader hämtas när du rullar mot slutet.
- **Filterknapparna** har en knapp per status (under Artikelregister en per artikeltyp), och du kan välja **flera samtidigt**: **Utkast** och **Mottagen** visar ordrar med någon av de statusarna. Klicka på en vald knapp igen för att ta bort den, och **Alla** tar bort alla val. **Öppna** under Förfrågningar väljer alla öppna statusar på en gång och är markerad så länge de alla är valda. Under Kundorder, Inköpsorder och Tillverkningsordrar behövs ingen sådan knapp: där visas bara de öppna ordrarna tills du kryssar i **Visa avslutade** (se nästa punkt), så **Alla** är redan de öppna. **Sen** (och **Halvfabrikat sent** under Tillverkningsordrar) står för sig efter ett streck: de lägger inte till fler dokument, utan visar de sena bland statusarna du har valt, eller bland alla om ingen status är vald.
- **Visa avslutade:** Kundorder, Inköpsorder och Tillverkningsordrar visar från början bara ordrar som inte är avslutade. En order räknas som avslutad när allt är in- eller utlevererat: Kundorder döljer **Levererad**, **Fakturerad** och **Avbruten**, Inköpsorder **Stängd** (en inköpsorder stängs automatiskt när allt är mottaget), **Mottagen** och **Avbruten**, och Tillverkningsordrar **Klar**, **Stängd** och **Makulerad**; **Alla** betyder då alla andra statusar. Kryssa i **Visa avslutade** under knapparna (i tabellen bredvid statusmenyn) för att få med dem, och då kan du också välja dem som knappar. En levererad kundorder hittas fortfarande av **Fakturera** och [Samlingsfakturering](/hjalp/forsaljning#samlingsfakturering), och på en klar tillverkningsorder går det att efterrapportera fram till **Stäng order**. Hittar en sökning inget säger listan att avslutade ordrar visas med Visa avslutade. Exporten följer listan.
- I tabellen är statusfiltret en meny med samma val som kryssrutor. Knappen visar vad som är valt, till exempel **Utkast, Mottagen**, och **Visa alla** tar bort valen. Varje kryss gäller direkt.
- **Klicka på en rad** så visas dokumentet till höger, och raden markeras i listan. Listan står kvar med samma sökning, urval och rullning när du byter dokument.
- **+** överst i listan skapar ett nytt dokument, som **+ Ny kundorder**.
- **Visa som tabell** (knappen med rutnätet överst i listan) visar i stället den breda tabellen med alla kolumner, **Kolumner** och **Exportera**. **Visa som lista** i tabellens verktygsrad går tillbaka. Valet gäller den listan och sparas i webbläsaren. Tabellen visar samma sökning och samma filterval som listan hade. Öppnar du listan med ett filter, en sökning eller en genväg som **+ Ny kundorder**, till exempel från en favorit, visas tabellen.
- På **mobilen** och i smala fönster visas listan eller dokumentet, inte båda.
- I **Artikelregistret** visar högersidan en **sammanfattning** av artikeln: **I lager**, **Disponibelt** (i lager minus de öppna behoven), **Inkommande**, **Standardpris** med lagervärdet till standardpris, saldot per lagerplats (med **Flytta** till [Lagerflytt](/hjalp/lager#lagerflytt)) och de närmaste behoven och inleveranserna. **Öppna artikelkort** visar hela kortet med alla flikar, utan listan.

### Dokumentkorten

Kundorder, offert, inköpsorder och förfrågan har samma uppbyggnad:

- **Överst** står var du är (till exempel **Försäljning › Kundorder › KO-5008**, med länkar tillbaka) och knapparna för det som går att göra i dokumentets status, med huvudåtgärden sist.
- **Under den** står numret med status, kundens eller leverantörens namn som rubrik och dokumentets steg, där steget dokumentet står i är markerat.
- **Huvudet** ändras direkt på kortet. När du har ändrat något visas *Osparade ändringar i huvudet* med **Ångra ändringar** och **Spara** (eller **Ctrl+S**). Sällan använda fält ligger under **Fler uppgifter**.
- **Flikarna** delar upp resten av kortet: **Rader** först, sedan till exempel **Leverans**, **Dokument** och **Historik**. Fliken du väljer står i adressen.
- **+ Ny rad** sist i radlistan lägger till rader utan dialog: sök artikel, skriv antal (och pris), **Enter** lägger till och raden står tom för nästa. Ikonen **Fler fält…** öppnar dialogen **Lägg till rad** för det som inte ryms på raden.

## Listor: sök, filter och bläddring

Alla registerlistor (artiklar, kunder, leverantörer, ordrar, saldon, transaktioner, tidrapporter…) fungerar likadant:

- **Sökfältet** ovanför tabellen söker medan du skriver — t.ex. på artikelnummer/benämning eller ordernummer/namn beroende på lista.
- **Filterval** (artikeltyp, varugrupp, orderstatus…) ligger bredvid sökfältet.
- **Bläddring**: listan visar 50 rader åt gången som standard; under tabellen står "Visar X–Y av Z" med sidknappar.
- **Rader per sida**: bredvid "Visar X–Y av Z" finns valet **Rader per sida** (25/50/100/250). Valet sparas på ditt konto och gäller sedan alla listor du öppnar, tills du ändrar det igen.
- Sökning, filter och sida ligger i sidans adress — du kan bokmärka eller dela en filtrerad vy.
- **Kolumner** längst till höger ovanför tabellen väljer vilka kolumner listan visar. Kolumnen med numret eller namnet du klickar på och kolumnerna för kryssrutor och ⋯-menyn finns alltid kvar. Ikonen på knappen färgas när listan skiljer sig från hur den är byggd.
- **Kolumnbredd**: dra i kanten till höger om en kolumnrubrik för att göra kolumnen smalare eller bredare; dubbelklicka på kanten för att återställa den. Med tangentbordet: tabba till kanten och tryck **←** eller **→**. Ändringen gäller kolumnen tills du återställer den.
- **Kolumnordning**: för musen över rubrikraden så syns ett grepp framför varje rubrik som går att flytta — dra det till en annan rubrik (vänstra halvan lägger kolumnen före, högra efter); ett streck visar var den hamnar. I **Kolumner** gör pilarna **↑** och **↓** samma sak. Kolumnen med numret eller namnet och kolumnerna för kryssrutor och ⋯-menyn står kvar på sina platser.
- Valen av kolumner, bredder och ordning sparas på ditt konto för varje lista för sig — kundorder och offerter har till exempel var sin uppsättning — och följer med mellan datorer. **Återställ kolumnerna** i **Kolumner** ger tillbaka listan som den är byggd.
- **Täthet** i användarmenyn gäller alla tabeller i Nav: **Normal** eller **Kompakt**, som ger lägre rader så att fler får plats på skärmen. Valet sparas på ditt konto. På mobilen, där tabellerna visas som kort, ändras ingenting.

## Artikelväljaren

Där en artikel ska väljas (orderrader, tillverkningsorder, struktur) finns en **sökbar artikelväljare**: klicka i fältet så visas de första träffarna, skriv för att söka på artikelnummer eller benämning, välj med piltangenterna + Enter eller med klick.

## Vanliga knappar

| Knapp | Betydelse |
|---|---|
| **+ Ny …** | Öppnar formulär för att skapa en post |
| **Spara** | Sparar formuläret; "Sparat" visas vid lyckad sparning |
| **Ändra / Ta bort** | Radknappar i tabeller; Ta bort kräver bekräftelse |
| Namn/nummer i en lista | Öppnar postens kort eller detaljsida |

## Utskrifter

**Skriv ut** på ett dokument, en lista eller en etikett öppnar webbläsarens utskriftsdialog direkt, där du väljer skrivare — Nav väljer aldrig skrivare åt dig. Det fungerar likadant i webbläsaren och i den installerade appen (Chrome, Edge, Firefox). Knappen visar **Skriver ut…** medan PDF:en hämtas. **Ladda ner PDF** sparar i stället filen på datorn utan att skriva ut.

Vid etiketter och pallkort väljer du format i dialogen (**A4-ark** eller **Etikettskrivare**, se [Lager](/hjalp/lager)); skrivaren väljer du sedan i utskriftsdialogen, och där ska pappersstorleken stämma med formatet.

**Safari** på iPhone, iPad och Mac kan inte skriva ut en PDF på det sättet: där öppnas PDF:en i en ny flik, och du skriver ut med **Dela → Skriv ut** (iPhone/iPad) eller **Arkiv → Skriv ut** (Mac). Tillåt popup-fönster för Nav om fliken inte öppnas.

## Licens

Nav|ERP är fri programvara, © 2026 Urban Källefors, och sprids under **GNU General Public License version 3 eller senare** (GPL-3.0-or-later). Du får använda, sprida och ändra programmet enligt licensens villkor; det levereras utan garanti. Den fullständiga licenstexten finns i filen `LICENSE` i källkoden.

Färgtemat **Dracula** bygger på [Dracula-paletten](https://draculatheme.com) (© 2023 Dracula Theme) och används under MIT-licensen — licenstexten finns i `licenses/Dracula-MIT.txt`.
