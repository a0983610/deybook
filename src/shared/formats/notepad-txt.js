/* ============================================================
   非標準匯入格式：舊記事本（每日工作紀錄 txt）→ 每日檔＋待辦.md（見 開發筆記 D008、D018、D019、D044、D047）
   純函式、不碰檔案；畫面上的匯入（import.js）和命令列 scripts/import-txt.js 共用。
   ============================================================ */
'use strict';

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\s*$/;
const DATE_LEAD_RE = /^\d{1,2}\/\d{1,2}(?!\d)/;   // 沒縮排、開頭是日期：後面還有字的要報錯（見 開發筆記 D060）
const YEAR_RE = /^-{3,}\s*(\d{4})\s*-{3,}\s*$/;
const SEP_RE = /^-{3,}\s*$/;
const TODO_MARK = '週報';   // 舊檔的常駐待辦區從內容剛好是這兩個字的那一行起（見 開發筆記 D019、D044）

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
    // 「2/22 (六)」「8/5請假」：不當日期行的話會悄悄併進前一天，所以停下來（見 開發筆記 D060）
    if (DATE_LEAD_RE.test(l)) throw new Error(`第 ${n} 行 ${l.trim()}：開頭是日期、後面還有字，分不出是日期還是一件事。日期要自己一行（例如 2/22），後面的字移到下一行`);
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

/* 有日期行、年份標記、或「週報」那一行 */
function detect(text) {
  return text.split(/\r?\n/).some(l => DATE_RE.test(l) || YEAR_RE.test(l) || l.trim() === TODO_MARK);
}

/* 匯入格式模組的介面（見 開發筆記 D047）：有「週報」那行就從那行起是待辦區，沒有就沒有待辦區 */
function parse(text) {
  let todo = null;
  if (text.split(/\r?\n/).some(l => l.trim() === TODO_MARK)) ({ rest: text, todo } = splitTodo(text, TODO_MARK));
  const days = splitDays(text);
  if (!days.length && !todo) throw new Error('這個檔裡找不到日期行（一行只有日期，例如 1/5）');
  return { days: days.map(d => ({ date: d.date, text: dayText(d) })), todo: todo ? todo.join('\n') + '\n' : null };
}

module.exports = {
  label: '舊記事本',
  hint: '一行只有日期，例如 1/5',
  extensions: ['txt'],
  detect,
  parse,
  splitDays,
  splitTodo,
  dayText,
};
