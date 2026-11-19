// Odjazdy Poznań – interfejs. Dane: ZTM Poznań (GTFS + GTFS-RT). Aplikacja nieoficjalna.
import {
  Timetable, warsawYmd, fmtHM, decodeTripUpdates, decodeVehiclePositions, applyRt, dedupeTrips, markWorse, boardKeys,
  pruneTransfers, routeCmp, RT_MAX_ABS_DELAY,
} from './engine.js';

const CFG = window.ODJAZDY_CONFIG || {};
const KEY = 'odjazdy.v1';
const POZNAN = [52.4064, 16.9252];
const DEFAULT_SETTINGS = {
  speed: 80,        // m/min (ok. 4,8 km/h)
  detour: 1.3,      // ile dłuższa od linii prostej jest realna droga piesza
  window: 90,       // ile minut naprzód
  radius: 400,      // domyślny promień
  rt: true,         // dane na żywo
  rtUrl: '',        // nadpisanie adresu pośrednika
  theme: 'auto',
  hideWorse: false,
  xfer: true,       // połączenia z jedną przesiadką (gdy wyraźnie szybsze)
  xferMin: 2,       // minimalny czas na przesiadkę (min)
};

// ======================================================================
// Stan użytkownika (localStorage – tylko na tym urządzeniu)
// ======================================================================
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isStr = (x) => typeof x === 'string' && x.length > 0 && x.length < 200;
function validEp(ep) {
  if (!ep || typeof ep !== 'object') return false;
  if (ep.type === 'gps') return true;
  if (ep.type === 'place') return isStr(ep.id);
  if (ep.type === 'stop') return isStr(ep.name);
  return false;
}
function normalizeState(s) {
  s = s && typeof s === 'object' ? s : {};
  const places = (Array.isArray(s.places) ? s.places : []).filter((p) => p && isStr(p.id) && isStr(p.name)
    && isNum(p.lat) && isNum(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)
    .map((p) => ({ id: p.id, name: p.name.slice(0, 60), lat: p.lat, lon: p.lon }));
  const sections = (Array.isArray(s.sections) ? s.sections : []).filter((x) => x && isStr(x.id) && isStr(x.name) && validEp(x.from)
    && (x.to == null || validEp(x.to)))
    .map((x) => ({
      id: x.id, name: x.name.slice(0, 60), from: x.from, to: x.to || null,
      rFrom: clamp(+x.rFrom || 400, 50, 2000), rTo: clamp(+x.rTo || 400, 50, 2000),
      tram: x.tram !== false, bus: x.bus !== false,
      hidden: Array.isArray(x.hidden) ? x.hidden.filter((h) => typeof h === 'string').slice(0, 100) : [],
      sort: x.sort === 'arr' ? 'arr' : 'dep',
    }));
  const settings = { ...DEFAULT_SETTINGS };
  const src = s.settings && typeof s.settings === 'object' ? s.settings : {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof src[k] === typeof DEFAULT_SETTINGS[k]) settings[k] = src[k];
  settings.speed = clamp(settings.speed, 40, 140);
  settings.detour = clamp(settings.detour, 1, 2);
  settings.window = clamp(settings.window, 30, 360);
  settings.radius = clamp(settings.radius, 100, 2000);
  settings.xferMin = clamp(settings.xferMin, 0, 10);
  if (!['auto', 'dark', 'light'].includes(settings.theme)) settings.theme = 'auto';
  return {
    places, sections, settings,
    recent: (Array.isArray(s.recent) ? s.recent : []).filter((x) => isStr(x)).slice(0, 8),
    nearby: s.nearby && typeof s.nearby === 'object' ? { src: isStr(s.nearby.src) ? s.nearby.src : 'gps', r: clamp(+s.nearby.r || 400, 100, 2000) } : { src: 'gps', r: 400 },
  };
}
function clamp(x, a, b) { x = +x; if (!Number.isFinite(x)) return a; return Math.min(b, Math.max(a, x)); }
function loadState() {
  try { return normalizeState(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return normalizeState(null); }
}
let S = loadState();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast('Nie udało się zapisać ustawień w pamięci przeglądarki'); }
}

// ======================================================================
// Narzędzia
// ======================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const walkSecFor = (dist) => Math.round((dist * S.settings.detour) / S.settings.speed * 60);
const fmtYmd = (y) => `${y.slice(6, 8)}.${y.slice(4, 6)}.${y.slice(0, 4)}`;
const postOf = (code) => { const m = /(\d{1,3})$/.exec(code || ''); return m ? m[1] : (code || ''); };
function kindOf(route) {
  if (route.type === 0 || (route.type >= 900 && route.type < 1000)) return 'tram';
  if (/^2\d\d$/.test(route.short)) return 'night';
  const n = parseInt(route.short, 10);
  if (!/^\d+$/.test(route.short) || n >= 300) return 'sub';
  return 'bus';
}
const isTram = (route) => kindOf(route) === 'tram';
const badge = (route, sm = false) => `<span class="badge ${kindOf(route)}${sm ? ' sm' : ''}" title="${esc(route.agency)}">${esc(route.short)}</span>`;

let toastTimer = null;
function toast(msg) {
  const root = $('#toast-root');
  root.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, 3200);
}

// ======================================================================
// Dane rozkładu
// ======================================================================
let TT = null, META = null, DATA_ERR = null, LOAD_ERR = null, TRIP_IDX = null, metaCheckedAt = 0;
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  if (res.headers.get('X-SW-Fallback')) res.fromCache = true;
  const data = await res.json();
  return res.fromCache ? Object.defineProperty(data, '__fromCache', { value: true }) : data;
}
async function loadData() {
  try {
    const meta = await fetchJson('data/meta.json', { cache: 'no-cache' });
    metaCheckedAt = Date.now();
    LOAD_ERR = meta.__fromCache ? 'brak połączenia (rozkład z pamięci telefonu)' : null;
    if (TT && META && META.version === meta.version) return false;
    const tt = await fetchJson(`data/${meta.files.timetable}`);
    TT = new Timetable(tt, meta);
    META = meta;
    // indeksy kursów zmieniają się między wersjami – stare dane na żywo i rozwinięcia są bezużyteczne
    TRIP_IDX = null;
    RT.data = null; RT.fetchedAt = 0;
    expanded.clear();
    DATA_ERR = null;
    return true;
  } catch (e) {
    LOAD_ERR = e.message;
    if (!TT) DATA_ERR = e.message;
    return false;
  }
}
async function ensureTripIdx() {
  if (TRIP_IDX && TRIP_IDX.version === META.version) return TRIP_IDX;
  const meta = META;
  const ids = await fetchJson(`data/${meta.files.tripIds}`);
  const m = new Map();
  ids.forEach((id, k) => { const a = m.get(id); if (a) a.push(k); else m.set(id, [k]); });
  m.version = meta.version;
  if (META === meta) TRIP_IDX = m;
  return m;
}

