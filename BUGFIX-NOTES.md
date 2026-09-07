# 背景 / 明暗主题问题修复说明

修复对象：`console-preload.js`（Harness 控制台注入）、`main.js`（背景镜像同步）。
本次问题全部在真实 Electron 桌面实例上复现验证（分别用随包 runtime 0.1.1-rc.2
与新版 0.1.2-rc.1 各跑一遍完整场景，见下方“验证”）。

---

## 问题现象 → 根因

### 1. 左下角点“设置”弹窗，整个背景丢失
复现：背景图开启时点“设置”，约 0.4s 后整个窗口回到纯色主题背景，设置窗口关闭后
还要 ~1–2s（甚至要点击会话）才恢复。

根因（console-preload.js 旧逻辑）：一旦检测到任何较大的 DSH 弹层（dialog/设置），
就**整体暂停**壁纸的半透明表面并恢复“原生纯色背景”，理由是担心旧版 DSH 弹层
自己没有背景色。但现在 DSH 的弹窗都自带背景：全屏蒙层（半透明遮罩或
backdrop blur）＋不透明面板（VOzbGW_mask/VOzbGW_panel）。暂停只让用户看到
“一弹设置背景就没了”，设置关闭后恢复又有 350ms 去抖 + 轮询延迟。

### 2. 背景/主题“不生效”，或要点左侧会话栏才生效
复现路径：设置弹窗开合、切换会话、切换明暗后，某些区域仍盖着不透明白条/旧色。

根因：
- 旧逻辑在“弹窗关闭 → 恢复”之间有明显空窗（去抖 350ms + 300ms 轮询），期间壁纸
  不可见，若用户此时点了会话，就误以为是“点了会话才生效”。
- band/date 等清扫只在状态切换时跑一次；React 重绘/新会话渲染出的**新**不透明
  容器、日期分组不会再次被清掉，壁纸局部被盖住，直到下一次整面切换。
- 日期分隔文字（今天/昨天…）只在第一次遇到时上色，主题翻转后残留旧主题颜色，
  直到 DOM 被整体替换（点会话）才刷新。

---

## 改动内容

### console-preload.js
1. **弹层不再停用壁纸（主修复）**
   新判定 `overlayPauseNeeded()`：
   - 全屏存在遮光层（半透明填充 alpha≥0.12，或 backdrop-filter 含
     blur/brightness/…）→ 弹窗自带背景 → 壁纸保持显示；
   - 不透明覆盖 ≥50% 视口 → 同上；
   - 透明全屏 “presentation” 包装层 / 包着其它弹层元素的容器 → 忽略；
   - 只有“真的没有任何自身背景的全屏接管页”才暂停壁纸（保持旧安全兜底）。
   350ms 去抖只用于“开始暂停”，一旦弹层消失下一拍立刻恢复，不再拖 1–2s。

2. **轮询稳态下持续自愈**
   稳态分支除补属性/作曲栏外，监测 DOM 变化（MutationObserver 置
   `S.mutAt`）与主题翻转（`S.darkFlipAt`），节流（≥1s）重跑
   band/date/composer 全套清扫 → 会话切换、React 重绘后新出现的遮盖条/日期组
   会被再次清掉，无需任何点击。

3. **日期分组随主题即时重着色**
   `dateSweep` 改为按主题 key 记录（`data-dshp-date`），明暗翻转后下一次清扫
   直接改回正确颜色；`restoreDateSweep` 同步清理属性。

4. applyThemeVars 记录明暗翻转时刻，翻转后 ~800ms 内强制整面重刷。

### main.js
- chat 视图每次 `dom-ready`（登录/重定向整页跳转后）以及从聊天切回可见时
  （setChat(true)）重新推送当前背景状态，避免镜像在隐藏/跳转期间丢失。

---

## 验证（CDP 真实驱动，两种 runtime 均通过）
- 开启背景 → 打开“设置”并停留：`data-dshp-bg-*` 全程保持（f/c/s/col=1），
  侧栏保持半透明 `rgba(主题,0.894)`，不再回退纯色。
- 设置内切换“模型/通用设置”子页：壁纸保持。
- 设置内切换深色/浅色：壁纸保持且色调 0.2–0.9s 内跟随新主题。
- 快速开合设置（<350ms）：无闪烁、无暂停。
- 点会话、新建会话：壁纸持续不丢。
- 关闭背景 → 原生纯色；再次开启 → 立即恢复。
- 聊天页（chat.deepseek.com 登录页实测）：镜像层/纱幕/壁纸正常，状态推送完好。

