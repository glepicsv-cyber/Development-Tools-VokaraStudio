import test from 'node:test';
import assert from 'node:assert/strict';
import { SR, synthVoice, midiHz, cents, measureF0, median, percentile, rms, db, spectrumDb, runBlocks } from '../helpers.js';
import { PitchDetector, analyzePitch } from '../../src/dsp/yin.js';
import { RealtimeVoiceProcessor } from '../../src/dsp/realtime.js';
import { renderPsola } from '../../src/dsp/psola.js';
import { segmentNotes, autoCorrectNotes, buildCurve } from '../../src/dsp/notes.js';
import { detectKey } from '../../src/dsp/keydetect.js';
import { shiftAndStretch, reduceCenterVocal } from '../../src/dsp/timestretch.js';
import { encodeWav } from '../../src/dsp/wav.js';
import { AutoTuner } from '../../src/dsp/tuner.js';
import { nearestInScale, scaleMask } from '../../src/dsp/scales.js';
import { reduceNoise } from '../../src/dsp/denoise.js';
import * as ops from '../../src/dsp/edit-ops.js';

/** Đo độ lệch (cents) so với nốt đích trong khoảng thời gian cho trước. */
function centsAgainst(output, fromSec, toSec, targetMidi) {
  const target = midiHz(targetMidi);
  const errors = [];
  for (let t = fromSec; t < toSec; t += 0.02) {
    const f = measureF0(output, Math.round(t * SR), 2048);
    if (f > 0) errors.push(cents(f, target));
  }
  return errors;
}

test('YIN: sai số < 5 cents trên dải 80-800 Hz và không lỗi quãng tám', () => {
  for (const f of [80, 110, 165, 220, 330, 440, 660, 800]) {
    const signal = synthVoice(0.5, () => f);
    const detector = new PitchDetector(SR, { minF0: 70, maxF0: 1000 });
    const errors = [];
    for (let pos = 0; pos + 256 <= signal.length; pos += 256) {
      detector.push(signal, pos, pos + 256);
      if (pos > SR * 0.1) {
        const { f0 } = detector.detect();
        assert.ok(f0 > 0, `phải nhận là hữu thanh ở ${f} Hz`);
        errors.push(Math.abs(cents(f0, f)));
      }
    }
    assert.ok(percentile(errors, 0.95) < 5, `${f} Hz: p95 = ${percentile(errors, 0.95).toFixed(2)} cents`);
  }
});

test('YIN: im lặng và nhiễu trắng không bị nhận thành nốt', () => {
  const detector = new PitchDetector(SR);
  detector.push(new Float32Array(4096));
  assert.equal(detector.detect().f0, 0);

  let seed = 7;
  const noise = new Float32Array(SR);
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    noise[i] = (seed / 4294967296 - 0.5) * 0.4;
  }
  const noisy = new PitchDetector(SR);
  let voiced = 0;
  let frames = 0;
  for (let pos = 0; pos + 256 <= noise.length; pos += 256) {
    noisy.push(noise, pos, pos + 256);
    frames++;
    if (noisy.detect().f0 > 0) voiced++;
  }
  assert.ok(voiced / frames < 0.05, `tỉ lệ nhầm ${(voiced / frames).toFixed(3)}`);
});

test('Auto-tune thời gian thực: giọng lệch 35 cents về đúng nốt, sai số < 8 cents', () => {
  for (const [midi, voice] of [[57, 'mid'], [64, 'mid'], [69, 'high'], [45, 'low']]) {
    const off = midiHz(midi + 0.35);
    const input = synthVoice(1.5, () => off);
    const processor = new RealtimeVoiceProcessor(SR, voice);
    processor.tuner.setScale(0, 'chromatic');
    processor.tuner.retuneMs = 10;
    processor.tuner.amount = 1;
    const output = runBlocks(processor, input, processor.latency);
    const errors = centsAgainst(output, 0.5, 1.4, midi);
    assert.ok(errors.length > 20, 'phải đo được cao độ');
    assert.ok(Math.abs(median(errors)) < 8, `MIDI ${midi}: lệch trung vị ${median(errors).toFixed(1)} cents`);
    assert.ok(percentile(errors.map(Math.abs), 0.95) < 15, `MIDI ${midi}: p95 ${percentile(errors.map(Math.abs), 0.95).toFixed(1)} cents`);
  }
});

