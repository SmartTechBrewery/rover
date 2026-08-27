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

### Trzy strony

| Kto | Ile sztuk | Czas życia | Rola |
|---|---|---|---|
| **Agent** | wielu naraz | sesja | Pracuje nad aplikacją. Nie wie nic o adb |
| **Serwer MCP** | jeden na agenta | sesja agenta | Wystawia czasowniki. Uruchamia go klient agenta |
| **Demon** | jeden na maszynę | długo | Trzyma urządzenia, rozdaje lease'y, sprząta |

Dlaczego demon musi istnieć osobno: dwóch agentów pracujących równolegle ma **dwa osobne serwery
MCP**, które nie mają jak się ze sobą dogadać. Demon jest tym jednym miejscem, które widzi obu
i pilnuje, żeby nie weszli na to samo urządzenie. Bez niego nieprzypięta instalacja jednego agenta
trafia na urządzenie drugiego — a zrzut ekranu z cudzego builda to zielona weryfikacja kodu,
którego się nie napisało. To najgorszy tryb porażki, jaki ta klasa narzędzi ma.

### Przebieg

1. Agent prosi o urządzenie o określonych cechach (platforma, ewentualnie konkretny model).
2. Demon sprawdza w adb, co jest wolne, przyznaje **lease** i zwraca uchwyt urządzenia razem
   z listą tego, co na nim wolno zrobić.
3. Agent woła czasowniki, podając ten uchwyt. Każde wywołanie odsuwa wygaśnięcie lease'u.
4. Agent zwalnia urządzenie. Demon przywraca stan wyjściowy.
5. Jeśli agent umrze i nie zwolni — lease wygasa po 20 minutach bezczynności i demon sprząta
   tak samo.

---

## 3. Decyzje (zapadłe)

| # | Decyzja | Dlaczego | Data |
|---|---|---|---|
| D1 | **Osobne repozytorium, zero związku z projektem źródłowym** | Narzędzie ma obsłużyć dowolną aplikację mobilną. Wszystko, co wie o konkretnym produkcie, jest długiem od pierwszego dnia | 2026-08-27 |
| D2 | **Node.js** | Warstwa jest cienka: procesy, gniazda, parsowanie XML-a i JSON-a, trochę obróbki obrazu. Ekosystem MCP jest tu u siebie | 2026-08-27 |
| D3 | **Dwa procesy: demon per maszyna, serwer MCP per agent** | Urządzenia są zasobem współdzielonym, a sesja agenta nie jest. Jedno bez drugiego albo nie skaluje się na dwóch agentów, albo wymaga ręcznego startu | 2026-08-27 |
| D4 | **Rdzeń + CLI, MCP jako cienka nakładka na ten sam rdzeń** | CLI debuguje człowiek, CLI działa bez agenta, CLI nie wymaga konfiguracji MCP w każdym projekcie. MCP dochodzi potem i nic nie duplikuje. Odwrotna kolejność zamyka narzędzie w agencie | 2026-08-27 |
| D5 | **Demon startuje sam przy pierwszym wywołaniu** | Precedens `adb`, który forkuje własny serwer na 5037 i nikt tego nie zauważa. Ręczny start to krok, o którym ktoś zapomni w najgorszym momencie | 2026-08-27 |
| D6 | **Demon jest cache'em, adb jest prawdą** | Demon wprowadza tryb porażki, którego plikowy lease nie miał: własny nieświeży stan. Więc nie trzyma niczego, czego nie umie odtworzyć z `adb devices`, i weryfikuje urządzenie przy każdym przyznaniu lease'u | 2026-08-27 |
| D7 | **Lease per urządzenie, nie muteks na całą maszynę** | Poprzednik brał cały sprzęt na wyłączność, bo był plikiem. Przy dwóch i więcej urządzeniach to marnuje wszystkie poza jednym | 2026-08-27 |
| D8 | **TTL 20 minut, odnawiany przy każdym wywołaniu** | Agent bywa bezczynny przez długie minuty myślenia, więc stały budżet czasu jest zły w obie strony. Agent martwy nie wywoła już nic i wygaśnie sam, bez heartbeatu po stronie klienta | 2026-08-27 |
| D9 | **Przywracanie stanu wymuszone, nie proszone** | Poprzednik *prosił* w komentarzu o przywrócenie stanu przed zwolnieniem i nikt tego nie sprawdzał. Demon robi to sam przy zwolnieniu **i** przy wygaśnięciu: zatrzymanie aplikacji, tryb samolotowy wyłączony, wifi z powrotem, hooki projektu | 2026-08-27 |
| D10 | **Jeden zestaw czasowników. Platforma jest cechą urządzenia, nie nazwą narzędzia** | Rozważone i odrzucone: `tap_android` / `tap_ios`. Sufiksy podwajają listę narzędzi (agenci wybierają tym gorzej, im dłuższa lista), zmuszają do pisania każdego scenariusza dwa razy i każą agentowi pamiętać, na czym stoi. Urządzenie i tak wie, czym jest | 2026-08-27 |
| D11 | **Negocjacja zdolności zamiast najmniejszego wspólnego mianownika** | Backendy nie są symetryczne i nie da się tego ukryć. Każdy deklaruje, co potrafi; czasownik bez pokrycia kończy się **głośnym błędem**, nie cichą degradacją. Sufiks mówi „nie ma takiego narzędzia" i każe się domyślać; odmowa mówi wprost, czego brakuje | 2026-08-27 |
| D12 | **Determinizm to trzy reguły w warstwie czasowników, nie własność demona** | (a) żadnych współrzędnych z pamięci — cel rozwiązywany ze świeżego zrzutu hierarchii **wewnątrz** czasownika; (b) żadnych `sleep` — wyłącznie czekanie na warunek z limitem czasu; (c) każda akcja zwraca stan po sobie, żeby agent nigdy nie zgadywał, czy trafił | 2026-08-27 |
| D13 | **Wszystko specyficzne dla projektu to hooki w konfiguracji** | Komenda instalacji, start usług pomocniczych, sprzątanie, ścieżki do renderów. Rdzeń nie zna nazwy żadnej aplikacji | 2026-08-27 |
| D14 | **Każdy wynik nazywa urządzenie i jego gęstość** | Dwa emulatory o różnej gęstości dają różne — i oba poprawne — pomiary tego samego elementu. Bez nazwania urządzenia dwa raporty są sprzeczne i nie wiadomo, który kłamie | 2026-08-27 |

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

**Poza zakresem na teraz:** iOS (tylko szew, patrz §5). Testy automatyczne z asercjami. CI.
Farmy urządzeń w chmurze. Porównywanie do renderów — rover dostarcza zrzuty i pomiary, ocena
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

## 9. Stan prac

- [x] Ustalenie zakresu czasowników i modelu działania
- [x] Weryfikacja receptur adb na API 37
- [x] `PROJECT.md`, `.gitignore`
- [ ] Szkielet projektu Node.js
- [ ] Demon: śledzenie urządzeń przez adb, lease'y, wygasanie
- [ ] Rdzeń: interfejs urządzenia + backend Android
- [ ] CLI
- [ ] Serwer MCP
- [ ] Hooki projektowe (D13)
