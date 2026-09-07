'use strict';
/**
 * DSH server lifecycle manager for the desktop shell.
 *
 * Responsibilities:
 *  - resolve the bundled DeepSeek Harness runtime (@deepseek-ai/dsh + plugins)
 *  - seed a DSH_HOME (default %USERPROFILE%\.dsh) with the `web` profile files
 *  - make $DSH_HOME/profiles/node_modules resolve to the runtime's node_modules
 *    (a single directory junction; on machines that already have a valid
 *    junction farm, e.g. installed via pnpm/npx, it is left untouched)
 *  - adopt an already-running DSH server on the port, otherwise spawn one using
 *    this Electron executable in ELECTRON_RUN_AS_NODE mode (no separate Node
 *    runtime needed), waiting until the port answers
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const httpsMod = require('node:https'); // httpGetBuffer() 的下载实现(httpGetBuffer 曾引用未定义标识符,升级/下载一直是死代码)
const net = require('node:net'); // start() 的 TCP 端口占用探测

const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHDesktop', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'desktop.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // ~5MB 轮转,保留一份 .1

/** 把 ?token=… / &token=… 打码后再落盘/打印,避免授权 URL 明文泄漏到日志。 */
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
    console.log(line);
  } catch {}
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const state = {
  port: 3080,
  home: null,
  runtimeDir: null,
  bootRuntimeRoot: null, // 实际启动所依赖的 runtime 根（便携版=稳定缓存；安装版=resources）
  appVersion: 'dev', // 稳定缓存 installed.json 的版本标记:start() 按 opts.appVersion 覆盖
  child: null,
  owned: false,
  ready: false,
  url: null,
  authUrl: null, // token-bearing console URL printed by dsh web (browser auth)
  stopped: false,
  onStatus: null,
  // “owned 子进程意外退出 → 自动重启”相关状态（见 handleChildExit / scheduleAutoRestart）
  intentionalStop: false, // restartService()/stop() 主动停止时为 true；退出回调据此不触发自动重启
  restartBusy: false,
  autoRestartCount: 0
};

/** Does this dsh server gate the index behind its printed ?token= URL? */
async function serverNeedsAuth(baseUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(baseUrl + '/?dsh-adopt-probe=1', {
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store'
    });
    clearTimeout(timer);
    return res.status === 401;
  } catch {
    return true;
  }
}

function status(phase, message) {
  if (state.onStatus) {
    try {
      state.onStatus({ phase, message });
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** TCP 端口占用探测:能区分“没监听 / 非 HTTP 监听 / HTTP 监听”。 */
function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
  });
}

/** 根路径确实返回 2xx(可接管的普通 Web 服务才算数,404/3xx/5xx 都不接管)。 */
async function rootIsOk(baseUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(baseUrl, { signal: controller.signal, redirect: 'manual', cache: 'no-store' });
    clearTimeout(timer);
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

async function probe(url, timeoutMs = 900) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual', cache: 'no-store' });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    return false;
  }
}

function binOf(runtimeDir) {
  return path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** Resolve where the bundled DSH runtime lives. */
function resolveRuntimeDir() {
  if (process.env.DSH_DESKTOP_RUNTIME) {
    const p = path.resolve(process.env.DSH_DESKTOP_RUNTIME);
    log('runtime via env DSH_DESKTOP_RUNTIME:', p);
    return p;
  }
  // packaged: <exe-dir>/resources/dsh-runtime
  const exeSide = path.join(path.dirname(process.execPath), 'resources', 'dsh-runtime');
  if (fs.existsSync(binOf(exeSide))) return exeSide;
  // fallback: process.resourcesPath/dsh-runtime
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'dsh-runtime');
    if (fs.existsSync(binOf(p))) return p;
  }
  return null;
}

function isUnderTemp(dir) {
  const t = path.resolve(os.tmpdir()).toLowerCase();
  return path.resolve(dir).toLowerCase().startsWith(t + path.sep) || path.resolve(dir).toLowerCase() === t;
}

/**
 * Portable exes extract themselves under %TEMP% on every run, so a junction
 * into the bundled resources would break between launches. When the runtime
 * lives under the temp dir, copy it once to a stable location.
 */