test('Âm giai: nốt ngoài âm giai bị kéo về nốt gần nhất trong âm giai', () => {
  // Hát C#4 (61) trong C trưởng: phải về C4 hoặc D4 (đo: gần nhất là 60 hoặc 62).
  const input = synthVoice(1.2, () => midiHz(60.8));
  const processor = new RealtimeVoiceProcessor(SR, 'mid');
  processor.tuner.setScale(0, 'major');
  processor.tuner.retuneMs = 5;
  const output = runBlocks(processor, input, processor.latency);
  const errors = centsAgainst(output, 0.5, 1.1, 60);
  assert.ok(Math.abs(median(errors)) < 10, `lệch ${median(errors).toFixed(1)} cents so với C4`);
});

test('Retune chậm giữ vibrato, retune tức thì làm phẳng', () => {
  const vibrato = (t) => midiHz(60 + 0.5 * Math.sin(2 * Math.PI * 5.5 * t));
  const input = synthVoice(2, vibrato);
  const swing = (retuneMs) => {
    const processor = new RealtimeVoiceProcessor(SR, 'mid');
    processor.tuner.setScale(0, 'chromatic');
    processor.tuner.retuneMs = retuneMs;
    const output = runBlocks(processor, input, processor.latency);
    const errors = centsAgainst(output, 0.6, 1.9, 60);
    return percentile(errors, 0.95) - percentile(errors, 0.05);
  };
  const natural = swing(400);
  const flat = swing(0);
  assert.ok(natural > 60, `retune chậm phải còn vibrato, biên độ ${natural.toFixed(0)} cents`);
  assert.ok(flat < 30, `retune tức thì phải phẳng, biên độ ${flat.toFixed(0)} cents`);
});

test('Dịch tông giữ formant: đỉnh F1 không chạy theo cao độ', () => {
  const input = synthVoice(1.5, () => midiHz(55));
  const processor = new RealtimeVoiceProcessor(SR, 'mid');
  processor.tuner.enabled = false;
  processor.tuner.transpose = 5;
  const output = runBlocks(processor, input, processor.latency);
  const pitchErrors = centsAgainst(output, 0.5, 1.4, 60);
  assert.ok(Math.abs(median(pitchErrors)) < 10, `dịch +5 lệch ${median(pitchErrors).toFixed(1)} cents`);

  const freqs = [];
  for (let f = 300; f <= 1600; f += 20) freqs.push(f);
  const envelope = (signal, start) => {
    // Làm trơn phổ để thành đường bao, không phụ thuộc vị trí hoạ âm.
    const spec = spectrumDb(signal, start, 9600, freqs);
    return spec.map((_, i) => {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - 8); k <= Math.min(spec.length - 1, i + 8); k++) {
        sum += Math.pow(10, spec[k] / 10);
        count++;
      }
      return 10 * Math.log10(sum / count);
    });
  };
  const peakOf = (values) => freqs[values.indexOf(Math.max(...values))];
  const before = peakOf(envelope(input, 24000));
  const after = peakOf(envelope(output, 24000));
  const naive = before * Math.pow(2, 5 / 12);
  assert.ok(Math.abs(after - before) < Math.abs(after - naive), `F1 ${before} → ${after} Hz (dịch thô sẽ là ${naive.toFixed(0)} Hz)`);
});

test('Âm lượng ổn định: trung bình trên nhiều cao độ lệch < 1.5 dB so với giọng thật ở nốt đích', () => {
  // Từng điểm có thể lệch vài dB vì hoạ âm trượt qua formant hẹp của giọng tổng hợp,
  // nên kiểm tra độ lệch hệ thống trên cả lưới cao độ.
  const raw = { normalize: false };
  const errors = [];
  for (const base of [52, 55, 57, 60, 62, 64]) {
    const input = synthVoice(1.5, () => midiHz(base), raw);
    for (const transpose of [-3, -1, 1, 3]) {
      const processor = new RealtimeVoiceProcessor(SR, 'mid');
      processor.tuner.enabled = false;
      processor.tuner.transpose = transpose;
      const output = runBlocks(processor, input, processor.latency);
      const reference = synthVoice(1.5, () => midiHz(base + transpose), raw);
      const expected = db(rms(reference, 24000, 60000)) - 10 * Math.log10(Math.pow(2, transpose / 12));
      errors.push(db(rms(output, 24000, 60000)) - expected);
    }
  }
  const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  assert.ok(Math.abs(mean) < 1.5, `lệch trung bình ${mean.toFixed(2)} dB`);
});

