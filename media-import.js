'use strict';
/* Bringing any file into Live Studio.
   - Video, sound and pictures the built-in player (Chromium) plays are used as they are; everything else FFmpeg
     can read is converted once into a copy it does play (H.264 MP4, FLAC, PNG), kept in Live Studio's media folder
     and reused when the same file is added again. Pictures FFmpeg cannot read (iPhone HEIC on some files, camera
     RAW, JPEG XR) go through Windows' own picture decoders.
   - Documents become slides: PDF pages through Poppler (pdftoppm); PowerPoint through PowerPoint itself when it is
     installed, otherwise through LibreOffice (→ PDF); text (TXT, MD, RTF, DOCX, ODT) becomes text slides drawn by
     the window — this file only reads the text out. Keynote / Pages: Windows cannot open them — export to PDF. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const EXT = {
  video: ['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'mp2v', 'mpv', 'vob', 'ts', 'mts', 'm2ts', 'm2t', 'trp', 'tod', 'mod', 'mxf', '3gp', '3g2', 'ogv', 'dv', 'dif', 'divx', 'xvid', 'rm', 'rmvb', 'y4m', 'mjpg', 'mjpeg', 'h264', '264', 'h265', '265', 'hevc', 'wtv', 'dvr-ms', 'nut', 'amv', 'gxf', 'ivf', 'bik', 'vro', 'evo', 'nsv', 'smk', 'roq'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba', 'aif', 'aiff', 'aifc', 'caf', 'alac', 'wma', 'ac3', 'eac3', 'ec3', 'dts', 'amr', 'awb', 'mka', 'ape', 'wv', 'tta', 'au', 'snd', 'mp2', 'mpa', 'm4b', 'm4r', 'ra', 'ram', '3ga', 'voc', 'w64', 'rf64', 'spx', 'gsm', 'dsf', 'dff', 'tak', 'mpc', 'ofr'],
  image: ['png', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'heif', 'hif', 'tif', 'tiff', 'psd', 'tga', 'dds', 'exr', 'hdr', 'jp2', 'j2k', 'jpf', 'jpx', 'jpm', 'jxl', 'pcx', 'ppm', 'pgm', 'pbm', 'pnm', 'pam', 'sgi', 'rgb', 'qoi', 'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'raf', 'srw', 'pef', 'x3f', 'erf', 'kdc', 'dcr', 'mrw', '3fr', 'iiq', 'jxr', 'wdp', 'hdp', 'xbm', 'wbmp', 'cur'],
  doc: ['pdf', 'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm', 'odp', 'key', 'pages'],
  text: ['txt', 'text', 'md', 'markdown', 'rtf', 'docx', 'docm', 'odt']
};
// played by the built-in player as they are (others are converted; these too if they turn out not to play)
const DIRECT = {
  video: new Set(['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv']),
  audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba']),
  image: new Set(['png', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'cur'])
};
const extOf = p => (path.extname(p).slice(1) || '').toLowerCase();
function classify(p) {
  const e = extOf(p);
  for (const k of ['video', 'audio', 'image', 'doc', 'text']) if (EXT[k].includes(e)) return { kind: k, convert: !!DIRECT[k] && !DIRECT[k].has(e) };
  return { kind: 'video', convert: true }; // unknown: FFmpeg will try
}
const ALL_EXT = Object.values(EXT).flat();

/* the converted copy's name: the same file (path, size, date) always gives the same name, so it is reused */
function stampOf(src) {
  const st = fs.statSync(src);
  return crypto.createHash('sha1').update(`${path.resolve(src)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 8);
}
const baseOf = src => path.basename(src).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

function run(exe, args, { onLine, timeoutMs = 0, cwd } = {}) {
  return new Promise(resolve => {
    let out = '', err = '', killed = false;
    let p;
    try { p = spawn(exe, args, { windowsHide: true, cwd }); } catch (e) { resolve({ code: -1, out, err: e.message }); return; }
    const t = timeoutMs ? setTimeout(() => { killed = true; try { p.kill(); } catch (e) { /* gone */ } }, timeoutMs) : null;
    p.stdout.on('data', d => { const s = d.toString(); out += s; if (onLine) s.split(/\r?\n/).forEach(l => l && onLine(l, 'out')); });
    p.stderr.on('data', d => { const s = d.toString(); err = (err + s).slice(-20000); if (onLine) s.split(/[\r\n]+/).forEach(l => l && onLine(l, 'err')); });
    p.on('error', e => { if (t) clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    p.on('exit', code => { if (t) clearTimeout(t); resolve({ code: killed ? -2 : code, out, err }); });
  });
}
// PowerShell (Windows): the script is passed encoded, so paths with quotes or spaces need no care
const psQ = s => `'${String(s).replace(/'/g, "''")}'`;
const powershell = (script, opts) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], opts);