async function ensureStableRuntimeCopy(runtimeDir, appVersion) {
  if (!isUnderTemp(runtimeDir)) return runtimeDir;
  const destRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHDesktop', 'runtime');
  const dest = path.join(destRoot, 'node_modules');
  const markerFile = path.join(destRoot, 'installed.json');
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch {}
  const intact =
    marker && marker.appVersion === appVersion && fs.existsSync(binOf(destRoot));
  if (intact) {
    log('stable runtime cache hit:', destRoot);
    return destRoot;
  }
  log('copying bundled runtime to stable cache (one-time per version):', destRoot);
  status('boot', '首次运行：正在准备内置运行时到本地缓存（约 200MB，只需一次）…');
  fs.mkdirSync(destRoot, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  const srcNm = path.join(runtimeDir, 'node_modules');
  fs.cpSync(srcNm, dest, { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify({ appVersion, time: new Date().toISOString() }));
  return destRoot;
}

/** Adopt an already-running DSH server, or spawn one and wait for it. */
async function start(opts) {
  state.port = opts.port || 3080;
  state.onStatus = opts.onStatus || null;
  state.home = opts.homeOverride || path.join(os.homedir(), '.dsh');
  state.stopped = false;
  state.intentionalStop = false; // 新一轮启动清除上一轮遗留的“抑制自动重启”标记
  state.appVersion = opts.appVersion || 'dev'; // 稳定缓存版本标记;热重启沿用同值(见 restartService)

  state.runtimeDir = resolveRuntimeDir();
  if (!state.runtimeDir || !fs.existsSync(binOf(state.runtimeDir))) {
    status('error', '未找到 DeepSeek Harness 运行时。请重新安装应用。');
    throw new Error('DSH runtime not found (dsh-runtime). Reinstall the app.');
  }
  log('runtime dir:', state.runtimeDir);
  log('DSH_HOME    :', state.home);

  const url = 'http://127.0.0.1:' + state.port;
  const host = '127.0.0.1';
  // Modern dsh web enforces a browser cookie signed with a secret only it can
  // mint (it prints a ?token= URL), so an external auth-gated instance cannot
  // be adopted — the console view would get a 401. If adoption is impossible we
  // start our own server on the next free port instead (same DSH_HOME; running
  // multiple servers on one home is supported).
  //
  // 判定顺序:先 TCP 探测“端口到底有没有人监听”(区分非 HTTP/半死监听),
  // 再 HTTP 探测“是不是 DSH”:只有根路径 2xx 且非 401 的服务才接管——
  // 任意返回 404/3xx/5xx 的无关服务或纯 TCP 监听者一律不接管,自己去抢下一
  // 个空闲端口,避免把窗口指到无关内容或 spawn 撞 EADDRINUSE。
  const occupied = await portOpen(host, state.port);
  if (occupied) {
    const httpUp = await probe(url, 1500);
    const authGated = httpUp && (await serverNeedsAuth(url));
    if (httpUp && !authGated && (await rootIsOk(url))) {
      log('a DSH server is already answering on', url, '— adopting it (will NOT stop it on exit)');
      state.owned = false;
      state.ready = true;
      state.url = url;
      status('ready', '已连接运行中的服务');
      return { adopted: true, url };
    }
    let alt = state.port + 1;
    while (await portOpen(host, alt)) alt++;
    state.port = alt;
    log(
      'port', url,
      authGated
        ? 'serves an auth-gated DSH server — starting our own on port'
        : 'is held by another (non-DSH) service — starting our own on port',
      alt
    );
  }

  status('boot', '正在准备运行环境…');
  // Portable exes extract under %TEMP% each launch; run from a stable copy then.
  const stableRoot = await ensureStableRuntimeCopy(state.runtimeDir, state.appVersion);
  state.bootRuntimeRoot = stableRoot; // 随包市场以此目录为准（升级就地写这里）

  // Stage the market plugin BEFORE the web server starts: pnpm needs exclusive
  // access to the profile directory (a running server locks those files on
  // Windows). First launch creates the profile; from the second launch on the
  // plugin is added here and the server then boots with it loaded.
  await stageMarketPlugin(true);

  // dsh itself initializes a missing profile and maintains the per-package
  // symlink farm at $DSH_HOME/profiles/node_modules (healProfilesModuleFallback),
  // pointing into the runtime we boot from. All we do is run it.
  const bin = binOf(stableRoot);
  const args = ['--expose-internals', bin, 'web', '--no-open'];
  if (state.port !== 3080) args.push('--port', String(state.port));

  // Child env: scrub harness/session variables inherited from the parent shell
  // (e.g. DSH_SESSION_ID, DSH_SHELL, DSH_WEB_URL) so the spawned server boots a
  // fresh profile session instead of attaching to an unrelated one. We then set
  // DSH_HOME explicitly to the profile home.
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'DSH_HOME' || k.startsWith('DSH_')) continue; // drop all DSH_*
    childEnv[k] = v;
  }
  childEnv.DSH_HOME = state.home;
  childEnv.ELECTRON_RUN_AS_NODE = '1';
  Object.assign(childEnv, dirPickerEnv());
  const pnpmPath = pnpmPathPrefix();
  if (pnpmPath) childEnv.PATH = pnpmPath + path.delimiter + (childEnv.PATH || '');

  log('spawning DSH server (ELECTRON_RUN_AS_NODE):', process.execPath, args.join(' '));
  status('boot', '正在启动 DeepSeek Harness 服务…');

  const child = spawn(process.execPath, args, {
    env: childEnv,
    cwd: stableRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  state.child = child;
  state.owned = true;
  state.authUrl = null;

  // capture the token-bearing URL dsh web prints ("dsh web: http://…/?token=…")
  let outBuf = '';
  child.stdout.on('data', (d) => {
    outBuf += String(d);
    const lines = outBuf.split('\n');
    outBuf = lines.pop() || '';
    for (const line of lines) {
      log('[server] ', line.trimEnd());
      const m = /dsh web: (https?:\/\/\S+)/.exec(line);
      if (m && !state.authUrl) {
        const cand = m[1].trim();
        if (cand.includes('token=')) state.authUrl = cand;
        else if (!state.url) state.url = cand;
      }
    }
  });
  child.stderr.on('data', (d) => log('[server!]', String(d).trimEnd()));
  child.on('exit', (code, sig) => handleChildExit(code, sig));

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (state.stopped) throw new Error('stopped by user');
    if (child.exitCode !== null) throw new Error('DSH server exited during startup (code ' + child.exitCode + ') — see logs');
    if (await probe(url, 1000)) {
      state.ready = true;
      state.url = url;
      status('ready', '服务已就绪');
      log('DSH server is up at', url);
      // dsh prints the token URL slightly after it starts answering — give it
      // a moment so the console view can load the authenticated URL
      const authDeadline = Date.now() + 8000;
      while (!state.authUrl && Date.now() < authDeadline && state.child && state.child.exitCode === null) {
        await sleep(200);
      }
      if (state.authUrl) log('console auth URL captured');
      // 首次启动：profile 刚由本服务初始化好，同一会话内补装插件市场
      scheduleFirstRunPluginStage();
      return { adopted: false, url, authUrl: state.authUrl };
    }
    await sleep(500);
  }
  // 就绪超时:清理可能仍在启动/半挂的已 spawn 子进程,不留孤儿服务占端口
  const orphan = state.child;
  if (orphan && state.owned && orphan.exitCode === null) {
    state.intentionalStop = true; // 让 handleChildExit 视作主动停止,不触发自动重启
    log('startup timed out — terminating spawned DSH server (pid ' + orphan.pid + ')');
    try {
      orphan.kill();
    } catch {}
    try {
      const killer = spawn('taskkill', ['/pid', String(orphan.pid), '/t', '/f'], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {}
    state.child = null;
    state.owned = false;
    state.ready = false;
  }
  throw new Error('timed out waiting for DSH server at ' + url);
}

/** Stop the server only if this app spawned it. Adopted servers are left alone. */
function stop() {
  state.stopped = true;
  const child = state.child;
  if (child && state.owned && child.exitCode === null) {
    const pid = child.pid;
    log('stopping owned DSH server (pid ' + pid + ')…');
    try {
      child.kill();
    } catch {}
    try {
      // taskkill /T also terminates grandchildren (sandbox runners etc.)
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      });
      killer.on('error', (e) => log('taskkill spawn error:', String(e && e.message || e)));
      killer.unref();
    } catch (e) {
      log('taskkill failed:', e.message);
    }
  } else {
    log('no owned server to stop (adopted or already gone)');
  }
}

// ---------------------------------------------------------------------------
// Owned-server crash supervision
//
// dshmarket's in-page “restart” is a SERVER-SIDE self-restart: the dsh web
// process schedules a detached replacement and then SIGTERMs itself. Inside
// this Electron shell that is the wrong shape — the replacement would be an
// orphaned, unmanaged server and the window would be left staring at a dead
// connection. Instead of fighting the plugin, we absorb its behaviour: when
// our owned child goes away unexpectedly we bring a fresh one up ourselves on
// the same port (the market’s detached helper, if it ever wins the race,
// simply hits EADDRINUSE and dies) and tell the main process to reload the
// console against the refreshed ?token= URL.
// ---------------------------------------------------------------------------
const MAX_AUTO_RESTARTS = 5;
let onAutoRestarted = null;
function setOnAutoRestarted(fn) {
  onAutoRestarted = fn;
}

/** Single exit path for every owned/adopted child (start + restartService). */
function handleChildExit(code, sig) {
  log('DSH server exited', 'code=' + code, 'sig=' + sig);
  const owned = state.owned;
  const wasReady = state.ready;
  state.child = null;
  state.ready = false;
  if (state.stopped || state.intentionalStop) return; // 主动停止/重启，不自动拉起
  if (!owned) {
    status('error', 'DeepSeek Harness 服务已退出（code ' + code + '）。');
    return;
  }
  if (!wasReady) {
    // 尚未就绪就退出：是启动失败，弹提示但不进入无限自动重启
    status('error', 'DeepSeek Harness 服务启动失败（code ' + code + '）。请在帮助菜单查看日志。');
    return;
  }
  log('owned DSH server exited unexpectedly — scheduling auto-restart');
  scheduleAutoRestart();
}

/** 意外退出后按递增间隔自动重拉服务（上限 MAX_AUTO_RESTARTS 次防死循环）。 */
function scheduleAutoRestart() {
  if (state.stopped || state.restartBusy) return;
  if (state.autoRestartCount >= MAX_AUTO_RESTARTS) {
    status('error', 'DeepSeek Harness 服务连续退出 ' + MAX_AUTO_RESTARTS + ' 次，已停止自动重启。请查看日志后手动重启应用。');
    return;
  }
  state.autoRestartCount += 1;
  const delay = 500 + 700 * (state.autoRestartCount - 1); // 0.5s → 1.2s → 1.9s …
  state.restartBusy = true;
  setTimeout(async () => {
    state.restartBusy = false;
    if (state.stopped) return;
    status('restarting', '服务意外退出，正在自动重启…');
    let ok = false;
    try {
      // 子进程已退出（state.child === null），respawnOnly 跳过“杀旧进程”步骤
      ok = await restartService({ respawnOnly: true });
    } catch (e) {
      log('auto-restart error:', String(e && e.message || e));
    }
    if (state.stopped) return;
    if (ok) {
      state.autoRestartCount = 0;
      status('restarted', '服务已自动重启完成');
      if (onAutoRestarted) {
        try {
          onAutoRestarted();
        } catch {}
      }
      return;
    }
    scheduleAutoRestart(); // 未就绪 → 下一轮（次数到上限前）
  }, delay);
}

// ---------------------------------------------------------------------------
// Optional first-run plugin staging: `dsh plugin --profile web add dshmarket`.
// The desktop app pre-installs the market plugin for its own console profile so
// users don't have to run the CLI by hand. Slow / flaky network → retry through
// the npmmirror registry (国内镜像). Env overrides:
//   DSH_DESKTOP_PLUGIN_SKIP=1     disable entirely
//   DSH_DESKTOP_PLUGIN_REGISTRY=… first registry to use
//   DSH_DESKTOP_FORCE_PLUGIN=1    re-run even when already staged
// ---------------------------------------------------------------------------
const PLUGIN_PROFILE = 'web';
const PLUGIN_NAME = 'dshmarket';
const CHINA_REGISTRY = 'https://registry.npmmirror.com';

// dsh plugin add 会把插件放进 profiles/web/node_modules/<name>（或 @deepseek-ai/<name>）。
// 判定是否真的装好，而不是只看 .ok 标记：插件被删/迁移后标记会“说谎”，
// 导致商店消失却永远不再自动补装。
function marketInstalled(home) {
  const nm = path.join(home, 'profiles', PLUGIN_PROFILE, 'node_modules');
  return (
    fs.existsSync(path.join(nm, PLUGIN_NAME, 'package.json')) ||
    fs.existsSync(path.join(nm, '@deepseek-ai', PLUGIN_NAME, 'package.json'))
  );
}

// ---------------------------------------------------------------------------
// 随包内置 dshmarket（方案 C）
//
// 新安装包把市场随 dsh-runtime 一起带进
// <runtime>/node_modules/dshmarket（构建期由 scripts/prep-runtime.mjs 固化）。
// dsh 加载器解析 bundle 时“安装锚点优先”（dsh-app-boot resolveBundleDir），
// 所以随包副本天然生效，只需把它登记进 profile 的 dsh.profile.bundles——
// 全程离线、不跑 pnpm、也就没有 pnpm store 版本不匹配问题。
// “升级”因此改为：按节奏就地更新随包副本（%LOCALAPPDATA% 安装目录或便携版
// 稳定缓存都可写），更新后热重启让新版本被加载。旧安装/开发态没有随包副本
// 时，原 pnpm 补装路径保持不变。
// ---------------------------------------------------------------------------
/** 升级换名窗口(旧目录→bak、新目录→dir 两步之间)被杀/断电导致 dir 缺失时,
 *  把最新的 bak 原样恢复回去,避免 junction 悬空 → 下次启动 ERR_MODULE_NOT_FOUND。 */
function healMarketDir(dir) {
  try {
    const parent = path.dirname(dir);
    const prefix = path.basename(dir) + '.bak-';
    let best = null;
    let bestTime = 0;
    for (const name of fs.readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      const cand = path.join(parent, name);
      try {
        const t = fs.statSync(cand).mtimeMs;
        if (!best || t > bestTime) {
          best = cand;
          bestTime = t;
        }
      } catch {}
    }
    if (best) {
      fs.renameSync(best, dir); // 同卷 rename,恢复即“原子”
      log('market self-heal: restored interrupted upgrade from', best);
    }
  } catch {}
}
function marketBundledDir() {
  const root = state.bootRuntimeRoot || resolveRuntimeDir();
  if (!root) return null;
  const dir = path.join(root, 'node_modules', PLUGIN_NAME);
  try {
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      healMarketDir(dir); // 换名窗口被杀/断电 → 下一拍自愈
      return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
    }
    return dir;
  } catch {
    return null;
  }
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function profileManifest(home) {
  return readJson(path.join(home, 'profiles', PLUGIN_PROFILE, 'package.json'));
}
function profileHasMarket(home) {
  const m = profileManifest(home);
  const bundles = m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles) ? m.dsh.profile.bundles : null;
  return !!bundles && bundles.includes(PLUGIN_NAME);
}
/**
 * 让 dsh 加载器能从 profile 解析到“随包市场”：在共享回退农场
 * ($DSH_HOME/profiles/node_modules，基座 bundle 们正是从这解析的) 放一个
 * dshmarket 的 junction → <runtime>/node_modules/dshmarket。
 *
 * 为什么必须：profile 的 bundles 里列出 dshmarket 后，加载器会以 profile 目录为
 * baseUrl `import 'dshmarket'`（cordis include）。随包副本不在 profile 的
 * node_modules 里、也不属于安装闭包（dsh 故意不为“层本身”建 profile 链接），
 * 没有这个 link 服务启动就会 ERR_MODULE_NOT_FOUND 崩溃。
 * junction 幂等、跨卷可用、Windows 下无需管理员权限。
 */
