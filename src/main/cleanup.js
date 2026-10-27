/* ============================================================
   可攜版留下的解壓資料夾（見 開發筆記 D050）：啟動時清掉
   可攜版每次開都解壓到 %TEMP%\<27 碼英數>（electron-builder 打包時隨機產生，每一版不同），
   正常關掉啟動器會刪；當掉、被強制結束就留下來（約幾百 MB），別的版本的啟動器也不會去刪。
   fs 由呼叫端給：Electron 主程序要給 original-fs（一般的 fs 會把 app.asar 當資料夾，刪不乾淨），測試給 node 的 fs
   ============================================================ */
'use strict';
const path = require('path');

const NAME_RE = /^[0-9A-Za-z]{27}$/;   // electron-builder 的 generateKsuid：27 碼 base62
const EXE = 'daybook.exe';

/* 認得出是 daybook 的解壓資料夾：名稱是 27 碼英數、裡面有 daybook.exe 和 resources\app.asar */
function isLeftover(fs, dir) {
  return fs.existsSync(path.join(dir, EXE)) && fs.existsSync(path.join(dir, 'resources', 'app.asar'));
}

/* 有 daybook 正從這個資料夾跑著嗎：跑著的 exe 用寫入模式打不開（EBUSY，2026-10-27 實測）；打開不會改到檔案 */
function inUse(fs, dir) {
  try { fs.closeSync(fs.openSync(path.join(dir, EXE), 'r+')); return false; } catch { return true; }
}

/* tempDir 底下的殘留都刪掉；ownDir（正在跑的這一份）、正在用的跳過。
   daybook.exe 最後才刪：中途刪不動（被防毒軟體鎖住之類），exe 還在，下次還認得出來再清。
   回傳刪掉的資料夾名稱；出錯不丟出去（清不掉就算了，不能擋住程式啟動） */
function cleanPortableLeftovers(tempDir, ownDir, fs) {
  const own = ownDir ? path.resolve(ownDir).toLowerCase() : null;
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(tempDir); } catch { return removed; }
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const dir = path.join(tempDir, name);
    try {
      if (path.resolve(dir).toLowerCase() === own || !isLeftover(fs, dir) || inUse(fs, dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f !== EXE) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch { /* 這個清不掉，換下一個 */ }
  }
  return removed;
}

module.exports = { cleanPortableLeftovers };
