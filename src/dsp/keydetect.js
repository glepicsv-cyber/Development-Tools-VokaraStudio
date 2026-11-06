// Tự dò tông bài hát: sắc đồ (chroma) + so khớp hồ sơ Krumhansl-Schmuckler.

import { FFT, hannWindow } from './fft.js';

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let numerator = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denominator = Math.sqrt(varA * varB);
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * @returns {{root:number, scale:'major'|'minor', confidence:number, chroma:number[]}}
 */
export function detectKey(samples, sampleRate, options = {}) {
  const size = 8192;
  const fft = new FFT(size);
  const window = hannWindow(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const chroma = new Float64Array(12);

  // Chỉ lấy dải chứa hoà âm chính; bass và tiếng rít làm hồ sơ sai đi.
  const minBin = Math.ceil((80 * size) / sampleRate);
  const maxBin = Math.floor((2000 * size) / sampleRate);
  const binPc = new Int8Array(size / 2);
  for (let bin = minBin; bin <= maxBin; bin++) {
    const freq = (bin * sampleRate) / size;
    const midi = 69 + 12 * Math.log2(freq / 440);
    binPc[bin] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const maxFrames = options.maxFrames ?? 1500;
  const available = Math.max(0, Math.floor((samples.length - size) / size)) + 1;
  const stride = Math.max(1, Math.floor(available / maxFrames));
  for (let frame = 0; frame < available; frame += stride) {
    const offset = frame * size;
    if (offset + size > samples.length) break;
    for (let i = 0; i < size; i++) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    // Chuẩn hoá theo khung để đoạn to không lấn át toàn bài.
    const frameChroma = new Float64Array(12);
    let total = 0;
    for (let bin = minBin; bin <= maxBin; bin++) {
      const magnitude = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
      frameChroma[binPc[bin]] += magnitude;
      total += magnitude;
    }
    if (total > 1e-6) for (let pc = 0; pc < 12; pc++) chroma[pc] += frameChroma[pc] / total;
  }

  const candidates = [];
  for (let root = 0; root < 12; root++) {
    const rotated = new Array(12);
    for (let pc = 0; pc < 12; pc++) rotated[pc] = chroma[(pc + root) % 12];
    candidates.push({ root, scale: 'major', score: pearson(rotated, MAJOR_PROFILE) });
    candidates.push({ root, scale: 'minor', score: pearson(rotated, MINOR_PROFILE) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];
  return {
    root: best.root,
    scale: best.scale,
    confidence: Math.max(0, Math.min(1, (best.score - second.score) * 5 + best.score * 0.3)),
    chroma: Array.from(chroma),
  };
}
