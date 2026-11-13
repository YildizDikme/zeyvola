// Version information (VS_VERSIONINFO) of a Windows executable: read it, and rewrite it in place so
// the packaged Zeyvola.exe names its own product and developer instead of Electron's.
//
// Layout from Microsoft's documentation of the PE resource directory and of VS_VERSIONINFO,
// VS_FIXEDFILEINFO, StringFileInfo, StringTable, String, VarFileInfo and Var: every block is
// wLength, wValueLength, wType, a UTF-16 key, padding to 32 bits, the value, padding, then its
// children, each starting on a 32-bit boundary. The new block is written over the old one and must
// not be larger, so nothing else in the file moves. Signed executables are refused: rewriting them
// would break the signature.

const FIXED_SIGNATURE = 0xfeef04bd;
const RT_VERSION = 16;
/** The strings Windows shows in a file's Properties › Details, in Microsoft's order. */
export const STRING_KEYS = ['CompanyName', 'FileDescription', 'FileVersion', 'InternalName', 'LegalCopyright', 'OriginalFilename', 'ProductName', 'ProductVersion'];

const align4 = (n) => (n + 3) & ~3;
const utf16z = (s) => Buffer.from(`${s}\0`, 'utf16le');

/** One block: header, key, value and children, laid out as Microsoft documents. */
function block(key, { value = Buffer.alloc(0), valueLength = value.length, text = false, children = [] } = {}) {
  const head = Buffer.alloc(6);
  const parts = [head, utf16z(key)];
  let len = 6 + parts[1].length;
  const pad = () => { const p = align4(len) - len; if (p) { parts.push(Buffer.alloc(p)); len += p; } };
  pad();
  if (value.length) { parts.push(value); len += value.length; }
  for (const c of children) { pad(); parts.push(c); len += c.length; }
  head.writeUInt16LE(len, 0);
  head.writeUInt16LE(valueLength, 2);
  head.writeUInt16LE(text ? 1 : 0, 4);
  return Buffer.concat(parts);
}

/** "0.1.0" or [0, 1, 0] → [major, minor, patch, build]. */
export function versionParts(v) {
  const p = (Array.isArray(v) ? v : String(v).split('.')).map((x) => Number.parseInt(String(x), 10) || 0);
  while (p.length < 4) p.push(0);
  return p.slice(0, 4).map((x) => Math.max(0, Math.min(0xffff, x)));
}

export function encodeVersionInfo({ fixed, fileVersion, productVersion, strings, tableKey = '040904b0', translation = [0x0409, 0x04b0] }) {
  const fv = versionParts(fileVersion);
  const pv = versionParts(productVersion);
  const f = Buffer.alloc(52);
  // Defaults: VS_FFI_STRUCVERSION, VS_FFI_FILEFLAGSMASK, VOS_NT_WINDOWS32, VFT_APP (Microsoft's VS_FIXEDFILEINFO values).
  const base = fixed ?? { strucVersion: 0x00010000, flagsMask: 0x3f, flags: 0, os: 0x00040004, type: 1, subtype: 0, dateMS: 0, dateLS: 0 };
  [FIXED_SIGNATURE, base.strucVersion, (fv[0] << 16) | fv[1], (fv[2] << 16) | fv[3], (pv[0] << 16) | pv[1], (pv[2] << 16) | pv[3],
    base.flagsMask, base.flags, base.os, base.type, base.subtype, base.dateMS, base.dateLS].forEach((x, i) => f.writeUInt32LE(x >>> 0, i * 4));
  const entries = STRING_KEYS.filter((k) => strings[k] != null && strings[k] !== '').map((k) => {
    const value = utf16z(strings[k]);
    return block(k, { value, valueLength: value.length / 2, text: true });
  });
  const table = block(tableKey, { text: true, children: entries });
  const translationValue = Buffer.alloc(4);
  translationValue.writeUInt16LE(translation[0], 0);
  translationValue.writeUInt16LE(translation[1], 2);
  return block('VS_VERSION_INFO', {
    value: f,
    children: [
      block('StringFileInfo', { text: true, children: [table] }),
      block('VarFileInfo', { text: true, children: [block('Translation', { value: translationValue })] }),
    ],
  });
}

function readBlock(buf, at) {
  const length = buf.readUInt16LE(at);
  const valueLength = buf.readUInt16LE(at + 2);
  const type = buf.readUInt16LE(at + 4);
  let p = at + 6;
  let end = p;
  while (end + 1 < buf.length && buf.readUInt16LE(end) !== 0) end += 2;
  const key = buf.toString('utf16le', p, end);
  p = align4(end + 2 - at) + at;
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  const value = buf.subarray(p, p + valueBytes);
  p = align4(p + valueBytes - at) + at;
  const children = [];
  while (p < at + length) {
    const c = readBlock(buf, p);
    children.push(c);
    p = align4(p + c.length - at) + at;
  }
  return { key, type, value, length, children };
}

