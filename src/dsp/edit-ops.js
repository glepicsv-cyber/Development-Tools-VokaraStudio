// Thao tác biên tập trên mảng kênh. Mọi hàm đều trả về dữ liệu mới và không sửa
// đầu vào, nhờ vậy hoàn tác chỉ cần giữ tham chiếu đến bản cũ.

const db2gain = (db) => Math.pow(10, db / 20);

function clampRange(length, start, end) {
  const a = Math.max(0, Math.min(length, Math.round(start)));
  const b = Math.max(a, Math.min(length, Math.round(end)));
  return [a, b];
}

export function extractRange(channels, start, end) {
  const [a, b] = clampRange(channels[0].length, start, end);
  return channels.map((ch) => ch.slice(a, b));
}

/** Xoá đoạn và kéo phần sau lên; làm mượt mối nối bằng crossfade. */
export function removeRange(channels, start, end, crossfade = 240) {
  return channels.map((ch) => {
    const [a, b] = clampRange(ch.length, start, end);
    const fade = Math.min(crossfade, a, ch.length - b);
    const out = new Float32Array(ch.length - (b - a));
    out.set(ch.subarray(0, a), 0);
    out.set(ch.subarray(b), a);
    for (let i = 0; i < fade; i++) {
      const t = (i + 0.5) / fade;
      const before = ch[a - fade + i];
      const after = ch[b - fade + i];
      out[a - fade + i] = before * Math.cos((t * Math.PI) / 2) + after * Math.sin((t * Math.PI) / 2);
    }
    return out;
  });
}

/** Chèn đoạn vào vị trí `position`. Đoạn ít kênh hơn sẽ được lặp cho đủ. */
export function insertAt(channels, position, clip) {
  return channels.map((ch, index) => {
    const data = clip[Math.min(index, clip.length - 1)];
    const at = Math.max(0, Math.min(ch.length, Math.round(position)));
    const out = new Float32Array(ch.length + data.length);
    out.set(ch.subarray(0, at), 0);
    out.set(data, at);
    out.set(ch.subarray(at), at + data.length);
    return out;
  });
}

function mapRange(channels, start, end, edit) {
  return channels.map((ch) => {
    const out = ch.slice();
    const [a, b] = clampRange(ch.length, start, end);
    edit(out, a, b);
    return out;
  });
}

/** Làm câm nhưng giữ nguyên thời lượng; hai đầu có fade ngắn chống tiếng nổ. */
export function silenceRange(channels, start, end, edgeFade = 48) {
  return mapRange(channels, start, end, (out, a, b) => {
    out.fill(0, a, b);
    const fade = Math.min(edgeFade, a, out.length - b);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      out[a - 1 - i] *= t;
      out[b + i] *= t;
    }
  });
}

export function gainRange(channels, start, end, gainDb, edgeFade = 48) {
  const gain = db2gain(gainDb);
  return mapRange(channels, start, end, (out, a, b) => {
    const fade = Math.min(edgeFade, (b - a) >> 1);
    for (let i = a; i < b; i++) {
      const edge = Math.min(i - a, b - 1 - i);
      const blend = fade > 0 && edge < fade ? edge / fade : 1;
      out[i] *= 1 + (gain - 1) * blend;
    }
  });
}

/** Đưa đỉnh của đoạn về `targetDb`, các kênh cùng hệ số để giữ cân bằng trái/phải. */
export function normalizeRange(channels, start, end, targetDb = -1) {
  let peak = 0;
  for (const ch of channels) {
    const [a, b] = clampRange(ch.length, start, end);
    for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(ch[i]));
  }
  if (peak < 1e-6) return channels.map((ch) => ch.slice());
  const gain = db2gain(targetDb) / peak;
  return mapRange(channels, start, end, (out, a, b) => {
    for (let i = a; i < b; i++) out[i] *= gain;
  });
}

export function fadeRange(channels, start, end, direction) {
  return mapRange(channels, start, end, (out, a, b) => {
    const length = Math.max(1, b - a);
    for (let i = a; i < b; i++) {
      const t = (i - a) / (direction === 'out' ? Math.max(1, length - 1) : length);
      // Đường cong công suất đều: nghe tự nhiên hơn đường thẳng.
      out[i] *= direction === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2);
    }
  });
}

export function reverseRange(channels, start, end) {
  return mapRange(channels, start, end, (out, a, b) => {
    out.subarray(a, b).reverse();
  });
}

export function keepRange(channels, start, end) {
  return extractRange(channels, start, end);
}

/** Ghép nhiều kênh thành một, dùng cho phân tích cao độ. */
export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) {
    for (let i = 0; i < out.length; i++) out[i] += ch[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}
