// Testy regresyjne do błędów znalezionych w weryfikacji (sztuczny, mały rozkład).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timetable, serviceBase, applyRt, dedupeTrips, boardKeys, decodeTripUpdates } from '../app/engine.js';

// przystanki: 0 Alfa/01, 1 Alfa/02, 2 Beta, 3 Gamma, 4 Delta, 5 Epsilon
const tt = new Timetable({
  v: 1,
  dates: ['20261116', '20261117', '20261118'],
  stops: [['A1', 'Alfa', 'ALFA01', 52.4, 16.9, 'A'], ['A2', 'Alfa', 'ALFA02', 52.4001, 16.9001, 'A'],
    ['B', 'Beta', 'BETA01', 52.41, 16.91, 'A'], ['C', 'Gamma', 'GAMM01', 52.42, 16.92, 'A'],
    ['D', 'Delta', 'DELT01', 52.43, 16.93, 'A'], ['E', 'Epsilon', 'EPSI01', 52.44, 16.94, 'A']],
  routes: [['R1', '148', 3, '', '', 'MPK', {}], ['R2', '160', 3, '', '', 'MPK', {}], ['R3', '5', 0, '', '', 'MPK', {}]],
  headsigns: ['Delta', 'Epsilon'],
  services: [[0, 1, 2]],
  patterns: {
    s: [[0, 2, 3, 1, 4], [2, 3, 4], [0, 1, 5]],
    d: [[0, 120, 600, 1200, 1500], [0, 300, 600], [0, 60, 300]],
    a: [null, null, null],
    f: ['10004', null, null],
    sq: [null, null, null],
    start: [0, 1, 2, 3],
  },
  trips: { r: [0, 1, 2], h: [0, 0, 1], s: [0, 0, 0], t: [28800, 30600, 32400], n: ['', '', ''], w: [0, 0, 0], q: [0, 1, 0] },
}, {});
const at = (h, m) => serviceBase('20261117') + (h * 3600 + m * 60) * 1000;
const alfa = [{ i: 0, walk: 0 }, { i: 1, walk: 0 }];

test('kurs pętlowy: oba przejazdy przez zespół zostają (148 na lotnisko)', () => {
  const rows = tt.departures(alfa, at(7, 55), at(8, 30)).filter((r) => r.k === 0);
  assert.equal(rows.length, 2);
  const now = at(7, 55);
  for (const r of rows) { r.leave = r.dep; }
  const keys = boardKeys(tt, rows, new Set([0, 1]));
  const out = dedupeTrips(rows, now, (r) => keys.get(r));
  assert.deepEqual(out.map((r) => r.pos).sort(), [0, 3]);
});
test('dwa sąsiednie słupki zespołu: jeden wiersz', () => {
  const rows = tt.departures(alfa, at(8, 55), at(9, 30)).filter((r) => r.k === 2);
  assert.equal(rows.length, 2);
  for (const r of rows) r.leave = r.dep;
  const keys = boardKeys(tt, rows, new Set([0, 1]));
  const out = dedupeTrips(rows, at(8, 55), (r) => keys.get(r));
  assert.equal(out.length, 1);
});
test('filtr słupka przed zapytaniem: odjazd z wybranego słupka nie „przeskakuje”', () => {
  const rows = tt.departures([{ i: 0, walk: 0 }], at(8, 55), at(9, 30)).filter((r) => r.k === 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stop, 0);
});
test('seqToPos: kurs numerowany od 1, seq 0 = czeka na pętli', () => {
  assert.equal(tt.seqToPos(1, 0), 0);
  assert.equal(tt.seqToPos(1, 1), 0);
  assert.equal(tt.seqToPos(1, 3), 2);
});
test('applyRt: przed startem kursu dalszy seq nie ukrywa odjazdu z pętli', () => {
  const r = tt.departures([{ i: 2, walk: 0 }], at(8, 0), at(8, 40)).find((x) => x.k === 1);
  assert.ok(r);
  const rt = { byTrip: new Map([[1, { seq: 2, delay: -1200 }]]) };
  applyRt(tt, r, rt, at(8, 10));
  assert.equal(r.gone, false);
  assert.equal(r.live, false);
  const r2 = tt.departures([{ i: 2, walk: 0 }], at(8, 0), at(8, 40)).find((x) => x.k === 1);
  applyRt(tt, r2, { byTrip: new Map([[1, { seq: 3, delay: 0 }]]) }, at(8, 36));
  assert.equal(r2.gone, true, 'po starcie kursu pojazd za naszym przystankiem = odjechał');
});