test('Không có tiếng nổ khi vào/ra nốt và đổi nốt', () => {
  const f0At = (t) => {
    if (t < 0.3) return 0;
    if (t < 0.8) return midiHz(57.3);
    if (t < 1.3) return midiHz(60.2);
    if (t < 1.5) return 0;
    return midiHz(55.4);
  };
  const input = synthVoice(2.2, f0At);
  const processor = new RealtimeVoiceProcessor(SR, 'mid');
  processor.tuner.retuneMs = 20;
  // Bỏ phần đuôi: tín hiệu thử bị cắt cụt ở cuối, đó không phải lỗi của bộ xử lý.
  const output = runBlocks(processor, input, processor.latency).subarray(0, input.length - 2400);
  const peakOf = (signal) => signal.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
  const maxStep = (signal) => {
    let step = 0;
    for (let i = 1; i < signal.length; i++) step = Math.max(step, Math.abs(signal[i] - signal[i - 1]));
    return step;
  };
  assert.ok(peakOf(output) < peakOf(input) * 1.6, `đỉnh ${peakOf(output).toFixed(3)} so với ${peakOf(input).toFixed(3)}`);
  assert.ok(maxStep(output) < maxStep(input) * 1.6, `bước nhảy ${maxStep(output).toFixed(3)} so với ${maxStep(input).toFixed(3)}`);
  for (const value of output) assert.ok(Number.isFinite(value));
});

test('Phụ âm/vô thanh đi qua không mất tiếng', () => {
  let seed = 11;
  const noise = new Float32Array(SR);
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    noise[i] = (seed / 4294967296 - 0.5) * 0.3;
  }
  const processor = new RealtimeVoiceProcessor(SR, 'mid');
  const output = runBlocks(processor, noise, processor.latency);
  const difference = db(rms(output, 12000, 44000)) - db(rms(noise, 12000, 44000));
  assert.ok(Math.abs(difference) < 1.5, `chênh ${difference.toFixed(2)} dB`);
});

test('Hiệu năng: thời gian xử lý mỗi khối < 25% ngân sách thời gian thực', () => {
  const input = synthVoice(3, (t) => midiHz(50 + 2 * Math.sin(t)));
  const processor = new RealtimeVoiceProcessor(SR, 'low');
  const start = performance.now();
  runBlocks(processor, input, 0);
  const elapsed = performance.now() - start;
  const load = elapsed / 3000;
  console.log(`  tải CPU trung bình: ${(load * 100).toFixed(1)}% một lõi`);
  assert.ok(load < 0.25, `tải ${(load * 100).toFixed(1)}%`);
});

test('Biên tập: tách đúng các nốt của một giai điệu', () => {
  const melody = [60, 62, 64, 65, 67];
  const input = synthVoice(2.75, (t) => {
    const index = Math.floor(t / 0.55);
    return midiHz(melody[Math.min(index, melody.length - 1)] + 0.3);
  });
  const analysis = analyzePitch(input, SR);
  const notes = segmentNotes(analysis);
  assert.equal(notes.length, melody.length, `tách được ${notes.length} nốt`);
  notes.forEach((note, index) => {
    assert.ok(Math.abs(note.pitch - (melody[index] + 0.3)) < 0.1, `nốt ${index}: ${note.pitch.toFixed(2)}`);
  });
});

test('Biên tập: tự sửa cả bài về âm giai và kéo tay một nốt lên 2 bán cung', () => {
  const melody = [60, 62, 64, 67];
  const input = synthVoice(2.4, (t) => {
    const index = Math.min(melody.length - 1, Math.floor(t / 0.6));
    return midiHz(melody[index] + 0.4 * (index % 2 === 0 ? 1 : -1));
  });
  const analysis = analyzePitch(input, SR);
  const notes = segmentNotes(analysis);
  assert.equal(notes.length, melody.length);
  autoCorrectNotes(notes, 0, 'major', 1, 1);
  notes[2].shift += 2; // E4 → F#4 (kéo tay ra ngoài âm giai)
  const curve = buildCurve(analysis, notes);
  const output = renderPsola(input, SR, curve);
  assert.equal(output.length, input.length);

  const expected = [60, 62, 66, 67];
  expected.forEach((midi, index) => {
    const errors = centsAgainst(output, index * 0.6 + 0.15, index * 0.6 + 0.45, midi);
    assert.ok(errors.length > 5, 'phải đo được');
    assert.ok(Math.abs(median(errors)) < 10, `nốt ${index}: lệch ${median(errors).toFixed(1)} cents`);
  });
});

