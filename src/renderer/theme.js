/* 畫面第一次畫出來之前就要套上的設定（放在 <head>，不會先閃一下別的樣子）。都記在這台電腦：
   - 亮／暗（見 開發筆記 D034）：沒切過就不設，跟 Windows 設定走
   - 縮放（見 開發筆記 D042）：上次調的比例
   - 左欄寬度（見 開發筆記 D074）：上次拉的寬度；之後拉、點兩下還原由 app.js 的 applySide 改
   - 左欄收起來（見 開發筆記 D083）：點頁籤列的「日記本」收起來的；之後由 app.js 的 setSideOff 改
   - 左欄放哪一個（見 開發筆記 D093）：日記本或剪貼簿；之後由 app.js 的 showSide 改
   - 中間是不是記事本（見 開發筆記 D102）、MD 檢視（D118）：之後由 app.js 的 setNoteMode、setMdMode 改
   - 字型、內容字的大小（見 開發筆記 D113）：之後由 app.js 的 setFont 改，套上都叫這裡的 applyFont */
'use strict';
/* 字型（D113）：f 是 { ui, mono, size }——介面、內容的字型名稱，內容字的大小（px）；沒有的照 style.css 的預設。
   選的字型沒有中文字時，中文照舊用微軟正黑體。FONT_SIZE 要跟 style.css 的 --fs 一樣 */
const FONT_SIZE = 14, FONT_MIN = 10, FONT_MAX = 24;
const cssFont = name => `"${name.replace(/["\\]/g, '\\$&')}"`;
function applyFont(f) {
  const s = document.documentElement.style;
  const stack = (name, last) => `${cssFont(name)}, "Microsoft JhengHei UI", "Microsoft JhengHei", ${last}`;
  const size = Number(f.size);
  if (size >= FONT_MIN && size <= FONT_MAX) s.setProperty('--fs', `${size}px`); else s.removeProperty('--fs');
  if (typeof f.ui === 'string' && f.ui) s.setProperty('--ui-font', stack(f.ui, 'sans-serif')); else s.removeProperty('--ui-font');
  if (typeof f.mono === 'string' && f.mono) s.setProperty('--mono', stack(f.mono, 'monospace')); else s.removeProperty('--mono');
}
try {
  applyFont(JSON.parse(localStorage.getItem('daybook.font')) || {});
} catch { /* 讀不到就照預設 */ }
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
try {
  const v = localStorage.getItem('daybook.view');
  if (v === 'note' || v === 'md') document.documentElement.dataset.view = v;
} catch { /* 讀不到就日記 */ }
