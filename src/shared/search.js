/* ============================================================
   搜尋、程式代號時間軸、事件時間軸、最大事件編號（見 開發筆記 D022、D023）
   純函式、不碰檔案。sources：[{ src: 'YYYY-MM-DD' 或 'todo', text }]
   ============================================================ */
'use strict';
const { parseDay } = require('./parser.js');

/* 先全部 parse 一次；之後的查詢都拿這份 */
function buildIndex(sources) {
  return sources.map(s => {
    const lines = s.text.split(/\r?\n/);
    return { src: s.src, lines, entries: parseDay(s.text) };
  });
}

/* 給畫面用的一筆：哪天（或 todo）、第幾筆、標題、狀態、事件、代號、內容 */
function item(day, e, index) {
  return {
    src: day.src,
    index,
    title: e.title,
    status: e.status,
    hidden: e.hidden,
    event: e.event,
    codes: e.codes,
    body: e.body.map(b => b.text.replace(/^(\t| {1,4})/, '')),
  };
}

function* all(idx) {
  for (const day of idx) for (let i = 0; i < day.entries.length; i++) yield { day, e: day.entries[i], i };
}

/* 日期新的在前、待辦區排最前面 */
const newestFirst = (a, b) => (a.src === b.src ? a.index - b.index : a.src === 'todo' ? -1 : b.src === 'todo' ? 1 : a.src < b.src ? 1 : -1);
/* 日期舊的在前、待辦區排最前面（時間軸照發生順序讀） */
const oldestFirst = (a, b) => (a.src === b.src ? a.index - b.index : a.src === 'todo' ? -1 : b.src === 'todo' ? 1 : a.src < b.src ? -1 : 1);

/* 全文搜尋：空白隔開的每個詞都要出現（不分大小寫），標題和內容都算 */
function search(idx, q, limit = 300) {
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const { day, e, i } of all(idx)) {
    const raw = day.lines.slice(e.start, e.end + 1).join('\n').toLowerCase();
    if (terms.every(t => raw.includes(t))) out.push(item(day, e, i));
  }
  return out.sort(newestFirst).slice(0, limit);
}

/* 程式代號時間軸：大小寫不同算同一支（見 開發筆記 D017） */
function timelineByCode(idx, code) {
  const key = String(code).toUpperCase();
  const out = [];
  for (const { day, e, i } of all(idx)) if (e.codes.some(c => c.toUpperCase() === key)) out.push(item(day, e, i));
  return out.sort(oldestFirst);
}

function timelineByEvent(idx, id) {
  const out = [];
  for (const { day, e, i } of all(idx)) if (e.event === Number(id)) out.push(item(day, e, i));
  return out.sort(oldestFirst);
}

function maxEvent(idx) {
  let max = 0;
  for (const { e } of all(idx)) if (e.event != null && e.event > max) max = e.event;
  return max;
}

module.exports = { buildIndex, search, timelineByCode, timelineByEvent, maxEvent };
