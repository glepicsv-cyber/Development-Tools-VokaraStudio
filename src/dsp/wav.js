// Mã hoá WAV (PCM 16/24-bit, float 32-bit).

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {16|24|32} bitDepth
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate, bitDepth = 24) {
  const channelCount = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const dataSize = frames * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeTag = (offset, tag) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = channels[channel][frame];
      if (bitDepth === 32) {
        view.setFloat32(offset, sample, true);
      } else {
        const clipped = Math.max(-1, Math.min(1, sample));
        if (bitDepth === 16) {
          view.setInt16(offset, clipped < 0 ? clipped * 32768 : clipped * 32767, true);
        } else {
          const value = Math.round(clipped < 0 ? clipped * 8388608 : clipped * 8388607);
          view.setUint8(offset, value & 0xff);
          view.setUint8(offset + 1, (value >> 8) & 0xff);
          view.setUint8(offset + 2, (value >> 16) & 0xff);
        }
      }
      offset += bytesPerSample;
    }
  }
  return buffer;
}
