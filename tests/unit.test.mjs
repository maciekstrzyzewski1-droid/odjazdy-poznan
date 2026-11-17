// Testy jednostkowe bez sieci: CSV, ZIP, czas (DST), protobuf GTFS-RT, logika wyboru opcji.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseCsv, timeToSecs } from '../scripts/lib/csv.mjs';
import { readZip } from '../scripts/lib/zip.mjs';
import {
  serviceBase, warsawYmd, fmtHM, ymdAdd, warsawOffsetMin, normalize, decodeTripUpdates, applyRt, dedupeTrips, markWorse, distM,
} from '../app/engine.js';

test('CSV: cudzysłowy, przecinki, "" i BOM, CRLF', () => {
  const { header, rows } = parseCsv('﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,,"multi\nline"\n');
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.deepEqual(rows, [['1', 'x, y', 'he said "hi"'], ['2', '', 'multi\nline']]);
});
test('CSV: tryb strumieniowy', () => {
  const got = [];
  parseCsv('h1,h2\n1,2\n3,4', (r) => got.push(r));
  assert.deepEqual(got, [['1', '2'], ['3', '4']]);
});
test('timeToSecs: godziny ≥ 24', () => {
  assert.equal(timeToSecs('25:13:07'), 25 * 3600 + 13 * 60 + 7);
  assert.equal(timeToSecs(' 7:05:00'), 7 * 3600 + 300);
  assert.equal(timeToSecs(''), null);
});

// minimalny zapis ZIP do testu czytnika
function makeZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, content, deflate] of files) {
    const data = Buffer.from(content);
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
test('ZIP: stored i deflate', () => {
  const z = readZip(makeZip([['a.txt', 'zażółć', false], ['b.txt', 'x'.repeat(5000), true]]));
  assert.deepEqual(z.names, ['a.txt', 'b.txt']);
  assert.equal(z.read('a.txt').toString(), 'zażółć');
  assert.equal(z.read('b.txt').toString().length, 5000);
  assert.throws(() => z.read('c.txt'));
});

test('czas: serviceBase = południe − 12 h (także przy zmianie czasu)', () => {
  assert.equal(new Date(serviceBase('20261117')).toISOString(), '2026-11-16T23:00:00.000Z'); // zima
  assert.equal(new Date(serviceBase('20260715')).toISOString(), '2026-07-14T22:00:00.000Z'); // lato
  // 29.03.2026: w południe obowiązuje już czas letni -> 10:00Z - 12h
  assert.equal(new Date(serviceBase('20260329')).toISOString(), '2026-03-28T22:00:00.000Z');
  // 25.10.2026: w południe czas zimowy -> 11:00Z - 12h
  assert.equal(new Date(serviceBase('20261025')).toISOString(), '2026-10-24T23:00:00.000Z');
  const t = serviceBase('20261117') + (7 * 3600 + 45 * 60) * 1000;
  assert.equal(fmtHM(t), '07:45');
  assert.equal(fmtHM(serviceBase('20261117') + 25 * 3600 * 1000), '01:00');
  assert.equal(warsawYmd(serviceBase('20261117') + 25 * 3600 * 1000), '20261118');
  assert.equal(warsawOffsetMin(Date.UTC(2026, 0, 1)), 60);
  assert.equal(warsawOffsetMin(Date.UTC(2026, 6, 1)), 120);
  assert.equal(ymdAdd('20261231', 1), '20270101');
  assert.equal(ymdAdd('20260301', -1), '20260228');
});

test('normalize: polskie znaki', () => {
  assert.equal(normalize('Św. Marcin'), 'sw marcin');
  assert.equal(normalize('Łazarz'), 'lazarz');
  assert.equal(normalize('Żegrze'), 'zegrze');
});
test('distM: ~111 km na stopień szerokości', () => {
  assert.ok(Math.abs(distM(52, 17, 53, 17) - 111195) < 50);
});

// ---- protobuf (koder testowy) ----
const varint = (n) => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
};
const fld = (f, w) => varint(f * 8 + w);
const vint = (f, n) => [...fld(f, 0), ...varint(n)];
const bytes = (f, arr) => [...fld(f, 2), ...varint(arr.length), ...arr];
const s = (f, str) => bytes(f, [...Buffer.from(str)]);
test('GTFS-RT: dekodowanie, ujemne opóźnienie, nieznane pola', () => {
  const stu = [...vint(1, 17), ...bytes(2, vint(1, -742)), ...vint(5, 0)];
  const tu = [...bytes(1, [...s(1, '1_123^N+'), ...s(5, '16')]), ...bytes(2, stu), ...bytes(3, [...s(1, '3001'), ...s(2, '16/3')]), ...vint(4, 1794910954)];
  const ent = [...s(1, 'e1'), ...bytes(3, tu), ...fld(9, 5), 1, 2, 3, 4, ...fld(10, 1), 1, 2, 3, 4, 5, 6, 7, 8];
  const hdr = [...s(1, '2.0'), ...vint(3, 1794910954)];
  const msg = new Uint8Array([...bytes(1, hdr), ...bytes(2, ent)]);
  const d = decodeTripUpdates(msg);
  assert.equal(d.ts, 1794910954);
  assert.deepEqual(d.updates.get('1_123^N+'), { seq: 17, delay: -742, vehicle: '3001', label: '16/3', ts: 1794910954 });
});

