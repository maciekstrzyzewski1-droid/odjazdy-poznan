// Konfiguracja wdrożenia. Plik podmieniany przy publikacji (np. w GitHub Actions).
// rtUrl – adres pośrednika GTFS-RT z nagłówkiem CORS: feeds.pb (opóźnienia + pozycje pojazdów w 1 pliku)
//   albo trip_updates.pb (wtedy pozycje pojazdów są pobierane osobno z vehicle_positions).
//   Lokalnie (npm run dev) działa „api/rt/feeds”. Na GitHub Pages wpisz adres Cloudflare Workera.
//   Pusty = bez danych na żywo (sam rozkład). Użytkownik może to nadpisać w Ustawieniach.
window.ODJAZDY_CONFIG = {
  rtUrl: 'api/rt/feeds',
};
