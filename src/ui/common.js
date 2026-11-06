// Tiện ích giao diện dùng chung.

export const $ = (id) => document.getElementById(id);

export function formatTime(seconds, withMs = false) {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  if (withMs) return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
  return `${minutes}:${String(Math.floor(rest)).padStart(2, '0')}`;
}

/**
 * Thanh trượt có nhãn và giá trị.
 * @returns {{root:HTMLElement, set:(v:number)=>void, get:()=>number}}
 */
export function createSlider({ label, min, max, step = 1, value, format = (v) => String(v), onInput, title }) {
  const root = document.createElement('label');
  root.className = 'slider';
  if (title) root.title = title;
  const name = document.createElement('span');
  name.textContent = label;
  const display = document.createElement('span');
  display.className = 'slider-value';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;
  const refresh = () => {
    const current = Number(input.value);
    display.textContent = format(current);
    const percent = ((current - min) / (max - min)) * 100;
    // Thanh có cả âm lẫn dương thì tô từ điểm 0 ra hai phía.
    const zero = min < 0 && max > 0 ? (-min / (max - min)) * 100 : 0;
    input.style.setProperty('--from', `${Math.min(zero, percent)}%`);
    input.style.setProperty('--to', `${Math.max(zero, percent)}%`);
  };
  input.addEventListener('input', () => {
    refresh();
    if (onInput) onInput(Number(input.value));
  });
  // Bấm đúp đưa về giá trị mặc định.
  input.addEventListener('dblclick', () => {
    input.value = value;
    refresh();
    if (onInput) onInput(Number(input.value));
  });
  refresh();
  root.append(name, display, input);
  return {
    root,
    input,
    set(next) {
      input.value = next;
      refresh();
    },
    get: () => Number(input.value),
  };
}

let toastTimer = 0;
export function toast(message, { error = false, ms = 4200 } = {}) {
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, ms);
}

export function setStatus(text, progress = null) {
  const bar = $('statusBar');
  if (text === null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('statusText').textContent = text;
  $('statusFill').style.width = progress === null ? '100%' : `${Math.round(progress * 100)}%`;
}

/** Chỉnh kích thước canvas theo CSS và mật độ điểm ảnh. */
export function fitCanvas(canvas, cssWidth, cssHeight) {
  const ratio = window.devicePixelRatio || 1;
  const width = cssWidth ?? canvas.clientWidth;
  const height = cssHeight ?? canvas.clientHeight;
  const pixelW = Math.max(1, Math.round(width * ratio));
  const pixelH = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

export const TOKENS = {
  bg: '#07090f',
  bg2: '#0b0e15',
  panel: '#10141d',
  panel2: '#171c27',
  line: '#1e2430',
  lineStrong: '#323a4a',
  text: '#f1f3f8',
  muted: '#a3acbd',
  faint: '#6d7688',
  accent: '#ff9d2e',
  raw: '#22d3ee',
  rec: '#ff5252',
};

const NEON_STOPS = [
  [255, 157, 46],
  [250, 204, 21],
  [74, 222, 128],
  [34, 211, 238],
  [168, 85, 247],
  [255, 95, 162],
];

/** Dải màu neon chia đều cho count vạch, trái sang phải. */
export function neonRamp(count) {
  const colors = [];
  for (let i = 0; i < count; i++) {
    const position = (count > 1 ? i / (count - 1) : 0) * (NEON_STOPS.length - 1);
    const index = Math.min(NEON_STOPS.length - 2, Math.floor(position));
    const mix = position - index;
    const [a, b] = [NEON_STOPS[index], NEON_STOPS[index + 1]];
    colors.push(`rgb(${a.map((value, c) => Math.round(value + (b[c] - value) * mix)).join(',')})`);
  }
  return colors;
}

/** Vẽ một đường hai lần: lớp rộng mờ làm quầng sáng, lớp mảnh ở trên. */
export function strokeWithGlow(g, color, lineWidth, alpha = 1) {
  g.strokeStyle = color;
  g.globalAlpha = 0.22 * alpha;
  g.lineWidth = lineWidth + 5;
  g.stroke();
  g.globalAlpha = alpha;
  g.lineWidth = lineWidth;
  g.stroke();
  g.globalAlpha = 1;
  g.lineWidth = 1;
}

/** Giọng mẫu: giá trị cho chỉnh cao độ và hiệu ứng. */
export const PRESETS = [
  {
    id: 'natural',
    name: 'Tự nhiên',
    tune: { retuneMs: 120, amount: 0.75 },
    fx: { reverb: 0.16, reverbSize: 1.4, echo: 0, echoTime: 0.28, echoFeedback: 0.25, low: 0, presence: 1, air: 1, comp: 0.3 },
  },
  {
    id: 'pop',
    name: 'Pop mượt',
    tune: { retuneMs: 45, amount: 0.95 },
    fx: { reverb: 0.26, reverbSize: 1.8, echo: 0.12, echoTime: 0.3, echoFeedback: 0.28, low: -1, presence: 2.5, air: 3, comp: 0.55 },
  },
  {
    id: 'ballad',
    name: 'Ballad',
    tune: { retuneMs: 90, amount: 0.85 },
    fx: { reverb: 0.42, reverbSize: 2.8, echo: 0.2, echoTime: 0.36, echoFeedback: 0.32, low: 1, presence: 1.5, air: 2, comp: 0.45 },
  },
  {
    id: 'bolero',
    name: 'Bolero',
    tune: { retuneMs: 160, amount: 0.7 },
    fx: { reverb: 0.48, reverbSize: 2.4, echo: 0.34, echoTime: 0.26, echoFeedback: 0.4, low: 2, presence: 1, air: 0, comp: 0.4 },
  },
  {
    id: 'room',
    name: 'Phòng hát',
    tune: { retuneMs: 70, amount: 0.85 },
    fx: { reverb: 0.34, reverbSize: 1.6, echo: 0.3, echoTime: 0.22, echoFeedback: 0.36, low: 1, presence: 2, air: 1, comp: 0.5 },
  },
  {
    id: 'robot',
    name: 'Bẻ nốt',
    tune: { retuneMs: 0, amount: 1 },
    fx: { reverb: 0.22, reverbSize: 1.5, echo: 0.1, echoTime: 0.25, echoFeedback: 0.25, low: 0, presence: 3, air: 3, comp: 0.6 },
  },
];
