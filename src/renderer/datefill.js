/* ============================================================
   暫存內文裡的日期符號（見 開發筆記 D094）：複製時把 {yyyy.MM.dd HH:mm} 換成當下的日期時間。
   - 大括號裡的英文字母要整段都是認得的符號（照 C# 的日期格式，大小寫有分）才算：
     yyyy 年、yy 年兩碼、MM 月、M 月不補零、dd 日、d 日不補零、HH 時（24 小時）、H 時不補零、mm 分、ss 秒
   - 其他字（標點、空白、中文、數字）照原樣：{yyyy年M月d日} → 2026年10月29日
   - 有別的英文字、或一個符號都沒有的照原樣不動：{0}、{ get; set; }、{MMM}、{m}、{}
   - 大括號不能跨行
   純函式、不碰 DOM。畫面用 <script> 載入（全域的 dateSegments、fillDates）；測試用 require
   ============================================================ */
'use strict';

const DATE_TOKENS = {
  yyyy: d => String(d.getFullYear()).padStart(4, '0'),
  yy: d => String(d.getFullYear() % 100).padStart(2, '0'),
  MM: d => String(d.getMonth() + 1).padStart(2, '0'),
  M: d => String(d.getMonth() + 1),
  dd: d => String(d.getDate()).padStart(2, '0'),
  d: d => String(d.getDate()),
  HH: d => String(d.getHours()).padStart(2, '0'),
  H: d => String(d.getHours()),
  mm: d => String(d.getMinutes()).padStart(2, '0'),
  ss: d => String(d.getSeconds()).padStart(2, '0'),
};

/* 切成一段一段：{ text, date }，date 是 true 的那段是日期符號（含大括號）；接起來就是原文 */
function dateSegments(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(/\{([^{}\n]*)\}/g)) {
    const runs = m[1].match(/([A-Za-z])\1*/g);   // 同一個字母連在一起算一個符號：yyyy、MM、d…
    if (!runs || !runs.every(r => Object.hasOwn(DATE_TOKENS, r))) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index), date: false });
    out.push({ text: m[0], date: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), date: false });
  return out;
}

/* 日期符號換成 now 的日期時間，其他照原樣 */
function fillDates(text, now) {
  return dateSegments(text).map(p => (p.date ? p.text.slice(1, -1).replace(/([A-Za-z])\1*/g, r => DATE_TOKENS[r](now)) : p.text)).join('');
}

if (typeof module === 'object' && module.exports) module.exports = { dateSegments, fillDates };
