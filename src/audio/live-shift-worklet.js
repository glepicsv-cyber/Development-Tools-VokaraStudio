// Đổi tông nhạc lấy trực tiếp từ trang web, chạy trên luồng âm thanh thời gian thực.

import { LivePitchShifter } from '../dsp/live-shift.js';

class LiveShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.shifter = new LivePitchShifter(sampleRate);
    this.silence = new Float32Array(128);
    this.port.onmessage = (event) => {
      if (typeof event.data.semitones === 'number') this.shifter.setSemitones(event.data.semitones);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const left = input[0] || this.silence;
    const right = input[1] || left;
    this.shifter.process(left, right, output[0], output[1] || output[0]);
    return true;
  }
}

registerProcessor('live-shift', LiveShiftProcessor);
