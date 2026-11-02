/* ============================================================
   截圖（見 開發筆記 D129）：取代 Windows 剪取工具。截好的存在截圖資料夾（不在紀錄資料夾裡，設定檔記位置），
   檔名是編號（639.png）；要留下來的取名搬進 保留\。
   這裡只放編號、日期、路徑的規則，純函式、不碰檔案；讀寫檔在 main.js，框選、畫框箭頭在 main/shot.js、renderer/capture.js。
   ============================================================ */
'use strict';

const KEEP_DIR = '保留';
const NUM_RE = /^(\d{1,9})\.png$/i;   // 編號的截圖：只認資料夾最上層、純數字的 .png（使用者原本手打的 400.png～638.png 也是這樣）

/* 檔名 → 編號；不是編號的回 null */
function numOf(file) {
  const m = NUM_RE.exec(String(file));
  return m ? Number(m[1]) : null;
}

/* 下一號：資料夾裡最大的號、記著用過的最大號（清掉了也不重用），比較大的那個 +1 */
function nextNo(files, last) {
  let max = Number.isInteger(last) && last > 0 ? last : 0;
  for (const f of files) {
    const n = numOf(f);
    if (n != null && n > max) max = n;
  }
  return max + 1;
}

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/* 修改時間 → 那一天（這台電腦的時區），畫面照這個分段、「清掉 N 天前的」照這個算 */
const dayOf = ms => iso(new Date(ms));

/* 「清掉 N 天前的」：today 往前 N 天那天（含）以前的都算。1 是今天以外全部、0 是全部 */
function cutoffDay(today, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 0 || n > 3650) throw new Error('天數要填 0～3650 的整數');
  const [y, m, d] = String(today).split('-').map(Number);
  return iso(new Date(y, m - 1, d - n));
}

/* 畫面、縮圖網址傳來的相對路徑（/ 隔開）：最上層的編號截圖，或 保留\ 裡的 .png（只有一層）。
   不是這兩種回 null——不能拿來指到截圖資料夾外面、或裡面別的檔 */
function checkRel(rel) {
  const parts = String(rel == null ? '' : rel).split('/');
  if (parts.length === 1 && numOf(parts[0]) != null) return parts;
  if (parts.length === 2 && parts[0] === KEEP_DIR && /^[^<>:"/\\|?*\x00-\x1f]+\.png$/i.test(parts[1]) && !/^\.+\.png$/i.test(parts[1])) return parts;
  return null;
}

module.exports = { KEEP_DIR, numOf, nextNo, dayOf, cutoffDay, checkRel };
