import type { PrivacyLayer, Rect, RenderPlan } from '@zeyvola/project-model';
import { magnifierSampling, sourceToCanvas } from '@zeyvola/project-model';
import { createCursorSprite, type CursorSprite } from './cursor-sprite';
import { GLError, Program, RenderTarget, createTexture, hexToRgba, premul, type GL } from './gl';
import { BACKGROUND_FS, BLUR_FS, LAYER_FS, MAGNIFIER_FS, PRIVACY_FS, QUAD_VS, SHADOW_FS, SHAPE_FS } from './shaders';

export type FrameSource = TexImageSource;

export interface FrameSources {
  screen?: FrameSource | null;
  screenSize?: { width: number; height: number };
  camera?: FrameSource | null;
  cameraSize?: { width: number; height: number };
  backgroundImage?: FrameSource | null;
  backgroundImageSize?: { width: number; height: number };
}

export interface CompositorStats {
  lastRenderMs: number;
  maxTextureSize: number;
}

const MAX_FX_SIZE = 4096;

/**
 * Draws a RenderPlan with WebGL2. The same class renders the preview and every exported
 * frame, so what you see is what gets encoded.
 */
export class Compositor {
  readonly gl: GL;
  private quad: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;
  private layer: Program;
  private shadow: Program;
  private shape: Program;
  private bg: Program;
  private blur: Program;
  private privacy: Program;
  private magnifier: Program;
  private screenTex: WebGLTexture;
  private cameraTex: WebGLTexture;
  private bgTex: WebGLTexture;
  private bgTexKey: unknown = null;
  private fx: RenderTarget;
  private blurA: RenderTarget;
  private blurB: RenderTarget;
  private cursor: CursorSprite;
  private cursorTex: WebGLTexture;
  readonly stats: CompositorStats;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, opts: { preserveDrawingBuffer?: boolean } = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, premultipliedAlpha: true, depth: false, stencil: false,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false, powerPreference: 'high-performance',
    }) as GL | null;
    if (!gl) throw new GLError('WebGL2 kullanılamıyor');
    this.gl = gl;
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    if (!vao || !buf) throw new GLError('Tampon oluşturulamadı');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.quad = vao;
    this.quadBuf = buf;
    this.layer = new Program(gl, QUAD_VS, LAYER_FS);
    this.shadow = new Program(gl, QUAD_VS, SHADOW_FS);
    this.shape = new Program(gl, QUAD_VS, SHAPE_FS);
    this.bg = new Program(gl, QUAD_VS, BACKGROUND_FS);
    this.blur = new Program(gl, QUAD_VS, BLUR_FS);
    this.privacy = new Program(gl, QUAD_VS, PRIVACY_FS);
    this.magnifier = new Program(gl, QUAD_VS, MAGNIFIER_FS);
    this.screenTex = createTexture(gl);
    this.cameraTex = createTexture(gl);
    this.bgTex = createTexture(gl, gl.LINEAR_MIPMAP_LINEAR);
    this.fx = new RenderTarget(gl);
    this.blurA = new RenderTarget(gl);
    this.blurB = new RenderTarget(gl);
    this.cursor = createCursorSprite();
    this.cursorTex = createTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, this.cursorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.cursor.image);
    this.stats = { lastRenderMs: 0, maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number };
  }

  // ─── Low-level drawing ────────────────────────────────────────────────────

  private bindTarget(target: RenderTarget | null, width: number, height: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, width, height);
    return { size: [width, height] as const, flip: target ? 0 : 1 };
  }

  private draw(p: Program, rect: Rect, t: { size: readonly [number, number]; flip: number }) {
    p.set('uRect', [rect.x, rect.y, rect.w, rect.h]).set('uTarget', t.size).set('uFlipY', t.flip);
    this.gl.bindVertexArray(this.quad);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  private upload(tex: WebGLTexture, src: FrameSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  private drawShadow(t: { size: readonly [number, number]; flip: number }, rect: Rect, radius: number, exp: number, blur: number, opacity: number, offsetY = 0) {
    if (opacity <= 0.001) return;
    const pad = blur * 2 + 2;
    const r: Rect = { x: rect.x - pad, y: rect.y - pad + offsetY, w: rect.w + 2 * pad, h: rect.h + 2 * pad };
    this.shadow.use().set('uShape', [pad, pad, rect.w, rect.h]).set('uRadius', radius).set('uExp', exp)
      .set('uBlur', blur).set('uOpacity', opacity);
    this.draw(this.shadow, r, t);
  }

  // ─── Privacy (source space) ───────────────────────────────────────────────

  private applyPrivacy(layers: PrivacyLayer[], srcW: number, srcH: number, crop: Rect): WebGLTexture {
    const gl = this.gl;
    const scale = Math.min(1, MAX_FX_SIZE / Math.max(srcW, srcH));
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);
    this.fx.ensure(w, h);
    let t = this.bindTarget(this.fx, w, h);
    gl.disable(gl.BLEND);
    this.layer.use().set('uTex', 0).set('uUV', [0, 0, 1, 1]).set('uSize', [w, h]).set('uRadius', 0).set('uExp', 2)
      .set('uBorder', 0).set('uOpacity', 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.screenTex);
    this.draw(this.layer, { x: 0, y: 0, w, h }, t);

    // One shared blurred copy, sized to the strongest blur item on this frame.
    const needsBlur = layers.some((l) => l.effect.kind === 'blur');
    if (needsBlur) {
      let sigmaPx = 0;
      for (const l of layers) {
        if (l.effect.kind !== 'blur') continue;
        sigmaPx = Math.max(sigmaPx, l.region.h * crop.h * h * 0.35, l.effect.strength * 40 * scale);
      }
      const down = 4;
      const bw = Math.max(1, Math.round(w / down));
      const bh = Math.max(1, Math.round(h / down));
      this.blurA.ensure(bw, bh);
      this.blurB.ensure(bw, bh);
      let bt = this.bindTarget(this.blurA, bw, bh);
      this.layer.use().set('uSize', [bw, bh]);
      gl.bindTexture(gl.TEXTURE_2D, this.fx.tex);
      this.draw(this.layer, { x: 0, y: 0, w: bw, h: bh }, bt);
      const passes = Math.max(1, Math.min(6, Math.ceil(sigmaPx / down / 6)));
      const step = sigmaPx / down / passes / 1.5;
      for (let i = 0; i < passes; i++) {
        bt = this.bindTarget(this.blurB, bw, bh);
        this.blur.use().set('uTex', 0).set('uDir', [step / bw, 0]);
        gl.bindTexture(gl.TEXTURE_2D, this.blurA.tex);
        this.draw(this.blur, { x: 0, y: 0, w: bw, h: bh }, bt);
        bt = this.bindTarget(this.blurA, bw, bh);
        this.blur.use().set('uDir', [0, step / bh]);
        gl.bindTexture(gl.TEXTURE_2D, this.blurB.tex);
        this.draw(this.blur, { x: 0, y: 0, w: bw, h: bh }, bt);
      }
    }

    t = this.bindTarget(this.fx, w, h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.privacy.use().set('uSrc', 0).set('uBlur', 1).set('uSrcSize', [w, h]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.screenTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, needsBlur ? this.blurA.tex : this.screenTex);
    gl.activeTexture(gl.TEXTURE0);
    for (const l of layers) {
      // Regions are relative to the content crop; map them to texture pixels.
      const rx = (crop.x + l.region.x * crop.w) * w;
      const ry = (crop.y + l.region.y * crop.h) * h;
      const rw = l.region.w * crop.w * w;
      const rh = l.region.h * crop.h * h;
      if (rw < 0.5 || rh < 0.5) continue;
      const radius = l.cornerRadius * Math.min(rw, rh);
      // Grow the rounded shape so its corners still cover the whole drawn rectangle.
      const grow = radius * 0.3 + 1;
      const region: Rect = { x: rx - grow, y: ry - grow, w: rw + 2 * grow, h: rh + 2 * grow };
      const e = l.effect;
      const mode = e.kind === 'solid' ? 1 : e.kind === 'pixelate' ? 2 : e.kind === 'blur' ? 3 : 4;
      p.set('uMode', mode).set('uRegion', [region.x, region.y, region.w, region.h]).set('uRadius', radius)
        .set('uColor', premul(hexToRgba(e.kind === 'solid' ? e.color : '#000000')))
        .set('uBlock', e.kind === 'pixelate' ? Math.max(12 * scale, e.block * scale, rh / 6) : 16);
      // Frosted samples outside the region from the untouched source copy (TEXTURE0).
      this.draw(p, region, t);
    }
    return this.fx.tex!;
  }

  // ─── Frame ────────────────────────────────────────────────────────────────

  /**
   * Draws one frame. On a lost context WebGL silently does nothing, so callers that keep the
   * result (export, privacy stills) check `lost` afterwards and draw again on a new compositor.
   */
  render(plan: RenderPlan, src: FrameSources): void {
    if (this.disposed) throw new GLError('Derleyici kapatıldı');
    const t0 = performance.now();
    const gl = this.gl;
    const W = Math.max(1, Math.round(plan.width));
    const H = Math.max(1, Math.round(plan.height));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;

    // Upload sources first; privacy needs the screen texture.
    let screenTex: WebGLTexture | null = null;
    if (plan.screen && src.screen && src.screenSize) {
      this.upload(this.screenTex, src.screen);
      screenTex = plan.privacy.length > 0
        ? this.applyPrivacy(plan.privacy, src.screenSize.width, src.screenSize.height, plan.screen.crop)
        : this.screenTex;
    }
    if (plan.camera && src.camera) this.upload(this.cameraTex, src.camera);

    const t = this.bindTarget(null, W, H);
    gl.disable(gl.BLEND);
    this.drawBackground(plan, src, t);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);

    const sc = plan.screen;
    if (sc) {
      this.drawShadow(t, sc.frame, sc.radius, 2, sc.shadow.blur, sc.shadow.opacity, sc.shadow.offsetY);
      if (screenTex) {
        gl.bindTexture(gl.TEXTURE_2D, screenTex);
        const [br, bg, bb, ba] = premul(hexToRgba(sc.border.color));
        const uv = [sc.crop.x + sc.viewport.x * sc.crop.w, sc.crop.y + sc.viewport.y * sc.crop.h, sc.viewport.w * sc.crop.w, sc.viewport.h * sc.crop.h];
        this.layer.use().set('uTex', 0).set('uUV', uv)
          .set('uSize', [sc.frame.w, sc.frame.h]).set('uRadius', sc.radius).set('uExp', 2)
          .set('uBorder', sc.border.width).set('uBorderColor', [br, bg, bb, ba]).set('uOpacity', 1);
        this.draw(this.layer, sc.frame, t);
      } else {
        this.shape.use().set('uSize', [sc.frame.w, sc.frame.h]).set('uRadius', sc.radius).set('uColor', [0.08, 0.08, 0.1, 1]).set('uRing', 0);
        this.draw(this.shape, sc.frame, t);
      }
      // The lens reads the privacy-filtered texture, so it can never reveal a hidden area.
      if (screenTex) this.drawMagnifier(plan, screenTex, t);
      this.drawCursor(plan, t);
    }

    const cam = plan.camera;
    if (cam && src.camera) {
      this.drawShadow(t, cam.rect, cam.radius, cam.cornerExponent, cam.shadow.blur, cam.shadow.opacity * cam.opacity, cam.shadow.blur * 0.25);
      gl.bindTexture(gl.TEXTURE_2D, this.cameraTex);
      const crop = cam.crop;
      const uv = cam.mirror ? [crop.x + crop.w, crop.y, -crop.w, crop.h] : [crop.x, crop.y, crop.w, crop.h];
      const [br, bg, bb, ba] = premul(hexToRgba(cam.border.color));
      this.layer.use().set('uTex', 0).set('uUV', uv).set('uSize', [cam.rect.w, cam.rect.h]).set('uRadius', cam.radius)
        .set('uExp', cam.cornerExponent).set('uBorder', cam.border.width).set('uBorderColor', [br, bg, bb, ba]).set('uOpacity', cam.opacity);
      this.draw(this.layer, cam.rect, t);
    }
    this.stats.lastRenderMs = performance.now() - t0;
  }

  private drawBackground(plan: RenderPlan, src: FrameSources, t: { size: readonly [number, number]; flip: number }) {
    const b = plan.background;
    const p = this.bg.use().set('uSize', [plan.width, plan.height]);
    const c = (hex: string) => hexToRgba(hex).slice(0, 3);
    switch (b.kind) {
      case 'solid': p.set('uKind', 0).set('uC0', c(b.color)); break;
      case 'gradient': p.set('uKind', 1).set('uC0', c(b.from)).set('uC1', c(b.to)).set('uAngle', b.angle); break;
      case 'aurora':
        p.set('uKind', 2).set('uC0', c(b.colors[0])).set('uC1', c(b.colors[1])).set('uC2', c(b.colors[2]))
          .set('uC3', c(b.colors[3])).set('uSeed', b.seed).set('uGrain', b.grain);
        break;
      case 'image': {
        if (src.backgroundImage && src.backgroundImageSize) {
          const gl = this.gl;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
          if (this.bgTexKey !== src.backgroundImage) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.backgroundImage);
            gl.generateMipmap(gl.TEXTURE_2D);
            this.bgTexKey = src.backgroundImage;
          }
          p.set('uKind', 3).set('uTex', 0).set('uTexSize', [src.backgroundImageSize.width, src.backgroundImageSize.height])
            .set('uLod', Math.max(0, b.blur) * 6);
        } else p.set('uKind', 0).set('uC0', [0.09, 0.09, 0.11]);
        break;
      }
    }
    this.draw(p, { x: 0, y: 0, w: plan.width, h: plan.height }, t);
  }

  private drawMagnifier(plan: RenderPlan, tex: WebGLTexture, t: { size: readonly [number, number]; flip: number }) {
    const m = plan.magnifier;
    const sc = plan.screen;
    if (!m || !sc || m.opacity <= 0.01) return;
    const gl = this.gl;
    this.drawShadow(t, m.rect, m.radius, 2, m.shadow.blur, m.shadow.opacity * m.opacity, m.shadow.blur * 0.3);
    const { uv0, uvPerPx, bounds } = magnifierSampling(sc, m);
    const [br, bg, bb, ba] = premul(hexToRgba(m.border.color));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.magnifier.use().set('uTex', 0).set('uUV0', [uv0.x, uv0.y]).set('uUVPerPx', [uvPerPx.x, uvPerPx.y])
      .set('uBounds', [bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h])
      .set('uSize', [m.rect.w, m.rect.h]).set('uRadius', m.radius)
      .set('uBorder', m.border.width).set('uBorderColor', [br, bg, bb, ba]).set('uOpacity', m.opacity);
    this.draw(this.magnifier, m.rect, t);
  }

  private drawCursor(plan: RenderPlan, t: { size: readonly [number, number]; flip: number }) {
    const cur = plan.cursor;
    const sc = plan.screen;
    if (!cur || !sc || cur.opacity <= 0.01) return;
    const gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    // Scissor uses a bottom-left origin.
    gl.scissor(Math.floor(sc.frame.x), Math.floor(plan.height - sc.frame.y - sc.frame.h), Math.ceil(sc.frame.w), Math.ceil(sc.frame.h));
    const zoomBoost = Math.sqrt(sc.zoom);
    if (cur.click) {
      const c = sourceToCanvas(plan, cur.click.position);
      if (c) {
        const k = cur.click.progress;
        const r = (8 + 26 * (1 - (1 - k) * (1 - k))) * plan.unit * zoomBoost;
        const alpha = (1 - k) * 0.55;
        const ring = cur.click.effect === 'ring' ? 3 * plan.unit : 0;
        this.shape.use().set('uSize', [2 * r, 2 * r]).set('uRadius', r).set('uRing', ring)
          .set('uColor', premul([1, 1, 1, alpha]));
        this.draw(this.shape, { x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r }, t);
      }
    }
    const p = sourceToCanvas(plan, cur.position);
    if (p) {
      const hgt = 30 * plan.unit * cur.scale * zoomBoost;
      const wid = hgt * (this.cursor.width / this.cursor.height);
      const x = p.x - this.cursor.hotspot.x * wid;
      const y = p.y - this.cursor.hotspot.y * hgt;
      gl.bindTexture(gl.TEXTURE_2D, this.cursorTex);
      this.layer.use().set('uTex', 0).set('uUV', [0, 0, 1, 1]).set('uSize', [wid, hgt]).set('uRadius', 0).set('uExp', 2)
        .set('uBorder', 0).set('uOpacity', cur.opacity);
      this.draw(this.layer, { x, y, w: wid, h: hgt }, t);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /** True once the browser has taken the WebGL context away (or dispose() gave it back). */
  get lost(): boolean {
    return this.disposed || this.gl.isContextLost();
  }

  private disposed = false;

  /**
   * Frees the GPU objects and gives the WebGL context back to the browser at once. Chromium
   * keeps only a limited number of contexts per page and drops the oldest beyond that, so a
   * compositor that is merely forgotten can cost a running preview or export its context.
   * The canvas cannot be drawn to again; a new compositor needs a new canvas.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const p of [this.layer, this.shadow, this.shape, this.bg, this.blur, this.privacy, this.magnifier]) p.dispose();
    for (const tex of [this.screenTex, this.cameraTex, this.bgTex, this.cursorTex]) gl.deleteTexture(tex);
    gl.deleteVertexArray(this.quad);
    gl.deleteBuffer(this.quadBuf);
    this.fx.dispose();
    this.blurA.dispose();
    this.blurB.dispose();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    // Release the drawing buffer as well.
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}
