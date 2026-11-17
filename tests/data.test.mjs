// Testy na prawdziwych danych (po `node scripts/build-data.mjs`). Bez danych – pomijane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Timetable, serviceBase, warsawYmd } from '../app/engine.js';

const metaPath = new URL('../app/data/meta.json', import.meta.url);
const have = fs.existsSync(metaPath);
const load = () => {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const tt = JSON.parse(fs.readFileSync(new URL(`../app/data/${meta.files.timetable}`, import.meta.url), 'utf8'));
  const ids = JSON.parse(fs.readFileSync(new URL(`../app/data/${meta.files.tripIds}`, import.meta.url), 'utf8'));
  return { meta, T: new Timetable(tt, meta), ids };
};

test('dane: spójność i rozmiar', { skip: !have && 'brak app/data' }, () => {
  const { meta, T, ids } = load();
  assert.ok(T.stops.length > 2000, 'za mało przystanków');
  assert.ok(T.routes.length > 100, 'za mało linii');
  assert.equal(ids.length, T.nTrips);
  assert.ok(meta.bytes.timetable < 8 * 1024 * 1024, 'dane rozkładu urosły podejrzanie');
  for (let p = 0; p < T.pS.length; p++) {
    assert.ok(T.pS[p].length >= 2);
    for (let i = 1; i < T.pD[p].length; i++) assert.ok(T.pD[p][i] >= T.pD[p][i - 1], `wzorzec ${p}: malejące czasy`);
  }
});

test('dane: odjazdy i połączenia w ruchliwym węźle', { skip: !have && 'brak app/data' }, () => {
  const { T } = load();
  const day = T.dates.find((d) => d > T.dates[0]) || T.dates[0];
  const g = T.groupByName.get('Rondo Kaponiera') || T.groups[0];
  const from = serviceBase(day) + 12 * 3600000, to = from + 30 * 60000;
  const deps = T.departures(g.stops.map((i) => ({ i, walk: 0 })), from, to);
  assert.ok(deps.length > 10, 'w południe powinno być wiele odjazdów');
  for (const d of deps) {
    assert.ok(d.dep >= from - 1000 && d.dep <= to + 1000, 'odjazd poza oknem');
    assert.ok(d.pos < T.pS[d.p].length - 1, 'odjazd z ostatniego przystanku');
    assert.notEqual(T.pickup(d.p, d.pos), 1);
  }
  const other = T.groupByName.get('Most Teatralny');
  if (other) {
    const conns = T.connections(g.stops.map((i) => ({ i, walk: 0 })), other.stops.map((i) => ({ i, walk: 0 })), from, to);
    assert.ok(conns.length > 0);
    for (const c of conns) {
      assert.ok(c.arr > c.dep, 'przyjazd przed odjazdem');
      assert.ok(c.arrPos > c.pos);
      assert.notEqual(T.dropoff(c.p, c.arrPos), 1);
    }
  }
});

test('dane: kursy nocne po północy należą do poprzedniego dnia kursowania', { skip: !have && 'brak app/data' }, () => {
  const { T } = load();
  const day = T.dates[2];
  const from = serviceBase(day) + 24 * 3600000 + 30 * 60000; // 00:30 dnia następnego
  const all = T.departures(T.stops.map((s) => ({ i: s.i, walk: 0 })), from, from + 60 * 60000);
  assert.ok(all.some((d) => d.D === day), 'brak kursów z czasem ≥ 24:00 poprzedniego dnia');
  assert.ok(all.every((d) => warsawYmd(d.dep) === warsawYmd(from) || d.dep >= from));
});

test('dane: obejmują dzień budowania', { skip: !have && 'brak app/data' }, () => {
  const { meta, T } = load();
  assert.ok(T.covers(meta.today), `rozkład nie obejmuje ${meta.today}`);
});
