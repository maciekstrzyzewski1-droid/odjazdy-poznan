#!/usr/bin/env node
// Lokalny serwer: pliki z app/ + pośrednik GTFS-RT pod /api/rt/<plik> (ZTM nie wysyła nagłówków CORS).
//   node server/dev-server.mjs            -> http://localhost:8787
//   PORT=9000 HOST=0.0.0.0 node server/dev-server.mjs   (dostęp z sieci lokalnej; GPS wymaga HTTPS poza localhost)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const RT_FILES = {
  trip_updates: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGtfsRtFile?file=trip_updates.pb',
  vehicle_positions: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGtfsRtFile?file=vehicle_positions.pb',
};
const RT_TTL = 10_000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const rtCache = new Map(); // name -> {at, body, promise}

async function getRt(name) {
  const c = rtCache.get(name);
  if (c && Date.now() - c.at < RT_TTL) return c.body;
  if (c?.promise) return c.promise;
  const promise = (async () => {
    const res = await fetch(RT_FILES[name], { headers: { 'User-Agent': 'odjazdy-poznan-dev/1.0' } });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    rtCache.set(name, { at: Date.now(), body });
    return body;
  })();
  rtCache.set(name, { ...(c || { at: 0 }), promise });
  try { return await promise; } catch (e) { rtCache.delete(name); throw e; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const m = /^\/api\/rt\/(trip_updates|vehicle_positions)$/.exec(url.pathname);
    if (m) {
      const body = await getRt(m[1]);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nie znaleziono'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': /\/data\/(tt|tripids)-/.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Błąd: ${e.message}`);
  }
});
server.listen(PORT, HOST, () => console.log(`Odjazdy Poznań: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`));
