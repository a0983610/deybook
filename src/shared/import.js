/* ============================================================
   畫面上的匯入要寫哪些（見 開發筆記 D044、D047）：認格式 → 拆成每天＋待處理 → 已經有的跳過。
   純函式、不碰檔案。各種格式怎麼拆在 formats/（D047）。
   放在 src/ 底下：打包只收 src/，exe 裡才有（見 D040）
   ============================================================ */
'use strict';
const { TODO_FILE, dayPath } = require('./paths.js');
const { pickFormat } = require('./formats/index.js');

/* - 資料夾裡已經有內容的日子跳過、其他照匯（使用者選的）；待辦.md 已經有內容，檔案裡的待處理也不匯
   exists(相對路徑) → 資料夾裡那個檔是不是已經有內容
   回傳 { format: 格式名稱, days: 檔案裡全部的日子 [{ date, text }], write: 要寫的日子, skipped: 跳過的日子,
         todo: 要寫的待處理文字（沒有或跳過是 null）, todoSkipped } */
function planImport(text, exists) {
  text = text.replace(/^﻿/, '');
  const format = pickFormat(text);
  const { days, todo } = format.parse(text);
  const write = [], skipped = [];
  for (const d of days) (exists(dayPath(d.date)) ? skipped : write).push(d);
  const todoSkipped = !!todo && exists(TODO_FILE);
  return { format: format.label, days, write, skipped, todo: todoSkipped ? null : todo, todoSkipped };
}

module.exports = { planImport };
