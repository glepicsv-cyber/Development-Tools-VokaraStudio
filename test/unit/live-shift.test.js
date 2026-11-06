import test from 'node:test';
import assert from 'node:assert/strict';
import { LivePitchShifter, LIVE_SHIFT_LATENCY } from '../../src/dsp/live-shift.js';

const SR = 48000;
const BLOCK = 128;

/** Chạy qua bộ đổi tông theo từng khối 128 mẫu, đúng như trên luồng âm thanh. */
function run(left, right, semitones, onBlock) {
  const shifter = new LivePitchShifter(SR);
  shifter.setSemitones(semitones);
  const outLeft = new Float32Array(left.length);
  const outRight = new Float32Array(left.length);
  for (let start = 0; start + BLOCK <= left.length; start += BLOCK) {
    if (onBlock) onBlock(shifter, start);
    shifter.process(
      left.subarray(start, start + BLOCK),
      right.subarray(start, start + BLOCK),
      outLeft.subarray(start, start + BLOCK),
      outRight.subarray(start, start + BLOCK),
    );
  }
  return [outLeft, outRight];
}

function tones(freqs, seconds, gain = 0.2) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    for (const f of freqs) out[i] += gain * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return out;
}

function rms(data, from = 0, to = data.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / (to - from));
}

function amplitude(data, freq, from, to) {
  let re = 0;
  let im = 0;
  const n = to - from;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const a = (2 * Math.PI * freq * i) / SR;
    re += data[from + i] * w * Math.cos(a);
    im += data[from + i] * w * Math.sin(a);
  }
  return (4 * Math.hypot(re, im)) / n;
}

/** Tần số đo bằng số lần qua 0, không giả định trước kết quả. */
function zeroCrossHz(data, from, to) {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) {
      const at = i - data[i] / (data[i] - data[i - 1]);
      if (first < 0) first = at;
      last = at;
      count++;
    }
  }
  return ((count - 1) * SR) / (last - first);
}

const cents = (a, b) => 1200 * Math.log2(a / b);
const SETTLED = SR; // bỏ qua giây đầu: đệm đầy và chuyển mạch xong

test('0 cung: đầu ra y hệt đầu vào, trễ đúng số mẫu đã công bố', () => {
  const input = new Float32Array(SR);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin(i * i * 1e-6) * 0.5;
  const [out] = run(input, input, 0);
  for (let i = LIVE_SHIFT_LATENCY; i < out.length - BLOCK; i++) {
    assert.equal(out[i], input[i - LIVE_SHIFT_LATENCY], `khác ở mẫu ${i}`);
  }
});

for (const semitones of [-6, -3, -1, 1, 3, 6]) {
  test(`${semitones > 0 ? '+' : ''}${semitones} cung: cao độ đúng trong 2 cent ở nhiều tần số, âm lượng giữ trong 1 dB`, () => {
    for (const freq of [110, 220, 440, 1000, 3000]) {
      const input = tones([freq], 3);
      const [out] = run(input, input, semitones);
      const measured = zeroCrossHz(out, SETTLED, out.length - BLOCK);
      const expected = freq * Math.pow(2, semitones / 12);
      assert.ok(Math.abs(cents(measured, expected)) < 2, `${freq} Hz: đo ${measured.toFixed(2)}, cần ${expected.toFixed(2)}`);
      const change = 20 * Math.log10(rms(out, SETTLED, out.length - BLOCK) / rms(input, SETTLED, input.length));
      assert.ok(Math.abs(change) < 1, `${freq} Hz: âm lượng đổi ${change.toFixed(2)} dB`);
    }
  });
}

test('nốt bass: đúng âm lượng, không có dải biên gây gợn tiếng', () => {
  // Các tần số này không rơi đúng tâm bin. Lỗi nhận nhầm tiếng đánh trước đây chỉ lộ ra ở đây.
  for (const semitones of [-6, -3, -1, 1, 3, 6]) {
    for (const freq of [55, 82.4, 110, 220]) {
      const input = tones([freq], 3);
      const [out] = run(input, input, semitones);
      const target = freq * Math.pow(2, semitones / 12);
      const from = SETTLED;
      const to = out.length - BLOCK;
      const level = amplitude(out, target, from, to);
      assert.ok(Math.abs(level - 0.2) < 0.005, `${freq} Hz ${semitones} cung: mức ${level.toFixed(3)}`);
      for (const offset of [-47, -23, 23, 47]) {
        const side = amplitude(out, target + offset, from, to);
        const db = 20 * Math.log10(Math.max(side, 1e-9) / level);
        assert.ok(db < -40, `${freq} Hz ${semitones} cung: dải biên ${offset} Hz ở ${db.toFixed(1)} dB`);
      }
    }
  }
});

test('hợp âm: mọi nốt dịch đúng, nốt gốc không còn lại', () => {
  const notes = [196, 246.94, 293.66, 392];
  const input = tones(notes, 3, 0.1);
  const ratio = Math.pow(2, 3 / 12);
  const [out] = run(input, input, 3);
  const from = SETTLED;
  const to = out.length - BLOCK;
  for (const note of notes) {
    const shifted = amplitude(out, note * ratio, from, to);
    assert.ok(shifted > 0.08, `${note} Hz sau khi dịch chỉ còn ${shifted.toFixed(4)}`);
  }
  // 246,94 Hz lên 3 cung đúng bằng 293,66 Hz, nên không xét nốt đó là nốt gốc còn sót.
  for (const note of [196, 246.94, 392]) {
    const residue = amplitude(out, note, from, to);
    assert.ok(residue < 0.01, `${note} Hz còn sót ${residue.toFixed(4)}`);
  }
});