function ensureMarketProfileLink(home) {
  if (!marketBundledDir()) return false;
  try {
    const shared = path.join(home, 'profiles', 'node_modules');
    fs.mkdirSync(shared, { recursive: true });
    const link = path.join(shared, PLUGIN_NAME);
    const target = marketBundledDir();
    let current = null;
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink() || st.isDirectory()) current = fs.realpathSync(link);
    } catch {}
    if (current) {
      try {
        if (current.toLowerCase() === fs.realpathSync(target).toLowerCase()) return true;
      } catch {}
      fs.rmSync(link, { recursive: true, force: true }); // 目标已变（应用升级/换 runtime）→ 重建
    }
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    log('market profile link:', link, '->', target);
    return true;
  } catch (e) {
    log('ensureMarketProfileLink failed:', String(e && e.message || e));
    return false;
  }
}
/** 把 dshmarket 追加进 profile manifest 的 bundles（与 dsh plugin 的 reconcile 同款写法）。
 *  @returns 'added' | 'present' | 'no-bundled-market' | 'unavailable' */
function ensureBundledMarketRegistration(home) {
  if (!marketBundledDir()) return 'no-bundled-market';
  const m = profileManifest(home);
  if (!m || !m.dsh || !m.dsh.profile) return 'unavailable'; // profile 还没初始化，稍后再试
  const bundles = Array.isArray(m.dsh.profile.bundles) ? m.dsh.profile.bundles : [];
  if (bundles.includes(PLUGIN_NAME)) return 'present';
  try {
    m.dsh.profile.bundles = [...bundles, PLUGIN_NAME];
    const file = path.join(home, 'profiles', PLUGIN_PROFILE, 'package.json');
    const tmp = file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
      fs.renameSync(tmp, file); // 原子替换:并发/中断不会丢更新或写坏 manifest
    } catch (e2) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      throw e2;
    }
    log('bundled market registered into profile bundles:', PLUGIN_NAME);
    return 'added';
  } catch (e) {
    log('bundled market registration failed:', String(e && e.message || e));
    return 'unavailable';
  }
}
const MARKET_DIST_TAGS_URLS = [
  process.env.DSH_DESKTOP_MARKET_REGISTRY && process.env.DSH_DESKTOP_MARKET_REGISTRY.replace(/\/+$/, '') + '/-/package/' + PLUGIN_NAME + '/dist-tags',
  'https://registry.npmmirror.com/-/package/' + PLUGIN_NAME + '/dist-tags',
  'https://registry.npmjs.org/-/package/' + PLUGIN_NAME + '/dist-tags'
].filter(Boolean);
function marketTarballUrl(registryBase, version) {
  return registryBase.replace(/\/+$/, '') + '/' + PLUGIN_NAME + '/-/' + PLUGIN_NAME + '-' + version + '.tgz';
}
async function latestMarketVersion() {
  for (const url of MARKET_DIST_TAGS_URLS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-desktop/1.0' }, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) continue;
      const tags = await res.json();
      const v = tags && typeof tags.latest === 'string' ? tags.latest : null;
      if (v && /^\d+\.\d+\.\d+/.test(v)) {
        // 从 dist-tags URL 还原 registry 基址:去掉尾部的 /-/package/<name>/dist-tags
        // (保留 scheme+host+路径前缀,私有 registry 带子路径时也能拼对 tgz URL)
        const base = String(url).replace(/\/-\/package\/.*$/, '');
        return { version: v, registry: base || url };
      }
    } catch (e) {
      log('latestMarketVersion failed:', url, String(e && e.message || e));
    }
  }
  return null;
}
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((s) => parseInt(s, 10) || 0).slice(0, 3);
  const pb = String(b).split(/[.-]/).map((s) => parseInt(s, 10) || 0).slice(0, 3);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}
