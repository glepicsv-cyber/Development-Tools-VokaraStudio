// Màn hát karaoke: mic trực tiếp, nhạc nền, lời bài hát, ghi âm.

import { $, createSlider, fitCanvas, formatTime, neonRamp, PRESETS, setStatus, toast, TOKENS } from './common.js';
import { PitchRoll } from './pitchroll.js';
import { NOTE_NAMES, SCALES, midiToName, scaleMask } from '../dsp/scales.js';
import { VOICE_RANGES } from '../dsp/realtime.js';
import { DEFAULT_FX } from '../audio/fxchain.js';
import { runJob } from '../audio/jobs.js';
import { mixToMono } from '../dsp/edit-ops.js';
import { normalizeWebInput } from './web-url.js';

const SETTINGS_KEY = 'vokara.karaoke.v1';

const WEB_CAPTURE_ATTEMPTS = 3;
const WEB_CAPTURE_RETRY_MS = 1500;
const LIVE_LEVEL_POINTS = 400;
const OVERVIEW_BAR_WIDTH = 5;
const OVERVIEW_BAR_STEP = 8;
const OVERVIEW_MIN_BAR = 4;
const AUTO_KEY_AFTER_SECONDS = 20;
const MIN_KEY_SECONDS = 5;
const SIGNAL_THRESHOLD = 0.004;
const NO_SIGNAL_WARNING_SECONDS = 6;
const LIVE_BEAT_NOTES = {
  web: 'Tốc độ và giảm lời ca chỉ dùng được với file nhạc.',
  system: 'Nhạc đang phát thẳng từ app đó ra loa nên không đổi được tông ở đây. Cần đổi tông thì mở bài qua nguồn Trang web.',
};
const SOURCE_HINTS = {
  file: '',
  web: 'Phát nhạc ngay trong khung này. Nhạc và giọng thu thành các track riêng.',
  system: 'Mở nhạc ở Spotify, trình duyệt hay app bất kỳ rồi hát. Âm lượng nhạc chỉnh ngay trong app đó.',
};

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

