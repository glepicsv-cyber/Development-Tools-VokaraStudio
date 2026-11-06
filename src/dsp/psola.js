// TD-PSOLA dòng chảy: đổi cao độ theo từng hạt đồng bộ với chu kỳ giọng.
// Vì hạt được lấy nguyên từ tín hiệu gốc nên khung đàm (formant) giữ nguyên,
// giọng không bị "chipmunk" khi dịch nốt.
//
// Trục thời gian: mẫu vào thứ k có thời gian ảo k. Khối ra được lấy tại
// thời gian (đầu vào - latency), nên latency chính là độ trễ của thuật toán.

const HANN_SIZE = 2048;
const HANN = new Float32Array(HANN_SIZE + 2);
for (let i = 0; i < HANN.length; i++) {
  HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / HANN_SIZE);
}

function nextPowerOfTwo(value) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

export class Psola {
  /**
   * @param {number} sampleRate
   * @param {{minF0?:number, blockSize?:number}} [options]
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.minF0 = options.minF0 ?? 80;
    const blockSize = options.blockSize ?? 128;
    this.maxPeriod = sampleRate / this.minF0;
    this.unvoicedPeriod = Math.round(sampleRate * 0.005);
    this.latency = Math.ceil(2 * this.maxPeriod) + blockSize + 8;

    const size = nextPowerOfTwo(Math.ceil(this.latency * 3 + this.maxPeriod * 8 + blockSize * 4));
    this.size = size;
    this.mask = size - 1;
    this.input = new Float32Array(size);
    this.output = new Float32Array(size);
    this.inHead = 0;
    this.synth = -this.latency; // vị trí hạt tổng hợp kế tiếp
    this.outHead = -this.latency;
    this.lastEpoch = -this.latency;
    this.lastEpochVoiced = false;
    this.prevEpoch = this.lastEpoch - this.unvoicedPeriod;
    this.prevPeriod = this.unvoicedPeriod;
    // Hai epoch gần nhất đủ để chọn hạt gần vị trí tổng hợp nhất.
    this.epochs = new Float64Array(64);
    this.epochPeriods = new Float32Array(64);
    this.epochCount = 0;
    this.epochs[0] = this.lastEpoch;
    this.epochPeriods[0] = this.unvoicedPeriod;
    this.epochCount = 1;
    /** Hệ số dịch khung đàm: 1 = giữ nguyên; >1 giọng mảnh hơn, <1 giọng dày hơn. */
    this.formant = 1;
  }

  reset() {
    this.input.fill(0);
    this.output.fill(0);
    this.inHead = 0;
    this.synth = -this.latency;
    this.outHead = -this.latency;
    this.lastEpoch = -this.latency;
    this.prevEpoch = this.lastEpoch - this.unvoicedPeriod;
    this.lastEpochVoiced = false;
    this.epochs[0] = this.lastEpoch;
    this.epochPeriods[0] = this.unvoicedPeriod;
    this.epochCount = 1;
  }

  /**
   * Xử lý một khối. `contour(t, out)` phải trả về chu kỳ tại thời gian ảo t qua
   * out.period (mẫu; 0 = vô thanh) và out.ratio (hệ số dịch tần số).
   */
  process(inputBlock, outputBlock, contour) {
    const n = inputBlock.length;
    const { input, output, mask } = this;

    for (let i = 0; i < n; i++) {
      input[(this.inHead + i) & mask] = inputBlock[i];
    }
    this.inHead += n;

    this.renderUntil(this.outHead + n, contour);

    for (let i = 0; i < n; i++) {
      const position = (this.outHead + i) & mask;
      outputBlock[i] = output[position];
      output[position] = 0;
    }
    this.outHead += n;
  }

  /** Sinh các hạt cần thiết để phủ tới thời điểm `end` của đầu ra. */
  renderUntil(end, contour) {
    const point = this.point || (this.point = { period: 0, ratio: 1 });
    // Dừng khi hạt kế tiếp bắt đầu sau `end`, nên hạt luôn được đặt trước đầu đọc.
    for (;;) {
      // Dùng chu kỳ dài nhất để hạt không bao giờ bắt đầu trước đầu đọc.
      if (this.synth - this.maxPeriod >= end) break;
      contour(this.synth, point);
      const voiced = point.period > 0;
      const period = voiced ? Math.min(point.period, this.maxPeriod) : this.unvoicedPeriod;

      this.extendEpochs(this.synth + period, contour);
      const index = this.nearestEpoch(this.synth);
      const epoch = this.epochs[index];
      const grainPeriod = Math.min(this.epochPeriods[index], this.maxPeriod);
      const ratio = voiced ? point.ratio : 1;
      this.addGrain(epoch, grainPeriod, this.synth, ratio);

      const step = voiced ? period / ratio : this.unvoicedPeriod;
      this.synth += Math.max(8, step);
    }
  }

  /** Mở rộng danh sách epoch đến thời gian `target`, trong giới hạn dữ liệu đã có. */
  extendEpochs(target, contour) {
    const point = this.epochPoint || (this.epochPoint = { period: 0, ratio: 1 });
    while (this.lastEpoch < target) {
      contour(this.lastEpoch, point);
      const voiced = point.period > 0;
      const period = voiced ? Math.min(point.period, this.maxPeriod) : this.unvoicedPeriod;
      let candidate = this.lastEpoch + period;
      // Hạt tâm tại epoch cần đủ mẫu phía sau.
      if (candidate + period * 1.25 + 4 > this.inHead) break;

      if (voiced) {
        if (this.lastEpochVoiced) {
          candidate = this.alignByCorrelation(candidate, period);
        } else {
          candidate = this.alignToPeak(candidate, period);
        }
      }
      this.prevPeriod = period;
      this.prevEpoch = this.lastEpoch;
      this.lastEpoch = candidate;
      this.lastEpochVoiced = voiced;

      if (this.epochCount === this.epochs.length) {
        this.epochs.copyWithin(0, 32);
        this.epochPeriods.copyWithin(0, 32);
        this.epochCount -= 32;
      }
      this.epochs[this.epochCount] = candidate;
      this.epochPeriods[this.epochCount] = period;
      this.epochCount++;
    }
  }

  nearestEpoch(time) {
    let best = this.epochCount - 1;
    let bestDistance = Infinity;
    for (let i = this.epochCount - 1; i >= 0; i--) {
      const distance = Math.abs(this.epochs[i] - time);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      } else if (this.epochs[i] < time) {
        break;
      }
    }
    return best;
  }

  /** Bám đỉnh tương quan với chu kỳ trước để hạt luôn đồng pha. */
  alignByCorrelation(candidate, period) {
    const { input, mask } = this;
    const reference = Math.round(this.lastEpoch);
    // Giữ phần lẻ của epoch trước, nếu không pha sẽ rung ±0,5 mẫu giữa các hạt.
    const carry = this.lastEpoch - reference;
    const center = Math.round(candidate - carry);
    const radius = Math.max(2, Math.round(period * 0.15));
    const half = Math.max(8, Math.round(period * 0.5));
    const stride = period > 200 ? 2 : 1;
    let bestScore = -Infinity;
    let bestOffset = 0;
    let scoreBefore = 0;
    let scoreBest = 0;
    let scoreAfter = 0;
    let previousScore = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      let sum = 0;
      const position = center + offset;
      if (position + half >= this.inHead) break;
      for (let i = -half; i < half; i += stride) {
        sum += input[(reference + i) & mask] * input[(position + i) & mask];
      }
      if (sum > bestScore) {
        bestScore = sum;
        bestOffset = offset;
        scoreBefore = previousScore;
        scoreBest = sum;
        scoreAfter = NaN;
      } else if (Number.isNaN(scoreAfter)) {
        scoreAfter = sum;
      }
      previousScore = sum;
    }
    let refined = 0;
    if (!Number.isNaN(scoreAfter) && bestOffset > -radius) {
      const denominator = scoreBefore - 2 * scoreBest + scoreAfter;
      if (denominator < 0) {
        refined = Math.max(-0.5, Math.min(0.5, (0.5 * (scoreBefore - scoreAfter)) / denominator));
      }
    }
    return center + bestOffset + refined + carry;
  }

  /** Khi vừa vào vùng hữu thanh: đặt epoch trùng đỉnh năng lượng của chu kỳ. */
  alignToPeak(candidate, period) {
    const { input, mask } = this;
    const start = Math.round(candidate - period * 0.5);
    const stop = Math.min(Math.round(candidate + period * 0.5), this.inHead - Math.ceil(period) - 2);
    let best = Math.round(candidate);
    let bestValue = -1;
    for (let i = start; i < stop; i++) {
      const value = Math.abs(input[i & mask]);
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    }
    return best;
  }

  /** Đặt một hạt Hann dài 2T tâm tại `center` của đầu ra, lấy từ `epoch` đầu vào. */
  addGrain(epoch, period, center, ratio) {
    const { input, output, mask, formant } = this;
    const half = Math.floor(period);
    if (half < 2) return;
    // Hệ số bù âm lượng: nhiều hạt/giây hơn thì công suất tăng theo căn của ratio.
    const gain = 1 / Math.sqrt(Math.max(0.25, Math.min(4, ratio)));
    const hannScale = HANN_SIZE / (2 * period);
    const centerInt = Math.floor(center);
    const centerFrac = center - centerInt;
    for (let i = -half; i <= half; i++) {
      // Khoảng cách tính từ tâm hạt ở đầu ra (mẫu i của đầu ra lệch dưới mẫu với tâm thực).
      const relative = i - centerFrac;
      const windowPosition = (relative + period) * hannScale;
      if (windowPosition < 0 || windowPosition >= HANN_SIZE) continue;
      const indexInt = windowPosition | 0;
      const fraction = windowPosition - indexInt;
      const window = HANN[indexInt] + (HANN[indexInt + 1] - HANN[indexInt]) * fraction;

      // Lấy mẫu đầu vào tại vị trí thực bằng nội suy Hermite bậc ba.
      const sourcePosition = epoch + relative * formant;
      const sourceInt = Math.floor(sourcePosition);
      const t = sourcePosition - sourceInt;
      const xm1 = input[(sourceInt - 1) & mask];
      const x0 = input[sourceInt & mask];
      const x1 = input[(sourceInt + 1) & mask];
      const x2 = input[(sourceInt + 2) & mask];
      const c1 = 0.5 * (x1 - xm1);
      const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      const value = ((c3 * t + c2) * t + c1) * t + x0;

      output[(centerInt + i) & mask] += value * window * gain;
    }
  }
}