function systemTarPath() {
  const cands = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : null,
    '/usr/bin/tar'
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}
function extractTgz(tgz, destDir) {
  const tar = systemTarPath();
  if (!tar) return false;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const r = spawnSync(tar, ['-xzf', tgz, '-C', destDir], { windowsHide: true, timeout: 120000, stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}
/**
 * 就地升级随包市场副本（安装目录或便携版稳定缓存都可写，见 resolveRuntimeDir /
 * ensureStableRuntimeCopy）。下载 → 解包到暂存 → 整目录原子替换。
 * @returns {{from: string, to: string}|null}
 */
async function upgradeBundledMarket() {
  const dir = marketBundledDir();
  if (!dir) return null;
  const current = (() => {
    const m = readJson(path.join(dir, 'package.json'));
    return m && typeof m.version === 'string' ? m.version : null;
  })();
  const latest = await latestMarketVersion();
  if (!latest) {
    log('market upgrade check: registry unreachable — keep bundled version');
    return null;
  }
  if (current && compareVersions(latest.version, current) <= 0) {
    log('market up-to-date:', current);
    return null;
  }
  const cacheRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHDesktop', 'market');
  try {
    fs.mkdirSync(cacheRoot, { recursive: true });
  } catch (e) {
    log('market upgrade cache mkdir failed:', String(e && e.message || e));
    return null;
  }
  // 清扫 24h 前的升级残留(stage-*),避免中断下载/解包在缓存里堆垃圾
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(cacheRoot)) {
      if (!name.startsWith('stage-')) continue;
      const p = path.join(cacheRoot, name);
      try {
        if (now - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
  const tgz = path.join(cacheRoot, PLUGIN_NAME + '-' + latest.version + '.tgz');
  if (!fs.existsSync(tgz)) {
    try {
      const url = marketTarballUrl(latest.registry, latest.version);
      log('downloading market', latest.version, 'from', url);
      await download(url, tgz);
    } catch (e) {
      log('market tarball download failed:', String(e && e.message || e));
      return null;
    }
  }
  const stage = path.join(cacheRoot, 'stage-' + latest.version + '-' + Date.now());
  if (!extractTgz(tgz, stage)) {
    log('market tarball extraction failed');
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    return null;
  }
  const pkg = path.join(stage, 'package');
  if (!fs.existsSync(path.join(pkg, 'package.json'))) {
    log('market tarball layout unexpected (no package/ dir)');
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    return null;
  }
  const swapped = path.join(cacheRoot, PLUGIN_NAME + '-' + latest.version);
  try {
    fs.rmSync(swapped, { recursive: true, force: true });
    fs.cpSync(pkg, swapped, { recursive: true });
    const backup = dir + '.bak-' + Date.now();
    fs.renameSync(dir, backup); // Windows 下目标目录整体换名才能“原子”替换
    try {
      fs.renameSync(swapped, dir);
    } catch (e) {
      fs.renameSync(backup, dir); // 回滚
      throw e;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
    log('market upgraded in place:', current || '?', '→', latest.version);
    return { from: current || '?', to: latest.version };
  } catch (e) {
    log('market in-place upgrade failed:', String(e && e.message || e));
    try { fs.rmSync(swapped, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    return null;
  }
}

function childEnvFor(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'DSH_HOME' || k.startsWith('DSH_')) continue; // drop all DSH_*
    env[k] = v;
  }
  env.DSH_HOME = state.home || path.join(os.homedir(), '.dsh');
  env.ELECTRON_RUN_AS_NODE = '1';
  Object.assign(env, extra || {});
  return env;
}

function runPluginCmd(registry, pnpmDir, extraArgs) {
  return new Promise((resolve) => {
    const bin = binOf(state.runtimeDir || resolveRuntimeDir());
    const extra = {};
    if (registry) extra.npm_config_registry = registry;
    const env = childEnvFor(extra);
    if (pnpmDir) env.PATH = pnpmDir + path.delimiter + (env.PATH || '');
    const argv = ['--expose-internals', bin, 'plugin', '--profile', PLUGIN_PROFILE, 'add', PLUGIN_NAME];
    for (const a of extraArgs || []) argv.push(a);
    const child = spawn(process.execPath, argv, {
      env,
      cwd: state.runtimeDir || resolveRuntimeDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 180000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.slice(-2000) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(e && e.message || e) });
    });
  });
}

const PNPM_BIN_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHDesktop', 'bin');
const PNPM_EXE = path.join(PNPM_BIN_DIR, 'pnpm.exe');

// 安装包内置的 pnpm：打包时经 electron-builder extraResources 放到
// <resources>/pnpm/pnpm.exe；开发模式用工程内 vendor/pnpm/pnpm.exe。
// 有内置就用内置（离线也能装/升级插件），没有才退回 PATH / 联网下载。
function bundledPnpmDir() {
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'pnpm'));
  cands.push(path.join(__dirname, '..', 'vendor', 'pnpm')); // dev
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'pnpm.exe'))) return c;
    } catch {}
  }
  return null;
}

