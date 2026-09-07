# DeepSeek Harness Desktop（Windows 桌面版）/ (Windows Desktop)

> **中文**：一个把 **DeepSeek Harness（DSH）控制台** 和 **chat.deepseek.com 官方免费聊天**
> 合进同一窗口的 Electron 桌面应用：不用开浏览器标签，一键在两个界面间切换。
> 本项目与 DeepSeek / DeepSeek Harness 官方**无任何隶属关系**，非官方作品。
>
> **EN**: An Electron desktop app that puts the **DeepSeek Harness (DSH) console** and the
> **official free chat at chat.deepseek.com** into one window — switch between the two
> interfaces with a single click, no extra browser tabs. This project is **unofficial** and
> is **not affiliated with** DeepSeek / DeepSeek Harness.

## 图标设计 / Icon Design

> **中文**：应用图标由**蓝黑渐变**组成，寓意“双鲸合一”：
>
> - **蓝色鲸鱼** —— 代表 **DeepSeek Chat（官方免费聊天）**：官方鲸鱼即是蓝色，象征自由聊天的轻快与开放；
> - **黑色鲸鱼** —— 代表 **DeepSeek Harness**：黑色的“工作鲸”对应 Harness 沉稳、专注、干活的一面；
> - 两条鲸鱼以蓝黑渐变交融，寓意「自由聊天 ⇄ 深度工作」两个世界在同一窗口无缝合一。
>
> **EN**: The icon is a **blue–black gradient** of two whales:
>
> - **Blue whale** — **DeepSeek Chat** (the official free chat); blue is DeepSeek's official whale color, standing for light, open chatting;
> - **Black whale** — **DeepSeek Harness**, the “working whale” for focused, deep work;
> - The gradient merges the two whales — “free chat ⇄ deep work” unified seamlessly in one window.

## 特性 / Features

- **开箱即用 / Out of the box**
  - 中文：安装包**自带 Electron 与 DeepSeek Harness 运行时**，无需安装 Node.js / npm / 浏览器 / WebView2 等任何环境，双击即用；首次启动自动初始化 `%USERPROFILE%\.dsh`，端口被占用时自动改空闲端口。
  - EN: The installer **bundles Electron and the DeepSeek Harness runtime** — no Node.js / npm / browser / WebView2 needed. Double-click and go. First launch initializes `%USERPROFILE%\.dsh` and auto-picks a free port if needed.
- **双界面一键切换 ⇄ / One-click switch ⇄**
  - 中文：Harness 侧栏“收起侧边栏”图标下方与聊天页侧栏收起图标下方各有一个纯图标 ⇄ 小按钮（不遮挡按钮、颜色随主题）；点击即在 Harness 控制台 ⇄ 官方免费聊天之间整窗切换，`Alt+1` 亦可。chat.deepseek.com 登录持久，登录一次重启仍在。
  - EN: A small icon ⇄ button sits under the “collapse sidebar” toggle on both pages (Harness rail and chat rail). Click it to switch the whole window between the DSH console ⇄ official chat; `Alt+1` works too. chat.deepseek.com login persists across restarts.
- **窗口体验 / Window experience**
  - 中文：默认 1360×840；拖**最下边**调高度、拖**右下角**同时调宽高，边缘始终跟随鼠标；窗口四角圆润（Win11）。按住顶部细条/空白区拖动**只会移动窗口**——防“拖到屏幕顶被最大化”与高分屏逐帧放大；右上角自绘 最小化/最大化/关闭（关闭隐藏到托盘）。
  - EN: Default 1360×840; drag the **bottom edge** for height and the **bottom-right corner** for both width & height, edge always follows the mouse; rounded corners on Windows 11. Dragging by the top strip/blank area **only moves** the window (no snap-maximize, no DPI pixel-drift enlargement). Top-right has custom min / max / close (close hides to tray).
- **本地运行 / Fully local**
  - 中文：窗口内容与网页版一致，自动在本地启动 DSH 服务（默认端口 3080，随包内置运行时），不修改网页版与官方服务。
  - EN: The console is identical to the browser version; the app starts a local DSH service (default port 3080) with the bundled runtime and never alters the web build or official services.
