/* ============================================================
   卡片編輯：對「一天的文字」（或 待辦.md）做加／改／刪一筆，純函式、不碰檔案（見 開發筆記 D021）
   每個改動都帶 index（第幾筆）和 expected（那一筆原本的原文），對不上就報錯不寫——
   檔案可能在外面被改過（人用編輯器改、Claude 改），不能拿舊的位置去蓋新的內容。
   改狀態、加事件編號、加更新只動必要的那一行，其他行原封不動（見 開發筆記 D006、D022）。
   ============================================================ */
'use strict';
const { parseDay, formatEntry, STATUSES } = require('./parser.js');

const STATUS_TAIL = new RegExp('\\s*\\[(' + STATUSES.join('|') + ')\\]\\s*$');

class Conflict extends Error {}

/* 一筆的原文：從 start 到 end 那幾行 */
function rawOf(lines, e) {
  return lines.slice(e.start, e.end + 1).join('\n');
}

/* 找到第 index 筆，並確認它還是畫面上看到的那個樣子 */
function locate(text, index, expected) {
  const lines = text.split(/\r?\n/);
  const e = parseDay(text)[index];
  if (!e || rawOf(lines, e) !== expected) throw new Conflict('這一筆在別的地方被改過了，畫面已重新整理，請再操作一次');
  return { lines, e };
}

function splice(lines, at, removeCount, insert) {
  lines.splice(at, removeCount, ...insert);
  return lines.join('\n');
}

/* 每一筆給畫面用的樣子：原文（之後改動時當 expected）、卡片欄位 */
function listEntries(text) {
  const lines = text.split(/\r?\n/);
  return parseDay(text).map((e, index) => ({
    index,
    raw: rawOf(lines, e),
    title: e.title,
    status: e.status,
    event: e.event,
    codes: e.codes,
    // 內容去掉一層縮排（Tab 或最多 4 個空白），存回去時 formatEntry 會補一個 Tab
    body: e.body.map(b => b.text.replace(/^(\t| {1,4})/, '')),
  }));
}

/* 加在最後面；結尾的空行先收掉 */
function addEntry(text, card) {
  const t = text.replace(/\s+$/, '');
  return (t ? t + '\n' : '') + formatEntry(card).join('\n') + '\n';
}

function editEntry(text, index, expected, card) {
  const { lines, e } = locate(text, index, expected);
  return splice(lines, e.start, e.end - e.start + 1, formatEntry(card));
}

function deleteEntry(text, index, expected) {
  const { lines, e } = locate(text, index, expected);
  return splice(lines, e.start, e.end - e.start + 1, []);
}

function lastHead(e) {
  if (!e.heads.length) throw new Error('這一筆沒有標題');
  return e.heads[e.heads.length - 1].line;
}

/* 只改最後一行標題的行尾狀態；status 給 null 就是拿掉 */
function setStatus(text, index, expected, status) {
  if (status && !STATUSES.includes(status)) throw new Error('沒有這個狀態：' + status);
  const { lines, e } = locate(text, index, expected);
  const at = lastHead(e);
  const base = lines[at].replace(STATUS_TAIL, '');
  return splice(lines, at, 1, [base + (status ? ' [' + status + ']' : '')]);
}

/* 在最後一行標題的狀態前面插 ^編號；已經有編號就報錯 */
function setEvent(text, index, expected, id) {
  const { lines, e } = locate(text, index, expected);
  if (e.event != null) throw new Error('這一筆已經有事件編號 ^' + e.event);
  const at = lastHead(e);
  const m = lines[at].match(STATUS_TAIL);
  const base = m ? lines[at].slice(0, m.index) : lines[at];
  return splice(lines, at, 1, [base.trimEnd() + ' ^' + id + (m ? m[0] : '')]);
}

/* 同一天的進展：在這一筆最後面加一行 \t->… */
function appendUpdate(text, index, expected, update) {
  const u = String(update).trim().replace(/^->\s*/, '');   // 自己打了 -> 就不要變成 ->->
  if (!u) throw new Error('更新內容不能空白');
  const { lines, e } = locate(text, index, expected);
  return splice(lines, e.end + 1, 0, ['\t->' + u]);
}

module.exports = { Conflict, listEntries, addEntry, editEntry, deleteEntry, setStatus, setEvent, appendUpdate };
