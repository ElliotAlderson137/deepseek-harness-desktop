// Copy the DeepSeek Harness runtime (the @deepseek-ai/dsh node_modules tree)
// into runtime-src/node_modules so electron-builder can ship it as
// resources/dsh-runtime. Source: $env:DSH_RUNTIME_SRC, else the most recent
// npm-cache _npx checkout that contains @deepseek-ai/dsh.
//
// Then vendor the plugin market (dshmarket) INTO that runtime tree as
// runtime-src/node_modules/dshmarket, so the packaged app boots with the
// market available OFFLINE on first launch (方案 C):
//  - the dsh loader resolves profile bundles from the install anchor first
//    (dsh-app-boot resolveBundleDir), so a package living next to
//    @deepseek-ai/dsh in node_modules is always found;
//  - version pinning: $env:DSH_MARKET_VERSION (exact, default = latest
//    dist-tag at build time), registry via $env:DSH_MARKET_REGISTRY (default
//    npmmirror). A local checkout may be used instead of downloading with
//    $env:DSH_MARKET_SRC_DIR (must contain package.json with dsh.bundle).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destRoot = path.join(root, 'runtime-src');
const destNm = path.join(destRoot, 'node_modules');
const marker = path.join(destRoot, '.src');
const binRel = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const MARKET = 'dshmarket';
const MARKET_DEST = path.join(destNm, MARKET);
const MARKET_PKG_JSON = path.join(MARKET_DEST, 'package.json');
const UA = 'dsh-desktop-build/1.0';

function log(...a) {
  console.log(...a);
}

function findSource() {
  if (process.env.DSH_RUNTIME_SRC) {
    const p = path.resolve(process.env.DSH_RUNTIME_SRC);
    if (fs.existsSync(path.join(p, binRel))) return p;
    throw new Error('DSH_RUNTIME_SRC does not contain ' + binRel + ': ' + p);
  }
  const cacheRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), 'npm-cache', '_npx');
  if (!fs.existsSync(cacheRoot)) return null;
  const candidates = fs
    .readdirSync(cacheRoot)
    .map((d) => path.join(cacheRoot, d))
    .filter((d) => fs.existsSync(path.join(d, binRel)))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
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
  if (!tar) {
    log('no system tar available; cannot extract', tgz);
    return false;
  }
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync(tar, ['-xzf', tgz, '-C', destDir], { windowsHide: true, timeout: 120000, stdio: 'ignore' });
  return !r.error && r.status === 0;
}

async function registryJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return await res.json();
}

async function latestMarketVersion() {
  const bases = [process.env.DSH_MARKET_REGISTRY, 'https://registry.npmmirror.com', 'https://registry.npmjs.org'].filter(Boolean);
  for (const base of bases) {
    try {
      const tags = await registryJson(base.replace(/\/+$/, '') + '/-/package/' + MARKET + '/dist-tags');
      const v = tags && typeof tags.latest === 'string' ? tags.latest : null;
      if (v && /^\d+\.\d+\.\d+/.test(v)) return v;
    } catch (e) {
      log('dist-tags fetch failed:', base, String(e && e.message || e));
    }
  }
  return null;
}

/** Vendor dshmarket into runtime-src/node_modules (offline afterwards). */
async function ensureMarketStaged() {
  if (fs.existsSync(MARKET_PKG_JSON)) {
    log('market already staged at', MARKET_DEST);
    return;
  }
  if (process.env.DSH_MARKET_SRC_DIR) {
    const srcPkg = path.join(path.resolve(process.env.DSH_MARKET_SRC_DIR), 'package.json');
    if (!fs.existsSync(srcPkg)) throw new Error('DSH_MARKET_SRC_DIR has no package.json: ' + srcPkg);
    fs.mkdirSync(path.dirname(MARKET_DEST), { recursive: true });
    fs.cpSync(path.resolve(process.env.DSH_MARKET_SRC_DIR), MARKET_DEST, { recursive: true });
    log('market staged from DSH_MARKET_SRC_DIR ->', MARKET_DEST);
    return;
  }
  let version = process.env.DSH_MARKET_VERSION;
  if (!version) {
    version = await latestMarketVersion();
    if (!version) throw new Error('could not resolve latest ' + MARKET + ' version from any registry');
  }
  const base = (process.env.DSH_MARKET_REGISTRY || 'https://registry.npmmirror.com').replace(/\/+$/, '');
  const url = base + '/' + MARKET + '/-/' + MARKET + '-' + version + '.tgz';
  log('downloading market', MARKET + '@' + version, 'from', url);
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const buf = Buffer.from(await res.arrayBuffer());

  const stage = path.join(destRoot, '.scratch-market-' + version);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const tgz = path.join(stage, 'market.tgz');
  fs.writeFileSync(tgz, buf);
  if (!extractTgz(tgz, stage)) throw new Error('failed to extract market tarball');
  const pkg = path.join(stage, 'package');
  if (!fs.existsSync(path.join(pkg, 'package.json'))) throw new Error('market tarball layout unexpected (no package/)');
  fs.mkdirSync(path.dirname(MARKET_DEST), { recursive: true });
  fs.cpSync(pkg, MARKET_DEST, { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  log('market staged:', MARKET + '@' + version, '->', MARKET_DEST);
}

async function main() {
  const src = findSource();
  if (!src) {
    console.error('No DSH runtime found. Set DSH_RUNTIME_SRC to a checkout containing ' + binRel);
    process.exit(1);
  }
  log('runtime source:', src);

  let skip = false;
  try {
    const prev = fs.readFileSync(marker, 'utf8');
    if (prev === src && fs.existsSync(path.join(destNm, '@deepseek-ai', 'dsh', 'package.json'))) skip = true;
  } catch {}

  if (!skip) {
    log('copying node_modules ->', destNm, '(this is a ~200MB one-time copy)');
    fs.rmSync(destRoot, { recursive: true, force: true });
    fs.mkdirSync(destRoot, { recursive: true });
    fs.cpSync(path.join(src, 'node_modules'), destNm, { recursive: true });
    fs.writeFileSync(marker, src);
    log('runtime staged.');
  } else {
    log('runtime already staged (unchanged source), skipping copy.');
  }

  // Vendoring the market is best-effort but loud: a failure only means the app
  // falls back to the legacy online `dsh plugin add` staging path at runtime.
  try {
    await ensureMarketStaged();
    // 桌面版补丁:给随包 dshmarket 的 global 目录源加“国内镜像优先、官方兜底”,
    // 官方目录源(awesome-dsh-plugin.com)不可达时市场仍能正常浏览。幂等。
    const patch = spawnSync(process.execPath, [path.join(root, 'scripts', 'patch-market-catalog-fallback.cjs')], {
      stdio: 'inherit'
    });
    if (patch.status !== 0) {
      console.error('WARNING: market catalog fallback patch did not apply — official-catalog outages may leave the market empty.');
    }
  } catch (e) {
    console.error('WARNING: failed to vendor ' + MARKET + ' into the runtime (' + String(e && e.message || e) + ');' +
      ' the packaged app will fall back to online plugin staging on first launch.');
  }
}

main();
