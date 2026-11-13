// Enforces module boundaries: platform-independent packages may not import Electron or
// Node built-ins; pure packages may not touch the DOM either.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PURE = ['timing', 'project-model', 'zoom-engine'];
const BROWSER_OK = ['compositor', 'media-web', 'protocol'];
const errors = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

for (const pkg of [...PURE, ...BROWSER_OK]) {
  for (const file of walk(join('packages', pkg, 'src'))) {
    // Comments are ignored so prose like "time window." does not count as DOM use.
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports) {
      if (imp === 'electron' || imp.startsWith('node:') || ['fs', 'path', 'child_process', 'os'].includes(imp)) {
        errors.push(`${file}: '${imp}' içe aktarılamaz (platformdan bağımsız paket)`);
      }
    }
    if (PURE.includes(pkg) && /\b(document|window|navigator)\./.test(src)) {
      errors.push(`${file}: saf pakette DOM kullanımı`);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Modül sınırları: tamam');