- **内置插件商店 / Built-in plugin market**
  - 中文：内置 DeepSeek Harness 插件市场（dshmarket），**成千上万款插件**可浏览/安装/更新；同时**内置 pnpm**（启动时自动放到 `%LOCALAPPDATA%\pnpm`，市场里可直接“自动配置 Pnpm 环境”）。**新版安装包把市场本体随包内置**：首次启动离线即可用——应用数秒内自动登记并加载出插件市场（窗口不关、无需重启）；联网时约每 6 小时自动升级内置市场，断网/中断都安全，下次自动重试。市场的**目录源已做“国内镜像优先、官方兜底”**：官方目录站（awesome-dsh-plugin.com）抽风或不可达时，浏览插件列表不受影响（只是换条线路，插件来源不变）。
  - EN: Ships with the DeepSeek Harness plugin market (dshmarket) — browse/install/update thousands of plugins. **pnpm is bundled** (auto-placed at `%LOCALAPPDATA%\pnpm`, so the market's “auto-configure pnpm” works). New builds **bundle the market itself**: it registers and loads within seconds of the first launch, fully offline (no restart needed); while online it auto-upgrades the bundled market about every 6 hours. Network loss / interruption is safe — it simply retries later. The market's **catalog source prefers the China npm mirror with the official site as fallback**, so an official-catalog outage never blocks browsing (route changes only; plugin sources are unchanged).

## 安装 / Installation

> 中文：Windows 10/11 x64。到 GitHub Releases 页下载最新版：
> <https://github.com/ElliotAlderson137/deepseek-harness-desktop/releases>
>
> EN: Windows 10/11 x64. Download the latest from the GitHub Releases page:
> <https://github.com/ElliotAlderson137/deepseek-harness-desktop/releases>

| 文件 / File | 说明 / Notes |
|---|---|
| `DeepSeek-Harness-Desktop-Setup-<版本>.exe` | **安装版（推荐日常使用）** / **Installer (recommended)** |
| `DeepSeek-Harness-Desktop-<版本>-portable.exe` | 免安装单文件版 / Portable single-file |

> 中文：安装包**不进代码仓库**，仅作为 GitHub Release 附件发布（当前 v1.0.0 已发布）；未签名，首次运行 SmartScreen 提示选「更多信息 → 仍要运行」。
> EN: Installers are **not committed** to the repo — they are published as GitHub Release assets (v1.0.0 is live); unsigned — choose “More info → Run anyway” on the SmartScreen prompt.
>
> 中文：GitHub 下载慢？备用下载（微云网盘，含安装版与便携版）：<https://share.weiyun.com/H8R7eeOo>
> EN: GitHub downloads too slow? Backup download (Tencent Weiyun, installer & portable): <https://share.weiyun.com/H8R7eeOo>

### 安装版 vs 便携版 / Installer vs Portable

| 维度 / Aspect | 安装版 Setup / Installer | 便携版 Portable |
|---|---|---|
| 安装方式 / Install | 写入本机程序目录，带快捷方式与卸载入口 / Installs locally with shortcuts & uninstaller | 单个 exe，放哪都能跑（可放 U 盘）/ One exe, runs anywhere (USB-friendly) |
| 启动速度 / Startup | 快（文件已就位）/ Fast | 每次启动先在临时目录自解压，明显更慢 / Self-extracts to temp each launch — noticeably slower |
| 首次运行 / First run | 只需初始化配置 / Just inits config | 还要缓存约 200MB 运行时，更慢 / Also caches ~200MB runtime first time |
| 更新/卸载 / Update | 安装包升级、卸载干净 / Clean upgrade via installer | 删文件即走、换新文件即升级 / Delete to remove, replace to upgrade |
| 建议 / Verdict | ✅ 日常主力 / Daily driver | 尝鲜、出差、多机轮换 / Trying out, travel, multi-machine |

### 首次启动说明 / First-run notes

> **中文**：首次启动会初始化 `%USERPROFILE%\.dsh`、必要时缓存运行时。新版安装包**随包内置插件市场**，离线也能在数秒内登记并加载（无需重启）；旧版安装/开发态则联网自动补装。联网时约每 6 小时自动升级内置市场。这些步骤全部“尽力而为”：断网/中断只影响市场更新，绝不影响控制台与聊天，也不会崩溃。若已运行其它 Harness（如网页版 3080），自动改用空闲端口互不干扰；在线功能需联网。
>
> **EN**: First launch initializes `%USERPROFILE%\.dsh` and caches the runtime if needed. With the new installer the plugin market is **bundled**: it is registered and loaded within seconds of the first launch, fully offline (no restart needed); legacy installs / dev builds fall back to an online install. These steps are best-effort: offline/interrupted runs only delay market updates — the console, chat and stability are never affected. If another Harness (e.g. the web build on port 3080) is already running, the app picks a free port. Online features need a connection.

## 使用 / Usage

> **中文**：1) 启动进入 DSH 控制台；2) 点 ⇄ 小按钮进入官方免费聊天，聊天页内点同款按钮或 `Alt+1` 返回；3) 拖顶部移动窗口、拖下边/右下角缩放；4) × 最小化到托盘，托盘菜单可退出。
>
> **EN**: 1) Launch into the DSH console; 2) click the ⇄ button to enter the official free chat and click the same button or `Alt+1` to return; 3) drag the top strip/blank area to move, bottom edge or bottom-right corner to resize; 4) × hides to tray; quit from the tray menu.

