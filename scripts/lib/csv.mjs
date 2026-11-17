// Parser CSV zgodny z RFC 4180 (cudzysłowy, "" w polu, przecinki i nowe linie w polu, BOM, CRLF).
// Zwraca { header: string[], rows: string[][] } albo wywołuje onRow dla oszczędności pamięci.
export function parseCsv(text, onRow) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = onRow ? null : [];
  let header = null;
  let field = '';
  let row = [];
  let inQ = false;
  const n = text.length;
  let i = 0;
  const emit = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) {
      if (!header) header = row.map((h) => h.trim());
      else if (onRow) onRow(row);
      else rows.push(row);
    }
    row = [];
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (inQ) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      // szybkie kopiowanie do następnego cudzysłowu
      const j = text.indexOf('"', i);
      if (j < 0) { field += text.slice(i); i = n; continue; }
      field += text.slice(i, j); i = j; continue;
    }
    if (c === 34) { inQ = true; i++; continue; }
    if (c === 44) { row.push(field); field = ''; i++; continue; }
    if (c === 10 || c === 13) {
      emit();
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      i++; continue;
    }
    // szybkie kopiowanie zwykłego fragmentu
    let j = i + 1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 44 || d === 10 || d === 13 || d === 34) break;
      j++;
    }
    field += text.slice(i, j); i = j;
  }
  if (field !== '' || row.length) emit();
  return { header, rows };
}

export function indexer(header, required = []) {
  const idx = {};
  header.forEach((h, k) => { idx[h] = k; });
  for (const r of required) if (!(r in idx)) throw new Error(`Brak kolumny ${r}`);
  return idx;
}

// "25:13:00" -> sekundy od „południa minus 12 h” dnia kursowania
export function timeToSecs(t) {
  if (!t) return null;
  const m = /^\s*(\d+):(\d{2}):(\d{2})\s*$/.exec(t);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}
