/* ============================================================
   暫存（見 開發筆記 D093）：對 暫存.md 的文字做加／改／刪一筆，純函式、不碰檔案。
   寫法照紀錄：沒縮排的行是標題，Tab 縮排的行是內文（點卡片複製的就是內文）。
   跟紀錄不一樣的地方——內文要原封不動複製出去，所以不沿用 parser.js：
   - 標題整行就是標題，行尾的 [待回覆]、^編號 這些不拆；連續兩行標題各是一筆
   - 內文中間的空行留著（寫成只有一個 Tab 的行）
   每個改動都帶 index（第幾筆）和 expected（那一筆原本的原文），對不上就報錯不寫（同 entries.js）。
   ============================================================ */
'use strict';
const { Conflict } = require('./entries.js');

/* 一行一行讀：Tab（或空白）開頭是內文，去掉一層縮排（Tab 或最多 4 個空白，同 entries.js）；
   空行先記著，後面還有同一筆的內文才算內文裡的空行；第一個標題前面的內文掛在一筆沒標題的上面，不丟 */
function parse(lines) {
  const out = [];
  let cur = null, blanks = 0;
  lines.forEach((text, line) => {
    if (text === '') { blanks++; return; }
    if (/^[\t ]/.test(text)) {
      if (!cur) { cur = { title: '', body: [], start: line, end: line }; out.push(cur); }
      else if (cur.body.length) for (; blanks; blanks--) cur.body.push('');
      cur.body.push(text.replace(/^(\t| {1,4})/, ''));
      cur.end = line;
    } else {
      cur = { title: text.trim(), body: [], start: line, end: line };
      out.push(cur);
    }
    blanks = 0;
  });
  return out;
}

const rawOf = (lines, s) => lines.slice(s.start, s.end + 1).join('\n');

/* 每一筆給畫面用的樣子：原文（之後改動時當 expected）、標題、內文（一行一個） */
function listSnips(text) {
  const lines = text.split(/\r?\n/);
  return parse(lines).map((s, index) => ({ index, raw: rawOf(lines, s), title: s.title, body: s.body }));
}

/* 一筆 → 行。標題只能一行；內文頭尾的空行、結尾的空白拿掉，中間的空行寫成只有 Tab */
function formatSnip(snip) {
  const title = String(snip.title || '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) throw new Error('標題不能空白');
  const body = String(snip.body || '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  if (!body) throw new Error('內文不能空白（要複製的就是內文）');
  return [title, ...body.split('\n').map(l => '\t' + l)];
}

function locate(text, index, expected) {
  const lines = text.split(/\r?\n/);
  const s = parse(lines)[index];
  if (!s || rawOf(lines, s) !== expected) throw new Conflict('這一筆暫存在別的地方被改過了，請再操作一次');
  return { lines, s };
}

/* 新的放最前面；檔案開頭有沒標題的內文（外面改的）就放在它後面，不然那段會變成新那筆的內文 */
function addSnip(text, snip) {
  const t = text.replace(/(?:\r?\n)+$/, '');   // 結尾的換行先收掉，最後補一個
  const lines = t ? t.split(/\r?\n/) : [];
  const first = parse(lines)[0];
  const at = first && !first.title ? first.end + 1 : 0;
  lines.splice(at, 0, ...formatSnip(snip));
  return lines.join('\n') + '\n';
}

function editSnip(text, index, expected, snip) {
  const { lines, s } = locate(text, index, expected);
  lines.splice(s.start, s.end - s.start + 1, ...formatSnip(snip));
  return lines.join('\n');
}

function deleteSnip(text, index, expected) {
  const { lines, s } = locate(text, index, expected);
  lines.splice(s.start, s.end - s.start + 1);
  return lines.join('\n');
}

module.exports = { listSnips, formatSnip, addSnip, editSnip, deleteSnip };
