# PROJECT.md — Rover

> Żywy dokument. Aktualizowany na bieżąco w trakcie pracy nad narzędziem.
> Ostatnia aktualizacja: 2026-08-27

---

## 1. Po co to robimy

Agent pracujący nad aplikacją mobilną potrafi ją zbudować i skompilować, ale nie potrafi na nią
**spojrzeć**. Kompilator nie ma zdania o pikselach: zielony build nie mówi nic o promieniu 12dp,
który miał być 10dp, ani o ekranie, który wygląda dobrze i przy tapnięciu nie robi nic.

Rover daje agentowi ręce i oczy do prawdziwego urządzenia: stuka, przewija, pisze, robi zrzuty
ekranu, czyta teksty z hierarchii widoków, nagrywa wideo, przestawia stan sieci. I — co ważniejsze
— **rozdziela urządzenia między agentów**, żeby dwóch pracujących równolegle nie zdeptało sobie
nawzajem przebiegu.

To nie są testy automatyczne. Nic się nie zapala na czerwono samo z siebie, nic nie jest
asercją, nic nie ląduje w CI jako bramka. To jest przeklikiwanie aplikacji, tylko wykonywane
przez agenta i z liczbami zamiast wrażeń.

### Skąd wzięliśmy wymagania

Zestaw czasowników i lista pułapek pochodzą z rzeczywistej praktyki na projekcie
Compose Multiplatform (`giotto-ai-demo`), gdzie ta metoda była prowadzona ręcznie przez agentów
przez kilka tygodni: 428 linii opisu metody, plikowy lease na sprzęt i trzy rozjeżdżające się
kopie tej samej procedury w trzech skillach. Rover nie ma z tamtym projektem żadnego związku
poza tym, że to on ujawnił, czego takie narzędzie potrzebuje. **Nic specyficznego dla tamtej
aplikacji nie wchodzi do rovera.**

---

## 2. Model działania

### Cztery strony

| Kto | Ile sztuk | Czas życia | Rola |
|---|---|---|---|
| **Agent** | wielu naraz | sesja | Pracuje nad aplikacją. Nie wie nic o adb ani o tym, gdzie fizycznie stoi urządzenie |
| **Serwer MCP** | jeden na agenta | sesja agenta | Wystawia czasowniki. Jest **klientem** hosta, nie wykonawcą |
| **CLI** | na wywołanie | sekundy | Ten sam klient dla człowieka i dla skryptu |
| **Host urządzeń (demon)** | jeden na maszynę **ze sprzętem** | długo | Trzyma urządzenia, rozdaje lease'y, **wykonuje czasowniki**, sprząta |

Dlaczego demon musi istnieć osobno: dwóch agentów pracujących równolegle ma **dwa osobne serwery
MCP**, które nie mają jak się ze sobą dogadać. Demon jest tym jednym miejscem, które widzi obu
i pilnuje, żeby nie weszli na to samo urządzenie. Bez niego nieprzypięta instalacja jednego agenta
trafia na urządzenie drugiego — a zrzut ekranu z cudzego builda to zielona weryfikacja kodu,
którego się nie napisało. To najgorszy tryb porażki, jaki ta klasa narzędzi ma.

### Agent i urządzenie nie muszą stać na tej samej maszynie

To jest istota narzędzia, nie rozszerzenie: **rover jest hostem urządzeń, a agenci — skądkolwiek
pracują — wypożyczają je od niego**. Maszyna z podpiętymi telefonami i uruchomionymi emulatorami
rzadko jest tą samą, na której siedzi agent, a sprzęt jest najdroższym i najmniej podzielnym
zasobem w tym układzie. Narzędzie, które wypożycza tylko lokalnie, wypożycza jednemu człowiekowi.

Relacja do Swarma jest **odwrócona**. Swarm rozsyła pracę do workerów stojących na wielu maszynach;
rover stoi w miejscu i wypożycza urządzenia tym, którzy się do niego zgłoszą. Stąd trzy rzeczy,
które inaczej byłyby tylko wygodą: host jest adresowalny po sieci (D17), urządzenie ma dokładnie
jednego właściciela-hosta (D18), a czasowniki wykonują się **tam, gdzie stoi urządzenie** (D19).

