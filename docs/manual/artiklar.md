# Artiklar

Artikelregistret är grunden för allt annat i Nav|ERP — lager, inköp, försäljning, tillverkning och kalkyl utgår från artikeln.

## Artikelregistret

Menyvalet **Artiklar** öppnar modulens sida med artikelregistret, importen och grunddata i ett rutnät. **Artiklar → Artikelregister** (`/artiklar/register`) listar alla artiklar med nummer, benämning, typ, **ABC** (klassen i [ABC-analysen](/hjalp/lager#abc-analys), **–** utanför klassningen), varugrupp, artikelkod, standardenhet, standardkostnad och status. Filtret **Alla ABC-klasser** begränsar listan till klass A, B eller C. Med rader markerade kan du lägga dem i din personliga lista med **Kopiera (N)**, och **Kopiera alla träffar** tar hela sökningen — se [Kopierat](#kopierat). Sök på artikelnummer/benämning och filtrera på **artikeltyp**, **varugrupp** eller **artikelkod** (se [Artikelkoder](#artikelkoder)).

Sökfältet går att använda helt från tangentbordet:

- Listan filtreras medan du skriver. **Enter** söker direkt utan att vänta, och träffarna ligger kvar i listan.
- **Pil ned** markerar första träffen, och fler tryck flyttar markeringen nedåt. **Pil upp** flyttar uppåt och tar bort markeringen från första raden. Den markerade raden får en grön ram.
- **Enter** på en markerad rad öppnar artikelkortet.
- **Esc** tar bort markeringen, och skriver du något nytt börjar du om.
- I läget **Redigera** gäller inte piltangenterna i sökfältet — där styr Enter och Esc cellerna.

### Skapa en artikel

1. Klicka **+ Ny artikel**.
2. Fyll i **benämning**, **typ** och **grundenhet** (standard `st`; enheterna kommer från registret under [Grunddata](/hjalp/grunddata)), och ev. **artikelnummer** (unikt).
3. Klicka **Skapa artikel** — artikelkortet öppnas direkt för vidare beredning.

#### Artikelnummer ur en nummerserie

Lämnar du **Artikelnummer** tomt får artikeln nästa nummer i den serie som står i **Nummerserie**. Under fältet står vilket nummer det blir, t.ex. "Tomt = nästa nummer i serien Plåt: PL-043". Serien är förvald efter varugruppen: har gruppen en egen serie (se [Varugrupper](#varugrupper)) används den, annars standardserien **Artikelnummer**. Väljer du en annan serie själv ligger den kvar även om du byter grupp. Skriver du ett eget artikelnummer används det, och serien rörs inte.

Nummer som redan finns — t.ex. importerade artiklar eller nummer som skrivits för hand — hoppas över, så serien ger alltid ett ledigt nummer. Är 10 000 nummer i rad upptagna räknas serien som full: under fältet står "Serien … är full — skriv ett eget nummer.", och en artikel utan eget nummer kan inte skapas ur den. Serierna ställs in under [System → Nummerserier](/hjalp/system#nummerserier).

#### Kopiera från befintlig artikel

En ny artikel kan ta med sig uppgifter från en befintlig artikel i stället för att allt fylls i från början.

1. Fyll i **Artikelnummer** och **Benämning** som vanligt — de tas alltid från formuläret, aldrig från förlagan.
2. Sök fram förlagan i fältet **Kopiera från** bredvid benämningen. Dialogen **Kopiera från *nummer* – *benämning*** öppnas med fyra kryssrutor, alla ikryssade från början:
   - **Information** — **Typ**, **Grundenhet**, **Standardkostnad**, **Varugrupp**, **Artikelkod**, **Huvudplats** och **Fantomartikel** förifylls i formuläret och kan ändras innan du sparar. Förlagans alternativa lagerplatser kopieras inte; en hyllplats är fysisk och hör till varan. Resten av uppgifterna på fliken Allmänt kopieras när artikeln skapas: inköps- och försäljningsenhet, försäljningspris, vikt och mått, förpackning och frakt (antal per kolli, kollityp, kolliart, stapelbar, pallplatser, flakmeter), ytbehandling och färg, planeringen (beställningspunkt, orderkvantitet, avrundning) samt de alternativa enheterna. Alternativa enheter och inköps-/försäljningsenhet följer bara med när den nya artikeln har samma grundenhet som förlagan. Den nya artikeln är alltid aktiv.
   - **Beredning** — strukturens komponenter och operationerna (med en lego-operations egen fil). Material som är kopplat till en operation kopplas till motsvarande operation på den nya artikeln.
   - **Inköp** — leverantörerna med huvudleverantör, leverantörens artikelnummer, pris, valuta, ledtid och stafflade priser.
   - **Ritningar och filer** — ritningsnummer och bifogade filer: filerna under fliken Filer och de aktiva ritningsrevisionernas filer, som vanliga filer på den nya artikeln (revisionerna kopieras inte). Äldre revisioners filer kopieras inte. Kopieras **Beredning** samtidigt följer operationernas valda ritningar med via ritningsnumret och de valda filerna som kopian av samma fil. Eftersom ritningsnumren kopieras utan revisioner får en operation med en vald ritning också kopian av ritningens aktiva revisions fil som vald fil — operationen visar då samma filer i terminalen och på tillverkningsorderns utskrift som förlagans.
3. Klicka **Kopiera**. Under fältet visas valet, till exempel *Kopierar: Information, Beredning*, med knapparna **Ändra** (öppnar dialogen igen) och **Ta bort** (kopierar ingenting — de förifyllda värdena ligger kvar som de står).
4. Klicka **Skapa artikel** (eller **Skapa och koppla** när formuläret öppnats från beredningen för att lägga in en ny komponent i strukturen). Artikeln och allt som kopieras sparas i ett svep: går något fel skapas ingenting.

Värden du själv anger i formuläret vinner alltid över förlagans.

**Typen styr vad som går att kopiera.** **Beredning** kopieras bara till tillverkade artiklar och **Inköp** bara till köpta artiklar och tjänster. I dialogen är en kryssruta som inte gäller avstängd med en kort förklaring. Den bedöms efter den typ artikeln får: när **Information** väljs första gången efter förlagans typ, som då förifylls, och annars (till exempel när du öppnar dialogen igen med **Ändra**) efter **Typ** i formuläret. Byter du **Typ** i formuläret efteråt kryssas en del som inte längre gäller ur, och raden under fältet förklarar varför (till exempel "Beredning kopieras bara till tillverkade artiklar"). Byter du tillbaka till en typ där delen gäller kommer den med igen.

Har den nya artikeln en annan **Grundenhet** än förlagan visas en förklaring under fältet: alternativa enheter och inköps-/försäljningsenhet kopieras inte, och leverantörspriser, strukturens antal och operationstider gäller per grundenhet och kopieras som de är.

**Kopieras aldrig:** lagersaldo, historik, revisioner (även ritningsnumrens revisioner), kundpriser, prislisterader, konfiguratormall samt leverantörsfakturor och order.

### Redigera direkt i listan

Med behörigheten **Artiklar** finns knappen **Redigera** bredvid **+ Ny artikel**. Listan är skrivskyddad tills du trycker på den; då blir kolumnerna **Benämning**, **Typ**, **Varugrupp** och **Standardenhet** redigerbara direkt i registret (varugruppen väljs bland varugrupperna, **— Ingen —** tar bort varugruppen; artikelkoden ändras på artikelkortet). Övriga kolumner är läsbara som vanligt, och artikelnummer ändras på artikelkortet. Redigeringsläget gäller även när du söker eller byter sida, tills du trycker **Avsluta redigering** (med osparade ändringar frågar systemet först) eller sparar utan fel — då går listan tillbaka till visningsläget.

- En ändrad cell markeras med en ram i accentfärgen. Ändrar du tillbaka till det sparade värdet försvinner ramen. En tömd **Benämning** sparas inte — raden får felet "Benämning måste anges".
- Längst ned visas fältet **N rader ändrade** med knapparna **Spara ändringar** och **Ångra**. **Ångra** återställer alla osparade ändringar.
- **Enter** flyttar till samma kolumn på nästa rad, **Tab** och **Skift+Tab** flyttar mellan fälten och **Esc** återställer den cell du står i.
- **Spara ändringar** sparar alla ändrade rader i ett anrop, men varje rad för sig: lyckade rader sparas och släpper sin markering, medan en rad som nekas (till exempel en konfiguratormall vars typ inte tillåts, eller en artikel med alternativa enheter där standardenheten inte kan bytas) behåller sin ändring och visar felet under benämningen. Rätta raden och spara igen, eller tryck **Esc**/**Ångra**. Så länge någon rad har nekats stannar listan i redigeringsläget.
- Har du osparade ändringar och försöker söka, filtrera, byta sida, öppna en annan sida (till exempel ett artikelkort) eller stänga fliken frågar systemet **Du har osparade ändringar — lämna ändå?**. **Lämna sidan** släpper ändringarna, **Avbryt** stannar kvar.

### Artikeltyper

| Typ | Användning |
|---|---|
| **Tillverkad** | Tillverkas internt via tillverkningsorder; har struktur (BOM) och rutt |
| **Köpt** | Köps in via inköpsorder |
| **Tjänst** | Lagerförs inte — arbete, inte gods |

**Byta typ till Tjänst.** En artikel kan bara bli en tjänst när den saknar lagersaldo — på alla lagerplatser, även [spärrade](/hjalp/lager#sparrade-lagerplatser), och plus på en plats tar inte ut minus på en annan. Annars nekas ändringen med *Artikeln har lagersaldo — justera saldot till 0 innan den görs till tjänst.*, både på kortet och när du redigerar direkt i listan. Nolla saldot med en lagerjustering först.

**Tjänster lagerförs aldrig.** En tjänst kan köpas på en inköpsorder, säljas på en kundorder och stå i en struktur, men den får aldrig något lagersaldo: inleveransen räknar upp inköpsorderns rad, utleveransen kundorderns rad och en tillverkningsorder bokar tjänsten som förbrukad — utan någon lagerrörelse. Lagerjustering, lagerflytt och inventering tar inte tjänster (*Artikeln … är en tjänst — tjänster lagerförs inte*). Hade en tjänst ett saldo från tiden före regeln (november 2026) nollades det vid uppdateringen med en justering i lagerloggen (*Tjänster lagerförs inte — saldot nollat vid uppdateringen*); rörelserna före det står kvar som historik.

**Fantomartikel:** en artikel som aldrig lagerhålls utan alltid "löses upp" till sina komponenter vid tillverkning och kalkyl — typiskt en modul/underrede i en konfigurerbar produkt. Markeras med fantomflaggan på artikeln och visas som "Fantom" i register och strukturer.

Alla fält är redigerbara i efterhand, även artikelnummer, typ och fantomflagga (dubbletter av artikelnummer avvisas).

## Artikelkortet

Klicka på ett artikelnummer i registret för att öppna artikelkortet, som är uppdelat i flikar.

Vilka flikar som visas beror på artikelns **typ**:

- **Tillverkad**: Allmänt, Konfigurator, Beredning, Lager, Kalkyl, Revisioner och Filer.
- **Köpt**: Allmänt, Inköp, Lager, Kalkyl, Revisioner och Filer — fliken **Inköp** ersätter Beredning, som bara gäller tillverkade artiklar.
- **Tjänst**: Allmänt, Inköp, Kalkyl, Revisioner och Filer — tjänster lagerhålls inte och saknar därför både Lager och Beredning.

Längst upp på kortet finns ett artikelhuvud som ligger kvar oavsett vilken flik du är på, med fyra fält:

- **Artikelnummer** är en sökbar väljare — skriv artikelnummer eller benämning och välj en träff för att hoppa direkt till den artikelns kort, utan att gå tillbaka till registret.
- **Benämning** — artikelns benämning.
- **Artikeltyp** — Tillverkad, Köpt eller Tjänst, alltså typen som avgör vilka flikar kortet har. Är artikeln en fantomartikel eller inaktiv visas det som en märkning här.
- **Lagersaldo** visar artikelns totala saldo (summan av alla lagerplatser, i grundenheten). Står en del av saldot på [spärrade lagerplatser](/hjalp/lager#sparrade-lagerplatser) visas **varav spärrat** under siffran (bara plussaldon där; ett minus på en spärrad plats räknas som brist). Uppdelningen per lagerplats finns på fliken [Lager](#lager), där en spärrad plats är märkt **Spärrad**.

Benämning, artikeltyp och fantom-/aktivflaggan ändras på fliken [Allmänt](#allmant), inte i huvudet.

### Allmänt

Grunduppgifterna är grupperade i sektioner:

- **Identitet** — artikelnummer, typ, benämning, **Extra benämning** (flerradig fritext, max 2 000 tecken), **Varugrupp**, den skrivskyddade **Momssats** som följer varugruppen, **Artikelkod**, fantomflagga, **Ytbehandling** och **Färg** (fria textfält, max 200 tecken), **Streckkod (EAN)** och aktiv/inaktiv. Streckkoden är tillverkarens kod på förpackningen (EAN/GTIN, 8, 12, 13 eller 14 siffror med rätt kontrollsiffra) och gör att varan hittas när den skannas, se [Skanna](/hjalp/lager#skanna). Samma kod kan bara finnas på en artikel. En kod jämförs som GTIN: en UPC-A-kod med 12 siffror och samma kod som EAN-13 med en inledande nolla (och som GTIN-14 med nollor framför) är samma kod — vid skanning hittas artikeln i vilken form koden än läses, och en annan artikel kan inte få samma kod i en annan form. Koden sparas som du skriver den. Fältet kan också fyllas i med artikelimportens kolumn **EAN**.
- **Enheter** — grundenhet, inköpsenhet och försäljningsenhet.
- **Försäljning** — **Försäljningspris (kr)**, artikelns grundpris vid försäljning (kr per grundenhet). Grundpriset är sista steget i kundprisernas priskedjan (kundens egen prisregel → kundens prislista → grundpriset) och förifyller à-priset på offert-/kundorderrader när inget mer specifikt pris finns — se [Kundpriser](/hjalp/forsaljning#kundpriser) i Försäljning.
- **Vikt & mått** — **Vikt (kg)** och måtten **Längd**, **Bredd** och **Höjd** i millimeter (nettovikt och yttermått, för volym och transport).
- **Förpackning** — **Antal per kolli** (i artikelns grundenhet, t.ex. 48 st per pall) och **Kollityp** som väljs ur kollityp-registret under [Grunddata](/hjalp/grunddata) (t.ex. EUR-pall). Används för kolliförslaget vid transportbokning (se punkten **Frakt** nedan).
- **Frakt** — styr hur artikeln blir kollin på en [försändelse](/hjalp/forsaljning#frakt). Fraktsättet härleds och visas som text överst i sektionen: **Förpackning** när både kollityp och **Antal per kolli** är ifyllda, annars **Egna mått** när artikelns mått finns, annars **Inget fraktsätt** (vikten hamnar då på en rad av typen Övrigt). Fälten är **Kolliart (egna mått)** (Paket eller Pall), **Pallplatser** (ger **Flakmeter** = pallplatser × 0,4 när Flakmeter är tomt), **Flakmeter** och **Stapelbar**.
- **Kalkyl** — standardkostnad.
- **Alternativa enheter** — extra enheter med omräkningsfaktor (se nedan).

**Historik** under **Försäljningspris (kr)** och bredvid **Spara standardkostnad** visar hur priset har ändrats: en rad per ändring med **Från och med** (datum och tid) och värdet, nyast först. Alla ändringar kommer med, oavsett om de gjordes på kortet, med **Sätt standardpris**/**Sätt försäljningspris** från en kalkyl, med massändring eller med import. Ett rensat försäljningspris visas som **inget pris**. Historiken för försäljningspriset börjar när funktionen infördes; standardkostnadens har förts sedan lagervärderingen per datum infördes. Tidigare värden är okända.

Identitet, Enheter, Försäljning, Vikt & mått, Förpackning och Frakt sparas tillsammans med knappen **Spara**. Kalkyl och Alternativa enheter är egna block med egna knappar — en linje skiljer blocken åt, och varje knapp sparar blocket ovanför sig. **Spara** skickar bara de fält du har ändrat, så ett försäljningspris som satts från Kalkyl under tiden skrivs inte tillbaka. Osparade ändringar visas med *Osparade ändringar* vid knappen, finns kvar om du byter flik till Lager och tillbaka, och lämnar du kortet — även via artikelväljaren i huvudet — frågar Nav först. Byter du **Grundenhet** utan att spara räknas alternativa enheter fortfarande mot den sparade grundenheten; spara först.

**Momssats** (25/12/6/0 %) är artikelns momssats vid försäljning — fakturarader ärver den som förval. Den kan inte ändras på artikeln utan följer **Varugrupp**: gruppens momssats, eller 25 % för en artikel utan varugrupp. Se [Varugrupper](#varugrupper).

Artikelns lagerplatser ställs in på fliken [Lager](#lager), under **Lagerplatser**. Vid **Ny artikel** heter fältet **Huvudplats**; väljs ingen plats sätts reservplatsen **`***`** automatiskt, och den räknas som ingen huvudplats (se [Lager](/hjalp/lager)).

**Ytbehandling** och **Färg** skrivs ut som en rad under artikelnamnet ("Ytbehandling: … · Färg: …", bara ifyllda fält tas med) på förfrågan och inköpsorder (bara på lego-rader) samt på offert och orderbekräftelse (alla rader). De skrivs aldrig ut på fakturan.

**Benämning (engelska)** och **Extra benämning (engelska)** ligger direkt under sina svenska motsvarigheter på fliken **Allmänt** och används på dokument som skrivs på engelska (när kundens eller leverantörens **Språk** är **Engelska**, se [Dokument på engelska](/hjalp/forsaljning#dokument-pa-engelska)). Är fältet tomt skrivs den svenska texten även på engelska dokument; svenska dokument visar aldrig de engelska fälten. Fälten finns inte i dialogen **Ny artikel**, men kan fyllas i via artikelimportens kolumner (se [Importera artiklar](#importera-artiklar)) och kopieras med **Kopiera från**.

**Extra benämning** är en flerradig fritext (radbrytningar behålls) som skrivs ut under artikelnamnet, direkt efter raden med ytbehandling och färg, på de dokument som är valda under **System → Inställningar**, avsnittet **Extra benämning på dokument** (se [Inställningar](/hjalp/system#installningar)): Förfrågan, Inköpsorder, Offert, Orderbekräftelse, Plocklista, Följesedel, Faktura och Tillverkningsorder. Inget dokument är valt från början. Texten läses från artikeln när dokumentet skrivs ut, så en ändring slår igenom på nästa utskrift; en utfärdad faktura behåller dock den text den hade när den utfärdades. Fältet finns bara på artikelkortet, inte i dialogen **Ny artikel**, men **Kopiera från** med **Information** kopierar det till den nya artikeln.

#### Enheter

En artikel har alltid en **grundenhet** — allt lagersaldo och alla lagrade antal räknas i den. Utöver grundenheten kan artikeln ha **alternativa enheter** med omräkningsfaktor, i sektionen **Alternativa enheter** längst ner på fliken:

1. Välj enhet under **Lägg till enhet** (grundenheten och redan tillagda enheter kan inte väljas igen).
2. Ange faktorn i fältet **1 {grundenhet} =** — t.ex. väger en st-artikel 5 kg per styck anges `5` på kg-raden. Den omvända riktningen visas direkt som hjälptext (`1 kg = 0,2 st`).
3. Klicka **Lägg till**. Faktorn kan ändras i efterhand (**Spara** visas när den ändrats) och raden tas bort med **Ta bort**.

Fälten **Inköpsenhet** och **Försäljningsenhet** väljer vilken enhet som förifylls på inköps- respektive kundorderrader för artikeln — grundenheten eller en av de alternativa enheterna. Enheten går alltid att byta per orderrad, med automatisk omräkning av antal och à-pris (se [Inköp](/hjalp/inkop) och [Försäljning](/hjalp/forsaljning)).

Regler:

- **Grundenheten är låst** så länge artikeln har alternativa enheter — faktorernas betydelse skulle annars ändras i tysthet. Ta bort de alternativa enheterna först om grundenheten måste bytas.
- En alternativ enhet som är vald som inköps- eller försäljningsenhet kan inte tas bort förrän valet ändrats.
- Befintliga orderrader påverkas inte av senare faktorändringar — radens faktor låses när raden skrivs.

### Konfigurator

Fliken **Konfigurator** (för tillverkade artiklar, bredvid Allmänt) gör artikeln till en **mall** som kunden kan konfigurera: du sätter upp valgrupper, regler och priser, och kan direkt prova hur det beter sig. Behörigheten att ändra är samma som för resten av artikelkortet.

Har artikeln ingen mall visas en förklaring och knappen **Gör konfigurerbar**. Du väljer ett **Läge**:

- **Variantartiklar** — varje kombination av val blir en egen, lagerförd artikel (se [Varianter](#varianter)). Kräver en tillverkad artikel (*Variantartiklar kräver en tillverkad artikel*) som inte är fantom.
- **Beställningsvara** — artikeln ligger kvar som den är och säljs med valen på orderraden: säljaren konfigurerar den i dialogen **Konfigurera** på offert/kundorder, raden får valen, etiketterna och prisuppdelningen sparade, och samma mall kan ligga flera gånger på en order med olika val (se [Försäljning](/hjalp/forsaljning#kundorder)). Raden kan tillverkas: **Skapa TO** på kundorderraden, **+ Ny tillverkningsorder** (med **Konfigurera**) och [behovsberäkningens](/hjalp/tillverkning#konfigurerade-kundorderrader) sektion **Konfigurerade kundorderrader** tar valen med sig och tillverkningsordern visar **Lagervärde vid inleverans** ur förkalkylen — se [Tillverkningsorder för beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara). Inköp av mallen förblir spärrat: den visas inte i artikelväljaren på inköpsorder och förfrågan. Kräver en tillverkad artikel; fliken Konfigurator finns därför bara på tillverkade artiklar.

En fantomartikel kan aldrig vara mall, och ett typbyte på en mallartikel som skulle bryta läget vägras. Läget ändras med **Ändra** och mallen tas bort med **Ta bort konfigurator** (valgrupper och regler försvinner, artikeln blir en vanlig artikel). **Grundpris** är artikelns försäljningspris i blocket Försäljning på fliken [Allmänt](#allmant); saknas det visas varningen *Grundpris saknas — ange försäljningspris på artikeln*.

Kryssrutan **Visa i API** (hjälptext: *Mallen syns för externa system via API:t (System → Integrationer)*) publicerar mallen för externa system — sparas direkt; mallens rad **Läge** får då etiketten **API**. Bara publicerade mallar på aktiva artiklar syns för API-klienter; se [Konfigurator-API](/hjalp/system#konfigurator-api).

I **Testa konfiguration** och dialogen **Konfigurera** gäller att en grupp du inte rört får sitt förval, medan **— Välj —** (eller ett tömt måttfält) tömmer gruppen så att förvalet inte används — också när du öppnar en sparad rad med **Ändra konfiguration**.

#### Valgrupper

Under **Valgrupper** lägger du till grupper med **Lägg till valgrupp** och väljer först **Sort**:

- **Listval** — kunden väljer ett av flera alternativ. Fält: **Kod**, **Namn** och **Obligatorisk**. Spara gruppen och lägg sedan till **Alternativ** i samma dialog med **Kod**, **Namn** och **Tillägg** (pristillägg), och markera **Aktiv** och **Förval**. Ett inaktivt alternativ kan inte längre väljas men finns kvar i mallen och i reglerna.
- **Ja/nej** — en kryssruta. Fält: **Kod**, **Namn** och **Pristillägg** som läggs på när rutan är ikryssad.
- **Mått/tal** — ett tal inom ett intervall. Fält: **Kod**, **Namn**, **Obligatorisk**, **Enhet**, **Min**, **Max**, **Steg** (lämna tomt för fri inmatning), **Förval**, **Pris per enhet** och **Räknas över**. Högst fyra decimaler. Förvalet måste ligga inom intervallet och, med **Steg**, exakt på ett steg räknat från **Min** — annars vägrar dialogen med *Förvalet ska ligga på ett steg räknat från min*.

**Kod** består av stora bokstäver A–Z och siffror 0–9, högst 20 tecken, och är unik per mall (alternativkoden unik per grupp). Ordningen ändras med **Upp** och **Ned**. En grupp eller ett alternativ som en regel använder kan inte tas bort förrän regeln har ändrats eller tagits bort.

#### Regler

Under **Regler** styr du vilka kombinationer som går. **Lägg till regel** öppnar en byggdialog med **Villkor** (rader med **Grupp**, **Operator** och **Värde**, fler rader med **+ Villkor** — alla villkor måste gälla samtidigt; utan villkor gäller regeln alltid), en **Effekt**, ett **Mål** och ett obligatoriskt **Meddelande** som visas för användaren. Varje regel visas som en läsbar rad med meddelandet efter tankstrecket; **Aktiv** stänger av en regel utan att ta bort den, och **Upp**/**Ned**, **Ändra** och **Ta bort** finns per rad. Operatorerna beror på gruppens sort: *är* och *är inte* för listval, *är vald* och *är inte vald* för ja/nej, och =, ≠, <, ≤, > och ≥ för mått. Flera alternativ i ett villkor betyder "något av dem".

Tre effekter:

- **Utesluter** — tar bort alternativ ur en listvalsgrupp. Exempel: *Om Ytbehandling är Elpolerad → utesluter Lock: C*. Ett uteslutet alternativ går inte att välja i **Testa konfiguration**, och har du själv valt ett uteslutet alternativ får gruppen regelns meddelande som fel. Ett förval som reglerna utesluter töms i stället (gruppen blir tom), och är gruppen obligatorisk ber konfigurationen om ett nytt val. Ett förval som finns kvar efter regelns första genomgång ger felet.
- **Kräver** — ett målvillkor måste vara uppfyllt när villkoren gäller, annars får målgruppen meddelandet som fel. Exempel: *Om Hjul är vald → kräver Underrede är vald*. Utan villkor blir det *Alltid → kräver Underrede är vald*.
- **Begränsar** — snävar in intervallet (**Min** och/eller **Max**) för en måttgrupp. Exempel: *Om Ytbehandling är Elpolerad → begränsar Bredd till högst 2400 mm* och *Om Hjul är vald → begränsar Bredd till 900–2400 mm*. Blir intervallet tomt får gruppen meddelandet som fel.

Regler ändrar aldrig kundens val; de stänger alternativ, snävar in gränser och ger fel. Ett förval som reglerna utesluter töms i stället för att ge fel, och är gruppen obligatorisk kräver konfigurationen då ett nytt val; ett förval som finns kvar efter regelns första genomgång ger regelns fel. **Målgruppen kan inte stå i regelns egna villkor** — sådana grupper är avstängda i målets gruppval. För ett mått med **Steg** måste värdet ligga exakt på ett steg från **Min**.

#### Pris

Priset är **grundpriset** (artikelns försäljningspris) plus **tilläggen**: ett valt listvalsalternativs **Tillägg**, en ikryssad ja/nej-grupps **Pristillägg**, och för ett mått **Pris per enhet** gånger det som överstiger **Räknas över** (aldrig negativt). Tillägg på 0 visas inte. Saknas grundpris blir priset tomt, aldrig 0. Anger du en **Kund** gäller kundens prislista eller kundpris i stället för grundpriset, och kundens rabatt gäller på hela summan (grundpris plus tillägg).

#### Struktur och rutt per val

Under **Struktur per val** och **Rutt per val** lägger du till komponenter och operationer som bara gäller för vissa val. Mallens vanliga struktur och rutt (fliken Beredning) ändras aldrig härifrån.

- **Lägg till strukturrad:** ange **Villkor** (utan villkor gäller raden alltid), välj **Komponent** som **Artikel** eller **Från val** (komponenten är då den artikel som valt alternativ pekar på), **Antal** som **Fast** eller **Formel**, valfri **Operation** och en **Anteckning**. Raderna kan flyttas med **Upp** och **Ned**; ordningen styr hur strukturen visas.
- **Lägg till operation:** ange **Nr**, **Villkor**, **Resurs**, **Beskrivning** samt **Ställtid** och **Stycktid** som **Fast** eller **Formel**. Väljer du en legoresurs anger du även **Ställpris (kr)** och **Styckpris (kr/st)**.
- På alternativen i en valgrupp kan du välja en **Artikel**; den används av strukturrader med **Från val**.
- En kod som en formel använder kan inte bytas, och en grupp eller ett alternativ som en strukturrad, operation eller formel använder kan inte tas bort.
- En villkorad operation som en strukturrad är kopplad till (fältet **Operation**) följer med när operationens villkor gäller. Gäller de inte, ingår operationen inte och materialet dras vid slutrapporteringen som okopplat material.
- En strukturrad kan inte kopplas till en **Kalkyl**-operation i mallens rutt — de finns inte i fältet **Operation** ("Operationen är en kalkyloperation och kan inte dra material"). Märks operationen **Kalkyl** efter att raden kopplats, visas kopplingen med tillägget *(kalkyl)* tills du byter den, materialet dras vid slutrapporteringen som okopplat material, och **Testa konfiguration** och förhandsgranskningen under **Skapa varianter** visar en varning.
- **Varning för saknad strukturrad.** Strukturrader vars villkor bara skiljer sig i alternativet för en valgrupp hör ihop, till exempel ett lackerat lock per färg (*Typ av lock är Lock* och *Färg är Svart*, *Färg är Silver* …). Har minst två sådana rader något aktivt alternativ i gruppen som ingen av dem täcker, visas en varning ovanför **Struktur per val**, till exempel *Färg: alternativet Blå saknar strukturrad om Typ av lock är Lock — strukturrad 1, 2 och 3 täcker de övriga alternativen*. Det händer typiskt när ett nytt alternativ läggs till i gruppen men dess delar glöms bort. Varningen visas också under **Testa konfiguration** och i förhandsgranskningen under **Skapa varianter** när det valda alternativet saknar sin rad. Det är bara en varning — varianten skapas ändå, utan den delen. En ensam villkorad rad (till exempel en dekal bara för svart) ger ingen varning, och regler som gör en kombination omöjlig tas inte med i bedömningen.
- Mallens egen kalkyl på fliken **Kalkyl** gäller bara de delar som alltid ingår (mallens vanliga struktur och rutt). Villkorade operationer som är legoresurser prissätts från sitt eget **Ställpris (kr)** och **Styckpris (kr/st)**. Den fullständiga kalkylen för ett visst val ser du under **Testa konfiguration**.

#### Formler

En formel kan ge **Antal** på en strukturrad samt **Ställtid** och **Stycktid** på en operation. Den använder valgruppernas koder, till exempel `BREDD`: ett mått ger sitt tal, en ja/nej-grupp ger 1 (valt) eller 0, och ett listval får bara jämföras med en citerad alternativkod, som `FARG = "EP"`. Skiftläge spelar ingen roll i koderna.

| Syntax | Betydelse |
|---|---|
| `1,5` eller `1.5` | tal med decimalkomma eller decimalpunkt |
| `+ - * /` och parenteser | räknesätt; `*` och `/` binder hårdare än `+` och `-` |
| `min(a; b; …)`, `max(a; b; …)` | minsta respektive största av minst två värden |
| `avrunda(x)` | närmaste heltal |
| `avrunda(x; n)` | `x` avrundat till `n` decimaler (0–4) |
| `avrunda_upp(x; steg)` | uppåt till närmaste multipel av steget |
| `avrunda_ned(x; steg)` | nedåt till närmaste multipel av steget |
| `om(jämförelse; a; b)` | `a` om jämförelsen gäller, annars `b` |

`avrunda` avrundar en halva bort från noll (`avrunda(-2,5)` ger −3), och `avrunda_upp`/`avrunda_ned` behandlar negativa tal symmetriskt: uppåt är alltid mot det större talet (`avrunda_upp(-1,3; 0,25)` ger −1,25 och `avrunda_ned(-1,3; 0,25)` ger −1,5).

Argument skiljs med semikolon, så att decimalkomma alltid är entydigt. Jämförelserna `=`, `<>`, `<`, `<=`, `>` och `>=` får bara stå som första argument i `om`. En formel får vara högst 500 tecken och högst 32 nivåer djup. Resultatet avrundas till 4 decimaler.

Exempel:

- `BREDD * DJUP / 1000000` — yta i kvadratmeter när måtten är i millimeter
- `avrunda_upp(BREDD / 600; 1)` — antal lister med en lista per påbörjade 600 mm
- `om(FARG = "EP"; 12; 8)` — 12 om färgen är EP, annars 8
- `max(BREDD; 800)` — aldrig mindre än 800

De vanligaste felen, som visas under formelfältet med position:

- *Okänd kod* — koden finns inte som valgrupp i mallen.
- En valgruppskod som bara består av siffror kan inte användas i en formel — byt kod på valgruppen.
- Tal skrivs utan exponent: `1E308` läses som en (okänd) kod.
- Ett listval används i räkning, eller ett mått jämförs med en citerad kod. Ett listval jämförs bara med `=` eller `<>`.
- Fel antal argument, eller en jämförelse utanför `om`.
- Decimalerna i `avrunda` är inte ett heltal 0–4, eller steget i `avrunda_upp`/`avrunda_ned` är inte större än 0.
- Division med noll, eller ett mått som saknar värde (*BREDD saknar värde*) när konfigurationen provas.
- Ett **Antal** som blir 0 eller negativt, eller en negativ tid. Vill du att raden inte ska vara med, uttryck det med ett **Villkor**, inte med formeln.

#### Testa konfiguration

Längst ned på fliken bygger **Testa konfiguration** ett formulär av grupperna: listval är en rullista med **— Välj —** (alternativ som en regel stänger visas som *(ej valbart)*), ja/nej är en kryssruta och mått är ett talfält där intervallet visas som hjälptext (komma eller punkt går bra). Varje ändring utvärderas direkt; ett halvskrivet tal som *12,* utvärderas först när det är komplett, och tills dess står föregående resultat kvar. Du ser **Giltig** eller **Ogiltig**, felen under respektive grupp, prisuppdelningen — **Grundpris**, ett tillägg per rad och **Totalt**, och har kunden rabatt dessutom **Rabatt** med procent och belopp samt **Att betala** — samt varningar. För en giltig konfiguration visas dessutom en **Nyckel** som identifierar just den kombinationen. Fältet **Kund (valfritt)** visar kundens pris.

Under priset finns fältet **Antal** (standard 1, komma eller punkt) och knappen **Visa struktur och kalkyl**, som är aktiv först när konfigurationen är **Giltig**. Knappen härleder strukturen för just det valet och antalet och visar:

- **Material** med artikelnummer, benämning, antal med enhet och operation. Rader som kommer från listan **Struktur per val** märks **Villkorad**.
- **Operationer** med nr, resurs, beskrivning, ställtid och stycktid. En operation som bara räknas i kalkylen märks **Bara kalkyl**, och legoresurser visar sitt ställpris och styckpris.
- Fel och varningar från härledningen. Går strukturen inte att härleda står det *Konfigurationen är inte giltig*.
- **Förkalkyl** för antalet: material, operationer (lön och lego), påslag (MO och LO), **Tillverkningskostnad** totalt, **Tillverkningskostnad per st**, **TO-påslag** och **Materialpåslag** — de två sista ligger utanför tillverkningskostnaden och läggs på försäljningspriset, se [System & inställningar](/hjalp/system#kalkyler).

Ändrar du valet, kunden eller antalet efter visningen märks resultatet *Struktur och kalkyl gäller ett tidigare val — klicka Visa struktur och kalkyl igen*.

I läget **Variantartiklar** finns dessutom knappen **Skapa variant** bredvid **Visa struktur och kalkyl**, se [Skapa variant](#skapa-variant).

> I läget Beställningsvara läggs mallen på offert och kundorder med valen på raden — se [Försäljning](/hjalp/forsaljning#kundorder).

#### Varianter

I läget **Variantartiklar** visar avsnittet **Varianter** (ovanför Testa konfiguration) mallens lagerförda varianter: **Artikelnummer** (länk till variantens artikelkort), **Benämning**, **Försäljningspris**, **Standardpris**, **Saldo** och **Aktiv**. Finns inga står det *Inga varianter ännu*. Varianterna skapas med **Skapa varianter** eller **Skapa variant**.

Varje variant är en egen tillverkad artikel som du kan lägga på order, planera och tillverka som vilken annan artikel som helst. Väljer du mallen på en offert, kundorder eller ny tillverkningsorder öppnas **Konfigurera**, och raden får varianten. På inköpsorder och förfrågan är mallen dold — välj varianten direkt.

- **Artikelnummer** blir mallens nummer följt av en del per valgrupp, åtskilda med `-`: alternativets kod för listval, gruppens kod för ett valt ja/nej och måttet med decimalkomma för mått (till exempel `63000-B-RD-1200`). Högst 50 tecken.
- **Benämning** blir mallens namn följt av en del per val, åtskilda med komma (till exempel *Papperskorg 50 l, Lock B, Röd, Bredd 1200 mm*). Högst 255 tecken.
- **Försäljningspris** är konfiguratorns pris för valet före eventuellt kundpris. Saknar mallen grundpris lämnas priset tomt och en varning visas.
- **Standardpris** är förkalkylens tillverkningskostnad per styck vid **Kalkylantal**. Saknas kostnad lämnas det tomt, aldrig 0.

Varianten får mallens grunduppgifter (som när du kopierar Information från en artikel), den härledda strukturen och rutten för just valet, men **inte** ritningar eller filer, revisioner, leverantörskatalog eller kundpriser.

**Variantens pris.** När en variant prissätts på en offert eller order gäller kundens avtal på **mallen**: har kunden en egen prisregel eller en prislisterad för själva varianten vinner den som vanligt, annars räknas priset som kundens pris på mallen (kundens prisregel, kundgruppsregel, prislista eller mallens försäljningspris, plus kundrabatt) med variantens tillägg. Går mallen inte längre att utvärdera med variantens val — till exempel efter en regeländring — eller saknar mallen grundpris, används variantens eget **Försäljningspris** enligt den vanliga [priskedjan](/hjalp/forsaljning#priskedjan). Staffel på mallens pris följer radens antal.

**Fyller artikelns fält.** I dialogen för en valgrupp av typen Listval kan du välja *—*, *Färg* eller *Ytbehandling*. Då får varianten det valda alternativets namn i fältet Färg respektive Ytbehandling på artikelns Allmänt-flik. Varje fält kan kopplas till högst en grupp per mall; saknas koppling gäller mallens eget värde.

**Kodlåset.** När en grupps eller ett alternativs kod används av en variant går den inte att ändra, eftersom koden ingår i variantens artikelnummer (*Koden används av varianter och kan inte ändras*). Detsamma gäller koder som används av en konfigurerad orderrad på en beställningsvara — raden finns kvar oavsett orderns status, så koden är låst så länge raden finns. En använd grupp kan inte tas bort, och ett använt alternativ kan inte tas bort men kan inaktiveras. En grupp som är tom på varianten eller raden (inget val, eller Nej på en ja/nej-grupp) räknas inte som använd: den kan byta kod eller tas bort, och varianten och raden fungerar som förut. Priser, gränser, regler, struktur, namn och nya grupper kan du ändra fritt — variantartiklarnas egna fält (även deras sparade Försäljningspris) påverkas inte, men priset på en ny orderrad följer mallens aktuella priser via variantens priskedja (se *Variantens pris*). En mall som har varianter kan varken byta läge eller tas bort.

#### Skapa varianter

Knappen **Skapa varianter** (kräver behörighet att ändra artiklar) skapar flera varianter på en gång:

1. För varje valgrupp väljer du vilka värden som ska ingå. Listval har en kryssruta per aktivt alternativ (alla ikryssade från början), ja/nej har **Med** och **Utan**, och mått skrivs som tal med decimalkomma åtskilda med semikolon, till exempel *800; 1000; 1200*. En grupp utan ikryssade alternativ utelämnas, och då gäller gruppens förval.
2. Ange **Kalkylantal** — antalet som standardpriset kalkyleras för. Förvalet är artikelns orderkvantitet, annars 1.
3. Klicka **Förhandsgranska**. Alla kombinationer visas med artikelnummer, benämning, **Försäljningspris**, **Standardpris** och **Status**, och en summering som *12 nya · 3 finns redan · 2 stoppas*. Statusen är *Ny*, *Finns redan* (länk till den befintliga varianten, som visas med sitt eget artikelnummer, sin benämning och sina priser), *Stoppas: …* (kombinationen är ogiltig enligt reglerna), *Numret finns redan* (artikelnumret används av en annan artikel) eller en text om att numret eller benämningen blir för lång.
4. Klicka **Skapa N varianter**. Knappen är inaktiv tills förhandsgranskningen visar minst en ny variant, och förhandsgranskningen måste göras om efter varje ändring. Resultatet ersätter tabellen och nya varianter märks *Skapad*. Alla nya varianter skapas i en och samma körning — går något fel skapas ingen.

Högst 200 kombinationer kan skapas åt gången; blir det fler får du ett felmeddelande och minskar urvalet. Kombinationer som redan finns skapas aldrig om.

#### Skapa variant

Under Testa konfiguration visas knappen **Skapa variant** när mallen är i läget Variantartiklar, konfigurationen är **Giltig** och du får ändra artiklar. Den öppnar en liten dialog för just det valda urvalet (grupper du inte har valt något i får gruppens förval) med förhandsgranskningsraden och fältet **Kalkylantal**; ändrar du antalet räknas raden om.

- *Ny* — klicka **Skapa**. Raden blir *Skapad* med länk till den nya artikeln, och knappen **Öppna …** tar dig dit.
- *Finns redan* — knappen **Öppna** följt av artikelnumret (till exempel **Öppna 63000-B-RD**) tar dig till den befintliga varianten.
- *Stoppas* — meddelandet säger varför, till exempel att numret redan finns på en annan artikel.

### Beredning

Beredningsvyn visar hela **strukturträdet** (BOM) till vänster; klicka på en nod för att göra den till aktiv artikel — rubriken ovanför visar **Aktiv artikel:** artikelnumret och namnet. Till höger ligger den samlade vyn **Beredning** med knapparna **+ Ny operation** och **+ Lägg till komponent** i rubrikraden, och därunder en lista där varje operation är en grupprubrik (sorterad på sekvensnummer) med sina kopplade komponenter indragna direkt under; komponenter utan operationskoppling samlas sist under gruppen **Ej kopplat material**:

- **Operationsraden** (rutten) har sekvensnummer och beskrivning — eller resursnamn om beskrivning saknas — som fetstil rubrik överst, med resursens kod och eventuella märken **Lego**/**Kalkyl** på samma rad, och kolumnerna **Ställtid** och **Tid/enhet** (enheten står i cellen, t.ex. "12 min"). Har operationen en **Cykeltid** visas den som en liten rad under värdet i **Tid/enhet**, t.ex. "Cykeltid 8 min", i samma enhet. En lego-operations leverantörs-/ritningsinfo, en satt kommentar och en satt **Packinstruktion** visas var för sig på egna rader under rubriken, i dämpad text med en skrivarsymbol (🖨) framför kommentaren när **Skriv ut på arbetskortet** är ikryssad och en 📦-symbol framför packinstruktionen — mycket lång text klipps efter två rader (öppna **Ändra** för att läsa hela). **+ Ny operation** öppnar dialogen **Ny operation**; **Ändra** på en operationsrad öppnar **Ändra operation N** (N = sekvensnummer) — samma fält i båda: **Sekvensnr**, **Resurs**, **Beskrivning (valfritt)**, **Ställtid (min)**, **Tid/enhet** (med enhetsväxlaren **min/st** | **sek/st** | **st/h**), **Cykeltid (valfritt)**, kryssrutan **Kalkyl**, **Kommentar (valfritt)**, kryssrutan **Skriv ut på arbetskortet** och **Packinstruktion (valfritt)**, sparas med **Lägg till operation** respektive **Spara ändringar**. **Ta bort** tar bort operationen (bekräftas först). Är strukturrader kopplade till operationen säger bekräftelsen hur många: de blir okopplade, och deras material dras då när färdiga varor levereras in i stället för vid operationen. Öppna tillverkningsordrar behåller sina operationer, men de tappar operationens valda ritningar och filer. Se [Beskrivning på operationen](#beskrivning-pa-operationen), [Kommentar på operationen](#kommentar-pa-operationen), [Packinstruktion på operationen](#packinstruktion-pa-operationen) och [Tidsenhet på operationen](#tidsenhet-pa-operationen).
- **Komponentraden** visar längst till vänster **Pos.** (ritningspositionen, "—" när den saknas), därefter artikelnummer, namn (med tillägget "· Fantom" för fantomartiklar) och antal + enhet i kolumnen **Antal**. Rader med kryssrutan **Kalkyl** får märket **Kalkyl** efter namnet (och även i trädet till vänster), se [Kalkylrader i strukturen](#kalkylrader-i-strukturen). Under varje operations komponenter finns knappen **+ Komponent**, som öppnar **Lägg till komponent** med den operationen förvald i fältet **Operation (valfritt)** — kalkyloperationer saknar knappen, eftersom vanligt material inte kan kopplas till dem. **+ Lägg till komponent** i rubriken öppnar samma dialog utan förvald operation: artikelväljaren **Komponent** (kortets egen artikel kan inte väljas — cirkulära strukturer stoppas), **Antal**, **Enhet** och **Operation (valfritt)** (**— ingen —** för okopplad). Samma artikel kan läggas till flera gånger, t.ex. på två ritningspositioner eller till två operationer. Dialogen varnar när den valda artikeln redan finns i strukturen ("Artikeln finns redan i strukturen … — den läggs till som en ny rad."), och i vyn får sådana rader märket **Flera rader** och en notis ovanför listan räknar upp dem. **Ändra** på en komponentrad öppnar **Ändra komponent NNN** — artikeln ligger fast, men **Antal**, **Enhet** och **Operation (valfritt)** kan ändras, och byts operationen flyttas raden till den gruppen. **+ Ny artikel** i komponentdialogen öppnar **Ny artikel i strukturen**, som skapar en ny artikel och kopplar in den i strukturen direkt. **Ta bort** tar bort komponenten (bekräftas först). Antalet kan anges i en av **komponentens** enheter — t.ex. stål i kg per tillverkad styck; lagrat antal räknas alltid om till komponentens grundenhet, och raden visas i den valda enheten.
- **Komponentens ritningar**: har komponenten ritningsnummer visas de under namnet med den aktiva revisionen, t.ex. *R-2001 rev C*; finns en fil öppnar länken den.
- **Pos.** är en fri text på strukturraden (högst 20 tecken) som motsvarar positionsnumret på ritningen. Den anges i fältet **Pos. (valfritt)** i dialogerna **Lägg till komponent** och **Ändra komponent …**; ett tomt fält betyder ingen position. Positionen påverkar inte materialuttaget och kan läsas in från fil, se [Importera artikelstruktur](#importera-artikelstruktur).

Knappen **Kopiera komponenterna** i rubrikraden lägger strukturens komponentartiklar, en gång var och i strukturens ordning, i din personliga lista **Kopierat** — se [Kopierat](#kopierat). Den kräver ingen skrivbehörighet.

Struktur och operationer kan också läsas in från fil i stället för att matas in för hand — se [Importera artikelstruktur](#importera-artikelstruktur) och [Importera operationer](#importera-operationer).

#### Ritningar i beredningen

Ovanför strukturen visar panelen **Ritningar och filer** den aktiva artikelns ritningsnummer med den aktiva revisionen och dess fil (länken öppnar filen). **+ Ny ritning**, **+ Ny revision** och **Lägg till fil** (när den aktiva revisionen saknar fil) öppnar samma dialoger som under fliken [Revisioner](#revisioner), där också historiken och äldre revisioners filer finns.

Under ritningarna listas artikelns övriga filer — samma som under fliken [Filer](#filer). **+ Ladda upp fil** lägger till en (PDF, JPEG eller PNG, högst 20 MB), filnamnet öppnar den och **Ta bort** tar bort den (bekräftas först). En sådan fil kan sedan bli en ritningsrevisions fil med **eller välj bland artikelns filer** i dialogen **Ny revision** eller **Lägg till fil**.

I operationsdialogen väljer du under **Ritningar och filer (valfritt)** vilka av artikelns ritningar och filer operationen arbetar efter — till exempel svetsritningen till svetsoperationen och monteringsanvisningen till monteringen. Operationsraden visar då *Ritning R-1002-SVETS* eller *Fil monteringsanvisning.pdf*, och valet styr:

- **Stämpelterminalen**: under en pågående stämpling visas knappar för operationens ritningar och filer, se [Terminal](/hjalp/terminal#stampla-pa-order).
- **Utskriften av tillverkningsordern**: raden *Ritning: R-1002-SVETS rev A · Fil: monteringsanvisning.pdf* under operationen.
- **Legoinköpets mejl**: en legooperation med **Använd artikelns ritningar** bifogar bara det valda.

Har operationen valt något får den precis det valda; utan val gäller alla artikelns ritningar och filer, som förut. Filerna som går att välja är artikelns övriga filer (fliken Filer) — en ritningsrevisions fil väljs genom sin ritning. Blir en vald fil senare en ritningsrevisions fil räknas den inte längre som operationens fil.

#### Beskrivning på operationen

**Beskrivning (valfritt)** säger vad operationen *är* — *Kapning*, *Svarvning*, *Avgradning* — till skillnad från **Resurs**, som säger vilken maskin eller arbetsplats den körs på. Max 255 tecken.

Beskrivningen visas **i stället för resursnamnet** överallt där operationen presenteras för en människa, med resursens tresiffriga kod kvar bredvid:

- artikelkortets operationslista och strukturradens **Operation**-lista,
- tillverkningsorderns operationstabell, dess kort **Rapportera** (**Slutför**, **Förbruka** och **Rapportera tid**),
- stämpelterminalens val av operation (resursen står kvar på raden under),
- utskriften **Skriv ut TO (PDF)**, där kolumnen heter **Operation**.

**Lämnas fältet tomt visas resursnamnet** — ingen rad blir tom.

Precis som tiderna och kommentaren **fryses beskrivningen vid frisläppet**: tillverkningsordern får en kopia, så en senare ändring i rutten påverkar inte en order som redan är frisläppt.

Beskrivningen kan också läsas in från fil — kolumnen **Operationens benämning** i operationslistan, se [Importera operationer](#importera-operationer).

#### Kommentar på operationen

Fältet **Kommentar (valfritt)** på operationen är fritext för information och instruktioner till momentet — max 1000 tecken. Kryssrutan **Skriv ut på arbetskortet** under fältet avgör om texten följer med ut på utskriften **Skriv ut TO (PDF)**, där den skrivs under sin operationsrad (se [Tillverkning](/hjalp/tillverkning#skriv-ut-to)).

- Utan kryss sparas kommentaren men syns bara här på artikelkortet — använd det för noteringar som hör till beredningen snarare än till verkstadsgolvet.
- Kryssrutan går inte att sätta så länge kommentarsfältet är tomt, och töms texten släcks krysset.
- **Texten fryses vid frisläppet.** Tillverkningsordern får en kopia av kommentaren när den frisläpps, precis som av tiderna. Ändrar du rutten efteråt påverkas inte en order som redan är frisläppt.

Kommentaren kan också läsas in från fil — kolumnen **Instruktion** i rapporten Operationslista, se [Importera operationer](#importera-operationer).

#### Packinstruktion på operationen

Fältet **Packinstruktion (valfritt)** på operationen är fritext för hur artiklarna packas inför nästa operation/avsändning — max 1000 tecken. Till skillnad från kommentaren är det här verkstadsgolvets information, inte beredarens: texten skrivs **alltid** ut under sin operationsrad på utskriften **Skriv ut TO (PDF)** (prefixet **"Packning: "**) när den är satt, oavsett om **Skriv ut på arbetskortet** är ikryssad — den kryssrutan styr bara kommentaren. Packinstruktionen visas också i stämpelterminalen, både i operationslistan och i utstämplingsvyn (se [Stämpelterminalen](/hjalp/terminal)).

**Texten fryses vid frisläppet**, precis som beskrivningen, tiderna och kommentaren — tillverkningsordern får en kopia när den frisläpps, och en senare ändring i rutten påverkar inte en redan frisläppt order.

Packinstruktionen kan också läsas in från fil — kolumnen **Packinstruktion**, se [Importera operationer](#importera-operationer).

#### Tidsenhet på operationen

Fältet **Tid/enhet** har en liten enhetsväxlare bredvid — **min/st** (förvalt), **sek/st** eller **st/h** — som styr hur talet i fältet och i beredningslistan visas. **sek/st** passar korta moment, där minuter skulle bli små decimaltal (45 sek i stället för 0,75 min). **Lagringen sker alltid i minuter per styck**: förkalkylen, beläggningen, TO-utskriften och det övriga systemet räknar oförändrat i minuter, oavsett vilken enhet operationen är inställd på — växlaren är bara en visningsinställning per operation.

- Att klicka en annan enhet räknar om det redan inmatade talet direkt (t.ex. 8,5714 min/st blir 7 st/h och 0,75 min/st blir 45 sek/st) i stället för att nollställa fältet.
- I **st/h**-läge måste talet vara **större än 0** — en operation kan inte ha 0 styck per timme. Är fältet 0 eller tomt visas felet "Antal per timme måste vara större än 0" när formuläret sparas; vill du ange 0 i stycktid växlar du tillbaka till **min/st**.
- Omräkningen fram och tillbaka avrundas (4 decimaler i minuter, 2 decimaler i sekunder och i st/h), så en liten avrundningsdrift kan synas om en operation växlas enhet flera gånger — det är förväntat. Att du bara byter visningsenhet ändrar inte den lagrade tiden i minuter — kalkylen läser alltid de lagrade minuterna.
- Beredningslistan, tillverkningsorderns operationstabell och utskriften **Skriv ut TO (PDF)** visar Stycktid i den enhet operationen sparades med (t.ex. "7 st/h" eller "45 sek"); ett värde på 0 (eller mindre) i **st/h** visas i minuter.
- **Byt enhet direkt i listan:** varje operationsrad i beredningslistan har samma **min/st | sek/st | st/h**-växlare i kolumnen **Tid/enhet**. Ett klick sparar valet direkt utan att dialogen öppnas och ändrar bara visningen — de lagrade minuterna är desamma. **st/h** är avstängd på en rad med stycktid 0 (håll muspekaren över knappen så visas "Kräver stycktid större än 0").
- **Lego-operationer** har ingen tidsenhet — växlaren är dold tillsammans med tidsfälten, både i dialogen och i listan, se [Lego-operationer](#lego-operationer) nedan.

#### Cykeltid på operationen

Fältet **Cykeltid (valfritt)** i operationsdialogen är operationens produktiva tid per styck — den tid maskinen eller operatören faktiskt arbetar, till skillnad från **Tid/enhet** som är den tid som planeras och kalkyleras. Den anges i **samma enhet som Tid/enhet** (växlaren **min/st** | **sek/st** | **st/h** gäller båda fälten, och ett klick på växlaren räknar om båda talen) och lagras som minuter per styck. Lämnas fältet tomt finns ingen cykeltid ("—" i listan). I **st/h**-läge måste ett ifyllt tal vara större än 0, annars visas felet "Cykeltid i st/h måste vara större än 0"; vill du ta bort en cykeltid tömmer du fältet.

Cykeltiden används inte i kalkylen eller beläggningen ännu, och den följer inte med när en tillverkningsorder frisläpps — **Ändra operationer** på en tillverkningsorder har inget fält för den. Legooperationer har ingen cykeltid (fältet är dolt tillsammans med tidsfälten). Cykeltiden kan också läsas in från fil, se [Importera operationer](#importera-operationer).

#### Alternativa resurser

En operation kan ha **alternativa resurser**: andra maskiner eller personal som operationen också kan köras på när den ordinarie resursen är full eller står still. Alternativen är underlag för ett byte som planeraren gör för hand på tillverkningsordern, se [Ändra material och operationer](/hjalp/tillverkning#andra-material-och-operationer). Beredningen och förkalkylen räknar alltid på den ordinarie resursen.

I operationsdialogen finns avsnittet **Alternativa resurser** på en egen operation. Varje alternativ är en rad med tre fält:

- **Resurs** — en av dina egna resurser (maskin eller personal). Den ordinarie resursen och resurser som redan är alternativ finns inte i listan.
- **Ställtid (min)** och **Tid/enhet** — alternativets egna tider, i samma tidsenhet som operationen. Ett tomt fält visar *Som ordinarie* och betyder att alternativet använder operationens egen tid, även om du ändrar den senare. Skriv en tid bara när resursen verkligen går snabbare eller långsammare.

Klicka **+ Lägg till alternativ** för en ny rad. **Upp** och **Ned** ändrar ordningen, som är alternativens rangordning (det första alternativet är rang 1), och **Ta bort** tar bort raden. Högst fem alternativ går att lägga till. Alternativen sparas tillsammans med operationen när du klickar **Spara ändringar** eller **Lägg till operation**. Operationen visar *Alt. 120, 130* under resurskoden i beredningslistan.

Några regler att känna till:

- En **legooperation** och en **Kalkyl**-operation kan inte ha alternativ, och en **legoresurs** kan inte vara alternativ. Gör du en operation till lego eller Kalkyl tas dess alternativ bort när du sparar, och dialogen säger det.
- Väljer du ett alternativ som operationens ordinarie resurs byter de två plats i listan, så att den gamla ordinarie resursen blir alternativ.
- En resurs som saknar kapacitet (varken veckoschema eller timmar per dag) visar *Saknar kapacitet — föreslås aldrig*. Den går att lägga till, men får aldrig något förslag.
- En inaktiv resurs kan inte läggas till som nytt alternativ, men får stå kvar där den redan finns.
- **Kopiera från** med **Beredning** och konfiguratorns varianter kopierar alternativen när den kopierade operationen ligger kvar på samma ordinarie resurs och inte är lego eller Kalkyl. Operationsimporten skriver aldrig alternativen; en uppdatering som lägger en operation med alternativ på en legoresurs eller gör den till Kalkyl avvisas.
- När en tillverkningsorder frisläpps följer operationens aktiva alternativ med, med sina tider. Ändringar i beredningen efteråt påverkar inte en redan frisläppt order.

#### Lego-operationer

Väljs en **legoresurs** i operationsdialogens **Resurs**-lista (resurserna är grupperade i **Resurser** och **Legoresurser**, se [Legoresurser](/hjalp/tillverkning#legoresurser)) byts tidsfälten ut mot legoinköpets uppgifter:

- **Leverantör** — förifylld från legoresursens standardleverantör, ändringsbar per operation. Utan leverantör kan behovsberäkningen inte skapa någon inköpsorder för operationen.
- **Ställpris**, **Styckpris** och **Transportkostnad (kr)** — ställpriset läggs på en gång per inköpsorder, styckpriset per enhet. Transportkostnaden är frakten till och från leverantören, också en gång per order: den läggs till ställpriset på legoinköpsorderns eller förfrågans rad (raden visar summan av ställpris och transportkostnad som sitt ställpris). Alla tre räknas in i förkalkylen som legokostnad med LO-påslag (ställpris + transportkostnad + styckpris × antal, se [System → Kalkyler](/hjalp/system#kalkyler)). Transportkostnaden är valfri; lämnas fältet tomt är den ingen.
- **Visa nettovikt på legoinköpet** — skriver ut **Nettovikt** (artikelns vikt × antal) på inköpsorderns rad. Kräver att artikeln har en vikt på Allmänt-fliken; saknas vikt skrivs ingen rad.
- **Använd artikelns ritningar** (förvald) — legoinköpets mejl bifogar **alltid** ritning till legoraderna, oberoende av mejldialogens **Bifoga ritningar**-kryss: när krysset är satt operationens valda ritningar och filer (se [Ritningar i beredningen](#ritningar-i-beredningen)) i den revision tillverkningsordern byggs efter, och utan val alla artikelns gällande ritningar och filerna under fliken Filer, annars en fil (PDF/JPEG/PNG, max 20 MB) som laddas upp här på operationen. En redan uppladdad ritning kan öppnas, ersättas med en ny uppladdning eller tas bort.

I beredningslistan bär operationen märket **Lego** och visar leverantör och ritningsval på raden; kolumnerna visar **Ställpris** och **Styckpris** i stället för tider (en satt transportkostnad visas som en liten rad **Transport** under ställpriset). Ställtid/Tid per enhet sparas som 0 — en lego-operation belastar inte [beläggningen](/hjalp/tillverkning#belaggning) och visas inte i stämpelterminalen. Legofälten fryses vid frisläppet precis som tiderna; ritningen läses dock alltid live från operationen/artikeln när inköpsordern skickas. Byts operationens resurs till en vanlig resurs rensas legofälten.

På en lego-operations rad finns knappen **Skicka förfrågan** — en ren prisförfrågan för kalkyl eller offert, utan att någon tillverkningsorder behöver finnas. Dialogen tar **Antal**, en valfri **Anteckning** och en lista med leverantörer att kryssa i; är flera leverantörer ikryssade skickas en förfrågan per leverantör, för konkurrerande offerter. Se [Legorader på förfrågan](/hjalp/inkop#legorader-pa-forfragan) i Inköp-kapitlet för hur en sådan rad ser ut och drivs vidare, och [Behovsberäkning](/hjalp/tillverkning#behovsberakning) för samma flöde utgående från en tillverkningsorders operationsbehov.

#### Kalkyloperationer

Kryssrutan **Kalkyl** gör operationen till en ren kalkylrad. Dess tid räknas med i **förkalkylen** precis som vanligt — hela kedjan upp till självkostnad och försäljningspris — men operationen följer **inte** med när en tillverkningsorder frisläpps. Den finns därför inte på arbetskortet (utskriften **Skriv ut TO**), inte i stämpelterminalen, inte i beläggningen och inte i efterkalkylen.

Använd den för tid som ska prissättas men aldrig rapporteras: kringtid, hanteringspåslag eller ett moment som utförs utan att stämplas.

En operation som material är kopplat till kan inte märkas **Kalkyl** — materialet skulle då aldrig dras vid sin operation. Ta bort operationskopplingen på strukturraden först. Av samma skäl kan en vanlig strukturrad inte kopplas till en operation som redan är märkt **Kalkyl**; sådana operationer visas inte i **Operation**-listan för en vanlig rad. En [kalkylrad i strukturen](#kalkylrader-i-strukturen) får däremot kopplas till en kalkyloperation.

#### Kalkylrader i strukturen

Kryssrutan **Kalkyl** i dialogerna **Lägg till komponent** och **Ändra komponent …** gör strukturraden till en ren kalkylrad — samma idé som [Kalkyloperationer](#kalkyloperationer), fast för material. Raden räknas med i **förkalkylen** som vilken rad som helst, men:

- den följer **inte** med när en tillverkningsorder frisläpps — den finns inte på TO:ns materiallista eller plocklista, dras aldrig ur lagret och ger ingen **Materialbrist**,
- den syns inte i efterkalkylen,
- den ger **inget behov** i [behovsberäkningen](/hjalp/tillverkning#behovsberakning).

En **fantomartikel** på en kalkylrad räknas helt som kalkyl: hela dess struktur ingår i förkalkylen men inget av den dras eller ger behov.

Använd den för förbrukningsmaterial som ska vara med i kostnaden men inte rapporteras per order — färg, svetstråd eller smörjmedel. Raden får märket **Kalkyl** i strukturlistan och i trädet.

Kopplingsregeln: en kalkylrad får vara kopplad till en kalkyloperation, men en vanlig rad får inte det. Tar du bort kryssen på en rad som är kopplad till en kalkyloperation sparas inte ändringen ("Operationen är en kalkyloperation och kan inte dra material.") — välj en annan operation eller **— ingen —** först; dialogen tömmer valet av sig själv när du släcker krysset. Kryssen kan också läsas in från fil, se [Importera artikelstruktur](#importera-artikelstruktur).

#### Koppla komponent till operation

Varje komponent kan kopplas till en av artikelns egna operationer i fältet **Operation** (välj **— ingen —** för att lämna den okopplad). Kopplingen styr **när materialet dras från lagret**:

- **Kopplad komponent** dras automatiskt när operationen avrapporteras klar på tillverkningsordern, i det antal som det avrapporterade antalet kräver (se [Tillverkning](/hjalp/tillverkning)).
- **Okopplad komponent** dras i takt med att färdiga varor levereras in på ordern, alltså när den sista operationen rapporteras eller ordern slutförs.

Kopplingen fastställs när tillverkningsordern frisläpps — senare ändringar i beredningen påverkar inte redan frisläppta ordrar. Kopplingen väljs per strukturrad: behövs samma material vid två operationer läggs det in på två rader, en per operation. Ligger samma material på flera rader med samma operation (eller båda okopplade) läggs de ihop till en materialrad med summerat antal när tillverkningsordern frisläpps; kalkylen och behovsberäkningen räknar också med summan. Komponenter under en fantomartikel ärver alltid fantomradens operation: en koppling på fantomens egna strukturrader pekar på fantomens egen rutt, som aldrig finns på en tillverkningsorder (fantomen tillverkas aldrig för sig), och används därför inte — inte heller i kalkylen eller konfiguratorn.

### Inköp

Fliken finns på **köpta artiklar och tjänster** (den ersätter Beredning) och samlar artikelns inköpsuppgifter i fem sektioner:

- **Leverantörer** — artikelns leverantörskatalog. **+ Ny leverantör** öppnar ett formulär med fälten **Leverantör** (väljs ur leverantörsregistret), **Leverantörens artikelnummer**, **Pris**, **Valuta**, **Ledtid (dagar)** (arbetsdagar; används i förslagen för inköpsorderns datum, se [Leveransdagar](/hjalp/inkop#leveransdagar)) och reglaget **Huvudleverantör**; valutan förifylls från den valda leverantören. Listan visar kolumnerna Leverantör, Leverantörens artikelnr, Pris, Valuta, Ledtid (dagar) och Huvudleverantör, och varje rad har **Ändra** och **Ta bort**. Högst en leverantör kan vara **Huvudleverantör** — sätts en ny huvudleverantör tas markeringen automatiskt bort från den förra.
  - **Stafflade priser.** **Pris** är grundpriset, det som gäller för antal 1. Under det finns sektionen **Staffel (pris från antal)**: klicka **+ Lägg till steg** och fyll i **Från antal** och **Pris** för varje steg; **Ta bort** tar bort ett steg. Ett steg gäller från sitt antal och uppåt tills nästa steg tar vid — t.ex. Pris 25, steg 10 → 22 och steg 100 → 20 ger 25 kr upp till 9 st, 22 kr från 10 st och 20 kr från 100 st. Från antal måste vara större än 1 (antal 1 är ju grundpriset) och unikt inom raden, och en rad kan ha högst 50 steg (sedan visas *Staffeln kan ha högst 50 steg.* i stället för knappen); priserna anges i artikelns grundenhet och radens valuta. I listan visas antalet steg efter priset (**· 2 staffelsteg**), och stegen syns när du håller muspekaren över texten. Staffeln används automatiskt när à-priset förifylls på inköpsorderns rader, när behovsberäkningen skapar inköpsorder (se [Tillverkning](/hjalp/tillverkning#behovsberakning)) och — om inställningen är vald — i kalkylen (se [System](/hjalp/system#leverantorspris-vid-staffel)).
- **Katalogprishistorik** — skrivskyddad historik över leverantörskatalogen, nyast först: en rad varje gång en leverantörs pris, valuta, staffel eller huvudleverantörsmarkering ändras, och när en leverantör tas bort. Kolumner: Från och med, Leverantör, Pris, Valuta, Staffel och Status (**Huvudleverantör** eller **Borttagen**). Alla ändringar kommer med, även de som görs med import eller när en artikel kopieras. Efterkalkylen läser den här historiken när den räknar med leverantörspriset vid uttaget (se [System](/hjalp/system#kalkyler)). Historiken börjar när funktionen infördes.
- **Inleveranslogg** — skrivskyddad lista över artikelns inleveranser (mottagningar), härledd ur lagertransaktionerna. Kolumner: Datum, IO-nummer, Leverantör, Antal, À-pris och Lagerplats.
- **Prislogg** — skrivskyddad historik över inköpspriser från artikelns inköpsorderrader, nyast först (utkast och avbrutna order visas inte). Kolumner: Datum, IO-nummer, Leverantör, À-pris, Valuta och Antal.
- **Leverantörsfakturor** — skrivskyddad lista över de leverantörsfakturor som rör artikeln (se [Inköp](/hjalp/inkop#leverantorsfakturor)). Kolumner: Fakturadatum, Reg.nr, Leverantörens fakturanr, Leverantör, Status och Belopp. **Reg.nr** länkar till fakturan.

### Lager

Aktuella saldon per lagerplats för artikeln — aggregerat från transaktionsloggen, aldrig direktändrat. Kolumnen **Plats** i saldotabellen visar om raden är artikelns **Huvudplats**, en **Alternativ 1**, **Alternativ 2** …, eller **–** för övriga platser.

Kortet **Lagerplatser** överst på fliken styr var artikeln hamnar och tas ifrån:

- **Huvudplats** — platsen där inleveranser och andra inflöden utan vald plats bokförs, och den plats som uttag med **Automatiskt** tar från först. Valet `*** (standard)` betyder att artikeln inte har någon egen huvudplats: inleveranserna går till första användbara alternativa plats, annars till reservplatsen `***`, och **Automatiskt** tar `***` sist. En [spärrad lagerplats](/hjalp/lager#sparrade-lagerplatser) eller en inaktiv plats kan inte väljas som ny huvudplats, men en plats som redan är vald står kvar, märkt *(spärrad)* eller *(inaktiv)*, och hoppas över så länge den är det.
- **Alternativa lagerplatser** — en ordnad lista med upp till 20 platser. Välj en plats och klicka **Lägg till plats**, ändra ordningen med ↑ och ↓ och ta bort en plats med **Ta bort**. Samma plats kan inte stå två gånger, och inte både som huvudplats och alternativ. Reservplatsen `***` kan inte vara alternativ plats.
- **Spara** skriver hela kortet på en gång. Behörighet att ändra har Artiklar och Lager.

Ordningen betyder: en inleverans utan vald plats går till huvudplatsen, annars till första användbara alternativa platsen, annars till `***`. Med huvudplatsen `*** (standard)` hamnar inleveranserna alltså på första alternativa plats. Uttag med **Automatiskt** tar först från huvudplatsen, sedan från de alternativa platserna i ordning och sist från övriga platser med saldo, med `***` allra sist (se [Uttag med Automatiskt](/hjalp/lager#uttag-med-automatiskt)). Blir en **tillfällig** lagerplats tom och inaktiveras tas den bort ur kortet; en **lagerflytt** som tömmer en tillfällig huvudplats flyttar huvudplatsen till den mottagande platsen, men en tillfällig alternativ plats försvinner bara (se [Lager](/hjalp/lager#tomma-lagerplatser-stadas-bort)).

Sektionen **Planering** på fliken (under **Lagerplatser**, som ligger överst) har fält som styr [behovsberäkningen](/hjalp/tillverkning#behovsberakning): **Beställningspunkt** (förslag utlöses när projicerat saldo faller under punkten; tomt = förslag bara vid negativt netto), **Säkerhetslager** (den lägsta nivå saldot inte bör understiga; tomt = inget), **Orderkvantitet** (förslag avrundas uppåt till närmaste multipel, fungerar även som minsta orderkvantitet) och **Avrundning**. Beställningspunkt och Säkerhetslager arbetar ihop: det **större** av dem är golvet — faller projicerat saldo under det föreslår behovsberäkningen ett antal som fyller upp till just den nivån (därefter tillämpas Orderkvantitet och Avrundning som vanligt). Fälten anges i artikelns grundenhet. Fältet **Styrning** (**Orderstyrd** eller **Lagerstyrd**, förvalt Orderstyrd) är bara information om hur artikeln planeras och påverkar ingen beräkning. Allt sparas med **Spara**. Kryssrutan **Prognosstyrd** gör att behovsberäkningen planerar ett månadsbehov för artikeln (se [Prognos](/hjalp/lager#prognos)); raden **ABC-klass** visar artikelns klass i [ABC-analysen](/hjalp/lager#abc-analys) (**A**, **B**, **C**, eller **—** när artikeln står utanför klassningen) och är bara information.

Är artikeln **Prognosstyrd** (sparad) visas kortet **Prognos** under Planering: en tabell per månad i horisonten med **Månad**, **Snitt**, **Eget antal** (tomt = snittet), **Prognos**, **Order och behov**, **Redan förbrukat** (bara innevarande månad) och **Prognosbehov**, och under den **Historik** med **Förbrukat** per månad. **Spara** skickar de månader du ändrat; knappen finns för dig som får ändra artikeln. Så räknas det i [Prognos](/hjalp/lager#prognos).

**Ledtid (dagar)** visas bara för tillverkade artiklar och anger hur många arbetsdagar tillverkningen tar (heltal, 0 eller mer). Ledtiden bestäms i den här ordningen: **fältet vinner** — är det ifyllt används det. Är fältet tomt räknas ledtiden ur operationerna i rutten — operationernas tid för antalet, omräknad till dagar med resursens arbetstid per dag, utan hänsyn till kapacitet och belastning, plus systeminställningen **Kötid mellan operationer (dagar)** mellan varje par av operationer (inte före den första eller efter den sista); en legooperation räknar resursens ledtid och kötid. Summan avrundas uppåt till hela dagar. Saknar artikeln både fält och rutt gäller systeminställningen **Standardledtid (dagar)**, och är den 0 blir ledtiden 0 (se [Inställningar](/hjalp/system#installningar)). Ledtiden styr **Senast starta** i [behovsberäkningen](/hjalp/tillverkning#tidsfasade-forslag) och golvet i det [föreslagna färdigdatumet](/hjalp/tillverkning#foreslaget-fardigdatum) (idag plus ledtid).

**Avrundning** är ett steg som antal avrundas **uppåt** till: 1 ger hela tal, 5 ger 5, 10, 15 …, 7,38 ger hela stänger om 7,38 kg (högst 3 decimaler, tomt = ingen avrundning). Till skillnad från orderkvantiteten gäller den inte bara behovsberäkningens förslag utan **även antalet på orderrader**: när en rad läggs till eller antalet ändras på en inköpsorder, förfrågan, offert/kundorder eller när en tillverkningsorder skapas, avrundar systemet antalet uppåt till närmaste multipel och sparar det avrundade antalet — skriver du 12 på en artikel med Avrundning 5 blir raden 15. Avrundningen sker i grundenheten även när raden matas in i en alternativ enhet, så det visade antalet i den enheten kan bli ett "ojämnt" tal (1 m på en artikel med 1 st = 0,89 m och Avrundning 5 st blir 5 st = 4,45 m). Är både Orderkvantitet och Avrundning satta tillämpas orderkvantiteten först och avrundningen sist: 100 kg i stänger om 7,38 kg blir 103,32 kg, alltså 14 hela stänger.

### Kalkyl

- **Förkalkyl**: ange **Antal att förkalkylera** och klicka **Förkalkylera** — materialkostnaden beräknas från strukturen och lönekostnaden från rutten och resursernas timkostnad. Resultatet visas i panelen bredvid formuläret **utan att sparas**: hela kedjan från direkt material till försäljningspris i två kolumner — **Totalt** för hela det kalkylerade antalet och **Per st** där varje belopp delats med antalet — plus eventuella varningar. Ställtidens kostnad fördelas därmed på det kalkylerade antalet och ingår i styckpriset: ett större antal ger ett lägre pris per styck. Ändrar du antalet töms panelen, eftersom siffrorna hörde till det gamla antalet.
- **Räkna om underliggande nivåer** är en kryssruta under antalet. Utan den värderas ett tillverkat halvfabrikat i strukturen till sin **Standardkostnad** — ett fält som matas in för hand, och som alltså bara är så färskt som senaste inmatningen. Med kryssrutan i kostas varje tillverkat halvfabrikat i stället ur **sin egen struktur och rutt**, nivå för nivå hela vägen ned.
  - Halvfabrikatet står kvar som **en** rad i specifikationen, märkt **halvfabrikat**, med priskällan **Beräknat (flernivå)**. Dess komponenter och operationer syns alltså inte som egna rader på slutartikeln — de ligger inne i dess à-pris.
  - À-priset är halvfabrikatets **tillverkningskostnad (TVK) per styck**, alltså utan TO-påslag, utan Affo-påslag och utan generellt påslag. Affo och det generella påslaget läggs på en gång, längst upp på slutartikeln, och skulle annars räknas två gånger. Raden bär av samma skäl **inget MO-påslag** — materialomkostnaden är redan pålagd inne i halvfabrikatets egen kalkyl. Halvfabrikatets eget TO-påslag försvinner inte: det läggs till slutartikelns **TO-påslag** i kedjan och visas i specifikationen i kolumnen **TO-belopp** på halvfabrikatsraden. Likadant med halvfabrikatets materialpåslag: det läggs till slutartikelns **Materialpåslag** och visas i kolumnen **Materialpåslag** på halvfabrikatsraden.
  - Underkalkylen körs för det **antal halvfabrikat den här kalkylen behöver** (kalkylantalet gånger antalet per slutartikel). Ställtiden i halvfabrikatets rutt fördelas därmed på det antalet, precis som slutartikelns egen ställtid — kalkylerar du 100 i stället för 10 sjunker alltså även halvfabrikatets styckpris.
  - Ett halvfabrikat som varken har struktur eller rutt går inte att räkna om. Det räknas då till sitt standardpris, och kalkylen visar en varning om vilken artikel det gäller. Detsamma gäller om strukturen skulle vara cirkulär.
  - Ändrar du kryssrutan töms panelen, av samma skäl som när du ändrar antalet: siffrorna hörde till den andra inställningen.
- **Pröva påslag** — se [Pröva påslag](#prova-paslag) nedan: två fält under **Räkna om underliggande nivåer** för att räkna förkalkylen med andra prispåslag.
- **Spara kalkyl** i panelen lägger beräkningen som en ny rad i listan högst upp och öppnar **Kalkylspecifikation** direkt. Kalkylen räknas om vid sparningen, så byter någon inställning under tiden är det de nya påslagen som sparas.
- En sparad **Förkalkyl** tas bort med **Ta bort** längst till höger på raden (bekräftas först). **Efterkalkyl** har ingen sådan knapp — den är facit för vad ordern kostade och kan inte tas bort.
- **Efterkalkyl** görs från tillverkningsorderns detaljsida när ordern är klar, och listas här per order. Även dess kedja visas med **Totalt** och **Per st** — delat med det **inlevererade** antalet, inte orderns antal: en order på 10 där 8 levererades in kostar kedjans belopp delat med 8 per styck. En efterkalkyl som görs medan ordern är öppen är preliminär och har ingen **Per st**-kolumn, och inte heller en order där inget inlevererats. En efterkalkyl som sparades innan avvikelseanalysen fanns delas med orderns antal.
- En kalkyl som sparats med **Spara som prövad kalkyl** är märkt **Prövat** under typen i listan.
- Listan visar kolumnen **Styckpris** — försäljningspriset delat med kalkylens antal (för en efterkalkyl med det inlevererade antalet, som **Per st** ovan; **—** för en preliminär efterkalkyl eller när inget inlevererats), alltid härlett vid visning.
- Var materialkostnaden hämtas (standardpris eller huvudleverantörens pris) och påslagens storlek ställs in under **System → Kalkyler**, se [System & inställningar](/hjalp/system#kalkyler). Faller kalkylen tillbaka på ett annat pris än det valda visas en varning per rad.

Klicka på **Förkalkyl** eller **Efterkalkyl** i typkolumnen för att öppna **Kalkylspecifikation** — den visar exakt vad som kostade:

- Överst vilka inställningar kalkylen kördes med, så att en gammal kalkyl går att förstå även om inställningarna ändrats sedan dess — inklusive om den kördes som flernivåkalkyl. Efter **generellt påslag** och **materialpåslag** står var procentsatsen kom från: *(företaget)*, *(varugruppen)* eller *(prövat)*. Kalkyler sparade före nivåerna visas som *(företaget)*.
- **Material och lego** — en rad per komponent med antal, enhet, à-pris, belopp och **Priskälla**. Tjänsteartiklar i strukturen räknas som legokostnad och märks **lego**; ett omräknat halvfabrikat märks **halvfabrikat** och har priskällan **Beräknat (flernivå)**. Har raden fått ett annat pris än det valda står **standardpris (fallback)**, eller **inget pris** när komponenten helt saknar pris och räknats som 0. Ett leverantörspris i annan valuta har under priskällan priset i valutan och kursen det räknades om med, till exempel *2,50 EUR · kurs 11,50* — à-priset och beloppet är i kronor. I en efterkalkyl med standardpris eller leverantörspris står också dagen priset togs, till exempel *uttag 2026-03-03*: dagen då komponenten senast togs ut på ordern.
- **Operationer** — en rad per operation med timmar, **Ställtid**, timkostnad, lönebelopp, TO-procent, TO-belopp och **varav ställ/st** (ställtidens kostnad delad med kalkylens antal — det är den andelen som gör styckpriset lägre vid större kalkylantal). Förkalkylen räknar ställtid plus stycktid gånger antalet; efterkalkylen den tid som faktiskt rapporterats, varje dag till den dagens timkostnad — har timkostnaden ändrats under tiden visar raden snittet. Är tiden registrerad som **Ställ** och **Produktion** (se [Tidrapporter](/hjalp/tillverkning#tidrapporter)) visar efterkalkylen verklig ställtid och ställkostnad per styck som förkalkylen; annars, och på kalkyler sparade innan uppdelningen infördes, visas **—** i de kolumnerna. Ställ och stycke för sig finns i **Avvikelseanalys** nedan.
- **Summering** — hela kedjan från direkt material till försäljningspris, med kolumnerna **Totalt** och **Per st**. Radernas belopp summerar alltid till kedjans direkta kostnader. Steget **Halvfabrikat** visas bara när kalkylen faktiskt innehåller ett omräknat halvfabrikat. **TO-påslag** står sist i kedjan, efter **Generellt påslag**: det ingår varken i **Tillverkningskostnad (TVK)** eller **Självkostnad (SVK)** utan läggs direkt på försäljningspriset, utan Affo eller generellt påslag på sig. Beloppet är summan av operationsradernas **TO-belopp** och, i en flernivåkalkyl, halvfabrikatsradernas **TO-belopp**. **Materialpåslag** står mellan **Generellt påslag** och **TO-påslag** och visas bara när kalkylen har ett: det är materialpåslaget på direkt material + MO-påslag (plus halvfabrikatens), och det ingår inte heller i TVK eller SVK. Kalkyler sparade innan materialpåslaget fanns har inget. Kalkyler sparade innan TO-påslaget flyttades ut ur tillverkningskostnaden visas i den nya ordningen med samma sparade belopp — summan är fortfarande det sparade försäljningspriset, men deras TVK och SVK läses nu utan TO-påslaget.

- **Avvikelseanalys** (bara på en efterkalkyl) — orderns avvikelse mot kalkylerat, i egna tabeller så att tabellerna ovan inte blir bredare. Överst står vilken materialkälla kalkylerat prissattes med och när (T₀, då ordern skapades). Beskrivningen av vad Kalkylerat, Utfall, Pris, Mängd och Påslag betyder står under [Avvikelseanalys](/hjalp/tillverkning#avvikelseanalys) i Tillverkning.
  - **Material och lego** — **Kalkylerat antal**, **Kalkylerat à-pris**, **Antal**, **À-pris**, **Pris**, **Mängd** och **varav kassation** (kolumnen visas när något är kasserat). Ett negativt belopp är billigare än kalkylerat.
  - **Operationer** — **Planerad ställ (h)**, **Verklig ställ (h)**, **Planerad stycke (h)**, **Verklig stycke (h)**, **Ej uppdelad (h)** och beloppen **Ställ**, **Stycke** och **Ej uppdelad**. Är tiden registrerad som **Ställ** och **Produktion** visas verklig ställ och stycke och avvikelsen delas i **Ställ** och **Stycke**. Saknar tiden typ, helt eller bara för en del av tiden, visar verklig ställ och stycke **—**, **Ej uppdelad (h)** är alla timmar på operationen och hela tidsavvikelsen står under **Ej uppdelad**. **Timpris** — skillnaden mellan timkostnaden de dagar tiden arbetades och timkostnaden vid T₀ — står först och visas bara när någon operation har en sådan skillnad. Legooperationer har en egen tabell med **Kalkylerat**, **Utfall**, **Pris** och **Mängd**.
  - **Summering** — Kalkylerat, Utfall och Avvikelse med delarna. Utfall är tillverkningskostnaden i kedjan; öresresten från radernas avrundning står under Påslag.
  - En efterkalkyl som sparats före avvikelseanalysen visar *Sparad före avvikelseanalysen — efterkalkylera och spara igen för att få den.*

Kalkyler gjorda innan specifikationen infördes saknar rader och visar **Inga rader sparade för den här kalkylen**; summeringen finns kvar.

#### Pröva påslag

Under **Pröva påslag** i formuläret på fliken **Kalkyl** finns fälten **Generellt påslag (%)** och **Materialpåslag (%)**. De är förifyllda med påslagen som gäller för artikeln: **varugruppens**, och är gruppens fält tomt, **företagets** under **System → Kalkyler** (se [Påslagen](/hjalp/system#paslagen)). Ändra ett eller båda och klicka **Förkalkylera** för att se vad förkalkylen hade gett med de påslagen. Resultatet visas i panelen bredvid, där kedjans rader för **Generellt påslag** och **Materialpåslag** anger procentsatsen och var den kom från, till exempel *Generellt påslag 40 % (prövat)*.

- Bara de två prispåslagen kan prövas. **MO-, LO-, Affo- och TO-påslagen är alltid de vanliga**, så **Tillverkningskostnad (TVK)** och **Självkostnad (SVK)** är desamma som i en vanlig förkalkyl — det är försäljningspriset som ändras.
- Förhandsvisningen sparar ingenting, och ingenting under **System → Kalkyler** eller på varugruppen ändras. Rör du fälten töms panelen, eftersom siffrorna hörde till de gamla värdena.
- **Spara som prövad kalkyl** (knappen heter så i stället för **Spara kalkyl** när något påslag är ändrat) lägger kalkylen i listan märkt **Prövat**, och öppnar **Kalkylspecifikation**, som visar nivån efter varje påslag, till exempel *generellt påslag 40 % (prövat)*. En prövad kalkyl räknas som en vanlig förkalkyl i övrigt: den kan bli den senaste förkalkylen, men eftersom självkostnaden är densamma ändras varken kortet **Marginal** eller rapporterna.
- **Sätt försäljningspris** på en prövad kalkyl skriver det prövade priset till artikeln, och bekräftelsen säger att kalkylen är prövad. **Sätt standardpris** ger samma värde som i en vanlig kalkyl.
- Läskonton kan göra förhandsvisningen men inte spara den.

#### Föra tillbaka kalkylen till artikeln

Längst ned i **Summering** finns två knappar som för tillbaka kalkylens resultat till artikelregistret. De finns bara på en **sparad** kalkyl — förhandsvisningen skriver aldrig något, och siffran ska gå att spåra till en kalkyl som finns kvar och går att öppna. Både förkalkyl och efterkalkyl duger som källa; efterkalkylen är det verkliga utfallet, och dess pris per styck räknas på det inlevererade antalet. Knapparna finns inte på en **preliminär** efterkalkyl (ordern är inte klar) eller när inget är inlevererat — gör en ny efterkalkyl när ordern är klar.

- **Sätt standardpris** skriver kalkylens **tillverkningskostnad (TVK) per styck** till artikelns **Standardkostnad** på fliken Allmänt, och loggar ändringen i standardprishistoriken. Alltså utan TO-påslag, utan Affo-påslag och utan generellt påslag: fältet används även till lagervärdering och till värdet på tillverkningsinleveranser, och omkostnadspåslagen hör inte hemma i ett lagervärde. Kör du knappen nedifrån och upp — halvfabrikaten först, slutartikeln sist — blir också flernivåkalkylen rätt utan att kryssrutan behövs.
- **Sätt försäljningspris** skriver kalkylens **försäljningspris per styck** till artikelns **Försäljningspris**, alltså grundpriset längst ned i [priskedjan](/hjalp/forsaljning).

Båda bekräftas först, eftersom de skriver över ett fält du kan ha satt för hand. Trycker du en gång till utan att kalkylen ändrats läggs ingen ny historikrad till.


#### Marginal

Kortet **Marginal** överst på fliken ställer artikelns **Försäljningspris** mot den senaste sparade **förkalkylens** självkostnad per styck (SVK — utan TO-påslag, materialpåslag och generellt påslag), och visar **täckningsbidraget** och täckningsgraden. Efterkalkyler räknas inte in — de beskriver en enskild tillverkningsorders utfall, inte vad artikeln kostar att sälja idag.

Saknas antingen priset eller en sparad förkalkyl står det i kortet vilket av dem som fattas. Ingenting antas: en artikel utan kalkyl har en *okänd* kostnad, inte kostnaden noll.

### Revisioner

Fliken samlar artikelns revisionsregister och ritningarnas filer. Den har två kort:

- **Artikelrevisioner**: artikelns egna revisioner (t.ex. A, B, C) med valfri **Kommentar**. Högst en revision är **Aktiv** åt gången och märks så i kolumnen **Status**. Lägg till med **+ Ny revision**: fyll i **Revision** och eventuellt **Kommentar (valfritt)**. Den första revisionen blir aktiv automatiskt; finns det redan revisioner avgör bocken **Gör den till aktiv revision** (förvald) om den nya tar över. Menyn **⋯** på raden har **Aktivera** (flyttar markeringen till raden), **Ändra** (revisionsbeteckning och kommentar) och **Ta bort** (tas den aktiva bort är ingen revision aktiv tills du aktiverar en annan). Artikelrevisioner har ingen fil — filerna hör till ritningarna.
- **Ritningar**: artikeln kan ha flera frivilliga **ritningsnummer**. **+ Ny ritning** lägger till ett — med **Första revision (valfritt)** får ritningen sin första revision på samma gång, och då kan också dess fil väljas. Varje ritningsnummer visas med sin aktiva revision bredvid numret och har sitt eget revisionsregister med samma regler som artikelrevisionerna: **+ Ny revision** vid ritningsnumret och **⋯** på raderna. **⋯** vid ritningsnumret har **Byt ritningsnummer** och **Ta bort ritningen**, som även tar bort dess revisioner och deras filer.
- **Fil på ritningsrevisionen**: varje ritningsrevision kan ha en fil (PDF, JPEG eller PNG, högst 20 MB) i kolumnen **Fil**. Välj den i dialogen **Ny revision** — **Fil (valfritt)** laddar upp en ny, **eller välj bland artikelns filer** tar en av filerna under fliken Filer — eller i efterhand med **⋯ → Lägg till fil** / **Byt fil** (den gamla filen tas då bort). **⋯ → Ta bort filen** tar bort filen men behåller revisionen, och **Ta bort** på revisionen tar bort filen också.
- **Vilken fil som följer med:** bara den **aktiva** revisionens fil skickas och skrivs ut av sig själv — på tillverkningsordern (i den revision ordern byggs efter, se [Ritningar och revisioner](/hjalp/tillverkning#ritningar-och-revisioner)), i legoinköpets mejl och när ritningar bifogas offert, orderbekräftelse, förfrågan och inköpsorder. En äldre revisions fil följer aldrig med, men öppnas med länken i kolumnen **Fil** — därifrån kan den skrivas ut när den behövs.
- Samma revisionsbeteckning kan inte förekomma två gånger på samma artikel respektive ritning ("Den revisionen finns redan."), och samma ritningsnummer kan inte läggas två gånger på samma artikel ("Artikeln har redan det ritningsnumret."). En fil som redan hör till en annan revision kan inte väljas ("Filen hör redan till en annan ritningsrevision.").
- Artikelrevision, ritningsnummer och ritningsrevision kan också läsas in med [artikelimporten](#importera-artiklar) (utan filer).
- Utan skrivbehörighet till artiklar visas registren utan knappar och menyer; filerna går fortfarande att öppna.

Med systeminställningen **Visa revisioner på dokument** (se [System](/hjalp/system)) skrivs aktiv artikelrevision och ritningsnummer med aktiv ritningsrevision ut per orderrad på offert, orderbekräftelse, inköpsorder och förfrågan.

### Filer

Ritningar och andra dokument som hör till artikeln. Välj fil med filväljaren så laddas den upp direkt; klicka på filnamnet för att öppna den och **Ta bort** för att koppla bort den. Kolumnen **Ritning** visar vilken ritningsrevision en fil hör till, t.ex. *R-1001 rev 2 · gällande* eller *· äldre* (se [Revisioner](#revisioner)); en fil utan ritning hör till artikeln i stort.

- Tillåtna format: **PDF, JPEG och PNG**, max **20 MB** per fil.
- Filerna följer automatiskt med när tillverkningsordern skrivs ut (se [Tillverkning](/hjalp/tillverkning#skriv-ut-to)) — PDF:er läggs som extra sidor, bilder som en sida var. En fil som hör till en äldre ritningsrevision följer inte med.
- När en förfrågan, inköpsorder, offert eller orderbekräftelse mejlas kan artiklarnas ritningar bifogas (se [Inköp](/hjalp/inkop) och [Försäljning](/hjalp/forsaljning)).

## Kopierat

**Kopierat** är din egen arbetslista med artiklar. Du fyller den från de ställen där du hittar artiklar och använder den sedan där ett urval behövs — rutinen [Förkalkylera flera](#forkalkylera-flera) kan läsa listan som urval.

- Listan är **personlig**: ingen annan ser den, och den ligger kvar tills du tömmer den eller ersätter den — även efter utloggning. Den rymmer högst 5 000 artiklar; blir det fler avvisas kopieringen och ingenting läggs till.
- Artiklarna ligger i den ordning de kopierades. En artikel som redan finns i listan behåller sin plats.
- Du behöver ingen skrivbehörighet för att använda listan, och även ett konto som är **Endast läsning** kan kopiera.

### Kopiera artiklar

Det finns tre ställen:

- **Artikelregistret** — markera rader och klicka **Kopiera (N)**, eller klicka **Kopiera alla träffar (N)** för att kopiera hela den aktuella sökningen med dess filter (alla sidor, inte bara de rader som visas).
- **Behovsberäkningen** — markera rader och klicka **Kopiera artiklar (N)**. Artiklarna på de markerade raderna kopieras en gång var; se [Orderförslag och Skapa ordrar](/hjalp/tillverkning#orderforslag-och-skapa-ordrar).
- **Artikelns struktur** (fliken Beredning) — **Kopiera komponenterna** kopierar strukturens komponenter, se [Beredning](#beredning).

Innehåller **Kopierat** redan artiklar frågar systemet *Kopierat innehåller N artiklar.* med tre val: **Lägg till** (de nya läggs sist), **Ersätt** (listan töms och fylls med de nya) och **Avbryt**. Är listan tom läggs artiklarna till direkt. Efteråt visas beskedet *N artiklar i Kopierat.* (eller *1 artikel i Kopierat.*) med det nya antalet.

### Sidan Kopierat

**Artiklar → Kopierat** (`/artiklar/kopierat`) visar hela din lista i den ordning artiklarna kopierades, med löpnummer, **Artikelnummer** (länk till artikelkortet), **Benämning**, **Typ** och **Status** (**Aktiv** eller **Inaktiv**). Sidan är öppen för alla som har någon meny, även ett konto som är **Endast läsning**. Sidhuvudet visar antalet, till exempel *12 artiklar i listan — i den ordning de kopierades*.

- **Lägg till artikel** — sök fram en artikel i fältet överst och välj den; den läggs sist i listan och beskedet *A-100 lades till sist. 13 artiklar i Kopierat.* visas. Finns artikeln redan säger sidan *A-100 finns redan i Kopierat och behåller sin plats.* Fler artiklar på en gång kopierar du från artikelregistret, behovsberäkningen eller en artikels struktur (se ovan).
- **Ta bort** på raden tar bort den artikeln ur listan; markera flera rader och klicka **Ta bort markerade (N)** i sidhuvudet för att ta bort dem på en gång. Rubrikens kryssruta markerar alla.
- **Förkalkylera Kopierat** öppnar [Förkalkylera flera](#forkalkylera-flera) med **Kopierat** som urval.
- **Töm Kopierat** tar bort alla artiklar ur listan, efter en bekräftelse. Artiklarna i sig påverkas aldrig — listan är bara en lista.

### Visa Kopierat i artikelregistret

I artikelregistret visar kryssrutan **Kopierat (N)** i verktygsraden bara artiklarna i din lista (adressen får `?copied=true`), sorterade som registret. Sökning och övriga filter fungerar som vanligt inom listan, och antalet ovanför tabellen följer. Knappen **Visa Kopierat** öppnar [sidan Kopierat](#sidan-kopierat) med listan i kopieringsordning.

### Förkalkylera Kopierat

När filtret **Kopierat (N)** är på visas länken **Förkalkylera Kopierat**. Den öppnar [Förkalkylera flera](#forkalkylera-flera) med **Kopierat** som urval. Samma knapp finns på sidan Kopierat.

### Ta bort och tömma

När filtret **Kopierat (N)** är på i artikelregistret:

- Markera rader och klicka **Ta bort ur Kopierat (N)** för att ta bort dem ur listan.
- **Töm Kopierat** tar bort alla artiklar ur listan, efter en bekräftelse. Artiklarna i sig påverkas inte.

Samma sak går att göra på [sidan Kopierat](#sidan-kopierat). Raderas en artikel försvinner den också ur alla listor.

## Förkalkylera flera

**Artiklar → Förkalkylera flera** (`/artiklar/forkalkylera`) förkalkylerar många artiklar i ett svep: du väljer ett urval, tittar på siffrorna och sparar de rader du vill behålla. Sidan kräver behörigheten **Artiklar** eller **Tillverkning**. Varje artikel räknas exakt som med **Förkalkylera** på artikelns flik [Kalkyl](#kalkyl).

### Urval

Välj mellan två urval:

- **Kopierat (N)** — artiklarna i din egen lista [Kopierat](#kopierat), i den ordning de kopierades. Länken **Visa och ändra** bredvid öppnar [sidan Kopierat](#sidan-kopierat), där du ser listan och kan lägga till och ta bort artiklar. Valet är avstängt när listan är tom; texten *Kopierat är tomt* länkar då till artikelregistret och till sidan Kopierat. Länken **Förkalkylera Kopierat** i artikelregistret och på sidan Kopierat öppnar sidan med Kopierat valt.
- **Filter** — sektionen **Filtrera** med **Artikelnummer**-intervall, **Varugrupp**, **Typ** (**Alla**, **Tillverkad**, **Köpt** eller **Tjänst**, förvalt **Tillverkad**), **Artikelkod** och kryssrutan **Bara aktiva** (förvalt på). Konfiguratormallar ingår aldrig.

**Artikelnummer**-intervallen: varje rad har fälten **Från** och **Till** (båda inklusive; jämförelsen sker tecken för tecken, så "A-10" sorteras före "A-9", precis som i listan). Medan du skriver visar fälten artiklar som matchar på artikelnummer eller benämning, som när du söker en artikel i artikelregistret. Klickar du på en träff, eller väljer den med piltangenterna och **Enter**, fylls dess artikelnummer i. Du kan också skriva ett nummer som inte finns som artikel, till exempel början av en nummerserie. Lämnas ett av fälten tomt är intervallet öppet åt det hållet; en rad med båda fälten tomma begränsar ingenting. Med **+ Lägg till intervall** lägger du till fler rader (högst 20), och ✕ på raden tar bort den — en rad finns alltid kvar. En artikel tas med när den ligger i **något** av intervallen; varugrupp, typ, artikelkod och **Bara aktiva** gäller därutöver för alla.

Högst 500 artiklar kan förkalkyleras åt gången. Blir urvalet större visas ett felmeddelande och ingenting beräknas — snäva in det med artikelnummerintervall, varugrupp eller artikelkod.

**Visa urval** listar artiklarna som urvalet träffar — **Artikelnummer** (länk till artikeln), **Benämning** och **Typ**, i den ordning de förkalkyleras — utan att räkna något, så att du kan kontrollera urvalet innan du startar ett stort jobb. Överst står hur många artiklar urvalet har (*Urvalet har 37 artiklar*). Har urvalet fler än 500 artiklar säger en notis att det måste snävas in, och listan visar de första 500. Ändrar du urvalet försvinner listan, så den aldrig visar ett gammalt urval; **Dölj** stänger den.

### Antal

Varje artikel räknas med antalet i **sin senaste sparade förkalkyl**. Har artikeln ingen förkalkyl används **Antal när förkalkyl saknas** (förvalt 1). Kryssrutan **Räkna om underliggande nivåer** fungerar som på kortet.

Antalet går också att ändra **per rad** i tabellen: skriv ett nytt värde i radens **Antal** och tryck Enter eller lämna fältet, så räknas just den raden om med det antalet (under fältet står *räknar om…* medan det pågår). Ett eget antal vinner över både den senaste förkalkylens och **Antal när förkalkyl saknas**, och det ligger kvar när du klickar **Förkalkylera** igen. Esc ångrar ett värde du inte har lämnat än.

### Tabellen

Klicka **Förkalkylera** (knappen visar **Beräknar…** medan det pågår). Inget sparas ännu. Tabellen har en rad per artikel:

- **Artikelnummer** (länk till artikelkortet) och **Benämning**. Eventuella varningar från kalkylen står under benämningen.
- **Antal** — ett fält du kan ändra, med anmärkningen *senaste förkalkyl*, *valt antal* eller *eget antal* som visar var antalet kom ifrån.
- **TVK/st** — tillverkningskostnaden per styck.
- **Förra TVK/st** med datum, och **Ändring** i kronor och procent. Ändringen visas bara när det finns en tidigare förkalkyl; en höjd kostnad är röd och en sänkt grön.
- **Standardpris** och **Försäljningspris** — artikelns nuvarande värden.
- **Pris/st** — förkalkylens försäljningspris per styck.

En artikel som inte går att kalkylera visar felet under benämningen och kan inte markeras. Alla övriga rader är markerade från början; rubrikens kryssruta markerar eller avmarkerar alla. Ovanför tabellen står en sammanfattning, till exempel *12 artiklar, varav 1 med fel*.

### Spara markerade

**Spara markerade (N)** sparar en ny **Förkalkyl** på varje markerad artikel, med antalet som visas i tabellen (räknas en rad om när du klickar, väntar sparandet in den) och samma inställning för underliggande nivåer som förhandsvisningen. Knappen syns bara för dig som får spara kalkyler. Kalkylerna räknas om vid sparandet, så ändrade priser sedan förhandsvisningen kommer med.

Två kryssrutor, båda av från början, gör mer i samma svep:

- **Sätt standardpris** — artikelns standardpris sätts till den sparade kalkylens TVK per styck, som **Sätt standardpris** på kortet.
- **Sätt försäljningspris** — artikelns försäljningspris sätts till kalkylens pris per styck, som **Sätt försäljningspris** på kortet.

Ett pris på 0 skrivs aldrig härifrån. En köpt artikel utan struktur, eller en vars komponenter saknar pris, får TVK/st 0 — raden varnar redan i förhandsvisningen (*TVK/st är 0 — standardpris och försäljningspris sätts inte vid Spara*), och vid sparandet sparas kalkylen men priserna lämnas orörda och artikeln listas bland felen. Vill du ändå sätta 0 gör du det på artikelkortet.

Är någon av dem ikryssad frågar systemet först, till exempel *Spara 12 förkalkyler och sätta standardpris och försäljningspris för 12 artiklar?*.

Efteråt visas *N förkalkyler sparade.* tillsammans med hur många standardpriser och försäljningspriser som sattes. Misslyckas en artikel listas den med orsak; de övriga påverkas inte. En artikel vars kalkyl sparades men vars pris inte kunde sättas finns både bland de sparade och i felen. Därefter räknas tabellen om automatiskt, så **Förra TVK/st**, **Standardpris** och **Försäljningspris** visar det nya läget.

## Artikelöversikt

**Artiklar → Artikelöversikt** (`/artiklar/oversikt`) är artikelns planeringsbild: alla öppna behov och allt inkommande för en artikel, rad för rad i datumordning, med löpande disponibelt antal. Välj artikel i fältet **Artikel** (sökbart på artikelnummer eller benämning); vald artikel ligger i adressen så sidan kan bokmärkas.

Överst visas artikelnumret med benämning (länk till artikelkortet), artikeltyp, **Lagersaldo** (med **varav spärrat** när något står på en [spärrad lagerplats](/hjalp/lager#sparrade-lagerplatser)), **Beställningspunkt**, **Orderkvantitet**, **Avrundning** och **Huvudleverantör** med **Ledtid**. Tabellen har kolumnerna **Datum**, **Typ**, **Order**, **Kund/Leverantör**, **Antal** och **Disponibelt**:

- Första raden är **Lagersaldo idag** — utgångspunkten för kolumnen **Disponibelt**. Finns det saldo på spärrade lagerplatser heter raden **Lagersaldo idag (utan spärrat)** och räknar bara det som är till hands. Begreppet *saldo* används bara för det som faktiskt finns på lager (**Lagersaldo**); **Disponibelt** är vad som finns kvar att förfoga över efter behov och inkommande fram till och med raden.
- Därefter en rad per öppen orderrad, sorterad på datum: kundorderns datum (kundens avsändningsdag — leveransdatumet minus [transportdagar](/hjalp/forsaljning#leveransdagar) — medan kundorderkortet visar leveransdatumet), inköpsorderns förväntade leveransdatum respektive tillverkningsorderns färdigdatum. Rader utan datum visas sist som **Saknar datum**. Samma dag sorteras inkommande före behov.
- **Typ** är **Kundorder**, **Inköpsorder**, **Tillverkningsorder** (inleverans av artikeln själv), **Prognos** (för en prognosstyrd artikel — numret är t.ex. *Prognos 2026-11 · v.47*, utan länk och i dämpad text, eftersom det inte är en order; se [Prognos](/hjalp/lager#prognos)), **Material till TO** (materialrad på frisläppt/pågående order, planerat minus uttaget) eller **Material till planerad TO** (beräknat ur strukturen, precis som i behovsberäkningen). För materialrader visar **Kund/Leverantör** vilken artikel tillverkningsordern gäller. Ordernumret i kolumnen **Order** är en länk till orderkortet.
- **Antal** är negativt för behov och positivt för inkommande; **Disponibelt** är den löpande summan från lagersaldot och nedåt. Ett negativt disponibelt antal markeras i rött — det visar när artikeln tar slut.
- Inköpsorder i status **Utkast** räknas med men märks **Utkast**, precis som IO-utkast i behovsberäkningen.
- Raden **Ritningar** under artikelhuvudet listar artikelns filer från fliken **Filer** som länkar som öppnas i ny flik (**—** när det saknas filer eller de inte kunde hämtas).
- Ordernumren i kolumnen **Order** är bara länkar när du får öppna orderkortet; annars visas numret som vanlig text. Kundorder kräver **Försäljning**, inköpsorder **Inköp** och tillverkningsorder **Tillverkning** eller **Tillverkningsorder (läsläge)** — med bara läsläget öppnas kortet i läsläge. Samma sak gäller artikelnumret överst, som kräver **Artiklar**. Se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper).

**Material till TO** och **Material till planerad TO** dateras med tillverkningsorderns **startdatum**, alltså färdigdatum minus artikelns ledtid (se **Ledtid (dagar)** ovan) — inte färdigdatumet. Har ordern en planerad vecka i [planerade veckor](/hjalp/tillverkning#planerade-veckor) som är låst eller påbörjad, eller ligger senare än så, gäller i stället den veckan. Utan färdigdatum används planens vecka, annars saknar raden datum.

Samma regler som i [Behovsberäkning](/hjalp/tillverkning#behovsberakning) avgör vad som räknas: kundordrar i status **Bekräftad**/**Under tillverkning** (inte offerter), öppna inköpsordrar (legorader undantagna) och tillverkningsordrar i status **Planerad**/**Frisläppt**/**Pågår**. Det sista disponibla antalet är därför detsamma som behovsberäkningens **Netto** för artikeln, med skillnaden att härlett behov från ännu inte skapade orderförslag inte ingår — översikten visar bara verkliga ordrar. Förfrågningar och offerter visas inte.

### Panelen i listor och kort

Artikelöversikten finns också som en **flyttbar panel** som öppnas ovanpå den sida du arbetar i, utan att du lämnar den. Ikonknappen **Artikelöversikt** (tre rader) finns efter artikelnumret i behovsberäkningen, tillverkningsorderlistan, artikelregistret, lagersaldolistan och på inköps- och kundorderkortens rader, samt uppe till höger på artikelkortet. Panelen ligger kvar medan du fortsätter arbeta i listan: klicka på en annan rads knapp så byter panelen till den artikeln, eller byt artikel direkt i panelens fält **Artikel**. Dra i panelens huvud för att flytta den — läget sparas i webbläsaren. **Öppna sida** går till sidan ovan med samma artikel, **Stäng** (eller Esc) stänger panelen. På en smal skärm visas panelen i stället som ett ark längst ned på skärmen.

## Importera alla filer

Fliken **Alla filer** på **Artiklar → Importera** tar emot **alla exportfiler på en gång** i stället för en fil per flik. Guiden har fyra steg: **Filer**, **Kolumner**, **Förhandsgranska** och **Resultat**.

Mallar för varje fil laddas ned med **Ladda ned mall** i respektive flik; kolumnerna förklaras i [Importmallar](/hjalp/importmallar).

1. **Filer** — välj alla filer i filväljaren (flera kan markeras samtidigt). Varje fil läses in direkt och känns igen på sina kolumnrubriker: Artikellistan och dess delexporter (planering, extra benämning) som **Artiklar**, Enheter-filen som **Enheter**, Operationslistan som **Operationer**, Materiallistan som **Struktur**, Prislista Inköp (vanlig och stafflad) som **Inköpspriser**, Prislista Försäljning (vanlig och stafflad) som **Kundpriser** och en lista med artikelnummer, lagerplats (eller lagerställe) och antal (eller saldo) som **Lagersaldon**. En fil som inte känns igen (t.ex. Nivålistan) visas som **Okänd fil – hoppas över**. Listan visar radantal och igenkänd typ per fil; **Ta bort** plockar bort en fil. Fler filer kan läggas till innan du går vidare.
2. **Kolumner** — ett kort per fil, sorterat i importordning. Typen kan ändras i fältet på kortet (välj **Hoppa över filen** för att lämna en fil utanför), kolumnmappningen ligger hopfälld under **Kolumner (…)** och fungerar som i enfilsguiden, och under den finns filtypens egna val — **Hoppa över rader som redan finns**, **Standardtyp**, **Skapa saknade artiklar**, **Uppdatera befintliga operationer** osv. **Förhandsgranska alla** granskar alla filer i ett svep.
3. **Förhandsgranska** — ett kort per fil med sammanfattningen (nya, uppdateras, hoppas över, fel, varningar); kortet fälls ut automatiskt när filen har fel. Varje fil visas som den kommer att se ut när de tidigare filerna har importerats — operationer, struktur och priser för artiklar som artikelfilen skapar är alltså inte längre fel. Inget sparas förrän du klickar **Importera alla**. En fil med fel stoppar förhandsgranskningen av filerna efter den, som visar "Förhandsgranskas när felen i filen ovan är rättade." tills felet är rättat. **Importera alla** är låst tills ingen fil har fel — rätta filen, ta bort den eller sätt den till Hoppa över filen.
4. **Resultat** — filerna importeras i **beroendeordning**: artiklar → enheter → operationer → struktur → inköpspriser → kundpriser → lagersaldon (bland artikelfilerna först de som har en kolumn för benämning, eftersom bara de kan skapa nya artiklar — en delexport som Extra-fält kompletterar sedan), varje fil som en egen import (allt eller inget per fil, precis som i enfilsguiden). Misslyckas en fil stoppas körningen där: de redan importerade filerna står kvar, den misslyckade visar raderna som stoppade den, och de efterföljande visas som **ej importerad – stoppad av felet ovan**. Rätta felet och kör de återstående filerna igen — det som redan kommit in hoppas över eller uppdateras enligt filtypens regler. Överhoppade rader visas per fil med **Spara som fil** och **Skriv ut**.

Raderna med omräkningsfaktor 1 i Enheter-filen räknas som överhoppade — se [Importera alternativa enheter](#importera-alternativa-enheter).

## Importera artiklar

**Artiklar → Importera** läser in artiklar från fil, till exempel exporterade från ett tidigare affärssystem. Både **CSV** (semikolon, komma och tabb känns alla igen — även teckenkodningen identifieras automatiskt) och **Excel (.xlsx)** fungerar; av en arbetsbok läses bara det **första bladet**. Endast administratörer har åtkomst. Guiden har fyra steg: **Fil**, **Kolumner**, **Förhandsgranska** och **Resultat**.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#artiklar).

Sidan har åtta flikar — **Alla filer** (se [ovan](#importera-alla-filer)), **Artiklar**, **Enheter**, **Operationer**, **Struktur**, **Inköpspriser**, **Kundpriser** och **Lagersaldon**. Byter du flik börjar guiden om från steget **Fil**. Vid en migrering från ett annat system är ordningen **artiklar → enheter → operationer → struktur → inköpspriser → kundpriser → lagersaldon**: strukturens kolumn **Operation** slår upp en operation som redan måste finnas (saknas den importeras raden ändå, men utan koppling), och prisfilerna kräver att artiklar, leverantörer respektive kunder redan finns. Strukturimporten kan dessutom lägga upp de komponenter som inte kom med i artikelfilen — se [Importera artikelstruktur](#importera-artikelstruktur). Enheter beskrivs i [Importera alternativa enheter](#importera-alternativa-enheter), inköpspriser i [Inköp](/hjalp/inkop#importera-inkopspriser), kundpriser i [Försäljning](/hjalp/forsaljning#importera-kundpriser) och lagersaldon i [Lager](/hjalp/lager#importera-lagersaldon).

1. **Fil** — välj filen med filväljaren, så läses den in direkt. Första raden ska innehålla kolumnrubriker. Max 10 000 rader per fil.
2. **Kolumner** — varje kolumn i filen mappas mot ett fält: **Artikelnummer** är obligatoriskt (märkt *), övriga är **Benämning** (krävs för nya artiklar), **Artikeltyp**, **Enhet**, **Varugrupp (kod)**, **Artikelkod**, **Standardpris**, **Vikt (kg)**, **Ytbehandling**, **Färg**, **Extra benämning**, **Aktiv**, planeringsfälten **Beställningspunkt**, **Säkerhetslager**, **Styrning**, **Prognosstyrd**, **Ledtid (dagar)**, **Orderkvantitet**, **Avrundning** och **Partiformningsregel**, revisionsfälten **Artikelrevision**, **Ritningsnummer** och **Ritningsrevision** (se nedan) samt inköpsfälten **Antal per förpackning** och **Leverantörsnr** (se nedan). Kända rubriker (t.ex. "Artikelnummer", "Artikelbenämning", "Art.nr") föreslås automatiskt; kolumner satta till **Importera inte** hoppas över. Valet **Standardtyp** (Köpt/Tillverkad/Tjänst) används för nya artiklar när kolumnen Artikeltyp inte är mappad eller cellen är tom. Här finns också kryssrutan **Hoppa över rader som redan finns** — se [Hoppa över befintliga rader](#hoppa-over-befintliga-rader). Klicka **Förhandsgranska** för att gå vidare.
3. **Förhandsgranska** — varje rad visas som **Ny**, **Uppdateras** eller **Hoppas över** (matchning sker på artikelnummer) tillsammans med eventuella fel och varningar. Under **Skapas automatiskt** listas enheter, varugrupper och artikelkoder som inte finns i registren: okända enheter skapas med koden som namn, okända varugruppskoder skapas på samma sätt om de är 1–4 siffror (annars blir raden fel; en ny varugrupp får momssatsen 25 %), och en okänd artikelkod skapas med koden som både kod och namn. Heter en annan varugrupp eller artikelkod redan så får den nya namnet med ett löpnummer efter, t.ex. **3 (2)** — byt namn i registret efteråt. Knappen **Importera** är låst tills alla fel är åtgärdade — rätta filen och börja om från steget **Fil**.
4. **Resultat** — visar hur många artiklar som skapades, uppdaterades och hoppades över samt vilka register som skapades. **Klar** går tillbaka till artikelregistret.

Regler att känna till:

- **Allt eller inget.** Innehåller filen ett enda radfel importeras ingenting — det som förhandsgranskningen visar som fel måste rättas i filen först. Varningar stoppar däremot aldrig importen.
- **Tomma celler skriver aldrig över.** Vid uppdatering lämnas fält med tom cell orörda; vid ny artikel lämnas de tomma/med standardvärde.
- **Artikeltypen tolkas ur flera stavningar.** "Tillverkad" och "M" ger Tillverkad, "Köpt", "P" och "K" ger Köpt, "Tjänst" och "Lego" ger Tjänst. **"Fiktiv" (eller "F") är ett vanligt namn på en fantomartikel** och ger en **tillverkad** artikel med **fantomflaggan** satt — se [Artikeltyper](#artikeltyper). Att fiktiva artiklar blir tillverkade är avsiktligt: en fantomartikel löses upp till sina komponenter och måste därför ha en struktur, och fliken **Beredning** finns bara på tillverkade artiklar. Valet **Standardtyp** åsidosätts alltså av en Fiktiv-cell. Andra värden ger felet "Okänd artikeltyp".
- **Artikeltyp, fantomflagga och enhet ändras aldrig på befintliga artiklar.** Avviker filens värde från artikelkortet visas en varning och det gamla värdet behålls (enhetslåset — se avsnittet om enheter).
- Nya artiklar utan mappad enhet får grundenheten **st**, och lagerplatsen sätts till **\*\*\*** precis som när en artikel skapas för hand.
- Belopp och vikter tolkas med svenskt decimalkomma ("1 234,56"), och **Aktiv** förstår Ja/Nej, 1/0 och true/false.
- Samma artikelnummer två gånger i filen ger fel på den andra raden.
- **Revisioner och ritningar** (se [Revisioner](#revisioner)). **Artikelrevision** blir artikelns aktiva revision och läggs till om artikeln saknar den — den tidigare aktiva ligger kvar som inaktiv, och förhandsgranskningen varnar med "Aktiv artikelrevision byts från A till B". **Ritningsnummer** läggs till om artikeln saknar det; artikelns andra ritningsnummer ligger kvar. **Ritningsrevision** blir den aktiva revisionen för ritningsnumret på samma rad och läggs till om den saknas — utan ritningsnummer på raden blir det felet "Ritningsrevision kräver ett ritningsnummer på samma rad". Importen tar aldrig bort en revision eller ett ritningsnummer, och samma fil en gång till ändrar ingenting. Eftersom ett artikelnummer bara får förekomma en gång per fil importeras en artikels övriga ritningar i en ny körning.
- **Textformatera nummerkolumner i Excel.** Ett artikelnummer som `0042` lagras annars som talet 42 och importeras med den stavningen.
- **Delexporter av artikellistan** (utan benämningskolumn) importeras med samma flik som rena uppdateringar: matchningen sker på artikelnummer och bara de mappade kolumnerna skrivs.
  - **Planering** (rubrikerna **Nettovikt**, **Beställningspunkt**, **Säkerhetslager**, **Orderkvantitet**, **Avrundningsantal**, **Styrning**, **Partiformningsregel** och **Ledtid** känns igen): vikten går till **Vikt (kg)** och planeringsfälten till Lager-flikens [Planering](#lager). **Styrning** läses som **Lagerstyrd** eller **Orderstyrd**. Ett **0** i filen betyder "ingen" och tömmer fältet. **Orderkvantitet importeras bara på rader där Partiformningsregel är "Fast orderstorlek"** — med "Mot behov" är planeringen rent behovsstyrd, och en importerad orderkvantitet skulle göra artikeln till en multipelköpare här; en orderkvantitet som hoppas över (regeln är något annat eller tom) ger varningen "Orderkvantitet hoppades över — Partiformningsregel är inte Fast orderstorlek" på raden. Är kolumnen Partiformningsregel inte mappad tas orderkvantiteten som den är. **Avrundningsantal** med fler än 3 decimaler avrundas med en varning. **Ledtid** (hela dagar) hamnar där artikeltypen säger: en tillverkad artikel får den som **Ledtid (dagar)** på Lager-flikens planering, en köpt artikel som huvudleverantörens ledtid på Inköp-fliken — saknar den köpta artikeln huvudleverantör blir det varningen "Ledtiden importerades inte — artikeln har ingen huvudleverantör (importera Leverantörsnr först)", och en tjänst får ingen ledtid. Importera därför filen med **Leverantörsnr** (Inköp och Ritningsnummer) före Planering; fliken **Alla filer** gör det av sig själv. **Min. kvantitet**, **Säkerhetstid**, **Årsvolym** och de övriga planeringskolumnerna importeras inte (orderkvantiteten fungerar redan som minsta antal). Exporten har ingen kolumn för **Prognosstyrd** — lägg till den i filen eller använd importmallen: **Ja** eller **Nej** (även 1/0), och en tom cell lämnar en befintlig artikels val orört.
  - **Extra benämning** (rubrikerna **Artikelnummer**, **Extra benämning**, **Färg**): färgen går till **Färg** och extra benämning till fältet **Extra benämning**. Radbrytningar i cellen behålls, och en text på mer än 2 000 tecken ger ett radfel. En tom cell lämnar artikelns befintliga text orörd.
  - **Inköp och ritningsnummer** (rubrikerna **Antal/kolli (Inköp)** och **Leverantörsnr** känns igen, liksom revisions- och ritningskolumnerna ovan): antalet går till **Antal per förpackning** på Inköp-fliken (0 tömmer fältet), och leverantören blir artikelns **förvalda leverantör** på Inköp-fliken. Saknar artikeln en rad för leverantören läggs den till utan pris — priserna kommer med [inköpsprislistan](/hjalp/inkop#importera-inkopspriser) — och den tidigare förvalda leverantören ligger kvar men är inte längre förvald. Leverantören måste redan finnas, annars blir raden ett radfel (se [Importera leverantörer](/hjalp/inkop#importera-leverantorer)).

## Importera alternativa enheter

Fliken **Enheter** läser exporten **Artikellista, Enheter** — en rad per artikel och enhet, med rubrikerna **Enh.**, **Omr.faktor**, **Inköpsorder** och **Kundorder** (de känns igen automatiskt; Förvald, Materialuttag, Rapportera inleverans, Packa för leverans, Rapportera utleverans, Lagerrapportering och Statistik importeras inte). Kolumner: **Artikelnummer**, **Enhet** och **Omräkningsfaktor** är obligatoriska; **Inköpsenhet (Inköpsorder)** och **Försäljningsenhet (Kundorder)** är valfria.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#alternativa-enheter).

- **Raden med omräkningsfaktor 1 är artikelns grundenhet** och hoppas över — bara alternativa enheter importeras (de ligger på artikelkortets Allmänt-flik under **Enheter**). Avviker den radens enhet från artikelns grundenhet visas en varning; grundenheten ändras aldrig av importen. Står **Inköpsorder** eller **Kundorder** = Ja på grundenhetens rad blir grundenheten artikelns inköps- respektive försäljningsenhet igen — en alternativ enhet som en tidigare import valde tas alltså bort som förval.
- **Faktorn inverteras.** Filens Omr.faktor är antal *grundenheter per en alternativ enhet* (rundstål Ø12 med grundenhet kg: raden `m` säger 0,89 = 0,89 kg per meter). Nav lagrar det omvända — *alternativa enheter per grundenhet* — så 0,89 blir 1 kg = 1,123596 m (sex decimaler). Samma enhet som grundenheten med en annan faktor än 1 är ett fel.
- **Inköpsorder** respektive **Kundorder** = Ja på en alternativ rad gör enheten till artikelns **Inköpsenhet** respektive **Försäljningsenhet** (förvalet på inköps- och kundorderrader). Två enheter med samma flagga på en artikel är ett fel, även när den ena är grundenhetens rad.
- Okända enhetskoder skapas i enhetsregistret precis som i artikelimporten. Artikeln måste redan finnas.
- En alternativ enhet som redan finns på artikeln får sin faktor uppdaterad; med **Hoppa över rader som redan finns** lämnas den orörd.

Raderna med faktor 1 (en per artikel) listas som **Hoppas över** i förhandsgranskningen och resultatet — det är väntat och ingen brist i filen.

## Hoppa över befintliga rader

Kryssrutan **Hoppa över rader som redan finns** i steget **Kolumner** finns på alla importer — artiklar, enheter, inköps- och kundpriser, struktur och operationer, liksom kund- och leverantörsimporten. Den gör att rader vars post redan finns lämnas helt orörda:

- **Artiklar, enheter, priser, kunder och leverantörer** uppdateras inte. Utan kryss skrivs filens värden in på den befintliga posten; med kryss behålls posten precis som den är.
- **Struktur och operationer** stoppar inte längre importen. Utan kryss blir en rad som redan finns ett fel, och eftersom importen är allt-eller-inget avbryts hela filen. Med kryss importeras de nya raderna och resten hoppas över.

I steget **Förhandsgranska** visas de överhoppade raderna med åtgärden **Hoppas över** och en orsak. I steget **Resultat** räknas de som **överhoppade** och listas i tabellen **Överhoppade rader**:

- **Spara som fil** laddar ner hela listan som en CSV-fil (`overhoppade-…`) med alla mappade kolumner — öppna den i Excel för att se vad som inte kom in, rätta och importera om.
- **Skriv ut** öppnar listan i ett eget fönster och startar utskriften.

Listan på skärmen visar högst 200 rader, men den sparade och den utskrivna listan innehåller alltid alla.

Krysset gäller bara poster som redan finns i databasen. **Samma rad två gånger i filen är fortfarande ett fel** som avbryter importen — filen motsäger då sig själv och ska rättas. (Undantag: finns raden dessutom redan i databasen hoppas båda förekomsterna över, eftersom ingen av dem skulle skapa något.) Strukturimporten är ett undantag: där får samma komponent förekomma flera gånger på en artikel, se [Importera artikelstruktur](#importera-artikelstruktur).

## Importera artikelstruktur

Fliken **Struktur** på **Artiklar → Importera** läser in strukturrader (BOM) — en rad per komponent. Guiden har samma fyra steg som artikelimporten.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#artikelstruktur).

Kolumner: **Artikelnummer** (den tillverkade artikeln), **Komponentnummer** och **Antal** är obligatoriska; **Enhet**, **Operation**, **Pos.**, **Artikelbenämning (komponenten)**, **Komponentens artikeltyp** och **Komponentens standardpris** är valfria. De tre sista används bara tillsammans med **Skapa saknade artiklar**.

- **Den överordnade artikeln måste alltid redan finnas.** Ett okänt nummer i kolumnen Artikelnummer blir ett fel — filen bär varken artikeltyp eller enhet för den överordnade artikeln, så den kan inte skapas automatiskt. Importera artiklarna först.
- **Skapa saknade artiklar** är en kryssruta i steget **Kolumner**. Med den ikryssad lägger importen upp de **komponenter** som inte finns i artikelregistret i stället för att stoppa filen. Artikeln skapas ur radens egna kolumner: **Artikelbenämning (komponenten)** (obligatorisk när rutan är ikryssad), **Komponentens artikeltyp**, **Enhet** och **Komponentens standardpris**. En fil med **en enda** benämningskolumn får den mappad automatiskt, oavsett om rubriken heter **Artikelbenämning**, **Benämning** eller **Komponentens benämning**. Saknas typkolumnen eller är cellen tom används valet **Standardtyp**; "Fiktiv" ger en tillverkad artikel med fantomflaggan, precis som i artikelimporten. Enheter som inte finns i enhetsregistret skapas med koden som namn, och den nya artikeln får lagerplatsen `***` — samma regler som i artikelimporten. **Befintliga artiklar ändras aldrig** av strukturimporten: de tre kolumnerna läses bara för komponenter som saknas. De nya artiklarna listas under **Skapas automatiskt** i förhandsgranskningen och räknas upp i steget **Resultat**. Utan kryss är en okänd komponent fortfarande ett fel.
- **Första raden bestämmer.** Nämns samma nya komponent på flera rader skapas den en gång, med första radens uppgifter. Avviker benämning, artikeltyp eller standardpris på en senare rad visas en varning; avviker **enheten** blir raden ett fel — en ny artikel kan bara ha en grundenhet.
- **Enhet** avser en av **komponentens** enheter. Lämnas den tom används komponentens grundenhet. Anges en annan enhet måste den vara upplagd som **alternativ enhet** på komponenten (artikelkortets flik Allmänt), annars stoppas raden. Antalet räknas alltid om till och lagras i komponentens grundenhet. För en komponent som skapas av importen är enheten i stället artikelns **grundenhet**, och antalet räknas inte om.
- **Operation** anger sekvensnumret på en av artikelns egna operationer och styr när materialet dras (se [Koppla komponent till operation](#koppla-komponent-till-operation)). **Finns operationen inte** — antingen för att sekvensnumret saknas på rutten, eller för att artikeln inte har någon rutt alls — importeras raden ändå med en **varning**, men utan koppling: materialet dras då vid slutrapporteringen. Importera därför gärna operationerna före strukturen om kopplingen ska bli rätt. En [kalkyloperation](#kalkyloperationer) kan aldrig förbruka material och avvisas som **fel**, liksom ett värde som inte är ett heltal.
- **Kalkyl** förstår Ja/Nej, 1/0 och true/false; tom cell betyder Nej på en ny rad. Ja gör raden till en [kalkylrad](#kalkylrader-i-strukturen). Kolumnen **End. kal.** i en materiallista känns igen. En rad som är kopplad till en kalkyloperation kräver Kalkyl = Ja, annars blir det ett fel.
- **Pos.** är ritningspositionen på strukturraden, fri text på högst 20 tecken — en längre text blir ett radfel. Kolumnen **Pos.** i Materiallistan hamnar här automatiskt. Se artikelkortets [Beredning](#beredning).
- **Bara nya rader importeras som standard.** Ligger komponenten redan i artikelns struktur blir raden ett fel med texten "finns redan i strukturen" — ta bort den ur filen och importera om, kryssa i **Hoppa över rader som redan finns** (se [Hoppa över befintliga rader](#hoppa-over-befintliga-rader)) eller kryssa i **Uppdatera befintliga strukturrader** (nedan).
- **Samma komponent flera gånger** på en artikel är tillåtet, t.ex. på två positioner (**Pos.**) eller till två operationer — varje filrad blir en egen strukturrad. Förhandsgranskningen varnar med "Komponenten K ingår N gånger i strukturen för A" på alla rader för den komponenten. Finns komponenten redan i strukturen paras filens rader ihop med de befintliga: först rader med samma **Pos.**, därefter i tur och ordning. En ihopparad rad räknas som befintlig (fel, överhoppad eller uppdaterad enligt kryssrutorna ovan och nedan), en filrad som blir över läggs till som ny rad. Strukturen på artikelkortet står i filens radordning, så "i tur och ordning" är samma ordning som i filen den importerades från. Samma fil en gång till med **Hoppa över rader som redan finns** lägger därför inte till något.
- **Uppdatera befintliga strukturrader** är kryssrutan i steget **Kolumner** som i stället skriver över en komponent som redan ligger i artikelns struktur med filens **antal och enhet**, **operationskopplingen** när kolumnen **Operation** är mappad (en tom cell tar då bort kopplingen) och **Pos.** när cellen är ifylld (en tom Pos.-cell lämnar det sparade värdet orört) samt **Kalkyl** när kolumnen är mappad och cellen ifylld (en tom cell lämnar värdet orört). Frisläppta tillverkningsordrar påverkas inte — de behåller sin kopia av strukturen från frisläppet. Förhandsgranskningen visar raderna som **Uppdateras**. Kryssrutan kan inte kombineras med **Hoppa över rader som redan finns**; kryssar du i den ena släcks den andra.
- **Cirkulära strukturer stoppas.** En rad som skulle göra att en artikel innehåller sig själv, direkt eller via flera led, blir ett fel — även när cirkeln uppstår först av två rader i samma fil.

### Rapporten Materiallista

Rapporten **Materiallista** kan importeras rakt av. Guiden känner igen kolumnerna automatiskt trots att filen använder samma rubrik två gånger: **Huvudartikel** blir den överordnade artikeln, den **andra** kolumnen **Artikelnummer** blir komponenten och den andra **Artikelbenämning** blir komponentens benämning, medan **Artikeltyp**, **Till operation**, **Kvantitet**, **Enhet**, **Pos.** och **Standardpris** hamnar rätt av sig själva. Kontrollera ändå förslaget i steget **Kolumner**.

Kolumnerna **Pos.** och **End. kal.** hamnar på Pos. respektive Kalkyl av sig själva. Övriga kolumner importeras inte och ska stå på **Importera inte**: **Pgrp**, **Inst.kvant.**, **Extra %**, **Status**, **A**, **Beredare**, **Spärrad (material)**, **Ersättningsartikel**, **Instruktion**, **Filer (material)**, **Villkor**, **Från och med** och **Till och med**. Systemets strukturrad har varken spillprocent eller giltighetsdatum. Materiallistans **Instruktion** hör till materialraden; vår kommentar sitter på **operationen** och importeras från Operationslistan i stället (se [Importera operationer](#importera-operationer)).

Materiallistan bär allt som behövs för de komponenter som inte kom med i artikelexporten — kryssa i **Skapa saknade artiklar** så läggs de upp under importen.

## Importera operationer

Fliken **Operationer** på **Artiklar → Importera** läser in rutter — en rad per operation.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#operationer).

Kolumner: **Artikelnummer**, **Sekvensnr** och **Resurs** är obligatoriska; **Ställtid** och **Stycktid / Tid per enhet** krävs på varje rad med en vanlig resurs (se nedan); **Tidsenhet**, **Cykeltid**, **Beskrivning**, **Kalkyl**, **Kommentar**, **Packinstruktion**, **Legoleverantör**, **Ställpris**, **Styckpris** och **Transportkostnad** är valfria.

- **Artikeln måste redan finnas.** Är den inte tillverkad importeras operationen ändå, men med en varning — den används inte vid tillverkning.
- **Resurs** är resursens tresiffriga kod (se **Tillverkning → Resurser**). Resursen måste finnas i registret. Excel gör gärna om `007` till `7`; importen fyller på med nollor igen, men textformatera kolumnen om du vill vara säker.
- Rapporten **Operationslista** känns igen automatiskt: **Produktionsgrupp** blir Resurs, **Op.** blir Sekvensnr, **Operationens benämning** blir Beskrivning, **Instruktion** blir Kommentar, **Enhet** blir Tidsenhet, och **Ställtid**, **Stycktid** och **Endast kalkyl** hamnar rätt. (**Artikelbenämning** importeras däremot inte — det är artikelns namn, inte operationens.) Lägg upp resurserna under **Tillverkning → Resurser** först — importen skapar dem inte.
- **Ställtid** och **Stycktid** krävs för operationer på en vanlig resurs: en sådan rad utan någon av tiderna — kolumnen omappad eller cellen tom — blir ett radfel. Saknar momentet ställtid skriver du `0`, eftersom ett gissat värde skulle slå igenom i förkalkylen utan att synas. Legooperationer har inga tider, så filen behöver inte tidskolumnerna för dem.
- **Lego-operationslistan** (exporten **Operationslista, Lego**) känns igen automatiskt och läses med samma flik: **Produktionsgrupp** blir Resurs (en legoresurs), **Leverantör** blir **Legoleverantör**, **Ställkostnad** blir **Ställpris**, **Styckkostnad** blir **Styckpris** och **Transportkostnad** blir **Transportkostnad** — samma fält som i operationsdialogen för legoresurser (där heter legoleverantören **Leverantör**, se [Lego-operationer](#lego-operationer)). Leverantören måste finnas i registret; en tom cell ger legoresursens egen leverantör på en ny operation. Ställpriset avrundas till 2 och styckpriset till 4 decimaler, med en varning. Resursens och leverantörens namnkolumner, **Legoartikelnummer**, **Kötid**, leveransadressen och **Färg** importeras inte. Står lego-kolumnerna på en rad med en vanlig resurs ignoreras de med en varning. Med **Uppdatera befintliga operationer** skrivs bara ifyllda lego-celler, och en operation som flyttas från en legoresurs till en vanlig resurs får sina lego-uppgifter tömda, som i dialogen.
- **Tidsenhet** säger i vilken enhet de två tidskolumnerna är skrivna. Är kolumnen inte mappad, eller cellen tom, läses båda som **minuter** (ställtid i minuter, stycktid i minuter per styck). Operationslistan exporteras normalt med **antal/timme**: då är **Stycktid** antal styck per timme och **Ställtid** anges i **timmar** — importen räknar om (0,2 h blir 12 min, 360 st/h blir 0,1667 min/st) och sparar operationen med visningsenheten **st/h**. Även **minuter/enhet**, **timmar/enhet** (båda tiderna i timmar) och **sekunder/enhet** (båda tiderna i sekunder, operationen sparas med visningsenheten **sek/st**) förstås; en okänd enhet blir ett radfel, aldrig en gissning. En rad med antal/timme och stycktid 0 sparas som 0 min/st med en varning, eftersom 0 st/h saknar mening. Lagringen är alltid minuter — se [Tidsenhet på operationen](#tidsenhet-pa-operationen). På en **legoresurs** sätts tiderna alltid till 0 (med en varning om filen hade tider), precis som i dialogen.
- **Cykeltid** är operationens produktiva tid per styck (se [Cykeltid på operationen](#cykeltid-pa-operationen)). Operationslistans kolumn **Cykeltid** hamnar här — den lästes tidigare som ett alias för Stycktid, men gör inte det längre. Den räknas om med **samma Tidsenhet som Stycktid** (med antal/timme är 120 st/h lika med 0,5 min/st), 0 eller en tom cell betyder ingen cykeltid, och på en **legoresurs** ignoreras den. Med **Uppdatera befintliga operationer** skrivs bara en ifylld cell (0 tömmer cykeltiden).
- **Beskrivning** är operationens namn (operationslistans **Operationens benämning**), max 255 tecken — en längre text blir ett radfel. En kolumn med rubriken **Beskrivning** hamnar här, inte i Kommentar. Se [Beskrivning på operationen](#beskrivning-pa-operationen).
- **Kalkyl** förstår Ja/Nej, 1/0 och true/false; tom cell betyder Nej. Se [Kalkyloperationer](#kalkyloperationer).
- **Kommentar** är operationens fritext (operationslistans **Instruktion**), max 1000 tecken — en längre text blir ett radfel. Kryssrutan **Skriv ut kommentaren på arbetskortet** i steget **Kolumner** avgör om texterna skrivs ut på utskriften **Skriv ut TO (PDF)**: filen bär ingen egen kolumn för valet, så det gäller alla rader som har en kommentar. Utan kryss sparas kommentaren men skrivs inte ut — krysset kan sättas per operation efteråt på artikelkortet, se [Kommentar på operationen](#kommentar-pa-operationen).
- **Packinstruktion**, max 1000 tecken — en längre text blir ett radfel, aldrig en tyst avkortning. Se [Packinstruktion på operationen](#packinstruktion-pa-operationen).
- **Nya rader som standard.** Finns sekvensnumret redan på artikeln blir raden ett fel — ta bort den ur filen, eller kryssa i **Hoppa över rader som redan finns** (se [Hoppa över befintliga rader](#hoppa-over-befintliga-rader)). Operationer kan alltså läggas till på en artikel som redan har en rutt, så länge sekvensnumren är nya.
- **Uppdatera befintliga operationer** är kryssrutan i steget **Kolumner** som i stället skriver över en operation som redan finns (samma artikel och sekvensnummer) med filens **resurs, ställtid, stycktid, tidsenhet och Kalkyl**, samt **beskrivning, kommentar och packinstruktion** för de celler som är ifyllda — en tom textcell lämnar det sparade värdet orört, och utskriftsvalet för kommentaren följer kryssrutan **Skriv ut kommentaren på arbetskortet** bara på rader som har en kommentar. Det är så en rutt som importerats med fel tidsenhet rättas: kör om Operationslistan med kryssrutan i, så räknas tiderna om enligt **Enhet**-kolumnen. En operation som har material kopplat till sig kan inte märkas Kalkyl — raden blir ett fel tills operationskopplingen tagits bort på strukturraden, precis som på artikelkortet. Förhandsgranskningen visar raderna som **Uppdateras**. Frisläppta tillverkningsordrar påverkas inte — de behåller sin kopia av operationerna från frisläppet. Kryssrutan kan inte kombineras med **Hoppa över rader som redan finns**; kryssar du i den ena släcks den andra.

## Varugrupper

**Artiklar → Varugrupper** är registret som styr artikelns **kontering och moms**: varugruppen avgör vilket intäkts- och kostnadskonto en fakturarad bokförs mot (konteringsreglerna sätts per varugrupp och momskod, se [Konteringsregler](/hjalp/ekonomi#konteringsregler)) och vilken **Momssats** artikeln har. Varje varugrupp har en **kod (1–4 siffror)**, en **benämning** och en **Momssats** (**25 %**, **12 %**, **6 %** eller **0 %**, förvalt 25 %), samt en valfri **Beskrivning** (högst 500 tecken, visas som kolumn i listan). Listan visar momssatsen i kolumnen **Moms**; registret är platt utan huvudgruppsnivå. Skapa med **+ Ny varugrupp**, redigera genom att klicka på namnet.

Artikeln kopplas till varugruppen på artikelkortets Allmänt-flik. **Alla artiklar i en varugrupp får gruppens momssats**: ändrar du **Momssats** på varugruppen följer alla dess artiklar med, och fakturarader ärver satsen som förval. En artikel utan varugrupp får 25 %. På artikelkortet är **Momssats** därför ett skrivskyddat fält bredvid **Varugrupp** (till exempel "12 % (från varugruppen)" eller "25 % (ingen varugrupp)") — byt varugrupp om artikeln ska ha en annan sats.

**Generellt påslag (%)** och **Materialpåslag (%)** är gruppens egna prispåslag för förkalkylen (0–1000, högst två decimaler). Är fältet **tomt** — platshållaren visar *Företagets* med värdet, till exempel *Företagets (25 %)* — gäller företagets värde under [System → Kalkyler](/hjalp/system#paslagen); **0** betyder uttryckligen 0 %. Fälten avgörs var för sig, så en grupp kan ha eget generellt påslag och ärva materialpåslaget. Påslagen gäller bara försäljningspriset: **självkostnaden** och standardpriset påverkas inte. Listan visar dem i kolumnen **Påslag**, till exempel *40 % / —* (generellt / material, **—** där gruppen ärver). En ändring loggas i händelseloggen som **Påslag ändrade**, och redan sparade kalkyler räknas inte om. Att ändra påslagen kräver behörigheten **Artiklar**.

Fältet **Nummerserie** väljer vilken artikelnummerserie nya artiklar i gruppen får sina nummer ur — standardserien **Artikelnummer** eller en egen artikelserie (se [System → Nummerserier](/hjalp/system#nummerserier)), se [Artikelnummer ur en nummerserie](#artikelnummer-ur-en-nummerserie). Finns det kostnadsställen har gruppen även **Kostnadsställe (förval)**, som sätts på faktura- och leverantörsfakturarader för gruppens artiklar när inget annat kostnadsställe anges, se [Kostnadsställen och projekt](/hjalp/ekonomi#kostnadsstallen-och-projekt).

## Artikelkoder

**Grunddata → Artikelkoder** (under Inköp, Försäljning eller Artiklar) är ett register för **urval och gruppering i listor**. Varje artikelkod har en **kod** (högst 20 tecken), en **benämning** (högst 100) och en valfri **Beskrivning** (högst 300 tecken); kod och benämning är unika. Artikelkoden påverkar inte kontering eller moms — det gör varugruppen.

- **Sätt koden** på artikelkortets Allmänt-flik (fältet **Artikelkod**, **–** tar bort den) och i **Ny artikel**. Vid **Kopiera från** med **Information** förifylls den från förlagan. Importen sätter den från kolumnen **Artikelkod**, se [Importera artiklar](#importera-artiklar).
- **Välj ut på den** med filtret **Alla artikelkoder** i artikelregistret (kolumnen **Artikelkod** visar koden på varje artikel), i [Orderförteckningen](/hjalp/rapporter#orderforteckning) och i [Lagervärderingen](/hjalp/lager#lagervardering), där **Gruppera** också kan sättas till **Artikelkod** så att rapporten delas upp per artikelkod i stället för per varugrupp. Artiklar utan artikelkod samlas under **Utan artikelkod**.
- **Skapa och ändra** kräver behörigheten **Artiklar**. **Ta bort** (administratörer) fungerar som för övriga register: används koden på artiklar visar dialogen vilka, och du väljer en annan artikelkod under **Flytta kopplingarna till** — artiklarna flyttas dit och koden tas bort.