/* what FFmpeg says about a file: duration, interlacing, sound channels, picture size */
async function probe(ff, src) {
  const r = await run(ff, ['-hide_banner', '-i', src]);
  const t = r.err;
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(t);
  const v = /Stream #[^\n]*Video:([^\n]*)/.exec(t), a = /Stream #[^\n]*Audio:([^\n]*)/.exec(t);
  return {
    duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0,
    video: !!v, audio: !!a,
    interlaced: !!(v && /top first|bottom first|top coded first|bottom coded first/.test(v[1])),
    channels: a ? (/\bmono\b/.test(a[1]) ? 1 : /\bstereo\b/.test(a[1]) ? 2 : /(\d+)\s*channels|5\.1|7\.1|quad/.test(a[1]) ? 6 : 2) : 0,
    text: t
  };
}

/* video → H.264 MP4 (and AAC stereo sound), the same size and frame rate; interlaced video (DV, MPEG-2, AVCHD)
   is deinterlaced, very large pictures brought down to 4K */
async function convertVideo(ff, src, dir, onPct) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${baseOf(src)} (${stampOf(src)}).mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, reused: true };
  const info = await probe(ff, src);
  if (!info.video) return { error: 'There is no picture in this file.' };
  const vf = [...(info.interlaced ? ['bwdif=mode=send_frame'] : []), "scale='min(3840,iw)':'min(2160,ih)':force_original_aspect_ratio=decrease", 'scale=trunc(iw/2)*2:trunc(ih/2)*2', 'format=yuv420p'];
  const part = out.replace(/\.mp4$/, '.part.mp4');
  const r = await run(ff, ['-hide_banner', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf.join(','),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', part], { onLine: progressOf(info.duration, onPct) });
  if (r.code !== 0 || !fs.existsSync(part)) { try { fs.unlinkSync(part); } catch (e) { /* none */ } return { error: lastLine(r.err) || 'This file could not be converted.' }; }
  fs.renameSync(part, out);
  return { path: out };
}
/* sound → FLAC (no quality lost), stereo, 48 kHz */
async function convertAudio(ff, src, dir, onPct) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${baseOf(src)} (${stampOf(src)}).flac`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, reused: true };
  const info = await probe(ff, src);
  if (!info.audio) return { error: 'There is no sound in this file.' };
  const part = out.replace(/\.flac$/, '.part.flac');
  const r = await run(ff, ['-hide_banner', '-y', '-i', src, '-map', '0:a:0', '-vn', '-c:a', 'flac', '-ac', '2', '-ar', '48000', part], { onLine: progressOf(info.duration, onPct) });
  if (r.code !== 0 || !fs.existsSync(part)) { try { fs.unlinkSync(part); } catch (e) { /* none */ } return { error: lastLine(r.err) || 'This file could not be converted.' }; }
  fs.renameSync(part, out);
  return { path: out };
}
/* picture → PNG (at most 4K): FFmpeg first; then Windows' own decoders (WIC: HEIC/HEIF, camera RAW, JPEG XR) */
async function convertImage(ff, src, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${baseOf(src)} (${stampOf(src)}).png`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, reused: true };
  const r = await run(ff, ['-hide_banner', '-y', '-i', src, '-frames:v', '1', '-update', '1',
    '-vf', "scale='min(3840,iw)':'min(2160,ih)':force_original_aspect_ratio=decrease", out], { timeoutMs: 120000 });
  if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out };
  try { fs.unlinkSync(out); } catch (e) { /* none */ }
  if (process.platform === 'win32') {
    const w = await powershell(`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$d = [System.Windows.Media.Imaging.BitmapDecoder]::Create([Uri]${psQ(path.resolve(src))}, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
$f = $d.Frames[0]
$k = [Math]::Min(1.0, [Math]::Min(3840.0 / $f.PixelWidth, 2160.0 / $f.PixelHeight))
$src = $f
if ($k -lt 1.0) { $src = New-Object System.Windows.Media.Imaging.TransformedBitmap($f, (New-Object System.Windows.Media.ScaleTransform($k, $k))) }
$e = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
$e.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($src))
$s = [IO.File]::Create(${psQ(out)}); $e.Save($s); $s.Close()`, { timeoutMs: 120000 });
    if (w.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out };
    if (/heic|heif|hif/i.test(extOf(src))) return { error: 'This iPhone photo (HEIC) could not be opened. Install “HEIF Image Extensions” and “HEVC Video Extensions” from the Microsoft Store, or export it as JPEG.' };
    if (/^(cr2|cr3|crw|nef|nrw|arw|srf|sr2|orf|rw2|raf|srw|pef|x3f|erf|kdc|dcr|mrw|3fr|iiq|dng)$/i.test(extOf(src))) return { error: 'This camera RAW photo could not be opened. Install “Raw Image Extension” from the Microsoft Store, or export it as JPEG.' };
  }
  return { error: lastLine(r.err) || 'This picture could not be opened.' };
}
const lastLine = t => String(t || '').trim().split(/\r?\n/).filter(l => !/^\s*$/.test(l)).pop() || '';
function progressOf(dur, onPct) {
  let last = -1;
  return l => {
    if (!onPct || !dur) return;
    const tm = /time=\s*(\d+):(\d+):([\d.]+)/.exec(l);
    if (!tm) return;
    const pct = Math.min(99, Math.round(((+tm[1]) * 3600 + (+tm[2]) * 60 + (+tm[3])) / dur * 100));
    if (pct !== last) { last = pct; onPct(pct); }
  };
}

