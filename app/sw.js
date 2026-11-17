// Service worker: aplikacja działa bez internetu (sam rozkład), dane na żywo zawsze z sieci.
const SHELL = 'odjazdy-shell-v2';
const DATA = 'odjazdy-data-v1';
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'engine.js', 'config.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, DATA].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // mapy OSM, pośrednik RT – bez cache
  const path = url.pathname;
  if (/\/api\//.test(path)) return;                            // dane na żywo – tylko sieć
  if (/\/data\/meta\.json$/.test(path)) { e.respondWith(metaFirst(req)); return; }
  if (/\/data\/(tt|tripids)-[0-9a-f]+\.json$/.test(path)) { e.respondWith(immutable(req, path)); return; }
  e.respondWith(staleWhileRevalidate(req));
});

// Odpowiedź z pamięci oznaczamy nagłówkiem, żeby aplikacja nie twierdziła „masz najnowszy rozkład”.
async function fromCache(hit) {
  const h = new Headers(hit.headers);
  h.set('X-SW-Fallback', '1');
  return new Response(await hit.blob(), { status: 200, headers: h });
}

// meta.json zapisujemy w pamięci dopiero, gdy wskazany w nim plik rozkładu też tam jest –
// inaczej przerwane pobieranie (słaby zasięg) zostawiłoby telefon bez rozkładu offline.
async function metaFirst(req) {
  const cache = await caches.open(DATA);
  const cached = await cache.match(req, { ignoreSearch: true });
  let res;
  try {
    res = await fetch(req, { cache: 'no-cache' });
  } catch (err) {
    if (cached) return fromCache(cached);
    throw err;
  }
  if (!res.ok) return cached ? fromCache(cached) : res;
  try {
    const meta = await res.clone().json();
    const ttUrl = new URL(meta.files.timetable, new URL('./', req.url)).href;
    if (!(await cache.match(ttUrl))) {
      const tt = await fetch(ttUrl);
      if (!tt.ok) throw new Error('tt ' + tt.status);
      await cache.put(ttUrl, tt.clone());
      await prune(cache, new URL(ttUrl).pathname);
    }
    await cache.put(req, res.clone());
    return res;
  } catch {
    return cached ? fromCache(cached) : res;
  }
}

async function prune(cache, keepPath) {
  const kind = /\/(tt|tripids)-/.exec(keepPath)[1];
  const re = new RegExp(`/data/${kind}-[0-9a-f]+\\.json$`);
  for (const k of await cache.keys()) {
    const p = new URL(k.url).pathname;
    if (p !== keepPath && re.test(p)) await cache.delete(k);
  }
}

async function immutable(req, path) {
  const cache = await caches.open(DATA);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    await prune(cache, path); // usuń starsze wersje tego samego rodzaju pliku
  }
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(async (res) => {
    if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) { net.catch(() => {}); return hit; }
  const res = await net;
  if (res) return res;
  if (req.mode === 'navigate') {
    const shell = await cache.match('index.html');
    if (shell) return shell;
  }
  return new Response('Brak połączenia', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
