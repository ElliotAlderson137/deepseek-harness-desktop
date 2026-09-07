'use strict';
/**
 * DeepSeek Harness Desktop — single-page edition.
 *
 * The window hosts ONE page: the local DSH console (identical to the browser
 * build at http://127.0.0.1:3080). Inside that console a desktop-only preload
 * (console-preload.js) augments the sidebar:
 *   - the wide “新会话” button is split into two: “新会话” + “deepseek_chat”;
 *   - deepseek_chat switches the right content area to the official DeepSeek
 *     web chat (chat.deepseek.com) rendered in a native WebContentsView with a
 *     persistent login partition — exactly like the free chat on the website;
 *   - a “背景” foot button switches the whole page background to a local image,
 *     a local video, or a remote URL, with a dim/glass control.
 *
 * Everything the browser version shows stays untouched: the console page is
 * served from the same profile (session / settings continuity).
 */
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  shell,
  dialog,
  Menu,
  Tray,
  nativeImage,
  screen
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const manager = require('./server/manager.cjs');

let win = null;
let chatOn = false;
let serverReady = false;
const views = { console: null, chat: null };

// Diagnostic/test override: isolate userData (single-instance lock, sessions,
// cookies) so several instances can run side by side.
if (process.env.DSH_DESKTOP_USERDATA) {
  app.setPath('userData', path.resolve(process.env.DSH_DESKTOP_USERDATA));
}

// ---------- argv / env overrides (for dev & automated smoke tests) ----------
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const PORT = Number(argValue('--dsh-port') || process.env.DSH_DESKTOP_PORT || 3080);
const HOME_OVERRIDE = argValue('--dsh-home') || process.env.DSH_DESKTOP_HOME || undefined;

// ---------- logging ----------
const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHDesktop', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'desktop.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // ~5MB 轮转,保留一份 .1

/** 打码 ?token=… / &token=…,auth URL 不能明文落日志。 */
function safeText(s) {
  return String(s).replace(/([?&]token=)[^&\s"'<>]+/gi, '$1***');
}

function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.rmSync(LOG_FILE + '.1', { force: true });
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch {}
}

function log(...a) {
  const line = safeText(new Date().toISOString() + '  ' + a.join(' '));
  try {
    console.log(line); // may throw EPIPE when no console is attached
  } catch {}
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}
// Write fatal errors straight to the log file, never through log() (no recursion risk).
function writeFatal(tag, e) {
  const line = new Date().toISOString() + '  ' + tag + ': ' + (e && e.stack ? e.stack : String(e)) + '\n';
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}
let lastFatalAt = 0;
process.on('uncaughtException', (e) => {
  const now = Date.now();
  if (now - lastFatalAt < 2000) return; // suppress floods (e.g. repeated EPIPE)
  lastFatalAt = now;
  writeFatal('uncaughtException', e);
});
process.on('unhandledRejection', (e) => {
  const now = Date.now();
  if (now - lastFatalAt < 2000) return;
  lastFatalAt = now;
  writeFatal('unhandledRejection', e);
});

// ---------- single instance ----------
const lockHeld = app.requestSingleInstanceLock();
if (!lockHeld) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// ---------- UI helpers ----------
function sendToShell(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sendToConsole(channel, payload) {
  const v = views.console;
  if (v && !v.webContents.isDestroyed()) v.webContents.send(channel, payload);
}

function consoleUrl() {
  // dsh web prints a token-bearing URL that mints the browser-auth cookie;
  // the console view must load that first (it 303-redirects to clean /)
  return manager.state.authUrl || manager.state.url;
}

// ---------- navigation allow-list & IPC sender checks (defense in depth) ----------
/** 控制台视图只允许本机 DSH 服务 (http://127.0.0.1 / localhost,任意端口)。 */
function isLocalConsoleUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost');
  } catch {
    return false;
  }
}
/** 聊天视图只允许 deepseek.com 域树(登录/SSO 跳转都在站内)。 */
function isDeepSeekSite(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (x.hostname === 'deepseek.com' || x.hostname.endsWith('.deepseek.com'));
  } catch {
    return false;
  }
}
/** IPC 消息必须来自本应用的两个远程视图或本地 splash 页,其余一律拒绝。 */
function trustedSender(event) {
  try {
    const frame = event.senderFrame;
    const u = (frame && frame.url) || (event.sender && event.sender.getURL());
    if (!u) return false;
    const x = new URL(u);
    if (x.protocol === 'file:') return true; // shell splash (本地文件)
    return isLocalConsoleUrl(u) || isDeepSeekSite(u);
  } catch {
    return false;
  }
}
/** 渲染进程崩溃后自动重载对应视图(30s 窗口内最多 3 次,防崩溃死循环)。 */
function onRendererGone(label, wc, loader) {
  let n = 0;
  let at = 0;
  return (_e, details) => {
    log(label, 'render-process-gone', details.reason);
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    if (now - at > 30000) n = 0;
    at = now;
    n += 1;
    if (n > 3) {
      log(label, 'renderer crashed repeatedly — giving up auto reload');
      return;
    }
    setTimeout(() => {
      try {
        if (wc && !wc.isDestroyed()) loader();
      } catch {}
    }, 1200);
  };
}

