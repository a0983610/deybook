/* 畫面第一次畫出來之前就要套上的設定（放在 <head>，不會先閃一下別的樣子）。都記在這台電腦：
   - 亮／暗（見 開發筆記 D034）：沒切過就不設，跟 Windows 設定走
   - 縮放（見 開發筆記 D042）：上次調的比例 */
'use strict';
try {
  const t = localStorage.getItem('daybook.theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch { /* 讀不到就跟系統 */ }
try {
  const z = Number(localStorage.getItem('daybook.zoom'));
  if (z > 0 && z !== 1) window.daybook.setZoom(z);
} catch { /* 讀不到就 100% */ }