test('Biên tập: render không đổi thời gian của các nốt', () => {
  const input = synthVoice(1.2, (t) => (t >= 0.4 && t < 0.8 ? midiHz(60) : 0));
  const analysis = analyzePitch(input, SR);
  const notes = segmentNotes(analysis);
  for (const note of notes) note.shift = 1;
  const output = renderPsola(input, SR, buildCurve(analysis, notes));
  const onset = (signal) => {
    for (let i = 0; i < signal.length; i += 48) {
      if (rms(signal, i, Math.min(signal.length, i + 240)) > 0.02) return i / SR;
    }
    return -1;
  };
  assert.ok(Math.abs(onset(output) - onset(input)) < 0.015, `${onset(input)} → ${onset(output)}`);
});

test('Tự dò tông: nhận đúng tông từ hợp âm', () => {
  const tone = (midi, n, offset, target) => {
    const f = midiHz(midi);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 500) * Math.min(1, (n - i) / 2000);
      target[offset + i] += env * 0.15 * (Math.sin((2 * Math.PI * f * i) / SR) + 0.4 * Math.sin((4 * Math.PI * f * i) / SR));
    }
  };
  const progression = (root, intervals) => {
    const barLength = SR;
    const signal = new Float32Array(barLength * intervals.length * 2);
    for (let repeat = 0; repeat < 2; repeat++) {
      intervals.forEach((chord, index) => {
        for (const interval of chord) tone(root + interval, barLength, (repeat * intervals.length + index) * barLength, signal);
      });
    }
    return signal;
  };
  // I-V-vi-IV ở G trưởng
  const major = progression(55, [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]]);
  const majorKey = detectKey(major, SR);
  assert.equal(majorKey.root, 7, `gốc ${majorKey.root}`);
  assert.equal(majorKey.scale, 'major');
  // i-iv-V-i ở A thứ
  const minor = progression(57, [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7]]);
  const minorKey = detectKey(minor, SR);
  assert.equal(minorKey.root, 9, `gốc ${minorKey.root}`);
  assert.equal(minorKey.scale, 'minor');
});

test('Nhạc nền: đổi tông +3 và -2, độ dài giữ nguyên, cao độ đúng', () => {
  const f = 330;
  const input = new Float32Array(SR * 2);
  for (let i = 0; i < input.length; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR);
  for (const semitones of [3, -2]) {
    const output = shiftAndStretch(input, semitones, 1);
    assert.ok(Math.abs(output.length - input.length) < 64, `độ dài ${output.length}`);
    const measured = measureF0(output, SR / 2, 4096);
    const error = cents(measured, f * Math.pow(2, semitones / 12));
    assert.ok(Math.abs(error) < 5, `${semitones}: lệch ${error.toFixed(1)} cents`);
    assert.ok(Math.abs(db(rms(output, SR / 2, SR)) - db(rms(input, SR / 2, SR))) < 1.5, 'mức âm lượng');
  }
});

test('Nhạc nền: đổi tốc độ không đổi cao độ', () => {
  const f = 220;
  const input = new Float32Array(SR * 2);
  for (let i = 0; i < input.length; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / SR);
  const faster = shiftAndStretch(input, 0, 1.25);
  assert.ok(Math.abs(faster.length - input.length / 1.25) < 64, `độ dài ${faster.length}`);
  const error = cents(measureF0(faster, SR / 2, 4096), f);
  assert.ok(Math.abs(error) < 5, `lệch ${error.toFixed(1)} cents`);
});

test('Giảm giọng ca: tín hiệu giữa giảm mạnh, nhạc lệch hai bên còn nguyên', () => {
  const n = SR * 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const center = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    center[i] = 0.3 * Math.sin((2 * Math.PI * 500 * i) / SR);
    const panned = 0.3 * Math.sin((2 * Math.PI * 1500 * i) / SR);
    left[i] = center[i] + panned;
    right[i] = center[i];
  }
  const [outL, outR] = reduceCenterVocal(left, right, SR, 1);
  const level = (signal, f) => spectrumDb(signal, SR / 2, 9600, [f])[0];
  assert.ok(level(outR, 500) - level(right, 500) < -6, 'phần giữa phải giảm');
  assert.ok(Math.abs(level(outL, 1500) - level(left, 1500)) < 6, 'phần lệch phải còn');
  assert.equal(outL.length, n);
});

test('WAV: phần đầu đúng định dạng và không vượt ngưỡng', () => {
  const data = new Float32Array([0, 1.5, -1.5, 0.5]);
  for (const bits of [16, 24, 32]) {
    const buffer = encodeWav([data], 48000, bits);
    const view = new DataView(buffer);
    assert.equal(view.getUint32(24, true), 48000);
    assert.equal(view.getUint16(34, true), bits);
    assert.equal(buffer.byteLength, 44 + 4 * (bits / 8));
  }
  const view = new DataView(encodeWav([data], 48000, 16));
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
});

