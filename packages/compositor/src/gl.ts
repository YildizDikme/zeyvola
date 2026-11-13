export type GL = WebGL2RenderingContext;

export class GLError extends Error {}

export function compile(gl: GL, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new GLError('Shader oluşturulamadı');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new GLError(`Shader derleme hatası: ${log}`);
  }
  return sh;
}

type UniformValue = number | boolean | readonly number[] | Float32Array;

/** A linked program with cached uniform locations and a typed-by-value setter. */
export class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  private types = new Map<string, number>();

  constructor(private readonly gl: GL, vs: string, fs: string) {
    const p = gl.createProgram();
    if (!p) throw new GLError('Program oluşturulamadı');
    const v = compile(gl, gl.VERTEX_SHADER, vs);
    const f = compile(gl, gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new GLError(`Program bağlama hatası: ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      this.types.set(name, info.type);
      this.locs.set(name, gl.getUniformLocation(p, info.name));
    }
  }

  use(): this {
    this.gl.useProgram(this.prog);
    return this;
  }

  set(name: string, value: UniformValue): this {
    const loc = this.locs.get(name);
    if (loc === undefined || loc === null) return this;
    const gl = this.gl;
    const type = this.types.get(name);
    if (typeof value === 'boolean') value = value ? 1 : 0;
    if (typeof value === 'number') {
      if (type === gl.INT || type === gl.BOOL || type === gl.SAMPLER_2D) gl.uniform1i(loc, value);
      else gl.uniform1f(loc, value);
      return this;
    }
    const arr = value as ArrayLike<number>;
    switch (arr.length) {
      case 2: gl.uniform2f(loc, arr[0]!, arr[1]!); break;
      case 3: gl.uniform3f(loc, arr[0]!, arr[1]!, arr[2]!); break;
      case 4: gl.uniform4f(loc, arr[0]!, arr[1]!, arr[2]!, arr[3]!); break;
      default: gl.uniform1fv(loc, arr as Float32Array);
    }
    return this;
  }

  dispose(): void {
    this.gl.deleteProgram(this.prog);
  }
}

export interface Target {
  fbo: WebGLFramebuffer | null;
  tex: WebGLTexture | null;
  width: number;
  height: number;
}

export function createTexture(gl: GL, filter: number = gl.LINEAR): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new GLError('Doku oluşturulamadı');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  // Magnification only accepts NEAREST/LINEAR; mipmap modes apply to minification.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Offscreen render target that is (re)allocated only when its size changes. */
export class RenderTarget implements Target {
  fbo: WebGLFramebuffer | null = null;
  tex: WebGLTexture | null = null;
  width = 0;
  height = 0;

  constructor(private readonly gl: GL) {}

  ensure(width: number, height: number): this {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.fbo && w === this.width && h === this.height) return this;
    const gl = this.gl;
    this.dispose();
    this.tex = createTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new GLError('Framebuffer eksik');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.width = w;
    this.height = h;
    return this;
  }

  dispose(): void {
    if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
    if (this.tex) this.gl.deleteTexture(this.tex);
    this.fbo = null;
    this.tex = null;
    this.width = 0;
    this.height = 0;
  }
}

export function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0, alpha];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

/** Premultiplied RGBA. */
export function premul(c: [number, number, number, number]): [number, number, number, number] {
  return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
}
