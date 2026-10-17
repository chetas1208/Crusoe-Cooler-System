// Attribute minified bytes of every JS chunk to source packages using its sourcemap (build with `vite build --sourcemap`).
//   node scripts/mobile/bundle-report.mjs <distDir>   -> JSON on stdout + table on stderr
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dist = process.argv[2];
const B64 = Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));
function vlq(seg) { const out = []; let shift = 0, val = 0; for (const ch of seg) { const d = B64[ch]; val += (d & 31) << shift; if (d & 32) shift += 5; else { out.push(val & 1 ? -(val >> 1) : val >> 1); shift = 0; val = 0; } } return out; }
function pkgOf(src) {
  const m = src.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
  if (m) return m[1];
  if (/packages\/scene/.test(src)) return '@loopkeeper/scene';
  if (/packages\/core/.test(src)) return '@loopkeeper/core';
  if (/apps\/web\/src\/(tabs|features)\/([^/]+)/.test(src)) return 'app:' + src.match(/apps\/web\/src\/(?:tabs|features)\/([^/]+)/)[1];
  if (/apps\/web/.test(src) || /^\.\.\/src/.test(src) || /src\//.test(src)) return 'app:shell';
  return 'other';
}
const report = {};
for (const f of fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'))) {
  const code = fs.readFileSync(path.join(dist, 'assets', f), 'utf8');
  const mapFile = path.join(dist, 'assets', f + '.map');
  const gz = zlib.gzipSync(code).length;
  const entry = { raw: Buffer.byteLength(code), gzip: gz, pkgs: {} };
  if (fs.existsSync(mapFile)) {
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const lines = code.split('\n');
    let src = 0, sl = 0, sc = 0;
    const segs = [];
    map.mappings.split(';').forEach((line, li) => { let gc = 0; for (const s of line.split(',')) { if (!s) continue; const v = vlq(s); gc += v[0]; if (v.length >= 4) { src += v[1]; sl += v[2]; sc += v[3]; segs.push([li, gc, src]); } else segs.push([li, gc, -1]); } });
    for (let i = 0; i < segs.length; i++) {
      const [li, col, s] = segs[i]; const nxt = segs[i + 1];
      const end = nxt && nxt[0] === li ? nxt[1] : (lines[li]?.length ?? col);
      const len = Math.max(0, end - col) + (nxt && nxt[0] !== li ? 1 : 0);
      const p = s >= 0 ? pkgOf(map.sources[s]) : 'unmapped';
      entry.pkgs[p] = (entry.pkgs[p] ?? 0) + len;
    }
  }
  report[f] = entry;
}
console.log(JSON.stringify(report, null, 1));
const tot = {};
for (const e of Object.values(report)) for (const [k, v] of Object.entries(e.pkgs)) tot[k] = (tot[k] ?? 0) + v;
console.error([...Object.entries(tot)].sort((a, b) => b[1] - a[1]).slice(0, 22).map(([k, v]) => `${(v / 1024).toFixed(0).padStart(7)} KB  ${k}`).join('\n'));
