'use strict';
(() => {
  const api = window.dsh;
  if (!api) return;

  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  const panel = document.getElementById('status-panel');

  api.onServerStatus((s) => {
    if (s.phase === 'ready') return;
    panel.classList.add('visible');
    statusText.textContent = s.message || '';
    statusDetail.textContent = s.detail || '';
    if (s.phase === 'error') {
      document.getElementById('spinner').style.display = 'none';
    }
  });

  api.onServerReady((info) => {
    statusText.textContent = info.adopted ? '已连接运行中的服务…' : '服务就绪，正在载入…';
    statusDetail.textContent = '';
  });
})();
