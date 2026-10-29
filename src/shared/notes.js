/* ============================================================
   記事本（見 開發筆記 D102）：資料夾的 記事本\ 裡一份一個 .txt，檔名就是名稱。
   這裡只放名稱的規則，純函式、不碰檔案；讀寫檔在 main.js。
   ============================================================ */
'use strict';

const EXT = '.txt';
const NEW_PREFIX = '新記事 ';   // 新增時的預設名稱：新記事 1、新記事 2…
const MAX_LEN = 100;
// Windows 檔名不能用的字、控制字元；保留的裝置名（加副檔名也不行，CON.txt 一樣不能用）
const BAD_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/* 檔名 → 名稱：只認 .txt（大小寫都算），其他的回 null */
function nameOf(file) {
  return file.toLowerCase().endsWith(EXT) && file.length > EXT.length ? file.slice(0, -EXT.length) : null;
}

/* 改名、新增前檢查：頭尾空白去掉（不算名稱的一部分）；不行就丟錯，錯誤訊息直接給畫面顯示。
   others 是其他份的名稱，同名不分大小寫（Windows 的檔名不分） */
function checkName(name, others = []) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw new Error('名稱不能空白');
  if (n.length > MAX_LEN) throw new Error(`名稱太長（最多 ${MAX_LEN} 個字）`);
  if (BAD_CHARS.test(n)) throw new Error('名稱不能有這些字：< > : " / \\ | ? *');
  if (n.endsWith('.')) throw new Error('名稱不能用「.」結尾');
  if (RESERVED.test(n)) throw new Error(`「${n}」是 Windows 保留的名稱，換一個`);
  if (others.some(o => o.toLowerCase() === n.toLowerCase())) throw new Error(`已經有一份叫「${n}」了`);
  return n;
}

/* 新增時的名稱：「新記事 N」，N 從 1 開始找沒用過的（不分大小寫） */
function newName(names) {
  const used = new Set(names.map(n => n.toLowerCase()));
  let i = 1;
  while (used.has((NEW_PREFIX + i).toLowerCase())) i++;
  return NEW_PREFIX + i;
}

/* 讀檔：UTF-8（有沒有 BOM 都可以）；開頭是 FF FE 的當 UTF-16（舊的 Windows 記事本存「Unicode」是這種）。
   換行一律變 \n（D018），畫面的文字框本來就只有 \n */
function decode(buf) {
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le', 2) : buf.toString('utf8').replace(/^﻿/, '');
  return text.replace(/\r\n?/g, '\n');
}

module.exports = { EXT, nameOf, checkName, newName, decode };
