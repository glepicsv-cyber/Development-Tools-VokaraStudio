// Khử nhiễu nền kiểu trừ phổ: mức nhiễu của từng bin được ước lượng từ các khung
// yên tĩnh nhất, nên không cần người dùng chọn đoạn mẫu nhiễu.

import { FFT, hannWindow } from './fft.js';

/**
 * @param {Float32Array} input
 * @param {number} sampleRate
 * @param {number} strength 0..1
 */
export function reduceNoise(input, sampleRate, strength = 0.7, onProgress) {
  const size = 2048;
  const hop = size / 4;
  const half = size / 2;
  const fft = new FFT(size);
  const window = hannWindow(size);
  const frames = Math.ceil(input.length / hop) + 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);

  const loadFrame = (frame) => {
    const offset = (frame - 1) * hop;
    for (let i = 0; i < size; i++) {
      const position = offset + i;
      re[i] = position >= 0 && position < input.length ? input[position] * window[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
  };

  // Ước lượng hồ sơ nhiễu từ các khung có năng lượng thấp nhất.
  const probeStride = Math.max(1, Math.floor(frames / 400));
  const probes = [];
  for (let frame = 1; frame < frames - 1; frame += probeStride) {
    loadFrame(frame);
    const magnitudes = new Float32Array(half + 1);
    let energy = 0;
    for (let k = 0; k <= half; k++) {
      magnitudes[k] = Math.hypot(re[k], im[k]);
      energy += magnitudes[k] * magnitudes[k];
    }
    probes.push({ energy, magnitudes });
  }
  probes.sort((a, b) => a.energy - b.energy);
  const quiet = probes.slice(0, Math.max(1, Math.floor(probes.length * 0.15)));
  const noise = new Float64Array(half + 1);
  for (const probe of quiet) {
    for (let k = 0; k <= half; k++) noise[k] += probe.magnitudes[k] / quiet.length;
  }

  const overSubtraction = 1 + strength * 2.5;
  const floor = Math.pow(10, (-6 - strength * 24) / 20);
  const previousGain = new Float64Array(half + 1).fill(1);
  const output = new Float32Array(input.length + size * 2);
  const norm = new Float32Array(input.length + size * 2);

  for (let frame = 0; frame < frames; frame++) {
    loadFrame(frame);
    for (let k = 0; k <= half; k++) {
      const magnitude = Math.hypot(re[k], im[k]) + 1e-12;
      let gain = Math.max(floor, 1 - (overSubtraction * noise[k]) / magnitude);
      // Mở nhanh, đóng chậm: bớt tiếng "nhạc nhiễu" lục cục.
      gain = gain > previousGain[k] ? gain : previousGain[k] * 0.7 + gain * 0.3;
      previousGain[k] = gain;
      re[k] *= gain;
      im[k] *= gain;
      if (k > 0 && k < half) {
        re[size - k] = re[k];
        im[size - k] = -im[k];
      }
    }
    fft.transform(re, im, true);
    const offset = (frame - 1) * hop;
    for (let i = 0; i < size; i++) {
      const position = offset + i;
      if (position < 0 || position >= output.length) continue;
      output[position] += re[i] * window[i];
      norm[position] += window[i] * window[i];
    }
    if (onProgress && frame % 500 === 0) onProgress(frame / frames);
  }

  const result = new Float32Array(input.length);
  for (let i = 0; i < result.length; i++) {
    result[i] = norm[i] > 1e-4 ? output[i] / norm[i] : 0;
  }
  return result;
}
