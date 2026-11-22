// Build-time check: runs the bundled FFmpeg with exactly the options Live Studio uses for streaming and
// recording, so an FFmpeg change that rejects an option stops the build instead of reaching a live service.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { streamArgs, recordArgs } = require('../streamer.js');
const ff = process.argv[2] || 'ffmpeg';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-selftest-'));
const src = path.join(tmp, 'in.mkv');
const g = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60', '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
  '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libopus', '-f', 'matroska', '-y', src], { encoding: 'utf8' });
if (g.status !== 0) { console.error('could not make the test clip:\n' + g.stderr); process.exit(1); }
function run(name, args, out) {
  return new Promise(resolve => {
    const p = spawn(ff, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.stdin.on('error', () => {});
    fs.createReadStream(src).pipe(p.stdin);
    p.on('close', code => {
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      const ok = code === 0 && size > 10000;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  (exit ${code}, ${size} bytes)`);
      if (!ok) console.log(err.split(/\r?\n/).filter(l => !/^frame=/.test(l)).join('\n'));
      resolve(ok);
    });
  });
}
(async () => {
  const flv = path.join(tmp, 'stream.flv'), mp4 = path.join(tmp, 'rec.mp4'), mp4b = path.join(tmp, 'rec-copy.mp4');
  const r = [
    await run('stream (software encoder)', streamArgs({ encoder: 'x264', fps: 59.94, bitrate: 6000, audioBitrate: 198, url: flv }), flv),
    await run('record (re-encode)', recordArgs({ fps: 59.94, audioBitrate: 320 }, mp4), mp4),
    await run('record (copy picture)', recordArgs({ fps: 60, inputCodec: 'h264' }, mp4b), mp4b)
  ];
  process.exit(r.every(Boolean) ? 0 : 1);
})();
