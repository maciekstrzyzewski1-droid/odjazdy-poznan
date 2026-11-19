// Silnik rozkładu: dekodowanie danych, wyszukiwanie odjazdów i połączeń, opóźnienia GTFS-RT.
// Czysty JS (bez DOM) – działa w przeglądarce i w Node (testy).

export const TZ = 'Europe/Warsaw';

// ---------- czas w strefie Europe/Warsaw (niezależnie od strefy urządzenia) ----------
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function wParts(ms) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = +p.value;
  return o;
}
// przesunięcie Warszawy względem UTC w minutach w danej chwili
export function warsawOffsetMin(ms) {
  const p = wParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
export function warsawYmd(ms) {
  const p = wParts(ms);
  return `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`;
}
export function ymdAdd(ymd, n) {
  const t = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
}
// GTFS: czasy liczone od „południa minus 12 h” dnia kursowania (poprawne przy zmianie czasu)
const baseCache = new Map();
export function serviceBase(ymd) {
  let v = baseCache.get(ymd);
  if (v != null) return v;
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 12);
  let noon = guess - warsawOffsetMin(guess) * 60000;
  noon = guess - warsawOffsetMin(noon) * 60000;
  v = noon - 12 * 3600000;
  baseCache.set(ymd, v);
  return v;
}
const hmFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const fmtHM = (ms) => hmFmt.format(new Date(ms));

