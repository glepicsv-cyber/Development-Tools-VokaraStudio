// Các việc nặng chạy trong worker để giao diện và âm thanh không bị giật.

import { analyzePitch } from '../dsp/yin.js';
import { segmentNotes, buildCurve } from '../dsp/notes.js';
import { renderPsola } from '../dsp/psola.js';
import { detectKey } from '../dsp/keydetect.js';
import { shiftAndStretch, reduceCenterVocal } from '../dsp/timestretch.js';
import { reduceNoise } from '../dsp/denoise.js';
import { encodeWav } from '../dsp/wav.js';

const handlers = {
  analyzePitch({ samples, sampleRate }, progress) {
    const analysis = analyzePitch(samples, sampleRate, { minF0: 65, maxF0: 1100, onProgress: progress });
    const notes = segmentNotes(analysis);
    return { result: { analysis, notes }, transfer: [analysis.f0.buffer, analysis.confidence.buffer, analysis.rms.buffer] };
  },

  renderPitch({ channels, sampleRate, analysis, notes, formant }, progress) {
    const curve = buildCurve(analysis, notes);
    const out = channels.map((samples, index) =>
      renderPsola(samples, sampleRate, curve, {
        minF0: 60,
        formant: formant ?? 1,
        onProgress: (p) => progress((index + p) / channels.length),
      }),
    );
    return { result: { channels: out, outMidi: curve.outMidi }, transfer: [...out.map((c) => c.buffer), curve.outMidi.buffer] };
  },

  detectKey({ samples, sampleRate }) {
    return { result: detectKey(samples, sampleRate), transfer: [] };
  },

  prepareBeat({ channels, sampleRate, semitones, tempo, vocalReduce }, progress) {
    let working = channels;
    const hasReduce = vocalReduce > 0 && channels.length >= 2;
    if (hasReduce) {
      working = reduceCenterVocal(channels[0], channels[1], sampleRate, vocalReduce, (p) => progress(p * 0.3));
    }
    const base = hasReduce ? 0.3 : 0;
    const out = working.map((samples, index) =>
      shiftAndStretch(samples, semitones, tempo, (p) => progress(base + ((index + p) / working.length) * (1 - base))),
    );
    return { result: { channels: out }, transfer: [] };
  },

  denoise({ channels, sampleRate, strength }, progress) {
    const out = channels.map((samples, index) =>
      reduceNoise(samples, sampleRate, strength, (p) => progress((index + p) / channels.length)),
    );
    return { result: { channels: out }, transfer: out.map((c) => c.buffer) };
  },

  encodeWav({ channels, sampleRate, bitDepth }) {
    const buffer = encodeWav(channels, sampleRate, bitDepth);
    return { result: { buffer }, transfer: [buffer] };
  },
};

self.onmessage = (event) => {
  const { id, type, payload } = event.data;
  try {
    const progress = (value) => self.postMessage({ id, progress: value });
    const { result, transfer } = handlers[type](payload, progress);
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
