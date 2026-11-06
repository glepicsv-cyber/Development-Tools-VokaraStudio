// Tiến trình chính của Electron: cửa sổ, quyền mic, hộp thoại và đọc/ghi file.

const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, net, protocol, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC_ROOT = path.join(__dirname, 'src');
const APP_ORIGIN = 'app://vokara';

const WEB_PARTITION = 'persist:vokara-web';

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'webm'];

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Hát karaoke cần nhạc phát ngay khi bấm, không chờ cử chỉ thứ hai.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let webView = null;
let webPlaying = false;
let webBounds = null;
let webFullscreen = false;
let armedCapture = null;

function isWebUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const resolved = path.resolve(SRC_ROOT, relative);
    if (resolved !== SRC_ROOT && !resolved.startsWith(SRC_ROOT + path.sep)) {
      return new Response('Không được phép', { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

function configurePermissions() {
  const OWN_PERMISSIONS = ['media', 'speaker-selection', 'display-capture'];
  const isOurs = (origin) => typeof origin === 'string' && origin.startsWith(APP_ORIGIN);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = OWN_PERMISSIONS.includes(permission) && isOurs(details.requestingUrl || contents.getURL());
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => {
    return OWN_PERMISSIONS.includes(permission) && isOurs(origin);
  });
  session.defaultSession.setDevicePermissionHandler(() => false);

  // Chỉ cấp đúng nguồn mà giao diện vừa yêu cầu. Hình ảnh là bắt buộc với API này,
  // nên lấy chính cửa sổ của mình thay vì màn hình; giao diện tắt nó ngay.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const kind = armedCapture;
    armedCapture = null;
    const ours = request.frame && request.frame.url.startsWith(APP_ORIGIN);
    if (ours && kind === 'web' && webView) {
      const frame = webView.webContents.mainFrame;
      callback({ video: frame, audio: frame });
    } else if (ours && kind === 'system') {
      callback({ video: request.frame, audio: 'loopback' });
    } else {
      callback({});
    }
  });

  // Trang web mở trong ứng dụng dùng phiên riêng và không được cấp quyền nào.
  const web = session.fromPartition(WEB_PARTITION);
  // Chỉ cho toàn màn hình, để nút phóng to của video hoạt động. Mic, camera, vị trí đều bị chặn.
  web.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
  web.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');
  web.setDevicePermissionHandler(() => false);
  web.on('will-download', (event) => event.preventDefault());
  web.setUserAgent(app.userAgentFallback.replace(/\s(?:Electron|[\w-]*[Vv]okara[\w-]*)\/\S+/g, ''));
}

/** Khung web phủ kín cửa sổ khi xem toàn màn hình, nếu không thì nằm đúng chỗ giao diện yêu cầu. */
function applyWebBounds() {
  if (!webView || !mainWindow || mainWindow.isDestroyed()) return;
  if (webFullscreen) {
    const { width, height } = mainWindow.contentView.getBounds();
    webView.setBounds({ x: 0, y: 0, width, height });
  } else if (webBounds) {
    webView.setBounds(webBounds);
  }
}

function setWebFullscreen(on) {
  webFullscreen = on;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(on);
  applyWebBounds();
  // Windows còn đổi kích thước thêm một nhịp sau sự kiện cuối, mà không báo lại.
  for (const delay of [100, 400, 1000]) setTimeout(applyWebBounds, delay);
}

function sendWebState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = webView ? webView.webContents : null;
  mainWindow.webContents.send('web-state', {
    open: !!contents,
    url: contents ? contents.getURL() : '',
    title: contents ? contents.getTitle() : '',
    loading: contents ? contents.isLoading() : false,
    canGoBack: contents ? contents.navigationHistory.canGoBack() : false,
    canGoForward: contents ? contents.navigationHistory.canGoForward() : false,
    playing: contents ? webPlaying : false,
  });
}

function ensureWebView() {
  if (webView) return webView;
  webView = new WebContentsView({
    webPreferences: {
      partition: WEB_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  webView.setVisible(false);
  mainWindow.contentView.addChildView(webView);
  const contents = webView.webContents;
  // Trang muốn mở cửa sổ mới thì mở ngay trong khung này.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isWebUrl(url)) event.preventDefault();
  });
  contents.on('enter-html-full-screen', () => setWebFullscreen(true));
  contents.on('leave-html-full-screen', () => setWebFullscreen(false));
  // Esc thoát toàn màn hình ngay cả khi trang không tự xử lý phím này.
  contents.on('before-input-event', (event, input) => {
    if (webFullscreen && input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      contents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    }
  });
  contents.on('media-started-playing', () => {
    webPlaying = true;
    sendWebState();
  });
  contents.on('media-paused', () => {
    webPlaying = false;
    sendWebState();
  });
  for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    contents.on(name, sendWebState);
  }
  // Mã -3 là tải bị huỷ do chuyển trang, không cần báo.
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('web-error', { code, description, url });
  });
  return webView;
}