## 开发 / Development

> **中文**：环境 Node.js ≥ 18（推荐 20+）。
> **EN**: Requires Node.js ≥ 18 (20+ recommended).

```bash
npm install
# 准备内置 DSH 运行时（从本地已安装的 @deepseek-ai/dsh 拷贝 node_modules，
# 或用 DSH_RUNTIME_SRC 指向 DSH 检出目录）
# Stage the bundled DSH runtime (copies node_modules from a local @deepseek-ai/dsh,
# or point DSH_RUNTIME_SRC at a DSH checkout)
npm run prep:runtime

npx electron .            # 本地运行 / run locally
npm run dist:dir          # dist/win-unpacked（免安装目录版 / dir build）
npm run dist:portable     # 单文件 portable.exe
npm run dist:setup        # 安装版 Setup.exe（内部先 prep:runtime；等价 npx electron-builder --win nsis）
npm run verify:bundled-market  # 端到端自检“随包内置插件市场”（需先跑过 prep:runtime）
```

> **中文**：调试环境变量：`DSH_DESKTOP_USERDATA`（隔离用户数据）、`DSH_DESKTOP_VERBOSE=1`、
> `DSH_DESKTOP_SMOKE_CAPTURE` / `DSH_DESKTOP_SMOKE_QUIT_MS`（冒烟截图）、
> `DSH_DESKTOP_NO_RELAUNCH=1`（首装后不自动热重启）、`DSH_DESKTOP_DIRPICKER=native`（目录选择用原生）。
> 应用日志：`%LOCALAPPDATA%\DSHDesktop\logs\desktop.log`。
>
> **EN**: Debug env: `DSH_DESKTOP_USERDATA` (isolate user data), `DSH_DESKTOP_VERBOSE=1`,
> `DSH_DESKTOP_SMOKE_CAPTURE` / `DSH_DESKTOP_SMOKE_QUIT_MS` (smoke screenshots),
> `DSH_DESKTOP_NO_RELAUNCH=1` (skip first-run service hot-restart),
> `DSH_DESKTOP_DIRPICKER=native` (force the native directory picker).
> App log: `%LOCALAPPDATA%\DSHDesktop\logs\desktop.log`.

### 文件布局 / File layout

| 文件 / File | 中文作用 | English role |
|---|---|---|
| `main.js` | 主进程：窗口、聊天视图、缩放/拖拽 IPC、托盘、DSH 服务启动与原生最大化守卫 | Main process: window, chat view, resize/drag IPC, tray, DSH service startup & native-maximize guard |
| `console-preload.js` | Harness 页注入：⇄ 切换图标、拖拽条/空白拖拽块、缩放把手、窗口按钮 | Harness page: ⇄ switch icon, drag strip/blank drag zones, resize handles, window buttons |
| `chat-preload.js` | chat.deepseek.com 注入：同款 ⇄ 图标、缩放把手、窗口按钮 | chat.deepseek.com: same ⇄ icon, resize handles, window buttons |
| `preload.js` / `shell/*` | 启动画面 | Splash screen |
| `server/manager.cjs` | DSH 本地服务生命周期：运行时查找、端口接管、插件市场补装/升级、目录选择器策略、服务热重启 | DSH service lifecycle: runtime lookup, port takeover, plugin-market install/upgrade, directory-picker policy, service hot-restart |
| `scripts/prep-runtime.mjs` | 把 DSH 运行时 node_modules 预备到 `runtime-src/`（仅打包用） | Stage DSH runtime node_modules into `runtime-src/` (packaging only) |
| `scripts/verify-bundled-market.cjs` | 端到端自检：真实拉起服务，验证随包市场的“离线登记→热重启→挂载”（A–I） | End-to-end self check: boots a real service to verify bundled-market offline registration → hot restart → mount (A–I) |
| `scripts/patch-market-catalog-fallback.cjs` | 构建期给随包市场打“目录源镜像优先、官方兜底”补丁（幂等，prep:runtime 自动执行） | Build-time idempotent patch: makes the bundled market's catalog prefer the China npm mirror with the official source as fallback (run automatically by prep:runtime) |

