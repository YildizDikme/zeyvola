#!/usr/bin/env node
// Stand-in for the macOS pointer helper in tests: same line protocol, watches nothing.
// Writes "ready", one click (down/up) and one scroll in one go (all written at uptime 1000.6 s,
// the events happened earlier), then waits for "stop". With --window <id> it also reports that
// window's bounds before "ready" and once more after it moved, as the real helper does.
const now = 1000.6;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const window = process.argv.includes('--window');
if (window) out({ type: 'window', at: 1000.1, now, gx: 100, gy: 50, w: 800, h: 600 });
out({ type: 'ready', now });
out({ e: 'd', b: 'l', at: 1000.25, now, gx: 300, gy: 200 });
out({ e: 'u', b: 'l', at: 1000.31, now, gx: 300, gy: 200 });
if (window) out({ type: 'window', at: 1000.4, now, gx: 150, gy: 50, w: 800, h: 600 });
out({ e: 's', dy: -3, at: 1000.5, now, gx: 310, gy: 210 });
process.stdin.on('data', (d) => { if (String(d).includes('stop')) process.exit(0); });
process.stdin.on('end', () => process.exit(0));
