import test from 'node:test';
import assert from 'node:assert/strict';
import { SR, synthVoice, midiHz, cents, measureF0, median, rms, db, runBlocks } from '../helpers.js';
import { RealtimeVoiceProcessor } from '../../src/dsp/realtime.js';

test('Chạy dài: mô phỏng 3 phút hát có nghỉ, không NaN, không trôi cao độ hay âm lượng', () => {
  const processor = new RealtimeVoiceProcessor(SR, 'mid');
  processor.tuner.setScale(0, 'chromatic');
  processor.tuner.retuneMs = 20;
  const phrase = synthVoice(2, (t) => (t < 1.5 ? midiHz(57.3) : 0));
  const block = new Float32Array(128);
  const out = new Float32Array(128);
  const repeats = 90;
  const lastOutput = new Float32Array(phrase.length);
  let firstLevel = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (let pos = 0; pos + 128 <= phrase.length; pos += 128) {
      block.set(phrase.subarray(pos, pos + 128));
      processor.process(block, out);
      for (let i = 0; i < 128; i++) assert.ok(Number.isFinite(out[i]));
      if (repeat === 0 || repeat === repeats - 1) lastOutput.set(out, pos);
    }
    if (repeat === 0) firstLevel = db(rms(lastOutput, 24000, 60000));
  }
  const errors = [];
  for (let t = 0.5; t < 1.3; t += 0.02) {
    const f = measureF0(lastOutput, Math.round(t * SR), 2048);
    if (f > 0) errors.push(cents(f, midiHz(57)));
  }
  assert.ok(errors.length > 20, 'phải đo được ở vòng cuối');
  assert.ok(Math.abs(median(errors)) < 8, `sau 3 phút lệch ${median(errors).toFixed(1)} cents`);
  const drift = db(rms(lastOutput, 24000, 60000)) - firstLevel;
  assert.ok(Math.abs(drift) < 0.5, `âm lượng trôi ${drift.toFixed(2)} dB`);
});

test('Đổi loại giọng giữa chừng không hỏng trạng thái', () => {
  const processor = new RealtimeVoiceProcessor(SR, 'mid');
  const input = synthVoice(1, () => midiHz(69));
  runBlocks(processor, input);
  processor.setVoice('high');
  const output = runBlocks(processor, input, processor.latency);
  for (const value of output) assert.ok(Number.isFinite(value));
  assert.ok(rms(output, 24000, 44000) > 0.01);
});
