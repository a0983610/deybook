/* ============================================================
   記事本（見 開發筆記 D102）：資料夾的 記事本\ 裡一份一個 .txt，檔名就是名稱。
   可以開資料夾（D116）：一份記事、一個資料夾都用「記事本\ 底下的相對路徑」認，/ 隔開、記事不帶 .txt
   （例：工作/週會）；最上層的就是名稱本身，跟原本一樣。
   這裡只放名稱、路徑的規則，純函式、不碰檔案；讀寫檔在 main.js。
   ============================================================ */
'use strict';
const { L } = require('./i18n.js');

const EXT = '.txt';
const SEP = '/';
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
  if (!n) throw new Error(L('名稱不能空白'));
  if (n.length > MAX_LEN) throw new Error(L('名稱太長（最多 {max} 個字）', { max: MAX_LEN }));
  if (BAD_CHARS.test(n)) throw new Error(L('名稱不能有這些字：< > : " / \\ | ? *'));
  if (n.endsWith('.')) throw new Error(L('名稱不能用「.」結尾'));
  if (RESERVED.test(n)) throw new Error(L('「{name}」是 Windows 保留的名稱，換一個', { name: n }));
  if (others.some(o => o.toLowerCase() === n.toLowerCase())) throw new Error(L('已經有一份叫「{name}」了', { name: n }));
  return n;
}

/* 新增時的名稱：「新記事 N」，N 從 1 開始找沒用過的（不分大小寫）。
   名稱跟著介面語言（D131）：找號碼跟產生用同一個模板，換了語言就從新的名稱算（舊語言的「新記事 1」不同名，不會撞） */
function newName(names) {
  const used = new Set(names.map(n => n.toLowerCase()));
  const nth = n => L('新記事 {n}', { n });
  let i = 1;
  while (used.has(nth(i).toLowerCase())) i++;
  return nth(i);
}

/* 相對路徑（D116）：在哪個資料夾（'' 是最上層）、最後一段的名稱、接起來 */
const parentOf = rel => { const i = rel.lastIndexOf(SEP); return i < 0 ? '' : rel.slice(0, i); };
const baseOf = rel => rel.slice(rel.lastIndexOf(SEP) + 1);
const joinRel = (dir, name) => (dir ? dir + SEP + name : name);
/* a 是不是 b 自己、或在 b 底下（不分大小寫，Windows 的路徑不分） */
const within = (a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x === y || x.startsWith(y + SEP); };

/* 畫面傳來、檔案系統上還沒有的相對路徑（要建的資料夾）：每一段都要是能用的名稱，而且不能靠去掉頭尾空白才變得能用。
   checkName 擋掉 \ : 和「.」結尾，所以 . 和 .. 也進不來，指不到 記事本\ 外面。'' 是最上層 */
function checkPath(rel) {
  const s = String(rel == null ? '' : rel);
  if (!s) return '';
  for (const p of s.split(SEP)) if (checkName(p) !== p) throw new Error(L('「{name}」不能用', { name: s }));
  return s;
}

/* 讀檔：UTF-8（有沒有 BOM 都可以）；開頭是 FF FE 的當 UTF-16（舊的 Windows 記事本存「Unicode」是這種）。
   換行一律變 \n（D018），畫面的文字框本來就只有 \n。
   strict（記事本用，見 開發筆記 D139）：不是 UTF-8 的（Big5、ANSI 存的）回 null——硬讀會變亂碼，記事本一存原檔就毀了；
   文件檢視只看不改，照舊硬讀 */
function decode(buf, strict) {
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le', 2);
  else if (!strict) text = buf.toString('utf8').replace(/^﻿/, '');
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }   // BOM TextDecoder 自己會拿掉
  }
  return text.replace(/\r\n?/g, '\n');
}

module.exports = { EXT, nameOf, checkName, newName, parentOf, baseOf, joinRel, within, checkPath, decode };
