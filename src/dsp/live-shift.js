// Đổi tông nhạc nhiều bè theo thời gian thực, độ trễ cố định: dịch đỉnh phổ trong phase
// vocoder (Laroche & Dolson, 1999). Hai kênh dùng chung một phép dịch, tính từ tổng của
// chúng, nên ảnh stereo không bị xô lệch. Ở 0 cung tín hiệu chỉ đi qua đường trễ, y hệt bản gốc.

import { FFT, hannWindow } from './fft.js';

const SIZE = 4096;
const HOP = SIZE / 4;
const HALF = SIZE / 2;
const FADE_SECONDS = 0.08;
const TWO_PI = 2 * Math.PI;
// Cửa sổ Hann hai lần, chồng 4 lớp, có tổng không đổi bằng 1,5.
const OVERLAP_GAIN = 1 / 1.5;
const TRANSIENT_RATIO = 2.2;
const TRANSIENT_MIN_SHARE = 0.25;
const GAIN_STEPS = 32;

/** Số mẫu trễ của khối này, không đổi dù ở tông nào. */
export const LIVE_SHIFT_LATENCY = SIZE;

function wrapPhase(value) {
  return value - TWO_PI * Math.round(value / TWO_PI);
}

/**
 * Nội suy giữa hai bin tương đương nhân khung với một đường bao hẹp dần về hai rìa,
 * làm tiếng nhỏ đi tuỳ phần lẻ. Bảng này bù lại phần đó.
 */
function buildInterpolationGain(window) {
  const table = new Float64Array(GAIN_STEPS + 1);
  for (let step = 0; step <= GAIN_STEPS; step++) {
    const fraction = step / GAIN_STEPS;
    let kept = 0;
    let total = 0;
    for (let i = 0; i < SIZE; i++) {
      const n = i - HALF;
      const weight = window[i] * window[i];
      const envelope = 1 - fraction + fraction * Math.cos((TWO_PI * n) / SIZE);
      const imaginary = fraction * Math.sin((TWO_PI * n) / SIZE);
      const phase = (TWO_PI * fraction * n) / SIZE;
      kept += weight * (envelope * Math.cos(phase) + imaginary * Math.sin(phase));
      total += weight;
    }
    table[step] = total / kept;
  }
  return table;
}

export class LivePitchShifter {
  constructor(sampleRate) {
    this.fade = 1 / (FADE_SECONDS * sampleRate);
    this.fft = new FFT(SIZE);
    this.window = hannWindow(SIZE);
    this.interpolationGain = buildInterpolationGain(this.window);
    this.re = new Float64Array(SIZE);
    this.im = new Float64Array(SIZE);
    this.outRe = new Float64Array(SIZE);
    this.outIm = new Float64Array(SIZE);
    this.leftRe = new Float64Array(HALF + 1);
    this.leftIm = new Float64Array(HALF + 1);
    this.rightRe = new Float64Array(HALF + 1);
    this.rightIm = new Float64Array(HALF + 1);
    this.yLeftRe = new Float64Array(HALF + 1);
    this.yLeftIm = new Float64Array(HALF + 1);
    this.yRightRe = new Float64Array(HALF + 1);
    this.yRightIm = new Float64Array(HALF + 1);
    this.magnitude = new Float64Array(HALF + 1);
    this.sumRe = new Float64Array(HALF + 1);
    this.sumIm = new Float64Array(HALF + 1);
    this.prevSumRe = new Float64Array(HALF + 1);
    this.prevSumIm = new Float64Array(HALF + 1);
    this.rotation = new Float64Array(HALF + 1);
    this.nextRotation = new Float64Array(HALF + 1);
    this.peaks = new Int32Array(HALF);
    // Vòng đệm: vào, ra đã chồng lớp, và đường trễ nguyên bản.
    this.inLeft = new Float64Array(SIZE);
    this.inRight = new Float64Array(SIZE);
    this.olaLeft = new Float64Array(SIZE);
    this.olaRight = new Float64Array(SIZE);
    this.position = 0;
    this.sinceFrame = 0;
    this.ratio = 1;
    this.semitones = 0;
    this.wet = 0;
    this.warmup = SIZE;
    this.running = false;
    this.fresh = true;
    this.fluxAverage = 0;
  }

  setSemitones(semitones) {
    this.semitones = semitones;
    if (semitones !== 0) this.ratio = Math.pow(2, semitones / 12);
  }

  resetAnalysis() {
    this.olaLeft.fill(0);
    this.olaRight.fill(0);
    this.rotation.fill(0);
    this.warmup = SIZE;
    this.fresh = true;
    this.fluxAverage = 0;
    this.sinceFrame = 0;
  }