/* ---------- documents → slides ---------- */
async function pdfPages(pdftoppm, src, outDir, onPct) {
  fs.mkdirSync(outDir, { recursive: true });
  const done = listPages(outDir);
  if (done.length && fs.existsSync(path.join(outDir, '.complete'))) return { pages: done, reused: true };
  for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));
  // how many pages (for the progress): pdfinfo sits next to pdftoppm
  let total = 0;
  const info = path.join(path.dirname(pdftoppm), process.platform === 'win32' ? 'pdfinfo.exe' : 'pdfinfo');
  const pi = await run(fs.existsSync(info) ? info : 'pdfinfo', [src], { timeoutMs: 30000 });
  const m = /Pages:\s*(\d+)/.exec(pi.out || ''); if (m) total = +m[1];
  if (/Incorrect password|encrypted/i.test(pi.err || '')) return { error: 'This PDF is locked with a password — save it without one.' };
  const tick = setInterval(() => { if (total && onPct) onPct(Math.min(99, Math.round(listPages(outDir).length / total * 100))); }, 400);
  const r = await run(pdftoppm, ['-png', '-scale-to', '1920', src, path.join(outDir, 'page')], { timeoutMs: 30 * 60000 });
  clearInterval(tick);
  const pages = listPages(outDir);
  if (!pages.length) return { error: r.code === -1 ? 'The PDF reader is missing from this installation — update Live Studio.' : /password/i.test(r.err) ? 'This PDF is locked with a password — save it without one.' : (lastLine(r.err) || 'This PDF could not be opened.') };
  fs.writeFileSync(path.join(outDir, '.complete'), String(pages.length));
  return { pages };
}
function listPages(dir) {
  try {
    return fs.readdirSync(dir).filter(f => /^page-\d+\.png$/i.test(f))
      .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).map(f => path.join(dir, f));
  } catch (e) { return []; }
}
function sofficePath() {
  if (process.platform !== 'win32') return 'soffice';
  for (const b of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']) {
    if (!b) continue;
    const p = path.join(b, 'LibreOffice', 'program', 'soffice.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
/* PowerPoint (and OpenDocument presentations): PowerPoint draws every slide when it is installed; otherwise
   LibreOffice turns the file into a PDF first. Hidden slides are left out. */
async function slidePages(tools, src, outDir, onPct, onStage) {
  fs.mkdirSync(outDir, { recursive: true });
  const done = listPages(outDir);
  if (done.length && fs.existsSync(path.join(outDir, '.complete'))) return { pages: done, reused: true };
  for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));
  const why = [];
  if (process.platform === 'win32' && !/\.odp$/i.test(src)) {
    if (onStage) onStage('PowerPoint');
    const r = await powershell(`$ErrorActionPreference = 'Stop'
$pp = New-Object -ComObject PowerPoint.Application
$had = $pp.Presentations.Count
$pres = $pp.Presentations.Open(${psQ(path.resolve(src))}, -1, 0, 0)
try {
  $sw = $pres.PageSetup.SlideWidth; $sh = $pres.PageSetup.SlideHeight
  $k = [Math]::Min(1920 / $sw, 1080 / $sh); $w = [int]($sw * $k); $h = [int]($sh * $k)
  $total = $pres.Slides.Count; $n = 0; $i = 0
  foreach ($s in $pres.Slides) {
    $i++
    if ($s.SlideShowTransition.Hidden -eq -1) { continue }
    $n++
    $s.Export((Join-Path ${psQ(path.resolve(outDir))} ('page-{0:D3}.png' -f $n)), 'PNG', $w, $h)
    [Console]::Out.WriteLine("SLIDE $i $total")
  }
} finally {
  $pres.Close()
  if ($had -eq 0) { $pp.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($pp)
}`, { timeoutMs: 20 * 60000, onLine: l => { const m = /^SLIDE (\d+) (\d+)/.exec(l); if (m && onPct) onPct(Math.min(99, Math.round(+m[1] / +m[2] * 100))); } });
    const pages = listPages(outDir);
    if (r.code === 0 && pages.length) { fs.writeFileSync(path.join(outDir, '.complete'), String(pages.length)); return { pages }; }
    why.push(/80040154|COM class factory|class not registered/i.test(r.err) ? 'PowerPoint is not installed' : `PowerPoint: ${lastLine(r.err)}`);
  }
  const so = sofficePath();
  if (so) {
    if (onStage) onStage('LibreOffice');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ls-slides-'));
    const prof = path.join(tmp, 'profile').replace(/\\/g, '/');
    const r = await run(so, [`-env:UserInstallation=file:///${prof.replace(/^\//, '')}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp, src], { timeoutMs: 20 * 60000 });
    const pdf = fs.readdirSync(tmp).find(f => /\.pdf$/i.test(f));
    if (pdf) {
      if (onStage) onStage('PDF');
      const res = await pdfPages(tools.pdftoppm, path.join(tmp, pdf), outDir, onPct);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* busy */ }
      return res;
    }
    why.push(`LibreOffice: ${lastLine(r.err) || 'could not convert'}`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* busy */ }
  } else why.push('LibreOffice is not installed');
  return { error: `PowerPoint files are opened with PowerPoint or the free LibreOffice — install one of them, or save the presentation as PDF. (${why.join('; ')})` };
}

/* ---------- text: TXT / MD / RTF / DOCX / ODT → the words, page by page ---------- */
function unzip(buf, want) {
  let i = buf.length - 22;
  const stop = Math.max(0, buf.length - 65557);
  while (i >= stop && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < stop) throw new Error('not a zip file');
  const n = buf.readUInt16LE(i + 10); let p = buf.readUInt32LE(i + 16);
  const out = new Map();
  for (let k = 0; k < n && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!want(name)) continue;
    const d0 = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28), data = buf.subarray(d0, d0 + csize);
    out.set(name, method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null);
  }
  return out;
}
const xmlText = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
function docxLines(buf) {
  const files = unzip(buf, n => n === 'word/document.xml');
  const x = files.get('word/document.xml');
  if (!x) throw new Error('no text in this Word file');
  const xml = x.toString('utf8'), lines = [];
  for (const m of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = m[0].replace(/<w:tab\/>/g, '\t').replace(/<w:(br|cr)\b[^>]*\/>/g, '\n');
    const t = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|\t|\n/g)].map(r => r[1] !== undefined ? xmlText(r[1]) : r[0]).join('');
    lines.push(...t.split('\n'));
  }
  return lines;
}
function odtLines(buf) {
  const files = unzip(buf, n => n === 'content.xml');
  const x = files.get('content.xml');
  if (!x) throw new Error('no text in this document');
  const xml = x.toString('utf8').replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (m, c) => ' '.repeat(+c || 1)).replace(/<text:tab\s*\/>/g, '\t').replace(/<text:line-break\s*\/>/g, '\n');
  const lines = [];
  for (const m of xml.matchAll(/<text:(p|h)\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:\1>)/g)) lines.push(...xmlText((m[2] || '').replace(/<[^>]+>/g, '')).split('\n'));
  return lines;
}
// RTF: the words with their own code page (\ansicpg1251 for Russian), \uN letters, paragraphs; no fonts / tables
function rtfLines(buf) {
  const s = buf.toString('latin1');
  const cp = (/\\ansicpg(\d+)/.exec(s) || [])[1] || '1252';
  let dec; try { dec = new TextDecoder(`windows-${cp}`); } catch (e) { dec = new TextDecoder('windows-1252'); }
  let out = '', i = 0, uc = 1, skip = 0; const stack = []; let ignore = false; let bytes = [];
  const flush = () => { if (bytes.length) { out += dec.decode(Uint8Array.from(bytes)); bytes = []; } };
  const SKIP_DEST = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|themedata|colorschememapping|latentstyles|datastore|fldinst)$/;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') { flush(); stack.push({ ignore, uc }); i++; if (s.startsWith('\\*', i)) ignore = true; continue; }
    if (c === '}') { flush(); const t = stack.pop() || { ignore: false, uc: 1 }; ignore = t.ignore; uc = t.uc; i++; continue; }
    if (c === '\\') {
      const n = s[i + 1];
      if (n === "'") { if (!ignore) { if (skip > 0) skip--; else bytes.push(parseInt(s.substr(i + 2, 2), 16)); } i += 4; continue; }
      if (n === '\\' || n === '{' || n === '}') { if (!ignore) { flush(); out += n; } i += 2; continue; }
      const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(s.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      const w = m[1], arg = m[2];
      i += m[0].length;
      if (SKIP_DEST.test(w)) { ignore = true; continue; }
      if (ignore) continue;
      flush();
      if (w === 'par' || w === 'line' || w === 'sect' || w === 'page') out += '\n';
      else if (w === 'tab') out += '\t';
      else if (w === 'uc') uc = +arg || 0;
      else if (w === 'u') { let cpnt = +arg; if (cpnt < 0) cpnt += 65536; out += String.fromCharCode(cpnt); skip = uc; }
      else if (w === 'emdash') out += '—'; else if (w === 'endash') out += '–'; else if (w === 'bullet') out += '•';
      else if (w === 'lquote') out += '‘'; else if (w === 'rquote') out += '’'; else if (w === 'ldblquote') out += '“'; else if (w === 'rdblquote') out += '”';
      continue;
    }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (!ignore) { if (skip > 0) skip--; else { flush(); out += c; } }
    i++;
  }
  flush();
  return out.split('\n');
}
// plain text: UTF-8 / UTF-16 with or without a mark; otherwise Windows Cyrillic (1251), the usual for Russian files
function plainText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1251').decode(buf); }
}
const mdPlain = t => t.replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+/gm, '• ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2').replace(/^>\s?/gm, '');
/* the words split into slides: every part between empty lines is a slide (verses, announcements); a part longer
   than 10 lines is cut into slides of 10 lines */
function textPages(lines) {
  const pages = []; let cur = [];
  const push = () => { while (cur.length) { pages.push(cur.slice(0, 10).join('\n')); cur = cur.slice(10); } };
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (!l.trim()) push(); else cur.push(l);
  }
  push();
  return pages;
}
function readText(src) {
  const buf = fs.readFileSync(src), e = extOf(src);
  let lines;
  if (e === 'docx' || e === 'docm') lines = docxLines(buf);
  else if (e === 'odt') lines = odtLines(buf);
  else if (e === 'rtf') lines = rtfLines(buf);
  else { const t = plainText(buf); lines = (e === 'md' || e === 'markdown' ? mdPlain(t) : t).split(/\r?\n/); }
  const pages = textPages(lines);
  return pages.length ? { text: pages } : { error: 'There is no text in this file.' };
}

/* one entry for the window: any document → { pages: [png …] } or { text: [slide …] } or { error } */
async function importDoc(tools, src, mediaDir, onProgress) {
  const e = extOf(src), say = (pct, stage) => onProgress && onProgress({ percent: pct, stage });
  try {
    if (EXT.text.includes(e)) return readText(src);
    if (e === 'key') return { error: 'Keynote files cannot be opened on Windows. In Keynote: File → Export To → PDF (or PowerPoint), then add that file.' };
    if (e === 'pages') return { error: 'Pages files cannot be opened on Windows. In Pages: File → Export To → PDF (or Word), then add that file.' };
    const outDir = path.join(mediaDir, `${baseOf(src)} (${stampOf(src)}) slides`);
    if (e === 'pdf') { say(0, 'PDF'); return await pdfPages(tools.pdftoppm, src, outDir, p => say(p, 'PDF')); }
    let stage = 'PowerPoint';
    return await slidePages(tools, src, outDir, p => say(p, stage), s => { stage = s; say(0, s); });
  } catch (err) { return { error: err.message }; }
}

module.exports = { EXT, ALL_EXT, classify, convertVideo, convertAudio, convertImage, importDoc, readText, textPages, rtfLines, docxLines, odtLines, plainText, unzip, probe, listPages };
