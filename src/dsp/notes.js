// Chia đường cao độ thành các nốt để sửa, và dựng đường cong dịch cho bản render.

import { hzToMidi, nearestInScale, scaleMask } from './scales.js';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : 0;
}

/**
 * @param {{f0:Float32Array, hop:number, sampleRate:number}} analysis
 * @returns {Array<{id:number,start:number,end:number,pitch:number,shift:number,flatten:number}>}
 *   start/end là chỉ số khung; pitch là cao độ trung vị theo MIDI.
 */
export function segmentNotes(analysis, options = {}) {
  const { f0, hop, sampleRate } = analysis;
  const frameMs = (hop / sampleRate) * 1000;
  const splitSemitones = options.splitSemitones ?? 0.75;
  const stableFrames = Math.max(2, Math.round((options.stableMs ?? 50) / frameMs));
  const minFrames = Math.max(2, Math.round((options.minNoteMs ?? 70) / frameMs));
  const notes = [];
  let id = 1;

  const emit = (start, end) => {
    if (end - start < minFrames) return;
    const pitches = [];
    for (let i = start; i < end; i++) if (f0[i] > 0) pitches.push(hzToMidi(f0[i]));
    if (pitches.length < minFrames / 2) return;
    notes.push({ id: id++, start, end, pitch: median(pitches), shift: 0, flatten: 0 });
  };

  let i = 0;
  while (i < f0.length) {
    if (f0[i] <= 0) {
      i++;
      continue;
    }
    let phraseEnd = i;
    while (phraseEnd < f0.length && f0[phraseEnd] > 0) phraseEnd++;

    // Trong một cụm hữu thanh liền mạch, tách nốt khi cao độ rời hẳn nốt cũ đủ lâu.
    let noteStart = i;
    let reference = hzToMidi(f0[i]);
    let runningSum = reference;
    let runningCount = 1;
    let awayCount = 0;
    let awayStart = -1;
    for (let k = i + 1; k < phraseEnd; k++) {
      const midi = hzToMidi(f0[k]);
      if (Math.abs(midi - reference) > splitSemitones) {
        if (awayCount === 0) awayStart = k;
        awayCount++;
        if (awayCount >= stableFrames) {
          emit(noteStart, awayStart);
          noteStart = awayStart;
          reference = midi;
          runningSum = midi;
          runningCount = 1;
          awayCount = 0;
        }
      } else {
        awayCount = 0;
        runningSum += midi;
        runningCount++;
        reference = runningSum / runningCount;
      }
    }
    emit(noteStart, phraseEnd);
    i = phraseEnd;
  }
  return notes;
}

/**
 * Tự sửa các nốt về âm giai.
 * @param {number} strength 0..1 mức kéo
 * @param {number} flatten 0..1 mức làm phẳng dao động cao độ
 */
export function autoCorrectNotes(notes, rootPc, scaleId, strength = 1, flatten = 0.5) {
  const mask = scaleMask(rootPc, scaleId);
  for (const note of notes) {
    const target = nearestInScale(note.pitch, mask);
    note.shift = (target - note.pitch) * strength;
    note.flatten = flatten;
  }
  return notes;
}

/**
 * Dựng đường cong dịch từng khung từ các nốt đã sửa.
 * @returns {{hop:number, f0:Float32Array, ratio:Float32Array, outMidi:Float32Array}}
 */
export function buildCurve(analysis, notes, options = {}) {
  const { f0, hop, sampleRate } = analysis;
  const frameMs = (hop / sampleRate) * 1000;
  const n = f0.length;
  const shift = new Float32Array(n);
  const globalShift = options.transpose ?? 0;

  const sorted = [...notes].sort((a, b) => a.start - b.start);
  for (const note of sorted) {
    for (let i = note.start; i < note.end && i < n; i++) {
      if (f0[i] <= 0) continue;
      const midi = hzToMidi(f0[i]);
      // flatten kéo đường cao độ về trung vị của nốt.
      const flattenAmount = (note.pitch - midi) * note.flatten;
      shift[i] = note.shift + flattenAmount;
    }
  }

  // Mở rộng độ dịch của mỗi nốt qua các đoạn hữu thanh chưa thuộc nốt nào,
  // rồi làm trơn để ranh giới nốt không nghe như bị bẻ.
  const owned = new Uint8Array(n);
  for (const note of sorted) owned.fill(1, Math.max(0, note.start), Math.min(n, note.end));
  let lastValue = 0;
  for (let i = 0; i < n; i++) {
    if (owned[i]) lastValue = shift[i];
    else if (f0[i] > 0) shift[i] = lastValue;
    else lastValue = 0;
  }

  const smoothFrames = Math.max(1, Math.round((options.smoothMs ?? 25) / frameMs));
  const smoothed = movingAverage(shift, smoothFrames);
  // Trong nốt ta muốn giữ độ phẳng: chỉ dùng bản làm trơn gần ranh giới nốt.
  const boundaryBlend = new Float32Array(n);
  for (const note of sorted) {
    const start = Math.max(0, note.start);
    const end = Math.min(n, note.end);
    for (let i = start; i < end; i++) {
      const fromEdge = Math.min(i - start, end - 1 - i);
      boundaryBlend[i] = Math.min(1, fromEdge / smoothFrames);
    }
  }

  const ratio = new Float32Array(n);
  const outMidi = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (f0[i] <= 0) {
      ratio[i] = Math.pow(2, globalShift / 12);
      outMidi[i] = 0;
      continue;
    }
    const blend = boundaryBlend[i];
    const value = shift[i] * blend + smoothed[i] * (1 - blend) + globalShift;
    ratio[i] = Math.pow(2, value / 12);
    outMidi[i] = hzToMidi(f0[i]) + value;
  }
  return { hop, f0, ratio, outMidi };
}

function movingAverage(values, radius) {
  const n = values.length;
  const out = new Float32Array(n);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    count++;
    if (i - radius - 1 >= 0) {
      sum -= values[i - radius - 1];
      count--;
    }
    // Trung bình lệch tâm được bù bằng cách ghi vào i - radius/2 bên dưới.
    const index = i - (radius >> 1);
    if (index >= 0) out[index] = sum / count;
  }
  for (let i = Math.max(0, n - (radius >> 1)); i < n; i++) out[i] = values[i];
  return out;
}
