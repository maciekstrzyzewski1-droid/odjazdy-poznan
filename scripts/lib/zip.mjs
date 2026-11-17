// Minimalny czytnik ZIP (bez zależności). Obsługuje metody 0 (stored) i 8 (deflate).
import { inflateRawSync } from 'node:zlib';

export function readZip(buf) {
  // End of Central Directory: sygnatura 0x06054b50, szukamy od końca (komentarz do 64 KB)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('To nie jest plik ZIP (brak EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Uszkodzony katalog ZIP');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, csize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`Brak pliku ${name} w ZIP`);
      const lp = e.localOff;
      if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error('Uszkodzony nagłówek lokalny ZIP');
      const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return inflateRawSync(data);
      throw new Error(`Nieobsługiwana metoda kompresji ${e.method}`);
    },
  };
}
