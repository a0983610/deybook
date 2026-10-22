/* ============================================================
   舊 txt → 每日檔（見 開發筆記 D008、D018）
   跑法：node scripts/import-txt.js <舊檔.txt> --out <資料資料夾> [--year 2025]
   - 原檔只讀。
   - --out 一定要給（資料資料夾不在專案裡，見 開發筆記 D016）。
   - 目標檔只要有一個已經存在，就整批不寫（不覆蓋）。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\s*$/;
const YEAR_RE = /^-{3,}\s*(\d{4})\s*-{3,}\s*$/;
const SEP_RE = /^-{3,}\s*$/;

/* 把整份舊檔拆成一天一段
   年份（見 開發筆記 D018）：
   - ---YYYY--- 之後的日期是那一年；第一個標記之前的日期算前一年（舊檔 12/29～12/31 在 ---2026--- 之前）
   - 沒有任何標記就要給 --year
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
      if (year == null) throw new Error(`L${n} ${l.trim()}：檔案裡沒有 ---YYYY--- 年份標記，請用 --year 指定第一個日期的年份`);
      const month = Number(dm[1]), date = Number(dm[2]);
      const d = new Date(Date.UTC(year, month - 1, date));
      if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== date) throw new Error(`L${n} ${l.trim()}：不是有效日期`);
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
      const last = days[days.length - 1];
      if (last && iso <= last.date) throw new Error(`L${n} ${l.trim()}：算出 ${iso}，沒有比上一個日期 ${last.date} 晚（跨年要加 ---YYYY--- 標記）`);
      day = { date: iso, lines: [], lineNos: [] };
      days.push(day);
      return;
    }
    if (!day) {
      if (l.trim() !== '') throw new Error(`L${n}：第一個日期之前就有內容`);
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

/* 每日檔的相對路徑：journal/YYYY/MM/YYYY-MM-DD.md（見 開發筆記 D004） */
function dayPath(date) {
  const [y, m] = date.split('-');
  return path.join('journal', y, m, date + '.md');
}

/* 每日檔內容一律用 \n 換行（見 開發筆記 D018） */
function dayText(day) {
  return day.lines.join('\n') + '\n';
}

/* 寫進資料資料夾；有任何一個目標檔已存在就整批不寫 */
function writeDays(days, outDir) {
  const targets = days.map(d => ({ day: d, file: path.join(outDir, dayPath(d.date)) }));
  const exists = targets.filter(t => fs.existsSync(t.file));
  if (exists.length) throw new Error(`有 ${exists.length} 個目標檔已經存在，整批不寫（第一個：${exists[0].file}）`);
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, dayText(t.day), 'utf8');
  }
  return targets.map(t => t.file);
}

function main(argv) {
  const args = argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const outDir = opt('--out');
  const year = opt('--year');
  const src = args[0];
  if (!src || !outDir) {
    console.error('用法：node scripts/import-txt.js <舊檔.txt> --out <資料資料夾> [--year 2025]');
    return 2;
  }
  const days = splitDays(fs.readFileSync(src, 'utf8'), { year });
  const files = writeDays(days, outDir);
  console.log(`匯入 ${files.length} 天（${days[0].date} ～ ${days[days.length - 1].date}）→ ${path.join(outDir, 'journal')}`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { splitDays, dayPath, dayText, writeDays, main };