let relayoutT1 = null;
let relayoutT2 = null;
function layout() {
  if (!win || win.isDestroyed()) return;
  let w = 0;
  let h = 0;
  try {
    [w, h] = win.getContentSize();
  } catch {
    return;
  }
  if (w <= 0 || h <= 0) return;
  const consoleV = views.console;
  if (consoleV && consoleV.getVisible()) {
    try {
      consoleV.setBounds({ x: 0, y: 0, width: w, height: h });
    } catch {}
  }
  if (chatOn && views.chat) {
    try {
      views.chat.setBounds({ x: 0, y: 0, width: w, height: h });
    } catch {}
  }
}

/** Apply bounds now and re-apply a couple of times shortly after. Child views
 * added around the window's first show can fail to composite until their
 * bounds change (the area stays the dark background colour). */
function layoutSoon(extraMs = 450) {
  if (!win || win.isDestroyed()) return;
  layout();
  clearTimeout(relayoutT1);
  clearTimeout(relayoutT2);
  relayoutT1 = setTimeout(() => {
    relayoutT1 = null;
    layout();
  }, 120);
  relayoutT2 = setTimeout(() => {
    relayoutT2 = null;
    layout();
  }, 120 + extraMs);
}

// ---------- local shortcuts (no application menu) ----------
// Alt+1 toggles between the console and the chat page in BOTH directions.
function wireShortcuts(wc) {
  if (!wc || wc.__dshpShortcuts) return;
  wc.__dshpShortcuts = true;
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '').toLowerCase();
    if (input.alt && !input.control && !input.meta && k === '1') {
      event.preventDefault();
      toggleChat();
      return;
    }
    if (input.key === 'F12') {
      event.preventDefault();
      if (wc && !wc.isDestroyed()) wc.toggleDevTools();
    }
  });
}

// ---------- chat (DeepSeek 网页版) native view — full-window takeover ----------
function ensureChatView() {
  if (views.chat) return views.chat;
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:deepseek-chat', // login persists across restarts
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'chat-preload.js')
    }
  });
  win.contentView.addChildView(view);
  view.setVisible(false);
  const wc = view.webContents;
  // Dark backing behind the page: if the chat page ever leaves html/body
  // transparent (wallpaper mode, or a theme mismatch), the region behind must
  // not fall back to the default white — dark-theme text would become
  // unreadable on the right column.
  try {
    wc.setBackgroundColor('#10131a');
  } catch {}
  wireShortcuts(wc); // Alt+1 toggles chat ⇄ harness on this page too
  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  // 顶层导航白名单:聊天视图只允许 deepseek.com 域树;跳到第三方(SSO 出站/
  // 广告链)一律拦下并交给系统浏览器,防止 chat-preload 在陌生页面注入窗口控制。
  wc.on('will-navigate', (e, u) => {
    if (!isDeepSeekSite(u)) {
      e.preventDefault();
      if (/^https?:/i.test(u)) shell.openExternal(u);
    }
  });
  wc.on('render-process-gone', onRendererGone('[chat]', wc, () => {
    wc.loadURL('https://chat.deepseek.com/').catch((err) => log('[chat] reload after crash failed', String(err)));
  }));
  if (process.env.DSH_DESKTOP_VERBOSE) {
    wc.on('did-finish-load', () => log('[chat] loaded:', wc.getURL()));
    wc.on('did-fail-load', (_e, code, desc, url) => log('[chat] FAILED', code, desc, url));
  }
  wc.on('page-title-updated', (_e, title) => {
    if (chatOn && views.chat && views.chat.getVisible() && win && !win.isDestroyed()) {
      win.setTitle(title || 'DeepSeek 聊天');
    }
  });
  wc.loadURL('https://chat.deepseek.com/').catch((e) => log('chat loadURL failed', String(e)));
  views.chat = view;
  log('created chat view');
  return view;
}

