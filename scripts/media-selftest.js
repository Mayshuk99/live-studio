// Build-time check of bringing files in (media-import.js): video / sound / pictures in formats the player cannot
// play are converted into ones it can; PDF pages become pictures; text files (TXT, RTF, DOCX, ODT) become slides;
// a PowerPoint file without PowerPoint or LibreOffice gives a clear message. Stops the build if anything fails.
//   node scripts/media-selftest.js <ffmpeg> <pdftoppm>
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');
const MI = require('../media-import');
const [ff, pdftoppm] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-media-')), out = path.join(dir, 'out');
let fails = 0;
const ok = (good, what) => { console.log(`${good ? 'OK  ' : 'FAIL'} ${what}`); if (!good) fails++; };
const mk = (name, args) => { const f = path.join(dir, name); const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args, f]); if (r.status !== 0) console.log(`(could not make ${name}: ${String(r.stderr).trim().slice(0, 200)})`); return f; };
// what FFmpeg reads back: codec names and size
const look = f => { const r = spawnSync(ff, ['-hide_banner', '-i', f]); return String(r.stderr); };

// a small PDF: pages of the given size (points), each filled with one colour
function pdf(file, pages) {
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const catalog = add(''), tree = add('');
  const kids = pages.map(([w, h, rgb]) => {
    const body = `${rgb.join(' ')} rg 0 0 ${w} ${h} re f`;
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${content} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let s = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  fs.writeFileSync(file, s, 'latin1');
  return file;
}
// a zip (for DOCX / ODT)
function zip(file, entries) {
  const parts = [], cd = []; let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data), nb = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nb, comp); cd.push(c, nb); off += 30 + nb.length + comp.length;
  }
  const cdb = Buffer.concat(cd), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, cdb, e]));
  return file;
}

