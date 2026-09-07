'use strict';
/**
 * patch-market-catalog-fallback.cjs — 给“随包 dshmarket”打目录源回退补丁。
 *
 * 背景:dshmarket 的 `global` 区域原本只从官方目录源
 * https://awesome-dsh-plugin.com/plugins.json(GitHub Pages/Fastly)拉插件目录。
 * 该域名在中国大陆网络会不定时不可达(实测一次持续 10–15 分钟超时),期间整个
 * 市场“能打开但拉不到列表”。本补丁做两处小改动:
 *   1) `global` 的目录源改为:国内 npm 镜像的 dsh-plugin-catalog(腾讯云镜像)
 *      优先,官方源兜底 —— 官方挂掉时市场仍能正常浏览;
 *   2) `routesFor()` 在把 npm 目录源映射到区域 registry 时,保留源自带 registry,
 *      否则第 1 步写死的镜像会被区域(global→npmjs)重写掉,回退就失效了。
 *
 * 只影响目录(列表)读取,不改变插件的下载来源/区域语义。
 *
 * 用途:打包流程(scripts/prep-runtime.mjs 在固化 dshmarket 后调用)或手工执行
 * (`node scripts/patch-market-catalog-fallback.cjs`)。幂等:两处各自带标记,
 * 已包含时跳过。
 *
 * 目标文件:<repo>/runtime-src/node_modules/dshmarket/lib/regions.js
 * dshmarket 改版导致结构变化时本脚本会报错退出(不会静默打错),需同步更新
 * 对应 OLD 片段。
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const TARGET = path.join(REPO, 'runtime-src', 'node_modules', 'dshmarket', 'lib', 'regions.js');

// 1) global 目录源:镜像优先、官方兜底
const STEP1 = {
  label: 'catalog mirror fallback',
  marker: 'dsh-desktop-catalog-fallback',
  old: "        catalog: [{ kind: 'url', url: CATALOG_OFFICIAL }],",
  next:
    "        // dsh-desktop patch (dsh-desktop-catalog-fallback):\n" +
    "        // 官方目录源(awesome-dsh-plugin.com/GitHub Pages)在中国大陆网络会不定时\n" +
    "        // 不可达(曾连续 10–15 分钟超时,导致整个市场“不能联网”)。目录改为镜像\n" +
    "        // 优先、官方兜底(与 china 区域同一份 npm 目录包),官方源恢复与否都不影响浏览。\n" +
    '        catalog: [\n' +
    "            { kind: 'npm', registry: NPM_CHINA, pkg: CATALOG_PACKAGE },\n" +
    "            { kind: 'url', url: CATALOG_OFFICIAL },\n" +
    '        ],',
};
// 2) routesFor 映射时保留 npm 目录源自带的 registry(避免被区域 registry 覆盖)
const STEP2 = {
  label: 'keep explicit catalog registry',
  marker: 'dsh-desktop-catalog-registry-keep',
  old: "base.catalog.map(source => (source.kind === 'npm' ? { ...source, registry } : source)),",
  next: "base.catalog.map(source => (source.kind === 'npm' ? { ...source, registry: source.registry ?? registry } : source)),",
};

function applyStep(src, step) {
  if (src.includes(step.marker)) {
    console.log(`patch: [${step.label}] already applied (idempotent skip).`);
    return src;
  }
  if (src.includes(step.next)) {
    // 目标文本已存在(例如上游版本本身已带该写法)→ 无需再改
    console.log(`patch: [${step.label}] already satisfied (equivalent text present).`);
    return src;
  }
  const count = src.split(step.old).length - 1;
  if (count !== 1) {
    console.error(`patch: [${step.label}] expected block found ${count} times (want exactly 1) in ${TARGET}`);
    console.error('patch: dshmarket 可能已改版,请同步更新本脚本后重试。');
    process.exit(1);
  }
  console.log(`patch: [${step.label}] applying …`);
  return src.replace(step.old, step.next);
}

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error('patch: target not found: ' + TARGET);
    console.error('patch: 请先运行 npm run prep:runtime 再重试。');
    process.exit(1);
  }
  let src = fs.readFileSync(TARGET, 'utf8');
  src = applyStep(src, STEP1);
  src = applyStep(src, STEP2);
  fs.writeFileSync(TARGET, src);
  console.log('patch: done -> ' + TARGET);
}

main();