function closeWebView() {
  if (!webView) return;
  const view = webView;
  webView = null;
  webPlaying = false;
  webBounds = null;
  if (webFullscreen) setWebFullscreen(false);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(view);
    sendWebState();
  }
  view.webContents.close();
}

// Chạy trong thế giới cô lập để trang không can thiệp được vào lệnh này.
const mediaScript = (action) => `(() => {
  const all = [...document.querySelectorAll('video, audio')];
  const media = all.find((m) => !m.paused) || all.find((m) => m.currentSrc) || all[0];
  if (!media) return null;
  if (${JSON.stringify(action)} === 'pause' || !media.paused) media.pause();
  else media.play();
  return !media.paused;
})()`;

function registerWebIpc() {
  ipcMain.handle('web-open', (_event, url) => {
    const view = ensureWebView();
    if (url === null) return true;
    if (!isWebUrl(url)) return false;
    view.webContents.loadURL(url).catch(() => {}); // lỗi đã được báo qua did-fail-load
    return true;
  });
  ipcMain.handle('web-close', () => closeWebView());
  ipcMain.handle('web-bounds', (_event, rect) => {
    if (!webView || !rect) return;
    webBounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    applyWebBounds();
  });
  ipcMain.handle('web-visible', (_event, visible) => {
    if (webView) webView.setVisible(!!visible);
  });
  ipcMain.handle('web-command', (_event, command) => {
    if (!webView) return;
    const contents = webView.webContents;
    if (command === 'back') contents.navigationHistory.goBack();
    else if (command === 'forward') contents.navigationHistory.goForward();
    else if (command === 'reload') contents.reload();
  });
  ipcMain.handle('web-media', async (_event, action) => {
    if (!webView) return null;
    return webView.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: mediaScript(action) }]);
  });
  ipcMain.handle('capture-arm', (_event, kind) => {
    armedCapture = kind === 'web' || kind === 'system' ? kind : null;
  });
}

function registerIpc() {
  ipcMain.handle('open-audio', async (event, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: options.title || 'Mở file âm thanh',
      properties: ['openFile'],
      filters: [
        { name: 'Âm thanh', extensions: AUDIO_EXTENSIONS },
        { name: 'Mọi file', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    const data = await fs.readFile(filePath);
    let lyrics = null;
    // Lời bài hát cùng tên đặt cạnh file nhạc sẽ tự được nạp.
    try {
      const lrcPath = filePath.replace(/\.[^.\\/]+$/, '.lrc');
      lyrics = await fs.readFile(lrcPath, 'utf8');
    } catch {
      lyrics = null;
    }
    return { name: path.basename(filePath), data: new Uint8Array(data), lyrics };
  });

  ipcMain.handle('open-lyrics', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Mở file lời bài hát',
      properties: ['openFile'],
      filters: [{ name: 'Lời bài hát', extensions: ['lrc', 'txt'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return { name: path.basename(result.filePaths[0]), text: await fs.readFile(result.filePaths[0], 'utf8') };
  });

  ipcMain.handle('save-file', async (event, { defaultName, filterName, extension, data }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      title: 'Lưu file',
      defaultPath: defaultName,
      filters: [{ name: filterName, extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, Buffer.from(data));
    return { path: result.filePath };
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0f1115',
    title: 'Vokara Studio',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Hỏi lại trước khi đóng nếu còn bản thu hoặc chỉnh sửa chưa lưu.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Đóng và bỏ thay đổi', 'Ở lại'],
      defaultId: 1,
      cancelId: 1,
      title: 'Chưa lưu',
      message: 'Bạn còn bản thu hoặc chỉnh sửa chưa xuất ra file.',
      detail: 'Đóng ứng dụng lúc này sẽ mất các thay đổi đó.',
    });
    if (choice === 0) event.preventDefault();
  });

  // Không cho trang điều hướng ra ngoài ứng dụng.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow = win;
  // Đổi kích thước diễn ra sau lệnh toàn màn hình, nên phải đặt lại khung web theo.
  for (const name of ['enter-full-screen', 'leave-full-screen', 'resize', 'restore']) win.on(name, applyWebBounds);
  win.on('closed', () => {
    closeWebView();
    if (mainWindow === win) mainWindow = null;
  });

  win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

function bootstrap() {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  configurePermissions();
  registerIpc();
  registerWebIpc();
}

if (process.env.VOKARA_E2E) {
  module.exports = { bootstrap, createWindow };
} else {
  app.whenReady().then(() => {
    bootstrap();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
