#!/usr/bin/env node
// Buduje kompaktowe dane rozkładu ZTM Poznań (GTFS) dla aplikacji w app/.
//
// Użycie:
//   node scripts/build-data.mjs                 # pobiera aktualne pliki z ZTM
//   node scripts/build-data.mjs --zip a.zip     # z lokalnego pliku (można podać kilka, nowszy później)
//   node scripts/build-data.mjs --today 20261117 --days 14 --out app/data
//
// Dlaczego łączymy kilka plików: ZTM publikuje nowy plik co 2–4 dni, a najnowszy często
// zaczyna obowiązywać dopiero jutro lub pojutrze. Dla każdego dnia bierzemy najnowszy plik,
// który ten dzień obejmuje.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readZip } from './lib/zip.mjs';
import { parseCsv, indexer, timeToSecs } from './lib/csv.mjs';

const LIST_URL = 'https://www.ztm.poznan.pl/otwarte-dane/gtfsfiles/';
const FILE_URL = 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGTFSFile/';
const UA = 'odjazdy-poznan-builder/1.0 (+open data client)';

// ---------- argumenty ----------
const args = process.argv.slice(2);
const opt = { zips: [], out: 'app/data', days: 14, today: null, cache: '.cache' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--zip') opt.zips.push(args[++i]);
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--days') opt.days = +args[++i];
  else if (a === '--today') opt.today = args[++i];
  else if (a === '--cache') opt.cache = args[++i];
  else { console.error(`Nieznany argument: ${a}`); process.exit(2); }
}

// ---------- daty (strefa Europe/Warsaw) ----------
const warsawToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' })
  .format(new Date()).replaceAll('-', '');
const ymdToUTC = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const utcToYmd = (t) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
const addDays = (s, n) => utcToYmd(ymdToUTC(s) + n * 86400000);
const weekday = (s) => (new Date(ymdToUTC(s)).getUTCDay() + 6) % 7; // 0 = poniedziałek