---

# 追加改动（第五轮）：缩小修好 + 缩放时边缘始终跟随鼠标
- **“只能放大不能缩小”根因**：resize 用 `win.getMinimumSize()` 做下限，而在这台
  125% 缩放机器上它被放大成近似“初始尺寸”（实测 1040/700 选项 → 1354×835），
  一拖向内就被夹住。→ 下限改为代码常量（约 1000×680），BrowserWindow 的
  minWidth/minHeight 只给极小兜底值；实测缩小 120×100 → 窗口精确缩小。
- **鼠标脱边框**：把手缩放由“增量”改为“按下点为基准的绝对位移”+ pointer capture，
  拖动全程窗口边缘与鼠标同步（每帧误差为 0）。
- 收敛：resizable:false（去掉不稳定的系统隐形缩放进），缩放统一走自绘把手
  （下边沿 8px + 右下角 20px）。

# 追加改动（第四轮）：小默认窗口 + 自由缩放 + 圆角 + 更舒适的拖动
- 默认窗口 1520×980 → **1360×840**（小屏自动收小）。
- 支持用户自定义缩放：`resizable:true` + 无边框自带边缘缩放；另注入
  **底部细条把手（上下拉高/压低）与右下角把手（同时改宽高）**，左上角固定
  （`dshp:win-resize` IPC 只改宽高，不会触发高分屏拖动漂移）。实测可用。
- 窗口四角圆角：去掉 `thickFrame:false` 的直角副作用，显式
  `roundedCorners:true`（Win11 生效）。
- 拖拽区再优化：全宽顶条 12px（贴边可用）+ 自动扫描顶部 58px 的
  **“空白缝隙拖拽块”**（#dshp-dragzone / #dshpc-dragzone，400ms 自适应重算，
  只铺在没有任何按钮/输入框的横向区段，绝不遮挡交互）→ 控制台中部有约
  736px 宽、聊天页主区有大段可拖区域，无需精准贴边。
- ⇄ 图标继续放大：热区 22→28px、笔画 15→17px。

# 追加改动（第三轮）：窗口拖动不再放大 + “切换”归位到收起按钮下方

问题全部在真实 Electron 桌面实例上复现（本机 125% 缩放 + 真实鼠标输入驱动，
见 .scratch/out* 与 real-drag/final-drag 脚本）。

## 0. 本轮补丁
- “切换”纯图标**加大**：图标 12→15px、热区 22→26px（仍塞在收起图标与下一行
  按钮之间，不遮挡任何原生按钮）。
- **删除**聊天页左上角“打开侧边栏”悬浮文字（遗留助手；原生收起图标已足够）。
- Windows 偶尔仍会对“拖到屏幕最上沿”强制原生最大化（Snap 不一定理会
  maximizable:false）→ main.js 增加守卫：拦截任何原生 `maximize` 并立即还原到
  拖动前位置。右上角“最大化”按钮不受影响（程序化 setBounds，不触发原生
  maximize）。打包版实测连拖 3 次到顶均不再最大化。

## 1. “按住窗口上部拖动，窗口却越来越大”（拖动变大/边拖边动）
- 旧方案是渲染进程 JS 拖动（pointer → IPC → `win.setPosition`）。在 125% 这类
  非整数 DPI 下，DIP→物理像素换算会漂移：每移动几步 Chromium/Windows 就
  “校正”一次窗口——宽/高每步 +1~2px，来回拖动会把窗口越拖越大（日志实证：
  每 dy=4 后紧跟一次 `WINDOW resize`，宽高 +1~2）。
- 修复：改回**系统原生拖拽**：
  - preload 注入顶部 14px `-webkit-app-region:drag` 细条（右端 140px 留给
    窗口按钮；高度取到所有原生按钮之上、不遮挡任何点击）；
  - `main.js` 的 BrowserWindow 设 `maximizable:false`——Windows 的
    “拖到屏幕顶部自动最大化/贴靠放大”被禁用，拖拽只会移动；
  - 保留 `resizable:false` + 新增 `thickFrame:false`（去掉边缘隐形缩放框）。
  - 实测（真实鼠标）：任意方向拖 120px → 尺寸全程不变、位置精准跟随；
    拖到屏幕顶按住再松手 → 停在 y=0，**不会变成全屏**，尺寸不变。
- 双击拖拽条不再最大化（原生最大化已被禁用，避免误触发放大）；
  右上角“最大化”按钮走程序化 setBounds 填充工作区，不受影响。

