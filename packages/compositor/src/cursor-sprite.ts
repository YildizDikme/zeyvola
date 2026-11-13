export interface CursorSprite {
  image: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  /** Tip position as a fraction of the sprite size. */
  hotspot: { x: number; y: number };
}

/** Our own pointer artwork, drawn procedurally so no image asset is shipped. */
export function createCursorSprite(scale = 4): CursorSprite {
  const gw = 26;
  const gh = 34;
  const w = gw * scale;
  const h = gh * scale;
  const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return { image: canvas, width: w, height: h, hotspot: { x: 0, y: 0 } };
  ctx.scale(scale, scale);
  const path = new Path2D();
  path.moveTo(3, 3);
  path.lineTo(3, 25.5);
  path.lineTo(8.6, 20.4);
  path.lineTo(12.6, 29.4);
  path.lineTo(16.4, 27.8);
  path.lineTo(12.5, 19);
  path.lineTo(20.2, 19);
  path.closePath();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.32)';
  ctx.shadowBlur = 2.4;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#16171B';
  ctx.strokeStyle = '#16171B';
  ctx.lineWidth = 2.6;
  ctx.stroke(path);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#FFFFFF';
  ctx.fill(path);
  return { image: canvas, width: w, height: h, hotspot: { x: 3 / gw, y: 3 / gh } };
}
