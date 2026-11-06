// Kiểm thử nguồn nhạc trực tiếp (trang web, app khác) trên Electron thật.
// Tách khỏi run.cjs vì cờ mic giả của Chromium thay luôn cả nguồn bắt màn hình bằng file
// giả, khiến mọi phép đo ở đây trở nên vô nghĩa. Mic được thay bằng nốt tổng hợp 220 Hz
// ngay trong trang, nên không đụng mic thật. Phần "App khác" phát tiếng thật ra loa
// khoảng 10 giây và cần máy đang im lặng.
// Chạy: npm run test:e2e

process.env.VOKARA_E2E = '1';

const { app, webContents } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });
// Hồ sơ mới mỗi lần chạy, để kết quả không phụ thuộc cài đặt đã lưu từ lần trước.
const PROFILE = path.join(OUT, 'profile-live');
fs.rmSync(PROFILE, { recursive: true, force: true });
app.setPath('userData', PROFILE);

const SR = 48000;

/** Hợp âm G D Em C lặp lại, stereo-mono như nhau. */
function writeChordWav(file, seconds) {
  const n = seconds * SR;
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  const bars = [[55, 59, 62], [62, 66, 69], [64, 67, 71], [60, 64, 67]];
  for (let i = 0; i < n; i++) {
    const bar = Math.floor(i / (SR * 1.5)) % 4;
    const env = Math.exp(-((i % (SR * 1.5)) / SR) * 1.2) * 0.2;
    let v = 0;
    for (const midi of bars[bar]) v += env * Math.sin((2 * Math.PI * 440 * Math.pow(2, (midi - 69) / 12) * i) / SR);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, data);
}

const beatFile = path.join(OUT, 'live-beat.wav');
writeChordWav(beatFile, 12);

