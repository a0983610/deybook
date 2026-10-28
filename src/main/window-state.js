/* ============================================================
   視窗大小、位置、最大化（見 開發筆記 D082）：關掉時記在設定檔，下次照著開
   記的位置現在看不到（那個螢幕拔掉了、解析度變小了）就不用，照預設開
   ============================================================ */
'use strict';

const TITLE_H = 30;   // 標題列大約多高
const GRAB_W = 100;   // 標題列至少要有這麼寬、一半高露在某個螢幕的工作區裡，才算拖得回來

/* 設定檔記的 window → { bounds, maximized }：bounds 是給 BrowserWindow 的 x、y、width、height，用不了是 null。
   areas 是每個螢幕的工作區（screen.getAllDisplays() 的 workArea） */
function restore(saved, areas) {
  if (!saved || typeof saved !== 'object') return { bounds: null, maximized: false };
  const { x, y, width, height } = saved;
  const ok = [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    && areas.some(a => Math.min(x + width, a.x + a.width) - Math.max(x, a.x) >= GRAB_W
      && Math.min(y + TITLE_H, a.y + a.height) - Math.max(y, a.y) >= TITLE_H / 2);
  return { bounds: ok ? { x, y, width, height } : null, maximized: saved.maximized === true };
}

module.exports = { restore };
