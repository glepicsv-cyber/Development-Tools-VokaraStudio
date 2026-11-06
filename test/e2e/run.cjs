// Kiểm thử đầu-cuối trên Electron thật: dùng file WAV làm "mic" giả của Chromium,
// nên toàn bộ đường AudioWorklet → hiệu ứng → ghi âm được chạy như khi hát thật.
// Chạy: npm run test:e2e

process.env.VOKARA_E2E = '1';

const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const SR = 48000;

function writeWav(file, samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples.length * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, data);
}

/** Giọng tổng hợp hát lệch +35 cent ở A3 (220 Hz). */
function makeOffKeyVoice(seconds) {
  const n = seconds * SR;
  const out = new Float32Array(n);
  const f0 = 440 * Math.pow(2, (57.35 - 69) / 12);
  const formants = [[700, 110, 1], [1220, 120, 0.5], [2600, 160, 0.25]].map(([f, bw, gain]) => {
    const r = Math.exp((-Math.PI * bw) / SR);
    return { a1: 2 * r * Math.cos((2 * Math.PI * f) / SR), a2: -r * r, y1: 0, y2: 0, gain };
  });
  let phase = 0;
  let previous = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    phase = (phase + f0 / SR) % 1;
    const pulse = phase < 0.6 ? 0.5 - 0.5 * Math.cos((Math.PI * phase) / 0.6) : 0;
    const excitation = pulse - previous;
    previous = pulse;
    let sum = 0;
    for (const filter of formants) {
      const y = excitation + filter.a1 * filter.y1 + filter.a2 * filter.y2;
      filter.y2 = filter.y1;
      filter.y1 = y;
      sum += y * filter.gain;
    }
    out[i] = sum;
    peak = Math.max(peak, Math.abs(sum));
  }
  for (let i = 0; i < n; i++) out[i] *= 0.4 / peak;
  return out;
}

const fakeMic = path.join(OUT, 'fake-mic.wav');
writeWav(fakeMic, makeOffKeyVoice(20));

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeMic);
app.setPath('userData', path.join(OUT, 'profile'));

