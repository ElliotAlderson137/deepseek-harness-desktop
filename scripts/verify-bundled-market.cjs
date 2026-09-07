'use strict';
/**
 * verify-bundled-market.cjs — 端到端自检“随包内置市场（方案 C）”。
 *
 * 用法（有 Node）：
 *   npm run verify:bundled-market
 * 或（无 Node 的 Windows，用已装桌面应用的可执行文件充当 node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & '…\DeepSeek Harness Desktop.exe' scripts/verify-bundled-market.cjs
 *
 * 前提：<repo>/runtime-src/node_modules/dshmarket 存在（跑过
 *   npm run prep:runtime，或用 DSH_RUNTIME_SRC 指定 DSH 检出后重跑）。
 *
 * 行为：用“全新临时 DSH_HOME + 临时端口 + 含随包市场的 runtime”真实拉起一个
 *   dsh 服务，验证干净首启的完整时序（断言 A–I，见文末）：
 *   预启动登记 deferred → 首启无市场(404) → ~9s 离线登记+bundles → 热重启 →
 *   次启从随包副本挂载市场(capabilities 200)。全程不碰正式 .dsh 与正在运行的
 *   实例（不同 home/端口）。退出码 0=全部 PASS。
 *
 * 环境变量：
 *   DSH_VERIFY_RUNTIME  覆盖 runtime 目录（默认 <repo>/runtime-src）
 *   DSH_VERIFY_PORT     端口（默认 3101，需空闲）
 *   DSH_VERIFY_KEEP=1   保留临时 home 便于人工检查（默认自动删除）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const RUNTIME = process.env.DSH_VERIFY_RUNTIME || path.join(REPO, 'runtime-src');
process.env.DSH_DESKTOP_RUNTIME = RUNTIME; // manager 按此解析“随包市场”
const HOME_ROOT = path.join(os.tmpdir(), 'dshd-verify');
const HOME = path.join(HOME_ROOT, 'home-' + process.pid + '-' + Date.now());
const PORT = Number(process.env.DSH_VERIFY_PORT || 3101);
const BASE = 'http://127.0.0.1:' + PORT;

const manager = require(path.join(REPO, 'server', 'manager.cjs'));

const managerLogs = [];
const origLog = console.log;
console.log = (...a) => { managerLogs.push(a.join(' ')); origLog(...a); };
const log = origLog.bind(console);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpStatus(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual', cache: 'no-store' });
    clearTimeout(t);
    return res.status;
  } catch {
    return 0;
  }
}
function readBundles(home) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'));
    return (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || [];
  } catch {
    return null;
  }
}

(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  const bundledPj = path.join(RUNTIME, 'node_modules', 'dshmarket', 'package.json');
  if (!fs.existsSync(bundledPj)) {
    console.error('FAIL: ' + bundledPj + ' 不存在——请先跑 `npm run prep:runtime`');
    process.exit(2);
  }
  const bundledVer = JSON.parse(fs.readFileSync(bundledPj, 'utf8')).version;
  log('[verify] 随包市场版本:', bundledVer, '| home:', HOME);

  let onStagedFired = false;
  manager.setOnStaged(async () => {
    onStagedFired = true;
    log('[verify] onStaged 触发 → restartService…');
    const ok = await manager.restartService();
    log('[verify] restartService 结果:', ok);
  });

  const started = await manager.start({
    port: PORT,
    homeOverride: HOME,
    appVersion: 'verify',
    onStatus: () => {}
  });
  log('[verify] start ready:', JSON.stringify(started));

  // A/B：首启就绪即刻检查（期望未登记、市场未挂载）
  await sleep(1500);
  const bundlesAtReady = readBundles(HOME) || [];
  const capAtReady = await httpStatus(BASE + '/dsh-market/api/v1/capabilities');
  log('[verify] 首启就绪: bundles含dshmarket=', bundlesAtReady.includes('dshmarket'),
      ' capabilities status=', capAtReady);

  // C：等待离线登记 + 热重启
  const d1 = Date.now() + 45000;
  while (Date.now() < d1 && !onStagedFired) await sleep(500);
  log('[verify] 等 onStaged… fired=', onStagedFired);

  // D：重启后市场可达
  let capAfter = 0;
  let marketVer = null;
  const d2 = Date.now() + 90000;
  while (Date.now() < d2) {
    const s = await httpStatus(BASE + '/dsh-market/api/v1/capabilities');
    if (s === 200) {
      capAfter = s;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(BASE + '/dsh-market/api/v1/capabilities', { signal: ctrl.signal });
        clearTimeout(t);
        marketVer = (await res.json()).marketVersion;
      } catch {}
      break;
    }
    if (s === 401) { capAfter = 401; break; }
    await sleep(1500);
  }
  log('[verify] 重启后 capabilities status=', capAfter, 'marketVersion=', marketVer);
  const control = await httpStatus(BASE + '/__dsh_no_such_route__');
  log('[verify] 对照路由 status=', control);

  // E/F
  const pnpmLines = managerLogs.filter((l) => /staging plugin:|pnpm: using bundled|plugin dshmarket staged/i.test(l));
  const pnpmEntity = fs.existsSync(path.join(HOME, 'profiles', 'web', 'node_modules', 'dshmarket'));
  log('[verify] pnpm 相关日志条数=', pnpmLines.length, '| profile pnpm 实体=', pnpmEntity);
  if (pnpmLines.length) log('[verify] pnpm 日志样例:', pnpmLines.slice(0, 3).join(' | '));

  // 结果
  const V = [];
  const push = (name, pass, detail) => { V.push((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : '')); if (!pass) process.exitCode = 1; };
  push('A 首启 bundles 不含 dshmarket（干净首启）', !bundlesAtReady.includes('dshmarket'), 'bundles=' + JSON.stringify(bundlesAtReady));
  push('B 首启时市场未挂载（404/不可达）', capAtReady === 404 || capAtReady === 0, 'status=' + capAtReady);
  push('C 登记后热重启已触发', onStagedFired === true);
  push('D 重启后市场已挂载', capAfter === 200 || capAfter === 401, 'status=' + capAfter + ' marketVersion=' + marketVer);
  push('E 全程未走 pnpm', pnpmLines.length === 0, 'pnpmLines=' + pnpmLines.length);
  push('F profile 无 pnpm 安装实体', pnpmEntity === false);
  push('G 对照路由确实 404', control === 404, 'status=' + control);
  push('H 随包版本有效', /^\d+\.\d+\.\d+/.test(bundledVer), bundledVer);
  push('I bundles 最终含 dshmarket', (readBundles(HOME) || []).includes('dshmarket'), 'bundles=' + JSON.stringify(readBundles(HOME)));

  console.log('--- verdicts ---');
  for (const v of V) console.log(v);

  manager.stop();
  await sleep(1200);
  if (process.env.DSH_VERIFY_KEEP !== '1') {
    try { fs.rmSync(HOME_ROOT, { recursive: true, force: true }); } catch {}
  } else {
    log('[verify] 已保留临时 home 供人工检查:', HOME);
  }
  console.log(process.exitCode ? 'VERIFY FAILED' : 'VERIFY PASSED');
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('driver crash:', e && e.stack || String(e));
  try { manager.stop(); } catch {}
  process.exit(1);
});
