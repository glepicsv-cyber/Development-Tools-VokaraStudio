// Đổi tông và tốc độ cho nhạc nền: phase vocoder khoá pha theo đỉnh phổ
// (Laroche & Dolson) rồi nội suy lại mẫu. Có reset pha tại các điểm trống
// để tiếng đánh không bị nhoè.

import { FFT, hannWindow } from './fft.js';

const SIZE = 2048;

/**
 * Giãn thời gian theo `stretch` (>1 dài ra) không đổi cao độ.
 */
export function phaseVocoder(input, stretch, onProgress) {
  const hopSynth = SIZE / 4;
  const hopAna = hopSynth / stretch;
  const fft = new FFT(SIZE);
  const window = hannWindow(SIZE);
  const half = SIZE / 2;
  const outputLength = Math.ceil(input.length * stretch) + SIZE * 2;
  const output = new Float32Array(outputLength);
  const norm = new Float32Array(outputLength);

  const re = new Float64Array(SIZE);
  const im = new Float64Array(SIZE);
  const magnitude = new Float64Array(half + 1);
  const phase = new Float64Array(half + 1);
  const prevPhase = new Float64Array(half + 1);
  const prevMagnitude = new Float64Array(half + 1);
  const synthPhase = new Float64Array(half + 1);
  const peaks = new Int32Array(half + 1);
  const expected = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) expected[k] = (2 * Math.PI * k) / SIZE;

  const frames = Math.ceil(input.length / hopAna) + 1;
  let first = true;
  let fluxAverage = 0;

  for (let frame = 0; frame < frames; frame++) {
    const analysisPos = frame * hopAna - SIZE / 2;
    const base = Math.floor(analysisPos);
    const fraction = analysisPos - base;
    for (let i = 0; i < SIZE; i++) {
      const position = base + i;
      const a = position >= 0 && position < input.length ? input[position] : 0;
      const b = position + 1 >= 0 && position + 1 < input.length ? input[position + 1] : 0;
      re[i] = (a + (b - a) * fraction) * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);

    let flux = 0;
    for (let k = 0; k <= half; k++) {
      const m = Math.hypot(re[k], im[k]);
      magnitude[k] = m;
      phase[k] = Math.atan2(im[k], re[k]);
      const difference = m - prevMagnitude[k];
      if (difference > 0) flux += difference;
    }
    const isTransient = !first && flux > fluxAverage * 2.2 && fluxAverage > 1e-3;
    fluxAverage = fluxAverage * 0.9 + flux * 0.1;

    if (first || isTransient) {
      for (let k = 0; k <= half; k++) synthPhase[k] = phase[k];
      first = false;
    } else {
      // Tìm đỉnh phổ; các bin xung quanh khoá theo đỉnh.
      let peakCount = 0;
      for (let k = 2; k < half - 1; k++) {
        const m = magnitude[k];
        if (m > magnitude[k - 1] && m > magnitude[k - 2] && m >= magnitude[k + 1] && m >= magnitude[k + 2]) {
          peaks[peakCount++] = k;
        }
      }
      if (peakCount === 0) {
        for (let k = 0; k <= half; k++) {
          synthPhase[k] += expected[k] * hopSynth + wrap(phase[k] - prevPhase[k] - expected[k] * hopAna) * stretch;
        }
      } else {
        let regionStart = 0;
        for (let p = 0; p < peakCount; p++) {
          const peak = peaks[p];
          const regionEnd = p + 1 < peakCount ? (peak + peaks[p + 1] + 1) >> 1 : half + 1;
          const delta = wrap(phase[peak] - prevPhase[peak] - expected[peak] * hopAna);
          const newPeakPhase = synthPhase[peak] + expected[peak] * hopSynth + delta * stretch;
          const rotation = newPeakPhase - phase[peak];
          for (let k = regionStart; k < regionEnd; k++) synthPhase[k] = phase[k] + rotation;
          regionStart = regionEnd;
        }
      }
    }

    for (let k = 0; k <= half; k++) {
      prevPhase[k] = phase[k];
      prevMagnitude[k] = magnitude[k];
      const m = magnitude[k];
      re[k] = m * Math.cos(synthPhase[k]);
      im[k] = m * Math.sin(synthPhase[k]);
    }
    for (let k = 1; k < half; k++) {
      re[SIZE - k] = re[k];
      im[SIZE - k] = -im[k];
    }
    fft.transform(re, im, true);

    const outputPos = frame * hopSynth;
    for (let i = 0; i < SIZE; i++) {
      const position = outputPos + i;
      if (position >= outputLength) break;
      output[position] += re[i] * window[i];
      norm[position] += window[i] * window[i];
    }
    if (onProgress && frame % 500 === 0) onProgress(frame / frames);
  }

  // Bỏ phần đệm đầu SIZE/2 và chuẩn hoá chồng cửa sổ.
  const length = Math.round(input.length * stretch);
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i + SIZE / 2;
    result[i] = norm[position] > 1e-4 ? output[position] / norm[position] : 0;
  }
  return result;
}

