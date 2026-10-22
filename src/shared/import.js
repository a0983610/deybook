/* ============================================================
   舊 txt → 每日檔＋待辦.md 的拆法（見 開發筆記 D008、D018、D019、D044）
   純函式、不碰檔案；畫面上的匯入（main.js）和命令列 scripts/import-txt.js 共用。
   放在 src/ 底下：打包只收 src/，exe 裡才有（見 D040）
   ============================================================ */
'use strict';
const { TODO_FILE, dayPath } = require('./paths.js');

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\s*$/;
const YEAR_RE = /^-{3,}\s*(\d{4})\s*-{3,}\s*$/;
const SEP_RE = /^-{3,}\s*$/;

/* 把整份舊檔拆成一天一段
   年份（見 開發筆記 D018）：
   - ---YYYY--- 之後的日期是那一年；第一個標記之前的日期算前一年（舊檔 12/29～12/31 在 ---2026--- 之前）
   - 沒有任何標記就要給 year
   - 日期一定要往後走：重複、或比上一個日期早（例如 12 月之後出現 1 月卻沒有年份標記）→ 報錯，不自己猜
   回傳 [{ date: 'YYYY-MM-DD', lines: [...], lineNos: [每一行在原檔第幾行，1 起算] }] */
function splitDays(text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const firstMarker = lines.map(l => l.match(YEAR_RE)).find(Boolean);
  let year = opts.year != null ? Number(opts.year) : firstMarker ? Number(firstMarker[1]) - 1 : null;

  const days = [];
  let day = null;
  lines.forEach((l, i) => {
    const n = i + 1;
    const ym = l.match(YEAR_RE);
    if (ym) { year = Number(ym[1]); return; }
    if (SEP_RE.test(l)) return;
    const dm = l.match(DATE_RE);
    if (dm) {
      if (year == null) throw new Error(`第 ${n} 行 ${l.trim()}：檔案裡沒有 ---年份--- 標記，分不出是哪一年。請在第一個日期前加一行，例如 ---2026---（命令列也可以用 --year 指定）`);
      const month = Number(dm[1]), date = Number(dm[2]);
      const d = new Date(Date.UTC(year, month - 1, date));
      if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== date) throw new Error(`第 ${n} 行 ${l.trim()}：不是有效日期`);
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
      const last = days[days.length - 1];
      if (last && iso <= last.date) throw new Error(`第 ${n} 行 ${l.trim()}：算出 ${iso}，沒有比上一個日期 ${last.date} 晚（跨年要加 ---年份--- 標記）`);
      day = { date: iso, lines: [], lineNos: [] };
      days.push(day);
      return;
    }
    if (!day) {
      if (l.trim() !== '') throw new Error(`第 ${n} 行：第一個日期之前就有內容`);
      return;
    }
    day.lines.push(l);
    day.lineNos.push(n);
  });

  for (const d of days) {
    while (d.lines.length && d.lines[0].trim() === '') { d.lines.shift(); d.lineNos.shift(); }
    while (d.lines.length && d.lines[d.lines.length - 1].trim() === '') { d.lines.pop(); d.lineNos.pop(); }
  }
  return days;
}

/* 檔尾的常駐待辦區（見 開發筆記 D019）：從內容剛好是 marker 的那一行起到檔尾。
   那一行之後不能再有日期行——不然分不清是待辦還是某一天，報錯不猜。
   回傳 { rest: 待辦區之前的文字（行號不變）, todo: 待辦區的行（去掉結尾空行） } */
function splitTodo(text, marker) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => l.trim() === marker);
  if (at < 0) throw new Error(`找不到內容是「${marker}」的那一行`);
  const todo = lines.slice(at);
  const bad = todo.findIndex(l => DATE_RE.test(l));
  if (bad >= 0) throw new Error(`第 ${at + bad + 1} 行 ${todo[bad].trim()}：「${marker}」後面還有日期行，分不清是待辦還是某一天`);
  while (todo.length && todo[todo.length - 1].trim() === '') todo.pop();
  return { rest: lines.slice(0, at).join('\n'), todo };
}

/* 檔案內容一律用 \n 換行（見 開發筆記 D018） */
function dayText(day) {
  return day.lines.join('\n') + '\n';
}

/* 畫面上的匯入要寫哪些（見 開發筆記 D044）
   - 有內容剛好是「週報」的那一行：從那行起是待辦區（D019，舊檔就是這樣放的）；沒有就沒有待辦區
   - 資料夾裡已經有的日子跳過、其他照匯（使用者選的）；待辦.md 已經有內容，舊檔的待辦區也不匯
   exists(相對路徑) → 資料夾裡那個檔是不是已經有內容
   回傳 { days: 舊檔全部的日子, write: 要寫的日子, skipped: 跳過的日子, todo: 要寫的待辦區行（沒有或跳過是 null）, todoSkipped } */
function planImport(text, exists, todoMarker = '週報') {
  text = text.replace(/^﻿/, '');
  let todo = null;
  if (text.split(/\r?\n/).some(l => l.trim() === todoMarker)) ({ rest: text, todo } = splitTodo(text, todoMarker));
  const days = splitDays(text);
  if (!days.length && !todo) throw new Error('這個檔裡找不到日期行（一行只有日期，例如 1/5）');
  const write = [], skipped = [];
  for (const d of days) (exists(dayPath(d.date)) ? skipped : write).push(d);
  const todoSkipped = !!todo && exists(TODO_FILE);
  return { days, write, skipped, todo: todoSkipped ? null : todo, todoSkipped };
}

module.exports = { splitDays, splitTodo, dayText, planImport };
