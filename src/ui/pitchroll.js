// Đồ thị cao độ cuộn theo thời gian thực trên màn hát.

import { fitCanvas, strokeWithGlow, TOKENS } from './common.js';
import { NOTE_NAMES } from '../dsp/scales.js';

const HISTORY_SECONDS = 8;
const SPAN_SEMITONES = 19;
const GUTTER = 48;

export class PitchRoll {
  constructor(canvas) {
    this.canvas = canvas;
    this.points = [];
    this.center = 60;
    this.targetCenter = 60;
    this.mask = new Array(12).fill(true);
    this.root = 0;
    this.activeNote = null;
  }

  setScale(mask, root) {
    this.mask = mask;
    this.root = root;
  }

  /** Thêm một mẫu đọc từ worklet. */
  push(time, inMidi, outMidi, note) {
    this.points.push({ time, inMidi, outMidi });
    this.activeNote = note;
    while (this.points.length && this.points[0].time < time - HISTORY_SECONDS - 0.5) this.points.shift();
    if (inMidi > 0) {
      // Giữ nốt đang hát ở giữa, nhưng không lắc khi chỉ đổi một hai nốt.
      if (Math.abs(outMidi - this.targetCenter) > SPAN_SEMITONES * 0.3) this.targetCenter = outMidi;
    }
  }

  draw(now) {
    const { context: g, width, height } = fitCanvas(this.canvas);
    this.center += (this.targetCenter - this.center) * 0.05;
    g.fillStyle = TOKENS.bg;
    g.fillRect(0, 0, width, height);

    const semitoneHeight = height / SPAN_SEMITONES;
    const yOf = (midi) => height / 2 - (midi - this.center) * semitoneHeight;
    const lowest = Math.floor(this.center - SPAN_SEMITONES / 2) - 1;
    const highest = Math.ceil(this.center + SPAN_SEMITONES / 2) + 1;
    const plotWidth = width - GUTTER;
    const xOf = (time) => GUTTER + plotWidth - ((now - time) / HISTORY_SECONDS) * plotWidth;

    const stripe = g.createLinearGradient(GUTTER, 0, width, 0);
    stripe.addColorStop(0, 'rgba(34,211,238,0.075)');
    stripe.addColorStop(0.55, 'rgba(168,85,247,0.06)');
    stripe.addColorStop(1, 'rgba(255,95,162,0.045)');

    const labelStep = Math.ceil(13 / semitoneHeight);
    g.font = '11px "Segoe UI", sans-serif';
    g.textBaseline = 'middle';
    for (let midi = lowest; midi <= highest; midi++) {
      const pc = ((midi % 12) + 12) % 12;
      const y = yOf(midi);
      const inScale = this.mask[pc];
      if (inScale) {
        g.fillStyle = pc === this.root ? 'rgba(255,157,46,0.13)' : stripe;
        g.fillRect(GUTTER, y - semitoneHeight / 2 + 0.5, plotWidth, semitoneHeight - 1);
      }
      if (midi === this.activeNote) {
        g.fillStyle = 'rgba(255,157,46,0.2)';
        g.fillRect(GUTTER, y - semitoneHeight / 2, plotWidth, semitoneHeight);
      }
      // Hàng thấp thì chỉ ghi nhãn cách quãng để chữ không chồng lên nhau.
      if (midi !== this.activeNote) {
        if (midi % labelStep !== 0) continue;
        if (this.activeNote !== null && Math.abs(midi - this.activeNote) < labelStep) continue;
      }
      g.fillStyle = midi === this.activeNote ? TOKENS.accent : inScale ? TOKENS.muted : TOKENS.faint;
      g.textAlign = 'right';
      g.fillText(NOTE_NAMES[pc] + (Math.floor(midi / 12) - 1), GUTTER - 8, y);
    }
    g.strokeStyle = TOKENS.line;
    g.beginPath();
    g.moveTo(GUTTER + 0.5, 0);
    g.lineTo(GUTTER + 0.5, height);
    g.stroke();

    // Đường cũ cuộn ra khỏi vùng vẽ không được đè lên nhãn nốt.
    g.save();
    g.beginPath();
    g.rect(GUTTER, 0, plotWidth, height);
    g.clip();
    this.drawLine(g, xOf, yOf, 'inMidi', TOKENS.raw, 1.5, 0.75);
    this.drawLine(g, xOf, yOf, 'outMidi', TOKENS.accent, 2.5, 1);
    g.restore();
  }

  drawLine(g, xOf, yOf, key, color, lineWidth, alpha) {
    g.lineJoin = 'round';
    g.beginPath();
    let drawing = false;
    let previous = 0;
    for (const point of this.points) {
      const value = point[key];
      if (value <= 0 || (drawing && Math.abs(value - previous) > 3)) {
        drawing = false;
        if (value <= 0) continue;
      }
      const x = xOf(point.time);
      const y = yOf(value);
      if (drawing) g.lineTo(x, y);
      else g.moveTo(x, y);
      drawing = true;
      previous = value;
    }
    strokeWithGlow(g, color, lineWidth, alpha);
  }
}