export function decodeVersionInfo(buf) {
  const root = readBlock(buf, 0);
  if (root.key !== 'VS_VERSION_INFO' || root.value.readUInt32LE(0) !== FIXED_SIGNATURE) throw new Error('VS_VERSIONINFO değil');
  const d = (i) => root.value.readUInt32LE(i * 4);
  const ver = (ms, ls) => [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
  const out = {
    fileVersion: ver(d(2), d(3)),
    productVersion: ver(d(4), d(5)),
    fixed: { strucVersion: d(1), flagsMask: d(6), flags: d(7), os: d(8), type: d(9), subtype: d(10), dateMS: d(11), dateLS: d(12) },
    strings: {},
    tableKey: null,
    translation: null,
  };
  for (const c of root.children) {
    if (c.key === 'StringFileInfo') {
      const table = c.children[0];
      out.tableKey = table?.key ?? null;
      for (const s of table?.children ?? []) out.strings[s.key] = s.value.toString('utf16le').replace(/\0+$/, '');
    } else if (c.key === 'VarFileInfo') {
      const t = c.children.find((x) => x.key === 'Translation');
      if (t && t.value.length >= 4) out.translation = [t.value.readUInt16LE(0), t.value.readUInt16LE(2)];
    }
  }
  return out;
}

/** The RT_VERSION resources of a PE file: where each data entry and its bytes are. */
export function findVersionResources(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('PE dosyası değil');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error('PE imzası yok');
  const sections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const dir = (i) => ({ rva: buf.readUInt32LE(dirs + 8 * i), size: buf.readUInt32LE(dirs + 8 * i + 4) });
  const table = [];
  for (let i = 0; i < sections; i++) {
    const s = opt + optSize + 40 * i;
    table.push({ vsize: buf.readUInt32LE(s + 8), va: buf.readUInt32LE(s + 12), rsize: buf.readUInt32LE(s + 16), raw: buf.readUInt32LE(s + 20) });
  }
  const offset = (rva) => {
    const s = table.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rsize));
    if (!s) throw new Error(`RVA bölümde değil: ${rva}`);
    return rva - s.va + s.raw;
  };
  const res = dir(2);
  if (!res.rva) return { signed: dir(4).size > 0, entries: [] };
  const base = offset(res.rva);
  const list = (at) => {
    const n = buf.readUInt16LE(base + at + 12) + buf.readUInt16LE(base + at + 14);
    return Array.from({ length: n }, (_, k) => ({ id: buf.readUInt32LE(base + at + 16 + 8 * k), to: buf.readUInt32LE(base + at + 20 + 8 * k) }));
  };
  const entries = [];
  for (const type of list(0)) {
    if (type.id !== RT_VERSION || !(type.to & 0x80000000)) continue;
    for (const name of list(type.to & 0x7fffffff)) {
      if (!(name.to & 0x80000000)) continue;
      for (const lang of list(name.to & 0x7fffffff)) {
        const entry = base + lang.to;
        entries.push({ lang: lang.id, entry, offset: offset(buf.readUInt32LE(entry)), size: buf.readUInt32LE(entry + 4) });
      }
    }
  }
  return { signed: dir(4).size > 0, entries };
}

/** Rewrites every RT_VERSION resource of `buf` (in place). Returns what was written. */
export function setVersionInfo(buf, { fileVersion, productVersion, strings }) {
  const { signed, entries } = findVersionResources(buf);
  if (signed) throw new Error('İmzalı bir dosyanın sürüm bilgisi değiştirilmez (imza bozulur)');
  if (!entries.length) throw new Error('Dosyada sürüm bilgisi kaynağı yok');
  return entries.map((e) => {
    const old = decodeVersionInfo(buf.subarray(e.offset, e.offset + e.size));
    const next = encodeVersionInfo({ fixed: old.fixed, fileVersion, productVersion, strings, tableKey: old.tableKey ?? undefined, translation: old.translation ?? undefined });
    if (next.length > e.size) throw new Error(`Yeni sürüm bilgisi eskisinden büyük (${next.length} > ${e.size})`);
    buf.fill(0, e.offset, e.offset + e.size);
    next.copy(buf, e.offset);
    buf.writeUInt32LE(next.length, e.entry + 4);
    return { lang: e.lang, before: old.strings, size: next.length };
  });
}
