/* ============================================================
   卡片編輯：對「一天的文字」（或 待辦.md）做加／改／刪一筆，純函式、不碰檔案（見 開發筆記 D021）
   每個改動都帶 index（第幾筆）和 expected（那一筆原本的原文），對不上就報錯不寫——
   檔案可能在外面被改過（人用編輯器改、Claude 改），不能拿舊的位置去蓋新的內容。
   改狀態、隱藏、標記、加事件編號、加更新只動必要的那一行，其他行原封不動（見 開發筆記 D006、D022、D026、D072）。
   ============================================================ */
'use strict';
const { parseDay, formatEntry, splitTail, joinTail, checkCat, STATUSES } = require('./parser.js');
const { L } = require('./i18n.js');

class Conflict extends Error {}

/* 一筆的原文：從 start 到 end 那幾行 */
function rawOf(lines, e) {
  return lines.slice(e.start, e.end + 1).join('\n');
}

/* 找到第 index 筆，並確認它還是畫面上看到的那個樣子 */
function locate(text, index, expected) {
  const lines = text.split(/\r?\n/);
  const e = parseDay(text)[index];
  if (!e || rawOf(lines, e) !== expected) throw new Conflict(L('這一筆在別的地方被改過了，畫面已重新整理，請再操作一次'));
  return { lines, e };
}

function splice(lines, at, removeCount, insert) {
  lines.splice(at, removeCount, ...insert);
  return lines.join('\n');
}

/* 換掉第 at 行起的 removeCount 行（加、刪、改一整筆），前後其他筆都要跟原本一樣（見 開發筆記 D135）：
   只有光頭標題的那筆緊接著別的標題，會被當成連續標題共用內容（D009）黏在一起——接縫那裡隔一行空行。
   先試不隔，再試前面隔、後面隔、兩邊都隔；都不行就報錯不寫。跟匯入的 mergeEntries（import.js，D063）同一個做法：
   接上去再拆一次比，不在這裡重刻哪些標題算光頭。比的時候每行行尾的空白不算（appendLines 會收掉檔尾的空白） */
function spliceKeep(lines, at, removeCount, insert) {
  const keys = t => { const ls = t.split(/\r?\n/); return parseDay(t).map(e => rawOf(ls, e).split('\n').map(l => l.trimEnd()).join('\n')); };
  const was = parseDay(lines.join('\n'));
  const all = keys(lines.join('\n'));
  const before = all.filter((_, i) => was[i].end < at);
  const after = all.filter((_, i) => was[i].start >= at + removeCount);
  const head = lines.slice(0, at), tail = lines.slice(at + removeCount);
  for (const [pre, post] of [[false, false], [true, false], [false, true], [true, true]]) {
    const out = [...head, ...(pre && head.length ? [''] : []), ...insert, ...(post && tail.length ? [''] : []), ...tail].join('\n');
    const got = keys(out);
    if (got.length >= before.length + after.length
      && before.every((k, i) => got[i] === k) && after.every((k, i) => got[got.length - after.length + i] === k)) return out;
  }
  throw new Error(L('這樣改會跟旁邊那一筆黏在一起，沒有寫入'));
}

/* 每一筆給畫面用的樣子：原文（之後改動時當 expected）、卡片欄位 */
function listEntries(text) {
  const lines = text.split(/\r?\n/);
  return parseDay(text).map((e, index) => ({
    index,
    raw: rawOf(lines, e),
    title: e.title,
    status: e.status,
    hidden: e.hidden,
    flagged: e.flagged,
    flagCat: e.flagCat,
    event: e.event,
    codes: e.codes,
    // 內容去掉一層縮排（Tab 或最多 4 個空白），存回去時 formatEntry 會補一個 Tab
    body: e.body.map(b => b.text.replace(/^(\t| {1,4})/, '')),
  }));
}

/* 幾行接在最後面；結尾的空行先收掉。接上去會跟最後一筆黏在一起就隔一行空行（D135） */
function appendLines(text, newLines) {
  const t = text.replace(/\s+$/, '');
  const lines = t ? t.split('\n') : [];
  return spliceKeep(lines, lines.length, 0, newLines) + '\n';
}

function addEntry(text, card) {
  return appendLines(text, formatEntry(card));
}