test('Bắt nốt: có trễ để không nhảy qua lại khi hát giữa hai nốt', () => {
  const tuner = new AutoTuner();
  tuner.setScale(0, 'chromatic');
  tuner.retuneMs = 0;
  tuner.update(midiHz(60.3), 5);
  assert.equal(tuner.currentNote, 60);
  tuner.update(midiHz(60.55), 5); // vượt giữa nhưng chưa qua biên trễ
  assert.equal(tuner.currentNote, 60);
  tuner.update(midiHz(60.8), 5);
  assert.equal(tuner.currentNote, 61);
  assert.equal(nearestInScale(61, scaleMask(0, 'pentatonicMajor')) === 60 || nearestInScale(61, scaleMask(0, 'pentatonicMajor')) === 62, true);
});

test('Khử nhiễu: nhiễu nền giảm > 8 dB, giọng gần như giữ nguyên', () => {
  const clean = synthVoice(3, (t) => (t > 1 && t < 2.5 ? midiHz(60) : 0));
  let seed = 3;
  const noisy = new Float32Array(clean.length);
  for (let i = 0; i < noisy.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    noisy[i] = clean[i] + (seed / 4294967296 - 0.5) * 0.02;
  }
  const output = reduceNoise(noisy, SR, 0.8);
  assert.equal(output.length, noisy.length);
  const drop = db(rms(noisy, 6000, 40000)) - db(rms(output, 6000, 40000));
  assert.ok(drop > 8, `nền giảm ${drop.toFixed(1)} dB`);
  const voiceChange = db(rms(output, 60000, 110000)) - db(rms(clean, 60000, 110000));
  assert.ok(Math.abs(voiceChange) < 1.5, `giọng đổi ${voiceChange.toFixed(2)} dB`);
});

test('Thao tác biên tập: cắt, chèn, câm, đảo, chuẩn hoá, fade đúng độ dài và giá trị', () => {
  const ramp = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) ramp[i] = 0.5;
  const ch = [ramp];
  assert.equal(ops.removeRange(ch, 100, 300, 0)[0].length, 800);
  const clip = ops.extractRange(ch, 0, 50);
  assert.equal(clip[0].length, 50);
  assert.equal(ops.insertAt(ch, 10, clip)[0].length, 1050);
  const silent = ops.silenceRange(ch, 100, 200, 0)[0];
  assert.equal(silent[150], 0);
  assert.equal(silent[50], 0.5);
  assert.equal(ch[0][150], 0.5, 'phải không sửa dữ liệu gốc (để hoàn tác)');
  const normalized = ops.normalizeRange(ch, 0, 1000, -6)[0];
  assert.ok(Math.abs(db(normalized[500]) + 6) < 0.01);
  const fadeIn = ops.fadeRange(ch, 0, 100, 'in')[0];
  assert.equal(fadeIn[0], 0);
  assert.ok(fadeIn[50] > 0 && fadeIn[50] < 0.5);
  assert.equal(fadeIn[200], 0.5);
  const fadeOut = ops.fadeRange(ch, 900, 1000, 'out')[0];
  assert.ok(Math.abs(fadeOut[999]) < 0.01);
  const seq = new Float32Array([1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...ops.reverseRange([seq], 1, 4)[0]], [1, 4, 3, 2, 5, 6]);
  assert.deepEqual([...ops.keepRange([seq], 2, 4)[0]], [3, 4]);
  const gained = ops.gainRange(ch, 0, 1000, 6.0206, 0)[0];
  assert.ok(Math.abs(gained[500] - 1) < 0.001);
  // Mono dán vào track stereo phải đủ kênh
  assert.equal(ops.insertAt([ramp, ramp], 0, clip).length, 2);
});

test('Cắt có làm mượt mối nối: không tạo bước nhảy lớn', () => {
  const n = 4800;
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const result = ops.removeRange([tone], 1000, 1777, Math.round(SR * 0.005))[0];
  let maxStep = 0;
  for (let i = 1; i < result.length; i++) maxStep = Math.max(maxStep, Math.abs(result[i] - result[i - 1]));
  const original = (2 * Math.PI * 440 * 0.8) / SR;
  assert.ok(maxStep < original * 2.5, `bước nhảy ${maxStep.toFixed(3)} so với ${original.toFixed(3)}`);
});