// ---- applyRt na sztucznym rozkładzie ----
function fakeTT() {
  return {
    tP: [0], tQ: [3], pSq: [null], pS: [[0, 1, 2, 3]], tT0: [0], pD: [[0, 3600, 3900, 4200]],
    arrOff(p, pos) { return this.pD[p][pos]; },
    stops: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
    seqToPos(k, seq) { return seq - this.tQ[k]; },
  };
}
test('applyRt: przesunięcie stop_sequence, minięty przystanek, przyspieszenie, błędne wartości', () => {
  const tt = fakeTT();
  const now = Date.UTC(2026, 10, 17, 10);
  const mk = (pos) => ({ k: 0, pos, base: now - 3600000, dep: now + 5 * 60000, arr: now + 15 * 60000 });
  const rt = (seq, delay) => ({ byTrip: new Map([[0, { seq, delay }]]) });
  let r = applyRt(tt, mk(2), rt(4, 120), now); // seq 4 -> pozycja 1 (q=3)
  assert.equal(r.live, true); assert.equal(r.gone, false); assert.equal(r.pDep, r.dep + 120000); assert.equal(r.near, 'B');
  r = applyRt(tt, mk(0), rt(4, 120), now);
  assert.equal(r.gone, true);
  r = applyRt(tt, mk(2), rt(4, -600), now);
  assert.equal(r.delay, -180);
  r = applyRt(tt, mk(2), rt(3, -600), now); // na pętli początkowej – nie odjedzie przed czasem
  assert.equal(r.delay, 0);
  r = applyRt(tt, mk(2), rt(4, 20834), now);
  assert.equal(r.live, false);
  r = applyRt(tt, { ...mk(2), dep: now + 6 * 3600000 }, rt(4, 60), now); // inny dzień tego samego kursu
  assert.equal(r.live, false);
});

test('dedupeTrips: jeden wiersz na kurs, najpóźniejsze możliwe wyjście', () => {
  const now = 1000000;
  const rows = [
    { k: 1, D: 'x', leave: now + 60000, walk: 300 },
    { k: 1, D: 'x', leave: now + 120000, walk: 400 },
    { k: 1, D: 'x', leave: now - 1, walk: 10 },
    { k: 2, D: 'x', leave: now + 5, walk: 1 },
  ];
  const out = dedupeTrips(rows, now);
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.k === 1).leave, now + 120000);
});
test('markWorse: najszybsza i wolniejsze opcje', () => {
  const now = 0, m = 60000;
  const a = { leave: 5 * m, door: 30 * m };   // wyjście 5, na miejscu 30
  const b = { leave: 8 * m, door: 22 * m };   // później wyjście, szybciej na miejscu -> a jest wolniejsza
  const c = { leave: 12 * m, door: 40 * m };
  markWorse([a, b, c], now);
  assert.equal(b.best, true);
  assert.equal(a.worse, b);
  assert.equal(c.worse, null);
});
