/* ============================================================
   剪貼簿（見 開發筆記 D093；原本叫「暫存」，D096）：對 剪貼簿.md 的文字做加／改／刪／搬一筆（搬 D125），純函式、不碰檔案。
   寫法照紀錄：沒縮排的行是標題，Tab 縮排的行是內文（點卡片複製的就是內文）。
   跟紀錄不一樣的地方——內文要原封不動複製出去，所以不沿用 parser.js：
   - 標題整行就是標題，行尾的 [待回覆]、^編號 這些不拆；連續兩行標題各是一筆
   - 內文的空行留著（寫成只有一個 Tab 的行），頭尾的空白、空行也留著（D127）
   每個改動都帶 index（第幾筆）和 expected（那一筆原本的原文），對不上就報錯不寫（同 entries.js）。
   ============================================================ */
'use strict';
const { Conflict } = require('./entries.js');
const { L } = require('./i18n.js');

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

/* 一筆 → 行。標題只能一行、去掉頭尾空白；內文原封不動（見 開發筆記 D127；原本會拿掉頭尾的空行、結尾的空白，D093）：
   每行前面加一個 Tab，空行寫成只有 Tab——頭尾的空行、最後的換行也是，讀回來（parse）才分得出來。整段都是空白才報錯 */
function formatSnip(snip) {
  const title = String(snip.title || '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) throw new Error(L('標題不能空白'));
  const body = String(snip.body || '').replace(/\r\n?/g, '\n');
  if (!body.trim()) throw new Error(L('內文不能空白（要複製的就是內文）'));
  return [title, ...body.split('\n').map(l => '\t' + l)];
}

function locate(text, index, expected) {
  const lines = text.split(/\r?\n/);
  const s = parse(lines)[index];
  if (!s || rawOf(lines, s) !== expected) throw new Conflict(L('剪貼簿的這一筆在別的地方被改過了，請再操作一次'));
  return { lines, s };
}

/* 新的放最後面（見 開發筆記 D126；原本放最前面，D093）：接在最後一行後面，原本的一個字都不動 */
function addSnip(text, snip) {
  const t = text.replace(/(?:\r?\n)+$/, '');   // 結尾的換行先收掉，最後補一個
  const lines = t ? t.split(/\r?\n/) : [];
  lines.push(...formatSnip(snip));
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

/* 搬一筆（見 開發筆記 D125）：第 index 筆搬到第 to 筆（搬完以後它是第幾筆）。只搬那一筆的行，筆跟筆中間的空行留在原地。
   開頭沒標題的那筆（外面改的）不能搬、別筆也不能搬到它前面：它只有內文，搬了會接到別筆底下 */
function moveSnip(text, index, expected, to) {
  const { lines, s } = locate(text, index, expected);
  const all = parse(lines);
  if (!Number.isInteger(to) || to < 0 || to >= all.length) throw new Error(L('剪貼簿沒有那個位置，請再操作一次'));
  if (!s.title || (!all[0].title && to === 0)) throw new Error(L('最前面那筆沒有標題，它和它前面都不能搬；先編輯補上標題'));
  const cut = lines.splice(s.start, s.end - s.start + 1);
  const rest = parse(lines);
  lines.splice(to < rest.length ? rest[to].start : rest[rest.length - 1].end + 1, 0, ...cut);
  return lines.join('\n');
}

module.exports = { listSnips, formatSnip, addSnip, editSnip, deleteSnip, moveSnip };
