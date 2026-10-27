/* ============================================================
   能匯入的格式（見 開發筆記 D047）：一種格式一個模組，在這裡登記。
   每個模組給：label（名稱）、hint（一句話說長怎樣，認不出格式時列給使用者看）、extensions（選檔視窗用）、
   detect(text) → 是不是這種格式、parse(text) → { days: [{ date: 'YYYY-MM-DD', text }], todo: 文字或 null }。
   都是純函式、不碰檔案；寫檔、跳過已有的日子、Ctrl+Z 都在主程序（外部擴充也照這個介面，見 D055）
   ============================================================ */
'use strict';

const FORMATS = [
  require('./daybook-md.js'),    // 標準格式：daybook 自己匯出的（見 D046）
  require('./notepad-txt.js'),   // 舊記事本
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
  const err = new Error(`這個檔同時像${hit.map(formatName).join('和')}，分不出要用哪一種` + (hit.some(f => f.ext) ? '；可以到右上角「匯入格式」停用擴充' : ''));
  err.candidates = hit;
  throw err;
}

module.exports = { FORMATS, pickFormat, formatName };