## 2. “切换”按钮位置：移到各界面“收起侧边栏”下方（纯图标、不遮挡按钮）
- Harness 控制台：`切换` 不再并排挤在“新会话”右侧，改为 22px 纯 ⇄ 小图标，
  紧贴侧栏顶部“收起侧边栏”按钮正下方的空隙（y≈53..73），与下面一行的
  “新会话”按钮(顶 y=74)不相交；侧栏收成 56px 窄条后自动贴到窄条右侧
  （窄条内图标列无空隙），仍然可见。
- chat.deepseek.com：聊天页会话栏顶部的“收起侧边栏”图标（右数第一枚）正下方
  放置同款小图标；侧栏收起时移到左上角展开图标下方。展开/收起来回切换，
  图标都自动跟随。

## 3. 聊天页“切换”的颜色/样式与 Harness 控制台一致
- 旧逻辑把聊天页原生“新对话/新会话”按钮的**文字颜色**复制到“切换”上，
  导致文字/图标变成站点的紫红色（实测 rgb(128,0,128)），看着“有色”。
- 现在两侧“切换”都不再复制原生按钮配色：透明无背景、纯中性主题色
  （控制台随 DSH 主题 #e8edf6/#0f1115；聊天页自行检测明暗取 #e6eaf3/#24282f），
  外观一致。

## 验证
- 真实鼠标（user32 SendInput）：两页 下拖/上拖/顶到屏幕上沿 后尺寸恒定
  1520×980、zoomed=false；控制台侧栏 收起↔展开 与聊天页侧栏 收起↔展开 后
  小图标位置均正确、与全部原生按钮 0 重叠。
- 新打包产物：dist/win-unpacked（`npm run dist:dir`）。

---

# 追加改动（第二轮）

## 1. 左下角“背景”升级为“主题”面板（console-preload.js）
- 按钮文案：背景 → **主题**（aria：页面主题）。
- 面板结构参考 ChatGPT / Telegram 常见外观设置：
  - **界面主题**：跟随系统 / 浅色 / 深色 —— 点击会驱动 DSH 原生设置写入
    （持久化），并即时改变界面；
  - **强调色**：6 种色板（默认蓝/青绿/橙/玫红/紫/琥珀），持久化并作用于注入 UI；
  - **背景图**：无背景 / 选择图片 / 粘贴 URL；
  - **界面透明度** 滑杆（默认 30；越大背景图越透，弹窗文字偏淡时可调小）。
- 设置弹窗期间背景保持显示；弹窗文字在 DSH 自带面板上始终不透明。

## 2. 余额面板（console-preload.js + main.js）
- 新增「今日消费」行：尽力请求官方 usage 接口（无公开接口时显示 `--`）。
- 新增高峰/非高峰提示条：按北京时间 00:00–09:00 判定非高峰并绿色显示，
  09:00–24:00 高峰橙色显示（仅提示，不涉及费率）。

## 3. 聊天页黑底修复（chat-preload.js）
- 根因：chat.deepseek.com 在底部停靠输入栏时，屏幕最底部有整宽深色
  scroll-fade/渐隐遮罩（容器文字多，原清扫规则漏掉）；输入变多/增高时
  显黑条。新增持久化 `bottomFadeSweep` + 输入/按键/滚动直接触发，清除
  渐隐层，壁纸持续可见。
- 右侧顶部标题栏（`.the-header` 等）背景改为透明（注入 CSS 规则，随
  React 重建仍生效），与左侧「昨天/7 天内」日期组风格一致。

## 4. 整窗拖动（console-preload.js + chat-preload.js）
- 顶部新增可拖拽区：控制台顶部 28px、聊天页顶部 44px（双击最大化）。
- 聊天页标题栏本体 `app-region: drag`，栏内按钮 `no-drag` —— 按住标题栏
  空白处即可拖动整窗，按钮仍可点击。

---

证据（可复跑）：
`.scratch/driver.mjs` + `.scratch/scenarios/*`（10/12/14/17/18 为主验证场景），
结果 JSON 见 `.scratch/out*.json`。

---

# 追加改动（第三轮：插件市场可见性 + 市场内“重启”可靠性）

## 1. 插件市场“设置里不出现”的根因与自愈（server/manager.cjs）

