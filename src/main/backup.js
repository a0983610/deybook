/* ============================================================
   備份（見 開發筆記 D097）：把整個紀錄資料夾壓成一個 zip（deflate 壓縮），回傳位元組；存到哪由 main.js 問使用者。
   不裝套件：zip 自己組（同 xlsx.js 的做法，D078），壓縮、CRC 用 Node 內建的 zlib。
   檔名是 UTF-8（旗標 0x0800），檔案時間照每個檔的修改時間（解開來修改時間還在）。
   只放檔案、不放資料夾項目：空的資料夾不會進備份
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* 修改時間 → zip 用的 DOS 日期、時間（本地時間、秒只準到 2 秒；1980 年以前寫 1980-01-01） */
function dosTime(d) {
  if (d.getFullYear() < 1980) return { date: 0x21, time: 0 };
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/* dir 底下全部的檔（含子資料夾）壓成一個 zip，回傳 Buffer；zip 裡的路徑是相對 dir、用 / 隔開 */
function zipDir(dir) {
  const files = fs.readdirSync(dir, { recursive: true }).map(String)
    .filter(f => fs.statSync(path.join(dir, f)).isFile());
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    const raw = fs.readFileSync(full);
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const { date, time } = dosTime(fs.statSync(full).mtime);
    const nm = Buffer.from(f.split(path.sep).join('/'), 'utf8');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);   // 本地檔頭
    loc.writeUInt16LE(20, 4);           // 解開要的版本 2.0
    loc.writeUInt16LE(0x0800, 6);       // 檔名是 UTF-8
    loc.writeUInt16LE(8, 8);            // 方法 8＝deflate
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
    cd.writeUInt16LE(8, 10);
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
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

module.exports = { zipDir };
