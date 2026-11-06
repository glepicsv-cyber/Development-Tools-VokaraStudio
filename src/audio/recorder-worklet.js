// Ghi tín hiệu theo mẫu chính xác, bắt đầu từ một khung thời gian đã hẹn.

const CHUNK = 16384;

class RecorderNode extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = (options.processorOptions && options.processorOptions.channels) || 1;
    this.startFrame = Infinity;
    this.active = false;
    this.fill = 0;
    this.chunk = null;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'start') {
        this.startFrame = message.frame;
        this.active = true;
        this.fill = 0;
        this.chunk = this.newChunk();
      } else if (message.type === 'stop') {
        this.flush();
        this.active = false;
        this.port.postMessage({ type: 'done' });
      }
    };
  }

  newChunk() {
    const chunk = [];
    for (let c = 0; c < this.channels; c++) chunk.push(new Float32Array(CHUNK));
    return chunk;
  }

  flush() {
    if (!this.chunk || this.fill === 0) return;
    const out = this.chunk.map((data) => data.slice(0, this.fill));
    this.port.postMessage({ type: 'chunk', channels: out }, out.map((data) => data.buffer));
    this.fill = 0;
  }

  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0];
    const frames = 128;
    const skip = Math.max(0, this.startFrame - currentFrame);
    if (skip >= frames) return true;
    for (let i = skip; i < frames; i++) {
      for (let c = 0; c < this.channels; c++) {
        const source = input[Math.min(c, input.length - 1)];
        this.chunk[c][this.fill] = source ? source[i] : 0;
      }
      if (++this.fill === CHUNK) {
        const full = this.chunk;
        this.port.postMessage({ type: 'chunk', channels: full }, full.map((data) => data.buffer));
        this.chunk = this.newChunk();
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('recorder-node', RecorderNode);