// ======================================================================
// Dane na żywo (GTFS-RT)
// ======================================================================
const RT = { data: null, fetchedAt: 0, error: null, busy: false };
const rtUrl = () => (S.settings.rtUrl || '').trim() || CFG.rtUrl || '';
const rtOn = () => S.settings.rt && !!rtUrl();
function rtFresh() {
  if (!rtOn() || !RT.data || !META || RT.data.version !== META.version) return false;
  const now = Date.now();
  if (now - RT.fetchedAt > 3 * 60000) return false;
  if (now - RT.data.ts * 1000 > 5 * 60000) return false;
  return true;
}
async function pollRt() {
  if (!rtOn() || !TT || RT.busy || document.hidden) return;
  RT.busy = true;
  const ctl = new AbortController();
  let timer = null;
  try {
    const meta = META;
    const idx = await ensureTripIdx(); // ~0,16 MB raz na wersję rozkładu – poza limitem 10 s
    timer = setTimeout(() => ctl.abort(), 10000);
    // feeds.pb ma opóźnienia i pozycje pojazdów naraz (1 zapytanie). Przy adresie „…/trip_updates”
    // pozycje pobieramy osobno – opcjonalnie, błąd nie blokuje opóźnień.
    const vpUrl = rtUrl().replace(/trip_updates(\.pb)?(\?.*)?$/, 'vehicle_positions$1$2');
    const vpP = vpUrl !== rtUrl()
      ? fetch(vpUrl, { cache: 'no-store', signal: ctl.signal }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
      : Promise.resolve(null);
    const res = await fetch(rtUrl(), { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('za duża odpowiedź');
    const d = decodeTripUpdates(buf);
    if (!d.ts) throw new Error('pusty lub niepoprawny feed');
    if (META !== meta) return; // w międzyczasie wczytano nowy rozkład
    const byTrip = new Map();
    let maxDelay = 0;
    for (const [id, u] of d.updates) {
      const ks = idx.get(id);
      if (ks) for (const k of ks) byTrip.set(k, u);
      if (u.delay > maxDelay && u.delay <= RT_MAX_ABS_DELAY) maxDelay = u.delay;
    }
    let vpByTrip = null;
    const vpBuf = (await vpP) || buf;
    if (vpBuf && vpBuf.byteLength < 5 * 1024 * 1024) {
      try {
        const v = decodeVehiclePositions(vpBuf instanceof Uint8Array ? vpBuf : new Uint8Array(vpBuf));
        if (!v.ts || Math.abs(v.ts - d.ts) < 180) {
          vpByTrip = new Map();
          for (const [id, pos] of v.positions) { const ks = idx.get(id); if (ks) for (const k of ks) vpByTrip.set(k, pos); }
        }
      } catch { /* bez pozycji GPS */ }
    }
    RT.data = { ts: d.ts, byTrip, vpByTrip, count: d.updates.size, maxDelay, version: meta.version };
    RT.fetchedAt = Date.now();
    RT.error = null;
  } catch (e) {
    RT.error = e.name === 'AbortError' ? 'przekroczony czas' : e.message;
  } finally {
    clearTimeout(timer);
    RT.busy = false;
    refreshLive();
  }
}

// ======================================================================
// Lokalizacja
// ======================================================================
const GPS = { pos: null, err: null, watch: null };
function startGps() {
  if (GPS.watch != null || !('geolocation' in navigator)) {
    if (!('geolocation' in navigator)) GPS.err = 'Ta przeglądarka nie udostępnia lokalizacji';
    return;
  }
  GPS.watch = navigator.geolocation.watchPosition(
    (p) => { GPS.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; GPS.err = null; refreshLive(); },
    (e) => {
      GPS.err = e.code === 1 ? 'Brak zgody na lokalizację – zezwól w ustawieniach przeglądarki albo wybierz zapisane miejsce.' : 'Nie udało się ustalić lokalizacji.';
      // przy chwilowym timeoucie zostawiamy świeżą pozycję (do 2 min), w innych przypadkach – nie
      if (e.code !== 3 || Date.now() - (GPS.pos?.at || 0) > 120000) GPS.pos = null;
      refreshLive();
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 25000 },
  );
}
// Po zatrzymaniu nie ufamy starej pozycji – po powrocie użytkownik może być gdzie indziej.
function stopGps() {
  if (GPS.watch != null) { navigator.geolocation.clearWatch(GPS.watch); GPS.watch = null; }
  GPS.pos = null; GPS.err = null;
}
function getPositionOnce() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Brak lokalizacji w tej przeglądarce'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Brak zgody na lokalizację' : 'Nie udało się ustalić lokalizacji')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 },
    );
  });
}

// ======================================================================
// Punkty początkowe/końcowe i zapytania
// ======================================================================
const placeById = (id) => S.places.find((p) => p.id === id);
function epLabel(ep) {
  if (!ep) return '—';
  if (ep.type === 'gps') return 'Moja lokalizacja';
  if (ep.type === 'place') return placeById(ep.id)?.name || '(usunięte miejsce)';
  return ep.name;
}
// -> { stops:[{i,dist,walk}], lat, lon } | { pending } | { error }
function areaFor(ep, radius) {
  if (ep.type === 'stop') {
    const g = TT.groupByName.get(ep.name);
    if (!g) return { error: `Nie ma już przystanku „${ep.name}” w rozkładzie.` };
    return { stops: g.stops.map((i) => ({ i, dist: 0, walk: 0 })), lat: g.lat, lon: g.lon, exact: true };
  }
  let pt;
  if (ep.type === 'gps') {
    startGps();
    if (!GPS.pos) return GPS.err ? { error: GPS.err } : { pending: 'Ustalam Twoją lokalizację…' };
    pt = GPS.pos;
  } else {
    pt = placeById(ep.id);
    if (!pt) return { error: 'To miejsce zostało usunięte – popraw sekcję.' };
  }
  const near = TT.nearStops(pt.lat, pt.lon, radius).map((s) => ({ ...s, walk: walkSecFor(s.dist) }));
  if (!near.length) return { error: `Brak przystanków w promieniu ${fmtDist(radius)} od: ${epLabel(ep)}. Zwiększ promień.` };
  return { stops: near, lat: pt.lat, lon: pt.lon, acc: pt.acc };
}

// Przesiadki liczone na rozkładzie (bez danych na żywo) z pamięcią na 5 minut – na telefonie to
// najdroższa część zapytania. Dane na żywo nakładane są przy każdym odświeżeniu.
const XFER_CACHE = new Map();
function transfersFor(A, B, fromMs, toMs) {
  const bucket = Math.floor(fromMs / 300000) * 300000;
  const st = S.settings;
  const key = [META.version, bucket, toMs - fromMs, st.xferMin, st.speed, st.detour,
    A.stops.map((s) => `${s.i}:${s.walk}`).join(','), B.stops.map((s) => `${s.i}:${s.walk}`).join(',')].join('|');
  let raw = XFER_CACHE.get(key);
  if (!raw) {
    raw = TT.transferConnections(A.stops, B.stops, bucket, toMs + 300000, {
      minTransferSec: st.xferMin * 60, maxWalkM: 250, walkSec: walkSecFor,
    });
    if (XFER_CACHE.size > 30) XFER_CACHE.clear();
    XFER_CACHE.set(key, raw);
  }
  return raw.filter((r) => r.dep >= fromMs && r.dep <= toMs)
    .map((r) => ({ ...r, xfer: { ...r.xfer }, leg2: { ...r.leg2 } }));
}

function runQuery(q, now, windowMin) {
  if (!TT) return { error: DATA_ERR || 'Brak danych rozkładu' };
  const A = areaFor(q.from, q.rFrom);
  if (!A.stops) return A;
  // filtr słupków (tablica przystanku) MUSI działać przed zwijaniem wierszy, inaczej
  // kurs zatrzymujący się na dwóch słupkach zespołu „przeskakuje” na niewybrany słupek
  if (q.posts && q.posts.size) {
    A.stops = A.stops.filter((s) => q.posts.has(TT.stops[s.i].id));
    if (!A.stops.length) return { error: 'Wybrane słupki nie występują w aktualnym rozkładzie.' };
  }
  const B = q.to ? areaFor(q.to, q.rTo) : null;
  if (B && !B.stops) return B;
  const live = rtFresh() ? RT.data : null;
  // okno wstecz: kurs spóźniony o X min miał rozkładowy odjazd X min temu
  const back = live ? Math.max(25, Math.ceil((live.maxDelay || 0) / 60) + 2) : 1;
  const fromMs = now - back * 60000;
  const toMs = now + windowMin * 60000;
  let rows = B ? TT.connections(A.stops, B.stops, fromMs, toMs) : TT.departures(A.stops, fromMs, toMs);
  if (B && S.settings.xfer) rows = rows.concat(transfersFor(A, B, fromMs, toMs));
  const hidden = new Set(q.hidden || []);
  const lines = new Map(); // linie w wynikach (przed filtrem linii) – do przycisków filtra
  const modeOk = (route) => (isTram(route) ? q.tram !== false : q.bus !== false);
  rows = rows.filter((r) => {
    const route = TT.routes[TT.tR[r.k]];
    const route2 = r.leg2 ? TT.routes[TT.tR[r.leg2.k]] : null;
    if (!modeOk(route) || (route2 && !modeOk(route2))) return false;
    lines.set(route.short, route);
    if (route2) lines.set(route2.short, route2);
    return !hidden.has(route.short) && !(route2 && hidden.has(route2.short));
  });
  for (const r of rows) {
    if (r.leg2) {
      const l1 = applyRt(TT, { k: r.k, p: r.p, pos: r.pos, D: r.D, base: r.base, dep: r.dep, arr: r.xfer.arr }, live, now);
      const l2 = applyRt(TT, r.leg2, live, now);
      Object.assign(r, { live: l1.live, delay: l1.delay, gone: l1.gone || l2.gone, near: l1.near, vpDist: l1.vpDist, atStop: l1.atStop, pDep: l1.pDep, pArr: l2.pArr });
      r.xfer.pArr = l1.pArr;
      r.xfer.risky = r.xfer.pArr + (r.xfer.walk + 60) * 1000 > l2.pDep;
    } else applyRt(TT, r, live, now);
    r.leave = r.pDep - r.walk * 1000;
    r.door = r.pArr != null ? r.pArr + (r.arrWalk || 0) * 1000 : null;
  }
  rows = rows.filter((r) => !r.gone && r.pDep >= now - 20000 && r.dep <= toMs);
  if (B) {
    rows = dedupeTrips(rows, now, (r) => `${r.leg2 ? 'x|' : ''}${r.k}|${r.D}`);
    rows = pruneTransfers(rows, now);
  } else {
    // tablica bez celu: zwijamy tylko kolejne słupki tej samej „wizyty” kursu w okolicy;
    // kurs pętlowy, który wraca w okolicę później, zostaje pokazany dwa razy (np. 148 na lotnisko)
    const inA = new Set(A.stops.map((s) => s.i));
    const keys = boardKeys(TT, rows, inA);
    rows = dedupeTrips(rows, now, (r) => keys.get(r));
  }
  if (B) markWorse(rows, now);
  const sort = q.to && q.sort === 'arr' ? 'arr' : 'dep';
  rows.sort(sort === 'arr' ? (a, b) => a.door - b.door || a.pDep - b.pDep : (a, b) => a.pDep - b.pDep || (a.door ?? 0) - (b.door ?? 0));
  return { rows, A, B, live: !!live, toMs, lines: [...lines.values()].sort(routeCmp) };
}

