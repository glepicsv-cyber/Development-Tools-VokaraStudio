// Nốt nhạc, âm giai và phép "bắt nốt" gần nhất trong âm giai.

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const SCALES = {
  major: { label: 'Trưởng', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Thứ tự nhiên', steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { label: 'Thứ hoà âm', steps: [0, 2, 3, 5, 7, 8, 11] },
  pentatonicMajor: { label: 'Ngũ cung trưởng', steps: [0, 2, 4, 7, 9] },
  pentatonicMinor: { label: 'Ngũ cung thứ', steps: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  chromatic: { label: 'Mọi nốt', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi) {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  return NOTE_NAMES[pc] + (Math.floor(rounded / 12) - 1);
}

/** Trả về mảng 12 phần tử true/false cho biết nốt có thuộc âm giai không. */
export function scaleMask(rootPc, scaleId) {
  const scale = SCALES[scaleId] || SCALES.chromatic;
  const mask = new Array(12).fill(false);
  for (const step of scale.steps) mask[(rootPc + step) % 12] = true;
  return mask;
}

/** Nốt thuộc âm giai gần `midi` nhất. */
export function nearestInScale(midi, mask) {
  const center = Math.round(midi);
  let best = center;
  let bestDist = Infinity;
  for (let offset = -6; offset <= 6; offset++) {
    const candidate = center + offset;
    if (!mask[((candidate % 12) + 12) % 12]) continue;
    const dist = Math.abs(candidate - midi);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}
