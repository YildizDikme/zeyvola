import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Writes a file atomically: temp file → fsync → rename. A crash leaves the old file intact. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

/** Resolves `rel` inside `root`, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, rel);
  const r = relative(base, full);
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return null;
  return full;
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) {
      try { total += (await stat(p)).size; } catch { /* vanished */ }
    }
  }
  return total;
}

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function removeQuiet(path: string): Promise<void> {
  try { await rm(path, { force: true, recursive: true }); } catch { /* ignore */ }
}

export { createReadStream };
