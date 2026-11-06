// Worker cổ điển vì thư viện lamejs là script toàn cục.
/* global lamejs */
importScripts('../vendor/lame.min.js');

self.onmessage = (event) => {
  const { id, payload } = event.data;
  try {
    const { channels, sampleRate, kbps } = payload;
    const channelCount = Math.min(2, channels.length);
    const encoder = new lamejs.Mp3Encoder(channelCount, sampleRate, kbps);
    const toInt16 = (data) => {
      const out = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const v = Math.max(-1, Math.min(1, data[i]));
        out[i] = v < 0 ? v * 32768 : v * 32767;
      }
      return out;
    };
    const left = toInt16(channels[0]);
    const right = channelCount > 1 ? toInt16(channels[1]) : null;
    const parts = [];
    const block = 1152;
    let total = 0;
    for (let i = 0; i < left.length; i += block) {
      const l = left.subarray(i, i + block);
      const data = right ? encoder.encodeBuffer(l, right.subarray(i, i + block)) : encoder.encodeBuffer(l);
      if (data.length) {
        parts.push(new Uint8Array(data));
        total += data.length;
      }
      if (i % (block * 500) === 0) self.postMessage({ id, progress: i / left.length });
    }
    const end = encoder.flush();
    if (end.length) {
      parts.push(new Uint8Array(end));
      total += end.length;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    self.postMessage({ id, result: { buffer: merged.buffer } }, [merged.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