test('stereo: tỉ lệ hai kênh và độ lệch pha được giữ nguyên', () => {
  const n = 3 * SR;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    right[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / SR);
  }
  const [outLeft, outRight] = run(left, right, 2);
  const from = SETTLED;
  const to = n - BLOCK;
  const balance = rms(outLeft, from, to) / rms(outRight, from, to);
  assert.ok(Math.abs(balance - 3) < 0.05, `tỉ lệ ${balance.toFixed(3)}, cần 3`);
  let dot = 0;
  for (let i = from; i < to; i++) dot += outLeft[i] * outRight[i];
  const correlation = dot / ((to - from) * rms(outLeft, from, to) * rms(outRight, from, to));
  assert.ok(correlation > 0.99, `hai kênh lệch pha, tương quan ${correlation.toFixed(3)}`);
});

test('kênh trái phải hoàn toàn độc lập không lẫn sang nhau', () => {
  const left = tones([440], 3);
  const right = tones([660], 3);
  const ratio = Math.pow(2, 2 / 12);
  const [outLeft, outRight] = run(left, right, 2);
  const from = SETTLED;
  const to = left.length - BLOCK;
  assert.ok(amplitude(outLeft, 440 * ratio, from, to) > 0.15);
  assert.ok(amplitude(outRight, 660 * ratio, from, to) > 0.15);
  assert.ok(amplitude(outLeft, 660 * ratio, from, to) < 0.005, 'trái lẫn tiếng phải');
  assert.ok(amplitude(outRight, 440 * ratio, from, to) < 0.005, 'phải lẫn tiếng trái');
});

test('đổi tông giữa chừng: không có tiếng tách', () => {
  const input = tones([440], 4);
  const [out] = run(input, input, 0, (shifter, start) => {
    if (start === SR * 1 - (SR % BLOCK)) shifter.setSemitones(3);
    if (start === SR * 2 - (SR % BLOCK)) shifter.setSemitones(-2);
    if (start === SR * 3 - (SR % BLOCK)) shifter.setSemitones(0);
  });
  // Sin 0,2 ở 440–523 Hz đổi tối đa khoảng 0,014 mỗi mẫu; tách sẽ vượt xa ngưỡng này.
  let worst = 0;
  let at = 0;
  for (let i = LIVE_SHIFT_LATENCY + 1; i < out.length - BLOCK; i++) {
    const jump = Math.abs(out[i] - out[i - 1]);
    if (jump > worst) {
      worst = jump;
      at = i;
    }
  }
  assert.ok(worst < 0.04, `bước nhảy ${worst.toFixed(4)} tại mẫu ${at}`);
  // Âm lượng không được tụt mạnh trong lúc chuyển.
  for (let start = LIVE_SHIFT_LATENCY; start + 2400 < out.length - BLOCK; start += 2400) {
    const level = rms(out, start, start + 2400);
    assert.ok(level > 0.2 * 0.707 * 0.6, `tụt còn ${level.toFixed(3)} tại ${(start / SR).toFixed(2)} s`);
  }
});

test('tiếng trống vẫn sắc: năng lượng không loang ra trước tiếng đánh', () => {
  const n = 4 * SR;
  const input = new Float32Array(n);
  const hits = [];
  for (let t = SR; t < n - SR / 2; t += SR / 2) {
    hits.push(t);
    for (let i = 0; i < 2400; i++) {
      input[t + i] += 0.6 * Math.exp(-i / 300) * Math.sin((2 * Math.PI * 180 * i) / SR + 7000 * Math.sin(i * 0.11) * 1e-3);
    }
  }
  const [out] = run(input, input, 3);
  let before = 0;
  let after = 0;
  for (const hit of hits.slice(1)) {
    const t = hit + LIVE_SHIFT_LATENCY;
    before += rms(out, t - 2400, t - 240);
    after += rms(out, t, t + 1200);
  }
  const ratioDb = 20 * Math.log10(after / Math.max(before, 1e-9));
  assert.ok(ratioDb > 12, `trước tiếng đánh chỉ thấp hơn ${ratioDb.toFixed(1)} dB`);
});

test('tiếng trắng và im lặng: không nổ, không sinh số lỗi', () => {
  const noise = new Float32Array(2 * SR);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.5;
  const [out] = run(noise, noise, 5);
  for (const value of out) assert.ok(Number.isFinite(value) && Math.abs(value) < 1.5);
  const silence = new Float32Array(SR);
  const [quiet] = run(silence, silence, -4);
  assert.equal(rms(quiet), 0);
});

test('đủ nhanh cho thời gian thực trên luồng âm thanh', () => {
  const left = tones([196, 246.94, 293.66, 392, 1500], 10, 0.1);
  const started = performance.now();
  run(left, left, 3);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 10000 * 0.25, `10 giây nhạc mất ${elapsed.toFixed(0)} ms`);
  console.log(`      10 giây nhạc xử lý trong ${elapsed.toFixed(0)} ms (${((elapsed / 10000) * 100).toFixed(1)}% thời gian thực)`);
});