const { bootstrap, createWindow } = require('../../main.js');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ĐẠT ' : 'LỖI '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  app.on('window-all-closed', () => {});
  await app.whenReady();
  bootstrap();
  const win = createWindow();
  const consoleErrors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') consoleErrors.push(details.message);
  });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));

  const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shot = async (name) => {
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const levelAvg = (ms) => run(`
    let sum = 0; let n = 0; const end = performance.now() + ${ms};
    while (performance.now() < end) { sum += __vokara.engine.liveLevel(); n++; await new Promise(r => setTimeout(r, 30)); }
    return sum / n;
  `);

  const wav = fs.readFileSync(beatFile);
  const server = http.createServer((request, response) => {
    if (request.url === '/beat.wav') {
      response.setHeader('content-type', 'audio/wav');
      response.end(wav);
      return;
    }
    const n = request.url === '/two' ? '2' : '1';
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Bai hat thu ${n}</title><body style="background:#123;color:#fff"><h1>Trang nhac thu</h1><audio id="a" src="/beat.wav" loop autoplay controls></audio></body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const pageContents = () => webContents.getAllWebContents().find((c) => c !== win.webContents && c.getURL().includes(String(port)));

  // "Mic" là nốt 220 Hz tổng hợp trong trang.
  await run(`
    const e = __vokara.engine;
    await e.ensure();
    const osc = e.context.createOscillator(); osc.frequency.value = 220;
    const gain = e.context.createGain(); gain.gain.value = 0.2;
    const dest = e.context.createMediaStreamDestination();
    osc.connect(gain).connect(dest); osc.start();
    e.mic.stream = dest.stream;
    e.mic.source = e.context.createMediaStreamSource(dest.stream);
    e.mic.source.connect(e.micGain);
    window.__monitor = (on) => { const box = document.getElementById('monitorToggle'); if (box.checked !== on) box.click(); };
    __monitor(false);
    window.__amp = (d, f) => {
      let re = 0, im = 0;
      for (let i = 0; i < d.length; i++) { const a = 2 * Math.PI * f * i / ${SR}; const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / d.length); re += d[i] * w * Math.cos(a); im += d[i] * w * Math.sin(a); }
      return 4 * Math.hypot(re, im) / d.length;
    };
    window.__rms = (d) => Math.sqrt(d.reduce((s, v) => s + v * v, 0) / Math.max(1, d.length));
  `);

  // --- Trang web ---
  await run("document.querySelector('.source-btn[data-source=web]').click();");
  const lockedAtOnce = await run('return __vokara.karaoke.beatTempoSlider.input.disabled;');
  check('Điều khiển file bị khoá ngay khi bấm chọn nguồn', lockedAtOnce === true);
  await sleep(600);
  const idle = await run("const k = __vokara.karaoke; return { live: __vokara.engine.live.kind, panel: !document.getElementById('webPanel').hidden, home: !document.getElementById('webHome').hidden, locked: k.beatTempoSlider.input.disabled };");
  check('Chọn Trang web: hiện khung, chưa bắt gì khi chưa có trang', idle.live === null && idle.panel && idle.home && idle.locked, JSON.stringify(idle));
  await shot('20-web-home');

  await run(`document.getElementById('webAddress').value = 'http://127.0.0.1:${port}/'; document.getElementById('webForm').requestSubmit();`);
  await sleep(2000);
  const opened = await run("const k = __vokara.karaoke; return { url: k.webState.url, home: !document.getElementById('webHome').hidden, address: document.getElementById('webAddress').value, label: document.getElementById('openBeatBtn').textContent, time: document.getElementById('beatTime').textContent };");
  check('Mở link từ ô địa chỉ', opened.url.includes(String(port)) && !opened.home && opened.address === opened.url, opened.url);
  check('Tiêu đề trang thành tên nhạc, thời gian là Trực tiếp', opened.label === 'Bai hat thu 1' && opened.time === 'Trực tiếp', `${opened.label} / ${opened.time}`);
  const liveKind = await run('return __vokara.engine.live.kind;');
  check('Mở trang đầu tiên thì bắt đầu bắt âm thanh', liveKind === 'web', String(liveKind));
  const webLevel = await levelAvg(1200);
  check('Âm thanh trang web đi vào ứng dụng', webLevel > 0.01, `mức ${webLevel.toFixed(3)}`);
  await shot('21-web-page');

  const page = pageContents();
  const sandbox = await page.executeJavaScript("(async () => { let mic = 'granted'; try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { mic = e.name; } return { mic, host: typeof window.vokaraHost, ua: navigator.userAgent }; })()");
  check('Trang web không xin được mic, không thấy API của ứng dụng', sandbox.mic !== 'granted' && sandbox.host === 'undefined', sandbox.mic);
  check('User agent không lộ Electron', !/Electron|okara/.test(sandbox.ua));
  check('Từ chối mở địa chỉ không phải http/https', (await run("return await window.vokaraHost.webOpen('file:///C:/Windows/win.ini');")) === false);

  await run("document.getElementById('beatPlayBtn').click();");
  await sleep(900);
  const paused = await page.executeJavaScript("document.getElementById('a').paused");
  const pausedLevel = await levelAvg(500);
  check('Nút phát của ứng dụng tạm dừng được nhạc trên trang', paused === true && pausedLevel < 0.003, `mức ${pausedLevel.toFixed(4)}`);
  await run("document.getElementById('beatPlayBtn').click();");
  await sleep(800);
  const resumed = await levelAvg(800);
  const playingClass = await run("return document.getElementById('beatPlayBtn').classList.contains('playing');");
  check('Bấm lại thì phát tiếp, nút đổi trạng thái', resumed > 0.01 && playingClass, `mức ${resumed.toFixed(3)}`);

  // Gọi khi vừa phát lại mới vài giây thì không được đoán bừa từ đoạn quá ngắn.
  await sleep(6500);
  await run('await __vokara.karaoke.detectKey(false);');
  const key = await run("return document.getElementById('keyHint').textContent;");
  check('Dò được tông từ nhạc trên web (G trưởng hoặc E thứ)', /dò được (G trưởng|E thứ)/.test(key), key);

  // Đổi tông trực tiếp: kéo thanh trượt thật, thu lại và đo trong bản thu.
  const setTone = (value) => run(`const s = __vokara.karaoke.beatToneSlider.input; s.value = ${value}; s.dispatchEvent(new Event('input'));`);
  const toneState = await run("const k = __vokara.karaoke; return { tone: k.beatToneSlider.input.disabled, tempo: k.beatTempoSlider.input.disabled, vocal: k.beatVocalSlider.input.disabled, root: k.state.root, scale: k.state.scale };");
  check('Nguồn web: mở Tông nhạc, tốc độ và giảm lời vẫn khoá', !toneState.tone && toneState.tempo && toneState.vocal, JSON.stringify(toneState));
  await setTone(1);
  const rootAfter = await run('return __vokara.karaoke.state.root;');
  check('Đổi tông nhạc thì tông chỉnh giọng đi theo', rootAfter === (toneState.root + 1) % 12, `${toneState.root} → ${rootAfter}`);
  await sleep(600);
  await run('await __vokara.karaoke.toggleRecord();');
  const lockedDuringRecord = await run('return __vokara.karaoke.beatToneSlider.input.disabled;');
  check('Đang ghi thì khoá Tông nhạc', lockedDuringRecord === true);
  await sleep(6500);
  await run('await __vokara.karaoke.toggleRecord();');
  const shifted = await run(`
    const m = __vokara.karaoke.take.liveBeat[0];
    return { a440: __amp(m, 440), a466: __amp(m, 466.16), d294: __amp(m, 293.66), d311: __amp(m, 311.13), rms: __rms(m) };
  `);
  check('Nhạc trong bản thu đã lên đúng 1 cung, nốt gốc biến mất', shifted.a466 > 10 * shifted.a440 && shifted.d311 > 10 * shifted.d294, `A4 ${shifted.a440.toFixed(4)} → Bb4 ${shifted.a466.toFixed(4)}; D4 ${shifted.d294.toFixed(4)} → Eb4 ${shifted.d311.toFixed(4)}`);
  const shiftedLevel = await levelAvg(300);
  await setTone(0);
  await sleep(500);
  const rootBack = await run('return __vokara.karaoke.state.root;');
  check('Về 0 cung thì tông chỉnh giọng về như cũ', rootBack === toneState.root);
  await run('await __vokara.karaoke.toggleRecord();');
  await sleep(6500);
  await run('await __vokara.karaoke.toggleRecord();');
  const original = await run(`
    const m = __vokara.karaoke.take.liveBeat[0];
    return { a440: __amp(m, 440), a466: __amp(m, 466.16), rms: __rms(m) };
  `);
  check('Về 0 cung: bản thu trở lại nguyên tông', original.a440 > 10 * original.a466, `A4 ${original.a440.toFixed(4)}, Bb4 ${original.a466.toFixed(4)}`);
  const toneLevelDb = 20 * Math.log10(shifted.rms / original.rms);
  check('Đổi tông không làm đổi âm lượng quá 1,5 dB', Math.abs(toneLevelDb) < 1.5, `${toneLevelDb.toFixed(2)} dB, mức nguồn ${shiftedLevel.toFixed(3)}`);
  await run('__vokara.karaoke.discardTake();');

  await run('await __vokara.karaoke.toggleRecord();');
  await sleep(3000);
  await run('await __vokara.karaoke.toggleRecord();');
  const take = await run(`
    const t = __vokara.karaoke.take; const m = t.liveBeat[0];
    return { kind: t.liveKind, asHeard: t.asHeard, music: m.length, voice: t.dry[0].length, rms: __rms(m), voiceRms: __rms(t.dry[0]), m220: __amp(m, 220), v220: __amp(t.dry[0], 220) };
  `);
  check('Bản thu web có nhạc và giọng dài bằng nhau', take.kind === 'web' && Math.abs(take.music - take.voice) < 2000 && take.music > 2.5 * SR, `${take.music}/${take.voice} mẫu`);
  check('Nhạc trong bản thu là âm thanh của trang, không lẫn giọng', take.rms > 0.01 && !take.asHeard && take.m220 < 0.1 * take.v220, `nhạc rms ${take.rms.toFixed(3)}; 220 Hz ở nhạc ${take.m220.toFixed(4)}, ở giọng ${take.v220.toFixed(4)}`);

  await run("document.getElementById('takeEditBtn').click();");
  await sleep(1000);
  const tracks = await run('return __vokara.editor.tracks.map((t) => ({ name: t.name, mute: !!t.mute }));');
  check('Mở trong Biên tập: 3 track đúng tên', tracks.length === 3 && tracks[0].name === 'Bai hat thu 1' && !tracks[1].mute && tracks[2].mute, tracks.map((t) => t.name + (t.mute ? ' (tắt)' : '')).join(', '));
  check('Sang Biên tập thì nhạc trên trang dừng', (await page.executeJavaScript("document.getElementById('a').paused")) === true);
  await shot('22-web-in-editor');
  await run("__vokara.switchTab('karaoke');");
  await sleep(400);

  await run(`window.vokaraHost.webOpen('http://localhost:${port}/two');`);
  await sleep(2500);
  const nav = await run('return { kind: __vokara.engine.live.kind, title: __vokara.karaoke.webState.title, signal: __vokara.karaoke.liveSignalSeconds };');
  const navLevel = await levelAvg(1000);
  check('Chuyển sang trang khác origin vẫn bắt được âm thanh', nav.kind === 'web' && navLevel > 0.01, `${nav.title}, mức ${navLevel.toFixed(3)}`);
  check('Sang bài khác thì tính lại thời lượng để dò tông', nav.signal < 5, `đã nghe ${nav.signal.toFixed(1)} s`);

  // --- App khác: một tiến trình PowerShell thật phát WAV ra loa mặc định ---
  await run("document.querySelector('.source-btn[data-source=system]').click();");
  await sleep(1200);
  const sys = await run("return { kind: __vokara.engine.live.kind, tone: __vokara.karaoke.beatToneSlider.input.disabled, note: document.getElementById('beatStatus').textContent, hidden: document.getElementById('webPanel').hidden, volume: __vokara.karaoke.sliders.beatVol.input.disabled, play: document.getElementById('beatPlayBtn').disabled };");
  check('Chọn App khác: đóng khung web, khoá nút phát và âm lượng nhạc', sys.kind === 'system' && sys.hidden && sys.volume && sys.play, JSON.stringify(sys));
  check('Khung web đã đóng thật', !pageContents());
  check('App khác: Tông nhạc khoá và có lý do rõ ràng', sys.tone === true && sys.note.includes('Trang web'), sys.note);
  const before = await levelAvg(800);
  const player = spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${beatFile}').PlaySync()`], { stdio: 'ignore' });
  await sleep(1800);
  const during = await levelAvg(1000);
  check('Bắt được âm thanh của tiến trình khác', before < 0.002 && during > 0.01, `trước ${before.toFixed(4)}, trong lúc phát ${during.toFixed(3)}`);
  await shot('23-system');

  await run('await __vokara.karaoke.toggleRecord();');
  await sleep(2000);
  await run('await __vokara.karaoke.toggleRecord();');
  const clean = await run(`
    const t = __vokara.karaoke.take; const m = t.liveBeat[0];
    return { asHeard: t.asHeard, rms: __rms(m), m220: __amp(m, 220), v220: __amp(t.dry[0], 220), name: t.liveName, shift: t.dryShift };
  `);
  check('Tắt nghe giọng: bản thu là nhạc riêng, không có giọng', clean.asHeard === false && clean.rms > 0.01 && clean.m220 < 0.1 * clean.v220 && clean.name === 'Âm thanh từ app khác', `rms ${clean.rms.toFixed(3)}, 220 Hz ${clean.m220.toFixed(4)}/${clean.v220.toFixed(4)}, dịch ${(clean.shift * 1000).toFixed(0)} ms`);

  await run('__monitor(true); await __vokara.karaoke.toggleRecord();');
  await sleep(2000);
  await run('await __vokara.karaoke.toggleRecord(); __monitor(false);');
  const heard = await run(`
    const t = __vokara.karaoke.take; const n = t.liveBeat[0].length;
    const scan = [200, 210, 215, 220, 225, 230, 240].map((f) => f + ':' + __amp(t.liveBeat[0].subarray(Math.floor(n / 4)), f).toFixed(4)).join(' ');
    const wetScan = [200, 210, 215, 220, 225, 230, 240].map((f) => f + ':' + __amp(t.wet[0].subarray(Math.floor(n / 4)), f).toFixed(4)).join(' ');
    return { asHeard: t.asHeard, scan, wetScan, wetRms: __rms(t.wet[0]), m220: __amp(t.liveBeat[0].subarray(Math.floor(n / 4)), 220), info: document.getElementById('takeInfo').textContent };
  `);
  check('Bật nghe giọng: bản thu có sẵn giọng đúng như nghe', heard.asHeard === true && heard.m220 > 0.01 && heard.info.includes('đúng như bạn nghe'), `220 Hz trong bản thu ${heard.m220.toFixed(4)}; nhạc [${heard.scan}]; giọng rms ${heard.wetRms.toFixed(4)} [${heard.wetScan}]`);
  await run("document.getElementById('takeEditBtn').click();");
  await sleep(800);
  const heardTracks = await run('return __vokara.editor.tracks.map((t) => ({ name: t.name, mute: !!t.mute, gainDb: t.gainDb }));');
  check('Bản thu đúng như nghe: tắt sẵn cả hai track giọng', heardTracks.length === 3 && !heardTracks[0].mute && heardTracks[1].mute && heardTracks[2].mute && heardTracks[0].gainDb === 0, heardTracks.map((t) => t.name + (t.mute ? ' (tắt)' : '')).join(', '));
  await run("__vokara.switchTab('karaoke'); __vokara.engine.setMonitor(false);");
  player.kill();
  spawn('taskkill', ['/PID', String(player.pid), '/T', '/F'], { stdio: 'ignore' });

  await sleep(1800);
  const quiet = await levelAvg(800);
  check('Không phát lại âm thanh hệ thống (không hú)', quiet < 0.002, `mức ${quiet.toFixed(4)}`);

  await run("document.querySelector('.source-btn[data-source=file]').click();");
  await sleep(500);
  const back = await run("const k = __vokara.karaoke; return { live: __vokara.engine.live.kind, tone: k.beatToneSlider.input.disabled, volume: k.sliders.beatVol.input.disabled, play: document.getElementById('beatPlayBtn').disabled, status: document.getElementById('beatStatus').hidden, label: document.getElementById('openBeatBtn').textContent };");
  check('Quay về File nhạc: mở khoá điều khiển', back.live === null && !back.tone && !back.volume && !back.play && back.status && back.label === 'Mở nhạc nền…', JSON.stringify(back));

  const realErrors = consoleErrors.filter((message) => !/Autofill|Electron Security/.test(message));
  check('Không có lỗi console', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} đạt`);
  server.close();
  win.destroy();
  app.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('LỖI NGHIÊM TRỌNG', error);
  app.exit(2);
});
