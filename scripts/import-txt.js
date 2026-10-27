/* ============================================================
   舊 txt → 每日檔＋待辦.md，命令列版（見 開發筆記 D008、D018、D019）
   跑法：node scripts/import-txt.js <舊檔.txt> --out <資料資料夾> [--year 2025] [--todo-from 週報]
   - 原檔只讀。
   - --out 一定要給（資料資料夾不在專案裡，見 開發筆記 D016）。
   - --todo-from：從內容剛好是這幾個字的那一行起到檔尾，是常駐待辦區，原樣搬到 待辦.md。
   - 目標檔只要有一個已經存在，就整批不寫（不覆蓋）。畫面上的匯入是「已經有的日子跳過」，見 D044。
   拆法在 src/shared/formats/notepad-txt.js（畫面上的匯入共用，見 D047）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { TODO_FILE, dayPath } = require('../src/shared/paths.js');
const { splitDays, splitTodo, dayText } = require('../src/shared/formats/notepad-txt.js');

/* 寫進資料資料夾；有任何一個目標檔已存在就整批不寫。files：[{ rel, text }] */
function writeFiles(files, outDir) {
  const targets = files.map(f => ({ file: path.join(outDir, f.rel), text: f.text }));
  const exists = targets.filter(t => fs.existsSync(t.file));
  if (exists.length) throw new Error(`有 ${exists.length} 個目標檔已經存在，整批不寫（第一個：${exists[0].file}）`);
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, t.text, 'utf8');
  }
  return targets.map(t => t.file);
}

const dayFiles = days => days.map(d => ({ rel: dayPath(d.date), text: dayText(d) }));
const writeDays = (days, outDir) => writeFiles(dayFiles(days), outDir);

function main(argv) {
  const args = argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const outDir = opt('--out');
  const year = opt('--year');
  const todoFrom = opt('--todo-from');
  const src = args[0];
  if (!src || !outDir) {
    console.error('用法：node scripts/import-txt.js <舊檔.txt> --out <資料資料夾> [--year 2025] [--todo-from 週報]');
    return 2;
  }
  let text = fs.readFileSync(src, 'utf8');
  let todo = null;
  if (todoFrom != null) ({ rest: text, todo } = splitTodo(text, todoFrom));
  const days = splitDays(text, { year });
  const files = dayFiles(days);
  if (todo) files.push({ rel: TODO_FILE, text: todo.join('\n') + '\n' });
  writeFiles(files, outDir);
  console.log(`匯入 ${days.length} 天（${days[0].date} ～ ${days[days.length - 1].date}）→ ${path.join(outDir, 'journal')}` +
    (todo ? `；待辦區 ${todo.length} 行 → ${path.join(outDir, TODO_FILE)}` : ''));
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { TODO_FILE, splitDays, splitTodo, dayPath, dayText, writeDays, main };