/** Đọc file LRC thành các dòng có thời gian, bỏ thẻ siêu dữ liệu. */
export function parseLrc(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const stamp of stamps) {
      lines.push({ time: Number(stamp[1]) * 60 + Number(stamp[2].replace(':', '.')), text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Số giây có tiếng thật trong một đoạn tín hiệu, xét từng khung 100 ms. */
function countSignalSeconds(samples, sampleRate) {
  const frame = Math.round(sampleRate / 10);
  let frames = 0;
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let peak = 0;
    for (let i = start; i < start + frame; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak > SIGNAL_THRESHOLD) frames++;
  }
  return frames / 10;
}

export class KaraokeView {
  constructor(engine, callbacks) {
    this.engine = engine;
    this.callbacks = callbacks;
    const saved = readSettings();
    this.state = {
      root: saved.root ?? 0,
      scale: saved.scale ?? 'chromatic',
      enabled: saved.enabled ?? true,
      retuneMs: saved.retuneMs ?? 90,
      amount: saved.amount ?? 0.85,
      transpose: saved.transpose ?? 0,
      formant: saved.formant ?? 0,
      voice: saved.voice ?? 'mid',
      fx: { ...DEFAULT_FX, reverb: 0.3, echo: 0.15, presence: 1.5, comp: 0.4, ...(saved.fx || {}) },
      gateDb: saved.gateDb ?? -55,
      micGain: saved.micGain ?? 0,
      beatDb: saved.beatDb ?? -3,
      vocalDb: saved.vocalDb ?? 0,
      preset: saved.preset ?? null,
      monitor: saved.monitor ?? true,
      inputId: saved.inputId ?? '',
      outputId: saved.outputId ?? '',
    };
    this.beatSettings = { semitones: 0, tempo: 1, vocalReduce: 0 };
    this.beatName = '';
    this.lyrics = [];
    this.take = null;
    this.prepareToken = 0;
    this.peaks = null;
    this.source = 'file';
    this.sourceToken = 0;
    this.viewVisible = true;
    this.webState = { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, playing: false };
    this.liveLevels = new Float32Array(LIVE_LEVEL_POINTS);
    this.liveLevelAt = 0;
    this.liveStartedAt = 0;
    this.liveSignalSeconds = 0;
    this.liveLastTick = 0;
    this.keyLocked = false;
    this.autoKeyDone = false;

    this.roll = new PitchRoll($('pitchRoll'));
    this.buildControls();
    this.bindEvents();
    this.refreshScale();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.state));
    } catch {
      /* lưu cài đặt là tuỳ chọn */
    }
  }

  buildControls() {
    const s = this.state;

    const chips = $('presetChips');
    for (const preset of PRESETS) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = preset.name;
      chip.dataset.preset = preset.id;
      chip.addEventListener('click', () => this.applyPreset(preset));
      chips.append(chip);
    }

    const keyGrid = $('keyGrid');
    NOTE_NAMES.forEach((name, pc) => {
      const button = document.createElement('button');
      button.className = 'key-btn';
      button.textContent = name;
      button.dataset.pc = pc;
      button.addEventListener('click', () => {
        s.root = pc;
        this.keyLocked = true;
        $('keyHint').textContent = '';
        this.refreshScale();
      });
      keyGrid.append(button);
    });

    const scaleSelect = $('scaleSelect');
    for (const [id, scale] of Object.entries(SCALES)) scaleSelect.add(new Option(scale.label, id));
    scaleSelect.value = s.scale;

    const voiceSelect = $('voiceSelect');
    for (const [id, voice] of Object.entries(VOICE_RANGES)) voiceSelect.add(new Option(voice.label, id));
    voiceSelect.value = s.voice;

    $('tuneEnabled').checked = s.enabled;
    $('monitorToggle').checked = s.monitor;

    const pct = (v) => `${Math.round(v * 100)}%`;
    const signedDb = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    const signedSt = (v) => (v === 0 ? 'Giữ nguyên' : `${v > 0 ? '+' : ''}${v} cung`);
    const tune = $('tuneSliders');
    this.sliders = {
      retune: createSlider({
        label: 'Tốc độ bắt nốt',
        min: 0,
        max: 400,
        step: 5,
        value: s.retuneMs,
        title: '0 ms: bẻ nốt tức thì. Càng lớn càng giữ luyến láy tự nhiên.',
        format: (v) => (v === 0 ? 'Tức thì' : `${v} ms`),
        onInput: (v) => this.updateTune({ retuneMs: v }, true),
      }),
      amount: createSlider({
        label: 'Mức chỉnh',
        min: 0,
        max: 1,
        step: 0.01,
        value: s.amount,
        format: pct,
        onInput: (v) => this.updateTune({ amount: v }, true),
      }),
      transpose: createSlider({
        label: 'Đổi tông giọng',
        min: -12,
        max: 12,
        step: 1,
        value: s.transpose,
        format: signedSt,
        onInput: (v) => this.updateTune({ transpose: v }),
      }),
      formant: createSlider({
        label: 'Độ dày giọng',
        min: -6,
        max: 6,
        step: 0.5,
        value: s.formant,
        title: 'Âm: giọng dày, trầm ấm hơn. Dương: giọng mảnh, trẻ hơn.',
        format: (v) => (v === 0 ? 'Giữ nguyên' : `${v > 0 ? '+' : ''}${v}`),
        onInput: (v) => this.updateTune({ formant: v }),
      }),
    };
    tune.append(this.sliders.retune.root, this.sliders.amount.root, this.sliders.transpose.root, this.sliders.formant.root);

    const fx = $('fxSliders');
    const fxSlider = (key, label, min, max, step, format, title) => {
      const slider = createSlider({
        label,
        min,
        max,
        step,
        value: s.fx[key],
        format,
        title,
        onInput: (v) => {
          s.fx[key] = v;
          this.applyFx();
          this.clearPreset();
        },
      });
      this.sliders[`fx_${key}`] = slider;
      fx.append(slider.root);
    };
    fxSlider('reverb', 'Vang phòng', 0, 1, 0.01, pct);
    fxSlider('reverbSize', 'Độ rộng phòng', 0.6, 4, 0.1, (v) => `${v.toFixed(1)} s`);
    fxSlider('echo', 'Tiếng lặp (echo)', 0, 1, 0.01, pct);
    fxSlider('echoTime', 'Khoảng lặp', 0.08, 0.7, 0.01, (v) => `${Math.round(v * 1000)} ms`);
    fxSlider('echoFeedback', 'Số lần lặp', 0, 0.8, 0.01, pct);
    fxSlider('low', 'Ấm giọng', -6, 6, 0.5, signedDb);
    fxSlider('presence', 'Rõ lời', -6, 6, 0.5, signedDb);
    fxSlider('air', 'Sáng giọng', -6, 6, 0.5, signedDb);
    fxSlider('comp', 'Nén (đều giọng)', 0, 1, 0.01, pct, 'Làm tiếng to tiếng nhỏ đều nhau hơn');

    const beat = $('beatSliders');
    this.beatToneSlider = createSlider({
      label: 'Tông nhạc',
      min: -6,
      max: 6,
      step: 1,
      value: 0,
      title: 'Nâng hoặc hạ tông nhạc nền cho vừa giọng. Tông chỉnh giọng sẽ đi theo.',
      format: signedSt,
      onInput: () => this.schedulePrepareBeat(),
    });
    this.beatTempoSlider = createSlider({
      label: 'Tốc độ',
      min: 0.8,
      max: 1.2,
      step: 0.01,
      value: 1,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: () => this.schedulePrepareBeat(),
    });
    this.beatVocalSlider = createSlider({
      label: 'Giảm lời ca gốc',
      min: 0,
      max: 1,
      step: 0.05,
      value: 0,
      title: 'Chỉ có tác dụng với bản stereo có giọng ca nằm chính giữa.',
      format: (v) => (v === 0 ? 'Tắt' : pct(v)),
      onInput: () => this.schedulePrepareBeat(),
    });
    beat.append(this.beatToneSlider.root, this.beatTempoSlider.root, this.beatVocalSlider.root);

    const mic = $('micSliders');
    this.sliders.micGain = createSlider({
      label: 'Độ nhạy mic',
      min: -12,
      max: 24,
      step: 0.5,
      value: s.micGain,
      format: signedDb,
      onInput: (v) => {
        s.micGain = v;
        this.applyGains();
      },
    });
    this.sliders.gate = createSlider({
      label: 'Lọc tiếng ồn khi im',
      min: -80,
      max: -30,
      step: 1,
      value: s.gateDb,
      title: 'Tiếng nhỏ hơn mức này sẽ bị tắt để không nghe tiếng ồn phòng.',
      format: (v) => (v <= -80 ? 'Tắt' : `${v} dB`),
      onInput: (v) => {
        s.gateDb = v;
        this.engine.setVoiceParams({ gateDb: v <= -80 ? -200 : v });
        this.saveSettings();
      },
    });
    mic.append(this.sliders.micGain.root, this.sliders.gate.root);

    this.sliders.beatVol = createSlider({
      label: 'Nhạc',
      min: -40,
      max: 6,
      step: 0.5,
      value: s.beatDb,
      format: signedDb,
      onInput: (v) => {
        s.beatDb = v;
        this.applyGains();
      },
    });
    this.sliders.vocalVol = createSlider({
      label: 'Giọng',
      min: -40,
      max: 6,
      step: 0.5,
      value: s.vocalDb,
      format: signedDb,
      onInput: (v) => {
        s.vocalDb = v;
        this.applyGains();
      },
    });
    $('beatVolumeSlot').append(this.sliders.beatVol.root);
    $('vocalVolumeSlot').append(this.sliders.vocalVol.root);

    if (s.preset) this.markPreset(s.preset);
  }

  bindEvents() {
    const s = this.state;
    $('startMicBtn').addEventListener('click', () => this.toggleMicFromCard());
    $('micBtn').addEventListener('click', () => this.toggleMic());
    $('micSwitch').addEventListener('change', () => this.toggleMic());
    $('startBeatBtn').addEventListener('click', () => this.openBeat());
    $('openBeatBtn').addEventListener('click', () => this.openBeat());
    $('openLyricsBtn').addEventListener('click', () => this.openLyrics());
    $('beatPlayBtn').addEventListener('click', () => this.togglePlay());
    $('beatStopBtn').addEventListener('click', () => this.stopBeat());
    $('recordBtn').addEventListener('click', () => this.toggleRecord());
    $('detectKeyBtn').addEventListener('click', () => this.detectKey(false));
    $('tuneEnabled').addEventListener('change', (event) => this.updateTune({ enabled: event.target.checked }));
    $('scaleSelect').addEventListener('change', (event) => {
      s.scale = event.target.value;
      this.keyLocked = true;
      this.refreshScale();
    });
    $('voiceSelect').addEventListener('change', (event) => {
      s.voice = event.target.value;
      this.engine.setVoiceParams({ voice: s.voice });
      this.saveSettings();
    });
    $('monitorToggle').addEventListener('change', (event) => {
      s.monitor = event.target.checked;
      this.engine.setMonitor(s.monitor);
      this.saveSettings();
    });
    $('inputSelect').addEventListener('change', async (event) => {
      s.inputId = event.target.value;
      this.saveSettings();
      if (this.engine.micActive) await this.startMic();
    });
    $('outputSelect').addEventListener('change', async (event) => {
      s.outputId = event.target.value;
      this.saveSettings();
      try {
        await this.engine.setOutputDevice(s.outputId);
      } catch (error) {
        toast(`Không chuyển được loa: ${error.message}`, { error: true });
      }
    });
    $('beatOverview').addEventListener('pointerdown', (event) => this.seekFromEvent(event));
    $('takeExportBtn').addEventListener('click', () => this.callbacks.exportTake(this.take, this.collectBeat()));
    $('takeEditBtn').addEventListener('click', () => this.callbacks.openTake(this.take, this.collectBeat()));
    $('takeDiscardBtn').addEventListener('click', () => this.discardTake());

    document.querySelectorAll('.source-btn').forEach((button) => {
      button.addEventListener('click', () => this.selectSource(button.dataset.source));
    });
    $('webForm').addEventListener('submit', (event) => {
      event.preventDefault();
      this.openWeb($('webAddress').value);
      $('webAddress').blur();
    });
    $('webSites').addEventListener('click', (event) => {
      const url = event.target.dataset && event.target.dataset.url;
      if (url) this.openWeb(url);
    });
    $('webBack').addEventListener('click', () => window.vokaraHost.webCommand('back'));
    $('webForward').addEventListener('click', () => window.vokaraHost.webCommand('forward'));
    $('webReload').addEventListener('click', () => window.vokaraHost.webCommand('reload'));
    window.vokaraHost.onWebState((state) => this.onWebState(state));
    window.vokaraHost.onWebError(({ description }) => {
      toast(`Không mở được trang này (${description}). Hãy kiểm tra mạng hoặc địa chỉ.`, { error: true, ms: 6000 });
    });
    new ResizeObserver(() => this.syncWebBounds()).observe($('webHost'));
    window.addEventListener('resize', () => this.syncWebBounds());
    this.engine.addEventListener('live-lost', (event) => this.onLiveLost(event.detail.kind));

    this.engine.addEventListener('latency', () => this.renderLatency());
    this.engine.addEventListener('beat-ended', () => {
      if (this.engine.recording) this.toggleRecord();
      this.refreshTransport();
    });
    this.engine.addEventListener('mic-lost', () => {
      toast('Mất kết nối với mic. Hãy kiểm tra thiết bị rồi bật lại.', { error: true });
      this.refreshMicUi();
    });
    navigator.mediaDevices.addEventListener('devicechange', () => this.refreshDevices());
    window.addEventListener('resize', () => this.drawOverview());
  }

  // ---------- Tham số ----------

  applyAllToEngine() {
    const s = this.state;
    this.engine.setVoiceParams({
      voice: s.voice,
      root: s.root,
      scale: s.scale,
      retuneMs: s.retuneMs,
      amount: s.amount,
      transpose: s.transpose,
      enabled: s.enabled,
      formant: s.formant,
      gateDb: s.gateDb <= -80 ? -200 : s.gateDb,
      comp: s.fx.comp,
    });
    this.applyFx();
    this.applyGains();
    this.engine.setMonitor(s.monitor);
  }

  updateTune(partial, leavesPreset = false) {
    Object.assign(this.state, partial);
    this.engine.setVoiceParams(partial);
    if (leavesPreset) this.clearPreset();
    this.saveSettings();
  }

  applyFx() {
    const { engine, state } = this;
    if (engine.vocalChain) engine.vocalChain.apply(state.fx);
    engine.setVoiceParams({ comp: state.fx.comp });
    this.saveSettings();
  }

  applyGains() {
    const { engine, state } = this;
    if (!engine.context) return;
    const gain = (db) => Math.pow(10, db / 20);
    const now = engine.context.currentTime;
    engine.micGain.gain.setTargetAtTime(gain(state.micGain), now, 0.01);
    engine.vocalBus.gain.setTargetAtTime(gain(state.vocalDb), now, 0.01);
    engine.beat.gain.gain.setTargetAtTime(gain(state.beatDb), now, 0.01);
    this.saveSettings();
  }

  applyPreset(preset) {
    const s = this.state;
    Object.assign(s, preset.tune);
    Object.assign(s.fx, preset.fx);
    s.preset = preset.id;
    this.sliders.retune.set(s.retuneMs);
    this.sliders.amount.set(s.amount);
    for (const key of Object.keys(preset.fx)) {
      if (this.sliders[`fx_${key}`]) this.sliders[`fx_${key}`].set(s.fx[key]);
    }
    this.engine.setVoiceParams(preset.tune);
    this.applyFx();
    this.markPreset(preset.id);
  }

  markPreset(id) {
    document.querySelectorAll('#presetChips .chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.preset === id);
    });
  }

  clearPreset() {
    this.state.preset = null;
    this.markPreset(null);
  }

  refreshScale() {
    const s = this.state;
    document.querySelectorAll('#keyGrid .key-btn').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.pc) === s.root && s.scale !== 'chromatic');
    });
    $('scaleSelect').value = s.scale;
    this.roll.setScale(scaleMask(s.root, s.scale), s.scale === 'chromatic' ? -1 : s.root);
    this.engine.setVoiceParams({ root: s.root, scale: s.scale });
    this.saveSettings();
  }

  // ---------- Thiết bị ----------

  async refreshDevices() {
    const { inputs, outputs } = await this.engine.listDevices();
    const fill = (select, devices, current, fallback) => {
      select.innerHTML = '';
      select.add(new Option(`Mặc định của Windows`, ''));
      devices.forEach((device, index) => {
        if (device.deviceId === 'default' || device.deviceId === 'communications') return;
        select.add(new Option(device.label || `${fallback} ${index + 1}`, device.deviceId));
      });
      select.value = devices.some((device) => device.deviceId === current) ? current : '';
    };
    fill($('inputSelect'), inputs, this.state.inputId, 'Mic');
    fill($('outputSelect'), outputs, this.state.outputId, 'Loa');
  }

  async toggleMic() {
    if (this.engine.recording) return;
    if (this.engine.micActive) {
      this.engine.disableMic();
      this.refreshMicUi();
    } else {
      await this.startMic();
    }
  }

  async startMic() {
    try {
      await this.engine.enableMic(this.state.inputId);
      this.micEverOn = true;
      this.applyAllToEngine();
      await this.refreshDevices();
      if (this.state.outputId) await this.engine.setOutputDevice(this.state.outputId).catch(() => {});
    } catch (error) {
      const denied = error.name === 'NotAllowedError' || error.name === 'SecurityError';
      const missing = error.name === 'NotFoundError' || error.name === 'OverconstrainedError';
      const message = denied
        ? 'Windows đang chặn mic. Mở Settings → Privacy → Microphone và cho phép ứng dụng dùng mic.'
        : missing
          ? 'Không tìm thấy mic. Hãy cắm mic rồi thử lại.'
          : `Không bật được mic: ${error.message}`;
      toast(message, { error: true, ms: 7000 });
    }
    this.refreshMicUi();
  }

  async toggleMicFromCard() {
    if (!this.engine.micActive) await this.startMic();
  }

  refreshMicUi() {
    const hasMic = this.engine.micActive;
    $('startMicBtn').textContent = hasMic ? 'Mic đã bật' : 'Bật mic';
    $('startMicBtn').disabled = hasMic;
    const micBtn = $('micBtn');
    micBtn.classList.toggle('on', hasMic);
    micBtn.setAttribute('aria-pressed', String(hasMic));
    micBtn.title = hasMic ? 'Tắt mic (M)' : 'Bật mic (M)';
    micBtn.setAttribute('aria-label', hasMic ? 'Tắt mic' : 'Bật mic');
    $('micSwitch').checked = hasMic;
    this.refreshStartCard();
    this.renderLatency();
  }

  refreshStartCard() {
    // Thẻ này chỉ để bắt đầu: người dùng chủ động tắt mic thì không hiện lại che màn hình.
    $('startCard').hidden = this.engine.micActive || !!this.micEverOn;
    $('startBeatBtn').hidden = !!this.engine.beat.buffer || this.isLive;
  }

  renderLatency() {
    const breakdown = this.engine.latencyBreakdown();
    const info = $('latencyInfo');
    if (!breakdown || !this.engine.micActive) {
      info.textContent = this.micEverOn ? 'Mic đang tắt' : 'Chưa bật mic';
      return;
    }
    const ms = (v) => `${Math.round(v * 1000)} ms`;
    info.textContent = `Độ trễ ước tính ${ms(breakdown.total)}: thu ${ms(breakdown.input)}, chỉnh giọng ${ms(breakdown.algorithm)}, phát ${ms(breakdown.output)}`;
  }

  // ---------- Nhạc nền ----------

  // ---------- Nguồn nhạc ----------

  get isLive() {
    return this.source !== 'file';
  }

  /** Chuyển giữa file nhạc, trang web trong ứng dụng và âm thanh của app khác. */
  async selectSource(kind) {
    if (kind === this.source) return;
    const { engine } = this;
    if (engine.recording) await this.toggleRecord();
    const token = ++this.sourceToken;
    const previous = this.source;

    clearTimeout(this.prepareTimer);
    this.prepareToken++;
    engine.stopLive();
    engine.pauseBeat();
    engine.setBeatBuffer(null);
    if (previous === 'web') await window.vokaraHost.webClose();

    this.source = kind;
    this.resetBeatControls();
    this.resetLiveAnalysis();
    this.liveLevels.fill(0);
    this.liveStartedAt = performance.now() / 1000;
    $('webPanel').hidden = kind !== 'web';
    if (kind === 'web') $('webAddress').value = '';
    // Bắt âm thanh mất một lúc: cập nhật giao diện trước để không có khoảng trống chưa khoá.
    this.refreshSourceUi();

    if (kind === 'file') {
      const original = engine.beat.original;
      if (original) {
        engine.setBeatBuffer(original);
        this.computePeaks();
      } else {
        this.peaks = null;
      }
    } else {
      try {
        if (kind === 'web') {
          await window.vokaraHost.webOpen(null);
          this.syncWebBounds();
        } else {
          await engine.startLive(kind);
          if (token !== this.sourceToken) return;
          this.applyAllToEngine();
        }
      } catch (error) {
        if (token !== this.sourceToken) return;
        toast(`Không lấy được âm thanh: ${error.message}`, { error: true, ms: 7000 });
        await this.selectSource('file');
        return;
      }
    }
    this.refreshSourceUi();
  }

  resetBeatControls() {
    this.beatToneSlider.set(0);
    this.beatTempoSlider.set(1);
    this.beatVocalSlider.set(0);
    this.beatSettings = { semitones: 0, tempo: 1, vocalReduce: 0 };
    this.engine.setLiveSemitones(0);
  }

  /** Quên phần đã nghe, dùng khi đổi nguồn hoặc sang bài khác. */
  resetLiveAnalysis() {
    const { live } = this.engine;
    live.keyChunks = [];
    live.keySamples = 0;
    this.liveSignalSeconds = 0;
    this.autoKeyDone = false;
    this.keyLocked = false;
  }

  refreshSourceUi() {
    const live = this.isLive;
    document.querySelectorAll('.source-btn').forEach((button) => {
      const active = button.dataset.source === this.source;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const hint = $('sourceHint');
    hint.textContent = SOURCE_HINTS[this.source];
    hint.classList.remove('warn');

    const openBeat = $('openBeatBtn');
    openBeat.disabled = live;
    const name = this.liveSourceName() || this.beatName || 'Mở nhạc nền…';
    openBeat.textContent = name;
    openBeat.title = name;

    $('beatPlayBtn').disabled = this.source === 'system';
    $('beatStopBtn').disabled = this.source === 'system';
    $('openLyricsBtn').disabled = live;
    $('detectKeyBtn').disabled = !live && !this.engine.beat.original;
    this.sliders.beatVol.input.disabled = this.source === 'system';

    const status = $('beatStatus');
    status.hidden = !live;
    status.textContent = LIVE_BEAT_NOTES[this.source] || '';

    if (live) $('beatTime').textContent = 'Trực tiếp';
    else if (!this.engine.beat.buffer) $('beatTime').textContent = '0:00 / 0:00';
    this.refreshLyricsVisibility();
    this.refreshStartCard();
    this.refreshTransport();
    this.syncWebVisibility();
    this.drawOverview();
  }

  liveSourceName() {
    if (this.source === 'system') return 'Âm thanh từ app khác';
    if (this.source === 'web') return this.webState.title || 'Nhạc từ trang web';
    return '';
  }

  // ---------- Khung web ----------

  openWeb(text) {
    const url = normalizeWebInput(text);
    if (!url) {
      toast('Hãy dán một link hoặc gõ tên bài hát.', { error: true });
      return;
    }
    window.vokaraHost.webOpen(url);
  }

  /**
   * Bắt âm thanh của khung web. Phải chờ trang đã vào khung: bắt sớm hơn thì Chromium
   * đứng chờ rồi báo hết giờ nếu mạng chậm. Lần đầu lỗi thì tự thử lại vì thường chỉ do tải chậm.
   */
  async ensureWebCapture() {
    if (this.source !== 'web' || this.engine.live.kind || this.webCapturing || !this.webHasPage()) return;
    const token = this.sourceToken;
    this.webCapturing = true;
    let failure = null;
    try {
      await this.engine.startLive('web');
      if (token !== this.sourceToken) return;
      this.webCaptureAttempts = 0;
      this.applyAllToEngine();
      this.engine.setLiveMuted(!this.viewVisible);
    } catch (error) {
      failure = error;
    } finally {
      this.webCapturing = false;
    }
    if (!failure || token !== this.sourceToken) return;
    this.webCaptureAttempts = (this.webCaptureAttempts ?? 0) + 1;
    if (this.webCaptureAttempts < WEB_CAPTURE_ATTEMPTS) {
      setTimeout(() => {
        if (token === this.sourceToken) this.ensureWebCapture();
      }, WEB_CAPTURE_RETRY_MS);
    } else {
      this.webCaptureAttempts = 0;
      toast(`Không lấy được âm thanh của trang: ${failure.message}. Nhạc vẫn phát nhưng chưa thu và đổi tông được, hãy bấm tải lại trang.`, { error: true, ms: 8000 });
    }
  }

  webHasPage() {
    const { url } = this.webState;
    return !!url && url !== 'about:blank';
  }

  onWebState(state) {
    const previousUrl = this.webState.url;
    this.webState = state;
    if (this.source !== 'web') return;
    $('webBack').disabled = !state.canGoBack;
    $('webForward').disabled = !state.canGoForward;
    const address = $('webAddress');
    if (document.activeElement !== address && this.webHasPage()) address.value = state.url;
    $('webHome').hidden = this.webHasPage();
    if (previousUrl && previousUrl !== state.url) this.resetLiveAnalysis();
    if (!this.engine.recording) {
      const name = this.liveSourceName();
      $('openBeatBtn').textContent = name;
      $('openBeatBtn').title = name;
    }
    this.syncWebVisibility();
    this.refreshTransport();
    this.ensureWebCapture();
  }

  syncWebBounds() {
    if (this.source !== 'web') return;
    const rect = $('webHost').getBoundingClientRect();
    window.vokaraHost.webBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }

  syncWebVisibility() {
    if (this.source !== 'web') return;
    this.syncWebBounds();
    window.vokaraHost.webVisible(this.viewVisible && this.webHasPage());
  }

  /** Màn hát được hiện hoặc ẩn. Khung web nằm đè lên giao diện nên phải ẩn theo. */
  onViewChange(visible) {
    this.viewVisible = visible;
    if (this.source !== 'web') return;
    this.syncWebVisibility();
    this.engine.setLiveMuted(!visible);
    if (!visible) window.vokaraHost.webMedia('pause').catch(() => {});
  }

  async onLiveLost(kind) {
    if (this.source !== kind) return;
    if (this.engine.recording) await this.toggleRecord();
    toast('Mất kết nối với nguồn nhạc, đã quay về chế độ file nhạc.', { error: true, ms: 6000 });
    await this.selectSource('file');
  }

  /** Theo dõi nguồn trực tiếp: mức tín hiệu, cảnh báo im lặng, tự dò tông. */
  tickLive(now) {
    const dt = Math.min(0.2, now - this.liveLastTick);
    this.liveLastTick = now;
    const level = this.engine.liveLevel();
    if (level > SIGNAL_THRESHOLD) this.liveSignalSeconds += dt;

    if (now - this.liveLevelAt >= 0.05) {
      this.liveLevelAt = now;
      this.liveLevels.copyWithin(0, 1);
      this.liveLevels[LIVE_LEVEL_POINTS - 1] = level;
      this.drawOverview();
    }
    if (this.source === 'system') {
      const silent = this.liveSignalSeconds === 0 && now - this.liveStartedAt > NO_SIGNAL_WARNING_SECONDS;
      const hint = $('sourceHint');
      const text = silent ? 'Chưa nghe thấy âm thanh nào. Hãy bật nhạc ở app khác, trên loa mặc định của Windows.' : SOURCE_HINTS.system;
      if (hint.textContent !== text) hint.textContent = text;
      hint.classList.toggle('warn', silent);
    }
    if (!this.autoKeyDone && !this.keyLocked && this.liveSignalSeconds >= AUTO_KEY_AFTER_SECONDS) {
      this.autoKeyDone = true;
      this.detectKey(true).catch(() => {});
    }
  }

  async openBeat() {
    const file = await window.vokaraHost.openAudio({ title: 'Chọn nhạc nền' });
    if (file) await this.loadBeat(file.name, file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength), file.lyrics);
  }

  async loadBeat(name, arrayBuffer, lyricsText) {
    try {
      if (this.isLive) await this.selectSource('file');
      setStatus(`Đang mở ${name}…`);
      const buffer = await this.engine.decode(arrayBuffer);
      this.applyAllToEngine();
      this.engine.beat.original = buffer;
      this.engine.setBeatBuffer(buffer);
      this.beatName = name;
      this.beatToneSlider.set(0);
      this.beatTempoSlider.set(1);
      this.beatVocalSlider.set(0);
      this.beatSettings = { semitones: 0, tempo: 1, vocalReduce: 0 };
      this.refreshSourceUi();
      this.lyrics = lyricsText ? parseLrc(lyricsText) : [];
      this.refreshLyricsVisibility();
      this.computePeaks();
      this.drawOverview();
      this.refreshStartCard();
      this.refreshTransport();
      setStatus(null);
      await this.detectKey(true);
    } catch (error) {
      setStatus(null);
      toast(`Không đọc được file này: ${error.message}`, { error: true });
    }
  }

  async detectKey(isAutomatic) {
    const original = this.engine.beat.original;
    let channels = [];
    let sampleRate;
    if (this.isLive) {
      channels = this.engine.liveSnapshot();
      sampleRate = this.engine.context ? this.engine.context.sampleRate : 0;
      // Xét chính đoạn đã nghe: bộ đếm theo khung hình đứng lại khi cửa sổ bị che.
      if (!channels || countSignalSeconds(channels[0], sampleRate) < MIN_KEY_SECONDS) {
        if (!isAutomatic) toast('Cần nghe nhạc thêm vài giây nữa mới dò được tông.', { error: true });
        return;
      }
    } else {
      if (!original) return;
      sampleRate = original.sampleRate;
      for (let c = 0; c < original.numberOfChannels; c++) channels.push(original.getChannelData(c));
    }
    const samples = mixToMono(channels).slice();
    const key = await runJob('detectKey', { samples, sampleRate });
    const s = this.state;
    s.root = (key.root + this.beatSettings.semitones + 12) % 12;
    s.scale = key.scale;
    this.refreshScale();
    const label = `${NOTE_NAMES[s.root]} ${SCALES[key.scale].label.toLowerCase()}`;
    $('keyHint').textContent = `· dò được ${label}`;
    if (!isAutomatic) toast(`Tông nhạc nền: ${label}`);
  }

  schedulePrepareBeat() {
    if (this.source === 'web') {
      this.applyLiveTone();
      return;
    }
    clearTimeout(this.prepareTimer);
    this.prepareTimer = setTimeout(() => this.prepareBeat(), 260);
  }

  /** Đổi tông nhạc từ trang web ngay khi kéo; tông chỉnh giọng đi theo như với file nhạc. */
  applyLiveTone() {
    const semitones = this.beatToneSlider.get();
    const delta = semitones - this.beatSettings.semitones;
    this.beatSettings = { ...this.beatSettings, semitones };
    this.engine.setLiveSemitones(semitones);
    if (delta !== 0 && this.state.scale !== 'chromatic') {
      this.state.root = (this.state.root + delta + 120) % 12;
      this.refreshScale();
    }
  }

  async prepareBeat() {
    const original = this.engine.beat.original;
    if (!original) return;
    const next = {
      semitones: this.beatToneSlider.get(),
      tempo: this.beatTempoSlider.get(),
      vocalReduce: this.beatVocalSlider.get(),
    };
    const previous = this.beatSettings;
    const delta = next.semitones - previous.semitones;
    const token = ++this.prepareToken;
    this.beatSettings = next;
    if (delta !== 0 && this.state.scale !== 'chromatic') {
      this.state.root = (this.state.root + delta + 120) % 12;
      this.refreshScale();
    }
    if (next.semitones === 0 && next.tempo === 1 && next.vocalReduce === 0) {
      this.engine.setBeatBuffer(original, true);
      this.computePeaks();
      this.drawOverview();
      return;
    }
    const channels = [];
    for (let c = 0; c < original.numberOfChannels; c++) channels.push(original.getChannelData(c).slice());
    setStatus('Đang xử lý nhạc nền…', 0);
    try {
      const { channels: out } = await runJob(
        'prepareBeat',
        { channels, sampleRate: original.sampleRate, ...next },
        (p) => {
          if (token === this.prepareToken) setStatus('Đang xử lý nhạc nền…', p);
        },
      );
      if (token !== this.prepareToken) return; // đã có yêu cầu mới hơn
      const buffer = this.engine.context.createBuffer(out.length, out[0].length, original.sampleRate);
      out.forEach((data, index) => buffer.copyToChannel(data, index));
      this.engine.setBeatBuffer(buffer, true);
      this.computePeaks();
      this.drawOverview();
      setStatus(null);
    } catch (error) {
      setStatus(null);
      toast(`Lỗi xử lý nhạc nền: ${error.message}`, { error: true });
    }
  }

  async togglePlay() {
    if (this.isLive) {
      if (this.engine.recording) {
        await this.toggleRecord();
      } else if (this.source === 'web') {
        const result = await window.vokaraHost.webMedia('toggle').catch(() => null);
        if (result === null) toast('Hãy bấm phát ngay trên trang web.');
      }
      return;
    }
    if (!this.engine.beat.buffer) {
      await this.openBeat();
      return;
    }
    await this.engine.ensure();
    this.applyAllToEngine();
    if (this.engine.recording) {
      await this.toggleRecord();
      return;
    }
    if (this.engine.beat.playing) this.engine.pauseBeat();
    else this.engine.playBeat();
    this.refreshTransport();
  }

  async stopBeat() {
    if (this.engine.recording) await this.toggleRecord();
    if (this.isLive) {
      if (this.source === 'web') await window.vokaraHost.webMedia('pause').catch(() => {});
      return;
    }
    this.engine.pauseBeat();
    this.engine.seekBeat(0);
    this.refreshTransport();
  }

  refreshTransport() {
    const playing = this.source === 'web' ? this.webState.playing : this.engine.beat.playing;
    $('beatPlayBtn').classList.toggle('playing', playing);
    $('recordBtn').classList.toggle('active', !!this.engine.recording);
    // Đổi tông hay tốc độ giữa lúc ghi sẽ làm lệch bản thu so với nhạc.
    const recording = !!this.engine.recording;
    // Tắt mic giữa lúc ghi sẽ làm bản thu mất tiếng mà người dùng không biết.
    $('micBtn').disabled = recording;
    $('micSwitch').disabled = recording;
    this.beatToneSlider.input.disabled = recording || this.source === 'system';
    for (const slider of [this.beatTempoSlider, this.beatVocalSlider]) slider.input.disabled = recording || this.isLive;
  }

  seekFromEvent(event) {
    const beat = this.engine.beat;
    if (!beat.buffer || this.engine.recording) return;
    const rect = event.currentTarget.getBoundingClientRect();
    this.engine.seekBeat(((event.clientX - rect.left) / rect.width) * beat.buffer.duration);
  }

  computePeaks() {
    const buffer = this.engine.beat.buffer;
    if (!buffer) {
      this.peaks = null;
      return;
    }
    const buckets = 1200;
    const peaks = new Float32Array(buckets);
    const data = buffer.getChannelData(0);
    const size = data.length / buckets;
    for (let b = 0; b < buckets; b++) {
      let peak = 0;
      const start = Math.floor(b * size);
      const end = Math.floor((b + 1) * size);
      const stride = Math.max(1, Math.floor((end - start) / 200));
      for (let i = start; i < end; i += stride) peak = Math.max(peak, Math.abs(data[i]));
      peaks[b] = peak;
    }
    this.peaks = peaks;
  }

  drawOverview() {
    const canvas = $('beatOverview');
    if (!canvas.clientWidth) return;
    const { context: g, width, height } = fitCanvas(canvas);
    g.clearRect(0, 0, width, height);
    const beat = this.engine.beat;
    const barCount = Math.max(1, Math.floor(width / OVERVIEW_BAR_STEP));
    if (this.overviewColors?.length !== barCount) this.overviewColors = neonRamp(barCount);
    const colors = this.overviewColors;
    const mid = height / 2;
    const drawBar = (index, level, alpha) => {
      const h = Math.max(OVERVIEW_MIN_BAR, level * height);
      g.globalAlpha = alpha;
      g.fillStyle = colors[index];
      g.beginPath();
      g.roundRect(index * OVERVIEW_BAR_STEP, mid - h / 2, OVERVIEW_BAR_WIDTH, h, 2);
      g.fill();
    };
    if (this.isLive) {
      // Mới nhất ở bên phải, trôi dần sang trái. Căn bậc hai để nhạc nhỏ vẫn thấy rõ.
      for (let i = 0; i < barCount; i++) {
        const from = Math.floor((i / barCount) * LIVE_LEVEL_POINTS);
        const to = Math.max(from + 1, Math.floor(((i + 1) / barCount) * LIVE_LEVEL_POINTS));
        let level = 0;
        for (let p = from; p < to; p++) level = Math.max(level, this.liveLevels[p]);
        drawBar(i, Math.sqrt(level), level > SIGNAL_THRESHOLD ? 1 : 0.35);
      }
    } else if (this.peaks && beat.buffer) {
      const fraction = this.engine.beatPosition() / beat.buffer.duration;
      for (let i = 0; i < barCount; i++) {
        const from = Math.floor((i / barCount) * this.peaks.length);
        const to = Math.max(from + 1, Math.floor(((i + 1) / barCount) * this.peaks.length));
        let peak = 0;
        for (let p = from; p < to; p++) peak = Math.max(peak, this.peaks[p]);
        drawBar(i, peak, i / barCount <= fraction ? 1 : 0.3);
      }
    } else {
      // Chưa có nhạc: dải vạch mờ giữ chỗ để thanh này không trống trơn.
      for (let i = 0; i < barCount; i++) drawBar(i, 0, 0.3);
    }
    g.globalAlpha = 1;
  }

  // ---------- Lời bài hát ----------

  async openLyrics() {
    const file = await window.vokaraHost.openLyrics();
    if (!file) return;
    this.lyrics = parseLrc(file.text);
    if (!this.lyrics.length) toast('File này không có mốc thời gian dạng [phút:giây].', { error: true });
    this.refreshLyricsVisibility();
  }

  refreshLyricsVisibility() {
    $('lyrics').hidden = this.lyrics.length === 0 || this.isLive;
    $('openLyricsBtn').textContent = this.lyrics.length ? `Đã có lời · ${this.lyrics.length} dòng (đổi file)…` : 'Mở lời bài hát (.lrc)…';
  }

  renderLyrics() {
    if (!this.lyrics.length || this.isLive) return;
    // Lời theo mốc của bản gốc, nên đổi tốc độ phải quy đổi thời gian.
    const time = this.engine.beatPosition() * this.beatSettings.tempo;
    let index = -1;
    for (let i = 0; i < this.lyrics.length; i++) {
      if (this.lyrics[i].time <= time) index = i;
      else break;
    }
    const now = index >= 0 ? this.lyrics[index].text : '';
    const next = index + 1 < this.lyrics.length ? this.lyrics[index + 1].text : '';
    if ($('lyricNow').textContent !== now) $('lyricNow').textContent = now;
    if ($('lyricNext').textContent !== next) $('lyricNext').textContent = next;
  }

  // ---------- Ghi âm ----------

  async toggleRecord() {
    if (this.engine.recording) {
      this.stopRecordPromise = this.engine.stopRecording();
      const take = await this.stopRecordPromise;
      this.refreshTransport();
      if (take && take.dry[0].length > 0) {
        this.take = take;
        const seconds = take.dry[0].length / take.sampleRate;
        take.liveName = this.takeLiveName(take);
        const note = take.asHeard ? ' · nhạc và giọng gộp đúng như bạn nghe' : '';
        $('takeInfo').textContent = `Bản thu ${formatTime(seconds)} — chưa lưu${note}`;
        $('takeBar').hidden = false;
        this.callbacks.markDirty();
      }
      return;
    }
    if (!this.engine.micActive) {
      await this.startMic();
      if (!this.engine.micActive) return;
    }
    this.applyAllToEngine();
    await this.engine.startRecording();
    this.refreshTransport();
  }

  takeLiveName(take) {
    if (take.asHeard) return 'Nhạc và giọng như đã nghe';
    // Trình biên tập coi phần sau dấu chấm là đuôi file nên bỏ dấu chấm trong tiêu đề.
    return this.liveSourceName().replace(/\./g, ' ');
  }

  discardTake() {
    this.take = null;
    $('takeBar').hidden = true;
  }

  collectBeat() {
    if (this.take && this.take.liveKind) {
      const { liveBeat, liveName } = this.take;
      return liveBeat && liveBeat[0].length ? { name: liveName, channels: liveBeat } : null;
    }
    const buffer = this.engine.beat.buffer;
    if (!buffer) return null;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
    return { name: this.beatName || 'Nhạc nền', channels };
  }

  // ---------- Vòng vẽ ----------

  loop() {
    requestAnimationFrame(this.loop);
    const view = $('karaokeView');
    if (view.hidden) return;
    const now = performance.now() / 1000;
    const status = this.engine.status;
    const live = this.engine.micActive;
    this.roll.push(now, live ? status.inMidi : 0, live ? status.outMidi : 0, live ? status.note : null);
    this.roll.draw(now);
    this.renderReadout(status, live);
    this.renderLyrics();

    const beat = this.engine.beat;
    if (this.isLive && this.engine.live.kind) this.tickLive(now);
    if (beat.buffer) {
      const text = `${formatTime(this.engine.beatPosition())} / ${formatTime(beat.buffer.duration)}`;
      if ($('beatTime').textContent !== text) $('beatTime').textContent = text;
      const fraction = this.engine.beatPosition() / beat.buffer.duration;
      if (fraction !== this.overviewFraction) {
        this.overviewFraction = fraction;
        this.drawOverview();
      }
    }
  }

  renderReadout(status, live) {
    const name = $('noteName');
    const sub = $('noteSub');
    const needle = $('centsNeedle');
    if (!live || status.inMidi <= 0) {
      if (name.textContent !== '–') name.textContent = '–';
      const text = live ? 'Đang chờ tiếng hát' : this.micEverOn ? 'Mic đang tắt' : 'Chưa bật mic';
      if (sub.textContent !== text) sub.textContent = text;
      needle.style.opacity = 0;
      return;
    }
    const reference = status.note ?? Math.round(status.inMidi);
    const cents = Math.round((status.inMidi - reference) * 100);
    const tuned = midiToName(reference);
    if (name.textContent !== tuned) name.textContent = tuned;
    sub.textContent = `Bạn hát ${cents === 0 ? 'đúng nốt' : cents > 0 ? `cao ${cents} cent` : `thấp ${-cents} cent`}`;
    needle.style.opacity = 1;
    needle.style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
    needle.style.background = Math.abs(cents) <= 15 ? '#7bd88f' : TOKENS.raw;
  }
}