现象：安装版在部分机器上设置里没有插件市场；本机复现，`%LOCALAPPDATA%\
DSHDesktop\logs\desktop.log` 每次启动都报
`ERR_PNPM_UNEXPECTED_STORE`：`profiles/web/node_modules` 由 **pnpm 11.24.0**
（store v11，`.modules.yaml` 记录 `packageManager`）建档，而安装包内置
**pnpm 10.4.1**（store v10）。pnpm 出于安全拒绝用 v10 修改 v11 建的目录，
`dshmarket` 补装永远失败（20 分钟冷却重试也不会自愈）。

改动：补装失败时读取 `profiles/web/node_modules/.modules.yaml` 的
`packageManager`，若与内置 pnpm 主版本不同，则按版本（复用同一批
gh-proxy/npmmirror 镜像）下载匹配的 pnpm 到
`%LOCALAPPDATA%\DSHDesktop\pnpm-cache\v<版本>` 并重试一轮；成功才写 `.ok`
标记。装机时 `npm_config_registry`/国内镜像逻辑保持不变，全部仍“尽力而为、
失败只记日志”。

## 2. 插件市场里点“重启”程序不重启（server/manager.cjs + main.js）

现象：装完需重启的插件后，在市场界面点“重启”→ 页面断开连接，程序没有按
预期重启。

根因：dshmarket 的“重启”是**服务端进程自重启**（`restart.js` 的
`scheduleRestart`：按当前进程 argv 拉起一个 detached 替身，500ms 后
SIGTERM 自己）。这对终端里跑的 `dsh web` 成立，但本壳把 dsh 服务当作
Electron 主进程托管的子进程：子进程一死，主窗口对着死连接，Electron 侧
（只有首装市场时的 `restartService` 一条路径）不会重新拉起，替身则变成
无人托管的孤儿进程——即“断开连接却无重启”。

改动（吸收而非对抗）：
- manager 增加**自管子进程意外退出监督**：owned 且曾就绪的子进程意外退出
  → 按 0.5s→1.2s→1.9s…（上限 5 次防死循环）自动 `restartService`，全程
  状态上报；`restartService()` 支持 `{ respawnOnly: true }`（子进程已不在时
  跳过“杀旧进程”）。市场 detached 替身若抢跑，只会 EADDRINUSE 退出，无害。
- `restartService`/`stop` 用 `state.intentionalStop` 区分“主动重启/退出”，
  退出回调据此不误触发自动重启。
- main.js 注册 `setOnAutoRestarted`：服务被自动拉回后，把控制台视图
  **loadURL 到刷新后的 `?token=` 地址**（token 每次启动都变，原 `reload()`
  会带着旧 token/旧 cookie 打 401）——首装市场后的热重启路径同步修正。

说明：市场 UI 的 capability 显示 `managedBy: 'market'`、`restart: true` 属
正常——本方案让该自重启“落进”外壳的受管重启。若后续想让市场显示
`managedBy: 'desktop-host'` 并彻底禁用其自重启，需按 dshmarket 约定的
desktop 契约（`desktopProfiles`/`desktopPnpm` 注入，见
`lib/index.js` Desktop 分支与其引用的 plugin-services 文档）提供宿主服务，
属较大改动，另行立项。

---

# 追加改动（第四轮：市场随包内置，方案 C）

目标：市场不再依赖“首启联网补装”，**第一步启动直接出现在设置里**；
联网时再“有更新自行更新”。

机制依据（dsh-app-boot 源码）：profile 的 `dsh.profile.bundles` 里的每个
包，启动时经 `resolveBundleDir` 解析——**安装锚点（随包 dsh 的 node_modules）
优先于 profile 目录**。因此把市场包放进随包 runtime 的 node_modules 即天然
生效，只需把它登记进 bundles；但也因此**升级必须就地更新随包副本**（写
profile 副本会被随包副本“影子化”，升了不生效）。

改动：
- `scripts/prep-runtime.mjs`：构建期把 dshmarket 固化进
  `runtime-src/node_modules/dshmarket`（随 dsh-runtime 一起打进安装包）。
  版本默认取构建时 latest dist-tag，可用 `DSH_MARKET_VERSION` 锁定、
  `DSH_MARKET_REGISTRY` 换源、`DSH_MARKET_SRC_DIR` 直接用本地目录；
  固化失败只告警（app 回退到旧式联网补装路径）。
