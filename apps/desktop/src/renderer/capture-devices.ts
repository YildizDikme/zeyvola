/** Device helpers for the capture window: opening with retry and camera warm-up. */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a device; if another view still holds it, asks for it to be released and retries. */
export async function acquire(device: 'camera' | 'mic', onBusy: (device: 'camera' | 'mic') => Promise<void>, constraints: MediaStreamConstraints): Promise<MediaStream> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastError = e;
      const name = (e as DOMException).name;
      if (name !== 'NotReadableError' && name !== 'AbortError' && name !== 'TrackStartError') throw e;
      if (attempt === 0) await onBusy(device);
      await sleep(600);
    }
  }
  throw lastError;
}

/**
 * Waits until the camera delivers real frames and auto exposure has settled, so the
 * recording never starts on black or flickering frames. Gives up after `maxMs`.
 */
export async function warmUpCamera(stream: MediaStream, maxMs = 3000): Promise<number> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  const t0 = performance.now();
  let prev = -1;
  let stable = 0;
  let lit = false;
  while (performance.now() - t0 < maxMs) {
    await sleep(60);
    if (video.readyState < 2) continue;
    g.drawImage(video, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    const luma = sum / (32 * 18 * 255);
    if (luma > 0.035) lit = true;
    if (lit && prev >= 0 && Math.abs(luma - prev) < 0.012) {
      if (++stable >= 5) break;
    } else stable = 0;
    prev = luma;
  }
  video.pause();
  video.srcObject = null;
  return performance.now() - t0;
}