## 隐私说明 / Privacy

> **中文**：本机启动 DSH 服务并直接渲染官方网页，不经过任何第三方服务器、不收集使用数据；聊天登录 Cookie、DSH 会话等保存在本机用户目录；日志仅写本机 `%LOCALAPPDATA%\DSHDesktop\logs\desktop.log`。
>
> **EN**: The app starts the DSH service locally and renders official pages directly — no third-party server, no telemetry. Chat cookies and DSH data stay in your local user profile; logs go only to `%LOCALAPPDATA%\DSHDesktop\logs\desktop.log`.

## 说明与限制 / Notes & limits

- 中文：`chat.deepseek.com` 禁止 iframe 内嵌，聊天采用 Electron 原生视图整窗呈现；登录前聊天页没有会话栏，⇄ 小图标显示在左下角，也可用 `Alt+1` 返回；应用未签名；与官方无隶属关系。
- EN: `chat.deepseek.com` forbids iframes, so chat is rendered as a full-window native view; before login there is no rail, so the ⇄ icon sits at the bottom-left (or press `Alt+1`); the app is unsigned and unofficial.

## 常见问题 / Troubleshooting

### 选择工作区报错 “win32 folder dialog worker exited before reporting a result”

> **中文（现象）**：新建/选择工作区弹窗报
> `directory picker failed: directory picker failed: win32 folder dialog worker exited before reporting a result`
>
> **原因**：DeepSeek Harness 官方**原生目录选择器**的已知问题——它另起的 koffi/Win32 worker 在部分 Win10/虚拟机上“弹框后读取所选路径”时原生崩溃。官方讨论：
> [#30](https://github.com/deepseek-ai/deepseek-harness/discussions/30)、[#197](https://github.com/deepseek-ai/deepseek-harness/discussions/197)、[#236](https://github.com/deepseek-ai/deepseek-harness/discussions/236)、[#1503](https://github.com/deepseek-ai/deepseek-harness/discussions/1503)。
>
> **解决**：1) 升级到 1.0.0 及以上——桌面版默认改用**浏览器式目录选择器**，不再启动该 worker；2) 想用原生弹窗可设环境变量 `DSH_DESKTOP_DIRPICKER=native` 后启动；3) 若仍失败：装“Visual C++ 2015–2022 Redistributable (x64)”、管理员/普通模式各试一次、尽量手动输入路径、查 `%LOCALAPPDATA%\DSHDesktop\logs\desktop.log`。

> **EN (symptom)**: When creating/selecting a workspace the dialog reports
> `directory picker failed: directory picker failed: win32 folder dialog worker exited before reporting a result`.
>
> **Cause**: A known issue of DeepSeek Harness's official **native directory picker** — its koffi/Win32 helper worker natively crashes on some Windows 10 / VM setups *after* the dialog opens, while reading the chosen path. Official discussions: [#30](https://github.com/deepseek-ai/deepseek-harness/discussions/30), [#197](https://github.com/deepseek-ai/deepseek-harness/discussions/197), [#236](https://github.com/deepseek-ai/deepseek-harness/discussions/236), [#1503](https://github.com/deepseek-ai/deepseek-harness/discussions/1503).
>
> **Fix**: 1) Upgrade to 1.0.0+ — the desktop app now defaults to the **browser-style directory picker** (that worker is never launched); 2) to restore the native dialog, set `DSH_DESKTOP_DIRPICKER=native` before launch; 3) if it still fails: install the “Visual C++ 2015–2022 Redistributable (x64)”, try both admin and normal launch, type the path manually when possible, and check `%LOCALAPPDATA%\DSHDesktop\logs\desktop.log`.

## License

MIT

