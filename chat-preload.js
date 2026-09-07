'use strict';
/**
 * chat-preload.js — runs inside the official DeepSeek web chat page
 * (chat.deepseek.com, persistent login partition).
 *
 * Desktop-only additions (floating overlays only; chat site DOM is never
 * structurally modified):
 *   1. “切换”（返回 Harness）与 Harness 控制台页一致：纯图标小按钮，紧贴聊天页
 *      侧栏“收起侧边栏”图标的下方悬浮（侧栏收起时移到窄条旁），无背景、
 *      中性主题色（不继承站点按钮的紫红色）；
 *   2. frameless window chrome：右上 最小化/最大化/关闭 + 顶部原生拖拽条
 *      （系统级移动；main.js 禁用了原生最大化/缩放，拖动只会移动窗口）。
 */
const { ipcRenderer } = require('electron');

(() => {
  if (typeof document === 'undefined') return;

  // 只在 chat.deepseek.com(及站内子域/登录跳转页)注入;顶层被导航到任何
  // 第三方站点时 preload 立即退出,不在陌生页面注入窗口按钮或注册任何 IPC。
  try {
    const h = location.hostname || '';
    if (location.protocol !== 'https:' || !(h === 'deepseek.com' || h.endsWith('.deepseek.com'))) return;
  } catch {
    return;
  }

  const S = { host: null, back: null, wc: null, rs: null };

  const CSS = `
/* 顶部原生拖拽条（右端给窗口按钮留位）。全宽 12px；#dshpc-dragzone 内按
   顶部 58px 的空白缝隙自动生成拖拽块（避开站点按钮/输入框） */
html.dshpc-on .dshpc-dragbar{position:fixed;top:0;left:0;right:140px;height:12px;z-index:2147483800;-webkit-app-region:drag;app-region:drag;cursor:default}
html.dshpc-on #dshpc-dragzone{position:fixed;top:0;left:0;right:0;height:58px;z-index:2147483700;pointer-events:none;overflow:hidden}
html.dshpc-on #dshpc-dragzone > div{position:absolute;top:0;bottom:0;-webkit-app-region:drag;app-region:drag;cursor:default;pointer-events:auto}
/* “切换”= 悬浮小图标（不写入站点 DOM）：无文字无自绘色，中性主题色 */
html.dshpc-on .dshpc-back{position:fixed;z-index:2147483900;display:inline-flex;align-items:center;justify-content:center;width:28px;height:24px;padding:0;border:none !important;background:transparent !important;color:inherit;cursor:pointer;border-radius:9px;box-shadow:none !important;user-select:none}
html.dshpc-on .dshpc-back[hidden]{display:none}
html.dshpc-on .dshpc-back:hover{background:color-mix(in srgb, currentColor 14%, transparent)}
html.dshpc-on .dshpc-back:active{background:color-mix(in srgb, currentColor 22%, transparent)}
html.dshpc-on .dshpc-back svg{display:block;flex:none}
/* 底部/右下角 缩放把手（拖下边改高度，拖右下角改宽高；左上角固定，绝对位移
   跟随，边缘始终粘着鼠标） */
html.dshpc-on .dshpc-rs{position:fixed;z-index:2147483950;user-select:none;touch-action:none}
html.dshpc-on .dshpc-rs-bottom{left:10px;right:26px;bottom:0;height:8px;cursor:ns-resize}
html.dshpc-on .dshpc-rs-br{right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize}
html.dshpc-on .dshpc-rs[hidden]{display:none}
/* 无边框窗口 chrome */
html.dshpc-on .dshpc-wc{position:fixed;top:0;right:0;display:flex;flex-direction:row;height:36px;z-index:2147483600;-webkit-app-region:no-drag;user-select:none}
html.dshpc-on .dshpc-wc button{width:46px;height:36px;margin:0;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:inherit;cursor:default}
html.dshpc-on .dshpc-wc button:hover{background:color-mix(in srgb, currentColor 14%, transparent)}
html.dshpc-on .dshpc-wc button.dshpc-wc-close:hover{background:#e81123;color:#fff}
html.dshpc-on .dshpc-wc svg{display:block}
`;

  function ensureStyle() {
    if (!document.getElementById('dshpc-css')) {
      const st = document.createElement('style');
      st.id = 'dshpc-css';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    document.documentElement.classList.add('dshpc-on');
  }
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

  // ------------------------------------------- frameless window chrome + drag
  const WC_SVG = {
    min: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M3 8h10"/></svg>',
    max: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1"/></svg>',
    restore: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6.4 3.4h6.2v6.2"/><path d="M9.6 12.6H3.4V6.4"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
  };
  function ensureChatWinControls() {
    if (S.wc) return;
    const wc = h('div', 'dshpc-wc');
    const mk = (kind, label) => {
      const b = h('button', 'dshpc-wc-btn dshpc-wc-' + kind);
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = WC_SVG[kind];
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          ipcRenderer.send('dshp:win-' + (kind === 'max' ? 'max-toggle' : kind));
        } catch {}
      });
      wc.appendChild(b);
      return b;
    };
    mk('min', '最小化');
    const bMax = mk('max', '最大化 / 还原');
    mk('close', '关闭');
    document.body.appendChild(wc);
    S.wc = { cluster: wc, bMax };
    let lastMax = null;
    const onMax = (_e, s) => {
      const max = !!(s && s.max);
      if (max === lastMax) return;
      lastMax = max;
      bMax.title = max ? '还原' : '最大化';
      bMax.setAttribute('aria-label', bMax.title);
      bMax.innerHTML = max ? WC_SVG.restore : WC_SVG.max;
    };
    ipcRenderer.on('dshp:win-max-state', onMax);
    ipcRenderer.send('dshp:win-max-query');
  }
  // 系统原生拖拽顶条 + 会话栏右侧的内容区拖拽块（见 console-preload.js 同款说明）
  function ensureDragBars() {
    if (!document.getElementById('dshpc-dragbar')) {
      const bar = h('div', 'dshpc-dragbar');
      bar.id = 'dshpc-dragbar';
      document.body.appendChild(bar);
    }
    if (!document.getElementById('dshpc-dragzone')) {
      const zone = h('div', 'dshpc-dragzone');
      zone.id = 'dshpc-dragzone';
      document.body.appendChild(zone);
    }
  }
  // 顶部 58px 内自动生成“自由空白”原生拖拽块（避开聊天页按钮/输入框）
  function updateDragZone() {
    try {
      const zone = document.getElementById('dshpc-dragzone');
      if (!zone) return;
      const BAND_H = 58;
      const MIN_W = 60;
      const rightCap = window.innerWidth - 150;
      const blockers = [];
      for (const el of document.querySelectorAll('button, [role="button"], a, input, textarea, select, [contenteditable="true"]')) {
        if (!el.isConnected) continue;
        if (el.classList && (el.classList.contains('dshpc-back') || el.classList.contains('dshpc-wc-btn'))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        if (r.bottom <= 2 || r.top >= BAND_H) continue;
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
        if (!blockers.some((b) => b.right > l + 3 && b.left < r - 3)) pieces.push({ left: l + 1, right: r - 1 });
      }
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

  // theme-matched neutral icon colour (page has no CSS vars; never borrow the
  // site's accent colour — the user wants the same neutral look as Harness).
  // The site <body> can lie (white body + purple text while panels paint their
  // own surface), so sample a real painted site surface away from our overlays.
  function siteLum() {
    try {
      const probes = [
        [Math.min(24, innerWidth - 20), Math.min(220, innerHeight - 30)],
        [Math.min(200, innerWidth - 20), Math.min(260, innerHeight - 30)],
        [Math.min(60, innerWidth - 20), Math.min(30, innerHeight - 30)]
      ];
      for (const [px, py] of probes) {
        if (px < 0 || py < 0) continue;
        let el = document.elementFromPoint(px, py);
        for (let i = 0; i < 14 && el; i++) {
          if (el.classList && (el.classList.contains('dshpc-back') || el.classList.contains('dshpc-wc') || el.id === 'dshpc-dragbar')) {
            el = el.parentElement;
            continue;
          }
          const bg = getComputedStyle(el).backgroundColor;
          const m = String(bg).match(/rgba?\(([^)]+)\)/);
          if (m) {
            const p = m[1].split(',').map((s) => parseFloat(s.trim()));
            const alpha = p.length > 3 ? p[3] : 1;
            if (alpha > 0.2 && !(p[0] === 0 && p[1] === 0 && p[2] === 0)) {
              return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255;
            }
          }
          el = el.parentElement;
        }
      }
      return 1; // unknown → assume light surface (dark icons)
    } catch {
      return 1;
    }
  }
  const NEUTRAL_DARK = '#e6eaf3';
  const NEUTRAL_LIGHT = '#24282f';
  function neutralFor() {
    const lum = siteLum();
    return lum !== null && lum < 0.55 ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  }
  function syncNeutralColors() {
    try {
      const col = neutralFor();
      const back = S.back;
      if (back && back.dataset.dshpCol !== col) {
        back.dataset.dshpCol = col;
        back.style.color = col;
      }
      const wc = S.wc && S.wc.cluster;
      if (wc && wc.dataset.dshpCol !== col) {
        wc.dataset.dshpCol = col;
        wc.style.color = col;
      }
    } catch {}
  }

  // keep the page's own top-right controls clear of the cluster
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
      for (const el of document.querySelectorAll('button, [role="button"], a, [tabindex], input, textarea, select, [contenteditable="true"]')) {
        if (n++ > 60) break;
        if (!el.isConnected) continue;
        if (el.classList && (el.classList.contains('dshpc-wc-btn') || el.classList.contains('dshpc-dragbar'))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (r.top > 60 || r.bottom < 8) continue;
        if (r.right <= zoneLeft + 4 || r.right > vw + 2) continue;
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

  // ----------------------------------------------- “切换”小图标
  function svgSwitch() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '17');
    svg.setAttribute('height', '17');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const d = 'M7 7h10M7 7l3-3M7 7l3 3M17 17H7M17 17l-3-3M17 17l-3 3';
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }
  function makeBackButton() {
    const btn = h('button', 'dshpc-back');
    btn.type = 'button';
    btn.setAttribute('aria-label', '切换：返回 DeepSeek Harness');
    btn.title = '切换：返回 DeepSeek Harness（或按 Alt+1 来回切换）';
    btn.appendChild(svgSwitch());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        ipcRenderer.send('dshp:chat-off');
      } catch {}
    });
    return btn;
  }

  // -------------------------------------------------- 底部/右下角 缩放把手
  function ensureResizeHandles() {
    if (S.rs) return;
    const mk = (cls, dir) => {
      const hEl = h('div', 'dshpc-rs ' + cls);
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
    const wrap = h('div', 'dshpc-rs');
    S.rs = wrap;
    wrap.appendChild(mk('dshpc-rs-bottom', 'v'));
    wrap.appendChild(mk('dshpc-rs-br', 'd'));
    document.body.appendChild(wrap);
  }

  // ---- 聊天页侧栏收起按钮定位
  // 展开态：会话栏（x0..railRight）顶部右侧那一排小图标，取最右一个为“收起侧边栏”
  // 收起态：左上角出现的 34px 大图标中的第一个为“打开侧边栏”
  function railRightEdge() {
    try {
      // 会话列表所在栏：任一可见的日期/会话行的共同祖先栏，取最右
      const cands = [...document.querySelectorAll('button,[role="button"],div')].filter((el) => {
        const tx = (el.textContent || '').trim();
        if (!tx) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 14 || r.height > 60) return false;
        if (r.left > 300 || r.top < 60 || r.top > 1000) return false;
        return /^[\s\d]*今天|^[\s\d]*昨天|^[\s\d]*天内|昨天|今天/.test(tx.slice(0, 8)) || tx.length > 8;
      });
      let best = null;
      for (const c of cands) {
        let el = c;
        for (let i = 0; i < 6 && el; i++) {
          const r = el.getBoundingClientRect();
          if (r.width > 140 && r.width < 620 && r.height > 400 && el === c) break;
          el = el.parentElement;
        }
        const r = c.getBoundingClientRect();
        if (!best || r.right > best.right) best = { right: r.right, top: r.top, left: r.left };
      }
      // 直接找：左边缘开始、宽 200~700 的高容器里最靠左的可点图标行
      const container = [...document.querySelectorAll('div')].find((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.left < 5 && r.width >= 200 && r.width <= 700 && r.height > 500 && r.top < 20;
      });
      if (container) return container.getBoundingClientRect().right;
      return best ? best.right : 0;
    } catch {
      return 0;
    }
  }
  function chatAnchorIcon() {
    try {
      const railRight = railRightEdge();
      const isOurs = (b) => b.classList && (b.classList.contains('dshpc-back') || b.classList.contains('dshpc-wc-btn') || b.id === 'dshpc-dragbar');
      // 展开态：rail 顶部 y<60 且 x 在 rail 右半区的小图标按钮，取最右
      if (railRight > 150) {
        const icons = [...document.querySelectorAll('button,[role="button"]')]
          .filter((b) => {
            if (isOurs(b)) return false;
            const r = b.getBoundingClientRect();
            return r.width >= 12 && r.width <= 40 && r.height >= 12 && r.height <= 40 && r.top >= 8 && r.top < 60 && r.left >= railRight - 120 && r.right <= railRight + 2;
          })
          .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        if (icons.length) return icons[0];
      }
      // 收起态：左上角 34px 图标行第一个
      const wide = [...document.querySelectorAll('button,[role="button"]')]
        .filter((b) => {
          if (isOurs(b)) return false;
          const r = b.getBoundingClientRect();
          return r.width >= 26 && r.width <= 44 && r.height >= 26 && r.height <= 44 && r.top >= 4 && r.top < 60 && r.left < 200;
        })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      if (wide.length) return wide[0];
      return null;
    } catch {
      return null;
    }
  }

  // 兜底位：无侧栏可挂（登录页/加载页/异常页）时，固定显示在左下角
  function placeBackFallback(back, CW, CH) {
    try {
      back.style.left = '14px';
      back.style.top = Math.max(14, Math.round(window.innerHeight - CH - 72)) + 'px';
      back.style.width = CW + 'px';
      back.style.height = CH + 'px';
      back.hidden = false;
      return true;
    } catch {
      return false;
    }
  }

  function positionBackChip() {
    const back = S.back;
    if (!back) return false;
    const CW = 28;
    const CH = 22;
    const anchor = chatAnchorIcon();
    if (!anchor) {
      // 未登录 / 侧栏不存在：仍要保证能一键返回 Harness
      return placeBackFallback(back, CW, CH);
    }
    const ar = anchor.getBoundingClientRect();
    let left = Math.round(ar.left + ar.width / 2 - CW / 2);
    let top = Math.round(ar.bottom + 3);
    left = Math.max(6, Math.min(left, window.innerWidth - CW - 150));
    top = Math.max(6, Math.min(top, window.innerHeight - CH - 40));
    back.style.left = left + 'px';
    back.style.top = top + 'px';
    back.style.width = CW + 'px';
    back.style.height = CH + 'px';
    back.hidden = false;
    return true;
  }

  function ensureBackButton() {
    try {
      if (!S.back) {
        S.back = makeBackButton();
        document.body.appendChild(S.back);
      }
      syncNeutralColors();
      positionBackChip();
    } catch {}
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    if (!document.body) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
      else setTimeout(boot, 100);
      return;
    }
    ensureStyle();
    ensureDragBars();
    ensureResizeHandles();
    ensureChatWinControls();
    ensureBackButton();

    const observer = new MutationObserver(
      debounce(() => {
        ensureBackButton();
        updateDragZone();
      }, 250)
    );
    observer.observe(document.body, { childList: true, subtree: true });

    const sweep = () => {
      try {
        ensureBackButton();
        updateDragZone();
        syncNeutralColors();
        shiftTopRight();
      } catch {}
    };
    setInterval(() => {
      if (document.hidden) return; // 窗口隐藏/最小化时不空转做布局扫描
      sweep();
    }, 900);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sweep();
    });
    window.addEventListener('resize', debounce(() => {
      shiftTopRight();
      updateDragZone();
    }, 200));
  }

  boot();
})();