/**
 * Chỉnh cao độ không thời gian thực theo đường cong đã tính sẵn.
 * @param {Float32Array} samples đầu vào
 * @param {number} sampleRate
 * @param {{hop:number, f0:Float32Array|Float64Array, ratio:Float32Array|Float64Array}} curve
 * @param {{minF0?:number, formant?:number, onProgress?:(p:number)=>void}} [options]
 */
export function renderPsola(samples, sampleRate, curve, options = {}) {
  const blockSize = 512;
  const psola = new Psola(sampleRate, { minF0: options.minF0 ?? 60, blockSize });
  psola.formant = options.formant ?? 1;
  const { hop, f0, ratio } = curve;
  const frames = f0.length;

  const contour = (time, out) => {
    const framePosition = time / hop;
    const lower = Math.floor(framePosition);
    if (lower < 0 || lower >= frames) {
      out.period = 0;
      out.ratio = 1;
      return;
    }
    const upper = Math.min(frames - 1, lower + 1);
    const a = f0[lower];
    const b = f0[upper];
    if (a <= 0 || b <= 0) {
      out.period = 0;
      out.ratio = 1;
      return;
    }
    const fraction = framePosition - lower;
    out.period = sampleRate / (a + (b - a) * fraction);
    out.ratio = ratio[lower] + (ratio[upper] - ratio[lower]) * fraction;
  };

  const result = new Float32Array(samples.length);
  const latency = psola.latency;
  const inBlock = new Float32Array(blockSize);
  const outBlock = new Float32Array(blockSize);
  const total = samples.length + latency;
  let produced = 0;
  let blocks = 0;
  for (let pos = 0; pos < total; pos += blockSize) {
    inBlock.fill(0);
    if (pos < samples.length) inBlock.set(samples.subarray(pos, Math.min(samples.length, pos + blockSize)));
    psola.process(inBlock, outBlock, contour);
    // Đầu ra trễ `latency` mẫu: bỏ phần đó để khớp thời gian với đầu vào.
    const startOut = pos - latency;
    for (let i = 0; i < blockSize; i++) {
      const index = startOut + i;
      if (index >= 0 && index < result.length) {
        result[index] = outBlock[i];
        produced++;
      }
    }
    if (options.onProgress && ++blocks % 400 === 0) options.onProgress(Math.min(1, pos / total));
  }
  return result;
}