(async () => {
  console.log('FFmpeg:', String(spawnSync(ff, ['-version']).stdout).split('\n')[0]);
  // --- video: AVI, WMV, MPEG-2 interlaced, MXF, FLV → H.264 MP4 (MPEG-2 deinterlaced)
  const vids = {
    'clip.avi': ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=r=48000', '-t', '2', '-c:v', 'mpeg4', '-c:a', 'mp3'],
    'clip.wmv': ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=r=44100', '-t', '2', '-c:v', 'wmv2', '-c:a', 'wmav2'],
    'clip.mpg': ['-f', 'lavfi', '-i', 'testsrc2=s=720x576:r=25', '-f', 'lavfi', '-i', 'sine=r=48000', '-t', '2', '-vf', 'tinterlace=interleave_top,fieldorder=tff', '-flags', '+ilme+ildct', '-c:v', 'mpeg2video', '-b:v', '6M', '-c:a', 'mp2'],
    'clip.mxf': ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25', '-f', 'lavfi', '-i', 'sine=r=48000', '-t', '2', '-c:v', 'mpeg2video', '-b:v', '20M', '-c:a', 'pcm_s16le'],
    'clip.flv': ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=r=44100', '-t', '2', '-c:v', 'flv1', '-c:a', 'mp3'],
    'prores.mov': ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=r=48000', '-t', '2', '-c:v', 'prores_ks', '-profile:v', '3', '-c:a', 'pcm_s24le']
  };
  for (const [n, a] of Object.entries(vids)) {
    const r = await MI.convertVideo(ff, mk(n, a), out);
    const t = r.path ? look(r.path) : '';
    ok(r.path && /Video: h264/.test(t) && /Audio: aac/.test(t) && !/top first|bottom first/.test(t), `video ${n} → ${r.path ? path.basename(r.path) : r.error}`);
  }
  const again = await MI.convertVideo(ff, path.join(dir, 'clip.avi'), out);
  ok(again.reused, 'the same file again: the copy made before is used');
  // --- sound: AIFF, WMA, AC-3 5.1, CAF, ALAC → FLAC stereo 48 kHz
  const auds = {
    'tone.aiff': ['-f', 'lavfi', '-i', 'sine=r=44100', '-t', '2', '-c:a', 'pcm_s16be'],
    'tone.wma': ['-f', 'lavfi', '-i', 'sine=r=44100', '-t', '2', '-c:a', 'wmav2'],
    'tone.ac3': ['-f', 'lavfi', '-i', 'sine=r=48000', '-t', '2', '-ac', '6', '-c:a', 'ac3'],
    'tone.caf': ['-f', 'lavfi', '-i', 'sine=r=44100', '-t', '2', '-c:a', 'pcm_s16le', '-f', 'caf'],
    'alac.m4a': ['-f', 'lavfi', '-i', 'sine=r=44100', '-t', '2', '-c:a', 'alac']
  };
  for (const [n, a] of Object.entries(auds)) {
    const r = await MI.convertAudio(ff, mk(n, a), out);
    const t = r.path ? look(r.path) : '';
    ok(r.path && /Audio: flac, 48000 Hz, stereo/.test(t), `sound ${n} → ${r.path ? path.basename(r.path) : r.error}`);
  }
  // --- pictures: TIFF, TGA, PCX, PPM, QOI, EXR, SGI, JPEG 2000, JPEG XL → PNG
  const pics = { 'p.tiff': [], 'p.tga': [], 'p.pcx': [], 'p.ppm': [], 'p.qoi': [], 'p.exr': ['-pix_fmt', 'gbrpf32le'], 'p.sgi': [], 'p.jp2': ['-c:v', 'libopenjpeg'], 'p.jxl': ['-c:v', 'libjxl'] };
  for (const [n, a] of Object.entries(pics)) {
    const src = mk(n, ['-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', ...a]);
    if (!fs.existsSync(src)) continue;
    const r = await MI.convertImage(ff, src, out);
    ok(r.path && /Video: png.*800x600/.test(look(r.path)), `picture ${n} → ${r.path ? path.basename(r.path) : r.error}`);
  }
  // Windows' own decoders (WIC): a JPEG XR picture, which FFmpeg cannot read
  if (process.platform === 'win32') {
    const png = mk('wic.png', ['-f', 'lavfi', '-i', 'testsrc2=s=640x480', '-frames:v', '1']), wdp = path.join(dir, 'wic.wdp');
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName PresentationCore; $d = [System.Windows.Media.Imaging.BitmapDecoder]::Create([Uri]'${png}', 'None', 'OnLoad'); $e = New-Object System.Windows.Media.Imaging.WmpBitmapEncoder; $e.Frames.Add($d.Frames[0]); $s = [IO.File]::Create('${wdp}'); $e.Save($s); $s.Close()`]);
    if (fs.existsSync(wdp)) { const r = await MI.convertImage(ff, wdp, out); ok(r.path && /png.*640x480/.test(look(r.path)), `picture wic.wdp (JPEG XR, through Windows) → ${r.path ? path.basename(r.path) : r.error}`); }
    else console.log('(could not make a JPEG XR picture here)');
  }
  // --- PDF: a 16:9 page and a portrait page → pictures, long side 1920
  const pr = await MI.importDoc({ pdftoppm }, pdf(path.join(dir, 'slides.pdf'), [[960, 540, [0.1, 0.2, 0.7]], [595, 842, [0.7, 0.1, 0.1]]]), out, () => {});
  ok(pr.pages && pr.pages.length === 2 && /1920x1080/.test(look(pr.pages[0])) && /x1920/.test(look(pr.pages[1])), `PDF → ${pr.pages ? pr.pages.length + ' pages' : pr.error}`);
  // --- text: UTF-8 / UTF-16 TXT, RTF (code page 1251 + \\u letters), DOCX, ODT, Markdown
  const B = String.fromCharCode(92);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'Слава Богу\nАминь\n\nВторая страница\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Привет\n\nМир', 'utf16le')]));
  fs.writeFileSync(path.join(dir, 'c.rtf'), `{${B}rtf1${B}ansi${B}ansicpg1251{${B}fonttbl{${B}f0 Arial;}}${B}f0 ${B}'cf${B}'f0${B}'e8${B}'e2${B}'e5${B}'f2 ${B}u1052?${B}u1080?${B}u1088?${B}par${B}par Page two${B}par}`, 'latin1');
  zip(path.join(dir, 'd.docx'), [['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Аллилуйя &amp; аминь</w:t></w:r></w:p><w:p/><w:p><w:r><w:t xml:space="preserve">Второй </w:t></w:r><w:r><w:t>куплет</w:t></w:r></w:p></w:body></w:document>']]);
  zip(path.join(dir, 'e.odt'), [['mimetype', 'application/vnd.oasis.opendocument.text'], ['content.xml', '<office:document-content><office:body><office:text><text:p>Строка<text:s/>один</text:p><text:p/><text:h>Глава</text:h></office:text></office:body></office:document-content>']]);
  fs.writeFileSync(path.join(dir, 'f.md'), '# Объявления\n\n**Молитва** в среду\n');
  const want = { 'a.txt': ['Слава Богу\nАминь', 'Вторая страница'], 'b.txt': ['Привет', 'Мир'], 'c.rtf': ['Привет Мир', 'Page two'], 'd.docx': ['Аллилуйя & аминь', 'Второй куплет'], 'e.odt': ['Строка один', 'Глава'], 'f.md': ['Объявления', 'Молитва в среду'] };
  for (const [n, w] of Object.entries(want)) {
    const r = await MI.importDoc({ pdftoppm }, path.join(dir, n), out);
    ok(JSON.stringify(r.text) === JSON.stringify(w), `text ${n} → ${JSON.stringify(r.text || r.error)}`);
  }
  // --- PowerPoint with neither PowerPoint nor LibreOffice here: a clear message, no hang
  zip(path.join(dir, 'g.pptx'), [['[Content_Types].xml', '<Types/>']]);
  const pp = await MI.importDoc({ pdftoppm }, path.join(dir, 'g.pptx'), out, () => {});
  ok(pp.pages || /PowerPoint or the free LibreOffice/.test(pp.error || ''), `PowerPoint → ${pp.pages ? pp.pages.length + ' pages' : pp.error}`);
  ok(/Keynote/.test((await MI.importDoc({ pdftoppm }, path.join(dir, 'x.key'), out)).error || ''), 'Keynote → advice to export to PDF');
  console.log(fails ? `MEDIA SELFTEST FAILED (${fails})` : 'MEDIA SELFTEST OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
