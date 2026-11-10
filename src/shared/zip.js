/* ============================================================
   組 zip（見 開發筆記 D078、D097、D189）：匯出 Excel（formats/xlsx.js，只存、時間固定）、備份（main/backup.js，壓縮、照檔案時間）共用這一支。
   不裝套件：檔頭、中央目錄自己組，壓縮、CRC 用 Node 內建的 zlib。純函式、不碰檔案。
   files：[{ name, data, deflate, mtime }]，也可以一個一個給（generator：備份讀一個檔壓一個，不必整個資料夾一起放在記憶體）
   - name：zip 裡的路徑（/ 隔開），一律寫 UTF-8（旗標 0x0800）
   - data：檔案內容（Uint8Array／Buffer）
   - deflate：true 壓縮（方法 8），不給只存（方法 0）
   - mtime：檔案時間（Date，本地時間、秒只準到 2 秒；1980 年以前寫 1980-01-01）；不給寫 1980-01-01——同樣的內容組出來一個 byte 都不差（xlsx 要）
   回 Buffer。只放檔案、不放資料夾項目；不用 zip64（超過 65535 個檔或 4GB，writeUInt16LE／writeUInt32LE 會丟錯，不會寫出壞掉的檔）
   ============================================================ */
'use strict';
const zlib = require('zlib');

const DOS_1980 = { date: 0x21, time: 0 };   // 1980-01-01 00:00:00

/* 檔案時間 → zip 用的 DOS 日期、時間 */
function dosTime(d) {
  if (!d || d.getFullYear() < 1980) return DOS_1980;
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

function zip(files) {
  const parts = [], central = [];
  let offset = 0, count = 0;
  for (const f of files) {
    count++;
    const raw = f.data;
    const data = f.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const crc = zlib.crc32(raw);
    const { date, time } = dosTime(f.mtime);
    const nm = Buffer.from(f.name, 'utf8');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);   // 本地檔頭
    loc.writeUInt16LE(20, 4);           // 解開要的版本 2.0
    loc.writeUInt16LE(0x0800, 6);       // 檔名是 UTF-8
    loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(time, 10);
    loc.writeUInt16LE(date, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(nm.length, 26);
    parts.push(loc, nm, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);    // 中央目錄
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nm.length, 28);
    cd.writeUInt32LE(offset, 42);       // 本地檔頭在哪
    central.push(cd, nm);
    offset += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

module.exports = { zip };
