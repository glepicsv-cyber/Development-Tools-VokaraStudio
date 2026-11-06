// Tín hiệu thử và phép đo độc lập với mã trong src/ (không dùng YIN của ứng dụng).

export const SR = 48000;

/**
 * Giọng tổng hợp: xung thanh môn + 3 formant, có thể có vibrato và jitter.
 * @param {(t:number)=>number} f0At cao độ (Hz) theo thời gian, <=0 là ngừng hát
 */
export function synthVoice(durationSec, f0At, options = {}) {
  const sr = options.sr ?? SR;
  const n = Math.round(durationSec * sr);
  const out = new Float32Array(n);
  const formants = options.formants ?? [
    { f: 700, bw: 110, gain: 1 },
    { f: 1220, bw: 120, gain: 0.5 },
    { f: 2600, bw: 160, gain: 0.25 },
  ];
  const filters = formants.map(({ f, bw, gain }) => {
    const r = Math.exp((-Math.PI * bw) / sr);
    return { a1: 2 * r * Math.cos((2 * Math.PI * f) / sr), a2: -r * r, y1: 0, y2: 0, gain };
  });
  let phase = 0;
  let previous = 0;
  let seed = options.seed ?? 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const jitter = options.jitter ?? 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = f0At(t);
    let excitation = 0;
    if (f0 > 0) {
      phase += (f0 * (1 + jitter * (random() - 0.5))) / sr;
      if (phase >= 1) phase -= 1;
      // Xung Rosenberg: mở trong 60% chu kỳ, đóng đột ngột.
      const open = 0.6;
      const pulse = phase < open ? 0.5 - 0.5 * Math.cos((Math.PI * phase) / open) : 0;
      excitation = pulse - previous; // đạo hàm luồng khí
      previous = pulse;
    } else {
      previous = 0;
    }
    let sum = 0;
    for (const filter of filters) {
      const y = excitation + filter.a1 * filter.y1 + filter.a2 * filter.y2;
      filter.y2 = filter.y1;
      filter.y1 = y;
      sum += y * filter.gain;
    }
    out[i] = sum;
  }
  if (options.normalize === false) return out;
  // Chuẩn hoá về mức đỉnh 0.5.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.5 / peak;
  return out;
}

export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const hzMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const cents = (a, b) => 1200 * Math.log2(a / b);

/**
 * Đo F0 độc lập: tự tương quan chuẩn hoá ở tần số gốc, chọn đỉnh đầu tiên đủ cao.
 * @returns {number} Hz, 0 nếu không đo được
 */
export function measureF0(samples, start, length, minF0 = 60, maxF0 = 1200, sr = SR) {
  const minLag = Math.floor(sr / maxF0);
  const maxLag = Math.ceil(sr / minF0);
  if (start < 0 || start + length + maxLag + 1 >= samples.length) return 0;
  const nac = new Float64Array(maxLag + 2);
  let e0 = 0;
  for (let i = 0; i < length; i++) e0 += samples[start + i] ** 2;
  if (e0 < 1e-8) return 0;
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    let e1 = 0;
    for (let i = 0; i < length; i++) {
      const b = samples[start + i + lag];
      sum += samples[start + i] * b;
      e1 += b * b;
    }
    nac[lag] = sum / Math.sqrt(e0 * e1 + 1e-12);
  }
  let top = 0;
  for (let lag = minLag; lag <= maxLag; lag++) top = Math.max(top, nac[lag]);
  if (top < 0.5) return 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (nac[lag] >= nac[lag - 1] && nac[lag] >= nac[lag + 1] && nac[lag] > top * 0.93) {
      const denominator = nac[lag - 1] - 2 * nac[lag] + nac[lag + 1];
      const offset = denominator !== 0 ? (0.5 * (nac[lag - 1] - nac[lag + 1])) / denominator : 0;
      return sr / (lag + offset);
    }
  }
  return 0;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : NaN;
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;
}

export function rms(samples, start = 0, end = samples.length) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

export const db = (x) => 20 * Math.log10(x + 1e-12);

/** Đường bao phổ công suất trung bình (dB) bằng DFT trực tiếp trên dải tần cho trước. */
export function spectrumDb(samples, start, length, freqs, sr = SR) {
  return freqs.map((f) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < length; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
      const angle = (2 * Math.PI * f * i) / sr;
      const s = samples[start + i] * w;
      re += s * Math.cos(angle);
      im -= s * Math.sin(angle);
    }
    return 10 * Math.log10(re * re + im * im + 1e-12);
  });
}

/** Chạy bộ xử lý thời gian thực theo khối 128 mẫu như AudioWorklet. */
export function runBlocks(processor, input, tailSamples = 0, blockSize = 128) {
  const total = input.length + tailSamples;
  const output = new Float32Array(total);
  const inBlock = new Float32Array(blockSize);
  const outBlock = new Float32Array(blockSize);
  for (let pos = 0; pos + blockSize <= total; pos += blockSize) {
    inBlock.fill(0);
    if (pos < input.length) inBlock.set(input.subarray(pos, Math.min(input.length, pos + blockSize)));
    processor.process(inBlock, outBlock);
    output.set(outBlock, pos);
  }
  return output;
}