/* 把一筆整段拿出來（待處理 → 已處理搬家用，見 開發筆記 D024）：
   回傳 rest＝拿掉之後的文字、taken＝那一筆的原文行（最後一行標題的狀態、[隱藏] 拿掉，其他照舊）。
   有給 flagCat 就換成標上那個分類的標記（「已處理+未完標籤」，見 D091） */
function takeEntry(text, index, expected, flagCat) {
  const { lines, e } = locate(text, index, expected);
  const taken = lines.slice(e.start, e.end + 1);
  if (e.heads.length) {
    const at = e.heads[e.heads.length - 1].line - e.start;
    taken[at] = joinTail(splitTail(taken[at]).base, flagCat ? { flagged: true, flagCat: checkCat(flagCat) } : {});
  }
  return { rest: spliceKeep(lines, e.start, e.end - e.start + 1, []), taken };
}

function editEntry(text, index, expected, card) {
  const { lines, e } = locate(text, index, expected);
  return spliceKeep(lines, e.start, e.end - e.start + 1, formatEntry(card));
}

function deleteEntry(text, index, expected) {
  const { lines, e } = locate(text, index, expected);
  return spliceKeep(lines, e.start, e.end - e.start + 1, []);
}

function lastHead(e) {
  if (!e.heads.length) throw new Error(L('這一筆沒有標題'));
  return e.heads[e.heads.length - 1].line;
}

/* 只改最後一行標題的行尾狀態；status 給 null 就是拿掉；[隱藏]、[標記] 照舊 */
function setStatus(text, index, expected, status) {
  if (status && !STATUSES.includes(status)) throw new Error(L('沒有這個狀態：{status}', { status }));
  const { lines, e } = locate(text, index, expected);
  const at = lastHead(e);
  const t = splitTail(lines[at]);
  return splice(lines, at, 1, [joinTail(t.base, { ...t, status })]);
}

/* 隱藏／取消隱藏（見 開發筆記 D026）：只動行尾的 [隱藏]，其他標記照舊 */
function setHidden(text, index, expected, hidden) {
  const { lines, e } = locate(text, index, expected);
  const at = lastHead(e);
  const t = splitTail(lines[at]);
  return splice(lines, at, 1, [joinTail(t.base, { ...t, hidden: !!hidden })]);
}

/* 標記／取消標記（見 開發筆記 D072）：只動行尾的 [標記]，其他標記照舊。
   cat 是分類，沒給（null、空字串）就是未分類；已經標記的給新的分類就是換分類（見 D076） */
function setFlagged(text, index, expected, flagged, cat) {
  const flagCat = flagged && cat ? checkCat(cat) : null;
  const { lines, e } = locate(text, index, expected);
  const at = lastHead(e);
  const t = splitTail(lines[at]);
  return splice(lines, at, 1, [joinTail(t.base, { ...t, flagged: !!flagged, flagCat })]);
}

/* 在最後一行標題的行尾標記前面插 ^編號；已經有編號就報錯 */
function setEvent(text, index, expected, id) {
  const { lines, e } = locate(text, index, expected);
  if (e.event != null) throw new Error(L('這一筆已經有事件編號 ^{event}', { event: e.event }));
  const at = lastHead(e);
  const t = splitTail(lines[at]);
  return splice(lines, at, 1, [joinTail(t.base.trimEnd() + ' ^' + id, t)]);
}

/* 同一天的進展：在這一筆最後面加一行 \t->…。
   只有標題的那筆多了內容，前面緊貼的光頭標題會來共用（D009）：整筆當成換掉再比一次（D135） */
function appendUpdate(text, index, expected, update) {
  const u = String(update).trim().replace(/^->\s*/, '');   // 自己打了 -> 就不要變成 ->->
  if (!u) throw new Error(L('更新內容不能空白'));
  const { lines, e } = locate(text, index, expected);
  return spliceKeep(lines, e.start, e.end - e.start + 1, [...lines.slice(e.start, e.end + 1), '\t->' + u]);
}

module.exports = { Conflict, listEntries, appendLines, addEntry, takeEntry, editEntry, deleteEntry, setStatus, setHidden, setFlagged, setEvent, appendUpdate };