- `server/manager.cjs`：
  - `marketBundledDir()/ensureBundledMarketRegistration()`：检测到随包市场后，
    幂等把它追加进 `profiles/web/package.json` 的 `dsh.profile.bundles`
    （离线、不跑 pnpm——pnpm store 版本不匹配问题在随包路径下不再存在）；
  - `upgradeBundledMarket()`：约每 6 小时（沿用 attempt 时间戳节奏）查
    registry dist-tags，有新版本就下载 tgz、解包、**整目录原子替换随包副本**
    （便携版写稳定缓存 `%LOCALAPPDATA%\DSHDesktop\runtime`，安装版写安装
    目录——均用户可写），成功则热重启服务并重载控制台；
  - `state.bootRuntimeRoot`：标记真正启动用的 runtime 根（便携版=稳定缓存），
    随包市场以它为准；
  - `ensureMarketProfileLink()`：在共享回退农场 `$DSH_HOME/profiles/node_modules`
    为 dshmarket 建 junction → 随包 runtime 副本。**必须**：cordis include 会以
    profile 为 baseUrl `import 'dshmarket'`，随包副本不在 profile 依赖里、dsh
    也不为“层本身”建 profile 链接，缺它服务启动即 ERR_MODULE_NOT_FOUND 崩溃
    （端到端首轮验证发现；基座 bundle 正是经该农场解析的）；
  - `stop()` 的 taskkill spawn 补 error 监听，避免任务管理器缺失环境下抛未捕获
    异常（验证驱动/受限 PATH 下复现）；
  - 旧安装/开发态（runtime 里无随包市场）保持原 pnpm 补装路径（含第三轮
    的“pnpm 版本自动匹配”自愈）。

### 端到端验证（全新 home + 临时端口 3101 + 固化 dshmarket 的临时 runtime）
预启动：profile 未初始化 → 登记 deferred、仅建农场 junction；首启服务就绪时
bundles 不含 dshmarket、`/dsh-market/*` 404；约 9s 后 schedule 离线登记
（`added`）→ onStaged → restartService 热重启；次启服务从随包副本挂载市场，
`GET /dsh-market/api/v1/capabilities` → 200、`marketVersion: 1.44.0`。
断言 9/9 PASS：A 干净首启（首启无市场）B 首启 404 C 热重启触发 D 重启后 200
E 全程无 pnpm（日志 0 条）F profile 无 pnpm 安装实体 G 对照路由 404
H 随包版本有效 I bundles 最终含 dshmarket。另：验证中人为制造的服务崩溃被
“意外退出自动重启”链按设计自动重拉（第三轮功能真实生效）。

---

# 追加改动（第六轮 · 2026-09-07 加固 / hardening pass）

> 在“随包内置插件市场”版之上的可靠性/安全加固（本仓库重新定版为 v1.0.0）,均为
> 行为等价或更稳的改动;已在 Node 层做语法校验(--check),发版前请在真实打包实例上
> 回归（见文末“待回归项”）。

## server/manager.cjs
1. **修复死代码**:`httpGetBuffer()` 引用了从未定义的 `httpsMod`(文件只 require 了
   child_process/fs/os/path,main.js 也未注入)→ 市场 tgz 与 pnpm 的联网下载每次必
   抛 ReferenceError 并被 catch 吞掉,“每 ~6h 自动升级内置市场”实际从未生效。已在
   顶部补 `const httpsMod = require('node:https')`。
2. **升级换名窗口自愈**:升级的“旧目录→bak、新目录→dir”两段 rename 之间若被杀/
   断电,会留下 bak 而 dir 永久缺失(junction 悬空 → 下次启动 ERR_MODULE_NOT_FOUND)。
   现在 `marketBundledDir()` 发现 dir 缺失时自动从最新 `.bak-*` 恢复;升级时顺带清扫
   缓存内 ≥24h 的 `stage-*` 残留。
3. **便携版热重启不再全量重拷/毒化缓存**:`restartService` 原先硬编码
   `ensureStableRuntimeCopy(...,'restart')`,每次热重启重拷 ~200MB,并把缓存 marker
   写成 'restart',导致之后每次启动都因版本不匹配再全拷一次。现统一沿用 `start()`
   记录的真实 appVersion。
4. **端口判定更稳**:先 TCP 探测“端口到底有没有人监听”,再 HTTP 探测;只有根路径
   2xx 且非 401 的服务才“接管”。auth-gated DSH / 非 HTTP / 5xx / 404 占用者一律换
   下一个空闲端口自起——避免把窗口指到无关内容,也避免同端口 spawn 撞 EADDRINUSE。
5. **启动超时清理**:120s 就绪超时先 kill 已 spawn 的子进程(含 taskkill /T)并清空
   state.child 再抛错,不留带 token 的孤儿服务占端口。
