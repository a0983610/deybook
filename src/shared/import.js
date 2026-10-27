/* ============================================================
   畫面上的匯入要寫哪些（見 開發筆記 D044、D047、D055）：認格式 → 拆成每天＋待處理 → 已經有的跳過。
   純函式、不碰檔案。各種格式怎麼拆在 formats/（D047）；外部擴充在獨立程序跑，由主程序傳進來（D055）。
   放在 src/ 底下：打包只收 src/，exe 裡才有（見 D040）
   ============================================================ */
'use strict';
const { TODO_FILE, ISO_DATE_RE, dayPath } = require('./paths.js');
const { pickFormat } = require('./formats/index.js');

/* 擴充拆出來的結果先檢查（見 開發筆記 D055）：擴充是別人寫的，日期、型別不對就整批不寫。
   換行一律 \n、有字的結尾補一個 \n（同 D018） */
function checkParsed(r) {
  const bad = msg => { throw new Error('擴充拆出來的資料不對：' + msg); };
  const lf = t => { t = t.replace(/\r\n?/g, '\n'); return t === '' || t.endsWith('\n') ? t : t + '\n'; };
  const validDate = s => {
    if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  if (!r || !Array.isArray(r.days)) bad('要回傳 { days: [{ date, text }], todo }');
  const seen = new Set();
  const days = r.days.map((d, i) => {
    if (!d || !validDate(d.date)) bad(`第 ${i + 1} 天的日期 ${JSON.stringify(d && d.date)} 不是有效的 YYYY-MM-DD`);
    if (seen.has(d.date)) bad(`${d.date} 出現兩次`);
    seen.add(d.date);
    if (typeof d.text !== 'string') bad(`${d.date} 的內容不是文字`);
    return { date: d.date, text: lf(d.text) };
  });
  if (r.todo != null && typeof r.todo !== 'string') bad('todo 要是文字或 null');
  return { days, todo: r.todo ? lf(r.todo) : null };
}

/* - 資料夾裡已經有內容的日子跳過、其他照匯（使用者選的）；待辦.md 已經有內容，檔案裡的待處理也不匯
   exists(相對路徑) → 資料夾裡那個檔是不是已經有內容
   ext：外部擴充（main/extensions.js 的 startHost），沒有啟用的就是 null：
     ext.formats 格式清單、ext.detect(text) → 每一種認不認得、ext.parse(format, text) → 拆出來的結果
   choose(認得的那幾種) → 兩種以上都認得時用哪一種（見 開發筆記 D058）；回 null 是使用者取消，planImport 也回 null。沒給就照舊報錯
   回傳 { format: 格式名稱, formatFile: 擴充的程式檔（內建是 null；AI 寫的擴充試跑時看選中的是不是它，D056）,
         days: 檔案裡全部的日子 [{ date, text }], write: 要寫的日子, skipped: 跳過的日子,
         todo: 要寫的待處理文字（沒有或跳過是 null）, todoSkipped } */
async function planImport(text, exists, ext = null, choose = null) {
  text = text.replace(/^﻿/, '');
  const more = ext ? (await ext.detect(text)).map((hit, i) => ({ ...ext.formats[i], hit })) : [];
  let format;
  try {
    format = pickFormat(text, more);
  } catch (e) {
    if (!e.candidates || !choose) throw e;
    format = await choose(e.candidates);
    if (!format) return null;
  }
  const { days, todo } = format.ext ? checkParsed(await ext.parse(format, text)) : format.parse(text);
  const write = [], skipped = [];
  for (const d of days) (exists(dayPath(d.date)) ? skipped : write).push(d);
  const todoSkipped = !!todo && exists(TODO_FILE);
  return {
    format: format.ext ? `${format.label}，擴充「${format.ext}」` : format.label,
    formatFile: format.file || null,
    days, write, skipped, todo: todoSkipped ? null : todo, todoSkipped,
  };
}

module.exports = { planImport, checkParsed };
