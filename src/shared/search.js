/* ============================================================
   搜尋、程式代號時間軸、事件時間軸、最大事件編號（見 開發筆記 D022、D023）、自動補完的候選（D031、D032）
   純函式、不碰檔案。sources：[{ src: 'YYYY-MM-DD' 或 'todo', text }]
   ============================================================ */
'use strict';
const { parseDay, headMeta, isCodeToken, leadCodeName } = require('./parser.js');

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

/* 自動補完的候選（見 開發筆記 D031、D032）
   titles：標題開頭的「代號＋程式名稱」，最近用過的在前；待辦區沒有日期，排在所有日子後面。
           同一支代號有帶名稱的寫法，就不列只有代號的
   words ：搜尋補字用——代號（標題、內容都算）、程式名稱、人名，出現在越多筆越前面，一樣多的新的在前 */
function suggestions(idx) {
  const days = idx.filter(d => d.src !== 'todo').sort((a, b) => (a.src < b.src ? 1 : -1))
    .concat(idx.filter(d => d.src === 'todo'));
  const lead = [];                // 新的在前
  const words = new Map();        // 大寫 → { w, n }
  for (const day of days) {
    for (let i = day.entries.length - 1; i >= 0; i--) {
      const e = day.entries[i];
      const seen = new Set();     // 同一筆裡出現好幾次只算一次
      const word = w => {
        const k = w.toUpperCase();
        if (seen.has(k)) return;
        seen.add(k);
        const x = words.get(k);
        if (x) x.n++; else words.set(k, { w, n: 1 });
      };
      for (let j = e.heads.length - 1; j >= 0; j--) {
        const lc = leadCodeName(headMeta(e.heads[j].text));
        if (!lc) continue;
        lead.push(lc);
        if (lc.name) word(lc.name);
      }
      e.codes.forEach(word);
      e.people.forEach(word);
      for (const b of e.body) for (const m of b.text.matchAll(/[A-Za-z0-9_]+/g)) if (isCodeToken(m[0], false)) word(m[0]);
    }
  }
  const named = new Set(lead.filter(x => x.name).map(x => x.code.toUpperCase()));
  return {
    titles: [...new Set(lead.filter(x => x.name || !named.has(x.code.toUpperCase())).map(x => x.text))],
    words: [...words.values()].sort((a, b) => b.n - a.n).map(x => x.w),
  };
}

module.exports = { buildIndex, search, timelineByCode, timelineByEvent, maxEvent, suggestions };