function sendToChat(channel, payload) {
  const v = views.chat;
  if (v && !v.webContents.isDestroyed()) v.webContents.send(channel, payload);
}

// ---------- frameless window controls (min/max/close drawn by the pages) ----------
// 原生最大化被禁用（见 BrowserWindow 选项）：顶部拖拽只移动、不放大。
// “最大化”按钮走程序化 setBounds 填满工作区，图标/状态由 winMaxActive 驱动。
let winMaxActive = false;
let winNormalBounds = null;
function sendWinMaxState() {
  sendToConsole('dshp:win-max-state', { max: winMaxActive });
  sendToChat('dshp:win-max-state', { max: winMaxActive });
}
function setWindowMax(on) {
  try {
    if (!win || win.isDestroyed()) return;
    if (on) {
      if (!winMaxActive) winNormalBounds = winNormalBounds || win.getBounds();
      const wa = screen.getDisplayMatching(winNormalBounds || win.getBounds()).workArea;
      win.setBounds(wa);
      winMaxActive = true;
    } else {
      if (winNormalBounds) win.setBounds(winNormalBounds);
      winMaxActive = false;
    }
    layoutSoon();
    sendWinMaxState();
  } catch {}
}
ipcMain.on('dshp:win-min', (event) => {
  if (!trustedSender(event)) return;
  try {
    if (win && !win.isDestroyed()) win.minimize();
  } catch {}
});
ipcMain.on('dshp:win-max-toggle', (event) => {
  if (!trustedSender(event)) return;
  setWindowMax(!winMaxActive);
});
ipcMain.on('dshp:win-close', (event) => {
  if (!trustedSender(event)) return;
  // X = hide to tray (background keeps running); quit via tray menu / 退出
  try {
    if (win && !win.isDestroyed()) win.hide();
  } catch {}
});
ipcMain.on('dshp:win-max-query', (event) => {
  if (!trustedSender(event)) return;
  sendWinMaxState();
});
// Renderer-driven resize (bottom edge / bottom-right corner handles injected by
// the preloads). 拖拽跟随用“按下点基准的绝对位移”：边缘 = 起始边界 + 鼠标
// 相对按下点的位移，事件再快/再丢都不会与鼠标脱节（左上角固定，只改宽高，
// 也不会触发高分屏拖动漂移）。
let rsStart = null;
ipcMain.on('dshp:win-resize-start', (event) => {
  if (!trustedSender(event)) return;
  try {
    if (win && !win.isDestroyed()) rsStart = win.getBounds();
  } catch {}
});
ipcMain.on('dshp:win-resize', (event, d) => {
  if (!trustedSender(event)) return;
  try {
    if (!win || win.isDestroyed() || !rsStart) return;
    const dx = Math.round(d && d.dx ? d.dx : 0);
    const dy = Math.round(d && d.dy ? d.dy : 0);
    // 下限常量：不要用 win.getMinimumSize()（本机 DPI 下它会被放大成近似初始
    // 尺寸，导致“只能放大不能缩小”）。
    const MINW = 1000;
    const MINH = 680;
    const w = Math.max(MINW, rsStart.width + dx);
    const h = Math.max(MINH, rsStart.height + dy);
    if (w === rsStart.width && h === rsStart.height) return;
    win.setBounds({ x: rsStart.x, y: rsStart.y, width: w, height: h });
  } catch {}
});
ipcMain.on('dshp:win-resize-end', (event) => {
  if (!trustedSender(event)) return;
  rsStart = null;
});
// Whole-window dragging is done by the OS via -webkit-app-region:drag strips
// injected by the page preloads (console-preload.js / chat-preload.js):
//   - the OS moves the window in exact physical pixels, so there is none of the
//     DIP→physical rounding that made a JS-driven drag grow the window by a
//     pixel or two per move on fractional-DPI displays;
//   - with maximizable:false (see BrowserWindow options) Windows' snap-to-top
//     maximize never triggers while dragging, so dragging only ever MOVES the
//     window — no enlarging, no resizing.
// (A renderer-driven JS drag was tried before; besides the pixel-creep above it
// also fought the OS and could not prevent edge snapping.)

