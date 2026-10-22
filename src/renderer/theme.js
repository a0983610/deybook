/* 亮／暗（見 開發筆記 D034）：放在 <head>，畫面第一次畫出來之前就套上，不會先閃一下亮的。
   記在這台電腦；沒切過就不設，跟 Windows 設定走 */
'use strict';
try {
  const t = localStorage.getItem('daybook.theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch { /* 讀不到就跟系統 */ }
