// Stand-in for `zeyvola-win.exe --encode-mp4 / --encode-probe` in mf-export.test.ts: speaks the
// same stdin/stdout protocol and writes the packets' data to the output file. FAKE_MF selects a
// failure: refuse (encoder set-up fails), die (crashes after the first packet), finalize.
import { appendFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_MF ?? 'ok';
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const [flag, out] = process.argv.slice(2);

if (flag === '--encode-probe') {
  if (mode === 'refuse') { say({ type: 'error', stage: 'video-encoder', hr: '0xc00d36b4' }); process.exit(1); }
  say({ type: 'done', frames: 2, profile: 'high' });
  process.exit(0);
}
if (mode === 'refuse') { say({ type: 'error', stage: 'video-encoder', hr: '0xc00d36b4' }); process.exit(1); }
writeFileSync(out, '');
say({ type: 'ready' });
let buf = Buffer.alloc(0);
let frames = 0;
let packets = 0;
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 24) {
    const kind = buf.readUInt32LE(0);
    const len = buf.readUInt32LE(4);
    if (buf.length < 24 + len) return;
    const data = buf.subarray(24, 24 + len);
    buf = buf.subarray(24 + len);
    if (kind === 3) {
      if (mode === 'finalize') { say({ type: 'error', stage: 'finalize', hr: '0x80004005' }); process.exit(1); }
      say({ type: 'done', frames });
      process.exit(0);
    }
    appendFileSync(out, data);
    if (kind === 1) frames++;
    if (++packets === 1 && mode === 'die') { say({ type: 'error', stage: 'video-write', hr: '0x8007000e' }); process.exit(1); }
  }
});
process.stdin.on('end', () => process.exit(2));
