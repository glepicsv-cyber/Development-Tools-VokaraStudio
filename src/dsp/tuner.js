// Logic Auto-tune: từ cao độ hát được, tính cao độ đích và hệ số dịch.

import { hzToMidi, nearestInScale, scaleMask } from './scales.js';

export class AutoTuner {
  constructor() {
    this.setScale(0, 'chromatic');
    this.amount = 1; // 0..1: mức kéo về nốt đúng
    this.retuneMs = 40; // 0 = bẻ nốt tức thì (hiệu ứng robot)
    this.transpose = 0; // bán cung, dịch toàn bộ giọng
    this.enabled = true;
    this.hysteresis = 0.15; // bán cung: chống nhảy qua lại giữa 2 nốt
    this.currentNote = null;
    this.correction = 0;
    this.lastTime = 0;
  }

  setScale(rootPc, scaleId) {
    this.mask = scaleMask(rootPc, scaleId);
    this.currentNote = null;
  }

  reset() {
    this.currentNote = null;
    this.correction = 0;
  }

  /** Nốt đích cho `midi`, giữ nốt hiện tại khi người hát còn ở gần. */
  targetNote(midi) {
    if (this.currentNote !== null) {
      const pc = ((this.currentNote % 12) + 12) % 12;
      const stillInScale = this.mask[pc];
      const candidate = nearestInScale(midi, this.mask);
      if (candidate === this.currentNote) return candidate;
      if (stillInScale) {
        // Khoảng giữa hai nốt liền kề trong âm giai + biên trễ.
        const boundary = (this.currentNote + candidate) / 2;
        const distanceBeyond = (midi - boundary) * Math.sign(candidate - this.currentNote);
        if (distanceBeyond < this.hysteresis) return this.currentNote;
      }
    }
    return nearestInScale(midi, this.mask);
  }

  /**
   * @param {number} f0 Hz, 0 nếu vô thanh
   * @param {number} dtMs khoảng thời gian từ lần gọi trước
   * @returns {{ratio:number, inMidi:number, outMidi:number, note:number|null}}
   */
  update(f0, dtMs) {
    if (f0 <= 0) {
      this.currentNote = null;
      // Giữ phần dịch tông, bỏ phần sửa nốt để lần vào nốt sau bắt lại từ đầu.
      this.correction = 0;
      return {
        ratio: Math.pow(2, this.transpose / 12),
        inMidi: 0,
        outMidi: 0,
        note: null,
      };
    }

    const midi = hzToMidi(f0);
    let wanted = 0;
    if (this.enabled) {
      const note = this.targetNote(midi);
      const newNote = note !== this.currentNote;
      this.currentNote = note;
      wanted = note - midi;
      if (newNote && this.retuneMs <= 0) this.correction = wanted;
    } else {
      this.currentNote = null;
    }

    // Bộ lọc thông thấp trên độ sửa: retune chậm sẽ giữ vibrato nhanh,
    // retune nhanh sẽ là phẳng cao độ.
    if (this.retuneMs <= 0) {
      this.correction = wanted;
    } else {
      const alpha = 1 - Math.exp(-dtMs / this.retuneMs);
      this.correction += (wanted - this.correction) * alpha;
    }

    const shift = this.amount * this.correction + this.transpose;
    return {
      ratio: Math.pow(2, shift / 12),
      inMidi: midi,
      outMidi: midi + shift,
      note: this.currentNote,
    };
  }
}