function pnpmOnPath() {
  try {
    const r = require('node:child_process').spawnSync('pnpm', ['--version'], { shell: false, timeout: 8000 });
    return r.error ? false : r.status === 0;
  } catch {
    return false;
  }
}

// 把内置 pnpm 放到 pnpm 官方安装器的标准位置 %LOCALAPPDATA%\pnpm（pnpm.exe +
// pnpm.cmd）。插件市场里“自动配置 Pnpm 环境”只在这几个固定路径找 pnpm，
// 找不到才会去调 corepack/npm（内置 Node 没有 npm 所以必然失败）。
function standardPnpmDir() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'pnpm');
}
function ensureStandardPnpmDir() {
  const src = bundledPnpmDir();
  if (!src) return null;
  const dir = standardPnpmDir();
  const exe = path.join(dir, 'pnpm.exe');
  try {
    if (!fs.existsSync(exe)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(src, 'pnpm.exe'), exe);
    }
    const shim = path.join(dir, 'pnpm.cmd');
    if (!fs.existsSync(shim)) {
      fs.writeFileSync(shim, '@echo off\r\n"%~dp0pnpm.exe" %*\r\n');
    }
    log('standard pnpm available at', exe);
    return dir;
  } catch (e) {
    log('standard pnpm setup failed:', String(e && e.message || e));
    return src;
  }
}
// 服务器子进程 PATH 前缀：让 dsh/插件市场自己 spawn 的 pnpm 也能找到
function pnpmPathPrefix() {
  return ensureStandardPnpmDir() || bundledPnpmDir();
}

// 插件市场自动“补装 / 升级”节奏（尽力而为，全部容错，绝不阻塞启动）：
//  - 插件缺失：每次启动都会尝试（离线时失败后冷却一会儿再试，不空转）；
//  - 插件已在：距上次尝试 ≥ UPGRADE_EVERY 时才再尝试，联网即自动升级到最新。
// 时间戳放在每个 DSH 目录内，避免不同配置互相“冷却阻塞”。
const UPGRADE_EVERY_MS = 6 * 3600 * 1000; // 6 小时
const MISSING_RETRY_MS = 20 * 60 * 1000; // 缺失时失败后的冷却
function pluginAttemptStamp(home) {
  return path.join(home, '.dsh-desktop-plugin-' + PLUGIN_NAME + '-attempt.time');
}
function pluginAttemptRecent(home, graceMs) {
  try {
    return Date.now() - fs.statSync(pluginAttemptStamp(home)).mtimeMs < graceMs;
  } catch {
    return false;
  }
}
function touchPluginAttempt(home) {
  try {
    const now = new Date();
    fs.writeFileSync(pluginAttemptStamp(home), now.toISOString());
    fs.utimesSync(pluginAttemptStamp(home), now, now);
  } catch {}
}

