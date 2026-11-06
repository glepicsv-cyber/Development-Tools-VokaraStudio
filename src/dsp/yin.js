// Dò cao độ YIN (de Cheveigné & Kawahara, 2002) trên tín hiệu đã hạ tần số lấy mẫu
// để chạy đủ nhanh trên luồng âm thanh thời gian thực.

export class PitchDetector {
  /**
   * @param {number} sampleRate tần số lấy mẫu của tín hiệu đưa vào push()
   * @param {{minF0?:number,maxF0?:number,threshold?:number,silenceDb?:number}} [options]
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.minF0 = options.minF0 ?? 80;
    this.maxF0 = options.maxF0 ?? 1000;
    this.threshold = options.threshold ?? 0.15;
    this.silenceRms = Math.pow(10, (options.silenceDb ?? -55) / 20);
    this.decimation = Math.max(1, Math.round(sampleRate / 24000));
    this.rate = sampleRate / this.decimation;
    this.tauMax = Math.ceil(this.rate / this.minF0) + 2;
    this.tauMin = Math.max(2, Math.floor(this.rate / this.maxF0));
    // Cửa sổ tích phân phủ được một chu kỳ dài nhất.
    this.windowSize = this.tauMax;
    this.bufferSize = this.windowSize + this.tauMax;
    this.buffer = new Float32Array(this.bufferSize);
    this.diff = new Float32Array(this.tauMax + 1);
    this.previousF0 = 0;
    // Bộ lọc chống chồng phổ IIR bậc 2 (Butterworth) đơn giản, hai tầng.
    this.aa = this.decimation > 1 ? makeLowpass(this.rate * 0.42, sampleRate) : null;
    this.aaState = new Float64Array(4);
    this.decimCounter = 0;
    this.written = 0;
  }

  /** Số mẫu (ở tần số gốc) tương ứng với độ trễ của tâm cửa sổ phân tích. */
  get centerDelay() {
    return Math.round((this.bufferSize / 2) * this.decimation);
  }

  reset() {
    this.buffer.fill(0);
    this.aaState.fill(0);
    this.previousF0 = 0;
    this.written = 0;
  }

  /** Nạp mẫu mới; chỉ cập nhật bộ đệm, chưa tính pitch. */
  push(samples, start = 0, end = samples.length) {
    const { aa, aaState, decimation, buffer, bufferSize } = this;
    let writeIndex = this.written % bufferSize;
    for (let i = start; i < end; i++) {
      let value = samples[i];
      if (aa) {
        // Hai tầng biquad nối tiếp, dạng direct form II transposed.
        let out = aa.b0 * value + aaState[0];
        aaState[0] = aa.b1 * value - aa.a1 * out + aaState[1];
        aaState[1] = aa.b2 * value - aa.a2 * out;
        value = out;
        out = aa.b0 * value + aaState[2];
        aaState[2] = aa.b1 * value - aa.a1 * out + aaState[3];
        aaState[3] = aa.b2 * value - aa.a2 * out;
        value = out;
      }
      if (++this.decimCounter >= decimation) {
        this.decimCounter = 0;
        buffer[writeIndex] = value;
        writeIndex = (writeIndex + 1) % bufferSize;
        this.written++;
      }
    }
  }

  /**
   * Tính cao độ trên các mẫu mới nhất.
   * @returns {{f0:number, confidence:number, rms:number}} f0 = 0 nếu không hữu thanh.
   */
  detect() {
    const { buffer, bufferSize, windowSize, tauMax, tauMin, diff } = this;
    const start = this.written % bufferSize;

    // Trải bộ đệm vòng thành mảng thẳng theo đúng thứ tự thời gian.
    const x = this.linear || (this.linear = new Float32Array(bufferSize));
    const firstPart = bufferSize - start;
    x.set(buffer.subarray(start), 0);
    if (start > 0) x.set(buffer.subarray(0, start), firstPart);

    let energy = 0;
    for (let i = tauMax; i < bufferSize; i++) energy += x[i] * x[i];
    const rms = Math.sqrt(energy / windowSize);
    if (rms < this.silenceRms) {
      this.previousF0 = 0;
      return { f0: 0, confidence: 0, rms };
    }

    // Hàm hiệu YIN so sánh đoạn đầu cửa sổ với các đoạn dịch tau.
    diff[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < windowSize; i++) {
        const delta = x[i] - x[i + tau];
        sum += delta * delta;
      }
      running += sum;
      diff[tau] = running > 0 ? (sum * tau) / running : 1;
    }