// ======================================================================
// Szablony wierszy
// ======================================================================
const expanded = new Set();
function minsHtml(ms, now) {
  const diff = ms - now;
  if (diff < 45000) return '<div class="mins now">teraz</div>';
  const m = Math.round(diff / 60000);
  if (m < 60) return `<div class="mins">${m}<small>min</small></div>`;
  return `<div class="mins">${fmtHM(ms)}</div>`;
}
function delayHtml(r) {
  if (!r.live) return '';
  const m = Math.round(r.delay / 60);
  if (m === 0) return '<span class="delay ok" title="na czas wg danych na żywo">●</span>';
  return m > 0 ? `<span class="delay late">+${m}</span>` : `<span class="delay early">${m}</span>`;
}
function leaveHtml(r, now) {
  if (!r.walk) return '';
  const d = r.leave - now;
  if (d >= 60000) return `<div class="leave">wyjdź za ${Math.floor(d / 60000)} min</div>`;
  if (d >= 0) return '<div class="leave go">wyjdź teraz</div>';
  if (d >= -90000) return '<div class="leave run">biegiem!</div>';
  return '<div class="leave no">nie zdążysz pieszo</div>';
}
function rowHtml(r, now, { compact = false } = {}) {
  const inf = TT.tripInfo(r.k);
  const st = TT.stops[r.stop];
  const key = `${r.k}|${r.D}|${r.pos}${r.leg2 ? `|x${r.leg2.k}` : ''}`;
  const open = !compact && expanded.has(key);
  const miss = r.walk && r.leave < now - 90000;
  const nz = TT.pickup(r.p, r.pos) === 3;
  const tags = [];
  if (r.best) tags.push('<span class="tag best">najszybciej</span>');
  if (r.worse && !r.best) tags.push('<span class="tag worse">wolniej</span>');
  const depot = inf.notes.find((n) => /zjazd|zajezdni/i.test(n.text));
  if (depot) tags.push('<span class="tag note">do zajezdni</span>');
  if (r.leg2) tags.push(r.xfer.risky ? '<span class="tag note">przesiadka zagrożona</span>' : '<span class="tag worse">przesiadka</span>');
  if (r.atStop) tags.push('<span class="tag best">na przystanku</span>');
  const timeLine = r.live && fmtHM(r.dep) !== fmtHM(r.pDep)
    ? `<s>${fmtHM(r.dep)}</s>${fmtHM(r.pDep)}${delayHtml(r)}`
    : `${fmtHM(r.pDep)}${r.live ? delayHtml(r) : ''}`;
  let l2 = `z <b>${esc(st.name)}</b><span class="post" title="słupek ${esc(st.code)}">${esc(postOf(st.code))}</span>`;
  if (r.dist) l2 += ` · ${fmtDist(r.dist)} (${Math.max(1, Math.round(r.walk / 60))}′)`;
  if (nz) l2 += ' · <abbr title="przystanek na żądanie – daj znak kierowcy">nż</abbr>';
  let l3 = '';
  if (r.leg2) {
    const xs = TT.stops[r.xfer.stop], ys = TT.stops[r.leg2.stop];
    const r2 = TT.routes[TT.tR[r.leg2.k]];
    const wait = Math.max(0, Math.round((r.leg2.pDep - r.xfer.pArr) / 60000));
    l3 += `<div class="l3">przesiadka: <b>${esc(xs.name)}</b> ${fmtHM(r.xfer.pArr)}${ys.name !== xs.name ? ` → pieszo ${fmtDist(r.xfer.dist)} do <b>${esc(ys.name)}</b>` : ''} → ${badge(r2, true)} ${fmtHM(r.leg2.pDep)}${r.leg2.live ? delayHtml(r.leg2) : ''} (${wait} min)</div>`;
  }
  if (r.arrStop != null) {
    const as = TT.stops[r.arrStop];
    const ride = Math.round((r.pArr - r.pDep) / 60000);
    l3 += `<div class="l3">→ <b>${esc(as.name)}</b> ${fmtHM(r.pArr)} · ${ride} min ${r.leg2 ? 'w drodze' : 'jazdy'}`
      + (r.arrWalk ? ` · na miejscu <b>${fmtHM(r.door)}</b>` : '') + '</div>';
    if (r.worse && !r.best && !compact) {
      const ai = TT.tripInfo(r.worse.k);
      l3 += `<div class="l3">lepiej: ${esc(ai.route.short)} o ${fmtHM(r.worse.pDep)} – na miejscu ${fmtHM(r.worse.door)}</div>`;
    }
  }
  const badges = r.leg2
    ? `<div class="badges">${badge(inf.route)}<span class="via" aria-label="przesiadka">↓</span>${badge(TT.routes[TT.tR[r.leg2.k]], true)}</div>`
    : badge(inf.route);
  return `<li class="row${miss ? ' miss' : ''}${(r.worse && !r.best) ? ' dim' : ''}" data-act="toggle" data-key="${key}">
    ${badges}
    <div class="main">
      <div class="l1"><span class="hs">${esc(inf.headsign)}</span>${tags.join('')}</div>
      <div class="l2">${l2}</div>${l3}
    </div>
    <div class="when">${minsHtml(r.pDep, now)}<div class="hm">${timeLine}</div>${leaveHtml(r, now)}</div>
    ${open ? detailHtml(r, inf) : ''}
  </li>`;
}
function vehPosOf(r) {
  if (!r.live || !RT.data) return -1;
  const upd = RT.data.byTrip.get(r.k);
  return upd ? TT.seqToPos(r.k, upd.seq) : -1;
}
function stopListHtml(k, D, from, to, delayMs, vehPos) {
  const stops = TT.tripStops(k, D);
  const items = [];
  for (let j = from; j <= to; j++) {
    const s = stops[j];
    const t = (j === from ? s.dep : s.arr) + (j >= vehPos ? delayMs : 0);
    const cls = [j === from || j === to ? 'on' : '', j === vehPos ? 'veh' : ''].join(' ').trim();
    items.push(`<li class="${cls}"><span>${esc(s.stop.name)} <span class="post">${esc(postOf(s.stop.code))}</span>${s.pickup === 3 ? ' <abbr title="na żądanie">nż</abbr>' : ''}</span><span class="hm">${fmtHM(t)}</span></li>`);
  }
  return `<ol>${items.join('')}</ol>`;
}
function detailHtml(r, inf) {
  const stops = TT.tripStops(r.k, r.D);
  const end = r.leg2 ? r.xfer.pos : r.arrPos != null ? r.arrPos : stops.length - 1;
  const d = r.live ? r.delay * 1000 : 0;
  const vehPos = vehPosOf(r);
  const meta = [];
  meta.push(`${esc(inf.route.agency || 'Przewoźnik')} · linia ${esc(inf.route.short)} → ${esc(inf.headsign)}`);
  if (r.live) {
    const upd = RT.data?.byTrip.get(r.k);
    const away = vehPos >= 0 && vehPos <= r.pos ? r.pos - vehPos : -1;
    const awayTxt = away === 0 ? ' · dojeżdża do Twojego przystanku' : away > 0 ? ` · ${away} ${away === 1 ? 'przystanek' : away < 5 ? 'przystanki' : 'przystanków'} przed Tobą` : '';
    meta.push(`<span class="live-dot"></span>na żywo${r.near ? ` · zbliża się do: ${esc(r.near)}` : ''}${awayTxt}${upd?.label ? ` · pojazd ${esc(upd.label)}` : ''}`);
    if (r.atStop) meta.push('GPS: pojazd stoi przy Twoim przystanku');
    else if (r.vpDist != null) meta.push(`GPS: pojazd ok. ${fmtDist(r.vpDist)} od Twojego przystanku (w linii prostej)`);
  } else meta.push('wg rozkładu (brak danych na żywo dla tego kursu)');
  if (inf.wheelchair) meta.push('♿ pojazd przystosowany');
  for (const n of inf.notes) meta.push(`<b>${esc(n.code)}</b> – ${esc(n.text)}`);
  let html = `<div class="meta">${meta.join('<br>')}</div>${stopListHtml(r.k, r.D, r.pos, end, d, vehPos)}`;
  if (r.leg2) {
    const l2 = r.leg2, i2 = TT.tripInfo(l2.k);
    const wait = Math.max(0, Math.round((l2.pDep - r.xfer.pArr) / 60000));
    const walkTxt = l2.stop !== r.xfer.stop ? `przejdź ${fmtDist(r.xfer.dist)} (ok. ${Math.max(1, Math.round(r.xfer.walk / 60))} min) na ${esc(TT.stops[l2.stop].name)} ${esc(postOf(TT.stops[l2.stop].code))}, ` : '';
    html += `<div class="meta more">⇄ Przesiadka: ${walkTxt}czekasz ok. ${wait} min${r.xfer.risky ? ' – <b>przy obecnym opóźnieniu możesz nie zdążyć</b>' : ''}<br>${esc(i2.route.agency || '')} · linia ${esc(i2.route.short)} → ${esc(i2.headsign)}${l2.live ? ' · <span class="live-dot"></span>na żywo' : ''}</div>`;
    html += stopListHtml(l2.k, l2.D, l2.pos, l2.arrPos, l2.live ? l2.delay * 1000 : 0, vehPosOf(l2));
  }
  return `<div class="detail" data-act="noop">${html}</div>`;
}