// Electron main’s global fetch can be flaky for GitHub release downloads, so we
// use node:https with manual redirect following and a hard overall deadline.
function httpGetBuffer(url, hops = 0, deadline) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('too many redirects: ' + url));
    if (Date.now() > deadline) return reject(new Error('overall timeout ' + url));
    const req = httpsMod.get(url, { headers: { 'user-agent': 'dsh-desktop/1.0' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        resolve(httpGetBuffer(next, hops + 1, deadline));
        return;
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + status + ' for ' + url));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('hop timeout ' + url)));
  });
}

async function download(url, dest) {
  const deadline = Date.now() + 240000; // up to 4 minutes per source
  const buf = await httpGetBuffer(url, 0, deadline);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest + '.part', buf);
  fs.renameSync(dest + '.part', dest);
}

// 目录选择器后端策略（桌面端默认“browse”）：
// 官方 dsh 的原生目录选择器（koffi/Win32 worker）在部分 Windows 10/虚拟机环境会
// 崩溃（worker 拿到结果后读路径时 FATAL）。dsh-host-directory-picker-auto 的解析
// 逻辑中，只要服务进程环境里有 SSH_CONNECTION/SSH_TTY（非空），就强制使用
// browse（浏览器式目录选择器，不拉起那个 worker）。这里默认注入该变量来避开
// 崩溃；如需恢复原生选择器，可设 DSH_DESKTOP_DIRPICKER=native。
function dirPickerEnv() {
  if ((process.env.DSH_DESKTOP_DIRPICKER || 'browse') === 'native') return {};
  return { SSH_CONNECTION: 'dsh-desktop' };
}

// dsh 的 plugin 命令直接 spawn “pnpm”（无 shell），需要真实 pnpm。优先级：
// 安装包内置 pnpm（离线可用）→ 系统 PATH → 联网下载缓存一份（开发兜底）。
// 与安装包内置的 pnpm 版本一致；另有“按版本下载”的 ensurePnpmVersionExe 用于
// 匹配历史 .dsh（见 profilePackageManager），两者共用同一批国内镜像。
const PNPM_VERSION_DEFAULT = '10.4.1';
function pnpmMirrorUrls(version) {
  return [
    'https://gh-proxy.com/https://github.com/pnpm/pnpm/releases/download/v' + version + '/pnpm-win-x64.exe',
    'https://ghproxy.net/https://github.com/pnpm/pnpm/releases/download/v' + version + '/pnpm-win-x64.exe',
    'https://registry.npmmirror.com/-/binary/pnpm/v' + version + '/pnpm-win-x64.exe',
    'https://github.com/pnpm/pnpm/releases/download/v' + version + '/pnpm-win-x64.exe'
  ];
}
/** 按确切版本缓存的 pnpm 目录：%LOCALAPPDATA%\DSHDesktop\pnpm-cache\v<版本> */
function pnpmCacheDirFor(version) {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHDesktop', 'pnpm-cache', 'v' + version);
}
async function ensurePnpmVersionExe(version) {
  const dir = pnpmCacheDirFor(version);
  const exe = path.join(dir, 'pnpm.exe');
  if (fs.existsSync(exe)) {
    log('pnpm@' + version + ': cached copy at', dir);
    return dir;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log('ensurePnpmVersionExe mkdir failed:', String(e && e.message || e));
    return null;
  }
  for (const u of pnpmMirrorUrls(version)) {
    try {
      log('downloading pnpm@' + version + ' from', u);
      await download(u, exe);
      return dir;
    } catch (e) {
      log('pnpm download failed:', u, String(e && e.message || e));
    }
  }
  return null;
}
/**
 * web 配置档 node_modules 是由哪个 pnpm 装出来的（读 .modules.yaml 的
 * packageManager）。pnpm 10/11 的 store 目录不互通（…\store\v10 vs v11），
 * 用错主版本补装会永远 ERR_PNPM_UNEXPECTED_STORE——必须用建档同款 pnpm。
 */
