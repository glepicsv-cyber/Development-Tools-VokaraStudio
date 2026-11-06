// Đồ thị âm thanh của phần hát trực tiếp: mic → chỉnh cao độ → hiệu ứng → loa,
// cùng trình phát nhạc nền và bộ ghi âm.

import { createVocalChain, createSoftLimiter } from './fxchain.js';
import { LIVE_SHIFT_LATENCY } from '../dsp/live-shift.js';

const workletUrl = (name) => new URL(`./${name}`, import.meta.url).href;

// Âm thanh hệ thống đến bộ ghi muộn hơn lúc phát ra loa chừng này (đo trên Windows 10,
// loopback 48 kHz: vòng phát-thu 106 ms trừ đi độ trễ phát 57 ms).
const LOOPBACK_CAPTURE_DELAY = 0.05;
const KEY_WINDOW_SECONDS = 30;

function mergeChunks(chunks, channelCount) {
  const total = chunks.reduce((sum, chunk) => sum + chunk[0].length, 0);
  const out = [];
  for (let c = 0; c < channelCount; c++) {
    const data = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk[c], offset);
      offset += chunk[c].length;
    }
    out.push(data);
  }
  return out;
}

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.context = null;
    this.mic = { stream: null, source: null, deviceId: '' };
    this.voiceLatency = 0;
    this.beat = {
      original: null,
      buffer: null,
      source: null,
      gain: null,
      playing: false,
      startedAt: 0,
      offset: 0,
    };
    this.live = { kind: null, stream: null, source: null, keyChunks: [], keySamples: 0 };
    this.liveToken = 0;
    this.monitorOn = true;
    this.status = { inMidi: 0, outMidi: 0, note: null, rms: 0 };
    this.recording = null;
  }

  async ensure() {
    if (this.context) {
      if (this.context.state === 'suspended') await this.context.resume();
      return this.context;
    }
    const context = new AudioContext({ latencyHint: 0 });
    this.context = context;
    await context.audioWorklet.addModule(workletUrl('voice-worklet.js'));
    await context.audioWorklet.addModule(workletUrl('recorder-worklet.js'));
    await context.audioWorklet.addModule(workletUrl('live-shift-worklet.js'));

    this.limiter = createSoftLimiter(context);
    this.master = context.createGain();
    this.master.connect(this.limiter.input);
    this.limiter.output.connect(context.destination);

    this.micGain = context.createGain();
    this.micHighpass = context.createBiquadFilter();
    this.micHighpass.type = 'highpass';
    this.micHighpass.frequency.value = 70;
    this.micGain.connect(this.micHighpass);

    this.voiceNode = new AudioWorkletNode(context, 'voice-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { voice: 'mid' },
    });
    this.voiceNode.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'status') {
        this.status = data;
        return;
      }
      if (data.type === 'ready') {
        this.voiceLatency = data.latency;
        this.dispatchEvent(new CustomEvent('latency'));
      }
    };
    this.micHighpass.connect(this.voiceNode);

    this.vocalChain = createVocalChain(context);
    this.voiceNode.connect(this.vocalChain.input);
    this.vocalBus = context.createGain();
    this.vocalChain.output.connect(this.vocalBus);
    this.monitor = context.createGain();
    this.vocalBus.connect(this.monitor);
    this.monitor.connect(this.master);

    this.beat.gain = context.createGain();
    this.beat.gain.connect(this.master);

    this.dryRecorder = new AudioWorkletNode(context, 'recorder-node', {
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { channels: 1 },
    });
    this.micHighpass.connect(this.dryRecorder);
    this.wetRecorder = new AudioWorkletNode(context, 'recorder-node', {
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { channels: 2 },
    });
    this.vocalBus.connect(this.wetRecorder);

    // Nhạc lấy trực tiếp từ trang web hoặc app khác.
    this.liveBus = context.createGain();
    this.liveOut = context.createGain();
    this.liveOut.connect(this.beat.gain);
    this.liveAnalyser = context.createAnalyser();
    this.liveAnalyser.fftSize = 2048;
    this.liveBus.connect(this.liveAnalyser);
    const stereoRecorder = () => new AudioWorkletNode(context, 'recorder-node', {
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { channels: 2 },
    });
    // Bản thu lấy sau bộ đổi tông, để khớp với thứ người hát đang nghe.
    this.liveShifter = new AudioWorkletNode(context, 'live-shift', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.liveBus.connect(this.liveShifter);
    this.liveRecorder = stereoRecorder();
    this.liveShifter.connect(this.liveRecorder);
    this.liveKeyRecorder = stereoRecorder();
    this.liveBus.connect(this.liveKeyRecorder);

    this.silentKeepAlive = context.createConstantSource();
    this.silentKeepAlive.offset.value = 0;
    this.silentKeepAlive.connect(this.master);
    this.silentKeepAlive.start();
    if (context.state === 'suspended') await context.resume();
    return context;
  }

  // ---------- Thiết bị ----------

  async listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devices.filter((d) => d.kind === 'audioinput'),
      outputs: devices.filter((d) => d.kind === 'audiooutput'),
    };
  }

  async enableMic(deviceId) {
    await this.ensure();
    this.disableMic();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        latency: 0,
      },
      video: false,
    });
    this.mic.stream = stream;
    this.mic.deviceId = deviceId || '';
    this.mic.source = this.context.createMediaStreamSource(stream);
    this.mic.source.connect(this.micGain);
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      this.disableMic();
      this.dispatchEvent(new CustomEvent('mic-lost'));
    });
    this.dispatchEvent(new CustomEvent('latency'));
  }

  disableMic() {
    if (this.mic.source) this.mic.source.disconnect();
    if (this.mic.stream) this.mic.stream.getTracks().forEach((track) => track.stop());
    this.mic.source = null;
    this.mic.stream = null;
  }

  get micActive() {
    return !!this.mic.stream;
  }

  async setOutputDevice(deviceId) {
    await this.ensure();
    if (this.context.setSinkId) await this.context.setSinkId(deviceId || '');
    this.dispatchEvent(new CustomEvent('latency'));
  }

  /** Ước lượng tổng độ trễ từ mic đến tai, giây. */
  latencyBreakdown() {
    if (!this.context) return null;
    const track = this.mic.stream ? this.mic.stream.getAudioTracks()[0] : null;
    const settings = track ? track.getSettings() : {};
    const input = typeof settings.latency === 'number' && settings.latency > 0 ? settings.latency : 0.01;
    const output = this.context.outputLatency || 0;
    const base = this.context.baseLatency || 0;
    const algorithm = this.voiceLatency;
    return { input, output: output + base, algorithm, total: input + output + base + algorithm };
  }

  setVoiceParams(params) {
    if (this.voiceNode) this.voiceNode.port.postMessage(params);
  }

  setMonitor(on) {
    this.monitorOn = on;
    if (on && this.recording) this.recording.monitorHeard = true;
    if (this.monitor) this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.context.currentTime, 0.01);
  }

  // ---------- Nhạc nền ----------

  async decode(arrayBuffer) {
    await this.ensure();
    return this.context.decodeAudioData(arrayBuffer);
  }

  setBeatBuffer(buffer, keepFraction = false) {
    const beat = this.beat;
    const wasPlaying = beat.playing;
    const fraction = keepFraction && beat.buffer ? this.beatPosition() / beat.buffer.duration : 0;
    this.stopBeatSource();
    beat.buffer = buffer;
    beat.offset = fraction * (buffer ? buffer.duration : 0);
    beat.playing = false;
    if (wasPlaying && buffer) this.playBeat();
  }

  stopBeatSource() {
    const beat = this.beat;
    if (beat.source) {
      beat.source.onended = null;
      try {
        beat.source.stop();
      } catch {
        /* đã dừng */
      }
      beat.source.disconnect();
      beat.source = null;
    }
  }

  playBeat(atTime = 0) {
    const beat = this.beat;
    if (!beat.buffer || !this.context) return;
    this.stopBeatSource();
    const source = this.context.createBufferSource();
    source.buffer = beat.buffer;
    source.connect(beat.gain);
    const when = atTime || this.context.currentTime + 0.02;
    if (beat.offset >= beat.buffer.duration) beat.offset = 0;
    source.start(when, beat.offset);
    source.onended = () => {
      if (beat.source !== source) return;
      beat.playing = false;
      beat.offset = 0;
      beat.source = null;
      this.dispatchEvent(new CustomEvent('beat-ended'));
    };
    beat.source = source;
    beat.startedAt = when;
    beat.playing = true;
  }

  pauseBeat() {
    const beat = this.beat;
    if (!beat.playing) return;
    beat.offset = this.beatPosition();
    beat.playing = false;
    this.stopBeatSource();
  }

  seekBeat(seconds) {
    const beat = this.beat;
    if (!beat.buffer) return;
    const wasPlaying = beat.playing;
    this.stopBeatSource();
    beat.playing = false;
    beat.offset = Math.max(0, Math.min(beat.buffer.duration - 0.01, seconds));
    if (wasPlaying) this.playBeat();
  }

  beatPosition() {
    const beat = this.beat;
    if (!beat.buffer) return 0;
    if (!beat.playing) return beat.offset;
    const elapsed = Math.max(0, this.context.currentTime - beat.startedAt);
    return Math.min(beat.buffer.duration, beat.offset + elapsed);
  }

  // ---------- Nhạc trực tiếp từ web hoặc app khác ----------

  /** kind: 'web' (âm thanh riêng của khung web) hoặc 'system' (mọi âm thanh của máy). */
  async startLive(kind) {
    await this.ensure();
    this.stopLive();
    const token = ++this.liveToken;
    await window.vokaraHost.armCapture(kind);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    stream.getVideoTracks().forEach((track) => track.stop());
    // Người dùng đã đổi nguồn trong lúc chờ: luồng đến muộn này không còn cần nữa.
    if (token !== this.liveToken) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const audio = stream.getAudioTracks()[0];
    if (!audio) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Không nhận được âm thanh từ nguồn này');
    }
    const live = this.live;
    live.kind = kind;
    live.stream = stream;
    live.source = this.context.createMediaStreamSource(stream);
    live.source.connect(this.liveBus);
    live.keyChunks = [];
    live.keySamples = 0;
    // Âm thanh hệ thống đã ra loa sẵn. Phát lại sẽ gây hú, nên chỉ nghe nguồn web qua đây.
    if (kind === 'web') this.liveShifter.connect(this.liveOut);
    audio.addEventListener('ended', () => {
      if (live.stream !== stream) return;
      this.stopLive();
      this.dispatchEvent(new CustomEvent('live-lost', { detail: { kind } }));
    });
    // Giữ vài chục giây gần nhất để dò tông.
    const limit = KEY_WINDOW_SECONDS * this.context.sampleRate;
    this.liveKeyRecorder.port.onmessage = (event) => {
      if (event.data.type !== 'chunk') return;
      live.keyChunks.push(event.data.channels);
      live.keySamples += event.data.channels[0].length;
      while (live.keySamples - live.keyChunks[0][0].length >= limit) {
        live.keySamples -= live.keyChunks.shift()[0].length;
      }
    };
    this.liveKeyRecorder.port.postMessage({ type: 'start', frame: 0 });
  }

  stopLive() {
    this.liveToken++;
    const live = this.live;
    if (!live.kind) return;
    if (live.source) live.source.disconnect();
    if (live.stream) live.stream.getTracks().forEach((track) => track.stop());
    if (live.kind === 'web') this.liveShifter.disconnect(this.liveOut);
    this.setLiveSemitones(0);
    this.liveKeyRecorder.port.onmessage = null;
    this.liveKeyRecorder.port.postMessage({ type: 'stop' });
    live.kind = null;
    live.stream = null;
    live.source = null;
    live.keyChunks = [];
    live.keySamples = 0;
  }

  /** Tắt tiếng nguồn web mà không dừng bắt, dùng khi chuyển sang màn khác. */
  setLiveMuted(muted) {
    if (this.liveOut) this.liveOut.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, 0.01);
  }

  /** Đổi tông nhạc từ nguồn web. Chỉ áp dụng được cho nhạc phát qua ứng dụng này. */
  setLiveSemitones(semitones) {
    if (this.liveShifter) this.liveShifter.port.postMessage({ semitones });
  }

  /** Mức tín hiệu hiện tại của nguồn trực tiếp, 0..1. */
  liveLevel() {
    if (!this.live.kind) return 0;
    const data = (this.liveLevelBuffer ??= new Float32Array(this.liveAnalyser.fftSize));
    this.liveAnalyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    return Math.min(1, peak);
  }

  /** Các kênh của đoạn nghe gần nhất, để dò tông. */
  liveSnapshot() {
    const chunks = this.live.keyChunks;
    return chunks.length ? mergeChunks(chunks, 2) : null;
  }

  // ---------- Ghi âm ----------

  async startRecording() {
    await this.ensure();
    const context = this.context;
    const startAt = context.currentTime + 0.15;
    const frame = Math.round(startAt * context.sampleRate);
    const liveKind = this.live.kind;
    const session = {
      frame,
      dry: [],
      wet: [],
      live: [],
      liveKind,
      monitorHeard: this.monitorOn,
      startAt,
      beatOffset: liveKind ? 0 : this.beat.offset,
    };
    this.recording = session;
    const hook = (node, store) => {
      node.port.onmessage = (event) => {
        if (event.data.type === 'chunk') store.push(event.data.channels);
      };
      node.port.postMessage({ type: 'start', frame });
    };
    hook(this.dryRecorder, session.dry);
    hook(this.wetRecorder, session.wet);
    if (liveKind) hook(this.liveRecorder, session.live);
    if (this.beat.buffer) {
      if (this.beat.playing) this.pauseBeat();
      session.beatOffset = this.beat.offset;
      this.playBeat(startAt);
    }
    return session;
  }

  async stopRecording() {
    const session = this.recording;
    if (!session) return null;
    this.recording = null;
    const finish = (node, store) =>
      new Promise((resolve) => {
        node.port.onmessage = (event) => {
          if (event.data.type === 'chunk') store.push(event.data.channels);
          else if (event.data.type === 'done') resolve();
        };
        node.port.postMessage({ type: 'stop' });
      });
    const finishing = [finish(this.dryRecorder, session.dry), finish(this.wetRecorder, session.wet)];
    if (session.liveKind) finishing.push(finish(this.liveRecorder, session.live));
    await Promise.all(finishing);
    if (this.beat.playing) this.pauseBeat();
    const merge = mergeChunks;
    const latency = this.latencyBreakdown();
    // Nhạc file và web được phát qua đây nên đến tai sau bộ ghi; giọng lại trễ thêm đoạn thu.
    // Âm thanh hệ thống thì ngược lại: ra loa trước, đến bộ ghi sau.
    const fromSystem = session.liveKind === 'system';
    const shifterDelay = LIVE_SHIFT_LATENCY / this.context.sampleRate;
    const roundTrip = !latency ? 0 : fromSystem ? latency.input - LOOPBACK_CAPTURE_DELAY - shifterDelay : latency.input + latency.output;
    return {
      sampleRate: this.context.sampleRate,
      dry: merge(session.dry, 1),
      wet: merge(session.wet, 2),
      beatOffset: session.beatOffset,
      liveBeat: session.liveKind ? merge(session.live, 2) : null,
      liveKind: session.liveKind,
      // Windows không tách được tiếng của riêng ứng dụng này, nên khi đang nghe giọng qua
      // tai, bản thu hệ thống đã có sẵn cả giọng: đúng như những gì người hát nghe thấy.
      asHeard: fromSystem && session.monitorHeard,
      // Người hát nghe nhạc trễ và tiếng vào máy cũng trễ: dịch lại cho khớp.
      dryShift: roundTrip,
      wetShift: roundTrip + this.voiceLatency,
    };
  }
}