function wrap(angle) {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

/** Nội suy lại độ dài (dùng cho đổi tông sau khi đã giãn). */
export function resampleLinear(input, ratio) {
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const t = position - index;
    const xm1 = input[Math.max(0, index - 1)];
    const x0 = input[Math.min(input.length - 1, index)];
    const x1 = input[Math.min(input.length - 1, index + 1)];
    const x2 = input[Math.min(input.length - 1, index + 2)];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    output[i] = ((c3 * t + c2) * t + c1) * t + x0;
  }
  return output;
}

/**
 * Đổi tông `semitones` và tốc độ `tempo` (1 = nguyên bản; 1.1 = nhanh hơn 10%).
 * Trả về độ dài = input.length / tempo.
 */
export function shiftAndStretch(input, semitones, tempo, onProgress) {
  if (semitones === 0 && tempo === 1) return input;
  const pitchRatio = Math.pow(2, semitones / 12);
  const stretch = pitchRatio / tempo;
  const stretched = stretch === 1 ? input : phaseVocoder(input, stretch, onProgress);
  return pitchRatio === 1 ? stretched : resampleLinear(stretched, pitchRatio);
}

/**
 * Giảm giọng ca chính giữa trong bản stereo: suy giảm các bin mà hai kênh gần
 * như giống nhau trong dải tần của giọng hát.
 * @param {number} amount 0..1
 */
export function reduceCenterVocal(left, right, sampleRate, amount, onProgress) {
  const size = 4096;
  const hop = size / 4;
  const fft = new FFT(size);
  const window = hannWindow(size);
  const half = size / 2;
  const length = left.length;
  const outL = new Float32Array(length + size);
  const outR = new Float32Array(length + size);
  const norm = new Float32Array(length + size);
  const reL = new Float64Array(size);
  const imL = new Float64Array(size);
  const reR = new Float64Array(size);
  const imR = new Float64Array(size);
  const lowBin = Math.floor((180 * size) / sampleRate);
  const highBin = Math.ceil((7000 * size) / sampleRate);
  const frames = Math.ceil(length / hop);

  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * hop;
    for (let i = 0; i < size; i++) {
      const position = offset + i;
      reL[i] = (position < length ? left[position] : 0) * window[i];
      reR[i] = (position < length ? right[position] : 0) * window[i];
      imL[i] = 0;
      imR[i] = 0;
    }
    fft.transform(reL, imL);
    fft.transform(reR, imR);
    for (let k = lowBin; k <= highBin && k <= half; k++) {
      const dotProduct = reL[k] * reR[k] + imL[k] * imR[k];
      const powerL = reL[k] * reL[k] + imL[k] * imL[k];
      const powerR = reR[k] * reR[k] + imR[k] * imR[k];
      const denominator = Math.sqrt(powerL * powerR) + 1e-12;
      const similarity = dotProduct / denominator; // 1 = cùng pha
      const balance = 2 * Math.sqrt(powerL * powerR) / (powerL + powerR + 1e-12); // 1 = cân bằng
      const centerness = Math.max(0, similarity) * balance;
      const gain = 1 - amount * Math.pow(centerness, 4);
      reL[k] *= gain;
      imL[k] *= gain;
      reR[k] *= gain;
      imR[k] *= gain;
      if (k > 0 && k < half) {
        reL[size - k] = reL[k];
        imL[size - k] = -imL[k];
        reR[size - k] = reR[k];
        imR[size - k] = -imR[k];
      }
    }
    fft.transform(reL, imL, true);
    fft.transform(reR, imR, true);
    for (let i = 0; i < size; i++) {
      const position = offset + i;
      outL[position] += reL[i] * window[i];
      outR[position] += reR[i] * window[i];
      norm[position] += window[i] * window[i];
    }
    if (onProgress && frame % 500 === 0) onProgress(frame / frames);
  }
  const resultL = new Float32Array(length);
  const resultR = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const n = norm[i] > 1e-4 ? norm[i] : 1;
    resultL[i] = outL[i] / n;
    resultR[i] = outR[i] / n;
  }
  return [resultL, resultR];
}