function profilePackageManager(home) {
  try {
    const file = path.join(home, 'profiles', PLUGIN_PROFILE, 'node_modules', '.modules.yaml');
    const raw = fs.readFileSync(file, 'utf8');
    let value = null;
    try {
      value = JSON.parse(raw).packageManager;
    } catch {}
    if (!value || typeof value !== 'string') {
      const m = /packageManager\s*[:=]\s*["']?pnpm@([\d.]+(?:-[\w.]+)?)/.exec(raw);
      if (m) value = 'pnpm@' + m[1];
    }
    if (typeof value !== 'string' || !value.startsWith('pnpm@')) return null;
    const version = value.slice('pnpm@'.length);
    return /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}
async function ensurePnpmExe() {
  const bundled = bundledPnpmDir();
  if (bundled) {
    log('pnpm: using bundled copy at', bundled);
    return bundled;
  }
  if (pnpmOnPath()) return null; // system pnpm works
  try {
    if (fs.existsSync(PNPM_EXE)) return PNPM_BIN_DIR;
    return await ensurePnpmVersionExe(PNPM_VERSION_DEFAULT);
  } catch (e) {
    log('ensurePnpmExe error:', String(e && e.message || e));
  }
  return null;
}

async function stageMarketPlugin(preboot) {
  try {
    if (process.env.DSH_DESKTOP_PLUGIN_SKIP === '1') {
      log('plugin staging skipped (DSH_DESKTOP_PLUGIN_SKIP=1)');
      return;
    }
    const home = state.home || path.join(os.homedir(), '.dsh');
    // 随包内置市场（方案 C）：离线登记进 bundles；联网时按节奏就地升级随包副本
    if (marketBundledDir()) {
      const reg = ensureBundledMarketRegistration(home); // 幂等、离线、无 pnpm
      ensureMarketProfileLink(home); // 让加载器能从 profile 按包名 import 到随包市场
      if (reg === 'added') {
        log('bundled market added to profile bundles');
        touchPluginAttempt(home); // 刚登记即随包最新版，升级节奏从现在起算
      } else if (reg === 'unavailable') {
        log('bundled market registration deferred (profile not ready)');
      }
      if (preboot) return; // 服务未起：升级/热重启交给 post-boot 路径
      if (reg !== 'added' && !pluginAttemptRecent(home, UPGRADE_EVERY_MS)) {
        log('bundled market periodic upgrade check…');
        const upgraded = await upgradeBundledMarket();
        touchPluginAttempt(home);
        if (upgraded) {
          log('market upgraded', upgraded.from, '→', upgraded.to, '— restarting service to load it');
          let ok = false;
          try {
            ok = await restartService();
          } catch (e) {
            log('restart after market upgrade error:', String(e && e.message || e));
          }
          log('restart after market upgrade result:', ok);
          if (onAutoRestarted) {
            try {
              onAutoRestarted();
            } catch {}
          }
        }
      }
      return;
    }
    const marker = path.join(home, '.dsh-desktop-plugin-' + PLUGIN_NAME + '.ok');
    const installed = marketInstalled(home);
    const force = process.env.DSH_DESKTOP_FORCE_PLUGIN === '1';
    // 只认“真装了”，不认残留标记；并做补装/升级节奏控制（全部尽力而为，
    // 异常只记日志，绝不阻塞启动）：
    if (installed && !force) {
      if (pluginAttemptRecent(home, UPGRADE_EVERY_MS)) {
        log('plugin', PLUGIN_NAME, 'installed & recently checked — skip');
        return;
      }
      log('plugin', PLUGIN_NAME, 'installed; periodic upgrade check…');
    } else if (!installed && !force && pluginAttemptRecent(home, MISSING_RETRY_MS)) {
      log('plugin', PLUGIN_NAME, 'missing but recent attempt failed — cool down, retry later');
      return;
    }
    try {
      fs.rmSync(marker, { force: true });
    } catch {}
    if (!installed && !fs.existsSync(path.join(home, 'profiles', PLUGIN_PROFILE))) {
      log('plugin staging: profile not initialised yet — will stage right after first boot (same session)');
      return;
    }
    const pnpmDir = await ensurePnpmExe();
    if (!pnpmDir && !pnpmOnPath()) {
      log('plugin staging: pnpm unavailable (not on PATH and download failed) — will retry next launch');
      touchPluginAttempt(home);
      return;
    }
    // preboot staging happens before the server starts, so no wait is needed;
    // the post-boot path waits a little for the server to settle.
    if (!preboot) await sleep(4000);
    log('staging plugin:', PLUGIN_NAME, 'for profile', PLUGIN_PROFILE, pnpmDir ? '(using bundled pnpm)' : '(using PATH pnpm)');
    const registries = [process.env.DSH_DESKTOP_PLUGIN_REGISTRY || null];
    if (process.env.DSH_DESKTOP_PLUGIN_REGISTRY) registries.push(CHINA_REGISTRY);
    else registries.push(CHINA_REGISTRY, null); // official first, then China mirror
    // pnpm ≥ v10 refuses to add to the workspace root without --workspace-root
    const argVariants = [[], ['--workspace-root']];
    let ok = false;
    for (const reg of registries) {
      for (const extra of argVariants) {
        const r = await runPluginCmd(reg, pnpmDir, extra);
        if (r.code === 0) {
          ok = true;
          log('plugin', PLUGIN_NAME, 'staged OK' + (reg ? ' (registry ' + reg + ')' : '') + (extra.length ? ' (workspace-root)' : ''));
          break;
        }
        log('plugin staging attempt failed' + (reg ? ' (registry ' + reg + ')' : '') + (extra.length ? ' (workspace-root)' : '') + ' code=' + r.code, r.out.slice(0, 300).replace(/\s+/g, ' '));
      }
      if (ok) break;
    }
    if (ok) {
      try {
        fs.writeFileSync(marker, new Date().toISOString());
      } catch {}
      log('plugin', PLUGIN_NAME, 'present:', marketInstalled(home));
    } else {
      // 补装失败，且疑因 pnpm store 版本不匹配（这台机器的 .dsh 由另一 pnpm
      // 主版本建档，内置 pnpm 一碰就 ERR_PNPM_UNEXPECTED_STORE）：换用与
      // .modules.yaml 记录一致的 pnpm 版本再试一轮（npm/npmmirror 均有二进制）。
      const profileVersion = profilePackageManager(home);
      if (profileVersion && profileVersion !== PNPM_VERSION_DEFAULT) {
        log('plugin staging failed with bundled pnpm — profile built with pnpm@' + profileVersion + ', retrying with a matching pnpm');
        const dir = await ensurePnpmVersionExe(profileVersion);
        if (dir) {
          for (const reg of registries) {
            for (const extra of argVariants) {
              const r = await runPluginCmd(reg, dir, extra);
              if (r.code === 0) {
                ok = true;
                log('plugin', PLUGIN_NAME, 'staged OK with profile-matching pnpm@' + profileVersion + (reg ? ' (registry ' + reg + ')' : '') + (extra.length ? ' (workspace-root)' : ''));
                break;
              }
              log('plugin staging (profile pnpm) attempt failed' + (reg ? ' (registry ' + reg + ')' : '') + (extra.length ? ' (workspace-root)' : '') + ' code=' + r.code, r.out.slice(0, 300).replace(/\s+/g, ' '));
            }
            if (ok) break;
          }
          if (ok) {
            try {
              fs.writeFileSync(marker, new Date().toISOString());
            } catch {}
            log('plugin', PLUGIN_NAME, 'present:', marketInstalled(home));
          } else {
            log('plugin staging with profile-matching pnpm also failed — safe to ignore; auto retry later');
          }
        } else {
          log('could not fetch pnpm@' + profileVersion + ' for profile-matching retry — safe to ignore; auto retry later');
        }
      } else {
        log('plugin staging failed with all registries — safe to ignore; auto retry later');
      }
    }
    touchPluginAttempt(home);
  } catch (e) {
    log('plugin staging error:', String(e && e.message || e));
    try {
      touchPluginAttempt(state.home || path.join(os.homedir(), '.dsh'));
    } catch {}
  }
}

// 首次启动时 profile 由 dsh 服务初始化；服务就绪后在同一会话内补装插件市场。
// 装好后由宿主调用 restartService() 热重启一次本地服务，让插件被加载，
// 窗口本身不用重启。全程容错，失败也安全。
let onStaged = null;
function setOnStaged(fn) {
  onStaged = fn;
}
/** 市场“对本次启动可用”= 随包已登记进 bundles（或旧式 pnpm 已装进 profile）。 */
function marketNowAvailable(home) {
  return marketBundledDir() ? profileHasMarket(home) : marketInstalled(home);
}
function scheduleFirstRunPluginStage() {
  const home = state.home || path.join(os.homedir(), '.dsh');
  const missingAtStart = !marketNowAvailable(home);
  const attempts = [9000, 30000];
  let i = 0;
  const notify = () => {
    if (missingAtStart && marketNowAvailable(home) && onStaged) {
      const cb = onStaged;
      onStaged = null;
      try {
        cb();
      } catch {}
    }
  };
  const tryStage = async () => {
    if (state.stopped) return;
    if (marketBundledDir()) {
      // 随包：登记是本地操作；stageMarketPlugin(false) 顺带处理到期的就地升级
      try {
        await stageMarketPlugin(false);
      } catch {}
      if (marketNowAvailable(home)) {
        notify();
        return;
      }
      // profile 尚未就绪/登记失败 → 下一轮再试
      if (++i < attempts.length) setTimeout(tryStage, attempts[i]);
      return;
    }
    if (marketInstalled(home)) {
      notify();
      return;
    }
    if (pluginAttemptRecent(home, MISSING_RETRY_MS)) return;
    log('first-run plugin stage attempt', i + 1);
    try {
      await stageMarketPlugin(false);
    } catch {}
    notify();
    if (++i < attempts.length) setTimeout(tryStage, attempts[i]);
  };
  setTimeout(tryStage, attempts[0]);
}

// 热重启本地 DSH 服务（保留窗口/用户数据/登录），用于让新装插件被加载。
// 仅对“本应用自己拉起的服务”生效；成功返回 true。
// 所有重启用同一个串行队列:市场升级 / 崩溃监督自动重拉 / 首启补装 三者并发时
// 只有一个 spawn 在飞,不会出现双进程抢同一端口或“新市场没被加载”。
let restartChain = Promise.resolve();
function restartService(opts) {
  const run = restartChain.then(() => doRestartService(opts));
  restartChain = run.then(() => {}, () => {});
  return run;
}
async function doRestartService(opts) {
  const respawnOnly = !!(opts && opts.respawnOnly); // 子进程已不在（崩溃/被自重启），仅重新拉起
  try {
    if (!respawnOnly && (!state.child || state.owned === false)) {
      log('restartService: no owned child to restart');
      return false;
    }
    if (respawnOnly && state.owned === false) {
      log('restartService: adopted server — not ours to respawn');
      return false;
    }
    log('restarting DSH service to load newly installed plugins…');
    const url = 'http://127.0.0.1:' + state.port;
    // 1) stop old child (若还在)
    state.intentionalStop = true; // 旧子进程的退出回调不得触发“意外退出→自动重启”
    if (!respawnOnly && state.child) {
      const old = state.child;
      await new Promise((res) => {
        const done = () => res();
        if (old.exitCode !== null) return done();
        old.once('exit', done);
        try {
          old.kill();
        } catch {}
        setTimeout(() => {
          old.removeListener('exit', done);
          done();
        }, 4000);
      });
    }
    state.child = null;
    state.ready = false;
    state.authUrl = null;
    if (state.stopped) return false;

    // 2) spawn again（与 start() 相同的参数/环境）
    //    稳定缓存版本标记用启动时的真实版本(不能写死 'restart'——那会让每次
    //    热重启都全量重拷 ~200MB 并毒化缓存,导致之后每次启动再重拷一次)。
    const stableRoot = await ensureStableRuntimeCopy(state.runtimeDir, state.appVersion || 'dev');
    state.bootRuntimeRoot = stableRoot;
    const bin = binOf(stableRoot);
    const args = ['--expose-internals', bin, 'web', '--no-open'];
    if (state.port !== 3080) args.push('--port', String(state.port));
    const childEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'DSH_HOME' || k.startsWith('DSH_')) continue;
      childEnv[k] = v;
    }
    childEnv.DSH_HOME = state.home;
    childEnv.ELECTRON_RUN_AS_NODE = '1';
    Object.assign(childEnv, dirPickerEnv());
    const pnpmPathR = pnpmPathPrefix();
    if (pnpmPathR) childEnv.PATH = pnpmPathR + path.delimiter + (childEnv.PATH || '');
    const child = spawn(process.execPath, args, {
      env: childEnv,
      cwd: stableRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    state.child = child;
    state.owned = true;
    let outBuf = '';
    child.stdout.on('data', (d) => {
      outBuf += String(d);
      const lines = outBuf.split('\n');
      outBuf = lines.pop() || '';
      for (const line of lines) {
        log('[server] ', line.trimEnd());
        const m = /dsh web: (https?:\/\/\S+)/.exec(line);
        if (m && !state.authUrl) {
          const cand = m[1].trim();
          if (cand.includes('token=')) state.authUrl = cand;
          else if (!state.url) state.url = cand;
        }
      }
    });
    child.stderr.on('data', (d) => log('[server!]', String(d).trimEnd()));
    child.on('exit', (code, sig) => handleChildExit(code, sig));
    // 新子进程的退出回调已挂好，自此它的“意外退出”重新纳入自动重启管辖
    state.intentionalStop = false;

    // 3) wait ready
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !state.stopped) {
      if (child.exitCode !== null) break;
      if (await probe(url, 900)) {
        state.ready = true;
        state.url = url;
        log('DSH service restarted at', url);
        const authDeadline = Date.now() + 8000;
        while (!state.authUrl && Date.now() < authDeadline && state.child && state.child.exitCode === null) {
          await sleep(200);
        }
        return true;
      }
      await sleep(400);
    }
    log('restartService: not ready in time');
    return false;
  } catch (e) {
    log('restartService error:', String(e && e.message || e));
    return false;
  } finally {
    state.intentionalStop = false; // 任何提前中止路径都不许留下“抑制自动重启”的脏标记
  }
}

module.exports = { start, stop, state, probe, resolveRuntimeDir, marketInstalled, scheduleFirstRunPluginStage, stageMarketPlugin, setOnStaged, setOnAutoRestarted, restartService };
