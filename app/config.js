// Konfiguracja wdrożenia. Plik podmieniany przy publikacji (np. w GitHub Actions).
// rtUrl – adres pośrednika GTFS-RT (trip_updates.pb z nagłówkiem CORS).
//   Lokalnie (npm run dev) działa „api/rt/trip_updates”. Na GitHub Pages wpisz adres Cloudflare Workera.
//   Pusty = bez danych na żywo (sam rozkład). Użytkownik może to nadpisać w Ustawieniach.
window.ODJAZDY_CONFIG = {
  rtUrl: 'api/rt/trip_updates',
};