6. **重启串行化**:市场升级、崩溃监督自动重拉、首启补装的热重启共用一条 promise
   队列,不会出现两个 spawn 并发抢同一端口。
7. profile `package.json` 的 bundles 登记改为 tmp+rename 原子写(并发/中断不再可能
   写坏 manifest)。
8. **日志加固**:desktop.log 约 5MB 轮转(保留一份 .1);所有落盘/打印统一把
   `?token=…` 打码,不再明文持久化。
9. 私有 registry(带路径前缀)的 dist-tags 基址还原不再只留 host(否则 tgz URL 拼错)。

## main.js / 两个 preload
10. **IPC sender 校验 + 导航白名单**:`dshp:*` 全部 handler 校验 senderFrame URL(仅
    本机控制台 / deepseek.com 域树 / file: splash 放行);console/chat 视图加
    `will-navigate` 白名单,顶层导航到第三方一律拦下并交给系统浏览器。
11. preload 顶部按 hostname 自检:不在控制台(127.0.0.1/localhost)或
    chat.deepseek.com(站内子域)就直接退出——陌生页面零注入、零 IPC。
12. **chat-state 初始同步**:控制台视图 did-finish-load(含服务自动重启后的重载)
    补发一次 `dshp:chat-state`,chip/标题不再与主进程失步。
13. **渲染进程崩溃自愈**:console/chat/shell 的 render-process-gone 现在自动重载
    对应视图(30s 窗口内最多 3 次,防崩溃死循环);原先只打日志 → 白屏只能重启应用。
14. **日志脱敏**:`created console view …` 等不再把带 token 的 URL 写进日志。
15. preload 细节:缩放 IPC 改 rAF 合帧(高频 pointermove 每帧最多一次 setBounds);
    `shiftTopRight` 位移可逆(每轮先归位、再按自然位置重算,resize 后不残留错位);
    页面隐藏(document.hidden)时不空转做布局扫描。

## 其它
16. package.json / package-lock 与新仓库定版一致(1.0.0);NSIS 增加固定 artifactName
    `DeepSeek-Harness-Desktop-Setup-${version}.exe`(消除不同 release 间安装包命名
    漂移);新增 `dist:setup` 脚本;补 author / repository / homepage 元信息。
17. README:版本引用定为 v1.0.0、中英 first-run 说明一致化(市场为随包内置、
    离线可用)、构建/自检命令与文件布局表补全。

## 待回归项（发版前真机验证）
- ① 市场 6h 升级现在真的会“下载 → 原子替换 → 热重启”,请完整观察一次升级过程;
- ② 便携版一次热重启后缓存命中,后续启动不再二次全量重拷;
- ③ 聊天页登录/SSO 跳转未被 will-navigate 白名单误拦(若官方登录会跳到 deepseek.com
  之外的域名,把该域名加进 main.js 的 isDeepSeekSite);
- ④ 自绘拖拽/缩放手感、崩溃自愈与旧版一致。

---

# 追加改动（第七轮 · 2026-09-07 市场目录源回退补丁）

## 背景
dshmarket 的 `global` 区域只从官方目录源 `https://awesome-dsh-plugin.com/plugins.json`
(GitHub Pages/Fastly)拉插件列表;该域名在中国大陆网络会不定时不可达(实测一次持续
10–15 分钟,期间市场“能打开但拉不到列表”,报 `(30s, 2 attempts)`)。浏览器能开别的
网页与它无关——市场列表是服务端(Node)去抓这个域名的。

## 改动
1. **随包 dshmarket 补丁**(构建期由 `scripts/prep-runtime.mjs` 在固化市场后自动执行
   `scripts/patch-market-catalog-fallback.cjs`,幂等):
   - `global` 区域目录源改为 **腾讯云 npm 镜像的 `dsh-plugin-catalog` 优先、官方源兜底**
     (与 `china` 区域同源);
   - 同步修正 `routesFor()` 的 npm 目录源映射,保留源自带 registry(否则会被区域
     registry 重写,镜像回退失效)。
   - 只影响目录读取;插件下载来源/区域语义不变。
2. 新增 `scripts/patch-market-catalog-fallback.cjs`(可复现、幂等、结构变化时报错)。

## 说明 / 注意
- 若日后 dshmarket 发布新版本且被“6h 自动升级”替换,补丁会随旧副本一起被换掉
  (下一版安装包需重新内置打过补丁的市场)。
- 用户仍可手动切换“下载区域 = 全球/中国大陆”,两条线现在都能浏览;官方源恢复后
  行为与旧版一致(镜像优先,官方作为兜底)。