  /** Xử lý từng đoạn. left/right là đầu vào, outLeft/outRight là đầu ra cùng độ dài. */
  process(left, right, outLeft, outRight) {
    const { inLeft, inRight, olaLeft, olaRight } = this;
    for (let i = 0; i < left.length; i++) {
      const at = this.position;
      // Mẫu cũ nhất trong vòng chính là mẫu đã trễ đúng SIZE.
      const dryLeft = inLeft[at];
      const dryRight = inRight[at];
      inLeft[at] = left[i];
      inRight[at] = right[i];

      if (!this.running && this.semitones !== 0) {
        this.running = true;
        this.resetAnalysis();
      }
      let wetLeft = 0;
      let wetRight = 0;
      if (this.running) {
        // Phần đã chồng đủ lớp của vòng ra, rồi xoá để đón khung sau.
        wetLeft = olaLeft[at];
        wetRight = olaRight[at];
        olaLeft[at] = 0;
        olaRight[at] = 0;
        if (this.warmup > 0) this.warmup--;
      }
      this.position = (at + 1) % SIZE;
      if (this.running && ++this.sinceFrame === HOP) {
        this.sinceFrame = 0;
        this.processFrame();
      }

      const target = this.semitones !== 0 && this.warmup === 0 ? 1 : 0;
      if (this.wet < target) this.wet = Math.min(target, this.wet + this.fade);
      else if (this.wet > target) this.wet = Math.max(target, this.wet - this.fade);
      if (this.running && this.semitones === 0 && this.wet === 0) this.running = false;

      // Hai đường không cùng pha nên trộn theo công suất để âm lượng không tụt lúc chuyển.
      const angle = this.wet * Math.PI * 0.5;
      const dryGain = Math.cos(angle);
      const wetGain = Math.sin(angle);
      outLeft[i] = dryLeft * dryGain + wetLeft * wetGain;
      outRight[i] = dryRight * dryGain + wetRight * wetGain;
    }
  }

  processFrame() {
    const { re, im, window, position, inLeft, inRight, fft } = this;
    // Khung không pha: đặt tâm cửa sổ về đầu mảng để việc dịch bin không kèm đổi dấu.
    for (let i = 0; i < SIZE; i++) {
      const source = (position + i) % SIZE;
      const target = (i + HALF) % SIZE;
      re[target] = inLeft[source] * window[i];
      im[target] = inRight[source] * window[i];
    }
    fft.transform(re, im);
    this.separate();
    this.shiftSpectrum();
    this.synthesize();
  }

  /** Một FFT phức chở hai tín hiệu thực: tách ra phổ của từng kênh. */
  separate() {
    const { re, im, leftRe, leftIm, rightRe, rightIm, sumRe, sumIm, magnitude } = this;
    for (let k = 0; k <= HALF; k++) {
      const m = (SIZE - k) % SIZE;
      const lr = (re[k] + re[m]) * 0.5;
      const li = (im[k] - im[m]) * 0.5;
      const rr = (im[k] + im[m]) * 0.5;
      const ri = (re[m] - re[k]) * 0.5;
      leftRe[k] = lr;
      leftIm[k] = li;
      rightRe[k] = rr;
      rightIm[k] = ri;
      sumRe[k] = lr + rr;
      sumIm[k] = li + ri;
      magnitude[k] = Math.hypot(lr, li) + Math.hypot(rr, ri);
    }
  }

