'use strict';
/**
 * console-preload.js — desktop-only augmentation of the DSH console page.
 *
 * The console page's own DOM is NEVER modified: everything we add is a floating
 * overlay (window chrome, the 切换 chip) so official UI updates can't break us
 * and DSH/plugin DOM stays untouched.
 *
 *   1. “切换”（切换进官方聊天页）是一个纯图标小按钮，紧贴在侧栏顶部
 *      “收起/展开侧边栏”按钮的下方/旁边悬浮（不遮挡任何原生按钮；侧栏
 *      收窄时移到窄条右侧），颜色跟随页面主题、无背景（与聊天页的切换一致）；
 *   2. 无边框窗口：右上 最小化/最大化/关闭；窗口拖拽交给系统原生
 *      -webkit-app-region:drag 顶条完成（main.js 已设 maximizable:false /
 *      resizable:false / thickFrame:false —— 拖动只会移动窗口，绝不会被
 *      Windows 吸附放大或在高分屏上逐帧变大）；
 *   3. 快捷键 Alt+1 在控制台与聊天页之间来回切换。
 */
const { ipcRenderer } = require('electron');

(() => {
  if (typeof document === 'undefined') return;

  // 只在本机 DSH 控制台页注入;顶层被导航到任何其它站点(误开/劫持)时
  // preload 立即退出,不在陌生页面注入窗口按钮或注册任何 IPC。
  try {
    const h = location.hostname || '';
    if (location.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost)$/i.test(h)) return;
  } catch {
    return;
  }

  const S = { chip: null, chatOn: false, wc: null, rs: null };

  // ---------------------------------------------------------------- styles
  const CSS = `
/* 顶部原生拖拽条（右端给窗口按钮留位）。全宽 12px：位于所有原生按钮
   （最早 y≈12）之上，整条边缘都能拖，不遮挡点击。
   #dshp-dragzone 是透明的“自由空白拖拽”容器（本身不拦事件，pointer-events:none），
   其子块按内容区空白缝隙摆放：高 58px 的拖拽块自动避开按钮/输入框，
   不用贴边也能按住窗口中间上部拖动 */
html.dshp-on .dshp-dragbar{position:fixed;top:0;left:0;right:140px;height:12px;z-index:2147483800;-webkit-app-region:drag;app-region:drag;cursor:default}
html.dshp-on #dshp-dragzone{position:fixed;top:0;left:0;right:0;height:58px;z-index:2147483700;pointer-events:none;overflow:hidden}
html.dshp-on #dshp-dragzone > div{position:absolute;top:0;bottom:0;-webkit-app-region:drag;app-region:drag;cursor:default;pointer-events:auto}
/* 悬浮“切换”小图标：无文字无自绘色，中性主题色，圆角悬停底 */
html.dshp-on .dshp-chat{position:fixed;z-index:2147483900;display:inline-flex;align-items:center;justify-content:center;width:28px;height:24px;padding:0;border:none !important;background:transparent !important;color:var(--dshp-text, inherit);cursor:pointer;border-radius:9px;box-shadow:none !important;user-select:none}
html.dshp-on .dshp-chat:hover{background:color-mix(in srgb, var(--dshp-text, #888) 14%, transparent)}
html.dshp-on .dshp-chat:active{background:color-mix(in srgb, var(--dshp-text, #888) 22%, transparent)}
html.dshp-on .dshp-chat[hidden]{display:none}
html.dshp-on .dshp-chat svg{display:block;flex:none}
/* 底部/右下角 缩放把手（拖下边改变高度、拖右下角同时改变宽高；左上角固定，
   绝对位移跟随，边缘始终粘着鼠标） */
html.dshp-on .dshp-rs{position:fixed;z-index:2147483950;user-select:none;touch-action:none}
html.dshp-on .dshp-rs-bottom{left:10px;right:26px;bottom:0;height:8px;cursor:ns-resize}
html.dshp-on .dshp-rs-br{right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize}
html.dshp-on .dshp-rs[hidden]{display:none}
/* frameless window chrome */
html.dshp-on .dshp-wc{position:fixed;top:0;right:0;display:flex;flex-direction:row;height:36px;z-index:2147483600;-webkit-app-region:no-drag;user-select:none}
html.dshp-on .dshp-wc button{width:46px;height:36px;margin:0;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dshp-text);cursor:default}
html.dshp-on .dshp-wc button:hover{background:color-mix(in srgb, var(--dshp-text) 13%, transparent)}
html.dshp-on .dshp-wc button.dshp-wc-close:hover{background:#e81123;color:#fff}
html.dshp-on .dshp-wc svg{display:block}
`;

  const WC_SVG = {
    min: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M3 8h10"/></svg>',
    max: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1"/></svg>',
    restore: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6.4 3.4h6.2v6.2"/><path d="M9.6 12.6H3.4V6.4"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
  };

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function debounce(fn, ms) {
    let t = null;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }
  function ensureStyle() {
    if (!document.getElementById('dshp-css')) {
      const st = document.createElement('style');
      st.id = 'dshp-css';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    document.documentElement.classList.add('dshp-on');
  }

  // light/dark theme colours for the chrome / chip
  function lumColor(rgb) {
    const m = String(rgb).match(/rgba?\(([^)]+)\)/);
    if (!m) return 0.5;
    const p = m[1].split(',').map((s) => parseFloat(s.trim()));
    return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255;
  }
  function applyThemeVars() {
    try {
      const wide = document.querySelector('button');
      if (!wide) return;
      let base = getComputedStyle(wide).backgroundColor;
      if (/rgba\(0, 0, 0, 0\)/.test(String(base)) || String(base) === 'transparent') {
        const col = document.querySelector('.pI_x6G_sidebarCol');
        base = col ? getComputedStyle(col).backgroundColor : '#ffffff';
      }
      const dark = lumColor(base) < 0.5;
      const textColor = dark ? '#e8edf6' : '#0f1115';
      const rs = document.documentElement.style;
      rs.setProperty('--dshp-text', textColor);
      rs.setProperty('--dshp-surface', base);
    } catch {}
  }

  // ------------------------------------------- frameless window chrome + drag
  function ensureWinControls() {
    if (S.wc) return;
    const wc = h('div', 'dshp-wc');
    const mk = (kind, label) => {
      const b = h('button', 'dshp-wc-btn dshp-wc-' + kind);
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = WC_SVG[kind];
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send('dshp:win-' + (kind === 'max' ? 'max-toggle' : kind));
      });
      wc.appendChild(b);
      return b;
    };
    const bMin = mk('min', '最小化');
    const bMax = mk('max', '最大化 / 还原');
    mk('close', '关闭');
    document.body.appendChild(wc);
    S.wc = wc;
    let lastMax = null;
    const onMax = (_e, s) => {
      const max = !!(s && s.max);
      if (max === lastMax) return;
      lastMax = max;
      bMin.title = '最小化';
      bMax.title = max ? '还原' : '最大化';
      bMax.setAttribute('aria-label', bMax.title);
      bMax.innerHTML = max ? WC_SVG.restore : WC_SVG.max;
    };
    ipcRenderer.on('dshp:win-max-state', onMax);
    ipcRenderer.send('dshp:win-max-query');
  }

  // 系统原生拖拽顶条：OS 负责移动窗口（物理像素级、无漂移放大；
  // main.js 已禁用原生最大化，因此拖到屏幕边缘也只会移动）。
  function ensureDragBars() {
    if (!document.getElementById('dshp-dragbar')) {
      const bar = h('div', 'dshp-dragbar');
      bar.id = 'dshp-dragbar';
      document.body.appendChild(bar);
    }
    if (!document.getElementById('dshp-dragzone')) {
      const zone = h('div', 'dshp-dragzone');
      zone.id = 'dshp-dragzone';
      document.body.appendChild(zone);
    }
  }
  // 让“内容区”出现可拖的自由空白块：扫描顶部 58px 内所有原生交互元素，
  // 只把不含任何按钮/输入框的横向区段变成原生拖拽块（自动避开按钮，不遮挡）。
  function updateDragZone() {
    try {
      const zone = document.getElementById('dshp-dragzone');
      if (!zone) return;
      const BAND_H = 58;
      const MIN_W = 60;
      const rightCap = window.innerWidth - 150;
      const blockers = [];
      for (const el of document.querySelectorAll('button, [role="button"], a, input, textarea, select, [contenteditable="true"]')) {
        if (!el.isConnected) continue;
        if (el.classList && (el.classList.contains('dshp-chat') || el.classList.contains('dshp-wc-btn'))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        if (r.bottom <= 2 || r.top >= BAND_H) continue; // intersects top band
        if (r.right <= 0 || r.left >= rightCap) continue;
        blockers.push({ left: r.left, right: r.right });
      }
      const edges = new Set([0, rightCap]);
      for (const b of blockers) {
        if (b.left > 0 && b.left < rightCap) edges.add(Math.round(b.left));
        if (b.right > 0 && b.right < rightCap) edges.add(Math.round(b.right));
      }
      const sorted = [...edges].sort((a, b) => a - b);
      const pieces = [];
      for (let i = 0; i + 1 < sorted.length; i++) {
        const l = sorted[i];
        const r = sorted[i + 1];
        if (r - l < MIN_W) continue;
        const free = !blockers.some((b) => b.right > l + 3 && b.left < r - 3);
        if (free) pieces.push({ left: l + 1, right: r - 1 });
      }
      // 用 data 键避免每 400ms 重建 DOM
      const key = pieces.map((p) => p.left + '|' + p.right).join(',');
      if (zone.dataset.key === key) return;
      zone.dataset.key = key;
      zone.textContent = '';
      for (const p of pieces) {
        const d = document.createElement('div');
        d.style.left = p.left + 'px';
        d.style.width = Math.max(1, p.right - p.left) + 'px';
        zone.appendChild(d);
      }
    } catch {}
  }

  // keep the page’s own top-right controls clear of the window cluster
  // (位移可逆:先解除上一轮所有 translate,再按“自然位置”重新测量;窗口 resize
  //  或站点重排后不会残留错位,已移元素也不会因缓存键相同而丢位移)
  function shiftTopRight() {
    try {
      for (const el of document.querySelectorAll('[data-dshp-shift]')) {
        try {
          el.style.transform = '';
        } catch {}
      }
      const vw = window.innerWidth;
      const zoneLeft = vw - 148;
      const shifted = new Set();
      let n = 0;
      for (const el of document.querySelectorAll('button, [role="button"], a, [tabindex]')) {
        if (n++ > 60) break;
        if (!el.isConnected) continue;
        if (el.classList && el.classList.contains('dshp-wc-btn')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (r.top > 60 || r.bottom < 8) continue;
        if (r.right <= zoneLeft + 4 || r.right > vw + 2) continue;
        if (el.closest('[role="dialog"], [aria-modal="true"]')) continue;
        const dx = Math.min(320, Math.max(8, Math.round(r.right - zoneLeft)));
        shifted.add(el);
        el.dataset.dshpShift = String(dx);
        try {
          el.style.transform = 'translateX(-' + dx + 'px)';
        } catch {}
      }
      // 兜底:本轮不再需要位移的历史元素清干净(含扫描限 60 之外的残留)
      for (const el of document.querySelectorAll('[data-dshp-shift]')) {
        if (!shifted.has(el)) {
          try {
            delete el.dataset.dshpShift;
            el.style.transform = '';
          } catch {}
        }
      }
    } catch {}
  }

  // -------------------------------------------------- 底部/右下角 缩放把手
  function ensureResizeHandles() {
    if (S.rs) return;
    const mk = (cls, dir) => {
      const hEl = h('div', 'dshp-rs ' + cls);
      hEl.dataset.dshpDir = dir;
      hEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const st = { x: e.screenX, y: e.screenY };
        try {
          ipcRenderer.send('dshp:win-resize-start');
          if (hEl.setPointerCapture) hEl.setPointerCapture(e.pointerId);
        } catch {}
        // rAF 合帧:高频 pointermove 只保留最新位移,每帧最多发一次 IPC,
        // 避免主进程 setBounds 风暴(拖拽跟手性不受影响——永远发最新值)
        let raf = 0;
        let pending = null;
        const flush = () => {
          raf = 0;
          if (!pending) return;
          const p = pending;
          pending = null;
          try {
            ipcRenderer.send('dshp:win-resize', p);
          } catch {}
        };
        const move = (ev) => {
          pending = {
            dx: dir === 'h' || dir === 'd' ? Math.round(ev.screenX - st.x) : 0,
            dy: dir === 'v' || dir === 'd' ? Math.round(ev.screenY - st.y) : 0
          };
          if (!raf) raf = requestAnimationFrame(flush);
        };
        const up = () => {
          if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
          }
          try {
            ipcRenderer.send('dshp:win-resize-end');
          } catch {}
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      return hEl;
    };
    const wrap = h('div', 'dshp-rs');
    S.rs = wrap;
    wrap.appendChild(mk('dshp-rs-bottom', 'v'));
    wrap.appendChild(mk('dshp-rs-br', 'd'));
    document.body.appendChild(wrap);
  }

  // ------------------------------------------------------ 悬浮“切换”小图标
  function svgIcon(d, size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(size || 13));
    svg.setAttribute('height', String(size || 13));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }
  const ICON_SWITCH = 'M7 7h10M7 7l3-3M7 7l3 3M17 17H7M17 17l-3-3M17 17l-3 3';

  // 原生侧栏“收起/展开/打开侧边栏”按钮 = 悬浮“切换”的锚点
  function findRailToggle() {
    try {
      const els = [...document.querySelectorAll('button,[role="button"]')].filter((b) => {
        if (b.classList && (b.classList.contains('dshp-chat') || b.classList.contains('dshp-wc-btn'))) return false;
        const hay = ((b.getAttribute && (b.getAttribute('aria-label') || '')) || '') + ' ' + (b.getAttribute && (b.getAttribute('title') || '')) + ' ' + (b.textContent || '').trim();
        const r = b.getBoundingClientRect();
        return /收起侧边栏|展开侧边栏|打开侧边栏/.test(hay) && r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0;
      });
      if (!els.length) return null;
      return els[0];
    } catch {
      return null;
    }
  }

  function railSideWidth() {
    try {
      const col = document.querySelector('.pI_x6G_sidebarCol');
      if (col) return col.getBoundingClientRect().width;
      const w = document.querySelector('button.hHd-Xa_newSession, button');
      if (!w) return 0;
      let el = w.parentElement;
      for (let i = 0; i < 6 && el; i++) {
        const cs = getComputedStyle(el);
        if (cs.position === 'sticky' || /sidebarCol|hHd-Xa/.test(String(el.className || ''))) {
          return el.getBoundingClientRect().width;
        }
        el = el.parentElement;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  // 把“切换”贴到收起按钮正下方；窄栏（已收起）时移到窄条右侧顶部。
  // 恒不遮挡原生按钮：芯片 22px，放在收起按钮与下一行按钮之间的空隙中。
  function positionChip() {
    const chip = S.chip;
    if (!chip) return false;
    const toggle = findRailToggle();
    if (!toggle) {
      chip.hidden = true;
      return false;
    }
    const tr = toggle.getBoundingClientRect();
    const railW = railSideWidth();
    const collapsed = /打开|展开/.test((toggle.getAttribute('aria-label') || '') + (toggle.textContent || ''));
    const CW = 28;
    const CH = 24;
    let left;
    let top;
    if (!collapsed) {
      // 展开：贴紧收起图标正下方（图标底 ~50 → 芯片 y52..74，与“新会话”(y74) 相接不重叠）
      const gapTop = tr.bottom + 2;
      const next = tr.bottom + 24; // approximate next-row top
      const hh = Math.min(CH, Math.max(16, next - gapTop));
      left = Math.round(tr.left + tr.width / 2 - CW / 2);
      top = Math.round(gapTop + (next - gapTop - hh) / 2);
      chip.style.height = hh + 'px';
    } else {
      // 已收起：窄条右侧、紧贴其下方悬浮（窄条内图标列无空位）
      left = Math.round((railW || tr.right) + 6);
      top = Math.round(tr.bottom + 4);
      chip.style.height = CH + 'px';
    }
    chip.style.width = CW + 'px';
    left = Math.max(6, Math.min(left, window.innerWidth - CW - 150));
    top = Math.max(6, Math.min(top, window.innerHeight - CH - 40));
    chip.style.left = left + 'px';
    chip.style.top = top + 'px';
    chip.hidden = false;
    return true;
  }

  function ensureChatChip() {
    try {
      if (!S.chip) {
        const chip = h('button', 'dshp-ui dshp-chat');
        chip.type = 'button';
        chip.setAttribute('aria-label', '切换：打开官方免费聊天');
        chip.title = '打开官方免费聊天（或按 Alt+1 来回切换）';
        chip.appendChild(svgIcon(ICON_SWITCH, 17));
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          ipcRenderer.send('dshp:chat-toggle');
        });
        document.body.appendChild(chip);
        S.chip = chip;
      }
      positionChip();
      S.chip.classList.toggle('on', S.chatOn);
      S.chip.title = S.chatOn ? '正在 DeepSeek 聊天（按 Alt+1 可切回）' : '打开官方免费聊天（或按 Alt+1）';
    } catch {}
  }

  function applyChatState(on) {
    S.chatOn = !!on;
    if (S.chip) {
      S.chip.classList.toggle('on', on);
      S.chip.title = on ? '正在 DeepSeek 聊天（按 Alt+1 可切回）' : '打开官方免费聊天（或按 Alt+1）';
    }
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        setTimeout(boot, 100);
      }
      return;
    }
    ensureStyle();
    ensureDragBars();
    ensureWinControls();
    ensureResizeHandles();
    ensureChatChip();

    const observer = new MutationObserver(
      debounce(() => {
        ensureChatChip();
        updateDragZone();
      }, 250)
    );
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-label'] });

    const sweep = () => {
      try {
        applyThemeVars();
        ensureChatChip();
        updateDragZone();
        shiftTopRight();
      } catch {}
    };
    setInterval(() => {
      if (document.hidden) return; // 窗口隐藏/最小化时不空转做布局扫描
      sweep();
    }, 400);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sweep();
    });
    window.addEventListener('resize', debounce(() => {
      shiftTopRight();
      ensureChatChip();
      updateDragZone();
    }, 150));

    ipcRenderer.on('dshp:chat-state', (_e, s) => applyChatState(s && s.on));
  }

  boot();
})();