function setChat(on) {
  chatOn = !!on;
  const view = ensureChatView();
  if (chatOn) {
    if (!view.getVisible()) view.setVisible(true);
    view.webContents.focus();
  } else {
    if (view.getVisible()) view.setVisible(false);
    const cv = views.console;
    if (cv) cv.webContents.focus();
  }
  if (win && !win.isDestroyed()) {
    win.setTitle(chatOn ? 'DeepSeek 聊天 — DeepSeek Harness Desktop' : 'DeepSeek Harness Desktop');
  }
  sendToConsole('dshp:chat-state', { on: chatOn });
  log('chat mode:', chatOn ? 'on' : 'off');
  layoutSoon();
}

function toggleChat() {
  setChat(!chatOn);
}

// ---------- console view ----------
function createConsoleView() {
  if (views.console) return views.console;
  const url = consoleUrl();
  if (!url) return null;
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:dsh-desktop',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'console-preload.js')
    }
  });
  win.contentView.addChildView(view);
  const wc = view.webContents;
  wireShortcuts(wc); // Alt+1 toggles chat ⇄ harness
  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  // 顶层导航白名单:控制台视图只允许本机 DSH 服务;别的地址(被服务端拼错/
  // 劫持)一律拦下,最多交给系统浏览器,不让 console-preload 注入到陌生页。
  wc.on('will-navigate', (e, u) => {
    if (!isLocalConsoleUrl(u)) {
      e.preventDefault();
      if (/^https?:/i.test(u)) shell.openExternal(u);
    }
  });
  wc.on('render-process-gone', onRendererGone('[console]', wc, () => {
    const u = consoleUrl();
    if (u) wc.loadURL(u).catch((err) => log('[console] reload after crash failed', String(err)));
  }));
  wc.on('did-finish-load', () => {
    if (view.getVisible()) layoutSoon();
    if (process.env.DSH_DESKTOP_VERBOSE) log('[console] finished:', safeText(wc.getURL()));
    // 视图(首次加载或服务重启后重载)就绪时重新同步聊天状态,避免 chip/标题失步
    sendToConsole('dshp:chat-state', { on: chatOn });
  });
  wc.on('page-title-updated', (_e) => {
    // console SPA never changes title; keep our own chrome title
  });
  wc.loadURL(url).catch((e) => log('console loadURL failed', String(e)));
  views.console = view;
  log('created console view', safeText(url));
  return view;
}

// ---------- IPC ----------
ipcMain.on('dshp:chat-toggle', (event) => {
  if (!trustedSender(event)) return;
  toggleChat();
});
ipcMain.on('dshp:chat-off', (event) => {
  if (!trustedSender(event)) return;
  if (chatOn) setChat(false);
});
ipcMain.handle('dshp:open-external', (event, url) => {
  if (!trustedSender(event)) return { ok: false };
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle('get-state', (event) => {
  if (!trustedSender(event)) return null;
  return {
    ready: serverReady,
    url: manager.state.url,
    port: manager.state.port,
    adopted: manager.state.owned === false && serverReady,
    version: app.getVersion()
  };
});

// ---------- no application menu (per user request) ----------
function removeMenu() {
  Menu.setApplicationMenu(null);
}

// ---------- tray (close hides here; right-click has 退出) ----------
let tray = null;
function showMainWindow() {
  try {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch {}
}
function createTray() {
  try {
    if (tray) return tray;
    const ico = path.join(__dirname, 'build', 'icon.ico');
    let img = null;
    try {
      img = nativeImage.createFromPath(ico);
    } catch {}
    if (!img || img.isEmpty()) {
      // fall back to the window icon data if available
      img = null;
    }
    tray = new Tray(img || nativeImage.createEmpty());
    tray.setToolTip('DeepSeek Harness Desktop');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开主界面', click: showMainWindow },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() }
      ])
    );
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
    log('tray created');
    return tray;
  } catch (e) {
    log('tray create failed:', String(e));
    return null;
  }
}

