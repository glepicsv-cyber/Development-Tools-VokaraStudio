// Chạy trên luồng âm thanh thời gian thực của Chromium.

import { RealtimeVoiceProcessor } from '../dsp/realtime.js';

class Compressor {
  constructor(rate) {
    this.attack = Math.exp(-1 / (rate * 0.005));
    this.release = Math.exp(-1 / (rate * 0.14));
    this.env = 0;
    this.amount = 0;
  }

  process(block) {
    if (this.amount <= 0) return;
    const threshold = -12 - this.amount * 16;
    const ratio = 1 + this.amount * 4;
    const makeup = Math.pow(10, (-threshold * (1 - 1 / ratio) * 0.55) / 20);
    let env = this.env;
    for (let i = 0; i < block.length; i++) {
      const level = Math.abs(block[i]);
      env = level > env ? level + (env - level) * this.attack : level + (env - level) * this.release;
      const db = 20 * Math.log10(env + 1e-8);
      const over = db - threshold;
      const gainDb = over > 0 ? -over * (1 - 1 / ratio) : 0;
      block[i] *= Math.pow(10, gainDb / 20) * makeup;
    }
    this.env = env;
  }
}

class VoiceProcessorNode extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.core = new RealtimeVoiceProcessor(sampleRate, opts.voice || 'mid', 128);
    this.compressor = new Compressor(sampleRate);
    this.tick = 0;
    this.scratchIn = new Float32Array(128);
    this.scratchOut = new Float32Array(128);
    this.peakMs = 0;
    this.port.onmessage = (event) => this.applyParams(event.data);
    this.port.postMessage({ type: 'ready', latency: this.core.latency / sampleRate });
  }

  applyParams(params) {
    const core = this.core;
    const tuner = core.tuner;
    if (params.voice !== undefined && params.voice !== core.voice) {
      core.setVoice(params.voice);
      this.port.postMessage({ type: 'ready', latency: core.latency / sampleRate });
    }
    if (params.root !== undefined) tuner.setScale(params.root, params.scale);
    if (params.retuneMs !== undefined) tuner.retuneMs = params.retuneMs;
    if (params.amount !== undefined) tuner.amount = params.amount;
    if (params.transpose !== undefined) tuner.transpose = params.transpose;
    if (params.enabled !== undefined) tuner.enabled = params.enabled;
    if (params.gateDb !== undefined) core.gateDb = params.gateDb;
    if (params.formant !== undefined) core.psola.formant = Math.pow(2, params.formant / 12);
    if (params.comp !== undefined) this.compressor.amount = params.comp;
    // Khi không sửa gì thì đi đường nguyên bản để giọng hoàn toàn trong suốt.
    core.bypass = !tuner.enabled && tuner.transpose === 0 && Math.abs(core.psola.formant - 1) < 1e-6;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const source = input && input[0] ? input[0] : this.scratchIn;
    if (source === this.scratchIn) this.scratchIn.fill(0);

    this.core.process(source, this.scratchOut);
    this.compressor.process(this.scratchOut);
    for (let channel = 0; channel < output.length; channel++) output[channel].set(this.scratchOut);

    if (++this.tick >= 6) {
      this.tick = 0;
      const status = this.core.status;
      this.port.postMessage({
        type: 'status',
        inMidi: status.inMidi,
        outMidi: status.outMidi,
        note: status.note,
        rms: status.rms,
      });
    }
    return true;
  }
}

registerProcessor('voice-processor', VoiceProcessorNode);
