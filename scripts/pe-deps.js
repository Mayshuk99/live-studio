// Which DLLs in a folder a Windows program needs (its imports, and theirs, found in that folder) — so the build
// copies only those next to Live Studio instead of a whole download.   node scripts/pe-deps.js <folder> <exe> [<exe> …]
'use strict';
const fs = require('fs'), path = require('path');

function imports(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt16LE(0) !== 0x5a4d) return [];
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) return [];
  const nsec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20), opt = pe + 24;
  const pe32plus = b.readUInt16LE(opt) === 0x20b;
  const dirs = opt + (pe32plus ? 112 : 96);
  const secs = opt + optSize;
  const off = rva => {
    for (let i = 0; i < nsec; i++) {
      const s = secs + i * 40, va = b.readUInt32LE(s + 12), vs = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw = b.readUInt32LE(s + 20);
      if (rva >= va && rva < va + vs) return rva - va + raw;
    }
    return -1;
  };
  const cstr = o => { let e = o; while (e < b.length && b[e]) e++; return b.toString('latin1', o, e); };
  const names = new Set();
  // normal imports (directory 1) and delay-load imports (directory 13)
  for (const [d, size, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = b.readUInt32LE(dirs + d * 8);
    if (!rva) continue;
    let p = off(rva);
    if (p < 0) continue;
    for (; p + size <= b.length; p += size) {
      const n = b.readUInt32LE(p + nameAt);
      if (!n) break;
      const o = off(n);
      if (o > 0) names.add(cstr(o));
    }
  }
  return [...names];
}

function closure(dir, entries) {
  const have = new Map(fs.readdirSync(dir).map(f => [f.toLowerCase(), f]));
  const need = new Set(), todo = [...entries];
  while (todo.length) {
    const f = todo.pop();
    for (const d of imports(path.join(dir, f))) {
      const real = have.get(d.toLowerCase());
      if (real && !need.has(real)) { need.add(real); todo.push(real); }
    }
  }
  return [...need].sort();
}

if (require.main === module) {
  const [dir, ...exes] = process.argv.slice(2);
  for (const f of closure(dir, exes)) console.log(f);
}
module.exports = { imports, closure };
