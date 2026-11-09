/* ============================================================
   設定檔 settings.json（正式在 %APPDATA%\daybook，見 開發筆記 D016、D041）：讀寫一律走這裡（D176）。
   - 開頭的 BOM 拿掉（記事本存的會帶）；讀不懂（手改壞了）就把壞檔改名成 settings.json.bad-日期時間、畫面提示一次，
     這次當作沒設定——不然之後寫任何一項設定（最晚是關視窗記大小）都會拿 {} 把整份蓋掉。改名失敗就照舊當作沒設定（D137）
   - 有 --data-dir 時不讀寫設定檔（D016）：get／set 只記在記憶體，關掉就沒了
   ============================================================ */
'use strict';
const fs = require('fs');

/* 讀不懂的檔改名成 檔名.bad-日期時間 留著（設定檔 D137、記事本的暫存 D175）：回改成的名稱，改名失敗回 null */
function keepBad(file) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const bad = `${file}.bad-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  try { fs.renameSync(file, bad); return bad; } catch { return null; }   // 改不了名就算了
}

/* file()：設定檔的完整路徑（userData 啟動時才定，所以給函式）；dev：有 --data-dir；write(file, text)：先寫暫存檔再改名 */
function createSettings({ file, dev, write }) {
  const mem = {};      // --data-dir 時的設定
  let bad = null;      // 壞檔改成的名稱，交給畫面提示一次就清掉（takeBad）
  /* 整份（正式的設定檔；--data-dir 時不讀） */
  function read() {
    let text;
    try { text = fs.readFileSync(file(), 'utf8'); } catch { return {}; }   // 還沒有設定檔
    try { return JSON.parse(text.replace(/^﻿/, '')); } catch { /* 下面另存 */ }
    bad = keepBad(file()) || bad;
    return {};
  }
  return {
    read,
    /* 一項設定（沒有是 undefined，預設值由叫的地方給） */
    get: key => (dev ? mem[key] : read()[key]),
    /* 改一項：其他項照原本的寫回去 */
    set(key, value) {
      if (dev) mem[key] = value;
      else write(file(), JSON.stringify({ ...read(), [key]: value }, null, 2));
    },
    takeBad() { const b = bad; bad = null; return b; },
  };
}

module.exports = { createSettings, keepBad };
