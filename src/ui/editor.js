// Trình biên tập: nhiều track, thao tác trên sóng âm, sửa từng nốt, xuất file.

import { $, createSlider, fitCanvas, formatTime, setStatus, strokeWithGlow, toast, TOKENS } from './common.js';
import * as ops from '../dsp/edit-ops.js';
import { hzToMidi, nearestInScale, NOTE_NAMES, scaleMask, SCALES } from '../dsp/scales.js';
import { autoCorrectNotes, buildCurve } from '../dsp/notes.js';
import { createSoftLimiter, createVocalChain, DEFAULT_FX } from '../audio/fxchain.js';
import { encodeMp3, runJob } from '../audio/jobs.js';

const MIN_ROW_HEIGHT = 92;
const MAX_ROW_HEIGHT = 320;
const RULER_HEIGHT = 24;
const PEAK_BLOCK = 256;
const UNDO_LIMIT = 40;
const UNDO_BYTES = 1.5 * 1024 * 1024 * 1024;
const TRACK_COLORS = ['#16e0ff', '#ff9d2e', '#b388ff', '#4ade80', '#ff6fa8', '#60a5fa'];
const db2gain = (db) => Math.pow(10, db / 20);

/** Dấu vân tay các sửa đổi nốt. Khác với dấu của audio đã dựng nghĩa là nốt và tiếng đang lệch nhau. */
const noteSignature = (notes) => notes.map((note) => `${note.id}:${note.shift}:${note.flatten}`).join('|');

const peakCache = new WeakMap();

