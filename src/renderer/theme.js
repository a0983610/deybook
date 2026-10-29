/* 畫面第一次畫出來之前就要套上的設定（放在 <head>，不會先閃一下別的樣子）。都記在這台電腦：
   - 亮／暗（見 開發筆記 D034）：沒切過就不設，跟 Windows 設定走
   - 縮放（見 開發筆記 D042）：上次調的比例
   - 左欄寬度（見 開發筆記 D074）：上次拉的寬度；之後拉、點兩下還原由 app.js 的 applySide 改
   - 左欄收起來（見 開發筆記 D083）：點頁籤列的「日記本」收起來的；之後由 app.js 的 setSideOff 改
   - 左欄放哪一個（見 開發筆記 D093）：日記本或剪貼簿；之後由 app.js 的 showSide 改 */
'use strict';
try {
  const t = localStorage.getItem('daybook.theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch { /* 讀不到就跟系統 */ }
try {
  const z = Number(localStorage.getItem('daybook.zoom'));
  if (z > 0 && z !== 1) {
    window.daybook.setZoom(z);
    document.documentElement.style.setProperty('--zoom', String(z));   // 標題列照這個縮回去（D100）
  }
} catch { /* 讀不到就 100% */ }
try {
  const w = Number(JSON.parse(localStorage.getItem('daybook.sizes'))?.side);
  if (w > 0) document.documentElement.style.setProperty('--side-w', `${w}px`);
} catch { /* 讀不到就 180px */ }
try {
  if (localStorage.getItem('daybook.sideOff') === '1') document.documentElement.dataset.side = 'off';
} catch { /* 讀不到就打開 */ }
try {
  if (localStorage.getItem('daybook.sideView') === 'snip') document.documentElement.dataset.sideView = 'snip';
} catch { /* 讀不到就日記本 */ }