  shiftSpectrum() {
    const {
      magnitude, sumRe, sumIm, prevSumRe, prevSumIm, peaks, rotation, nextRotation, ratio,
      leftRe, leftIm, rightRe, rightIm, yLeftRe, yLeftIm, yRightRe, yRightIm,
    } = this;
    yLeftRe.fill(0);
    yLeftIm.fill(0);
    yRightRe.fill(0);
    yRightIm.fill(0);

    let count = 0;
    for (let k = 2; k < HALF - 1; k++) {
      const m = magnitude[k];
      if (m > 0 && m > magnitude[k - 1] && m > magnitude[k - 2] && m >= magnitude[k + 1] && m >= magnitude[k + 2]) {
        peaks[count++] = k;
      }
    }

    // Tiếng đánh: bỏ pha đã tích luỹ để các bin khớp lại với nhau, tiếng trống không nhoè.
    // Phải so với tổng phổ: nốt ngân đều cũng dao động rất nhẹ giữa các khung, nếu chỉ so
    // tỉ lệ thì dao động đó bị nhận nhầm là tiếng đánh và làm mất pha liên tục.
    let flux = 0;
    let total = 0;
    for (let k = 0; k <= HALF; k++) {
      flux += Math.max(0, magnitude[k] - this.prevMagnitudeAt(k));
      total += magnitude[k];
    }
    const transient = !this.fresh
      && flux > this.fluxAverage * TRANSIENT_RATIO
      && flux > total * TRANSIENT_MIN_SHARE;
    this.fluxAverage = this.fluxAverage * 0.9 + flux * 0.1;
    this.storeMagnitude();

    const advance = (TWO_PI * HOP) / SIZE;
    for (let index = 0; index < count; index++) {
      const peak = peaks[index];
      const low = index === 0 ? 0 : (peaks[index - 1] + peak + 1) >> 1;
      const high = index === count - 1 ? HALF : (peak + peaks[index + 1]) >> 1;

      // Tần số thật của đỉnh, suy từ độ lệch pha giữa hai khung liên tiếp.
      const crossRe = sumRe[peak] * prevSumRe[peak] + sumIm[peak] * prevSumIm[peak];
      const crossIm = sumIm[peak] * prevSumRe[peak] - sumRe[peak] * prevSumIm[peak];
      const deviation = wrapPhase(Math.atan2(crossIm, crossRe) - advance * peak);
      const exactBin = this.fresh ? peak : peak + deviation / advance;

      // Dịch phân số bằng nội suy giữa hai bin. Dịch tròn bin sẽ lệch tới nửa bin (gần 6 Hz),
      // đủ để nốt bass nghe gợn.
      const exactShift = exactBin * (ratio - 1);
      const shift = Math.floor(exactShift);
      const fraction = exactShift - shift;
      const compensation = this.interpolationGain[Math.round(fraction * GAIN_STEPS)];
      const previous = transient || this.fresh ? 0 : rotation[peak];
      const angle = wrapPhase(previous + (ratio - 1) * exactBin * advance);
      const cos = Math.cos(angle) * compensation;
      const sin = Math.sin(angle) * compensation;
      const nearWeight = 1 - fraction;
      for (let k = low; k <= high; k++) {
        nextRotation[k] = angle;
        const lr = leftRe[k] * cos - leftIm[k] * sin;
        const li = leftRe[k] * sin + leftIm[k] * cos;
        const rr = rightRe[k] * cos - rightIm[k] * sin;
        const ri = rightRe[k] * sin + rightIm[k] * cos;
        const near = k + shift;
        if (near >= 1 && near < HALF) {
          yLeftRe[near] += lr * nearWeight;
          yLeftIm[near] += li * nearWeight;
          yRightRe[near] += rr * nearWeight;
          yRightIm[near] += ri * nearWeight;
        }
        const far = near + 1;
        if (far >= 1 && far < HALF) {
          yLeftRe[far] += lr * fraction;
          yLeftIm[far] += li * fraction;
          yRightRe[far] += rr * fraction;
          yRightIm[far] += ri * fraction;
        }
      }
    }
    if (count === 0) nextRotation.fill(0);
    this.rotation = nextRotation;
    this.nextRotation = rotation;
    this.prevSumRe = sumRe;
    this.prevSumIm = sumIm;
    this.sumRe = prevSumRe;
    this.sumIm = prevSumIm;
    this.fresh = false;
  }

  prevMagnitudeAt(k) {
    return this.prevMagnitude ? this.prevMagnitude[k] : 0;
  }

  storeMagnitude() {
    this.prevMagnitude ??= new Float64Array(HALF + 1);
    this.prevMagnitude.set(this.magnitude);
  }

  /** Ghép phổ hai kênh về một FFT phức ngược, rồi chồng lớp vào vòng ra. */
  synthesize() {
    const { outRe, outIm, yLeftRe, yLeftIm, yRightRe, yRightIm, fft, window, position, olaLeft, olaRight } = this;
    for (let k = 0; k <= HALF; k++) {
      // Y[k] = L[k] + jR[k]
      outRe[k] = yLeftRe[k] - yRightIm[k];
      outIm[k] = yLeftIm[k] + yRightRe[k];
    }
    for (let k = 1; k < HALF; k++) {
      // Y[N-k] = conj(L[k]) + j·conj(R[k])
      outRe[SIZE - k] = yLeftRe[k] + yRightIm[k];
      outIm[SIZE - k] = -yLeftIm[k] + yRightRe[k];
    }
    fft.transform(outRe, outIm, true);
    for (let i = 0; i < SIZE; i++) {
      const target = (position + i) % SIZE;
      const source = (i + HALF) % SIZE;
      const gain = window[i] * OVERLAP_GAIN;
      olaLeft[target] += outRe[source] * gain;
      olaRight[target] += outIm[source] * gain;
    }
  }
}
