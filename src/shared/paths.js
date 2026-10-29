/* ============================================================
   資料資料夾裡的檔案位置（見 開發筆記 D004、D019）
   主程序與匯入腳本共用。日期一律先驗格式，畫面傳進來的字串不能拿來拼出別的路徑。
   ============================================================ */
'use strict';
const path = require('path');

const TODO_FILE = '待辦.md';
const FLAG_CATS_FILE = '標記分類.json';   // 標記的分類清單，跟著紀錄走（見 開發筆記 D076）
const SNIP_FILE = '暫存.md';              // 暫存的文字，跟著紀錄走（見 開發筆記 D093）
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* 每日檔的相對路徑：journal/YYYY/MM/YYYY-MM-DD.md */
function dayPath(date) {
  if (!ISO_DATE_RE.test(date)) throw new Error('日期格式不對：' + date);
  const [y, m] = date.split('-');
  return path.join('journal', y, m, date + '.md');
}

module.exports = { TODO_FILE, FLAG_CATS_FILE, SNIP_FILE, ISO_DATE_RE, dayPath };
