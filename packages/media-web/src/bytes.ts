/** Growable big-endian byte writer used by the container writers. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; return this; }
  u16(v: number): this { this.ensure(2); this.view.setUint16(this.pos, v); this.pos += 2; return this; }
  i16(v: number): this { this.ensure(2); this.view.setInt16(this.pos, v); this.pos += 2; return this; }
  u24(v: number): this { this.ensure(3); this.view.setUint8(this.pos, (v >>> 16) & 255); this.view.setUint16(this.pos + 1, v & 0xffff); this.pos += 3; return this; }
  u32(v: number): this { this.ensure(4); this.view.setUint32(this.pos, v >>> 0); this.pos += 4; return this; }
  i32(v: number): this { this.ensure(4); this.view.setInt32(this.pos, v); this.pos += 4; return this; }
  u64(v: number): this {
    this.ensure(8);
    this.view.setUint32(this.pos, Math.floor(v / 2 ** 32));
    this.view.setUint32(this.pos + 4, v >>> 0);
    this.pos += 8;
    return this;
  }
  f32(v: number): this { this.ensure(4); this.view.setFloat32(this.pos, v); this.pos += 4; return this; }
  f64(v: number): this { this.ensure(8); this.view.setFloat64(this.pos, v); this.pos += 8; return this; }
  ascii(s: string): this { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0x7f); return this; }
  bytes(b: Uint8Array): this { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  zeros(n: number): this { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; return this; }

  /** Patches a 32-bit value at an earlier position. */
  setU32(at: number, v: number): void { this.view.setUint32(at, v >>> 0); }

  result(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

/** Writes an ISO-BMFF box; the size is filled in after the body. */
export function box(w: ByteWriter, type: string, body: (w: ByteWriter) => void): void {
  const start = w.pos;
  w.u32(0).ascii(type);
  body(w);
  w.setU32(start, w.pos - start);
}

export function fullBox(w: ByteWriter, type: string, version: number, flags: number, body: (w: ByteWriter) => void): void {
  box(w, type, (b) => {
    b.u8(version).u24(flags);
    body(b);
  });
}

export type Sink = (data: Uint8Array, position: number | null) => Promise<void>;
