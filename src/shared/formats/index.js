/* ============================================================
   能匯入的格式（見 開發筆記 D047）：一種格式一個模組，在這裡登記。
   每個模組給：label（名稱）、hint（一句話說長怎樣，認不出格式時列給使用者看）、extensions（選檔視窗用）、
   detect(text) → 是不是這種格式、parse(text) → { days: [{ date: 'YYYY-MM-DD', text }], todo: 文字或 null }。
   都是純函式、不碰檔案；寫檔、跳過已有的日子、Ctrl+Z 都在主程序（之後的外部擴充也照這個介面，見 D047）
   ============================================================ */
'use strict';

const FORMATS = [
  require('./daybook-md.js'),    // 標準格式：daybook 自己匯出的（見 D046）
  require('./notepad-txt.js'),   // 舊記事本
];

/* 只有一種格式認得這個檔才用它；都不認得、或兩種以上都認得就報錯，不猜（同 D018） */
function pickFormat(text) {
  const hit = FORMATS.filter(f => f.detect(text));
  if (hit.length === 1) return hit[0];
  if (!hit.length) throw new Error('認不出這個檔的格式。能匯入的有：' + FORMATS.map(f => `${f.label}（${f.hint}）`).join('、'));
  throw new Error(`這個檔同時像${hit.map(f => `「${f.label}」`).join('和')}，分不出要用哪一種`);
}

module.exports = { FORMATS, pickFormat };
