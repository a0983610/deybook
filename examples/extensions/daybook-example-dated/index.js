/* ============================================================
   daybook 格式擴充的範例（教學用）：同一種格式能匯入、也能匯出
   格式：一行「=== 2026-10-27 ===」隔開每一天，「=== 待處理 ===」之後是待處理，例如 sample.txt。
   怎麼裝、package.json 每個欄位的意思：見 daybook 的 README〈寫格式擴充〉。

   匯入給兩個函式，都只看傳進來的文字、不碰檔案：
   - detect(text) → true／false：是不是這種格式。daybook 會問每一種格式，只有一種說是才用它，
     所以要認得出跟別的格式的差別（daybook Markdown 第一行是「# 」、舊記事本有「1/5」這種日期行）
   - parse(text) → { days: [{ date: 'YYYY-MM-DD', text: 那天的內容 }], todo: 待處理的內容或 null }
     內容照 daybook 每日檔的寫法：沒縮排的行是標題、Tab 縮排的是內容。格式不對就丟 Error，訊息會顯示給使用者看。
     日期是不是真的日期、有沒有重複、換行，daybook 拿到後會再檢查，這裡只管拆。
   匯出給一個函式：
   - write(data) → 整個檔案的內容：文字回字串（daybook 用 UTF-8 存），二進位檔回 Uint8Array。
     data 是 daybook 給的：days 每天有 date、weekday、text（原文）、entries（拆好的每一筆）；todo 匯出全部才有，不然是 null
   ============================================================ */
'use strict';

const MARK_RE = /^===\s*(\d{4}-\d{2}-\d{2}|待處理)\s*===\s*$/;

function detect(text) {
  return text.split(/\r?\n/).some(l => MARK_RE.test(l));
}

function parse(text) {
  const days = [];
  let todo = null;
  let cur = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(MARK_RE);
    if (m) {
      cur = [];
      if (m[1] !== '待處理') days.push({ date: m[1], lines: cur });
      else if (todo) throw new Error(`第 ${i + 1} 行：「=== 待處理 ===」出現兩次`);
      else todo = cur;
      return;
    }
    if (cur) cur.push(line);
    else if (line.trim() !== '') throw new Error(`第 ${i + 1} 行：第一個「=== 日期 ===」之前就有內容`);
  });
  // 每一段去掉頭尾的空行
  const body = lines => {
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n') + '\n';
  };
  return { days: days.map(d => ({ date: d.date, text: body(d.lines) })), todo: todo ? body(todo) : null };
}

/* parse 的反方向：每天一行「=== 日期 ===」接那天的原文，最後是待處理；段跟段之間空一行。匯出再匯入，內容一樣 */
function write(data) {
  const out = [];
  for (const d of data.days) out.push(`=== ${d.date} ===`, d.text.replace(/\n+$/, ''), '');
  if (data.todo && data.todo.entries.length) out.push('=== 待處理 ===', data.todo.text.replace(/\n+$/, ''), '');
  return out.join('\n');
}

/* key 是 package.json 裡 contributes.importFormats、exportFormats 的 id：同一個 id 兩邊都列，就是這種格式能匯入也能匯出 */
module.exports = { formats: { 'dated-txt': { detect, parse, write } } };