// ---------- geografia ----------
export function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function normalize(s) {
  return s.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------- rozkład ----------
export class Timetable {
  constructor(tt, meta = {}) {
    if (tt.v !== 1) throw new Error('Nieobsługiwana wersja danych');
    this.meta = meta;
    this.dates = tt.dates;
    this.dateSet = new Set(tt.dates);
    this.stops = tt.stops.map(([id, name, code, lat, lon, zone], i) => ({ i, id, name, code, lat, lon, zone }));
    this.routes = tt.routes.map(([id, short, type, color, text, agency, notes], i) => ({ i, id, short, type, color, text, agency, notes: notes || {} }));
    this.headsigns = tt.headsigns;
    this.services = tt.services.map((ix) => new Set(ix.map((d) => tt.dates[d])));
    const P = tt.patterns;
    this.pS = P.s; this.pD = P.d; this.pA = P.a; this.pF = P.f; this.pSq = P.sq || P.s.map(() => null);
    this.pStart = P.start;
    const T = tt.trips;
    const n = T.r.length;
    this.nTrips = n;
    this.tR = T.r; this.tH = T.h; this.tSv = T.s; this.tN = T.n; this.tW = T.w; this.tQ = T.q || new Array(n).fill(0);
    this.tT0 = new Int32Array(n);
    this.tP = new Int32Array(n);
    for (let p = 0; p < this.pS.length; p++) {
      let acc = 0;
      for (let k = this.pStart[p]; k < this.pStart[p + 1]; k++) { acc += T.t[k]; this.tT0[k] = acc; this.tP[k] = p; }
    }
    // przystanek -> [wzorzec, pozycja]
    this.stopPats = this.stops.map(() => []);
    for (let p = 0; p < this.pS.length; p++) {
      const s = this.pS[p];
      for (let pos = 0; pos < s.length; pos++) this.stopPats[s[pos]].push(p, pos);
    }
    // grupy przystanków po nazwie (zespoły)
    const groups = new Map();
    for (const s of this.stops) {
      if (!this.stopPats[s.i].length) continue;
      let g = groups.get(s.name);
      if (!g) { g = { name: s.name, key: normalize(s.name), stops: [] }; groups.set(s.name, g); }
      g.stops.push(s.i);
    }
    for (const g of groups.values()) {
      g.lat = g.stops.reduce((a, i) => a + this.stops[i].lat, 0) / g.stops.length;
      g.lon = g.stops.reduce((a, i) => a + this.stops[i].lon, 0) / g.stops.length;
    }
    this.groups = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    this.groupByName = groups;
    this._active = new Map();
    this._stopRoutes = null;
  }

  covers(ymd) { return this.dateSet.has(ymd); }

  activeFor(ymd) {
    let a = this._active.get(ymd);
    if (!a) { a = Uint8Array.from(this.services, (set) => (set.has(ymd) ? 1 : 0)); this._active.set(ymd, a); }
    return a;
  }

  pickup(p, pos) { const f = this.pF[p]; return f ? parseInt(f[pos], 16) >> 2 : 0; }
  dropoff(p, pos) { const f = this.pF[p]; return f ? parseInt(f[pos], 16) & 3 : 0; }
  depOff(p, pos) { return this.pD[p][pos]; }
  arrOff(p, pos) { const a = this.pA[p]; return this.pD[p][pos] - (a ? a[pos] : 0); }
  seqToPos(k, seq) {
    const sq = this.pSq[this.tP[k]];
    if (sq) return sq.indexOf(seq);
    // kursy numerowane od 1: ZTM podaje seq 0, gdy pojazd czeka przed pierwszym przystankiem
    if (seq >= 0 && seq < this.tQ[k]) return 0;
    return seq - this.tQ[k];
  }

  stopRoutes(i) {
    if (!this._stopRoutes) this._stopRoutes = new Map();
    let r = this._stopRoutes.get(i);
    if (r) return r;
    const set = new Set();
    const sp = this.stopPats[i];
    for (let x = 0; x < sp.length; x += 2) {
      const p = sp[x], pos = sp[x + 1];
      if (pos === this.pS[p].length - 1) continue;
      for (let k = this.pStart[p]; k < this.pStart[p + 1]; k++) set.add(this.tR[k]);
    }
    r = [...set].map((ri) => this.routes[ri]).sort(routeCmp);
    this._stopRoutes.set(i, r);
    return r;
  }

  nearStops(lat, lon, radius) {
    const out = [];
    const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    for (const s of this.stops) {
      if (Math.abs(s.lat - lat) > dLat || Math.abs(s.lon - lon) > dLon) continue;
      if (!this.stopPats[s.i].length) continue;
      const d = distM(lat, lon, s.lat, s.lon);
      if (d <= radius) out.push({ i: s.i, dist: d });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  searchGroups(q, limit = 30) {
    const nq = normalize(q);
    if (!nq) return [];
    const words = nq.split(' ');
    const scored = [];
    for (const g of this.groups) {
      if (!words.every((w) => g.key.includes(w))) continue;
      const score = (g.key.startsWith(nq) ? 0 : g.key.split(' ').some((w) => w.startsWith(words[0])) ? 1 : 2);
      scored.push([score, g]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'pl'));
    return scored.slice(0, limit).map((x) => x[1]);
  }

  // Odjazdy z zestawu przystanków. origin: [{i, walk (s), dist}]
  // Zwraca wystąpienia kursów (jedno na kurs – z przystanku, z którego wyjście jest najpóźniejsze).
  departures(origin, fromMs, toMs, { needDest = null } = {}) {
    const res = [];
    const startYmd = ymdAdd(warsawYmd(fromMs), -1);
    const endYmd = warsawYmd(toMs);
    for (let D = startYmd; D <= endYmd; D = ymdAdd(D, 1)) {
      if (!this.dateSet.has(D)) continue;
      const base = serviceBase(D);
      const act = this.activeFor(D);
      const lo = Math.floor((fromMs - base) / 1000), hi = Math.ceil((toMs - base) / 1000);
      if (hi < 0) continue;
      for (const o of origin) {
        const sp = this.stopPats[o.i];
        for (let x = 0; x < sp.length; x += 2) {
          const p = sp[x], pos = sp[x + 1];
          const len = this.pS[p].length;
          if (pos === len - 1) continue; // ostatni przystanek – tylko przyjazd
          if (this.pickup(p, pos) === 1) continue;
          let dest = null;
          if (needDest) { dest = this._bestDest(p, pos, needDest); if (!dest) continue; }
          const off = this.pD[p][pos];
          let a = this.pStart[p], b = this.pStart[p + 1];
          const target = lo - off;
          while (a < b) { const m = (a + b) >> 1; if (this.tT0[m] < target) a = m + 1; else b = m; }
          for (let k = a; k < this.pStart[p + 1]; k++) {
            const dep = this.tT0[k] + off;
            if (dep > hi) break;
            if (!act[this.tSv[k]]) continue;
            res.push({ k, p, pos, D, base, dep: base + dep * 1000, stop: o.i, walk: o.walk || 0, dist: o.dist || 0, dest });
          }
        }
      }
    }
    return res;
  }

  // najlepszy (najwcześniej na miejscu) przystanek docelowy dalej na trasie
  _bestDest(p, pos, destMap) {
    const s = this.pS[p];
    let best = null;
    for (let j = pos + 1; j < s.length; j++) {
      const w = destMap.get(s[j]);
      if (w == null) continue;
      if (this.dropoff(p, j) === 1) continue;
      const door = this.arrOff(p, j) + w.walk;
      if (!best || door < best.door) best = { pos: j, stop: s[j], walk: w.walk, dist: w.dist, door };
    }
    return best;
  }

  // Połączenia bezpośrednie: origin/dest – [{i, walk, dist}]
  connections(origin, dest, fromMs, toMs) {
    const destMap = new Map(dest.map((d) => [d.i, d]));
    const raw = this.departures(origin, fromMs, toMs, { needDest: destMap });
    return raw.map((r) => ({
      ...r,
      arrStop: r.dest.stop, arrPos: r.dest.pos, arrWalk: r.dest.walk, arrDist: r.dest.dist,
      arr: r.base + (this.tT0[r.k] + this.arrOff(r.p, r.dest.pos)) * 1000,
    }));
  }

  // ---------- przesiadki ----------
  // przystanki w zasięgu pieszym (z samym przystankiem, dist 0), z pamięcią
  _foot(i, maxWalkM) {
    if (!this._footCache) this._footCache = new Map();
    const key = i * 10000 + maxWalkM;
    let f = this._footCache.get(key);
    if (!f) { const s = this.stops[i]; f = this.nearStops(s.lat, s.lon, maxWalkM); this._footCache.set(key, f); }
    return f;
  }

  // dni kursowania potrzebne do szukania drugiego odcinka (bez Intl w pętli – to drogie)
  _days(fromMs, toMs) {
    const out = [];
    for (let D = ymdAdd(warsawYmd(fromMs), -1); D <= warsawYmd(toMs); D = ymdAdd(D, 1)) {
      if (this.dateSet.has(D)) out.push({ D, base: serviceBase(D), act: this.activeFor(D) });
    }
    return out;
  }

  // najwcześniejszy kurs wzorca p odjeżdżający z pozycji q nie wcześniej niż readyMs
  _nextTrip(p, q, readyMs, days, maxWaitMs) {
    const off = this.pD[p][q];
    let res = null;
    for (const { D, base, act } of days) {
      const target = Math.ceil((readyMs - base) / 1000) - off;
      let a = this.pStart[p], b = this.pStart[p + 1];
      while (a < b) { const m = (a + b) >> 1; if (this.tT0[m] < target) a = m + 1; else b = m; }
      for (let k = a; k < this.pStart[p + 1]; k++) {
        const dep = base + (this.tT0[k] + off) * 1000;
        if (dep - readyMs > maxWaitMs) break;
        if (!act[this.tSv[k]]) continue;
        if (!res || dep < res.dep) res = { k, D, base, dep };
        break;
      }
    }
    return res;
  }

  // Połączenia z jedną przesiadką: kurs 1 z okolicy startu → (dojście ≤ maxWalkM) → kurs 2 do okolicy celu.
  // Dla każdego wyjazdu kursem 1 wybiera przesiadkę dającą najwcześniejsze dotarcie na miejsce.
  transferConnections(origin, dest, fromMs, toMs, {
    minTransferSec = 120, maxWalkM = 250, maxWaitMs = 30 * 60000,
    walkSec = (d) => Math.round((d * 1.3) / 80 * 60),
  } = {}) {
    const destMap = new Map(dest.map((d) => [d.i, d]));
    const destPat = new Map(); // wzorzec -> [[pozycja, offset do drzwi celu]]
    for (const d of dest) {
      const sp = this.stopPats[d.i];
      for (let x = 0; x < sp.length; x += 2) {
        const p = sp[x], j = sp[x + 1];
        if (this.dropoff(p, j) === 1) continue;
        let a = destPat.get(p);
        if (!a) destPat.set(p, (a = []));
        a.push([j, this.arrOff(p, j) + d.walk]);
      }
    }
    const bestAfter = (p, q) => {
      const a = destPat.get(p);
      if (!a) return null;
      let b = null;
      for (const e of a) if (e[0] > q && (!b || e[1] < b[1])) b = e;
      return b;
    };
    const originSet = new Set(origin.map((o) => o.i));
    const days = this._days(fromMs, toMs + 3 * 3600000);
    const out = [];
    for (const r of this.departures(origin, fromMs, toMs)) {
      const p = r.p, s = this.pS[p], t0 = this.tT0[r.k];
      let best = null;
      for (let x = r.pos + 1; x < s.length; x++) {
        if (destMap.has(s[x])) break; // ten kurs sam dojeżdża do celu – to połączenie bezpośrednie
        if (this.dropoff(p, x) === 1) continue;
        const arr1 = r.base + (t0 + this.arrOff(p, x)) * 1000;
        if (best && arr1 >= best.door) break;
        for (const nb of this._foot(s[x], maxWalkM)) {
          if (originSet.has(nb.i)) continue; // przesiadka z powrotem przy starcie nie ma sensu
          const w = nb.i === s[x] ? 0 : walkSec(nb.dist);
          const ready = arr1 + (w + minTransferSec) * 1000;
          const sp2 = this.stopPats[nb.i];
          for (let y = 0; y < sp2.length; y += 2) {
            const p2 = sp2[y], q = sp2[y + 1];
            if (p2 === p || q === this.pS[p2].length - 1 || this.pickup(p2, q) === 1) continue;
            const ba = bestAfter(p2, q);
            if (!ba) continue;
            const hit = this._nextTrip(p2, q, ready, days, maxWaitMs);
            if (!hit) continue;
            const door = hit.base + (this.tT0[hit.k] + ba[1]) * 1000;
            if (best && (door > best.door || (door === best.door && hit.dep <= best.leg2.dep))) continue;
            const arrStop = this.pS[p2][ba[0]];
            const dd = destMap.get(arrStop);
            best = {
              door, x, arr1, w, dist: nb.dist,
              leg2: {
                k: hit.k, D: hit.D, base: hit.base, p: p2, pos: q, stop: nb.i, dep: hit.dep,
                arrPos: ba[0], arrStop, arr: hit.base + (this.tT0[hit.k] + this.arrOff(p2, ba[0])) * 1000,
                arrWalk: dd.walk, arrDist: dd.dist,
              },
            };
          }
        }
      }
      if (best) {
        const l2 = best.leg2;
        out.push({
          ...r, leg2: l2,
          xfer: { pos: best.x, stop: s[best.x], arr: best.arr1, walk: best.w, dist: best.dist },
          arrStop: l2.arrStop, arrPos: l2.arrPos, arrWalk: l2.arrWalk, arrDist: l2.arrDist, arr: l2.arr,
        });
      }
    }
    return out;
  }

  tripStops(k, D) {
    const p = this.tP[k], base = serviceBase(D);
    return this.pS[p].map((si, pos) => ({
      pos, stop: this.stops[si],
      arr: base + (this.tT0[k] + this.arrOff(p, pos)) * 1000,
      dep: base + (this.tT0[k] + this.pD[p][pos]) * 1000,
      pickup: this.pickup(p, pos), dropoff: this.dropoff(p, pos),
    }));
  }

  tripInfo(k) {
    const route = this.routes[this.tR[k]];
    const codes = this.tN[k] || '';
    const notes = [];
    for (const c of codes) if (route.notes[c]) notes.push({ code: c, text: route.notes[c] });
    return { route, headsign: this.headsigns[this.tH[k]], wheelchair: !!this.tW[k], notes };
  }
}

export function routeCmp(a, b) {
  const na = parseInt(a.short, 10), nb = parseInt(b.short, 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  if (isNaN(na) !== isNaN(nb)) return isNaN(na) ? 1 : -1;
  return a.short.localeCompare(b.short, 'pl', { numeric: true });
}

// Jeden wpis na kurs (k + dzień): wybieramy wariant z najpóźniejszym wyjściem z domu,
// który jeszcze daje się złapać; przy remisie – krótsze dojście.
export function dedupeTrips(list, nowMs, keyFn = (r) => `${r.k}|${r.D}`) {
  const best = new Map();
  for (const r of list) {
    const key = keyFn(r);
    const cur = best.get(key);
    if (!cur) { best.set(key, r); continue; }
    const rOk = r.leave >= nowMs, cOk = cur.leave >= nowMs;
    let better;
    if (rOk !== cOk) better = rOk;
    else if (r.door != null && cur.door != null && r.door !== cur.door) better = r.door < cur.door;
    else if (rOk) better = r.leave > cur.leave || (r.leave === cur.leave && r.walk < cur.walk);
    else better = r.walk < cur.walk;
    if (better) best.set(key, r);
  }
  return [...best.values()];
}

// Klucz zwijania na tablicy bez celu: kurs + dzień + początek „wizyty” w okolicy
// (ciąg kolejnych przystanków kursu należących do inA). Kurs pętlowy wracający w okolicę
// później dostaje osobny wiersz, a dwa sąsiednie słupki tego samego zespołu – jeden.
export function visitKey(tt, r, inA) {
  const s = tt.pS[r.p];
  let x = r.pos;
  while (x > 0 && inA.has(s[x - 1])) x--;
  return `${r.k}|${r.D}|${x}`;
}

// Klucze zwijania dla całej tablicy: osobny wiersz dostaje tylko powrót kursu w okolicę
// po co najmniej minGapMs (np. 148 na lotnisko, ~1 h). Krótka pętla (ten sam autobus na sąsiednim
// słupku 2–5 min później) zostaje jednym wierszem.
export function boardKeys(tt, rows, inA, minGapMs = 10 * 60000) {
  const keys = new Map();
  const groups = new Map();
  for (const r of rows) {
    const g = `${r.k}|${r.D}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const [g, list] of groups) {
    list.sort((a, b) => a.dep - b.dep);
    let c = 0, prevVisit = null, prevDep = 0;
    for (const r of list) {
      const v = visitKey(tt, r, inA);
      if (prevVisit !== null && v !== prevVisit && r.dep - prevDep >= minGapMs) c++;
      prevVisit = v; prevDep = r.dep;
      keys.set(r, `${g}|${c}`);
    }
  }
  return keys;
}

// Opcja jest „wolniejsza”, jeśli inna pozwala wyjść nie wcześniej i być na miejscu ≥1 min szybciej.
// Oznacza: r.best (najwcześniej na miejscu), r.worse (lepsza alternatywa). Wymaga r.leave i r.door.
export function markWorse(rows, nowMs) {
  const ok = rows.filter((r) => r.leave >= nowMs && r.door != null);
  let best = null;
  for (const r of ok) if (!best || r.door < best.door || (r.door === best.door && r.leave > best.leave)) best = r;
  for (const r of rows) { r.best = false; r.worse = null; }
  if (best) best.best = true;
  for (const x of ok) {
    let alt = null;
    for (const y of ok) {
      if (y === x) continue;
      if (y.leave >= x.leave && y.door <= x.door - 60000 && (!alt || y.door < alt.door)) alt = y;
    }
    x.worse = alt;
  }
  return rows;
}

// Przesiadka ma sens tylko wtedy, gdy wyraźnie wygrywa. Ukrywa opcję z przesiadką, jeśli:
// – jakieś połączenie bezpośrednie pozwala wyjść nie wcześniej i dojechać najwyżej tolMs później
//   (bez przesiadki wolimy nawet trochę dłużej), albo
// – inna opcja z przesiadką jest od niej nie gorsza pod oboma względami (i lepsza w jednym).
// Na koniec zostawia maxKeep opcji z przesiadką (najwcześniej na miejscu).
export function pruneTransfers(rows, nowMs, { tolMs = 2 * 60000, maxKeep = 12 } = {}) {
  const direct = rows.filter((r) => !r.leg2);
  const xf = rows.filter((r) => r.leg2);
  // jedna opcja na kurs 2 (ten sam autobus po przesiadce) – z najpóźniejszym wyjściem
  const byLeg2 = new Map();
  for (const r of xf) {
    const key = `${r.leg2.k}|${r.leg2.D}`;
    const cur = byLeg2.get(key);
    if (!cur || r.leave > cur.leave || (r.leave === cur.leave && r.door < cur.door)) byLeg2.set(key, r);
  }
  const cand = [...byLeg2.values()];
  const keep = cand.filter((x) => {
    if (direct.some((y) => y.door != null && y.leave >= x.leave && y.door <= x.door + tolMs && y.leave >= nowMs - 90000)) return false;
    return !cand.some((y) => y !== x && y.leave >= x.leave && y.door <= x.door && (y.leave > x.leave || y.door < x.door));
  }).sort((a, b) => a.door - b.door).slice(0, maxKeep);
  return direct.concat(keep);
}

// ---------- GTFS-RT (protobuf) ----------
function pbRead(buf, start, end, cb) {
  let p = start;
  const varint = () => {
    let r = 0, s = 0, b;
    do {
      if (p >= end || s > 63) throw new Error('pb: uszkodzony varint');
      b = buf[p++];
      if (s < 28) r |= (b & 0x7f) << s; else r += (b & 0x7f) * 2 ** s;
      s += 7;
    } while (b & 0x80);
    return r;
  };
  while (p < end) {
    const key = varint();
    const f = Math.floor(key / 8), w = key % 8;
    if (w === 0) {
      const lo = p; const v = varint();
      cb(f, 0, v, lo, p);
    } else if (w === 2) {
      const l = varint();
      if (l > end - p) throw new Error('pb: zła długość pola');
      cb(f, 2, null, p, p + l); p += l;
    } else if (w === 5) {
      if (p + 4 > end) throw new Error('pb: ucięte pole');
      cb(f, 5, null, p, p + 4); p += 4;
    } else if (w === 1) {
      if (p + 8 > end) throw new Error('pb: ucięte pole'); p += 8;
    } else throw new Error('pb wire ' + w);
  }
}
// odczyt int32 zapisanego jako varint (ujemne = 10 bajtów)
function int32At(buf, a, b) {
  let r = 0, s = 0, p = a;
  while (p < b && s < 32) { const x = buf[p++]; r |= (x & 0x7f) << s; s += 7; if (!(x & 0x80)) break; }
  return r | 0;
}
const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const str = (buf, a, b) => td.decode(buf.subarray(a, b));

// Zwraca { ts (s), updates: Map trip_id -> {seq, delay, vehicle, label, ts} }
// Ten sam trip_id bywa w feedzie dwa razy (dwa pojazdy) – zostaje nowszy wpis, przy remisie dalszy przystanek.
export function decodeTripUpdates(u8) {
  const updates = new Map();
  let ts = 0;
  pbRead(u8, 0, u8.length, (f, w, v, a, b) => {
    if (f === 1 && w === 2) pbRead(u8, a, b, (g, ww, vv) => { if (g === 3 && ww === 0) ts = vv; });
    if (f !== 2 || w !== 2) return;
    pbRead(u8, a, b, (ef, ew, ev, ea, eb) => {
      if (ef !== 3 || ew !== 2) return;
      let tripId = null, seq = null, delay = null, vehicle = '', label = '', tuDelay = null, tuTs = 0;
      pbRead(u8, ea, eb, (g, gw, gv, ga, gb) => {
        if (g === 1 && gw === 2) pbRead(u8, ga, gb, (h, hw, hv, ha, hb) => { if (h === 1 && hw === 2) tripId = str(u8, ha, hb); });
        else if (g === 3 && gw === 2) pbRead(u8, ga, gb, (h, hw, hv, ha, hb) => {
          if (hw === 2 && h === 1) vehicle = str(u8, ha, hb);
          if (hw === 2 && h === 2) label = str(u8, ha, hb);
        });
        else if (g === 5 && gw === 0) tuDelay = int32At(u8, ga, gb);
        else if (g === 4 && gw === 0) tuTs = gv;
        else if (g === 2 && gw === 2) {
          // StopTimeUpdate – bierzemy pierwszy (ZTM podaje jeden: najbliższy przystanek)
          let s = null, d = null;
          pbRead(u8, ga, gb, (h, hw, hv, ha, hb) => {
            if (h === 1 && hw === 0) s = hv;
            if ((h === 2 || h === 3) && hw === 2 && d == null) {
              pbRead(u8, ha, hb, (q, qw, qv, qa, qb) => { if (q === 1 && qw === 0) d = int32At(u8, qa, qb); });
            }
          });
          if (seq == null && s != null) { seq = s; delay = d; }
        }
      });
      if (tripId == null) return;
      if (delay == null) delay = tuDelay;
      const old = updates.get(tripId);
      if (old && (old.ts > tuTs || (old.ts === tuTs && (old.seq ?? -1) >= (seq ?? -1)))) return;
      updates.set(tripId, { seq, delay, vehicle, label, ts: tuTs });
    });
  });
  return { ts, updates };
}

const f32 = (buf, a) => new DataView(buf.buffer, buf.byteOffset + a, 4).getFloat32(0, true);

// Pozycje pojazdów: Map trip_id -> { lat, lon, seq, ts, vehicle, label } (przy powtórzeniach – nowszy wpis)
export function decodeVehiclePositions(u8) {
  const out = new Map();
  let ts = 0;
  pbRead(u8, 0, u8.length, (f, w, v, a, b) => {
    if (f === 1 && w === 2) pbRead(u8, a, b, (g, ww, vv) => { if (g === 3 && ww === 0) ts = vv; });
    if (f !== 2 || w !== 2) return;
    pbRead(u8, a, b, (ef, ew, ev, ea, eb) => {
      if (ef !== 4 || ew !== 2) return;
      let tripId = null, lat = null, lon = null, seq = null, vts = 0, vehicle = '', label = '';
      pbRead(u8, ea, eb, (g, gw, gv, ga, gb) => {
        if (g === 1 && gw === 2) pbRead(u8, ga, gb, (h, hw, hv, ha, hb) => { if (h === 1 && hw === 2) tripId = str(u8, ha, hb); });
        else if (g === 2 && gw === 2) pbRead(u8, ga, gb, (h, hw, hv, ha) => {
          if (h === 1 && hw === 5) lat = f32(u8, ha);
          if (h === 2 && hw === 5) lon = f32(u8, ha);
        });
        else if (g === 3 && gw === 0) seq = gv;
        else if (g === 5 && gw === 0) vts = gv;
        else if (g === 8 && gw === 2) pbRead(u8, ga, gb, (h, hw, hv, ha, hb) => {
          if (h === 1 && hw === 2) vehicle = str(u8, ha, hb);
          if (h === 2 && hw === 2) label = str(u8, ha, hb);
        });
      });
      if (tripId == null || lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      if (Math.abs(lat) < 1 && Math.abs(lon) < 1) return; // brak fixu GPS (0,0)
      const old = out.get(tripId);
      if (old && old.ts > vts) return;
      out.set(tripId, { lat, lon, seq, ts: vts, vehicle, label });
    });
  });
  return { ts, positions: out };
}

// Pojazd „przy przystanku” wg GPS (m). Dalej – ufamy numerowi przystanku z trip_updates.
export const VP_AT_STOP_M = 120;

// Nakłada opóźnienia na wyniki. rt: { ts, byTrip: Map k -> upd, vpByTrip?: Map k -> vp }
export const RT_MAX_ABS_DELAY = 2 * 3600;   // większe wartości to błędy źródła
export const RT_MAX_EARLY = 3 * 60;         // przyspieszenie liczymy maks. 3 min
export const RT_MAX_IMPLAUSIBLE_EARLY = 10 * 60; // > 10 min przed czasem w trasie = błędne przypisanie
export function applyRt(tt, r, rt, nowMs) {
  r.live = false; r.delay = 0; r.gone = false; r.near = null; r.vpDist = null; r.atStop = false;
  r.pDep = r.dep; if (r.arr != null) r.pArr = r.arr;
  if (!rt) return r;
  const upd = rt.byTrip.get(r.k);
  if (!upd || upd.seq == null || upd.delay == null) return r;
  if (Math.abs(r.dep - nowMs) > 4 * 3600000) return r; // inny dzień tego samego kursu
  if (Math.abs(upd.delay) > RT_MAX_ABS_DELAY) return r;
  const posRt = tt.seqToPos(r.k, upd.seq);
  if (posRt < 0) return r;
  // Przed rozkładowym startem kursu ZTM bywa, że przypisuje pojazd (jeszcze na poprzednim kursie
  // albo na pętli) do dalszego przystanku z dużym ujemnym opóźnieniem. Takie dane pomijamy,
  // inaczej realny odjazd zniknąłby jako „już minął”.
  if (posRt > 0 && r.base != null && nowMs < r.base + tt.tT0[r.k] * 1000 - 60000) return r;
  // Test spójności (domyka ostatnią minutę przed startem i chwilę po nim):
  // pojazd „jadący do” posRt minął już posRt−1, więc jego odjazd stamtąd nie może być w przyszłości,
  // a do posRt powinien dotrzeć w ciągu kilkunastu minut. Prawdziwe aktualizacje ZTM mieszczą się
  // w tych granicach z dużym zapasem (zmierzone na 15 tys. aktualizacji: max 14 s).
  // Kurs „10+ min przed czasem” w trasie to w danych ZTM pojazd przypisany do złego miejsca kursu
  // (np. stoi na pętli, a feed twierdzi, że jest 20 przystanków dalej) – nie wierzymy w „już minął”.
  if (posRt > 0 && upd.delay < -RT_MAX_IMPLAUSIBLE_EARLY) return r;
  if (posRt > 0 && r.base != null) {
    const p = tt.tP[r.k], t0 = r.base + tt.tT0[r.k] * 1000, d = upd.delay * 1000;
    if (t0 + tt.pD[p][posRt - 1] * 1000 + d > nowMs + 60000) return r;
    if (t0 + tt.arrOff(p, posRt) * 1000 + d - nowMs > 15 * 60000) return r;
  }
  r.live = true;
  const near = tt.stops[tt.pS[tt.tP[r.k]][posRt]];
  r.near = near ? near.name : null;
  const vp = rt.vpByTrip ? rt.vpByTrip.get(r.k) : null;
  if (vp) {
    const os = tt.stops[tt.pS[tt.tP[r.k]][r.pos]];
    r.vpDist = os ? Math.round(distM(vp.lat, vp.lon, os.lat, os.lon)) : null;
  }
  if (r.pos < posRt) {
    // GPS rozstrzyga: pojazd stoi przy naszym przystanku, choć numer przystanku już „przeskoczył”
    if (r.vpDist != null && r.vpDist <= VP_AT_STOP_M && Math.abs(r.dep - nowMs) < 20 * 60000) {
      r.delay = Math.max(0, Math.round((nowMs - r.dep) / 1000));
      r.pDep = Math.max(r.dep, nowMs);
      if (r.arr != null) r.pArr = r.arr + r.delay * 1000;
      r.atStop = true;
      return r;
    }
    r.gone = true; return r; // pojazd już minął nasz przystanek
  }
  let d = upd.delay;
  if (d < 0) d = posRt === 0 ? 0 : Math.max(d, -RT_MAX_EARLY);
  r.delay = d;
  r.pDep = r.dep + d * 1000;
  if (r.arr != null) r.pArr = r.arr + d * 1000;
  return r;
}
