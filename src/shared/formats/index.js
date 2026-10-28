/* ============================================================
   能匯入、匯出的格式（見 開發筆記 D047、D078）：一種格式一個模組，在這裡登記。
   匯入：每個模組給 label（名稱）、hint（一句話說長怎樣，認不出格式時列給使用者看）、extensions（選檔視窗用）、
         detect(text) → 是不是這種格式、parse(text) → { days: [{ date: 'YYYY-MM-DD', text }], todo: 文字或 null }。
   匯出：每種給 id、label、hint、extension（存檔的副檔名，不含「.」）、write(data) → 文字或 Uint8Array；data 是 exportData 組的。
   都是純函式、不碰檔案；寫檔、跳過已有的日子、Ctrl+Z、存檔視窗都在主程序（外部擴充也照這個介面，見 D055、D078）
   ============================================================ */
'use strict';
const { parseDay } = require('../parser.js');
const md = require('./daybook-md.js');

const FORMATS = [
  md,                            // 標準格式：daybook 自己匯出的（見 D046）
  require('./notepad-txt.js'),   // 舊記事本
];

/* 匯出的格式：畫面上「匯出…」的下拉選單照這個順序，第一個是沒選過時的預設 */
const EXPORT_FORMATS = [
  { id: 'daybook-md', label: md.label, hint: '標準匯出入格式，可以再匯回 daybook', extension: 'md', write: md.write },
  require('./xlsx.js'),
];

/* 給人看的格式名稱：擴充的多寫是哪個擴充 */
const formatName = f => `「${f.label}」` + (f.ext ? `（擴充「${f.ext}」）` : '');

/* 只有一種格式認得這個檔才用它；都不認得、或兩種以上都認得就報錯，不猜（同 D018）
   兩種以上的錯誤帶 candidates（認得的那幾種）：畫面上的匯入拿它問使用者這次用哪一種（見 開發筆記 D058）
   more：外部擴充的格式（見 開發筆記 D055），detect 已經在獨立程序跑過，認不認得放在 hit；ext 是擴充名稱 */
function pickFormat(text, more = []) {
  const all = [...FORMATS, ...more];
  const hit = [...FORMATS.filter(f => f.detect(text)), ...more.filter(f => f.hit)];
  if (hit.length === 1) return hit[0];
  if (!hit.length) {
    const err = new Error('認不出這個檔的格式。能匯入的有：' + all.map(f => `${f.label}（${f.ext ? `擴充「${f.ext}」，` : ''}${f.hint}）`).join('、'));
    err.unknownFormat = true;   // 主程序看到這個才補「有幾個擴充還沒啟用」
    throw err;
  }
  const err = new Error(`這個檔同時像${hit.map(formatName).join('和')}，分不出要用哪一種` + (hit.some(f => f.ext) ? '；可以到右上角「格式」停用擴充' : ''));
  err.candidates = hit;
  throw err;
}

/* 匯出格式拿到的資料（見 開發筆記 D078）：每天、待處理都給原文和拆好的每一筆，格式自己挑要用哪個。
   擴充、請 AI 寫的匯出格式也是拿這個（AI 的 prompt 拿它組例子），欄位改了 prompt 跟著變。
   days：[{ date, text }]，照日期排好；todo：待辦.md 的文字，匯出全部才給。回傳：
   { title, from, to（第一天、最後一天）, all（是不是「匯出全部」）,
     days：[{ date, weekday（日一二三四五六）, text（原文）, entries }]（沒寫東西的日子不列）, todo：{ text, entries } 或 null }
   entries 每一筆：heads（標題行原文）、title（不含行尾標記和 ^編號；好幾行標題用 \n 接）、
     body（內容一行一行，第一層縮排拿掉、更深的還是 Tab 開頭）、status、hidden、flagged、flagCat、event、codes、types、people、tickets、topics */
function exportData({ title, from, to, all, days, todo }) {
  const entries = text => parseDay(text).map(e => ({
    heads: e.heads.map(h => h.text),
    title: e.title,
    body: e.body.map(b => b.text.replace(/^(\t| {1,4})/, '')),   // 第一層縮排：同 daybook-md.js 的 bodyLine
    status: e.status, hidden: e.hidden, flagged: e.flagged, flagCat: e.flagCat, event: e.event,
    codes: e.codes, types: e.types, people: e.people, tickets: e.tickets, topics: e.topics,
  }));
  return {
    title, from, to, all: !!all,
    days: days.map(d => ({ date: d.date, weekday: md.weekday(d.date), text: d.text, entries: entries(d.text) })).filter(d => d.entries.length),
    todo: todo == null ? null : { text: todo, entries: entries(todo) },
  };
}

module.exports = { FORMATS, EXPORT_FORMATS, pickFormat, formatName, exportData };