const varint = (n) => { let v = BigInt.asUintN(64, BigInt(n)); const o = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const fld = (f, w) => varint(f * 8 + w);
const vint = (f, n) => [...fld(f, 0), ...varint(n)];
const bytes = (f, a) => [...fld(f, 2), ...varint(a.length), ...a];
const s = (f, x) => bytes(f, [...Buffer.from(x)]);
const ent = (id, seq, delay, ts, veh) => bytes(2, [...s(1, 'e'), ...bytes(3, [
  ...bytes(1, s(1, id)), ...bytes(2, [...vint(1, seq), ...bytes(2, vint(1, delay))]), ...bytes(3, s(1, veh)), ...vint(4, ts)])]);
test('GTFS-RT: przy powtórzonym trip_id wygrywa nowszy wpis', () => {
  const msg = new Uint8Array([...bytes(1, vint(3, 100)), ...ent('T', 4, -4, 953, '917'), ...ent('T', 1, 302, 948, '455')]);
  const u = decodeTripUpdates(msg).updates.get('T');
  assert.equal(u.vehicle, '917');
  assert.equal(u.delay, -4);
});
test('GTFS-RT: fałszywa długość pola nie zawiesza – błąd od razu', () => {
  const t0 = Date.now();
  assert.throws(() => decodeTripUpdates(new Uint8Array([0x12, 0xff, 0xff, 0xff, 0xff, 0x0f])));
  assert.throws(() => decodeTripUpdates(new Uint8Array([...Buffer.from('\n😀😀')])));
  assert.ok(Date.now() - t0 < 200);
});

test('krótka pętla (powrót < 10 min): jeden wiersz, długa (≥ 10 min): dwa', () => {
  const rows = tt.departures(alfa, at(7, 55), at(8, 30)).filter((r) => r.k === 0);
  for (const r of rows) r.leave = r.dep;
  // powrót po 20 min -> osobno; przy progu 30 min -> razem
  assert.equal(new Set(boardKeys(tt, rows, new Set([0, 1]), 10 * 60000).values()).size, 2);
  assert.equal(new Set(boardKeys(tt, rows, new Set([0, 1]), 30 * 60000).values()).size, 1);
});
test('applyRt: „widmo” w ostatniej minucie przed startem nie ukrywa odjazdu', () => {
  // kurs 148 startuje 08:00 z Alfa/01; o 07:59:30 ZTM twierdzi, że pojazd jedzie już do Delty (pos 4, 08:25)
  const r = tt.departures(alfa, at(7, 59), at(8, 5)).find((x) => x.k === 0 && x.pos === 0);
  assert.ok(r);
  applyRt(tt, r, { byTrip: new Map([[0, { seq: 4, delay: 0 }]]) }, at(7, 59) + 30000);
  assert.equal(r.gone, false);
  // spójna aktualizacja po starcie: o 08:21 pojazd jedzie do Delty (08:25) -> Alfa/01 minięta
  const r2 = tt.departures(alfa, at(7, 59), at(8, 5)).find((x) => x.k === 0 && x.pos === 0);
  applyRt(tt, r2, { byTrip: new Map([[0, { seq: 4, delay: 0 }]]) }, at(8, 21));
  assert.equal(r2.gone, true);
});