const { bootstrap, createWindow } = require('../../main.js');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ĐẠT ' : 'LỖI '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // Không để Electron tự thoát khi đóng cửa sổ: bài test còn phải báo kết quả.
  app.on('window-all-closed', () => {});
  await app.whenReady();
  bootstrap();

  // Bỏ hộp thoại lưu file: ghi thẳng vào thư mục kết quả.
  ipcMain.removeHandler('save-file');
  ipcMain.handle('save-file', async (_event, { defaultName, data }) => {
    const target = path.join(OUT, `export-${defaultName}`);
    fs.writeFileSync(target, Buffer.from(data));
    return { path: target };
  });

  const win = createWindow();
  const consoleErrors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') consoleErrors.push(details.message);
  });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));

  const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  };

  await sleep(600);
  await shot('01-start');

  // --- Bật mic và nhận tín hiệu qua worklet thật ---
  await run(`await __vokara.karaoke.startMic(); __vokara.engine.setMonitor(false);`);
  await run(`
    const k = __vokara.karaoke;
    k.state.root = 0; k.state.scale = 'chromatic';
    k.refreshScale();
    k.updateTune({ retuneMs: 15, amount: 1, enabled: true });
  `);
  await sleep(1500);
  const live = await run(`
    const samples = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 25));
      const s = __vokara.engine.status;
      samples.push({ in: s.inMidi, out: s.outMidi, note: s.note });
    }
    return { samples, rate: __vokara.engine.context.sampleRate, latency: __vokara.engine.latencyBreakdown(), state: __vokara.engine.context.state };
  `);
  const voiced = live.samples.filter((s) => s.in > 0);
  check('AudioContext đang chạy', live.state === 'running', live.state);
  check('Worklet dò được cao độ từ mic', voiced.length > 40, `${voiced.length}/60 khung có tiếng`);
  const meanIn = voiced.reduce((sum, s) => sum + s.in, 0) / Math.max(1, voiced.length);
  const meanOut = voiced.reduce((sum, s) => sum + s.out, 0) / Math.max(1, voiced.length);
  check('Cao độ vào đúng (A3 lệch +35 cent)', Math.abs(meanIn - 57.35) < 0.08, `đo ${meanIn.toFixed(3)}`);
  check('Cao độ đích về đúng A3', Math.abs(meanOut - 57) < 0.05, `đích ${meanOut.toFixed(3)}`);
  console.log(`      độ trễ (ms): ${JSON.stringify(Object.fromEntries(Object.entries(live.latency).map(([k, v]) => [k, Math.round(v * 1000)])))}`);
  await shot('02-singing');

  // --- Nhạc nền: tạo WAV, nạp, dò tông, đổi tông ---
  const beatFile = path.join(OUT, 'beat.wav');
  const chord = new Float32Array(SR * 12);
  const progression = [[55, 59, 62], [62, 66, 69], [64, 67, 71], [60, 64, 67]]; // G D Em C
  for (let i = 0; i < chord.length; i++) {
    const bar = Math.floor(i / (SR * 1.5)) % 4;
    const local = (i % (SR * 1.5)) / SR;
    const env = Math.exp(-local * 1.2) * 0.2;
    for (const midi of progression[bar]) chord[i] += env * Math.sin((2 * Math.PI * 440 * Math.pow(2, (midi - 69) / 12) * i) / SR);
  }
  writeWav(beatFile, chord);
  const lrc = '[00:00.50]Dòng thứ nhất của bài hát\\n[00:03.00]Dòng thứ hai ngân dài\\n[00:06.00]Dòng thứ ba';
  const beatBytes = fs.readFileSync(beatFile).toString('base64');
  await run(`
    const bin = atob('${beatBytes}');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await __vokara.karaoke.loadBeat('Nhac nen thu.wav', bytes.buffer, '${lrc}');
  `);
  const key = await run(`return { root: __vokara.karaoke.state.root, scale: __vokara.karaoke.state.scale, hint: document.getElementById('keyHint').textContent, lyrics: __vokara.karaoke.lyrics.length };`);
  check('Tự dò tông nhạc nền là G trưởng', key.root === 7 && key.scale === 'major', key.hint);
  check('Nạp được lời bài hát', key.lyrics === 3, `${key.lyrics} dòng`);

  await run(`__vokara.karaoke.applyPreset(${'(await import("./ui/common.js")).PRESETS[1]'});`);
  await run(`__vokara.engine.playBeat();__vokara.karaoke.refreshTransport();`);
  await sleep(1200);
  const playing = await run(`return { pos: __vokara.engine.beatPosition(), lyric: document.getElementById('lyricNow').textContent };`);
  check('Nhạc nền đang phát và thời gian chạy', playing.pos > 0.8 && playing.pos < 2, `${playing.pos.toFixed(2)} s`);
  check('Lời bài hát chạy theo nhạc', playing.lyric === 'Dòng thứ nhất của bài hát', playing.lyric);
  await shot('03-beat-lyrics');

  const beforeRoot = 7;
  await run(`
    const k = __vokara.karaoke;
    k.beatToneSlider.set(2);
    await k.prepareBeat();
  `);
  const shifted = await run(`
    return { root: __vokara.karaoke.state.root, dur: __vokara.engine.beat.buffer.duration, playing: __vokara.engine.beat.playing };
  `);
  check('Nâng tông nhạc +2 kéo tông chỉnh theo (A)', shifted.root === (beforeRoot + 2) % 12, `root ${shifted.root}`);
  check('Đổi tông giữ nguyên độ dài bài', Math.abs(shifted.dur - 12) < 0.05, `${shifted.dur.toFixed(2)} s`);
  await run(`__vokara.karaoke.beatToneSlider.set(0); await __vokara.karaoke.prepareBeat(); __vokara.engine.seekBeat(0);`);

  // --- Ghi âm bài hát thật qua toàn bộ đồ thị ---
  await run(`__vokara.engine.pauseBeat(); await __vokara.karaoke.applyPreset((await import('./ui/common.js')).PRESETS[0]); await __vokara.karaoke.updateTune({ retuneMs: 15, amount: 1 }); __vokara.karaoke.state.root = 0; __vokara.karaoke.state.scale='chromatic'; __vokara.karaoke.refreshScale(); await __vokara.karaoke.toggleRecord();`);
  await sleep(4000);
  await run(`await __vokara.karaoke.toggleRecord();`);
  const take = await run(`
    const t = __vokara.karaoke.take;
    window.__takeWav = t;
    return { len: t.dry[0].length / t.sampleRate, wetCh: t.wet.length, sr: t.sampleRate, info: document.getElementById('takeInfo').textContent };
  `);
  check('Ghi âm được khoảng 4 giây', take.len > 3.5 && take.len < 4.5, `${take.len.toFixed(2)} s; ${take.info}`);

  // Đo cao độ thật trong bản thu (không tin vào số báo của worklet).
  const measured = await run(`
    const t = __vokara.karaoke.take;
    const { analyzePitch } = await import('./dsp/yin.js');
    const measure = (data) => {
      const a = analyzePitch(data, t.sampleRate, { minF0: 70, maxF0: 900 });
      const values = [];
      for (let i = a.f0.length * 0.3 | 0; i < a.f0.length * 0.9; i++) if (a.f0[i] > 0) values.push(69 + 12 * Math.log2(a.f0[i] / 440));
      values.sort((x, y) => x - y);
      return { median: values[values.length >> 1], p5: values[values.length * 0.05 | 0], p95: values[values.length * 0.95 | 0], count: values.length };
    };
    const rms = (data) => { let s = 0; for (const v of data) s += v * v; return Math.sqrt(s / data.length); };
    return { dry: measure(t.dry[0]), wet: measure(t.wet[0]), wetRms: rms(t.wet[0]), dryRms: rms(t.dry[0]) };
  `);
  check('Bản thu mộc còn lệch như mic', Math.abs(measured.dry.median - 57.35) < 0.08, `MIDI ${measured.dry.median.toFixed(3)}`);
  check('Bản thu đã chỉnh về đúng nốt (< 10 cent)', Math.abs(measured.wet.median - 57) < 0.1, `MIDI ${measured.wet.median.toFixed(3)}, p5-p95 ${measured.wet.p5.toFixed(2)}…${measured.wet.p95.toFixed(2)}`);
  check('Bản thu có tín hiệu rõ', measured.wetRms > 0.01, `RMS ${measured.wetRms.toFixed(3)}`);
  await shot('04-take');

  // --- Biên tập: mở bản thu, sửa nốt, thao tác, xuất ---
  await run(`
    const k = __vokara.karaoke;
    await k.callbacks.openTake(k.take, k.collectBeat());
  `);
  await sleep(300);
  const tracks = await run(`return __vokara.editor.tracks.map(t => ({ name: t.name, mute: t.mute, off: t.offset, len: t.channels[0].length }));`);
  check('Bản thu mở thành 3 track đã căn', tracks.length === 3 && tracks[2].mute === true, tracks.map((t) => t.name).join(', '));

  await run(`
    const e = __vokara.editor;
    const dry = e.tracks[2];
    dry.mute = false; e.tracks[0].mute = true; e.tracks[1].mute = true;
    e.selectedId = dry.id;
    e.refreshUi();
    await e.analyzeSelected();
    e.root = 0; e.scale = 'chromatic';
    e.strength = 1; e.flatten = 1;
  `);
  const analysis = await run(`const p = __vokara.editor.selectedTrack.pitch; return { notes: p.notes.length, first: p.notes[0] && p.notes[0].pitch };`);
  check('Phân tích ra nốt từ giọng mộc', analysis.notes >= 1 && Math.abs(analysis.first - 57.35) < 0.15, `${analysis.notes} nốt, ${analysis.first && analysis.first.toFixed(2)}`);

  await run(`
    const e = __vokara.editor;
    e.autoFix();
    await e.renderDone;
    const t = e.selectedTrack;
    t.pitch.notes[0].shift += 2;
    await e.scheduleRender(t, 0);
  `);
  const fixed = await run(`
    const e = __vokara.editor;
    const { analyzePitch } = await import('./dsp/yin.js');
    const a = analyzePitch(e.selectedTrack.channels[0], e.sampleRate, { minF0: 70, maxF0: 900 });
    const values = [];
    for (let i = a.f0.length * 0.3 | 0; i < a.f0.length * 0.8; i++) if (a.f0[i] > 0) values.push(69 + 12 * Math.log2(a.f0[i] / 440));
    values.sort((x, y) => x - y);
    return values[values.length >> 1];
  `);
  check('Sửa nốt: tự chỉnh rồi kéo +2 bán cung ra đúng B3', Math.abs(fixed - 59) < 0.1, `MIDI ${fixed.toFixed(3)}`);
  await sleep(300);
  await shot('05-editor-pitch');

  const editTest = await run(`
    const e = __vokara.editor;
    const t = e.selectedTrack;
    const before = t.channels[0].length;
    e.selection = { start: (t.offset / e.sampleRate) + 1, end: (t.offset / e.sampleRate) + 1.5 };
    await e.runOp('cut');
    const afterCut = e.selectedTrack.channels[0].length;
    const clip = e.clipboard[0].length;
    e.undo();
    const afterUndo = e.selectedTrack.channels[0].length;
    const stillAnalyzed = !!e.selectedTrack.pitch;
    e.redo();
    const afterRedo = e.selectedTrack.channels[0].length;
    e.undo();
    return { before, afterCut, clip, afterUndo, afterRedo, stillAnalyzed, sr: e.sampleRate };
  `);
  check('Cắt 0.5 giây đúng độ dài', Math.abs(editTest.before - editTest.afterCut - 0.5 * editTest.sr) < 2, `${editTest.before} → ${editTest.afterCut}`);
  check('Hoàn tác khôi phục đúng và giữ phân tích nốt', editTest.afterUndo === editTest.before && editTest.stillAnalyzed);
  check('Làm lại áp dụng lại phép cắt', editTest.afterRedo === editTest.afterCut);

  await run(`
    const e = __vokara.editor;
    e.selection = null;
    e.tracks.forEach((t, i) => { t.mute = i === 1; });
    e.tracks[2].fx.reverb = 0.3;
    await e.togglePlay();
  `);
  await sleep(700);
  const editorPlay = await run(`const e = __vokara.editor; const p = e.position(); await e.stop(); return p;`);
  check('Phát trong biên tập chạy đúng thời gian', editorPlay > 0.4 && editorPlay < 1.1, `${editorPlay.toFixed(2)} s`);

  await run(`await __vokara.editor.exportMix('wav24', 'all');`);
  await run(`await __vokara.editor.exportMix('mp3-192', 'all');`);
  const exported = fs.readdirSync(OUT).filter((f) => f.startsWith('export-'));
  const wavPath = exported.find((f) => f.endsWith('.wav'));
  const mp3Path = exported.find((f) => f.endsWith('.mp3'));
  check('Xuất được WAV', !!wavPath && fs.statSync(path.join(OUT, wavPath)).size > 100000, wavPath);
  check('Xuất được MP3', !!mp3Path && fs.statSync(path.join(OUT, mp3Path)).size > 10000, mp3Path);
  // Giải mã lại file vừa xuất bằng chính Chromium để chắc file dùng được.
  for (const file of [wavPath, mp3Path]) {
    if (!file) continue;
    const b64 = fs.readFileSync(path.join(OUT, file)).toString('base64');
    const info = await run(`
      const bin = atob('${b64}');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const decoded = await __vokara.engine.context.decodeAudioData(bytes.buffer);
      let peak = 0; const d = decoded.getChannelData(0);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
      return { dur: decoded.duration, peak, channels: decoded.numberOfChannels };
    `);
    check(`${file} giải mã lại được, không vượt ngưỡng`, info.dur > 5 && info.peak > 0.02 && info.peak <= 1.0001 && info.channels === 2, `${info.dur.toFixed(2)} s, đỉnh ${info.peak.toFixed(3)}`);
  }

  // --- Thao tác thật bằng chuột và bàn phím, không gọi hàm trực tiếp ---
  const mouse = async (type, x, y, modifiers = []) => {
    win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers });
    await sleep(40);
  };
  const clickAt = async (x, y) => {
    await mouse('mouseMove', x, y);
    await mouse('mouseDown', x, y);
    await mouse('mouseUp', x, y);
  };
  const dragTo = async (x1, y1, x2, y2, modifiers = []) => {
    await mouse('mouseMove', x1, y1, modifiers);
    await mouse('mouseDown', x1, y1, modifiers);
    for (let step = 1; step <= 6; step++) await mouse('mouseMove', x1 + ((x2 - x1) * step) / 6, y1 + ((y2 - y1) * step) / 6, modifiers);
    await mouse('mouseUp', x2, y2, modifiers);
  };
  const pressKey = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(80);
  };
  const rectOf = (selector) => run(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
  const clickEl = async (selector) => {
    const r = await rectOf(selector);
    await clickAt(r.x + r.w / 2, r.y + r.h / 2);
  };

  win.focus();
  win.webContents.focus();
  await run(`__vokara.switchTab('karaoke');`);
  await clickEl('[data-tab="editor"]');
  const tabOk = await run(`return !document.getElementById('editorView').hidden;`);
  check('Bấm chuột chuyển sang tab Biên tập', tabOk);
  await run(`const e = __vokara.editor; e.selectTrack(e.tracks[2].id); e.fitPitchView(); e.refreshUi();`);
  await sleep(200);

  // Nút M phải bấm được, nghĩa là không bị cắt khỏi cột đầu track.
  const muteRect = await rectOf('.track-head:nth-child(3) .mini-btn:nth-of-type(1)');
  const headRect = await rectOf('.track-head:nth-child(3)');
  const removeRect = await rectOf('.track-head:nth-child(3) .mini-btn:nth-of-type(3)');
  check('Nút track nằm gọn trong đầu track', removeRect.x + removeRect.w <= headRect.x + headRect.w, `nút tới ${Math.round(removeRect.x + removeRect.w)}, cột tới ${Math.round(headRect.x + headRect.w)}`);
  const muteBefore = await run(`return __vokara.editor.tracks[2].mute;`);
  await clickAt(muteRect.x + muteRect.w / 2, muteRect.y + muteRect.h / 2);
  const muteAfter = await run(`return __vokara.editor.tracks[2].mute;`);
  check('Bấm nút M đổi trạng thái tắt tiếng', muteBefore !== muteAfter);
  const reMute = await rectOf('.track-head:nth-child(3) .mini-btn:nth-of-type(1)');
  await clickAt(reMute.x + reMute.w / 2, reMute.y + reMute.h / 2);

  // Kéo một nốt lên 2 ô trên bảng sửa nốt.
  const noteGeom = await run(`
    const e = __vokara.editor; const t = e.selectedTrack; const c = document.getElementById('edPitch'); const r = c.getBoundingClientRect();
    const n = t.pitch.notes[0]; const sr = e.sampleRate; const hop = t.pitch.analysis.hop;
    const mid = (n.start + n.end) / 2;
    const x = e.xOf((mid * hop + t.offset) / sr);
    const y = r.height / 2 - (n.pitch + n.shift - e.pitchView.center) * e.pitchView.semitoneHeight;
    return { x: r.x + x, y: r.y + y, st: e.pitchView.semitoneHeight, shift: n.shift, pitch: n.pitch };
  `);
  await dragTo(noteGeom.x, noteGeom.y, noteGeom.x, noteGeom.y - noteGeom.st * 2);
  await run(`await __vokara.editor.renderDone;`);
  await sleep(250);
  const dragged = await run(`
    const e = __vokara.editor; const n = e.selectedTrack.pitch.notes[0];
    const { analyzePitch } = await import('./dsp/yin.js');
    const a = analyzePitch(e.selectedTrack.channels[0], e.sampleRate, { minF0: 70, maxF0: 900 });
    const v = []; for (let i = a.f0.length * 0.3 | 0; i < a.f0.length * 0.8; i++) if (a.f0[i] > 0) v.push(69 + 12 * Math.log2(a.f0[i] / 440));
    v.sort((x, y) => x - y);
    return { target: n.pitch + n.shift, measured: v[v.length >> 1] };
  `);
  check('Kéo nốt bằng chuột: nốt khớp bán cung và audio đổi theo', Math.abs(dragged.target - 61) < 0.01 && Math.abs(dragged.measured - 61) < 0.1, `đích ${dragged.target.toFixed(2)}, đo ${dragged.measured.toFixed(2)}`);
  await run(`document.activeElement.blur();`);
  await pressKey('Z', ['control']);
  const undone = await run(`const n = __vokara.editor.selectedTrack.pitch.notes[0]; return n.pitch + n.shift;`);
  check('Ctrl+Z hoàn tác cú kéo nốt', Math.abs(undone - 59) < 0.01, undone.toFixed(2));

  // Kéo chọn trên sóng âm rồi bấm nút Câm trên thanh công cụ.
  await run(`const e = __vokara.editor; e.view.start = 0; e.view.pps = document.getElementById('edCanvas').clientWidth / Math.max(4, e.duration * 1.04); e.invalidate();`);
  await sleep(100);
  const canvasRect = await rectOf('#edCanvas');
  const rowHeight = await run(`return __vokara.editor.rowHeight;`);
  const rowY = canvasRect.y + 24 + rowHeight * 2 + 40;
  const pps = await run(`return __vokara.editor.view.pps;`);
  await dragTo(canvasRect.x + pps * 1, rowY, canvasRect.x + pps * 2, rowY);
  const selection = await run(`return __vokara.editor.selection;`);
  check('Kéo chuột chọn đúng vùng trên sóng âm', selection && Math.abs(selection.start - 1) < 0.1 && Math.abs(selection.end - 2) < 0.1, selection && `${selection.start.toFixed(2)}…${selection.end.toFixed(2)} s`);
  await clickEl('[data-op="silence"]');
  await sleep(100);
  const silenced = await run(`
    const e = __vokara.editor; const t = e.selectedTrack; const sr = e.sampleRate;
    const at = Math.round(1.5 * sr) - t.offset;
    let inside = 0; for (let i = at; i < at + 2400; i++) inside = Math.max(inside, Math.abs(t.channels[0][i]));
    let outside = 0; const o = Math.max(0, Math.round(0.5 * sr) - t.offset); for (let i = o; i < o + 2400; i++) outside = Math.max(outside, Math.abs(t.channels[0][i]));
    return { inside, outside };
  `);
  check('Nút Câm làm câm vùng chọn, ngoài vùng còn tiếng', silenced.inside === 0 && silenced.outside > 0.01, `trong ${silenced.inside}, ngoài ${silenced.outside.toFixed(3)}`);
  await pressKey('Z', ['control']);
  await run(`__vokara.editor.selection = null; __vokara.editor.invalidate(); document.activeElement.blur();`);

  // Phím cách chỉ bật một lần, kể cả khi nút Phát đang được focus.
  await clickEl('#edPlayBtn');
  await sleep(200);
  const playOn = await run(`return !!__vokara.editor.playback;`);
  await pressKey('Space');
  await sleep(100);
  const playOff = await run(`return !!__vokara.editor.playback;`);
  check('Nút Phát rồi phím Space: bật rồi tắt đúng một lần', playOn === true && playOff === false, `${playOn} → ${playOff}`);

  // File hỏng phải báo lỗi rõ ràng, không treo.
  await run(`await __vokara.karaoke.loadBeat('hong.mp3', new TextEncoder().encode('khong phai am thanh').buffer);`);
  const broken = await run(`const t = document.getElementById('toast'); return { hidden: t.hidden, text: t.textContent, status: document.getElementById('statusBar').hidden };`);
  check('File hỏng báo lỗi và không treo', !broken.hidden && broken.text.includes('Không đọc được') && broken.status, broken.text.slice(0, 60));

  // --- Ổn định: kiểm tra sau chuỗi thao tác đổi loại giọng và bật/tắt ---
  await run(`__vokara.switchTab('karaoke'); __vokara.karaoke.updateTune({ enabled: false }); __vokara.engine.setVoiceParams({ voice: 'high' });`);
  await sleep(500);
  const afterSwitch = await run(`return { lat: __vokara.engine.voiceLatency, ok: __vokara.engine.context.state };`);
  check('Đổi loại giọng giảm độ trễ thuật toán', afterSwitch.lat < 0.025, `${Math.round(afterSwitch.lat * 1000)} ms`);
  await shot('06-karaoke-end');

  await run(`__vokara.engine.setVoiceParams({ voice: 'mid' }); __vokara.switchTab('editor'); __vokara.editor.selectTrack(__vokara.editor.tracks[2].id);`);
  await sleep(200);
  await shot('07-editor');

  const realErrors = consoleErrors.filter((message) => !/Autofill|Electron Security/.test(message));
  check('Không có lỗi console', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  // --- Đóng cửa sổ khi chưa lưu: chọn "Ở lại" giữ cửa sổ, chọn "Đóng" thì đóng thật ---
  const { dialog } = require('electron');
  let prompts = 0;
  let answer = 1;
  dialog.showMessageBoxSync = () => {
    prompts++;
    return answer;
  };
  await run(`__vokara.editor.callbacks.markDirty();`);
  win.close();
  await sleep(600);
  check('Đóng khi chưa lưu: có hỏi và "Ở lại" giữ cửa sổ', prompts === 1 && !win.isDestroyed(), `${prompts} lần hỏi`);
  answer = 0;
  win.close();
  await sleep(800);
  check('Chọn "Đóng và bỏ thay đổi" thì đóng thật', win.isDestroyed());

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} đạt`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('LỖI NGHIÊM TRỌNG', error);
  app.exit(2);
});