// ======================================================================
// Renderowanie: widok + odświeżane fragmenty
// ======================================================================
let LIVE = new Map();
function live(key, fn) { LIVE.set(key, fn); return `<div data-live="${esc(key)}">${safe(fn)}</div>`; }
function safe(fn) { try { return fn(); } catch (e) { console.error(e); return `<div class="banner err">Błąd: ${esc(e.message)}</div>`; } }
function refreshLive() {
  for (const el of document.querySelectorAll('[data-live]')) {
    const fn = LIVE.get(el.dataset.live);
    if (fn) el.innerHTML = safe(fn);
  }
  renderStatus();
}
function renderStatus() {
  const el = $('#status');
  if (!el) return;
  if (!TT) { el.innerHTML = ''; return; }
  const on = rtFresh();
  const txt = on ? 'na żywo' : rtOn() ? (RT.error ? 'bez danych na żywo' : 'łączę…') : 'rozkład';
  el.innerHTML = `<span class="pulse${on ? ' on' : ''}"></span>${txt}`;
  el.title = on ? `Dane na żywo: ${RT.data.count} kursów` : RT.error ? `Dane na żywo niedostępne: ${RT.error}` : '';
}

function dataBanner() {
  if (!TT) return '';
  const today = warsawYmd(Date.now());
  if (!TT.covers(today)) {
    return `<div class="banner err">Rozkład w aplikacji obowiązuje ${fmtYmd(TT.dates[0])}–${fmtYmd(TT.dates.at(-1))} i nie obejmuje dzisiejszego dnia. <button class="link" data-act="update-data">Pobierz aktualny</button></div>`;
  }
  const left = TT.dates.filter((d) => d >= today).length;
  if (left <= 2) return `<div class="banner warn">Rozkład kończy się ${fmtYmd(TT.dates.at(-1))}. <button class="link" data-act="update-data">Sprawdź aktualizację</button></div>`;
  return '';
}

