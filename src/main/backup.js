/* ============================================================
   備份（見 開發筆記 D097）：把整個紀錄資料夾壓成一個 zip（deflate 壓縮），回傳位元組；存到哪由 main.js 問使用者。
   不裝套件：zip 用 shared/zip.js 組（跟匯出 Excel 共用，D189），壓縮、CRC 用 Node 內建的 zlib。
   檔名是 UTF-8（旗標 0x0800），檔案時間照每個檔的修改時間（解開來修改時間還在）。
   只放檔案、不放資料夾項目：空的資料夾不會進備份
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { zip } = require('../shared/zip.js');

/* dir 底下全部的檔（含子資料夾）壓成一個 zip，回傳 Buffer；zip 裡的路徑是相對 dir、用 / 隔開。讀一個檔壓一個 */
function zipDir(dir) {
  const files = fs.readdirSync(dir, { recursive: true }).map(String)
    .filter(f => fs.statSync(path.join(dir, f)).isFile());
  return zip((function* () {
    for (const f of files) {
      const full = path.join(dir, f);
      yield { name: f.split(path.sep).join('/'), data: fs.readFileSync(full), deflate: true, mtime: fs.statSync(full).mtime };
    }
  })());
}

module.exports = { zipDir };
