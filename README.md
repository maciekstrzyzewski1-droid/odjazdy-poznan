# Odjazdy Poznań

**Aplikacja:** https://maciekstrzyzewski1-droid.github.io/odjazdy-poznan/ (na telefonie: „Dodaj do ekranu głównego”)

Osobista tablica odjazdów ZTM Poznań. Pokazuje **wszystkie** bezpośrednie tramwaje i autobusy z przystanków
w wybranym promieniu (np. 400 m) do celu (np. „Praca”) – także te, które planery tras pomijają.

- **Sekcje** na stronie głównej, np. „Do pracy”: z mojej lokalizacji albo zapisanego miejsca → do miejsca/przystanku.
  Każda opcja ma linię, przystanek i dojście pieszo, godzinę odjazdu, minuty do odjazdu, „wyjdź za X min”,
  przystanek docelowy, czas jazdy i godzinę dotarcia na miejsce.
- **Najszybciej / wolniej**: oznacza kurs, który najwcześniej dowiezie na miejsce, i przygasza te, przy których
  późniejszy kurs dowiezie szybciej (np. linia jadąca okrężnie). Nic nie jest ukrywane, chyba że to włączysz.
- **W pobliżu**: wszystkie odjazdy z przystanków wokół Ciebie (promień 100–1000 m).
- **Przystanki**: wyszukiwarka (bez polskich znaków też działa), tablica słupków, filtr „Dokąd?”.
- **Na żywo**: opóźnienia z GTFS-RT ZTM (co 20 s), „zbliża się do: …”, numer pojazdu; kurs, który już minął przystanek, znika.
- **Offline**: cały rozkład miasta (~0,2 MB po kompresji) jest zapisywany w telefonie.

## Skąd dane

Otwarte dane ZTM Poznań: rozkład GTFS (`https://www.ztm.poznan.pl/otwarte-dane/gtfsfiles/`) i GTFS-RT
(`https://www.ztm.poznan.pl/otwarte-dane/gtfs-rt/`). ZTM publikuje nowy plik co 2–4 dni, każdy na ok. 2 tygodnie,
a najnowszy często obowiązuje dopiero od jutra – skrypt `scripts/build-data.mjs` dla każdego dnia wybiera
najnowszy plik obejmujący ten dzień i łączy je.

Serwery ZTM nie wysyłają nagłówków CORS, dlatego przeglądarka nie może pobierać danych bezpośrednio:
rozkład jest przetwarzany wcześniej (GitHub Actions), a dane na żywo idą przez mały pośrednik.

## Uruchomienie lokalne

```bash
node scripts/build-data.mjs
```

```bash
node server/dev-server.mjs
```

Otwórz http://localhost:8787. Serwer lokalny ma wbudowany pośrednik danych na żywo (`/api/rt/trip_updates`).
Testy: `node --test "tests/*.test.mjs"`.

## Publikacja na telefon (darmowo)

1. **Repozytorium na GitHubie** (publiczne – GitHub Pages w darmowym planie wymaga publicznego repo;
   w kodzie nie ma żadnych Twoich danych, miejsca i sekcje są tylko w telefonie).
2. **Settings → Pages → Source: GitHub Actions.** Workflow `.github/workflows/deploy.yml` kilka razy dziennie
   pobiera rozkład, uruchamia testy i publikuje `app/` pod `https://<login>.github.io/<repo>/`.
3. **Dane na żywo (opcjonalnie)**: wdroż `worker/` na Cloudflare Workers (darmowy plan wystarczy z ogromnym zapasem):
   `npx wrangler deploy` w katalogu `worker/` (w `wrangler.toml` ustaw `ALLOWED_ORIGINS` na adres strony).
   Worker przekazuje tylko dwa stałe pliki ZTM i trzyma je w pamięci przez 10 s (Cache API nie działa na `*.workers.dev`).
   Adres workera + `/rt/trip_updates` wpisz w GitHubie jako zmienną repozytorium `RT_URL`
   (Settings → Secrets and variables → Actions → Variables) albo w aplikacji: Ustawienia → Dane na żywo.
4. Na telefonie otwórz stronę i wybierz „Dodaj do ekranu głównego”.

Uwaga: GitHub wyłącza zaplanowane workflow w publicznym repo po 60 dniach bez żadnej aktywności w repozytorium.
Aplikacja pokaże wtedy baner „rozkład nieaktualny” – wystarczy uruchomić workflow ręcznie (Actions → Run workflow).

## Jak to liczy

- Dojście: odległość w linii prostej × 1,3 (kręte ulice) ÷ tempo (domyślnie 80 m/min). Oba parametry w Ustawieniach.
- Połączenie bezpośrednie = kurs, który zatrzymuje się na przystanku w promieniu startu (z możliwością wsiadania)
  i później na przystanku w promieniu celu (z możliwością wysiadania). Dla każdego kursu wybierany jest przystanek,
  z którego można wyjść najpóźniej, i przystanek docelowy, z którego najszybciej dojdziesz do celu.
- Czasy GTFS liczone są od „południa minus 12 h” dnia kursowania (zgodnie ze specyfikacją; kursy nocne ≥ 24:00).
- Opóźnienie z GTFS-RT dotyczy przystanku, do którego jedzie pojazd, i jest przenoszone na dalsze przystanki.
  Wartości > 2 h są ignorowane (błędy źródła), przyspieszenie liczone maks. 3 min, na pętli początkowej 0.

## Struktura

| Ścieżka | Co robi |
|---|---|
| `scripts/build-data.mjs` | pobiera GTFS, wybiera pliki na dni, kompresuje do `app/data/` |
| `app/engine.js` | silnik: odjazdy, połączenia, czas Europe/Warsaw, dekoder GTFS-RT |
| `app/app.js`, `style.css`, `index.html` | interfejs (PWA, bez frameworków) |
| `app/sw.js` | tryb offline |
| `server/dev-server.mjs` | serwer lokalny + pośrednik GTFS-RT |
| `worker/rt-proxy.js` | pośrednik GTFS-RT na Cloudflare Workers |
| `tests/` | testy jednostkowe i na prawdziwych danych |

Aplikacja nieoficjalna, niezwiązana z ZTM Poznań. W razie wątpliwości obowiązuje rozkład na przystanku.
