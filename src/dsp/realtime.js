// Ghép dò cao độ + AutoTuner + PSOLA thành bộ xử lý thời gian thực.
// Tách khỏi AudioWorkletProcessor để kiểm thử được bằng Node.

import { Psola } from './psola.js';
import { PitchDetector } from './yin.js';
import { AutoTuner } from './tuner.js';

export const VOICE_RANGES = {
  high: { label: 'Giọng nữ / trẻ em', minF0: 140, maxF0: 1200 },
  mid: { label: 'Giọng nam', minF0: 80, maxF0: 800 },
  low: { label: 'Giọng nam trầm', minF0: 60, maxF0: 500 },
};

export class RealtimeVoiceProcessor {
  constructor(sampleRate, voice = 'mid', blockSize = 128) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.tuner = new AutoTuner();
    this.bypass = false;
    this.gateDb = -60;
    this.gateGain = 0;
    this.setVoice(voice);
    this.status = { inMidi: 0, outMidi: 0, note: null, rms: 0, confidence: 0 };
  }

  setVoice(voice) {
    const range = VOICE_RANGES[voice] || VOICE_RANGES.mid;
    this.voice = voice;
    const previousFormant = this.psola ? this.psola.formant : 1;
    this.detector = new PitchDetector(this.sampleRate, { minF0: range.minF0, maxF0: range.maxF0 });
    this.psola = new Psola(this.sampleRate, { minF0: range.minF0, blockSize: this.blockSize });
    this.psola.formant = previousFormant;
    this.hop = Math.round(this.sampleRate * 0.005);
    this.sinceDetect = 0;
    // Khung đường cao độ gần đây, tra theo thời gian ảo của Psola.
    this.frameCount = 64;
    this.frameTime = new Float64Array(this.frameCount);
    this.framePeriod = new Float32Array(this.frameCount);
    this.frameRatio = new Float32Array(this.frameCount).fill(1);
    this.frameIndex = 0;
    this.frameTime.fill(-1e12);
    this.bypassDelay = new Float32Array(this.psola.size);
    this.bypassMix = this.bypass ? 1 : 0;
    this.gateEnv = 0;
    this.tuner.reset();
    this.contour = (time, out) => this.lookup(time, out);
  }

  /** Độ trễ thuật toán tính bằng mẫu. */
  get latency() {
    return this.psola.latency;
  }

  lookup(time, out) {
    const { frameTime, framePeriod, frameRatio, frameCount, frameIndex } = this;
    // Duyệt ngược: khung mới nhất có thời gian <= time.
    for (let i = 1; i <= frameCount; i++) {
      const index = (frameIndex - i + frameCount * 2) % frameCount;
      if (frameTime[index] <= time) {
        out.period = framePeriod[index];
        out.ratio = frameRatio[index];
        return;
      }
    }
    out.period = 0;
    out.ratio = Math.pow(2, this.tuner.transpose / 12);
  }

  analyze(upToTime) {
    const result = this.detector.detect();
    const dtMs = (this.hop / this.sampleRate) * 1000;
    // Cổng nhiễu: khi im lặng không kéo cao độ theo tiếng ồn.
    const gated = 20 * Math.log10(result.rms + 1e-9) < this.gateDb;
    const f0 = gated ? 0 : result.f0;
    const tuned = this.tuner.update(f0, dtMs);

    const index = this.frameIndex;
    this.frameTime[index] = upToTime - this.detector.centerDelay;
    this.framePeriod[index] = f0 > 0 ? this.sampleRate / f0 : 0;
    this.frameRatio[index] = tuned.ratio;
    this.frameIndex = (index + 1) % this.frameCount;

    const status = this.status;
    status.inMidi = tuned.inMidi;
    status.outMidi = tuned.outMidi;
    status.note = tuned.note;
    status.rms = result.rms;
    status.confidence = result.confidence;
  }

  /** Xử lý đúng một khối `blockSize` mẫu. */
  process(input, output) {
    const n = input.length;
    const psola = this.psola;
    this.detector.push(input);
    this.sinceDetect += n;
    const headAfter = psola.inHead + n;
    if (this.sinceDetect >= this.hop) {
      this.sinceDetect -= this.hop;
      this.analyze(headAfter);
    }
    const delay = this.bypassDelay;
    const mask = psola.mask;
    const startHead = psola.inHead;
    for (let i = 0; i < n; i++) delay[(startHead + i) & mask] = input[i];

    psola.process(input, output, this.contour);

    // Trộn sang đường gốc có cùng độ trễ: chuyển bật/tắt không gây tiếng nổ.
    const target = this.bypass ? 1 : 0;
    if (target !== this.bypassMix || target === 1) {
      const step = 1 / (this.sampleRate * 0.02);
      const readHead = startHead - psola.latency;
      for (let i = 0; i < n; i++) {
        if (this.bypassMix < target) this.bypassMix = Math.min(target, this.bypassMix + step);
        else if (this.bypassMix > target) this.bypassMix = Math.max(target, this.bypassMix - step);
        const dry = readHead + i >= 0 ? delay[(readHead + i) & mask] : 0;
        output[i] = output[i] * (1 - this.bypassMix) + dry * this.bypassMix;
      }
    }

    // Cổng nhiễu đầu ra theo mức tín hiệu vào (có attack/release mượt).
    const open = 20 * Math.log10(this.status.rms + 1e-9) >= this.gateDb ? 1 : 0;
    const attack = 1 - Math.exp(-1 / (this.sampleRate * 0.003));
    const release = 1 - Math.exp(-1 / (this.sampleRate * 0.12));
    let env = this.gateEnv;
    for (let i = 0; i < n; i++) {
      env += (open - env) * (open > env ? attack : release);
      output[i] *= env;
    }
    this.gateEnv = env;
  }
}
