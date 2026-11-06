// Chuỗi hiệu ứng giọng dùng chung cho thời gian thực và xuất file.

export const DEFAULT_FX = {
  low: 0, // dB, ấm giọng (lọc kệ 200 Hz)
  presence: 0, // dB, rõ lời (3 kHz)
  air: 0, // dB, sáng (11 kHz)
  comp: 0, // 0..1, nén
  echo: 0, // 0..1, lượng vang lặp
  echoTime: 0.3, // giây
  echoFeedback: 0.3, // 0..0.85
  reverb: 0, // 0..1, lượng vang phòng
  reverbSize: 1.8, // giây
};

const impulseCache = new Map();

/** Tạo đáp ứng xung phòng hát bằng nhiễu giảm dần, tối dần theo thời gian. */
export function makeImpulse(sampleRate, seconds) {
  const key = `${sampleRate}:${seconds.toFixed(2)}`;
  if (impulseCache.has(key)) return impulseCache.get(key);
  const length = Math.round(seconds * sampleRate);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const predelay = Math.round(0.018 * sampleRate);
  let seed = 22222;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  let lowL = 0;
  let lowR = 0;
  for (let i = predelay; i < length; i++) {
    const t = (i - predelay) / (length - predelay);
    const envelope = Math.pow(1 - t, 2.6) * Math.min(1, (i - predelay) / (0.004 * sampleRate));
    // Tần số cao tắt nhanh hơn, giống tường phòng thật.
    const damping = 0.55 - 0.47 * t;
    lowL += (random() - lowL) * damping;
    lowR += (random() - lowR) * damping;
    left[i] = lowL * envelope;
    right[i] = lowR * envelope;
  }
  const impulse = { left, right, length, sampleRate };
  impulseCache.set(key, impulse);
  return impulse;
}

function toBuffer(context, impulse) {
  const buffer = context.createBuffer(2, impulse.length, impulse.sampleRate);
  buffer.copyToChannel(impulse.left, 0);
  buffer.copyToChannel(impulse.right, 1);
  return buffer;
}

/**
 * @param {BaseAudioContext} context
 * @param {{nativeCompressor?:boolean}} [options]
 *   nativeCompressor: dùng DynamicsCompressor (có 6 ms lookahead) cho xuất file;
 *   khi hát trực tiếp, bộ nén nằm trong worklet để không thêm độ trễ.
 */
export function createVocalChain(context, options = {}) {
  const input = context.createGain();
  const output = context.createGain();

  const low = context.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 200;
  const presence = context.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 3000;
  presence.Q.value = 0.8;
  const air = context.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 11000;
  input.connect(low);
  low.connect(presence);
  presence.connect(air);

  let last = air;
  let compressor = null;
  if (options.nativeCompressor) {
    compressor = context.createDynamicsCompressor();
    compressor.knee.value = 12;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.14;
    last.connect(compressor);
    last = compressor;
  }
  last.connect(output);

  const echoSend = context.createGain();
  const delay = context.createDelay(2);
  const feedback = context.createGain();
  const echoTone = context.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 4200;
  last.connect(echoSend);
  echoSend.connect(delay);
  delay.connect(echoTone);
  echoTone.connect(feedback);
  feedback.connect(delay);
  echoTone.connect(output);

  const reverbSend = context.createGain();
  const convolver = context.createConvolver();
  convolver.normalize = true;
  last.connect(reverbSend);
  reverbSend.connect(convolver);
  convolver.connect(output);
  // Vang cũng đi qua phần tiếng lặp để hoà vào nhau tự nhiên.
  echoTone.connect(reverbSend);

  let reverbSize = -1;

  const apply = (fx) => {
    const merged = { ...DEFAULT_FX, ...fx };
    low.gain.value = merged.low;
    presence.gain.value = merged.presence;
    air.gain.value = merged.air;
    delay.delayTime.value = merged.echoTime;
    feedback.gain.value = Math.min(0.85, merged.echoFeedback);
    echoSend.gain.value = merged.echo * 0.8;
    reverbSend.gain.value = merged.reverb * 1.6;
    if (merged.reverbSize !== reverbSize) {
      reverbSize = merged.reverbSize;
      convolver.buffer = toBuffer(context, makeImpulse(context.sampleRate, reverbSize));
    }
    if (compressor) {
      compressor.threshold.value = -12 - merged.comp * 16;
      compressor.ratio.value = 1 + merged.comp * 4;
      const makeup = merged.comp > 0 ? Math.pow(10, ((12 + merged.comp * 16) * (1 - 1 / (1 + merged.comp * 4)) * 0.55) / 20) : 1;
      output.gain.value = makeup;
    }
  };

  return { input, output, apply };
}

/** Giới hạn mềm cuối cùng; không có lookahead nên không thêm độ trễ. */
export function createSoftLimiter(context) {
  const pre = context.createGain();
  pre.gain.value = 0.5;
  const shaper = context.createWaveShaper();
  const size = 8193;
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const y = ((i / (size - 1)) * 2 - 1) * 2;
    const magnitude = Math.abs(y);
    const shaped = magnitude < 0.8 ? magnitude : 0.8 + 0.19 * Math.tanh((magnitude - 0.8) / 0.19);
    curve[i] = Math.sign(y) * shaped;
  }
  shaper.curve = curve;
  pre.connect(shaper);
  return { input: pre, output: shaper };
}