function getPeaks(channels) {
  const key = channels[0];
  if (peakCache.has(key)) return peakCache.get(key);
  const blocks = Math.ceil(key.length / PEAK_BLOCK);
  const min = new Float32Array(blocks);
  const max = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let low = 1;
    let high = -1;
    const start = b * PEAK_BLOCK;
    const end = Math.min(key.length, start + PEAK_BLOCK);
    for (const channel of channels) {
      for (let i = start; i < end; i++) {
        const value = channel[i];
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
    min[b] = low;
    max[b] = high;
  }
  const peaks = { min, max };
  peakCache.set(key, peaks);
  return peaks;
}

export class EditorView {
  constructor(engine, callbacks) {
    this.engine = engine;
    this.callbacks = callbacks;
    this.tracks = [];
    this.nextTrackId = 1;
    this.selectedId = null;
    this.selection = null; // {start, end} giây
    this.cursor = 0;
    this.view = { start: 0, pps: 40 };
    this.pitchView = { center: 60, semitoneHeight: 14 };
    this.clipboard = null;
    this.undoStack = [];
    this.redoStack = [];
    this.playback = null;
    this.selectedNotes = new Set();
    this.root = 0;
    this.scale = 'major';
    this.strength = 1;
    this.flatten = 0.5;
    this.renderToken = 0;
    this.renderWaiters = [];
    this.renderDone = Promise.resolve();
    this.dirtyCanvas = true;
    this.buildControls();
    this.bindEvents();
    this.refreshUi();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    new ResizeObserver(() => this.invalidate()).observe($('edCanvasWrap'));
    new ResizeObserver(() => this.invalidate()).observe($('edPitchWrap'));
  }

  get sampleRate() {
    return this.engine.context ? this.engine.context.sampleRate : 48000;
  }

  get selectedTrack() {
    return this.tracks.find((track) => track.id === this.selectedId) || null;
  }

  get duration() {
    return this.tracks.reduce((longest, track) => Math.max(longest, (track.offset + track.channels[0].length) / this.sampleRate), 0);
  }

  invalidate() {
    this.dirtyCanvas = true;
  }

  // ---------- Dựng giao diện ----------

  buildControls() {
    const keySelect = $('edKey');
    NOTE_NAMES.forEach((name, pc) => keySelect.add(new Option(name, pc)));
    const scaleSelect = $('edScale');
    for (const [id, scale] of Object.entries(SCALES)) scaleSelect.add(new Option(scale.label, id));
    scaleSelect.value = this.scale;

    const pct = (v) => `${Math.round(v * 100)}%`;
    const pitch = $('edPitchSliders');
    this.strengthSlider = createSlider({ label: 'Mức kéo về nốt', min: 0, max: 1, step: 0.01, value: 1, format: pct, onInput: (v) => (this.strength = v) });
    this.flattenSlider = createSlider({
      label: 'Làm phẳng luyến láy',
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.5,
      format: pct,
      title: '0%: giữ nguyên rung giọng. 100%: mỗi nốt phẳng hoàn toàn.',
      onInput: (v) => (this.flatten = v),
    });
    pitch.append(this.strengthSlider.root, this.flattenSlider.root);

    const signedDb = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    const fx = $('edFxSliders');
    this.fxSliders = {};
    const add = (key, label, min, max, step, format) => {
      const slider = createSlider({
        label,
        min,
        max,
        step,
        value: DEFAULT_FX[key],
        format,
        onInput: (v) => {
          const track = this.selectedTrack;
          if (!track) return;
          track.fx[key] = v;
          if (track.live) track.live.chain.apply(track.fx);
          this.callbacks.markDirty();
        },
      });
      this.fxSliders[key] = slider;
      fx.append(slider.root);
    };
    add('reverb', 'Vang phòng', 0, 1, 0.01, pct);
    add('reverbSize', 'Độ rộng phòng', 0.6, 4, 0.1, (v) => `${v.toFixed(1)} s`);
    add('echo', 'Tiếng lặp', 0, 1, 0.01, pct);
    add('echoTime', 'Khoảng lặp', 0.08, 0.7, 0.01, (v) => `${Math.round(v * 1000)} ms`);
    add('echoFeedback', 'Số lần lặp', 0, 0.8, 0.01, pct);
    add('low', 'Ấm giọng', -6, 6, 0.5, signedDb);
    add('presence', 'Rõ lời', -6, 6, 0.5, signedDb);
    add('air', 'Sáng giọng', -6, 6, 0.5, signedDb);
    add('comp', 'Nén', 0, 1, 0.01, pct);
  }

  bindEvents() {
    $('edAddTrack').addEventListener('click', () => this.openFile());
    $('edEmptyOpen').addEventListener('click', () => this.openFile());
    $('edPlayBtn').addEventListener('click', () => this.togglePlay());
    $('edHomeBtn').addEventListener('click', () => this.setCursor(0));
    $('edUndo').addEventListener('click', () => this.undo());
    $('edRedo').addEventListener('click', () => this.redo());
    $('edExport').addEventListener('click', () => this.showExport());
    $('edEditTools').addEventListener('click', (event) => {
      const button = event.target.closest('[data-op]');
      if (button) this.runOp(button.dataset.op);
    });
    $('edAnalyze').addEventListener('click', () => this.analyzeSelected());
    $('edAutoFix').addEventListener('click', () => this.autoFix());
    $('edDetectKey').addEventListener('click', () => this.detectVocalKey());
    $('edResetPitch').addEventListener('click', () => this.resetPitch());
    $('edKey').addEventListener('change', (event) => {
      this.root = Number(event.target.value);
      this.invalidate();
    });
    $('edScale').addEventListener('change', (event) => {
      this.scale = event.target.value;
      this.invalidate();
    });
    $('edScroll').addEventListener('input', (event) => {
      const span = Math.max(0, this.duration + 5 - this.visibleSeconds());
      this.view.start = (Number(event.target.value) / 1000) * span;
      this.invalidate();
    });
    document.querySelectorAll('.side-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.side-tab').forEach((other) => other.classList.toggle('active', other === tab));
        $('sidePitch').hidden = tab.dataset.side !== 'pitch';
        $('sideFx').hidden = tab.dataset.side !== 'fx';
      });
    });

    this.bindTimeline();
    this.bindPitchCanvas();

    const wrap = $('edCanvasWrap');
    const editorRoot = $('editorView');
    editorRoot.addEventListener('dragover', (event) => {
      event.preventDefault();
      wrap.classList.add('dragging');
    });
    editorRoot.addEventListener('dragleave', (event) => {
      if (!editorRoot.contains(event.relatedTarget)) wrap.classList.remove('dragging');
    });
    editorRoot.addEventListener('drop', async (event) => {
      event.preventDefault();
      wrap.classList.remove('dragging');
      for (const file of event.dataTransfer.files) {
        await this.addTrackFromArrayBuffer(file.name, await file.arrayBuffer());
      }
    });
  }

  // ---------- Quy đổi toạ độ ----------

  visibleSeconds() {
    return ($('edCanvas').clientWidth || 800) / this.view.pps;
  }

  xOf(seconds) {
    return (seconds - this.view.start) * this.view.pps;
  }

  secondsAt(x) {
    return this.view.start + x / this.view.pps;
  }

  zoomAround(x, factor) {
    const anchor = this.secondsAt(x);
    const width = $('edCanvas').clientWidth || 800;
    const minPps = Math.max(0.5, width / Math.max(10, this.duration + 5));
    this.view.pps = Math.max(minPps, Math.min(8000, this.view.pps * factor));
    this.view.start = Math.max(0, anchor - x / this.view.pps);
    this.invalidate();
  }

  // ---------- Tương tác dòng thời gian ----------

  bindTimeline() {
    const canvas = $('edCanvas');
    let dragging = null;

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (event.ctrlKey) {
        this.zoomAround(event.offsetX, event.deltaY < 0 ? 1.25 : 0.8);
      } else {
        const delta = (event.deltaY || event.deltaX) / this.view.pps;
        this.view.start = Math.max(0, this.view.start + delta);
        this.invalidate();
      }
    }, { passive: false });

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      const seconds = Math.max(0, this.secondsAt(event.offsetX));
      const row = Math.floor((event.offsetY - RULER_HEIGHT) / this.rowHeight);
      const track = this.tracks[row];
      if (track) this.selectTrack(track.id);
      if (event.altKey && track) {
        this.pushUndo('Dịch track');
        dragging = { mode: 'move', track, startX: event.offsetX, startOffset: track.offset };
        return;
      }
      dragging = { mode: 'select', anchor: seconds };
      this.selection = null;
      this.setCursor(seconds);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      if (dragging.mode === 'move') {
        const deltaSec = (event.offsetX - dragging.startX) / this.view.pps;
        dragging.track.offset = Math.max(0, Math.round(dragging.startOffset + deltaSec * this.sampleRate));
        this.invalidate();
        return;
      }
      const seconds = Math.max(0, this.secondsAt(event.offsetX));
      if (Math.abs(seconds - dragging.anchor) * this.view.pps > 3) {
        this.selection = { start: Math.min(seconds, dragging.anchor), end: Math.max(seconds, dragging.anchor) };
        this.invalidate();
      }
    });

    const finish = () => {
      if (dragging && dragging.mode === 'move') this.callbacks.markDirty();
      if (dragging && this.selection && dragging.mode === 'select') this.cursor = this.selection.start;
      dragging = null;
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
  }

  setCursor(seconds) {
    this.cursor = Math.max(0, seconds);
    if (this.playback) this.startPlayback(this.cursor);
    this.invalidate();
  }

  selectTrack(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.selectedNotes.clear();
    this.refreshUi();
    this.fitPitchView();
  }

  // ---------- Nạp audio ----------

  async openFile() {
    const file = await window.vokaraHost.openAudio({ title: 'Thêm track' });
    if (file) await this.addTrackFromArrayBuffer(file.name, file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength));
  }

  async addTrackFromArrayBuffer(name, arrayBuffer) {
    try {
      setStatus(`Đang mở ${name}…`);
      const buffer = await this.engine.decode(arrayBuffer);
      const channels = [];
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
      this.pushUndo('Thêm track');
      this.addTrack(name.replace(/\.[^.]+$/, ''), channels);
      setStatus(null);
    } catch (error) {
      setStatus(null);
      toast(`Không đọc được file ${name}: ${error.message}`, { error: true });
    }
  }

  addTrack(name, channels, options = {}) {
    const track = {
      id: this.nextTrackId++,
      name,
      channels,
      offset: options.offset ?? 0,
      gainDb: options.gainDb ?? 0,
      pan: 0,
      mute: options.mute ?? false,
      solo: false,
      fx: { ...DEFAULT_FX, ...(options.fx || {}) },
      color: TRACK_COLORS[(this.nextTrackId - 2) % TRACK_COLORS.length],
      pitch: null,
    };
    this.tracks.push(track);
    this.selectedId = track.id;
    this.callbacks.markDirty();
    this.fitIfFirst();
    this.refreshUi();
    return track;
  }

  fitIfFirst() {
    const width = $('edCanvas').clientWidth || 900;
    if (this.tracks.length === 1 || this.view.pps * (this.duration + 2) < width * 0.3) {
      this.view.start = 0;
      this.view.pps = Math.max(1, width / Math.max(4, this.duration * 1.04));
    }
  }

  /** Nạp bản thu từ màn karaoke thành các track đã căn thời gian. */
  async loadTake(take, beat) {
    await this.stop();
    this.pushUndo('Nạp bản thu');
    this.tracks = [];
    this.selection = null;
    this.cursor = 0;
    const sr = take.sampleRate;
    if (beat) this.addTrack(beat.name.replace(/\.[^.]+$/, ''), beat.channels, { gainDb: take.asHeard ? 0 : -3 });
    const place = (channels, shift) => {
      const offsetSec = take.beatOffset - shift;
      if (offsetSec >= 0) return { channels, offset: Math.round(offsetSec * sr) };
      const trim = Math.round(-offsetSec * sr);
      return { channels: channels.map((data) => data.slice(trim)), offset: 0 };
    };
    const dry = place(take.dry, take.dryShift);
    const wet = place(take.wet, take.wetShift);
    // Bản thu đúng-như-nghe đã có giọng sẵn, bật thêm sẽ thành hai lớp giọng.
    const wetTrack = this.addTrack('Giọng đã chỉnh', wet.channels, { offset: wet.offset, mute: !!take.asHeard });
    this.addTrack('Giọng mộc', dry.channels, { offset: dry.offset, mute: true });
    this.selectedId = wetTrack.id;
    this.view.start = 0;
    this.view.pps = Math.max(1, ($('edCanvas').clientWidth || 900) / Math.max(4, this.duration * 1.04));
    this.refreshUi();
  }

  // ---------- Hoàn tác ----------

  snapshot(label) {
    return {
      label,
      selectedId: this.selectedId,
      tracks: this.tracks.map((track) => ({
        ...track,
        live: null,
        fx: { ...track.fx },
        pitch: track.pitch ? { ...track.pitch, notes: track.pitch.notes.map((note) => ({ ...note })) } : null,
      })),
    };
  }

  pushUndo(label) {
    this.undoStack.push(this.snapshot(label));
    this.redoStack.length = 0;
    this.trimUndo();
    this.refreshHistoryButtons();
  }

  trimUndo() {
    while (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    // Dữ liệu dùng chung chỉ tính một lần vì thao tác giữ tham chiếu đến bản cũ.
    const measure = () => {
      const seen = new Set();
      let bytes = 0;
      for (const state of this.undoStack) {
        for (const track of state.tracks) {
          for (const channel of track.channels) {
            if (!seen.has(channel)) {
              seen.add(channel);
              bytes += channel.byteLength;
            }
          }
        }
      }
      return bytes;
    };
    while (this.undoStack.length > 1 && measure() > UNDO_BYTES) this.undoStack.shift();
  }

  restore(state) {
    this.stopSources();
    this.tracks = state.tracks;
    this.selectedId = state.selectedId;
    this.selectedNotes.clear();
    clearTimeout(this.renderTimer);
    this.renderToken++;
    // Bước hoàn tác có thể được lưu khi lần dựng trước chưa xong: nốt đã mới nhưng tiếng còn cũ.
    const stale = this.tracks.filter((track) => track.pitch && noteSignature(track.pitch.notes) !== track.pitch.renderedSignature);
    if (stale.length) stale.forEach((track) => this.scheduleRender(track, 0));
    else this.finishRenderWaiters();
    this.refreshUi();
  }

  undo() {
    const state = this.undoStack.pop();
    if (!state) return;
    this.redoStack.push(this.snapshot(state.label));
    this.restore(state);
    toast(`Đã hoàn tác: ${state.label}`, { ms: 1800 });
  }

  redo() {
    const state = this.redoStack.pop();
    if (!state) return;
    this.undoStack.push(this.snapshot(state.label));
    this.restore(state);
    toast(`Đã làm lại: ${state.label}`, { ms: 1800 });
  }

  refreshHistoryButtons() {
    $('edUndo').disabled = this.undoStack.length === 0;
    $('edRedo').disabled = this.redoStack.length === 0;
  }

  // ---------- Thao tác sóng âm ----------

  /** Vùng chọn quy về chỉ số mẫu của track, null nếu không giao nhau. */
  trackRange(track) {
    if (!this.selection) return null;
    const sr = this.sampleRate;
    const start = Math.round(this.selection.start * sr) - track.offset;
    const end = Math.round(this.selection.end * sr) - track.offset;
    const length = track.channels[0].length;
    const a = Math.max(0, Math.min(length, start));
    const b = Math.max(0, Math.min(length, end));
    return b > a ? [a, b] : null;
  }

  /** Thao tác làm đổi sóng âm sẽ cố định các sửa nốt vào audio. */
  commitPitch(track) {
    if (track.pitch) {
      track.pitch = null;
      this.selectedNotes.clear();
      toast('Các sửa nốt đã được giữ lại vào audio. Bấm “Phân tích giọng” nếu muốn sửa tiếp.', { ms: 3500 });
    }
  }

  async runOp(op) {
    const track = this.selectedTrack;
    if (!track) {
      toast('Hãy chọn một track trước.');
      return;
    }
    // Các thao tác dưới đây chốt audio hiện có, nên sửa nốt còn đang dựng phải xong trước.
    await this.settlePitch(track);
    if (op === 'denoise') {
      await this.denoise(track);
      return;
    }
    if (op === 'paste') {
      this.paste(track);
      return;
    }
    const range = this.trackRange(track);
    if (!range) {
      toast('Hãy kéo chuột trên sóng âm để chọn một đoạn của track này.');
      return;
    }
    const [a, b] = range;
    const labels = {
      cut: 'Cắt',
      copy: 'Chép',
      silence: 'Làm câm',
      keep: 'Giữ vùng chọn',
      fadeIn: 'Fade vào',
      fadeOut: 'Fade ra',
      normalize: 'Chuẩn hoá',
      reverse: 'Đảo ngược',
      gainUp: 'Tăng 3 dB',
      gainDown: 'Giảm 3 dB',
    };
    if (op === 'copy') {
      this.clipboard = ops.extractRange(track.channels, a, b);
      toast(`Đã chép ${((b - a) / this.sampleRate).toFixed(2)} giây`, { ms: 1500 });
      return;
    }
    this.pushUndo(labels[op]);
    this.commitPitch(track);
    let next;
    switch (op) {
      case 'cut':
        this.clipboard = ops.extractRange(track.channels, a, b);
        next = ops.removeRange(track.channels, a, b, Math.round(this.sampleRate * 0.005));
        this.selection = null;
        break;
      case 'silence':
        next = ops.silenceRange(track.channels, a, b);
        break;
      case 'keep':
        next = ops.keepRange(track.channels, a, b);
        track.offset += a;
        break;
      case 'fadeIn':
        next = ops.fadeRange(track.channels, a, b, 'in');
        break;
      case 'fadeOut':
        next = ops.fadeRange(track.channels, a, b, 'out');
        break;
      case 'normalize':
        next = ops.normalizeRange(track.channels, a, b, -1);
        break;
      case 'reverse':
        next = ops.reverseRange(track.channels, a, b);
        break;
      case 'gainUp':
        next = ops.gainRange(track.channels, a, b, 3);
        break;
      case 'gainDown':
        next = ops.gainRange(track.channels, a, b, -3);
        break;
      default:
        return;
    }
    this.replaceChannels(track, next);
  }

  paste(track) {
    if (!this.clipboard) {
      toast('Chưa có đoạn nào được chép.');
      return;
    }
    this.pushUndo('Dán');
    this.commitPitch(track);
    const position = Math.round(this.cursor * this.sampleRate) - track.offset;
    this.replaceChannels(track, ops.insertAt(track.channels, position, this.clipboard));
  }

  async denoise(track) {
    try {
      this.pushUndo('Khử nhiễu');
      this.commitPitch(track);
      setStatus('Đang khử nhiễu…', 0);
      const { channels } = await runJob(
        'denoise',
        { channels: track.channels, sampleRate: this.sampleRate, strength: 0.7 },
        (p) => setStatus('Đang khử nhiễu…', p),
      );
      this.replaceChannels(track, channels);
    } catch (error) {
      toast(`Lỗi khử nhiễu: ${error.message}`, { error: true });
    }
    setStatus(null);
  }

  replaceChannels(track, channels) {
    track.channels = channels;
    track.audioBuffer = null;
    this.callbacks.markDirty();
    if (this.playback) this.startPlayback(this.position());
    this.refreshUi();
  }

  // ---------- Cao độ ----------

  async analyzeSelected() {
    const track = this.selectedTrack;
    if (!track) {
      toast('Hãy chọn một track giọng hát trước.');
      return;
    }
    await this.analyzeTrack(track);
  }

  async analyzeTrack(track) {
    setStatus('Đang phân tích cao độ…', 0);
    try {
      const samples = ops.mixToMono(track.channels).slice();
      const { analysis, notes } = await runJob(
        'analyzePitch',
        { samples, sampleRate: this.sampleRate },
        (p) => setStatus('Đang phân tích cao độ…', p),
      );
      if (notes.length === 0) {
        toast('Không tìm thấy nốt hát rõ ràng trong track này.', { error: true });
        return;
      }
      this.pushUndo('Phân tích giọng');
      track.pitch = { analysis, notes, source: track.channels, outMidi: null, renderedSignature: noteSignature(notes) };
      this.selectedNotes.clear();
      this.fitPitchView();
      this.refreshUi();
      toast(`Tìm được ${notes.length} nốt.`, { ms: 2000 });
    } catch (error) {
      toast(`Lỗi phân tích: ${error.message}`, { error: true });
    } finally {
      setStatus(null);
    }
  }

  fitPitchView() {
    const track = this.selectedTrack;
    if (track && track.pitch && track.pitch.notes.length) {
      const pitches = track.pitch.notes.map((note) => note.pitch + note.shift).sort((a, b) => a - b);
      this.pitchView.center = pitches[pitches.length >> 1];
      const low = pitches[0];
      const high = pitches[pitches.length - 1];
      const height = $('edPitch').clientHeight || 240;
      this.pitchView.semitoneHeight = Math.max(8, Math.min(26, height / Math.max(10, high - low + 6)));
      this.pitchView.center = (low + high) / 2;
    }
    this.invalidate();
  }

  targetNotes(track) {
    if (this.selectedNotes.size) return track.pitch.notes.filter((note) => this.selectedNotes.has(note.id));
    if (!this.selection) return track.pitch.notes;
    const { hop } = track.pitch.analysis;
    const sr = this.sampleRate;
    const inside = track.pitch.notes.filter((note) => {
      const start = (note.start * hop + track.offset) / sr;
      const end = (note.end * hop + track.offset) / sr;
      return end > this.selection.start && start < this.selection.end;
    });
    return inside.length ? inside : track.pitch.notes;
  }

  autoFix() {
    const track = this.selectedTrack;
    if (!track || !track.pitch) return;
    this.pushUndo('Tự chỉnh về tông');
    autoCorrectNotes(this.targetNotes(track), this.root, this.scale, this.strength, this.flatten);
    this.scheduleRender(track, 0);
    this.invalidate();
  }

  resetPitch() {
    const track = this.selectedTrack;
    if (!track || !track.pitch) return;
    this.pushUndo('Đặt lại nốt');
    for (const note of this.targetNotes(track)) {
      note.shift = 0;
      note.flatten = 0;
    }
    this.scheduleRender(track, 0);
    this.invalidate();
  }

  /** Dò tông từ biểu đồ nốt đã hát: nốt nào hát lâu thì nặng cân. */
  detectVocalKey() {
    const track = this.selectedTrack;
    if (!track || !track.pitch) return;
    const histogram = new Array(12).fill(0);
    for (const note of track.pitch.notes) {
      const pc = ((Math.round(note.pitch) % 12) + 12) % 12;
      histogram[pc] += note.end - note.start;
    }
    let best = { root: 0, scale: 'major', score: -Infinity };
    for (const scale of ['major', 'minor']) {
      for (let root = 0; root < 12; root++) {
        const mask = scaleMask(root, scale);
        let score = 0;
        for (let pc = 0; pc < 12; pc++) score += mask[pc] ? histogram[pc] : -histogram[pc];
        // Nốt chủ và nốt át được ưu tiên để phân biệt các tông có cùng tập nốt.
        score += histogram[root] * 0.6 + histogram[(root + 7) % 12] * 0.25;
        if (score > best.score) best = { root, scale, score };
      }
    }
    this.root = best.root;
    this.scale = best.scale;
    $('edKey').value = String(best.root);
    $('edScale').value = best.scale;
    this.invalidate();
    toast(`Giọng hát có vẻ ở tông ${NOTE_NAMES[best.root]} ${SCALES[best.scale].label.toLowerCase()}.`, { ms: 3000 });
  }

  scheduleRender(track, delay = 140) {
    clearTimeout(this.renderTimer);
    this.callbacks.markDirty();
    const token = ++this.renderToken;
    // Vẽ đường cong đích ngay để người dùng thấy kết quả trước khi audio xong.
    track.pitch.outMidi = buildCurve(track.pitch.analysis, track.pitch.notes).outMidi;
    // Mọi người đang chờ đều được báo khi lần dựng mới nhất xong, kể cả ai chờ lần đã bị thay thế.
    this.renderDone = new Promise((resolve) => this.renderWaiters.push(resolve));
    this.renderTimer = setTimeout(async () => {
      await this.renderPitch(track, token);
      if (token === this.renderToken) this.finishRenderWaiters();
    }, delay);
    this.invalidate();
    return this.renderDone;
  }

  finishRenderWaiters() {
    const waiters = this.renderWaiters;
    this.renderWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Chờ tới khi audio của track khớp với các nốt đang hiển thị. */
  async settlePitch(track) {
    if (!track.pitch) return;
    if (noteSignature(track.pitch.notes) !== track.pitch.renderedSignature) await this.scheduleRender(track, 0);
    else await this.renderDone;
  }

  async renderPitch(track, token) {
    if (!track.pitch) return;
    setStatus('Đang dựng lại giọng…', 0);
    const signature = noteSignature(track.pitch.notes);
    try {
      const { channels, outMidi } = await runJob(
        'renderPitch',
        {
          channels: track.pitch.source,
          sampleRate: this.sampleRate,
          analysis: track.pitch.analysis,
          notes: track.pitch.notes,
        },
        (p) => {
          if (token === this.renderToken) setStatus('Đang dựng lại giọng…', p);
        },
      );
      if (token !== this.renderToken || !track.pitch) return;
      track.channels = channels;
      track.pitch.outMidi = outMidi;
      track.pitch.renderedSignature = signature;
      track.audioBuffer = null;
      if (this.playback) this.startPlayback(this.position());
      this.invalidate();
    } catch (error) {
      toast(`Lỗi dựng giọng: ${error.message}`, { error: true });
    }
    if (token === this.renderToken) setStatus(null);
  }

  bindPitchCanvas() {
    const canvas = $('edPitch');
    let drag = null;

    const noteAt = (x, y) => {
      const track = this.selectedTrack;
      if (!track || !track.pitch) return null;
      const { hop } = track.pitch.analysis;
      const sr = this.sampleRate;
      const { width: _w, height } = { width: canvas.clientWidth, height: canvas.clientHeight };
      const { center, semitoneHeight } = this.pitchView;
      const time = this.secondsAt(x);
      for (const note of track.pitch.notes) {
        const start = (note.start * hop + track.offset) / sr;
        const end = (note.end * hop + track.offset) / sr;
        if (time < start || time > end) continue;
        const midi = note.pitch + note.shift;
        const noteY = height / 2 - (midi - center) * semitoneHeight;
        if (Math.abs(noteY - y) <= Math.max(7, semitoneHeight / 2 + 1)) return note;
      }
      return null;
    };

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (event.ctrlKey) {
        this.pitchView.semitoneHeight = Math.max(6, Math.min(48, this.pitchView.semitoneHeight * (event.deltaY < 0 ? 1.15 : 0.87)));
      } else if (event.shiftKey) {
        this.view.start = Math.max(0, this.view.start + event.deltaY / this.view.pps);
      } else {
        this.pitchView.center -= event.deltaY / 40;
      }
      this.invalidate();
    }, { passive: false });

    canvas.addEventListener('pointerdown', (event) => {
      canvas.focus();
      const track = this.selectedTrack;
      if (!track || !track.pitch) return;
      const note = noteAt(event.offsetX, event.offsetY);
      if (!note) {
        if (!event.shiftKey) this.selectedNotes.clear();
        this.invalidate();
        return;
      }
      if (event.shiftKey) {
        if (this.selectedNotes.has(note.id)) this.selectedNotes.delete(note.id);
        else this.selectedNotes.add(note.id);
      } else if (!this.selectedNotes.has(note.id)) {
        this.selectedNotes.clear();
        this.selectedNotes.add(note.id);
      }
      canvas.setPointerCapture(event.pointerId);
      const group = track.pitch.notes.filter((other) => this.selectedNotes.has(other.id));
      drag = { y: event.offsetY, note, group, originals: group.map((other) => other.shift), moved: false, track };
      this.invalidate();
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!drag) {
        canvas.style.cursor = noteAt(event.offsetX, event.offsetY) ? 'ns-resize' : 'default';
        return;
      }
      const deltaSemis = (drag.y - event.offsetY) / this.pitchView.semitoneHeight;
      if (!drag.moved && Math.abs(deltaSemis) < 0.2) return;
      if (!drag.moved) {
        this.pushUndo('Kéo nốt');
        drag.moved = true;
      }
      const anchorIndex = drag.group.indexOf(drag.note);
      const anchorOriginal = drag.originals[anchorIndex];
      let anchorShift = anchorOriginal + deltaSemis;
      if (!event.altKey) {
        // Nốt neo khớp đúng bán cung; các nốt còn lại di chuyển cùng khoảng đó.
        anchorShift = Math.round(drag.note.pitch + anchorShift) - drag.note.pitch;
      }
      const applied = anchorShift - anchorOriginal;
      drag.group.forEach((note, index) => {
        note.shift = drag.originals[index] + applied;
      });
      this.invalidate();
    });

    const finish = () => {
      if (drag && drag.moved) this.scheduleRender(drag.track);
      drag = null;
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    canvas.addEventListener('dblclick', (event) => {
      const track = this.selectedTrack;
      const note = noteAt(event.offsetX, event.offsetY);
      if (!track || !note) return;
      this.pushUndo('Bắt nốt về tông');
      const mask = scaleMask(this.root, this.scale);
      note.shift = nearestInScale(note.pitch + note.shift, mask) - note.pitch;
      this.scheduleRender(track, 0);
    });

    canvas.addEventListener('keydown', (event) => {
      const track = this.selectedTrack;
      if (!track || !track.pitch) return;
      if (event.ctrlKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        event.stopPropagation();
        track.pitch.notes.forEach((note) => this.selectedNotes.add(note.id));
        this.invalidate();
        return;
      }
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && this.selectedNotes.size) {
        event.preventDefault();
        this.pushUndo('Chỉnh nốt');
        const step = (event.key === 'ArrowUp' ? 1 : -1) * (event.altKey ? 0.1 : 1);
        for (const note of track.pitch.notes) if (this.selectedNotes.has(note.id)) note.shift += step;
        this.scheduleRender(track);
      }
    });
  }

  // ---------- Phát ----------

  bufferFor(track) {
    if (!track.audioBuffer) {
      const context = this.engine.context;
      const buffer = context.createBuffer(track.channels.length, track.channels[0].length, context.sampleRate);
      track.channels.forEach((data, index) => buffer.copyToChannel(data, index));
      track.audioBuffer = buffer;
    }
    return track.audioBuffer;
  }

  /** Nối một track vào đồ thị; dùng chung cho phát thử và xuất file. */
  wireTrack(context, track, destination, nativeBuffer) {
    const source = context.createBufferSource();
    source.buffer = nativeBuffer;
    const gain = context.createGain();
    gain.gain.value = db2gain(track.gainDb);
    const pan = context.createStereoPanner();
    pan.pan.value = track.pan;
    const chain = createVocalChain(context, { nativeCompressor: true });
    chain.apply(track.fx);
    source.connect(gain);
    gain.connect(pan);
    pan.connect(chain.input);
    chain.output.connect(destination);
    return { source, gain, pan, chain };
  }

  audibleTracks() {
    const anySolo = this.tracks.some((track) => track.solo);
    return this.tracks.filter((track) => (anySolo ? track.solo : !track.mute));
  }

  async togglePlay() {
    if (this.playback) {
      await this.stop();
      return;
    }
    if (!this.tracks.length) return;
    await this.engine.ensure();
    const from = this.selection && $('edLoop').checked ? this.selection.start : this.cursor;
    this.startPlayback(from >= this.duration ? 0 : from);
  }

  startPlayback(from) {
    this.stopSources();
    const context = this.engine.context;
    const sr = context.sampleRate;
    const when = context.currentTime + 0.04;
    const bus = context.createGain();
    bus.connect(this.engine.master);
    const sources = [];
    for (const track of this.audibleTracks()) {
      const live = this.wireTrack(context, track, bus, this.bufferFor(track));
      track.live = live;
      const startSec = track.offset / sr;
      const delay = Math.max(0, startSec - from);
      const inside = Math.max(0, from - startSec);
      if (inside < live.source.buffer.duration) live.source.start(when + delay, inside);
      sources.push(live.source);
    }
    this.playback = { when, from, sources, bus };
    $('edPlayBtn').classList.add('playing');
  }

  stopSources() {
    if (!this.playback) return;
    for (const source of this.playback.sources) {
      try {
        source.stop();
      } catch {
        /* nguồn chưa chạy */
      }
    }
    this.playback.bus.disconnect();
    this.playback = null;
    for (const track of this.tracks) track.live = null;
    $('edPlayBtn').classList.remove('playing');
  }

  async stop() {
    if (this.playback) this.cursor = this.position();
    this.stopSources();
    this.invalidate();
  }

  position() {
    if (!this.playback) return this.cursor;
    return this.playback.from + Math.max(0, this.engine.context.currentTime - this.playback.when);
  }

  // ---------- Xuất file ----------

  showExport() {
    if (!this.tracks.length) {
      toast('Chưa có gì để xuất.');
      return;
    }
    const dialog = $('exportDialog');
    const rangeSelect = $('exportRange');
    rangeSelect.value = this.selection ? rangeSelect.value : 'all';
    rangeSelect.options[1].disabled = !this.selection;
    dialog.returnValue = '';
    dialog.showModal();
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue === 'ok') this.exportMix($('exportFormat').value, rangeSelect.value);
      },
      { once: true },
    );
  }

  async renderMix(from, to) {
    const sr = this.sampleRate;
    const frames = Math.max(1, Math.round((to - from) * sr));
    const context = new OfflineAudioContext(2, frames, sr);
    const limiter = createSoftLimiter(context);
    limiter.output.connect(context.destination);
    for (const track of this.audibleTracks()) {
      const buffer = context.createBuffer(track.channels.length, track.channels[0].length, sr);
      track.channels.forEach((data, index) => buffer.copyToChannel(data, index));
      const { source } = this.wireTrack(context, track, limiter.input, buffer);
      const startSec = track.offset / sr;
      const delay = Math.max(0, startSec - from);
      const inside = Math.max(0, from - startSec);
      if (inside < buffer.duration) source.start(delay, inside);
    }
    const rendered = await context.startRendering();
    return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];
  }

  async exportMix(format, range) {
    for (const track of this.tracks) await this.settlePitch(track);
    const from = range === 'selection' && this.selection ? this.selection.start : 0;
    // Thêm đuôi để tiếng vang tắt tự nhiên khi xuất cả dự án.
    const to = range === 'selection' && this.selection ? this.selection.end : this.duration + 1.5;
    try {
      setStatus('Đang trộn các track…');
      const channels = await this.renderMix(from, to);
      let data;
      let extension;
      let filterName;
      if (format.startsWith('mp3')) {
        const kbps = Number(format.split('-')[1]);
        setStatus('Đang mã hoá MP3…', 0);
        const result = await encodeMp3({ channels, sampleRate: this.sampleRate, kbps }, (p) => setStatus('Đang mã hoá MP3…', p));
        data = result.buffer;
        extension = 'mp3';
        filterName = 'MP3';
      } else {
        setStatus('Đang ghi WAV…');
        const result = await runJob('encodeWav', { channels, sampleRate: this.sampleRate, bitDepth: format === 'wav16' ? 16 : 24 });
        data = result.buffer;
        extension = 'wav';
        filterName = 'WAV';
      }
      setStatus(null);
      const saved = await window.vokaraHost.saveFile({
        defaultName: `${this.tracks[0].name || 'ban-mix'}.${extension}`,
        filterName,
        extension,
        data: new Uint8Array(data),
      });
      if (saved) {
        toast(`Đã lưu ${saved.path}`, { ms: 6000 });
        this.callbacks.markClean();
      }
      return saved;
    } catch (error) {
      setStatus(null);
      toast(`Không xuất được: ${error.message}`, { error: true });
      return null;
    }
  }

  // ---------- Danh sách track ----------

  refreshUi() {
    this.renderHeaders();
    this.refreshHistoryButtons();
    const track = this.selectedTrack;
    const empty = this.tracks.length === 0;
    $('edEmpty').hidden = !empty;
    const analyzed = !!(track && track.pitch);
    $('edAnalyze').disabled = !track;
    $('edAnalyze').textContent = analyzed ? 'Phân tích lại' : 'Phân tích giọng';
    $('edAutoFix').disabled = !analyzed;
    $('edDetectKey').disabled = !analyzed;
    $('edResetPitch').disabled = !analyzed;
    $('edPitchEmpty').hidden = analyzed;
    $('edPitchEmpty').textContent = track ? 'Bấm “Phân tích giọng” để hiện các nốt của track này.' : 'Chọn một track giọng hát rồi bấm “Phân tích giọng”.';
    $('edKey').value = String(this.root);
    $('edScale').value = this.scale;
    if (track) {
      for (const [key, slider] of Object.entries(this.fxSliders)) slider.set(track.fx[key]);
    }
    this.invalidate();
  }

  renderHeaders() {
    const host = $('edHeaders');
    host.innerHTML = '';
    for (const track of this.tracks) {
      const row = document.createElement('div');
      row.className = `track-head${track.id === this.selectedId ? ' selected' : ''}`;
      row.addEventListener('pointerdown', () => this.selectTrack(track.id));

      const top = document.createElement('div');
      top.className = 'track-top';
      const name = document.createElement('input');
      name.className = 'track-name';
      name.value = track.name;
      name.setAttribute('aria-label', 'Tên track');
      name.addEventListener('change', () => {
        track.name = name.value;
      });
      const toggle = (label, title, active, activeClass, onToggle) => {
        const button = document.createElement('button');
        button.className = `mini-btn ${active ? activeClass : ''}`;
        button.textContent = label;
        button.title = title;
        button.addEventListener('click', onToggle);
        return button;
      };
      const replay = () => {
        this.renderHeaders();
        if (this.playback) this.startPlayback(this.position());
      };
      const muteBtn = toggle('M', 'Tắt tiếng', track.mute, 'on-mute', () => {
        track.mute = !track.mute;
        replay();
      });
      const soloBtn = toggle('S', 'Chỉ nghe track này', track.solo, 'on-solo', () => {
        track.solo = !track.solo;
        replay();
      });
      const removeBtn = toggle('×', 'Xoá track', false, '', () => {
        this.pushUndo('Xoá track');
        this.tracks = this.tracks.filter((other) => other !== track);
        if (this.selectedId === track.id) this.selectedId = this.tracks[0] ? this.tracks[0].id : null;
        if (this.playback) this.startPlayback(this.position());
        this.refreshUi();
      });
      top.append(name, muteBtn, soloBtn, removeBtn);

      const volume = createSlider({
        label: 'Âm lượng',
        min: -40,
        max: 12,
        step: 0.5,
        value: track.gainDb,
        format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
        onInput: (v) => {
          track.gainDb = v;
          if (track.live) track.live.gain.gain.value = db2gain(v);
          this.callbacks.markDirty();
        },
      });
      const pan = createSlider({
        label: 'Trái / phải',
        min: -1,
        max: 1,
        step: 0.05,
        value: track.pan,
        format: (v) => (v === 0 ? 'Giữa' : v < 0 ? `T ${Math.round(-v * 100)}` : `P ${Math.round(v * 100)}`),
        onInput: (v) => {
          track.pan = v;
          if (track.live) track.live.pan.pan.value = v;
          this.callbacks.markDirty();
        },
      });
      row.append(top, volume.root, pan.root);
      host.append(row);
    }
  }

  // ---------- Vẽ ----------

  loop() {
    requestAnimationFrame(this.loop);
    if ($('editorView').hidden) return;

    if (this.playback) {
      const position = this.position();
      if (position >= this.duration + 0.2) {
        this.cursor = 0;
        this.stopSources();
        this.invalidate();
      } else if (this.selection && $('edLoop').checked && position >= this.selection.end) {
        this.startPlayback(this.selection.start);
      } else {
        // Trang cuộn theo con trỏ phát.
        const visible = this.visibleSeconds();
        if (position > this.view.start + visible * 0.95 || position < this.view.start) {
          this.view.start = Math.max(0, position - visible * 0.05);
          this.invalidate();
        }
      }
    }
    if (this.dirtyCanvas) {
      this.dirtyCanvas = false;
      this.drawTimeline();
      this.drawPitch();
      this.syncScroll();
    }
    this.drawPlayhead();
  }

  syncScroll() {
    const input = $('edScroll');
    const span = Math.max(0, this.duration + 5 - this.visibleSeconds());
    input.disabled = span <= 0;
    input.value = span > 0 ? String(Math.round((this.view.start / span) * 1000)) : '0';
  }

  drawPlayhead() {
    const position = this.position();
    const x = this.xOf(position);
    const canvasWidth = $('edCanvas').clientWidth;
    const inView = x >= 0 && x <= canvasWidth;
    for (const id of ['edPlayhead', 'edPitchPlayhead']) {
      const line = $(id);
      line.style.display = inView ? 'block' : 'none';
      line.style.transform = `translateX(${Math.round(x)}px)`;
    }
    const text = formatTime(position, true);
    if ($('edTime').textContent !== text) $('edTime').textContent = text;
  }

  /** Ít track thì mỗi hàng cao lên để sóng âm dùng hết khoảng trống. */
  get rowHeight() {
    // Trừ thêm 1 điểm ảnh: làm tròn có thể làm hiện thanh cuộn thừa.
    const available = $('edTimeline').clientHeight - RULER_HEIGHT - 1;
    const fair = Math.floor(available / Math.max(1, this.tracks.length));
    return Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, fair));
  }

  drawTimeline() {
    const canvas = $('edCanvas');
    const wrap = $('edCanvasWrap');
    const width = wrap.clientWidth;
    const rowHeight = this.rowHeight;
    $('edHeaders').style.setProperty('--row-height', `${rowHeight}px`);
    const contentHeight = RULER_HEIGHT + this.tracks.length * rowHeight;
    const height = Math.max(contentHeight, $('edTimeline').clientHeight);
    canvas.style.height = `${height}px`;
    const { context: g } = fitCanvas(canvas, width, height);
    g.fillStyle = TOKENS.bg;
    g.fillRect(0, 0, width, height);

    this.drawRuler(g, width);
    this.tracks.forEach((track, index) => this.drawTrack(g, track, index, width));

    if (this.selection) {
      const x1 = this.xOf(this.selection.start);
      const x2 = this.xOf(this.selection.end);
      g.fillStyle = 'rgba(255,157,46,0.2)';
      g.fillRect(x1, RULER_HEIGHT, x2 - x1, height - RULER_HEIGHT);
      g.fillStyle = TOKENS.accent;
      g.fillRect(x1, 0, 1, height);
      g.fillRect(x2, 0, 1, height);
      g.fillRect(x1, RULER_HEIGHT - 3, x2 - x1, 3);
    }
  }

  drawRuler(g, width) {
    g.fillStyle = TOKENS.bg2;
    g.fillRect(0, 0, width, RULER_HEIGHT);
    g.fillStyle = TOKENS.line;
    g.fillRect(0, RULER_HEIGHT - 1, width, 1);
    const steps = [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((value) => value * this.view.pps >= 70) || 600;
    const first = Math.floor(this.view.start / step) * step;
    g.font = '11px "Segoe UI", sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (let t = first; this.xOf(t) < width; t += step) {
      const x = this.xOf(t);
      g.fillStyle = TOKENS.lineStrong;
      g.fillRect(Math.round(x), RULER_HEIGHT - 8, 1, 8);
      g.fillStyle = TOKENS.muted;
      const label = step < 1 ? formatTime(t, true) : formatTime(t);
      g.fillText(label, x + 4, RULER_HEIGHT / 2 - 1);
    }
  }

  drawTrack(g, track, index, width) {
    const ROW_HEIGHT = this.rowHeight;
    const top = RULER_HEIGHT + index * ROW_HEIGHT;
    const selected = track.id === this.selectedId;
    const sr = this.sampleRate;
    g.fillStyle = selected ? TOKENS.bg2 : TOKENS.bg;
    g.fillRect(0, top, width, ROW_HEIGHT);
    g.fillStyle = TOKENS.line;
    g.fillRect(0, top + ROW_HEIGHT - 1, width, 1);

    const startSec = track.offset / sr;
    const length = track.channels[0].length;
    const x1 = Math.max(0, this.xOf(startSec));
    const x2 = Math.min(width, this.xOf(startSec + length / sr));
    if (x2 <= x1) return;

    const audible = this.audibleTracks().includes(track);

    const mid = top + (ROW_HEIGHT - 4) / 2;
    const amplitude = (ROW_HEIGHT - 12) * 0.46;
    g.fillStyle = track.color;
    g.globalAlpha = audible ? 0.8 : 0.22;
    const samplesPerPixel = sr / this.view.pps;

    if (samplesPerPixel >= PEAK_BLOCK) {
      const peaks = getPeaks(track.channels);
      for (let x = Math.floor(x1); x < x2; x++) {
        const from = ((this.secondsAt(x) - startSec) * sr) / PEAK_BLOCK;
        const to = from + samplesPerPixel / PEAK_BLOCK;
        const a = Math.max(0, Math.floor(from));
        const b = Math.min(peaks.min.length, Math.max(a + 1, Math.ceil(to)));
        let low = 1;
        let high = -1;
        for (let i = a; i < b; i++) {
          if (peaks.min[i] < low) low = peaks.min[i];
          if (peaks.max[i] > high) high = peaks.max[i];
        }
        if (high < low) continue;
        const y1 = mid - Math.min(1, high) * amplitude;
        const y2 = mid - Math.max(-1, low) * amplitude;
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    } else {
      const data = track.channels[0];
      if (samplesPerPixel > 1) {
        for (let x = Math.floor(x1); x < x2; x++) {
          const a = Math.max(0, Math.floor((this.secondsAt(x) - startSec) * sr));
          const b = Math.min(length, Math.ceil(a + samplesPerPixel));
          let low = 1;
          let high = -1;
          for (let i = a; i < b; i++) {
            if (data[i] < low) low = data[i];
            if (data[i] > high) high = data[i];
          }
          if (high < low) continue;
          g.fillRect(x, mid - high * amplitude, 1, Math.max(1, (high - low) * amplitude));
        }
      } else {
        g.strokeStyle = track.color;
        g.beginPath();
        for (let x = Math.floor(x1); x < x2; x++) {
          const i = Math.floor((this.secondsAt(x) - startSec) * sr);
          const y = mid - (data[Math.max(0, Math.min(length - 1, i))] || 0) * amplitude;
          if (x === Math.floor(x1)) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (audible) this.addWaveGlow(g, x1, top, x2 - x1, ROW_HEIGHT - 1, width);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(x1, mid, x2 - x1, 1);
  }

  /** Quầng sáng: chồng bản làm mờ của chính vùng vừa vẽ lên trên. */
  addWaveGlow(g, x, y, w, h, cssWidth) {
    const ratio = g.canvas.width / cssWidth;
    const sx = Math.floor(x * ratio);
    const sy = Math.floor(y * ratio);
    const sw = Math.ceil(w * ratio);
    const sh = Math.ceil(h * ratio);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.beginPath();
    g.rect(sx, sy, sw, sh);
    g.clip();
    g.filter = `blur(${(6 * ratio).toFixed(1)}px)`;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.42;
    g.drawImage(g.canvas, sx, sy, sw, sh, sx, sy, sw, sh);
    g.restore();
  }

  drawPitch() {
    const canvas = $('edPitch');
    if (!canvas.clientWidth) return;
    const { context: g, width, height } = fitCanvas(canvas);
    g.fillStyle = TOKENS.bg;
    g.fillRect(0, 0, width, height);

    const { center, semitoneHeight } = this.pitchView;
    const yOf = (midi) => height / 2 - (midi - center) * semitoneHeight;
    const mask = scaleMask(this.root, this.scale);
    const lowest = Math.floor(center - height / (2 * semitoneHeight)) - 1;
    const highest = Math.ceil(center + height / (2 * semitoneHeight)) + 1;
    const stripe = g.createLinearGradient(0, 0, width, 0);
    stripe.addColorStop(0, 'rgba(34,211,238,0.34)');
    stripe.addColorStop(0.5, 'rgba(168,85,247,0.2)');
    stripe.addColorStop(1, 'rgba(255,95,162,0.14)');
    const dimStripe = g.createLinearGradient(0, 0, width, 0);
    dimStripe.addColorStop(0, 'rgba(34,211,238,0.1)');
    dimStripe.addColorStop(0.5, 'rgba(168,85,247,0.06)');
    dimStripe.addColorStop(1, 'rgba(255,95,162,0.04)');
    g.font = '10.5px "Segoe UI", sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let midi = lowest; midi <= highest; midi++) {
      const pc = ((midi % 12) + 12) % 12;
      const y = yOf(midi);
      g.fillStyle = mask[pc] ? stripe : dimStripe;
      g.fillRect(0, y - semitoneHeight / 2 + 0.5, width, semitoneHeight - 1);
      if (mask[pc] && pc === this.root) {
        g.fillStyle = 'rgba(255,157,46,0.16)';
        g.fillRect(0, y - semitoneHeight / 2 + 0.5, width, semitoneHeight - 1);
      }
    }

    const track = this.selectedTrack;
    if (track && track.pitch) this.drawNotes(g, track, yOf, width, height, semitoneHeight);

    // Nhãn nốt đè lên trên để luôn đọc được.
    for (let midi = lowest; midi <= highest; midi++) {
      const pc = ((midi % 12) + 12) % 12;
      if (semitoneHeight < 11 && !mask[pc]) continue;
      g.fillStyle = mask[pc] ? TOKENS.text : TOKENS.muted;
      g.fillText(NOTE_NAMES[pc] + (Math.floor(midi / 12) - 1), 5, yOf(midi));
    }

    if (this.selection) {
      g.fillStyle = 'rgba(255,157,46,0.14)';
      const x1 = this.xOf(this.selection.start);
      g.fillRect(x1, 0, this.xOf(this.selection.end) - x1, height);
    }
  }

  drawNotes(g, track, yOf, width, height, semitoneHeight) {
    const { analysis, notes, outMidi } = track.pitch;
    const { hop, f0 } = analysis;
    const sr = this.sampleRate;
    const offsetSec = track.offset / sr;
    const frameSec = hop / sr;
    const firstFrame = Math.max(0, Math.floor((this.view.start - offsetSec) / frameSec));
    const lastFrame = Math.min(f0.length - 1, Math.ceil((this.secondsAt(width) - offsetSec) / frameSec));
    const stride = Math.max(1, Math.floor((lastFrame - firstFrame) / (width * 2)));

    for (const note of notes) {
      const x1 = this.xOf(offsetSec + note.start * frameSec);
      const x2 = this.xOf(offsetSec + note.end * frameSec);
      if (x2 < 0 || x1 > width) continue;
      const moved = Math.abs(note.shift) > 0.005 || note.flatten > 0;
      const selected = this.selectedNotes.has(note.id);
      const y = yOf(note.pitch + note.shift);
      const h = Math.max(6, semitoneHeight - 2);
      g.fillStyle = selected ? 'rgba(255,157,46,0.6)' : moved ? 'rgba(255,157,46,0.32)' : 'rgba(34,211,238,0.28)';
      g.strokeStyle = selected ? '#ffd9a3' : moved ? TOKENS.accent : TOKENS.raw;
      g.beginPath();
      g.roundRect(x1, y - h / 2, Math.max(2, x2 - x1), h, 3);
      g.fill();
      g.stroke();
      if (Math.abs(note.shift) > 0.02) {
        // Bóng mờ tại cao độ gốc cho thấy nốt đã đi bao xa.
        const originalY = yOf(note.pitch);
        g.setLineDash([3, 3]);
        g.strokeStyle = TOKENS.faint;
        g.strokeRect(x1, originalY - h / 2, Math.max(2, x2 - x1), h);
        g.setLineDash([]);
      }
    }

    const drawCurve = (getValue, color, lineWidth, alpha) => {
      g.beginPath();
      let drawing = false;
      for (let i = firstFrame; i <= lastFrame; i += stride) {
        const value = getValue(i);
        if (value <= 0) {
          drawing = false;
          continue;
        }
        const x = this.xOf(offsetSec + i * frameSec);
        const y = yOf(value);
        if (drawing) g.lineTo(x, y);
        else g.moveTo(x, y);
        drawing = true;
      }
      strokeWithGlow(g, color, lineWidth, alpha);
    };
    drawCurve((i) => (f0[i] > 0 ? hzToMidi(f0[i]) : 0), TOKENS.raw, 1, 0.75);
    if (outMidi) drawCurve((i) => outMidi[i], TOKENS.accent, 1.6, 1);
  }
}
