/* ============================================================
   標準匯出入格式：daybook Markdown（見 開發筆記 D035、D046）
   匯出的檔要能原樣匯回，所以兩個方向寫在同一個檔：改一邊就要看另一邊。
   純函式、不碰檔案。
   - toMarkdown：days：[{ date: 'YYYY-MM-DD', text }]，照日期排好；todo：待辦.md 的文字（匯出全部時才給，接在最後面）
   - write：匯出格式的介面（見 開發筆記 D078），拿 formats/index.js 的 exportData 組的資料，排法同 toMarkdown
   - parse：匯出檔 → { days: [{ date, text }], todo }（匯入格式模組的介面，見 開發筆記 D047）
   ============================================================ */
'use strict';
const { parseDay, lineKind } = require('../parser.js');
const { L, LK } = require('../i18n.js');

const WEEK = '日一二三四五六';   // 不翻：匯出檔的內容（## 2026-03-02（一）），也是 exportData 的 weekday
function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()];
}

/* 一行內容 → 清單的一項：內容本來就有的那一層縮排拿掉，後面再多的 Tab 變成下一層清單，剩下的字原樣照抄
   （不改 ->、不加跳脫：匯入才還原得回一模一樣，見 開發筆記 D046） */
function bodyLine(text) {
  const t = text.replace(/^(\t| {1,4})/, '');
  const depth = t.match(/^\t*/)[0].length;
  return '  '.repeat(depth) + '- ' + t.slice(depth);
}

/* 一筆：每一行標題各寫一個「### 原文」（含 ^編號、[隱藏]、[標記]、[狀態]）；
   好幾行標題共用內容的（D009）連著寫、中間不空行，匯入時靠這個分出哪幾行是同一筆 */
function entryLines(e) {
  const out = [];
  if (e.heads.length) out.push(...e.heads.map(h => '### ' + h.text), '');
  if (e.body.length) out.push(...e.body.map(b => bodyLine(b.text)), '');
  return out;
}

function toMarkdown({ title, days, todo }) {
  const out = [`# ${title}`, ''];
  for (const d of days) {
    const es = parseDay(d.text);
    if (!es.length) continue;   // 沒寫東西的日子不列
    out.push(`## ${d.date}（${weekday(d.date)}）`, '');   // 不翻：匯出檔的內容，匯入照這個認
    for (const e of es) out.push(...entryLines(e));
  }
  if (todo != null) {
    const es = parseDay(todo);
    out.push('## 待處理', '');   // 不翻：同上
    if (es.length) for (const e of es) out.push(...entryLines(e));
    else out.push('（沒有）', '');   // 不翻：同上
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

/* 匯出格式的介面（見 開發筆記 D078）：data 的 days 已經拿掉沒寫東西的日子，toMarkdown 本來也不列，排出來一樣 */
const write = data => toMarkdown({ title: data.title, days: data.days, todo: data.todo && data.todo.text });

/* ---------- 匯入：toMarkdown 的反方向。認不得的行就報錯、寫第幾行，不猜（同 D018） ---------- */
const DAY_RE = /^## (\d{4}-\d{2}-\d{2})(?:（.）)?\s*$/;
const TODO_RE = /^## 待處理\s*$/;
const HEAD_RE = /^### (.*)$/;
const ITEM_RE = /^((?:  )*)- (.*)$/;

/* 第一行有字的是「# 標題」，而且有「## 日期」或「## 待處理」 */
function detect(text) {
  const lines = text.split(/\r?\n/);
  const first = lines.find(l => l.trim() !== '');
  return !!first && first.startsWith('# ') && lines.some(l => DAY_RE.test(l) || TODO_RE.test(l));
}

/* 每筆還原成：標題行、內容行（前面補回一個 Tab，清單每深一層再多一個 Tab）；筆跟筆之間空一行，
   不然兩筆沒內容的標題連在一起，會被 D009 當成共用內容 */
function sectionText(entries) {
  return entries.map(e => e.heads.concat(e.body).join('\n')).join('\n\n') + '\n';
}

function parse(text) {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex(l => l.trim() !== '');
  const days = [];
  let todo = null;
  let sec = null;          // 正在收的那一段（某一天或待處理）
  let cur = null;          // 正在收的那一筆
  let afterHead = false;   // 上一行是 ###：連著的標題是同一筆
  lines.forEach((l, i) => {
    const n = i + 1;
    if (l.trim() === '') { afterHead = false; return; }
    if (i === first && l.startsWith('# ')) return;
    let m = l.match(DAY_RE);
    if (m || TODO_RE.test(l)) {
      if (m) {
        const date = m[1];
        const [y, mo, d] = date.split('-').map(Number);
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(L('第 {n} 行 {date}：不是有效日期', { n, date }));
        if (days.some(x => x.date === date)) throw new Error(L('第 {n} 行 {date}：這一天出現兩次', { n, date }));
        sec = { date, entries: [] };
        days.push(sec);
      } else {
        if (todo) throw new Error(L('第 {n} 行：「## 待處理」出現兩次', { n }));
        sec = todo = { entries: [] };
      }
      cur = null;
      afterHead = false;
      return;
    }
    if (!sec) throw new Error(L('第 {n} 行：第一個「## 日期」之前就有內容', { n }));
    if ((m = l.match(HEAD_RE))) {
      if (lineKind(m[1]) !== 'head') throw new Error(L('第 {n} 行：「{head}」不能當標題（空白或「數字＋.」開頭會被當成內容）', { n, head: m[1] }));
      if (!afterHead || !cur) { cur = { heads: [], body: [] }; sec.entries.push(cur); }
      cur.heads.push(m[1]);
      afterHead = true;
      return;
    }
    if ((m = l.match(ITEM_RE))) {
      if (m[2].trim() === '') throw new Error(L('第 {n} 行：清單這一項沒有字', { n }));
      if (!cur) { cur = { heads: [], body: [] }; sec.entries.push(cur); }   // 前面沒有標題的內容
      cur.body.push('\t' + '\t'.repeat(m[1].length / 2) + m[2]);
      afterHead = false;
      return;
    }
    if (sec === todo && !sec.entries.length && l.trim() === '（沒有）') return;   // 不翻：匯出檔的內容
    throw new Error(L('第 {n} 行：認不得這一行（{line}）', { n, line: l.length > 30 ? l.slice(0, 30) + '…' : l }));
  });
  return {
    days: days.filter(d => d.entries.length).map(d => ({ date: d.date, text: sectionText(d.entries) })),
    todo: todo && todo.entries.length ? sectionText(todo.entries) : null,
  };
}

module.exports = {
  label: 'daybook Markdown',
  hint: LK('daybook 匯出的 .md'),   // 顯示時才 L()（D131）
  extensions: ['md'],
  detect,
  parse,
  toMarkdown,
  write,
  weekday,
};