const ROUTES = [
  [/^#?\/?$/, () => viewHome(), 'home'],
  [/^#\/s\/([\w-]+)$/, (m) => viewSection(m[1]), 'home'],
  [/^#\/nearby$/, () => viewNearby(), 'nearby'],
  [/^#\/stops$/, () => viewStops(), 'stops'],
  [/^#\/stop\/(.+)$/, (m) => { let n; try { n = decodeURIComponent(m[1]); } catch { n = m[1]; } return viewStop(n); }, 'stops'],
  [/^#\/settings$/, () => viewSettings(), 'settings'],
];
let currentTab = 'home';
function render() {
  LIVE = new Map();
  const h = location.hash || '#/';
  let out = null;
  for (const [re, fn, tab] of ROUTES) {
    const m = re.exec(h);
    if (m) { currentTab = tab; out = fn(m); break; }
  }
  if (!out) { location.hash = '#/'; return; }
  $('#title').innerHTML = out.title || 'Odjazdy<span class="dot">·</span>Poznań';
  $('#back').hidden = !out.back;
  $('#back').dataset.to = out.back || '';
  for (const a of document.querySelectorAll('nav.tabs a')) {
    if (a.dataset.tab === currentTab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const view = $('#view');
  view.innerHTML = out.html;
  if (out.after) out.after(view);
  // lokalizacja tylko tam, gdzie potrzebna (oszczędzanie baterii)
  if (!out.gps) stopGps();
  renderStatus();
}

function needsData() {
  if (TT) return null;
  if (DATA_ERR) {
    return { html: `<div class="banner err">Nie udało się wczytać rozkładu: ${esc(DATA_ERR)}</div><button class="btn primary block" data-act="reload">Spróbuj ponownie</button>` };
  }
  return { html: '<div class="splash"><div class="board">ODJAZDY</div><div>Ładuję rozkład…</div></div>' };
}

// ---------- Strona główna: sekcje ----------
function sectionSub(sec) {
  const a = `${esc(epLabel(sec.from))}${sec.from.type !== 'stop' ? ` (${fmtDist(sec.rFrom)})` : ''}`;
  if (!sec.to) return `odjazdy: ${a}`;
  return `${a} → ${esc(epLabel(sec.to))}${sec.to.type !== 'stop' ? ` (${fmtDist(sec.rTo)})` : ''}`;
}
function resultsHtml(res, now, { limit = Infinity, compact = false } = {}) {
  if (res.pending) return `<div class="empty"><p>${esc(res.pending)}</p></div>`;
  if (res.error) return `<div class="empty"><p>${esc(res.error)}</p></div>`;
  let rows = res.rows;
  if (S.settings.hideWorse) rows = rows.filter((r) => !(r.worse && !r.best));
  if (compact) rows = rows.filter((r) => !(r.walk && r.leave < now - 90000));
  if (!rows.length) return `<div class="empty"><p>Brak bezpośrednich kursów w najbliższych ${Math.round((res.toMs - now) / 60000)} min.</p></div>`;
  return `<ul class="rows">${rows.slice(0, limit).map((r) => rowHtml(r, now, { compact })).join('')}</ul>`;
}
function viewHome() {
  const nd = needsData(); if (nd) return nd;
  const needGps = S.sections.some((s) => s.from.type === 'gps' || s.to?.type === 'gps');
  let html = dataBanner();
  if (!S.sections.length) {
    html += `<div class="empty">
      <h2>Twoje trasy</h2>
      <p>Dodaj miejsce (np. <b>Praca</b>, <b>Uczelnia</b>, <b>Dom</b>) – aplikacja pokaże <b>wszystkie</b> tramwaje i autobusy,
      które dowiozą Cię tam bez przesiadki, ze wszystkich przystanków w promieniu ${fmtDist(S.settings.radius)}.</p>
      <div class="btns"><button class="btn primary" data-act="place-new">+ Dodaj miejsce</button>
      <button class="btn" data-act="section-new">+ Nowa sekcja</button></div>
    </div>
    <div class="card"><div class="card-h"><div class="t"><h2>Odjazdy w pobliżu</h2><div class="sub">wszystko z przystanków wokół Ciebie</div></div></div>
    <div class="card-f"><span></span><a class="link" href="#/nearby">Otwórz →</a></div></div>`;
  } else {
    for (const sec of S.sections) {
      html += `<section class="card"><div class="card-h"><div class="t"><h2>${esc(sec.name)}</h2><div class="sub">${sectionSub(sec)}</div></div>
        <button class="icon-btn" data-act="section-edit" data-id="${esc(sec.id)}" aria-label="Edytuj sekcję">✎</button></div>
        ${live(`home-${sec.id}`, () => {
          const now = Date.now();
          const res = runQuery(sec, now, Math.min(S.settings.window, 120));
          return resultsHtml(res, now, { limit: 4, compact: true })
            + (res.rows ? `<div class="card-f"><span>${res.rows.length} kursów w ${Math.min(S.settings.window, 120)} min</span><a class="link" href="#/s/${esc(sec.id)}">Wszystkie →</a></div>` : '');
        })}
      </section>`;
    }
    html += '<div class="btns"><button class="btn" data-act="section-new">+ Nowa sekcja</button><button class="btn" data-act="place-new">+ Miejsce</button></div>';
  }
  html += footHtml();
  return { html, gps: needGps };
}
function footHtml() {
  const v = TT ? `Rozkład ${fmtYmd(TT.dates[0])}–${fmtYmd(TT.dates.at(-1))}` : '';
  return `<div class="foot">${v}<br>Dane: ZTM Poznań (GTFS, GTFS-RT). Aplikacja nieoficjalna – w razie wątpliwości sprawdź rozkład na przystanku.</div>`;
}

// ---------- Widok sekcji ----------
const extraWindow = new Map();
function viewSection(id) {
  const nd = needsData(); if (nd) return nd;
  const sec = S.sections.find((s) => s.id === id);
  if (!sec) return { html: '<div class="empty"><p>Nie ma takiej sekcji.</p><a class="link" href="#/">Wróć</a></div>', back: '#/' };
  const html = `${dataBanner()}
    <div class="hint" style="margin:0 2px 10px">${sectionSub(sec)}</div>
    <div class="toolbar">
      ${sec.to ? `<div class="seg" role="group" aria-label="Sortowanie">
        <button data-act="sec-sort" data-id="${esc(sec.id)}" data-v="dep" aria-pressed="${sec.sort !== 'arr'}">Odjazd</button>
        <button data-act="sec-sort" data-id="${esc(sec.id)}" data-v="arr" aria-pressed="${sec.sort === 'arr'}">Na miejscu</button></div>
        <button class="chip" data-act="toggle-worse" aria-pressed="${!S.settings.hideWorse}">${S.settings.hideWorse ? 'Pokaż' : 'Ukryj'} wolniejsze</button>` : ''}
      <button class="icon-btn" data-act="section-edit" data-id="${esc(sec.id)}" aria-label="Edytuj sekcję">✎</button>
    </div>
    ${live(`sec-${sec.id}`, () => {
      const now = Date.now();
      const win = S.settings.window + (extraWindow.get(sec.id) || 0);
      const res = runQuery(sec, now, win);
      const hidden = new Set(sec.hidden);
      const chips = res.lines && (res.lines.length > 1 || hidden.size)
        ? `<div class="chips scroll" aria-label="Linie – stuknij, aby ukryć">${res.lines.map((r) => `<button class="chip" data-act="sec-line" data-id="${esc(sec.id)}" data-line="${esc(r.short)}" aria-pressed="${!hidden.has(r.short)}">${badge(r, true)}</button>`).join('')}</div>`
        : '';
      return `${chips}<div class="card">${resultsHtml(res, now)}</div>`;
    })}
    <button class="btn block" data-act="more" data-id="${esc(sec.id)}">Pokaż kolejną godzinę</button>
    ${footHtml()}`;
  return { html, title: esc(sec.name), back: '#/', gps: sec.from.type === 'gps' };
}

// ---------- W pobliżu ----------
function nearbyQuery() {
  const src = S.nearby.src;
  const from = src === 'gps' || !placeById(src) ? { type: 'gps' } : { type: 'place', id: src };
  return { from, to: null, rFrom: S.nearby.r, tram: true, bus: true, hidden: [] };
}
function viewNearby() {
  const nd = needsData(); if (nd) return nd;
  const q = nearbyQuery();
  const opts = [`<option value="gps"${q.from.type === 'gps' ? ' selected' : ''}>📍 Moja lokalizacja</option>`]
    .concat(S.places.map((p) => `<option value="${esc(p.id)}"${q.from.id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`));
  const html = `${dataBanner()}
    <div class="row-2">
      <label class="field"><span>Skąd</span><select data-act="nearby-src">${opts.join('')}</select></label>
      <label class="field"><span>Promień: <b data-out="r">${fmtDist(S.nearby.r)}</b></span>
        <input type="range" min="100" max="1000" step="50" value="${S.nearby.r}" data-act="nearby-r"></label>
    </div>
    ${live('nearby-info', () => {
      const A = areaFor(q.from, q.rFrom);
      if (!A.stops) return '';
      const names = [...new Set(A.stops.map((s) => TT.stops[s.i].name))];
      return `<div class="hint" style="margin:-4px 2px 12px">${A.stops.length} słupków: ${esc(names.join(', '))}${A.acc ? ` · dokładność GPS ±${Math.round(A.acc)} m` : ''}</div>`;
    })}
    <div class="card">${live('nearby', () => { const now = Date.now(); return resultsHtml(runQuery(q, now, Math.min(S.settings.window, 60)), now); })}</div>
    <button class="btn block" data-act="nearby-save">Zapisz jako sekcję</button>
    ${footHtml()}`;
  return { html, title: 'W pobliżu', gps: q.from.type === 'gps' };
}

// ---------- Przystanki ----------
function viewStops() {
  const nd = needsData(); if (nd) return nd;
  const recent = S.recent.filter((n) => TT.groupByName.has(n));
  const html = `<label class="field"><span>Szukaj przystanku</span>
      <input type="search" id="stop-q" placeholder="np. Rondo Kaponiera, Most Teatralny" autocomplete="off" enterkeyhint="search"></label>
    <ul class="list" id="stop-res" hidden></ul>
    ${recent.length ? `<h3 class="sec">Ostatnie</h3><ul class="list">${recent.map(groupLi).join('')}</ul>` : '<p class="hint">Wpisz nazwę – wielkość liter i polskie znaki nie mają znaczenia.</p>'}`;
  return {
    html, title: 'Przystanki',
    after: (root) => {
      const inp = $('#stop-q', root);
      const out = $('#stop-res', root);
      inp.addEventListener('input', () => {
        const res = TT.searchGroups(inp.value, 25);
        out.hidden = !inp.value.trim();
        out.innerHTML = res.length ? res.map(groupLi).join('') : '<li><span class="hint">Nic nie znaleziono</span></li>';
      });
    },
  };
}
function groupLi(name) {
  const g = typeof name === 'string' ? TT.groupByName.get(name) : name;
  if (!g) return '';
  const routes = new Map();
  for (const i of g.stops) for (const r of TT.stopRoutes(i)) routes.set(r.short, r);
  const lines = [...routes.values()].sort(routeCmp).slice(0, 18);
  return `<li class="tap" data-act="open-stop" data-name="${esc(g.name)}"><div class="grow"><div class="name">${esc(g.name)}</div>
    <div class="lines-mini">${lines.map((r) => badge(r, true)).join('')}${routes.size > 18 ? '<span class="hint">…</span>' : ''}</div></div><span aria-hidden="true">›</span></li>`;
}
const stopUi = { name: null, posts: new Set(), to: null };
function viewStop(name) {
  const nd = needsData(); if (nd) return nd;
  const g = TT.groupByName.get(name);
  if (!g) return { html: '<div class="empty"><p>Nie znaleziono przystanku.</p></div>', back: '#/stops' };
  if (stopUi.name !== name) { stopUi.name = name; stopUi.posts = new Set(); stopUi.to = null; }
  S.recent = [name, ...S.recent.filter((n) => n !== name)].slice(0, 8); save();
  const posts = g.stops.map((i) => {
    const s = TT.stops[i];
    const hs = new Set();
    const sp = TT.stopPats[i];
    for (let x = 0; x < sp.length && hs.size < 3; x += 2) {
      const p = sp[x], pos = sp[x + 1];
      if (pos === TT.pS[p].length - 1) continue;
      if (TT.pStart[p] < TT.pStart[p + 1]) hs.add(TT.headsigns[TT.tH[TT.pStart[p]]]);
    }
    return { i, id: s.id, post: postOf(s.code), hs: [...hs] };
  }).sort((a, b) => a.post.localeCompare(b.post, 'pl', { numeric: true }));
  const q = () => ({
    from: { type: 'stop', name }, to: stopUi.to ? { type: 'stop', name: stopUi.to } : null,
    rFrom: 0, rTo: 0, tram: true, bus: true, hidden: [], sort: 'dep', posts: stopUi.posts,
  });
  const html = `${dataBanner()}
    <div class="chips scroll" aria-label="Słupki – stuknij, aby filtrować">${posts.map((p) => `<button class="chip" data-act="stop-post" data-id="${esc(p.id)}" aria-pressed="${!stopUi.posts.size || stopUi.posts.has(p.id)}"><b>${esc(p.post)}</b> <span class="hint">${esc(p.hs.join(', ') || '—')}</span></button>`).join('')}</div>
    <label class="field"><span>Dokąd? (opcjonalnie – pokaże tylko kursy, które tam dojadą)</span>
      <input type="search" id="stop-to" placeholder="nazwa przystanku docelowego" value="${esc(stopUi.to || '')}" autocomplete="off"></label>
    <ul class="list" id="stop-to-res" hidden></ul>
    <div class="card">${live('stop-board', () => {
      const now = Date.now();
      const query = q();
      return resultsHtml(runQuery(query, now, Math.min(S.settings.window, 90)), now);
    })}</div>
    <button class="btn block" data-act="stop-save">Zapisz jako sekcję</button>
    ${footHtml()}`;
  return {
    html, title: esc(name), back: '#/stops',
    after: (root) => {
      const inp = $('#stop-to', root);
      const out = $('#stop-to-res', root);
      inp.addEventListener('input', () => {
        const v = inp.value.trim();
        if (!v) { out.hidden = true; if (stopUi.to) { stopUi.to = null; refreshLive(); } return; }
        const res = TT.searchGroups(v, 8).filter((x) => x.name !== name);
        out.hidden = false;
        out.innerHTML = res.map((x) => `<li class="tap" data-act="stop-to" data-name="${esc(x.name)}"><div class="grow name">${esc(x.name)}</div></li>`).join('') || '<li class="hint">Nic nie znaleziono</li>';
      });
    },
  };
}

// ---------- Ustawienia ----------
function viewSettings() {
  const st = S.settings;
  const placeRows = S.places.map((p) => `<li class="tap" data-act="place-edit" data-id="${esc(p.id)}"><div class="grow"><div class="name">${esc(p.name)}</div>
      <div class="sub">${TT ? `${TT.nearStops(p.lat, p.lon, st.radius).length} słupków w promieniu ${fmtDist(st.radius)}` : ''}</div></div><span>✎</span></li>`).join('');
  const secRows = S.sections.map((s, ix) => `<li><div class="grow tap" data-act="section-edit" data-id="${esc(s.id)}"><div class="name">${esc(s.name)}</div><div class="sub">${sectionSub(s)}</div></div>
      <button class="icon-btn" data-act="sec-up" data-id="${esc(s.id)}" aria-label="W górę" ${ix === 0 ? 'disabled' : ''}>↑</button></li>`).join('');
  const rtState = () => (!S.settings.rt ? 'wyłączone' : !rtUrl() ? 'brak adresu pośrednika' : rtFresh() ? `działa (${RT.data.count} kursów, ${fmtHM(RT.fetchedAt)})` : RT.error ? `błąd: ${esc(RT.error)}` : 'łączę…');
  const html = `
    <h3 class="sec">Miejsca</h3>
    <ul class="list">${placeRows || '<li class="hint">Brak zapisanych miejsc.</li>'}</ul>
    <button class="btn block" data-act="place-new">+ Dodaj miejsce</button>

    <h3 class="sec">Sekcje na stronie głównej</h3>
    <ul class="list">${secRows || '<li class="hint">Brak sekcji.</li>'}</ul>
    <button class="btn block" data-act="section-new">+ Nowa sekcja</button>

    <h3 class="sec">Chodzenie i wyniki</h3>
    <div class="card" style="padding:14px">
      <label class="field"><span>Tempo marszu</span><select data-set="speed">
        ${[[65, 'spokojnie (3,9 km/h)'], [80, 'normalnie (4,8 km/h)'], [95, 'szybko (5,7 km/h)'], [110, 'bardzo szybko (6,6 km/h)']].map(([v, l]) => `<option value="${v}"${st.speed === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <label class="field"><span>Kręte ulice: droga piesza = linia prosta × <b data-out="detour">${st.detour.toFixed(2).replace('.', ',')}</b></span>
        <input type="range" min="1" max="1.8" step="0.05" value="${st.detour}" data-set="detour"></label>
      <label class="field"><span>Domyślny promień nowych sekcji: <b data-out="radius">${fmtDist(st.radius)}</b></span>
        <input type="range" min="100" max="1000" step="50" value="${st.radius}" data-set="radius"></label>
      <label class="field"><span>Pokazuj kursy na najbliższe: <b data-out="window">${st.window} min</b></span>
        <input type="range" min="30" max="240" step="15" value="${st.window}" data-set="window"></label>
      <label class="check"><input type="checkbox" data-set="hideWorse" ${st.hideWorse ? 'checked' : ''}> Ukrywaj wolniejsze opcje (gdy późniejszy kurs dowiezie szybciej)</label>
      <label class="check"><input type="checkbox" data-set="xfer" ${st.xfer ? 'checked' : ''}> Pokazuj połączenia z 1 przesiadką (tylko gdy wyraźnie szybsze niż bezpośrednie)</label>
      <label class="field"><span>Minimalny czas na przesiadkę</span><select data-set="xferMin">
        ${[1, 2, 3, 4, 5].map((v) => `<option value="${v}"${st.xferMin === v ? ' selected' : ''}>${v} min</option>`).join('')}
      </select></label>
      <label class="field" style="margin:8px 0 0"><span>Motyw</span><select data-set="theme">
        ${[['auto', 'jak w systemie'], ['dark', 'ciemny'], ['light', 'jasny']].map(([v, l]) => `<option value="${v}"${st.theme === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label>
    </div>

    <h3 class="sec">Dane na żywo (opóźnienia)</h3>
    <div class="card" style="padding:14px">
      <label class="check"><input type="checkbox" data-set="rt" ${st.rt ? 'checked' : ''}> Pokazuj opóźnienia i pozycje pojazdów</label>
      <label class="field"><span>Adres pośrednika GTFS-RT (puste = domyślny: ${esc(CFG.rtUrl || 'brak')})</span>
        <input type="url" data-set="rtUrl" value="${esc(st.rtUrl)}" placeholder="https://…/rt/trip_updates" autocomplete="off" spellcheck="false"></label>
      ${live('rt-state', () => `<div class="hint">Stan: ${rtState()}</div>`)}
    </div>

    <h3 class="sec">Rozkład</h3>
    <div class="card" style="padding:14px">
      ${TT ? `<div class="hint">Obowiązuje: <b>${fmtYmd(TT.dates[0])}–${fmtYmd(TT.dates.at(-1))}</b><br>
        Pliki ZTM: ${META.feeds.map((f) => esc(f.name)).join(', ')}<br>
        Przygotowano: ${esc(new Date(META.generated).toLocaleString('pl-PL'))} · wersja ${esc(META.version)}<br>
        ${META.counts.stops} przystanków · ${META.counts.routes} linii · ${META.counts.trips} kursów</div>` : ''}
      <div class="btns" style="margin-top:12px"><button class="btn" data-act="update-data">Sprawdź aktualizację</button></div>
    </div>

    <h3 class="sec">Kopia ustawień</h3>
    <div class="btns"><button class="btn" data-act="export">Eksportuj</button><button class="btn" data-act="import">Importuj</button></div>
    <p class="hint">Miejsca i sekcje są zapisane tylko w tej przeglądarce. Eksport pozwala przenieść je na inne urządzenie.</p>
    <input type="file" id="import-file" accept="application/json,.json" hidden>
    ${footHtml()}`;
  return { html, title: 'Ustawienia' };
}

// ======================================================================
// Arkusze: miejsce, sekcja, wybór przystanku
// ======================================================================
let sheetCleanup = null;
function openSheet(html, after) {
  closeSheet();
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-bg" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  if (after) sheetCleanup = after($('.sheet', root)) || null;
}
function closeSheet() {
  if (sheetCleanup) { try { sheetCleanup(); } catch { /* */ } sheetCleanup = null; }
  $('#sheet-root').innerHTML = '';
  document.body.style.overflow = '';
}

// --- Leaflet (wczytywany dopiero przy pierwszym otwarciu mapy) ---
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletP) {
    leafletP = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = 'vendor/leaflet/leaflet.js';
      s.onload = () => resolve(window.L);
      s.onerror = () => { leafletP = null; reject(new Error('Nie udało się wczytać mapy')); };
      document.head.appendChild(s);
    });
  }
  return leafletP;
}

function placeSheet(id, preset = {}) {
  const p = id ? placeById(id) : null;
  const st = { name: p?.name || preset.name || '', lat: p?.lat ?? preset.lat ?? null, lon: p?.lon ?? preset.lon ?? null };
  const r = S.settings.radius;
  openSheet(`<h2>${p ? 'Edytuj miejsce' : 'Nowe miejsce'}</h2>
    <label class="field"><span>Nazwa</span><input type="text" id="pl-name" maxlength="60" value="${esc(st.name)}" placeholder="np. Praca, UEP, Dom"></label>
    <div class="btns" style="margin-bottom:10px">
      <button class="btn" id="pl-gps">📍 Moja lokalizacja</button>
      <button class="btn" id="pl-stop">🚏 Z przystanku</button>
    </div>
    <div class="map" id="pl-map" aria-label="Mapa – stuknij, aby ustawić punkt"></div>
    <div class="hint" id="pl-info">Stuknij mapę, aby wskazać dokładne miejsce.</div>
    ${!p ? `<label class="check"><input type="checkbox" id="pl-mksec" checked> Utwórz też sekcję z mojej lokalizacji do tego miejsca</label>` : ''}
    <div class="btns" style="margin-top:14px">
      ${p ? '<button class="btn danger" id="pl-del">Usuń</button>' : ''}
      <button class="btn" data-act="sheet-close">Anuluj</button>
      <button class="btn primary" id="pl-save">Zapisz</button>
    </div>`, (root) => {
    let map = null, marker = null, circle = null, stopLayer = null;
    const info = $('#pl-info', root);
    const update = () => {
      if (st.lat == null) return;
      const near = TT ? TT.nearStops(st.lat, st.lon, r) : [];
      const names = [...new Set(near.map((s) => TT.stops[s.i].name))];
      info.innerHTML = `${st.lat.toFixed(5)}, ${st.lon.toFixed(5)} · <b>${near.length} słupków</b> w promieniu ${fmtDist(r)}${names.length ? `: ${esc(names.slice(0, 6).join(', '))}${names.length > 6 ? '…' : ''}` : ''}`;
      if (!map) return;
      const ll = [st.lat, st.lon];
      if (!marker) {
        marker = window.L.circleMarker(ll, { radius: 9, color: '#141414', weight: 3, fillColor: '#ffb627', fillOpacity: 1 }).addTo(map);
        circle = window.L.circle(ll, { radius: r, color: '#ffb627', weight: 1.5, fillOpacity: 0.08 }).addTo(map);
      } else { marker.setLatLng(ll); circle.setLatLng(ll); }
      stopLayer.clearLayers();
      if (TT) for (const s of TT.nearStops(st.lat, st.lon, r * 1.8)) {
        const so = TT.stops[s.i];
        window.L.circleMarker([so.lat, so.lon], { radius: 4, weight: 1, color: '#fff', fillColor: s.dist <= r ? '#3ddc84' : '#8e969f', fillOpacity: 1 })
          .bindTooltip(esc(`${so.name} ${postOf(so.code)}`)).addTo(stopLayer);
      }
    };
    const center = (zoom) => { if (map && st.lat != null) map.setView([st.lat, st.lon], zoom || Math.max(map.getZoom(), 16)); };
    loadLeaflet().then((L) => {
      if (!root.isConnected) return;
      map = L.map($('#pl-map', root), { zoomControl: true, attributionControl: true }).setView(st.lat != null ? [st.lat, st.lon] : POZNAN, st.lat != null ? 16 : 13);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      }).addTo(map);
      stopLayer = L.layerGroup().addTo(map);
      map.on('click', (e) => {
        st.lat = e.latlng.lat; st.lon = e.latlng.lng; update();
        if (map.getZoom() < 15) map.setView(e.latlng, 16);
      });
      setTimeout(() => map.invalidateSize(), 50);
      update();
    }).catch((e) => { $('#pl-map', root).innerHTML = `<div class="empty"><p>${esc(e.message)}. Użyj lokalizacji albo przystanku.</p></div>`; });
    update();
    $('#pl-gps', root).addEventListener('click', async (ev) => {
      ev.currentTarget.disabled = true;
      try { const pos = await getPositionOnce(); st.lat = pos.lat; st.lon = pos.lon; update(); center(17); if (pos.acc > 100) toast(`Dokładność tylko ±${Math.round(pos.acc)} m – popraw punkt na mapie`); }
      catch (e) { toast(e.message); }
      finally { ev.currentTarget.disabled = false; }
    });
    $('#pl-stop', root).addEventListener('click', () => {
      stopPicker((g) => {
        st.lat = g.lat; st.lon = g.lon;
        const nameInp = $('#pl-name', root);
        if (!nameInp.value.trim()) nameInp.value = g.name;
        update(); center(17);
      }, root);
    });
    $('#pl-del', root)?.addEventListener('click', () => {
      const used = S.sections.filter((s) => s.from.id === id || s.to?.id === id);
      const msg = used.length ? `Usunąć „${p.name}”? Używają go sekcje: ${used.map((s) => s.name).join(', ')} – zostaną też usunięte.` : `Usunąć „${p.name}”?`;
      if (!confirm(msg)) return;
      S.places = S.places.filter((x) => x.id !== id);
      S.sections = S.sections.filter((s) => !used.includes(s));
      save(); closeSheet(); render();
    });
    $('#pl-save', root).addEventListener('click', () => {
      const name = $('#pl-name', root).value.trim();
      if (!name) { toast('Podaj nazwę miejsca'); return; }
      if (st.lat == null) { toast('Wskaż miejsce na mapie, lokalizacją albo przystankiem'); return; }
      if (p) Object.assign(p, { name, lat: st.lat, lon: st.lon });
      else {
        const np = { id: uid(), name, lat: st.lat, lon: st.lon };
        S.places.push(np);
        if ($('#pl-mksec', root)?.checked) {
          S.sections.push({ id: uid(), name: `→ ${name}`, from: { type: 'gps' }, to: { type: 'place', id: np.id }, rFrom: S.settings.radius, rTo: S.settings.radius, tram: true, bus: true, hidden: [], sort: 'dep' });
        }
      }
      save(); closeSheet(); render(); toast('Zapisano');
    });
    return () => { if (map) map.remove(); };
  });
}

// mini-arkusz wyboru przystanku (nad innym arkuszem)
function stopPicker(onPick, parentRoot) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-bg';
  wrap.style.zIndex = 55;
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div><h2>Wybierz przystanek</h2>
    <input type="search" placeholder="nazwa przystanku" autocomplete="off" id="sp-q">
    <ul class="list" id="sp-res" style="margin-top:10px"></ul><button class="btn block" id="sp-x">Anuluj</button></div>`;
  (parentRoot?.closest('#sheet-root') || document.body).appendChild(wrap);
  const inp = $('#sp-q', wrap), out = $('#sp-res', wrap);
  const close = () => wrap.remove();
  inp.addEventListener('input', () => {
    out.innerHTML = TT.searchGroups(inp.value, 20).map((g) => `<li class="tap" data-name="${esc(g.name)}"><div class="grow name">${esc(g.name)}</div></li>`).join('');
  });
  out.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-name]');
    if (!li) return;
    const g = TT.groupByName.get(li.dataset.name);
    close();
    if (g) onPick(g);
  });
  $('#sp-x', wrap).addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  setTimeout(() => inp.focus(), 50);
}

function epOptions(selected, { allowNone = false, allowGps = true } = {}) {
  const sel = selected ? (selected.type === 'place' ? `place:${selected.id}` : selected.type === 'stop' ? `stop:${selected.name}` : 'gps') : 'none';
  const o = [];
  if (allowNone) o.push(['none', '— tylko odjazdy (bez celu) —']);
  if (allowGps) o.push(['gps', '📍 Moja lokalizacja']);
  for (const p of S.places) o.push([`place:${p.id}`, p.name]);
  if (selected?.type === 'stop') o.push([`stop:${selected.name}`, `🚏 ${selected.name}`]);
  o.push(['pick-stop', '🚏 Przystanek…']);
  return o.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
}
function parseEp(v) {
  if (v === 'none') return null;
  if (v === 'gps') return { type: 'gps' };
  if (v.startsWith('place:')) return { type: 'place', id: v.slice(6) };
  if (v.startsWith('stop:')) return { type: 'stop', name: v.slice(5) };
  return undefined;
}
function sectionSheet(id, preset = {}) {
  const sec = id ? S.sections.find((s) => s.id === id) : null;
  const d = sec ? structuredClone(sec) : {
    id: uid(), name: preset.name || '', from: preset.from || { type: 'gps' }, to: preset.to === undefined ? (S.places[0] ? { type: 'place', id: S.places[0].id } : null) : preset.to,
    rFrom: preset.rFrom || S.settings.radius, rTo: S.settings.radius, tram: true, bus: true, hidden: [], sort: 'dep',
  };
  const body = () => `<h2>${sec ? 'Edytuj sekcję' : 'Nowa sekcja'}</h2>
    <label class="field"><span>Nazwa</span><input type="text" id="se-name" maxlength="60" value="${esc(d.name)}" placeholder="np. Do pracy"></label>
    <label class="field"><span>Skąd</span><select id="se-from">${epOptions(d.from)}</select></label>
    ${d.from.type !== 'stop' ? `<label class="field"><span>Przystanki w promieniu <b data-out="rf">${fmtDist(d.rFrom)}</b> od startu</span>
      <input type="range" id="se-rf" min="100" max="1000" step="50" value="${d.rFrom}"></label>` : ''}
    <label class="field"><span>Dokąd</span><select id="se-to">${epOptions(d.to, { allowNone: true, allowGps: false })}</select></label>
    ${d.to && d.to.type !== 'stop' ? `<label class="field"><span>…do przystanków w promieniu <b data-out="rt">${fmtDist(d.rTo)}</b> od celu</span>
      <input type="range" id="se-rt" min="100" max="1000" step="50" value="${d.rTo}"></label>` : ''}
    <label class="check"><input type="checkbox" id="se-tram" ${d.tram ? 'checked' : ''}> Tramwaje</label>
    <label class="check"><input type="checkbox" id="se-bus" ${d.bus ? 'checked' : ''}> Autobusy</label>
    ${!S.places.length ? '<p class="hint">Wskazówka: najpierw dodaj miejsce (np. Praca), żeby wybrać je jako cel. Możesz też wybrać przystanek.</p>' : ''}
    <div class="btns" style="margin-top:14px">
      ${sec ? '<button class="btn danger" id="se-del">Usuń</button>' : ''}
      <button class="btn" data-act="sheet-close">Anuluj</button>
      <button class="btn primary" id="se-save">Zapisz</button>
    </div>`;
  const bind = (root) => {
    const sync = () => {
      d.name = $('#se-name', root).value;
      d.tram = $('#se-tram', root).checked; d.bus = $('#se-bus', root).checked;
      const rf = $('#se-rf', root); if (rf) d.rFrom = +rf.value;
      const rt = $('#se-rt', root); if (rt) d.rTo = +rt.value;
    };
    const rerender = () => { sync(); root.innerHTML = `<div class="grab"></div>${body()}`; bind(root); };
    for (const [selId, field] of [['#se-from', 'from'], ['#se-to', 'to']]) {
      $(selId, root).addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === 'pick-stop') {
          stopPicker((g) => { d[field] = { type: 'stop', name: g.name }; rerender(); }, root);
          e.target.value = field === 'to' && !d.to ? 'none' : e.target.querySelector('option[selected]')?.value || 'gps';
          return;
        }
        d[field] = parseEp(v);
        rerender();
      });
    }
    for (const [inpId, out, field] of [['#se-rf', 'rf', 'rFrom'], ['#se-rt', 'rt', 'rTo']]) {
      const el = $(inpId, root);
      if (el) el.addEventListener('input', () => { d[field] = +el.value; $(`[data-out="${out}"]`, root).textContent = fmtDist(+el.value); });
    }
    $('#se-del', root)?.addEventListener('click', () => {
      if (!confirm(`Usunąć sekcję „${sec.name}”?`)) return;
      S.sections = S.sections.filter((s) => s.id !== id);
      save(); closeSheet(); if (location.hash.startsWith('#/s/')) location.hash = '#/'; else render();
    });
    $('#se-save', root).addEventListener('click', () => {
      sync();
      d.name = d.name.trim() || (d.to ? `→ ${epLabel(d.to)}` : `Odjazdy: ${epLabel(d.from)}`);
      if (d.to && d.from.type !== 'gps' && JSON.stringify(d.to) === JSON.stringify(d.from)) { toast('Start i cel są takie same'); return; }
      if (!d.tram && !d.bus) { toast('Zaznacz tramwaje lub autobusy'); return; }
      if (sec) Object.assign(sec, d); else S.sections.push(d);
      save(); closeSheet(); render(); toast('Zapisano');
    });
  };
  openSheet(body(), (root) => { bind(root); });
}

// ======================================================================
// Zdarzenia
// ======================================================================
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'noop') { e.stopPropagation(); return; }
  if (act === 'sheet-bg') { if (e.target === el) closeSheet(); return; }
  if (act === 'sheet-close') { closeSheet(); return; }
  if (act === 'toggle') {
    if (e.target.closest('.detail')) return;
    const k = el.dataset.key;
    if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
    refreshLive();
    return;
  }
  if (act === 'place-new') return placeSheet(null);
  if (act === 'place-edit') return placeSheet(el.dataset.id);
  if (act === 'section-new') return sectionSheet(null);
  if (act === 'section-edit') return sectionSheet(el.dataset.id);
  if (act === 'sec-sort') { const s = S.sections.find((x) => x.id === el.dataset.id); if (s) { s.sort = el.dataset.v; save(); render(); } return; }
  if (act === 'sec-line') {
    const s = S.sections.find((x) => x.id === el.dataset.id); if (!s) return;
    const l = el.dataset.line;
    s.hidden = s.hidden.includes(l) ? s.hidden.filter((x) => x !== l) : [...s.hidden, l];
    save(); refreshLive(); return;
  }
  if (act === 'sec-up') {
    const i = S.sections.findIndex((x) => x.id === el.dataset.id);
    if (i > 0) { [S.sections[i - 1], S.sections[i]] = [S.sections[i], S.sections[i - 1]]; save(); render(); }
    return;
  }
  if (act === 'toggle-worse') { S.settings.hideWorse = !S.settings.hideWorse; save(); render(); return; }
  if (act === 'more') { extraWindow.set(el.dataset.id, (extraWindow.get(el.dataset.id) || 0) + 60); refreshLive(); return; }
  if (act === 'open-stop') { location.hash = `#/stop/${encodeURIComponent(el.dataset.name)}`; return; }
  if (act === 'stop-post') {
    const id = el.dataset.id;
    if (stopUi.posts.has(id)) stopUi.posts.delete(id); else stopUi.posts.add(id);
    for (const c of document.querySelectorAll('[data-act="stop-post"]')) c.setAttribute('aria-pressed', String(!stopUi.posts.size || stopUi.posts.has(c.dataset.id)));
    refreshLive(); return;
  }
  if (act === 'stop-to') {
    stopUi.to = el.dataset.name;
    $('#stop-to').value = stopUi.to; $('#stop-to-res').hidden = true;
    refreshLive(); return;
  }
  if (act === 'stop-save') {
    return sectionSheet(null, { name: stopUi.to ? `${stopUi.name} → ${stopUi.to}` : stopUi.name, from: { type: 'stop', name: stopUi.name }, to: stopUi.to ? { type: 'stop', name: stopUi.to } : null });
  }
  if (act === 'nearby-save') {
    const q = nearbyQuery();
    return sectionSheet(null, { name: q.from.type === 'gps' ? 'W pobliżu' : `Odjazdy: ${epLabel(q.from)}`, from: q.from, to: null, rFrom: q.rFrom });
  }
  if (act === 'update-data') {
    el.disabled = true;
    const changed = await loadData();
    el.disabled = false;
    toast(changed ? 'Wczytano nowy rozkład' : LOAD_ERR ? `Nie udało się sprawdzić: ${LOAD_ERR}` : 'Masz najnowszy rozkład');
    render();
    if (changed) pollRt();
    return;
  }
  if (act === 'reload') { location.reload(); return; }
  if (act === 'export') {
    const blob = new Blob([JSON.stringify({ app: 'odjazdy-poznan', v: 1, exported: new Date().toISOString(), ...S }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'odjazdy-ustawienia.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return;
  }
  if (act === 'import') { $('#import-file').click(); return; }
});
$('#back').addEventListener('click', () => { location.hash = $('#back').dataset.to || '#/'; });

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'import-file' && el.files?.[0]) {
    try {
      const text = await el.files[0].text();
      if (text.length > 1_000_000) throw new Error('Plik jest za duży');
      const data = normalizeState(JSON.parse(text));
      if (!confirm(`Zastąpić obecne ustawienia? (${data.places.length} miejsc, ${data.sections.length} sekcji)`)) return;
      S = data; save(); applyTheme(); render(); toast('Zaimportowano');
    } catch (err) { toast(`Nie udało się zaimportować: ${err.message}`); }
    el.value = '';
    return;
  }
  if (el.dataset.act === 'nearby-src') { S.nearby.src = el.value; save(); render(); return; }
  const k = el.dataset.set;
  if (k) {
    const st = S.settings;
    if (el.type === 'checkbox') st[k] = el.checked;
    else if (typeof DEFAULT_SETTINGS[k] === 'number') st[k] = +el.value;
    else st[k] = el.value;
    S = normalizeState(S); save();
    if (k === 'theme') applyTheme();
    if (k === 'rt' || k === 'rtUrl') { RT.data = null; RT.error = null; pollRt(); }
    render();
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.act === 'nearby-r') {
    S.nearby.r = +el.value;
    const out = $('[data-out="r"]'); if (out) out.textContent = fmtDist(S.nearby.r);
    clearTimeout(el._t); el._t = setTimeout(() => { save(); render(); }, 250);
  }
  if (el.dataset.set && el.type === 'range') {
    const out = $(`[data-out="${el.dataset.set}"]`);
    if (out) out.textContent = el.dataset.set === 'detour' ? (+el.value).toFixed(2).replace('.', ',') : el.dataset.set === 'window' ? `${el.value} min` : fmtDist(+el.value);
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#sheet-root').firstChild) closeSheet(); });
window.addEventListener('hashchange', () => { closeSheet(); safeRender(); window.scrollTo(0, 0); });

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ======================================================================
// Start
// ======================================================================
function safeRender() {
  try { render(); } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="banner err">Błąd widoku: ${esc(e.message)}</div><a class="link" href="#/">Strona główna</a>`;
  }
}
async function boot() {
  applyTheme();
  safeRender();
  await loadData();
  safeRender();
  pollRt();
  setInterval(refreshLive, 15000);
  setInterval(pollRt, 20000);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) { stopGps(); return; }
    if (Date.now() - metaCheckedAt > 30 * 60000) await loadData();
    safeRender(); // wznawia lokalizację tam, gdzie potrzebna
    pollRt();
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // lokalnie (npm run dev) bez SW, żeby zmiany w kodzie były widoczne od razu; ?sw wymusza
    const dev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !/[?&]sw\b/.test(location.search);
    if (dev) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    else navigator.serviceWorker.register('sw.js').catch(() => { /* bez trybu offline */ });
  }
}
boot();