    // Tìm cực tiểu đầu tiên dưới ngưỡng; nếu không có thì lấy cực tiểu toàn cục.
    let bestTau = -1;
    let globalMin = Infinity;
    let globalTau = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      const value = diff[tau];
      if (value < globalMin) {
        globalMin = value;
        globalTau = tau;
      }
      if (bestTau < 0 && value < this.threshold) {
        let t = tau;
        while (t + 1 < tauMax && diff[t + 1] < diff[t]) t++;
        bestTau = t;
        tau = t;
      }
    }
    if (bestTau < 0) {
      // Vùng nhiều nhiễu: chỉ chấp nhận khi vẫn khá tuần hoàn.
      if (globalTau < 0 || globalMin > 0.3) {
        this.previousF0 = 0;
        return { f0: 0, confidence: 0, rms };
      }
      bestTau = globalTau;
    }

    // Bám theo khung trước để tránh nhảy quãng tám khi hai ứng viên gần ngang nhau.
    if (this.previousF0 > 0) {
      const expected = this.rate / this.previousF0;
      if (Math.abs(bestTau - expected) / expected > 0.2) {
        const lo = Math.max(tauMin, Math.floor(expected * 0.9));
        const hi = Math.min(tauMax - 1, Math.ceil(expected * 1.1));
        let nearTau = -1;
        let nearValue = Infinity;
        for (let t = lo; t <= hi; t++) {
          if (diff[t] < nearValue) {
            nearValue = diff[t];
            nearTau = t;
          }
        }
        // Tín hiệu tuần hoàn ở T cũng tuần hoàn ở 2T, nên chỉ chuyển khi tốt hơn hẳn;
        // nếu không sẽ kẹt mãi ở quãng tám dưới.
        if (nearTau > 0 && nearValue < diff[bestTau] - 0.03) bestTau = nearTau;
      }
    }

    const refined = parabolic(diff, bestTau);
    const f0 = this.rate / refined;
    const confidence = Math.max(0, Math.min(1, 1 - diff[bestTau]));
    if (f0 < this.minF0 * 0.97 || f0 > this.maxF0 * 1.03) {
      this.previousF0 = 0;
      return { f0: 0, confidence: 0, rms };
    }
    this.previousF0 = f0;
    return { f0, confidence, rms };
  }
}

function parabolic(values, index) {
  if (index <= 0 || index >= values.length - 1) return index;
  const a = values[index - 1];
  const b = values[index];
  const c = values[index + 1];
  const denominator = a - 2 * b + c;
  if (Math.abs(denominator) < 1e-12) return index;
  const offset = (0.5 * (a - c)) / denominator;
  return Math.abs(offset) <= 1 ? index + offset : index;
}

function makeLowpass(cutoff, sampleRate) {
  const q = Math.SQRT1_2;
  const w = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Phân tích cao độ cả một đoạn audio (không thời gian thực).
 * @returns {{hop:number, sampleRate:number, f0:Float32Array, confidence:Float32Array, rms:Float32Array}}
 *   f0[i] là cao độ tại mẫu i*hop (đã bù độ trễ cửa sổ).
 */
export function analyzePitch(samples, sampleRate, options = {}) {
  const hop = options.hop ?? Math.round(sampleRate * 0.005);
  const detector = new PitchDetector(sampleRate, options);
  const delay = detector.centerDelay;
  const frames = Math.floor(samples.length / hop) + 1;
  const f0 = new Float32Array(frames);
  const confidence = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const padded = new Float32Array(hop);
  const onProgress = options.onProgress;
  let pos = 0;
  // Khung kết quả tại thời điểm (pos - delay) → chạy thêm `delay` mẫu để phủ phần đuôi.
  const total = samples.length + delay;
  while (pos < total) {
    const end = pos + hop;
    if (end <= samples.length) {
      detector.push(samples, pos, end);
    } else {
      padded.fill(0);
      if (pos < samples.length) padded.set(samples.subarray(pos, samples.length));
      detector.push(padded, 0, hop);
    }
    pos = end;
    const result = detector.detect();
    const frame = Math.round((pos - delay) / hop);
    if (frame >= 0 && frame < frames) {
      f0[frame] = result.f0;
      confidence[frame] = result.confidence;
      rms[frame] = result.rms;
    }
    if (onProgress && (pos / hop) % 2000 === 0) onProgress(Math.min(1, pos / total));
  }
  cleanTrack(f0, hop, sampleRate);
  return { hop, sampleRate, f0, confidence, rms };
}

/** Lọc trung vị và bỏ các đoạn hữu thanh quá ngắn hoặc nhảy quãng tám lẻ loi. */
function cleanTrack(f0, hop, sampleRate) {
  const n = f0.length;
  const copy = f0.slice();
  const radius = 2;
  const window = [];
  for (let i = 0; i < n; i++) {
    if (copy[i] <= 0) continue;
    window.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      if (copy[j] > 0) window.push(copy[j]);
    }
    window.sort((a, b) => a - b);
    const median = window[window.length >> 1];
    // Chỉ thay điểm lệch nhiều, giữ nguyên vibrato tinh tế.
    if (Math.abs(12 * Math.log2(copy[i] / median)) > 2) f0[i] = median;
  }
  const minFrames = Math.round((0.03 * sampleRate) / hop);
  let i = 0;
  while (i < n) {
    if (f0[i] <= 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && f0[j] > 0) j++;
    if (j - i < minFrames) f0.fill(0, i, j);
    i = j;
  }
}
