/* ============================================================
   匯出成一份 Markdown（見 開發筆記 D035）
   純函式、不碰檔案。days：[{ date: 'YYYY-MM-DD', text }]，照日期排好；
   todo：待辦.md 的文字（匯出全部時才給，接在最後面）
   ============================================================ */
'use strict';
const { parseDay } = require('./parser.js');

const WEEK = '日一二三四五六';
function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()];
}

/* 一行內容 → 清單的一項
   - 內容本來就有的那一層縮排拿掉，再多的縮排變成下一層清單（一個 Tab 或 4 個空白算一層）
   - 開頭的 -> 變成 →
   - 開頭長得像 Markdown 語法的（「1. 」「- 」「# 」「> 」）前面加 \，照原字顯示；「1.控管」這種後面沒空白的本來就不算，不動 */
function bodyLine(text) {
  const t = text.replace(/^(\t| {1,4})/, '');
  const indent = t.match(/^[\t ]*/)[0];
  const depth = (indent.match(/\t/g) || []).length + Math.floor(indent.replace(/\t/g, '').length / 4);
  const s = t.slice(indent.length)
    .replace(/^->\s*/, '→ ')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^([-+*#>])(?=\s|$)/, '\\$1');
  return '  '.repeat(depth) + '- ' + s;
}

/* 一筆：好幾行標題（共用內容的，見 D009）用「 / 」接成一行；狀態、[隱藏] 照寫，事件編號 ^N 不寫 */
function entryLines(e) {
  const out = [];
  if (e.title) {
    const tags = (e.hidden ? ' [隱藏]' : '') + (e.status ? ` [${e.status}]` : '');
    out.push(`### ${e.title.split('\n').join(' / ')}${tags}`, '');
  }
  if (e.body.length) out.push(...e.body.map(b => bodyLine(b.text)), '');
  return out;
}

function toMarkdown({ title, days, todo }) {
  const out = [`# ${title}`, ''];
  for (const d of days) {
    const es = parseDay(d.text);
    if (!es.length) continue;   // 沒寫東西的日子不列
    out.push(`## ${d.date}（${weekday(d.date)}）`, '');
    for (const e of es) out.push(...entryLines(e));
  }
  if (todo != null) {
    const es = parseDay(todo);
    out.push('## 待處理', '');
    if (es.length) for (const e of es) out.push(...entryLines(e));
    else out.push('（沒有）', '');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

module.exports = { toMarkdown, bodyLine };