// ---------- window ----------
function createWindow() {
  return new Promise((resolve) => {
    // 默认窗口比网页版略小（用户可随意拉大/缩小）；小屏幕自动再收小
    let winW = 1360;
    let winH = 840;
    try {
      const sd = screen.getPrimaryDisplay();
      if (sd && sd.workArea && sd.workArea.width > 800) {
        winW = Math.min(1360, Math.round(sd.workArea.width - 60));
        winH = Math.min(840, Math.round(sd.workArea.height - 40));
      }
    } catch {}
    win = new BrowserWindow({
      width: winW,
      height: winH,
      // 真实下限由 resize 处理里的常量保证（约 1000×680）；这里给极小值兜底，
      // 避免某些显示器 DPI 下 getMinimumSize 被放大成“初始尺寸”导致缩不动。
      minWidth: 320,
      minHeight: 240,
      show: false,
      frame: false, // frameless: pages draw their own min/max/close controls
      // 无边框窗口：移动走原生拖拽条/空白拖拽块；缩放走 preload 注入的
      // “下边沿 + 右下角”把手（IPC 绝对位移，边缘始终粘着鼠标）。
      //  - resizable:false：关掉系统那层又薄又不稳的隐形缩放进（在这个环境里
      //    只有最外 1px 有效、还会抢鼠标），缩放统一交给我们的把手；
      //  - maximizable:false + 原生 maximize 守卫：拖到屏幕顶只移动、不放大；
      //  - roundedCorners:true（Win11）：四角带一点圆角。
      resizable: false,
      maximizable: false,
      roundedCorners: true,
      backgroundColor: '#10131a',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.loadFile(path.join(__dirname, 'shell', 'index.html'));
    win.once('ready-to-show', () => {
      try {
        win.show();
      } catch {}
      layoutSoon();
      resolve();
    });
    // Keep the window's plain bounds up to date while it moves / is dragged.
    let lastPlain = null;
    win.on('move', () => {
      if (winMaxActive) return;
      try {
        lastPlain = win.getBounds();
      } catch {}
    });
    win.on('resize', () => {
      layoutSoon();
      if (!winMaxActive) {
        try {
          lastPlain = win.getBounds();
        } catch {}
      }
    });
    // Guard: a native maximize must never happen — Windows Snap can still force
    // one when the window is dragged to the very top of the screen even with
    // maximizable:false. Our own “最大化” button is programmatic (setBounds) and
    // never goes through here, so restoring is always the right reaction.
    let snapGuardT = null;
    win.on('maximize', () => {
      winMaxActive = false;
      try {
        clearTimeout(snapGuardT);
        const target = lastPlain || winNormalBounds || win.getBounds();
        log('native maximize (snap drag) intercepted -> restore ' + JSON.stringify(target));
        const restore = () => {
          try {
            if (win && !win.isDestroyed()) win.setBounds(target);
          } catch {}
        };
        restore();
        snapGuardT = setTimeout(restore, 90);
        layoutSoon();
        sendWinMaxState();
      } catch {}
    });
    win.on('unmaximize', () => {
      winMaxActive = false;
      layoutSoon();
      sendWinMaxState();
    });
    win.on('restore', () => {
      layoutSoon();
      sendWinMaxState();
    });
    win.on('show', () => layoutSoon());
    win.on('closed', () => {
      win = null;
      views.console = null;
      views.chat = null;
    });
    // X / Alt+F4 hides to tray; only the tray “退出” quits for real
    win.on('close', (e) => {
      if (!quitting && tray) {
        e.preventDefault();
        win.hide();
      }
    });
    win.webContents.on('render-process-gone', onRendererGone('[shell]', win.webContents, () => {
      win.webContents.reload();
    }));
    win.webContents.on('did-finish-load', () => layoutSoon());
  });
}

// ---------- server status -> shell ----------
function onServerStatus(s) {
  log('[status]', s.phase, s.message || '');
  sendToShell('server-status', s);
}

// ---------- boot ----------
async function boot() {
  if (!lockHeld) return;
  // Wait until the window is actually shown before anything else: child views
  // added while the window is still hidden can fail to composite on Windows.
  await createWindow();
  removeMenu();
  createTray();
  sendToShell('server-status', { phase: 'boot', message: '正在启动 DeepSeek Harness 服务…' });
  try {
    const res = await manager.start({
      port: PORT,
      homeOverride: HOME_OVERRIDE,
      appVersion: app.getVersion(),
      onStatus: onServerStatus
    });
    serverReady = true;
    // 首次启动若在同一会话里补装好了插件市场：热重启本地服务并刷新控制台，
    // 让“插件市场”无需用户重启即可出现（窗口不关、登录不丢）。
    if (!res.adopted && !process.env.DSH_DESKTOP_NO_RELAUNCH) {
      manager.setOnStaged(async () => {
        log('plugin market staged on first run — restarting local service to load it');
        try {
          const ok = await manager.restartService();
          log('service hot-restart result:', ok);
        } catch {}
        setTimeout(() => {
          try {
            const cv = views.console;
            const url = consoleUrl(); // 重启后 token 会变，必须载入新的 auth URL
            if (cv && !cv.webContents.isDestroyed() && url) cv.webContents.loadURL(url);
          } catch {}
          layoutSoon();
        }, 1500);
      });
    }
    // 子服务意外退出（含插件市场内“重启”触发的服务端自重启）后由 manager 自动
    // 拉回新服务：把控制台视图切到刷新后的 token URL，页面无缝重连。
    manager.setOnAutoRestarted(() => {
      log('auto-restarted service — reloading console with refreshed auth URL');
      setTimeout(() => {
        try {
          const cv = views.console;
          const url = consoleUrl();
          if (cv && !cv.webContents.isDestroyed() && url) cv.webContents.loadURL(url);
        } catch {}
        layoutSoon();
      }, 1200);
    });
    sendToShell('server-ready', { url: res.url, adopted: res.adopted });
    const view = createConsoleView();
    if (view) {
      view.setVisible(true);
      view.webContents.focus();
      layoutSoon(600);
    }
    log('boot complete —', res.adopted ? 'adopted existing server' : 'started own server', res.url);
    if (process.env.DSH_DESKTOP_SMOKE_CAPTURE) {
      const dir = process.env.DSH_DESKTOP_SMOKE_CAPTURE;
      setTimeout(async () => {
        try {
          const cv = views.console;
          if (cv) {
            const img = await cv.webContents.capturePage();
            fs.writeFileSync(path.join(dir, 'console.png'), img.toPNG());
          }
          if (views.chat && views.chat.getVisible()) {
            const img = await views.chat.webContents.capturePage();
            fs.writeFileSync(path.join(dir, 'chat.png'), img.toPNG());
          }
          if (win) {
            const img2 = await win.webContents.capturePage();
            fs.writeFileSync(path.join(dir, 'window.png'), img2.toPNG());
          }
          log('smoke capture saved to', dir);
        } catch (e) {
          log('smoke capture failed:', String(e));
        }
      }, 4000);
    }
    const smokeQuitMs = Number(process.env.DSH_DESKTOP_SMOKE_QUIT_MS || 0);
    if (smokeQuitMs > 0) {
      log('smoke mode: quitting in', smokeQuitMs, 'ms');
      setTimeout(() => app.quit(), smokeQuitMs);
    }
  } catch (e) {
    log('boot failed:', e && e.stack ? e.stack : String(e));
    onServerStatus({ phase: 'error', message: '启动失败：' + (e && e.message ? e.message : e) });
    dialog.showErrorBox('DeepSeek Harness Desktop 启动失败', String((e && e.message) || e) + '\n\n详细日志见: ' + LOG_DIR);
  }
}

// ---------- boot ----------

app.whenReady().then(() => {
  boot();
});

app.on('window-all-closed', () => {
  app.quit();
});

let quitting = false;
app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  manager.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
    createWindow().then(() => {
      removeMenu();
      if (serverReady) {
        const view = createConsoleView();
        if (view) view.setVisible(true);
        layoutSoon();
      }
    });
  }
});