// ---------- pobieranie ----------
async function fetchBuf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/octet-stream,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return { buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

async function listRemoteFeeds() {
  const { buf } = await fetchBuf(LIST_URL);
  const html = buf.toString('utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const re = /(\d{8})_(\d{8})\.zip\s+[\d.,]+\s*[KMG]?B\s+(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}):(\d{2}):(\d{2})/g;
  const seen = new Set();
  const feeds = [];
  let m;
  while ((m = re.exec(text))) {
    const name = `${m[1]}_${m[2]}.zip`;
    if (seen.has(name)) continue;
    seen.add(name);
    feeds.push({ name, start: m[1], end: m[2], published: `${m[5]}${m[4]}${m[3]}${m[6]}${m[7]}${m[8]}` });
  }
  if (!feeds.length) {
    // Układ strony się zmienił? Bierzemy same nazwy plików; jako „datę publikacji” przyjmujemy początek ważności.
    for (const x of html.matchAll(/(\d{8})_(\d{8})\.zip/g)) {
      const name = x[0];
      if (seen.has(name)) continue;
      seen.add(name);
      feeds.push({ name, start: x[1], end: x[2], published: `${x[1]}000000` });
    }
    console.warn(`UWAGA: nie rozpoznano tabeli plików na ${LIST_URL} – użyto ${feeds.length} nazw z linków.`);
  }
  return feeds;
}

async function getFeedBuffer(name) {
  fs.mkdirSync(opt.cache, { recursive: true });
  const p = path.join(opt.cache, name);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p);
  console.log(`  pobieram ${name}…`);
  const { buf } = await fetchBuf(`${FILE_URL}?file=${encodeURIComponent(name)}`);
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name}: odpowiedź nie jest plikiem ZIP`);
  fs.writeFileSync(p, buf);
  return buf;
}

// ---------- wybór plików na każdy dzień ----------
function assignDates(feeds, today, days) {
  const window = [];
  for (let d = -1; d <= days; d++) window.push(addDays(today, d)); // wczoraj: kursy po północy
  const byDate = new Map();
  for (const date of window) {
    const cands = feeds.filter((f) => f.start <= date && date <= f.end);
    if (!cands.length) continue;
    cands.sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));
    byDate.set(date, cands[0].name);
  }
  return byDate;
}

// ---------- parsowanie jednego pliku GTFS ----------
function parseRouteNotes(desc) {
  const notes = {};
  if (!desc) return notes;
  const re = /\^([^\s^|])\s*-\s*([^^|]*)/g;
  let m;
  while ((m = re.exec(desc))) {
    const code = m[1];
    const txt = m[2].trim().replace(/"+$/, '').trim();
    if (!txt) continue;
    if (notes[code] && notes[code] !== txt) {
      if (!notes[code].includes(txt)) notes[code] += ' / ' + txt;
    } else notes[code] = txt;
  }
  return notes;
}

function loadFeed(buf, feedName, datesForFeed) {
  const zip = readZip(buf);
  const txt = (n) => zip.read(n).toString('utf8');
  const out = { name: feedName, stops: new Map(), routes: new Map(), services: new Map(), trips: [] };

  // stops
  {
    const { header, rows } = parseCsv(txt('stops.txt'));
    const ix = indexer(header, ['stop_id', 'stop_name', 'stop_lat', 'stop_lon']);
    for (const r of rows) {
      out.stops.set(r[ix.stop_id], {
        id: r[ix.stop_id], name: (r[ix.stop_name] || '').trim(), code: (r[ix.stop_code] || '').trim(),
        lat: +r[ix.stop_lat], lon: +r[ix.stop_lon], zone: (r[ix.zone_id] || '').trim(),
      });
    }
  }
  // agencies
  const agencies = new Map();
  if (zip.has('agency.txt')) {
    const { header, rows } = parseCsv(txt('agency.txt'));
    const ix = indexer(header);
    for (const r of rows) agencies.set(r[ix.agency_id] ?? '', (r[ix.agency_name] || '').trim());
  }
  // routes
  {
    const { header, rows } = parseCsv(txt('routes.txt'));
    const ix = indexer(header, ['route_id', 'route_type']);
    for (const r of rows) {
      out.routes.set(r[ix.route_id], {
        id: r[ix.route_id], short: (r[ix.route_short_name] || r[ix.route_id]).trim(),
        type: +r[ix.route_type], color: (r[ix.route_color] || '').trim(), text: (r[ix.route_text_color] || '').trim(),
        agency: agencies.get(r[ix.agency_id]) || '', notes: parseRouteNotes(r[ix.route_desc]),
      });
    }
  }
  // kalendarz -> konkretne daty, ograniczone do dni przypisanych do tego pliku
  {
    const active = new Map();
    if (zip.has('calendar.txt')) {
      const { header, rows } = parseCsv(txt('calendar.txt'));
      const ix = indexer(header, ['service_id', 'start_date', 'end_date']);
      const wd = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      for (const r of rows) {
        const set = new Set();
        for (const date of datesForFeed) {
          if (date < r[ix.start_date] || date > r[ix.end_date]) continue;
          if (r[ix[wd[weekday(date)]]] === '1') set.add(date);
        }
        active.set(r[ix.service_id], set);
      }
    }
    if (zip.has('calendar_dates.txt')) {
      const { header, rows } = parseCsv(txt('calendar_dates.txt'));
      if (header) {
        const ix = indexer(header, ['service_id', 'date', 'exception_type']);
        for (const r of rows) {
          const sid = r[ix.service_id];
          if (!active.has(sid)) active.set(sid, new Set());
          if (!datesForFeed.has(r[ix.date])) continue;
          if (r[ix.exception_type] === '1') active.get(sid).add(r[ix.date]);
          else if (r[ix.exception_type] === '2') active.get(sid).delete(r[ix.date]);
        }
      }
    }
    for (const [sid, set] of active) if (set.size) out.services.set(sid, [...set].sort());
  }
  // trips
  const tripMeta = new Map();
  {
    const { header, rows } = parseCsv(txt('trips.txt'));
    const ix = indexer(header, ['route_id', 'service_id', 'trip_id']);
    for (const r of rows) {
      const sid = r[ix.service_id];
      if (!out.services.has(sid)) continue; // kurs nie jeździ w naszym oknie dat
      const tid = r[ix.trip_id];
      const suffix = tid.includes('^') ? tid.slice(tid.indexOf('^') + 1) : '';
      tripMeta.set(tid, {
        id: tid, route: r[ix.route_id], service: sid, headsign: (r[ix.trip_headsign] || '').trim(),
        dir: r[ix.direction_id] || '', wheelchair: r[ix.wheelchair_accessible] === '1' ? 1 : 0,
        noteCodes: suffix.replace(/[^A-Za-z0-9#]/g, ''), st: [],
      });
    }
  }
  // stop_times (największy plik ~70 MB) – strumieniowo przez onRow
  {
    const text = txt('stop_times.txt');
    let ix = null;
    const { header } = parseCsv(text.slice(0, text.indexOf('\n') + 1));
    ix = indexer(header, ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence']);
    parseCsv(text, (r) => {
      const t = tripMeta.get(r[ix.trip_id]);
      if (!t) return;
      const dep = timeToSecs(r[ix.departure_time]);
      const arr = timeToSecs(r[ix.arrival_time]);
      t.st.push({
        seq: +r[ix.stop_sequence], stop: r[ix.stop_id], arr: arr ?? dep, dep: dep ?? arr,
        pu: +(r[ix.pickup_type] || 0) || 0, dr: +(r[ix.drop_off_type] || 0) || 0,
        hs: ix.stop_headsign != null ? (r[ix.stop_headsign] || '').trim() : '',
      });
    });
  }
  for (const t of tripMeta.values()) {
    if (t.st.length < 2) continue;
    t.st.sort((a, b) => a.seq - b.seq);
    if (t.st.some((s) => s.dep == null)) continue; // brak godzin (interpolacja nieobsługiwana)
    out.trips.push(t);
  }
  return out;
}

// ---------- główny przebieg ----------
async function main() {
  const today = opt.today || warsawToday();
  console.log(`Dzisiaj (Warszawa): ${today}`);

  let feeds; // {name, start, end, published, buf?}
  if (opt.zips.length) {
    feeds = opt.zips.map((p, i) => {
      const buf = fs.readFileSync(p);
      const zip = readZip(buf);
      let start = '00000000', end = '99999999';
      const m = /(\d{8})_(\d{8})/.exec(path.basename(p));
      if (m) { start = m[1]; end = m[2]; }
      else if (zip.has('feed_info.txt')) {
        const { header, rows } = parseCsv(zip.read('feed_info.txt').toString('utf8'));
        const ix = indexer(header);
        start = rows[0]?.[ix.feed_start_date] || start; end = rows[0]?.[ix.feed_end_date] || end;
      }
      return { name: path.basename(p), start, end, published: String(i).padStart(14, '0'), buf };
    });
  } else {
    try {
      feeds = await listRemoteFeeds();
      console.log(`Lista plików ZTM: ${feeds.length} pozycji, najnowszy ${feeds[0]?.name}`);
    } catch (e) {
      console.warn(`UWAGA: nie udało się pobrać listy plików (${e.message}) – biorę najnowszy plik.`);
      feeds = [];
    }
    if (!feeds.length) {
      const { buf, headers } = await fetchBuf(FILE_URL);
      const cd = headers.get('content-disposition') || '';
      const m = /(\d{8})_(\d{8})\.zip/.exec(cd);
      feeds = [{ name: m ? m[0] : 'latest.zip', start: m ? m[1] : '00000000', end: m ? m[2] : '99999999', published: '99999999999999', buf }];
    }
  }

  const byDate = assignDates(feeds, today, opt.days);
  if (!byDate.size) throw new Error('Żaden plik GTFS nie obejmuje bieżących dat');
  // Bez dzisiejszego dnia nie publikujemy (CI zostawi poprzednią, dobrą wersję).
  if (!byDate.has(today)) throw new Error(`Dostępne pliki nie obejmują dzisiejszego dnia (${today})`);
  if (!byDate.has(addDays(today, -1))) console.warn('Uwaga: brak danych na wczoraj – kursy nocne po północy mogą być niepełne.');
  const chosen = [...new Set(byDate.values())];
  console.log('Przydział dni do plików:');
  for (const name of chosen) {
    const ds = [...byDate].filter(([, n]) => n === name).map(([d]) => d);
    console.log(`  ${name}: ${ds[0]}–${ds.at(-1)} (${ds.length} dni)`);
  }

  // parsowanie (od najstarszego do najnowszego – nowsze definicje przystanków/linii nadpisują)
  const chosenFeeds = chosen.map((n) => feeds.find((f) => f.name === n))
    .sort((a, b) => (a.published < b.published ? -1 : 1));
  const parsed = [];
  for (const f of chosenFeeds) {
    const buf = f.buf || (await getFeedBuffer(f.name));
    const dates = new Set([...byDate].filter(([, n]) => n === f.name).map(([d]) => d));
    const t0 = Date.now();
    const p = loadFeed(buf, f.name, dates);
    console.log(`  ${f.name}: ${p.trips.length} kursów, ${p.services.size} kalendarzy (${Date.now() - t0} ms)`);
    parsed.push({ feed: f, data: p });
  }

  // ---------- scalanie i kompresja ----------
  const allDates = [...byDate.keys()].sort();
  const dateIx = new Map(allDates.map((d, i) => [d, i]));
  const stopDefs = new Map();
  const routeDefs = new Map();
  for (const { data } of parsed) {
    for (const [k, v] of data.stops) stopDefs.set(k, v);
    for (const [k, v] of data.routes) routeDefs.set(k, v);
  }

  const usedStops = new Map(); // stop_id -> index
  const usedRoutes = new Map();
  const headsigns = new Map();
  const services = new Map(); // klucz z datami -> index
  const patterns = new Map(); // klucz -> {index, s, d, a, f}
  const trips = [];
  const getIx = (map, key) => { if (!map.has(key)) map.set(key, map.size); return map.get(key); };
  let skipped = 0, nonMonotonic = 0;

  for (const { data } of parsed) {
    for (const t of data.trips) {
      const route = data.routes.get(t.route);
      if (!route) { skipped++; continue; }
      const dates = data.services.get(t.service);
      if (!dates || !dates.length) continue;
      if (t.st.some((s) => !stopDefs.has(s.stop))) { skipped++; continue; }
      const base = t.st[0].dep;
      const s = t.st.map((x) => getIx(usedStops, x.stop));
      const d = t.st.map((x) => x.dep - base);
      const a = t.st.map((x) => x.dep - x.arr); // postój; zwykle 0
      for (let i = 1; i < d.length; i++) if (d[i] < d[i - 1]) { nonMonotonic++; break; }
      const f = t.st.map((x) => ((x.pu & 3) * 4 + (x.dr & 3)).toString(16)).join('');
      // stop_sequence: zwykle kolejne liczby od q (q zapisujemy przy kursie); inaczej jawna lista we wzorcu
      const q = t.st[0].seq;
      const contiguous = t.st.every((x, i) => x.seq === q + i);
      const sq = contiguous ? null : t.st.map((x) => x.seq);
      const key = `${s.join(',')}|${d.join(',')}|${a.join(',')}|${f}|${sq ? sq.join(',') : ''}`;
      let pat = patterns.get(key);
      if (!pat) {
        pat = { index: patterns.size, s, d, a: a.some((x) => x) ? a : null, f: /^0+$/.test(f) ? null : f, sq };
        patterns.set(key, pat);
      }
      const svcKey = dates.map((x) => dateIx.get(x)).join(',');
      let headsign = t.headsign;
      if (!headsign) headsign = t.st.at(-1).hs || stopDefs.get(t.st.at(-1).stop).name;
      trips.push({
        p: pat.index, r: getIx(usedRoutes, t.route), h: getIx(headsigns, headsign),
        sv: getIx(services, svcKey), t0: base, n: t.noteCodes, w: t.wheelchair, id: t.id,
        q: sq ? 0 : q,
      });
    }
  }
  trips.sort((x, y) => x.p - y.p || x.t0 - y.t0 || (x.id < y.id ? -1 : 1));

  // kolumnowo + delta t0 w obrębie wzorca
  const patArr = [...patterns.values()].sort((x, y) => x.index - y.index);
  const patStart = new Array(patArr.length + 1).fill(0);
  for (const t of trips) patStart[t.p + 1]++;
  for (let i = 0; i < patArr.length; i++) patStart[i + 1] += patStart[i];

  const tr = [], th = [], ts = [], tt = [], tn = [], tw = [], tq = [], tid = [];
  let prevP = -1, prevT = 0;
  for (const t of trips) {
    if (t.p !== prevP) { prevP = t.p; prevT = 0; }
    tt.push(t.t0 - prevT); prevT = t.t0;
    tr.push(t.r); th.push(t.h); ts.push(t.sv); tn.push(t.n); tw.push(t.w); tq.push(t.q); tid.push(t.id);
  }

  const stopsOut = [...usedStops.keys()].map((id) => {
    const s = stopDefs.get(id);
    return [id, s.name, s.code, +s.lat.toFixed(6), +s.lon.toFixed(6), s.zone];
  });
  const routesOut = [...usedRoutes.keys()].map((id) => {
    const r = routeDefs.get(id);
    return [id, r.short, r.type, r.color, r.text, r.agency, r.notes];
  });

  const timetable = {
    v: 1,
    dates: allDates,
    stops: stopsOut,
    routes: routesOut,
    headsigns: [...headsigns.keys()],
    services: [...services.keys()].map((k) => k.split(',').map(Number)),
    patterns: {
      s: patArr.map((p) => p.s), d: patArr.map((p) => p.d),
      a: patArr.map((p) => p.a), f: patArr.map((p) => p.f), sq: patArr.map((p) => p.sq), start: patStart,
    },
    trips: { r: tr, h: th, s: ts, t: tt, n: tn, w: tw, q: tq },
  };
  const ttJson = JSON.stringify(timetable);
  const idJson = JSON.stringify(tid);
  const hash = crypto.createHash('sha256').update(ttJson).update(idJson).digest('hex').slice(0, 12);

  fs.mkdirSync(opt.out, { recursive: true });
  for (const f of fs.readdirSync(opt.out)) {
    if (/^(tt|tripids)-[0-9a-f]+\.json$/.test(f)) fs.unlinkSync(path.join(opt.out, f));
  }
  const ttName = `tt-${hash}.json`;
  const idName = `tripids-${hash}.json`;
  fs.writeFileSync(path.join(opt.out, ttName), ttJson);
  fs.writeFileSync(path.join(opt.out, idName), idJson);
  const meta = {
    version: hash,
    generated: new Date().toISOString(),
    today,
    validFrom: allDates[0],
    validTo: allDates.at(-1),
    feeds: chosenFeeds.map((f) => ({ name: f.name, start: f.start, end: f.end, published: f.published })),
    files: { timetable: ttName, tripIds: idName },
    counts: { stops: stopsOut.length, routes: routesOut.length, patterns: patArr.length, trips: trips.length },
    bytes: { timetable: Buffer.byteLength(ttJson), tripIds: Buffer.byteLength(idJson) },
  };
  fs.writeFileSync(path.join(opt.out, 'meta.json'), JSON.stringify(meta, null, 2));

  const { gzipSync } = await import('node:zlib');
  const gz = (s) => (gzipSync(s, { level: 9 }).length / 1024 / 1024).toFixed(2);
  console.log(`\nGotowe: ${meta.counts.stops} przystanków, ${meta.counts.routes} linii, ${meta.counts.patterns} wzorców, ${meta.counts.trips} kursów`);
  console.log(`  ${ttName}: ${(meta.bytes.timetable / 1048576).toFixed(2)} MB (gzip ${gz(ttJson)} MB)`);
  console.log(`  ${idName}: ${(meta.bytes.tripIds / 1048576).toFixed(2)} MB (gzip ${gz(idJson)} MB)`);
  if (skipped) console.warn(`  Pominięto ${skipped} kursów (brak linii/przystanku)`);
  if (nonMonotonic) console.warn(`  Uwaga: ${nonMonotonic} kursów z malejącymi godzinami`);
}

main().catch((e) => { console.error('BŁĄD:', e.message); process.exit(1); });
