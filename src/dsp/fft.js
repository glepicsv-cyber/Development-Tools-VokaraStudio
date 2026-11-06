// FFT phức radix-2 kích thước cố định, tối ưu cho việc gọi lặp lại.

export class FFT {
  constructor(size) {
    if (size & (size - 1)) throw new Error('Kích thước FFT phải là luỹ thừa của 2');
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let reversed = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) reversed |= 1 << (bits - 1 - b);
      this.reverse[i] = reversed;
    }
  }

  /** Biến đổi tại chỗ. inverse=true có chia cho N. */
  transform(re, im, inverse = false) {
    const { size, cos, sin, reverse } = this;
    for (let i = 0; i < size; i++) {
      const j = reverse[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const direction = inverse ? 1 : -1;
    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1;
      const step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const wr = cos[w];
          const wi = direction * sin[w];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < size; i++) {
        re[i] /= size;
        im[i] /= size;
      }
    }
  }
}

export function hannWindow(size) {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}