### Przebieg

1. Klient agenta łączy się z hostem — lokalnym gniazdem albo skonfigurowanym hostem zdalnym.
2. Agent prosi o urządzenie o określonych cechach (platforma, ewentualnie konkretny model).
3. Host sprawdza w adb, co jest wolne, przyznaje **lease** i zwraca uchwyt urządzenia razem
   z listą tego, co na nim wolno zrobić. Uchwyt nazywa host, nie tylko seriala (D18).
4. Agent woła czasowniki, podając ten uchwyt. Wykonuje je host; klient dostaje wynik i artefakty.
   Każde wywołanie odsuwa wygaśnięcie lease'u.
5. Agent zwalnia urządzenie. Host przywraca stan wyjściowy.
6. Jeśli agent umrze, straci sieć albo po prostu nie zwolni — lease wygasa po 20 minutach
   bezczynności i host sprząta tak samo. Zerwane połączenie nie jest osobnym mechanizmem: jest
   brakiem kolejnych wywołań.

---

## 3. Decyzje (zapadłe)

| # | Decyzja | Dlaczego | Data |
|---|---|---|---|
| D1 | **Osobne repozytorium, zero związku z projektem źródłowym** | Narzędzie ma obsłużyć dowolną aplikację mobilną. Wszystko, co wie o konkretnym produkcie, jest długiem od pierwszego dnia | 2026-08-27 |
| D2 | **Node.js** | Warstwa jest cienka: procesy, gniazda, parsowanie XML-a i JSON-a, trochę obróbki obrazu. Ekosystem MCP jest tu u siebie | 2026-08-27 |
| D3 | **Dwa procesy: host urządzeń per maszyna ze sprzętem, klient per agent** | Urządzenia są zasobem współdzielonym, a sesja agenta nie jest. Jedno bez drugiego albo nie skaluje się na dwóch agentów, albo wymaga ręcznego startu. **Zrewidowane:** pierwotne brzmienie („demon per maszyna, serwer MCP per agent") milcząco zakładało, że obie strony stoją na tej samej maszynie. To założenie upadło wraz z D17; podział procesów nie | 2026-08-27, zrewidowane 2026-08-27 |
| D4 | **Rdzeń + CLI, MCP jako cienka nakładka na ten sam rdzeń** | CLI debuguje człowiek, CLI działa bez agenta, CLI nie wymaga konfiguracji MCP w każdym projekcie. MCP dochodzi potem i nic nie duplikuje. Odwrotna kolejność zamyka narzędzie w agencie | 2026-08-27 |
| D5 | **Demon startuje sam przy pierwszym wywołaniu** | Precedens `adb`, który forkuje własny serwer na 5037 i nikt tego nie zauważa. Ręczny start to krok, o którym ktoś zapomni w najgorszym momencie. Dotyczy hosta **lokalnego**; host zdalny jest długo żyjącą usługą, którą uruchamia jego operator, i klient nigdy go nie startuje zdalnie | 2026-08-27 |
| D6 | **Demon jest cache'em, adb jest prawdą** | Demon wprowadza tryb porażki, którego plikowy lease nie miał: własny nieświeży stan. Więc nie trzyma niczego, czego nie umie odtworzyć z `adb devices`, i weryfikuje urządzenie przy każdym przyznaniu lease'u | 2026-08-27 |
| D7 | **Lease per urządzenie, nie muteks na całą maszynę** | Poprzednik brał cały sprzęt na wyłączność, bo był plikiem. Przy dwóch i więcej urządzeniach to marnuje wszystkie poza jednym | 2026-08-27 |
| D8 | **TTL 20 minut, odnawiany przy każdym wywołaniu** | Agent bywa bezczynny przez długie minuty myślenia, więc stały budżet czasu jest zły w obie strony. Agent martwy nie wywoła już nic i wygaśnie sam, bez heartbeatu po stronie klienta | 2026-08-27 |
| D9 | **Przywracanie stanu wymuszone, nie proszone** | Poprzednik *prosił* w komentarzu o przywrócenie stanu przed zwolnieniem i nikt tego nie sprawdzał. Demon robi to sam przy zwolnieniu **i** przy wygaśnięciu: zatrzymanie aplikacji, tryb samolotowy wyłączony, wifi z powrotem, hooki projektu | 2026-08-27 |
| D10 | **Jeden zestaw czasowników. Platforma jest cechą urządzenia, nie nazwą narzędzia** | Rozważone i odrzucone: `tap_android` / `tap_ios`. Sufiksy podwajają listę narzędzi (agenci wybierają tym gorzej, im dłuższa lista), zmuszają do pisania każdego scenariusza dwa razy i każą agentowi pamiętać, na czym stoi. Urządzenie i tak wie, czym jest | 2026-08-27 |
| D11 | **Negocjacja zdolności zamiast najmniejszego wspólnego mianownika** | Backendy nie są symetryczne i nie da się tego ukryć. Każdy deklaruje, co potrafi; czasownik bez pokrycia kończy się **głośnym błędem**, nie cichą degradacją. Sufiks mówi „nie ma takiego narzędzia" i każe się domyślać; odmowa mówi wprost, czego brakuje | 2026-08-27 |
| D12 | **Determinizm to trzy reguły w warstwie czasowników, nie własność demona** | (a) żadnych współrzędnych z pamięci — cel rozwiązywany ze świeżego zrzutu hierarchii **wewnątrz** czasownika; (b) żadnych `sleep` — wyłącznie czekanie na warunek z limitem czasu; (c) każda akcja zwraca stan po sobie, żeby agent nigdy nie zgadywał, czy trafił | 2026-08-27 |
| D13 | **Wszystko specyficzne dla projektu to hooki w konfiguracji** | Komenda instalacji, start usług pomocniczych, sprzątanie, ścieżki do renderów. Rdzeń nie zna nazwy żadnej aplikacji | 2026-08-27 |
| D14 | **Każdy wynik nazywa urządzenie i jego gęstość** | Dwa emulatory o różnej gęstości dają różne — i oba poprawne — pomiary tego samego elementu. Bez nazwania urządzenia dwa raporty są sprzeczne i nie wiadomo, który kłamie | 2026-08-27 |

| D15 | **Architektura wzorowana na projekcie Swarm (`../swarm`)** | Swarm to działający kod w Node.js prowadzony przez tego samego autora, ze sprawdzonym zestawem konwencji (TypeScript strict/ESM, Biome, Vitest, Zod jako źródło prawdy, rejestr providerów). Providery Swarma to tutaj backendy urządzeń — ten sam kształt modułu. Wymyślanie własnych konwencji nie kupiłoby nic | 2026-08-27 |
| D16 | **Rover i Swarm będą zintegrowane; przygotowanie zaczyna się teraz** | Swarm ma docelowo pokazywać, że dany przebieg trzyma urządzenie rovera. Nic nie trzeba budować od razu, ale dwie rzeczy muszą być tak zaprojektowane od początku: stan demona odpytywalny przez coś, co nie jest agentem, oraz lease z jawnym właścicielem, w który Swarm wstawi identyfikator swojego przebiegu | 2026-08-27 |
| D17 | **Host urządzeń jest osiągalny po sieci; agent nie musi na nim stać** | Maszyna ze sprzętem rzadko jest maszyną agenta, a sprzęt jest tu najdroższym i najmniej podzielnym zasobem. Narzędzie wypożyczające wyłącznie lokalnie obsługuje jedną osobę i zostawia telefony bezczynne przez większość doby. Lokalne gniazdo zostaje ścieżką domyślną i zerokonfiguracyjną; nasłuch sieciowy jest **drugim transportem tej samej powierzchni**, nie drugą implementacją — inaczej jedna z dwóch zaczyna się rozjeżdżać w tygodniu, w którym powstała | 2026-08-27 |
| D18 | **Urządzenie należy do dokładnie jednego hosta — tego, do którego jest podpięte** | `adb connect B:5555` sprawia, że emulator z maszyny B widać w `adb devices` na A, i kusi, bo „prawie działa". Wtedy dwa hosty uważają to samo urządzenie za swoje i wolne, i obydwa przyznają na nie lease — dokładnie ten tryb porażki, dla którego D3 i D7 w ogóle istnieją, tylko trudniejszy do zauważenia, bo obie strony widzą zielono. Klient prosi o urządzenie ten host, który je posiada; nigdy nie zgłasza roszczenia przez adb po TCP | 2026-08-27 |
| D19 | **Czasowniki wykonują się po stronie hosta; adaptery są klientami** | Alternatywa — klient dostaje seriala i sam woła adb — wymaga sieciowej dostępności adb, czego zakazuje D18, a przy tym stawia hooki projektu i usługi pomocnicze (D13, alokacja portów) po drugiej stronie sieci niż urządzenie, które mają obsłużyć. Rdzeń pozostaje biblioteką; zmienia się tylko to, który proces go ładuje. Konsekwencja, o której trzeba pamiętać w każdym czasowniku zwracającym plik: artefakty wracają jako bajty, a ścieżka podana agentowi musi istnieć **na jego maszynie** | 2026-08-27 |
| D20 | **Token hosta uwierzytelnia; właściciel lease'u atrybuuje. To dwa różne pola** | Cokolwiek nasłuchuje na sieci, wpuszcza obcych, więc host musi mieć wspólny sekret. Kuszące jest wyprowadzenie właściciela z tego, kto się uwierzytelnił — i wtedy albo token ląduje w raportach i logach, albo atrybucji nie da się nadpisać, a Swarm ma tam wstawić identyfikator swojego przebiegu (D16). Token mówi „wolno ci brać stąd urządzenia", właściciel mówi „to trzyma `pr-127-review`" | 2026-08-27 |

---

## 4. Zestaw czasowników

Nazwy robocze. Wszystkie przyjmują uchwyt urządzenia.

### Urządzenia i lease

| Czasownik | Co robi |
|---|---|
| `list_devices` | Co jest podłączone, co wolne, co czyje |
| `acquire_device` | Bierze urządzenie na wyłączność; zwraca uchwyt i listę zdolności |
| `release_device` | Oddaje i przywraca stan wyjściowy |

### Wejście

| Czasownik | Uwagi |
|---|---|
| `tap` | Po tekście lub identyfikatorze elementu; współrzędne to droga awaryjna |
| `long_press` | Realizacja przez przeciągnięcie w miejscu z czasem trwania |
| `swipe` / `scroll` | |
| `type_text` | Ukrywa escapowanie spacji i znaków spoza ASCII |
| `press_key` | Wstecz, ekran główny, ostatnie, wybudzenie |

### Odczyt

| Czasownik | Uwagi |
|---|---|
| `screenshot` | |
| `read_screen` | Teksty i prostokąty elementów. **Działa nawet, gdy aplikacja blokuje zrzuty ekranu** |
| `record_video` | Nagranie plus pocięcie na klatki — dla stanów, które nie stoją w miejscu |
| `device_info` | Rozmiar, gęstość, wyliczona szerokość w dp, wersja systemu |

### Czekanie

| Czasownik | Uwagi |
|---|---|
| `wait_for` / `wait_until_gone` | Odpytywanie ekranu do skutku z limitem czasu. **Zastępuje `sleep`**, który jest głównym źródłem fałszywych wyników |

### Aplikacja i środowisko

| Czasownik | Uwagi |
|---|---|
| `install_app` / `launch_app` / `stop_app` / `clear_app_data` | |
| `read_logs` | Wykrywa awarię, której zrzut ekranu nie pokaże |
| `set_airplane_mode` / `set_wifi` | Patrz §6 — receptury bez roota |
| `pull_file` / `push_file` | |

---

## 5. Warstwa urządzenia i szew pod iOS

iOS nie jest teraz budowany, ale kod ma go przyjąć bez przepisywania. Szew **nie idzie** po linii
„adb kontra simctl" — idzie po interfejsie urządzenia: enumeracja, cykl życia, instalacja,
sterowanie aplikacją, zrzut ekranu, odczyt hierarchii, wejście.

Trzy rzeczy, które trzeba wiedzieć teraz, żeby nie zaprojektować się w róg:

- **`simctl` nie umie ani stuknąć, ani zrzucić hierarchii.** Potrafi zrzut ekranu, instalację
  i cykl życia. Wejście i odczyt drzewa wymagają `idb` albo WebDriverAgent — ciężkiej zależności
  z własnym cyklem życia.
- **Odczyt semantyczny ekranu nie ma taniego odpowiednika na iOS.** Na Androidzie to jedyna
  zdolność, która przechodzi przez blokadę zrzutów ekranu. Na iOS może się nie dać w ogóle.
- Stąd D11: `read_screen` **nie jest metodą obowiązkową** interfejsu. Jest deklarowaną
  zdolnością, o którą warstwa czasowników pyta, zanim jej użyje.

---

## 6. Ustalenia techniczne (zweryfikowane empirycznie)

Sprawdzone na emulatorze API 37, 2026-08-27. Utarte receptury krążące po internecie są tu
częściowo martwe.

- **`svc wifi` i `svc data` już nie istnieją.** Na API 37 `svc` ma tylko `power`, `usb`, `nfc`
  i `system-server`. Każdy przewodnik używający `svc wifi disable` jest przestarzały.
- **Działa, bez roota:** `cmd connectivity airplane-mode enable|disable`
  oraz `cmd wifi set-wifi-enabled enabled`.
- **`input` na API 37 daje:** `tap`, `swipe`, `draganddrop`, `motionevent`,
  `scroll --axis VSCROLL,n`, `keyevent`, `keycombination`, `text`.
- **Długie przytrzymanie to nie `keyevent --longpress`** — ta flaga dotyczy klawiszy, nie dotyku.
  Robi się je przeciągnięciem z punktu w ten sam punkt z zadanym czasem.
- **Odcisk palca na emulatorze:** `adb emu finger touch 1`. Na urządzeniu fizycznym potrzebny
  jest prawdziwy palec — to najostrzejsza asymetria emulator/telefon.
- **Skala px→dp to `wm density` ÷ 160**, wyprowadzana z urządzenia za każdym razem. Nigdy
  z szerokości zrzutu ekranu — ten błąd daje 5% odchyłki w jedną stronę, więc wygląda jak stos
  drobnych niedociągnięć, a nie jak pomyłka w arytmetyce, i dlatego przeżywa.
- **Zrzut ekranu bywa czarny, a aplikacja jest zdrowa.** Aplikacja może zablokować przechwytywanie
  ekranu; system oddaje wtedy czarny bufor bez żadnego błędu w logu. Kontrola: zrzut ekranu
  głównego systemu. Hierarchia widoków jest wtedy nadal czytelna.

---

## 7. Zakres

**W zakresie:** Android przez adb — emulatory i urządzenia fizyczne w trybie debugowania
traktowane jednakowo. Pula urządzeń, lease'y, przywracanie stanu. Czasowniki z §4. CLI i MCP.
Host osiągalny po sieci: agent na maszynie A wypożycza urządzenie z maszyny B, na której stoi
rover (D17–D20). Uwierzytelnienie tokenem hosta.

**Poza zakresem na teraz:** iOS (tylko szew, patrz §5). Testy automatyczne z asercjami. CI.
Farmy urządzeń w chmurze, katalog hostów, rejestracja hostów u siebie nawzajem i cokolwiek, co
przypomina panel — klient dostaje listę hostów z konfiguracji i tyle. Porównywanie do renderów — rover dostarcza zrzuty i pomiary, ocena
zgodności z projektem graficznym należy do agenta.

---

## 8. Czego ta metoda nie zobaczy

Warto nazwać wprost, bo milczenie czyta się jako „sprawdzone".

- **Nic nie zapala się na czerwono samo.** Nie ma tu żadnej asercji; jakość wyniku zależy od
  uwagi agenta, nie od narzędzia.
- **Kolor, krój, grubość, promień i odstępy — tylko gdy aplikacja pozwala się fotografować.**
  Blokada zrzutów ekranu odbiera piksele, zostawia semantykę.
- **Ruch jest wyłącznie próbkowany.** Klatki mówią, że coś się obróciło; nie mówią nic o easingu,
  czasie trwania ani o zacięciach.
- **Błąd pomiaru ±1–3 px**, gorzej przy krawędziach wygładzanych. Różnicy 1dp nie zgłasza się jako
  usterki bez sprawdzenia w kilku punktach.
- **Jedna gęstość na urządzenie.** Wynik z jednego emulatora nie jest wynikiem dla wszystkich
  telefonów — patrz D14.

---

## 9. Stan prac i backlog

### 9.1 Zrobione

- [x] Ustalenie zakresu czasowników i modelu działania
- [x] Weryfikacja receptur adb na API 37 (§6)
- [x] `PROJECT.md`, `.gitignore`
- [x] Reguły dla agentów: `CLAUDE.md` → `ai/RULES.md`, plus `ai/CODING_STANDARDS.md`, `ai/ARCHITECTURE.md`, `ai/TESTING.md`
- [x] Board (`ai/RULES.md` §5) i skille `/write-issue`, `/solve-issue`

### 9.2 Jak z tego backlogu robić issues

**Jeden wiersz tabeli poniżej to jedno issue.** Zakłada się `/write-issue` — to on pisze
specyfikację, dobiera etykiety, wstawia kartę do kolumny Backlog i zapisuje relacje **Blocked by**.
Wiersz nie jest specyfikacją; ustala cztery rzeczy, których nie chcemy negocjować od nowa przy
każdym issue: **rezultat**, **granicę zakresu**, **zależności** i **rozmiar**.

Trzy reguły przy zakładaniu tych issues:

1. **Zakładaj je w kolejności z tabeli** i od razu zapisuj `Blocked by`, bo prawie każde ma realny
   warunek wstępny. Kolejność w kolumnie Backlog ma odzwierciedlać tę tabelę.
2. **Kryterium ukończenia z kolumny „Rezultat" wchodzi do issue jako kryterium akceptacji**,
   dosłownie. Jest tak sformułowane, żeby dało się je sprawdzić, a nie tylko uznać.
3. **Numer wiersza jest identyfikatorem, nie pozycją.** R21–R24 doszły po założeniu pierwszych
   dwudziestu (zdalne hosty, D17–D20) i stoją tam, gdzie stawia je kolejność zależności, a nie na
   końcu tabeli. Kolumna Backlog ma odzwierciedlać kolejność wierszy, nie ich numerację.
4. **Nie rozbijaj wiersza na podzadania na etapie zakładania.** Jeśli w trakcie pracy okaże się za
   duży, dzieli go implementujący — wtedy wiadomo, gdzie przebiega szew.

### 9.3 Backlog w kolejności zależności

| # | Zadanie | Rezultat — kryterium ukończenia | Zależy od | Size |
|---|---|---|---|---|
| R1 | Szkielet Node.js | `package.json`, `tsconfig.json` + `tsconfig.typecheck.json`, `biome.json`, `vitest.config.ts`, `lefthook.yml`, commitlint, skrypty `lint` / `typecheck` / `test:unit` / `test:device` / `verify`. **`npm run verify` przechodzi na pustym drzewie.** Konfiguracja kopiowana z `../swarm`, nie wymyślana | — | S |
| R2 | Interfejs urządzenia, manifest zdolności, rejestr | Manifest jest schematem Zod; rejestr przyjmuje backend przez jeden import w barrelu. **Żaden plik poza `src/backends/` nie zawiera nazwy platformy.** Bez żadnego backendu | R1 | M |
| R3 | Suita conformance backendów | Jeden przebieg na **zarejestrowany** manifest. Wykrywa stub czytając źródło metody; deklarowana zdolność bez dispatchu = porażka; jawny opt-out (`false`) przechodzi. Bramka musi istnieć **przed** pierwszym backendem (`ai/TESTING.md`) | R2 | M |
| R4 | Parsery wyjścia adb + fixture'y z prawdziwego urządzenia | `adb devices -l`, `wm size`, `wm density`, `getprop`, XML z `uiautomator`. Fixture'y w `tests/fixtures/` z API i modelem w nazwie pliku. **Żaden parser nie wnioskuje niczego z kształtu seriala** | R1 | M |
| R5 | Backend Android: enumeracja, `device_info`, cykl życia | Pierwszy zarejestrowany manifest — `index.ts` ląduje w fazie, która usuwa ostatni stub, nie wcześniej. Raportuje gęstość i wyliczoną szerokość w dp (D14) | R2, R3, R4 | L |
| R6 | Demon: proces, gniazdo, autostart, IPC | Autostart przy pierwszym wywołaniu (D5). **Dwa równoległe wywołania CLI dają jeden demon** — przegrany bindu łączy się do zwycięzcy, nie do pliku blokady. Każdy komunikat parsowany schematem, nigdy rzutowany. **Powierzchnia IPC jest niezależna od transportu od pierwszego dnia** (D17) — nasłuch sieciowy z R22 ma być dołożonym transportem, nie przepisaniem | R1 | M |
| R7 | Inwentarz urządzeń w demonie | Strumień `adb track-devices` plus **ponowna weryfikacja przy każdym przyznaniu** (D6). Urządzenie, które zniknęło w trakcie lease'u, jest nazwanym błędem, nie wyjątkiem od reguły. **Host nie bierze do inwentarza urządzenia dopiętego przez `adb connect` do cudzego hosta** (D18) — odmowa jest głośna i nazywa powód | R5, R6 | M |
| R8 | Lease'y | Przyznanie per urządzenie (D7), właściciel jawnym stringiem (D16), TTL 20 min **odnawiany aktywnością**, nie heartbeatem (D8). **Test z pięcioma równoległymi klientami wyłania dokładnie jednego zwycięzcę** — poprzednik przepuścił czterech. Lease przyznaje wyłącznie host posiadający urządzenie, a uchwyt nazywa host (D18) | R7 | L |
| R9 | Przywracanie stanu | Zatrzymanie aplikacji, tryb samolotowy wyłączony, wifi z powrotem, hook projektu. **Test dowodzi, że teardown uruchamia się także na ścieżce wygaśnięcia**, nie tylko przy `release` (D9) | R8 | M |
| R10 | CLI: `list`, `acquire`, `release`, `status` | Czytelne dla człowieka i skryptowalne. To jest interfejs, którym debuguje się wszystko powyżej (D4). Host wskazywany flagą; brak flagi to host lokalny | R8 | S |
| R11 | Fundament warstwy czasowników | Rozwiązywanie celu ze **świeżego** odczytu wewnątrz czasownika, czekanie na warunek z timeoutem, zwracanie stanu po akcji (D12). **W repo nie ma ani jednego `sleep`** — egzekwowane regułą lintera albo testem. Timeout mówi, na co czekał i co zastał zamiast tego. Wynik czasownika jest serializowalny — wykona go host, nie klient (D19, R21) | R5, R8 | L |
| R21 | Wykonanie czasowników po stronie hosta | Rdzeń ładuje demon; CLI i MCP wołają czasowniki przez tę samą powierzchnię co lease'y (D19). **Zero adb w procesie klienta** — sprawdzalne testem. Ten wiersz stoi przed rodzinami czasowników celowo: zmiana modelu wykonania po ich napisaniu to przepisanie sześciu plików zamiast jednego | R11 | L |
| R22 | Nasłuch sieciowy hosta i uwierzytelnienie | TCP z TLS obok gniazda lokalnego, **ta sama powierzchnia, drugi transport** (D17). Token hosta uwierzytelnia, string właściciela atrybuuje — **dwa osobne pola, test dowodzi, że token nigdy nie trafia do właściciela ani do logu** (D20). Odmowa nie zdradza, co host ma podłączone | R21 | L |
| R23 | Adresowanie wielu hostów i rejestr po stronie klienta | Uchwyt to host + serial, nigdy sam serial (D18). Klient czyta listę hostów z konfiguracji; `list` scala je w jedno zestawienie i **mówi wprost, który host nie odpowiedział**, zamiast pokazywać krótszą listę. Brak katalogu i brak rejestracji hostów u siebie (§7) | R22, R10 | M |
| R12 | Czasowniki wejścia | `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key`. `long_press` przez przeciągnięcie w miejscu — **nie** `keyevent --longpress` (§6). `type_text` ukrywa escapowanie spacji | R21 | M |
| R13 | Czasowniki odczytu | `screenshot`, `read_screen`, `device_info`. `read_screen` działa przy zablokowanym przechwytywaniu ekranu i **jest zadeklarowaną zdolnością, nie metodą obowiązkową** (§5) | R21 | M |
| R14 | `record_video` + cięcie na klatki | Nagranie musi dobiec do końca przed pobraniem — plik pobrany wcześniej nie ma atomu `moov` i jest nie do odczytania | R13 | S |
| R15 | Czasowniki aplikacji | `install_app`, `launch_app`, `stop_app`, `clear_app_data`, `read_logs`, `pull_file`, `push_file`. `read_logs` ma wykryć awarię, której zrzut ekranu nie pokaże | R21 | M |
| R16 | Czasowniki środowiska | `set_airplane_mode`, `set_wifi` przez `cmd connectivity` i `cmd wifi` — **nie** przez `svc`, którego już nie ma (§6). Obie ścieżki bez roota | R21 | S |
| R24 | Przenoszenie artefaktów przez granicę maszyn | Zrzuty, nagrania i pobrane pliki wracają jako bajty; **ścieżka zwrócona agentowi istnieje na jego maszynie** (D19). W drugą stronę: `install_app` i `push_file` wysyłają plik na hosta. Nagranie z R14 kończy się na hoście przed transferem, nie w jego trakcie. Limit rozmiaru jest jawny i nazwany, nie ujawnia się urwanym plikiem | R23, R13, R14, R15 | M |
| R17 | Hooki projektowe (D13) | Schemat Zod: komenda instalacji, usługi pomocnicze, teardown. **Rdzeń nie zna nazwy żadnej aplikacji**, a domyślna wartość, która ją wymienia, jest błędem | R9 | M |
| R18 | Alokacja portów usług pomocniczych per slot | Bez wyścigu, z odzyskiwaniem po osieroconym slocie. Warunek pracy równoległej przy więcej niż dwóch urządzeniach | R17 | S |
| R19 | Serwer MCP | Czasowniki jako narzędzia, schematy Zod jako ich deklaracje. **Brak zdolności to głośny, czytelny dla agenta błąd** nazywający zdolność i urządzenie (D11) — nigdy cicha degradacja. Zero logiki czasowników w tej warstwie. Wskazanie hosta zdalnego jest konfiguracją serwera, nie parametrem narzędzia — agent nie wie, gdzie stoi sprzęt | R12, R13, R15, R16, R23 | L |
| R20 | `README.md` — szybki start | Plik istnieje od założenia repo i opisuje kształt projektu; brakuje w nim tego, czego nie dało się napisać przed kodem: jak uruchomić demona, wziąć urządzenie i podpiąć serwer MCP, z działającymi komendami. Osobno: jak wystawić hosta na sieć i jak się do cudzego podłączyć | R10, R19, R24 | S |

### 9.4 Poza backlogiem — świadomie

- **Backend iOS.** Zbudowany jest tylko szew (§5). Zanim powstanie issue, trzeba rozstrzygnąć
  zależność od `idb` albo WebDriverAgent i pogodzić się z tym, że `read_screen` może nie mieć tam
  odpowiednika w ogóle.
- **Integracja ze Swarmem (D16).** Nic do zbudowania teraz; R6 i R8 mają tylko nie zamknąć drogi —
  stan demona odpytywalny spoza MCP i lease z jawnym właścicielem.
- **Kolumna `Planning` na boardzie.** Swarm mapuje taki status w konfiguracji projektu, a nasz
  board go nie ma (`ai/RULES.md` §5). Do rozstrzygnięcia przy onboardingu rovera do Swarma: dodać
  kolumnę albo wyłączyć tę fazę. Nie dodawać kolumny, której nikt na razie nie używa.
