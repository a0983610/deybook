/* ============================================================
   畫面上的匯入要寫哪些（見 開發筆記 D044、D047、D055、D063）：認格式 → 拆成每天＋待處理 → 分出資料夾裡已經有的；
   已經有的要「加進去」時一筆一筆比，一模一樣的不再加。
   純函式、不碰檔案。各種格式怎麼拆在 formats/（D047）；外部擴充在獨立程序跑，由主程序傳進來（D055）。
   放在 src/ 底下：打包只收 src/，exe 裡才有（見 D040）
   ============================================================ */
'use strict';
const { TODO_FILE, ISO_DATE_RE, dayPath } = require('./paths.js');
const { pickFormat } = require('./formats/index.js');
const { parseDay } = require('./parser.js');
const { L } = require('./i18n.js');

/* 擴充拆出來的結果先檢查（見 開發筆記 D055）：擴充是別人寫的，日期、型別不對就整批不寫。
   換行一律 \n、有字的結尾補一個 \n（同 D018） */
function checkParsed(r) {
  const bad = msg => { throw new Error(L('擴充拆出來的資料不對：{why}', { why: msg })); };
  const lf = t => { t = t.replace(/\r\n?/g, '\n'); return t === '' || t.endsWith('\n') ? t : t + '\n'; };
  const validDate = s => {
    if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  if (!r || !Array.isArray(r.days)) bad(L('要回傳 { days: [{ date, text }], todo }'));
  const seen = new Set();
  const days = r.days.map((d, i) => {
    if (!d || !validDate(d.date)) bad(L('第 {n} 天的日期 {date} 不是有效的 YYYY-MM-DD', { n: i + 1, date: JSON.stringify(d && d.date) }));
    if (seen.has(d.date)) bad(L('{date} 出現兩次', { date: d.date }));
    seen.add(d.date);
    if (typeof d.text !== 'string') bad(L('{date} 的內容不是文字', { date: d.date }));
    return { date: d.date, text: lf(d.text) };
  });
  if (r.todo != null && typeof r.todo !== 'string') bad(L('todo 要是文字或 null'));
  return { days, todo: r.todo ? lf(r.todo) : null };
}

/* - 資料夾裡已經有內容的日子、待辦.md 分出來，要加進去還是略過由呼叫的地方問（見 開發筆記 D063）
   exists(相對路徑) → 資料夾裡那個檔是不是已經有內容
   ext：外部擴充（main/extensions.js 的 startHost），沒有啟用的就是 null：
     ext.formats 格式清單、ext.detect(text) → 每一種認不認得、ext.parse(format, text) → 拆出來的結果
   choose(認得的那幾種) → 兩種以上都認得時用哪一種（見 開發筆記 D058）；回 null 是使用者取消，planImport 也回 null。沒給就照舊報錯
   回傳 { format: 格式名稱, formatFile: 擴充的程式檔（內建是 null；AI 寫的擴充試跑時看選中的是不是它，D056）,
         days: 檔案裡全部的日子 [{ date, text }], write: 資料夾裡還沒有的日子, existing: 資料夾裡已經有的日子,
         todo: 檔案裡的待處理文字（沒有是 null）, todoExisting: 待辦.md 已經有內容 } */
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
  const write = [], existing = [];
  for (const d of days) (exists(dayPath(d.date)) ? existing : write).push(d);
  return {
    format: format.ext ? L('{format}，擴充「{ext}」', { format: format.label, ext: format.ext }) : L(format.label),
    formatFile: format.file || null,
    days, write, existing, todo, todoExisting: !!todo && exists(TODO_FILE),
  };
}

/* 「加進去」（見 開發筆記 D063）：have 是資料夾裡那天（或待辦.md）原本的文字，text 是匯入檔裡的。
   一筆一筆比（parseDay 拆出的一筆＝標題＋內容）：have 已經有一模一樣的就不加，同樣的有兩筆就抵兩筆；其他照原本的順序接在最後面。
   比的時候每行行尾的空白不算：新增卡片時檔尾的空白會被收掉（entries.js 的 appendLines）。
   接上去之後每一筆都要跟原本一樣：前一筆只有標題、後面又是標題，可能被當成連續標題共用內容（D009），就隔一行空行；
   隔了還是黏在一起（例如開頭的內容沒有標題，會變成上一筆的內容）就報錯，整批不寫。
   where：報錯時寫是哪裡（日期或「待處理」）。回傳 { text: 加完的文字（沒加就是 have）, added: 加了幾筆, dup: 幾筆一模一樣沒加 } */
function mergeEntries(have, text, where) {
  const pieces = t => { const lines = t.split(/\r?\n/); return parseDay(t).map(e => lines.slice(e.start, e.end + 1).join('\n')); };
  const key = raw => raw.split('\n').map(l => l.trimEnd()).join('\n');
  const keysOf = t => pieces(t).map(key);
  const want = keysOf(have);
  const left = new Map();   // have 的每一筆還能抵掉幾筆
  for (const k of want) left.set(k, (left.get(k) || 0) + 1);
  const incoming = pieces(text);
  let out = have.replace(/\s+$/, ''), added = 0;
  for (const raw of incoming) {
    const k = key(raw), n = left.get(k) || 0;
    if (n) { left.set(k, n - 1); continue; }
    want.push(k);
    const next = (out ? [out + '\n', out + '\n\n'] : ['']).map(t => t + raw)
      .find(t => { const got = keysOf(t); return got.length === want.length && got.every((g, i) => g === want[i]); });
    if (next == null) throw new Error(L('{where} 加不進去：「{head}」接在後面會跟上一筆黏在一起（例如開頭的內容沒有標題）。這次可以改選「略過」', { where, head: raw.split('\n')[0].trim() }));
    out = next;
    added++;
  }
  return { text: added ? out + '\n' : have, added, dup: incoming.length - added };
}

module.exports = { planImport, checkParsed, mergeEntries };
