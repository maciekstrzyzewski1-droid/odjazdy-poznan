// Cloudflare Worker: pośrednik GTFS-RT ZTM Poznań z nagłówkami CORS i krótkim buforem (10 s).
// Obsługuje wyłącznie trzy stałe pliki – nie jest otwartym proxy.
//   GET /rt/feeds             -> feeds.pb (opóźnienia + pozycje pojazdów w jednym – używa tego aplikacja)
//   GET /rt/trip_updates      -> trip_updates.pb
//   GET /rt/vehicle_positions -> vehicle_positions.pb
// Zmienna ALLOWED_ORIGINS: lista originów rozdzielona przecinkami (np. https://ktos.github.io) albo "*".
//
// Bufor trzymamy w pamięci izolatu: Cache API (caches.default) nie działa na domenach *.workers.dev,
// a pamięć izolatu – tak (best effort: izolat żyje zwykle wiele minut i obsługuje kolejne zapytania).
const UPSTREAM = {
  trip_updates: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGtfsRtFile?file=trip_updates.pb',
  vehicle_positions: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGtfsRtFile?file=vehicle_positions.pb',
  feeds: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGtfsRtFile?file=feeds.pb',
};
const TTL_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const memo = new Map(); // name -> { at, body: ArrayBuffer, pending?: Promise }

function corsHeaders(origin) {
  const h = { Vary: 'Origin' };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const UPSTREAM_TIMEOUT_MS = 8000;
const STALE_MAX_MS = 5 * 60_000; // starsze dane i tak odrzuci aplikacja (sprawdza znacznik czasu feedu)

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Upstream timeout')), ms))]);

async function getFeed(name) {
  const c = memo.get(name) || {};
  if (c.body && Date.now() - c.at < TTL_MS) return c.body;
  if (!c.pending) {
    c.pending = (async () => {
      const up = await fetch(UPSTREAM[name], {
        headers: { 'User-Agent': 'odjazdy-poznan-rt/1.0' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!up.ok) throw new Error(`Upstream HTTP ${up.status}`);
      const body = await up.arrayBuffer();
      if (body.byteLength > MAX_BYTES) throw new Error('Upstream too large');
      return body;
    })().then(
      (body) => { memo.set(name, { at: Date.now(), body, pending: null }); return body; },
      (e) => { const cur = memo.get(name); if (cur) cur.pending = null; throw e; },
    );
    memo.set(name, c);
  }
  try {
    // czekamy na wspólne pobranie, ale nigdy dłużej niż limit – zawieszony ZTM nie blokuje wszystkich
    return await withTimeout(c.pending, UPSTREAM_TIMEOUT_MS + 500);
  } catch (e) {
    const cur = memo.get(name);
    if (cur && cur.body && Date.now() - cur.at < STALE_MAX_MS) return cur.body; // ostatnie dobre dane
    throw e;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin');
    const allowOrigin = allowed.includes('*') ? '*' : (origin && allowed.includes(origin) ? origin : null);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    const m = /^\/rt\/(trip_updates|vehicle_positions|feeds)$/.exec(url.pathname);
    if (!m) return new Response('Not Found', { status: 404 });
    if (!allowed.includes('*') && origin && !allowOrigin) return new Response('Forbidden', { status: 403 });

    let body;
    try {
      body = await getFeed(m[1]);
    } catch (e) {
      return new Response(String(e.message || 'Upstream error'), { status: 502, headers: corsHeaders(allowOrigin) });
    }
    const headers = new Headers(corsHeaders(allowOrigin));
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(body.slice(0), { status: 200, headers });
  },
};
