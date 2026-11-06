// Điểm vào của giao diện: chuyển tab, phím tắt, trạng thái chưa lưu.

import { $, toast } from './ui/common.js';
import { AudioEngine } from './audio/engine.js';
import { KaraokeView } from './ui/karaoke.js';
import { EditorView } from './ui/editor.js';

const engine = new AudioEngine();
let dirty = false;

const callbacks = {
  markDirty() {
    dirty = true;
  },
  markClean() {
    dirty = false;
  },
  async openTake(take, beat) {
    await editor.loadTake(take, beat);
    karaoke.discardTake();
    switchTab('editor');
    toast('Giọng đã chỉnh đang bật; giọng mộc đang tắt để bạn sửa từng nốt nếu muốn.', { ms: 5000 });
  },
  async exportTake(take, beat) {
    await editor.loadTake(take, beat);
    karaoke.discardTake();
    switchTab('editor');
    editor.showExport();
  },
};

const karaoke = new KaraokeView(engine, callbacks);
const editor = new EditorView(engine, callbacks);

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('karaokeView').hidden = name !== 'karaoke';
  $('editorView').hidden = name !== 'editor';
  karaoke.onViewChange(name === 'karaoke');
  if (name === 'editor') {
    // Hai màn dùng chung loa: tắt nghe mic và nhạc nền khi đang biên tập.
    if (engine.recording) karaoke.toggleRecord();
    engine.pauseBeat();
    karaoke.refreshTransport();
    if (engine.context) engine.setMonitor(false);
    editor.invalidate();
    editor.refreshUi();
  } else {
    editor.stop();
    if (engine.context) engine.setMonitor(karaoke.state.monitor);
    karaoke.drawOverview();
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

window.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing = target instanceof HTMLInputElement && target.type !== 'range';
  if (typing || target instanceof HTMLSelectElement) return;
  const onEditor = !$('editorView').hidden;
  const key = event.key.toLowerCase();

  if (event.code === 'Space') {
    event.preventDefault();
    if (onEditor) editor.togglePlay();
    else karaoke.togglePlay();
    return;
  }
  if (!onEditor) {
    if (key === 'r' && !event.ctrlKey) karaoke.toggleRecord();
    if (key === 'm' && !event.ctrlKey) karaoke.toggleMic();
    return;
  }
  if (event.ctrlKey) {
    const map = { x: 'cut', c: 'copy', v: 'paste' };
    if (map[key]) {
      event.preventDefault();
      editor.runOp(map[key]);
    } else if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
    } else if (key === 'y') {
      event.preventDefault();
      editor.redo();
    } else if (key === 'e') {
      event.preventDefault();
      editor.showExport();
    }
    return;
  }
  if (event.key === 'Delete') editor.runOp('silence');
  if (event.key === 'Home') editor.setCursor(0);
});

// Thả file vào màn hát để nạp nhạc nền.
const karaokeRoot = $('karaokeView');
karaokeRoot.addEventListener('dragover', (event) => event.preventDefault());
karaokeRoot.addEventListener('drop', async (event) => {
  event.preventDefault();
  const [file] = event.dataTransfer.files;
  if (file) await karaoke.loadBeat(file.name, await file.arrayBuffer());
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

window.addEventListener('beforeunload', (event) => {
  if (dirty || karaoke.take) {
    event.preventDefault();
    event.returnValue = '';
  }
});

karaoke.refreshDevices().catch(() => {});
karaoke.refreshMicUi();

// Dùng cho kiểm thử đầu-cuối.
window.__vokara = { engine, karaoke, editor, switchTab };
