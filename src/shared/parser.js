/* ============================================================
   daybook 解析器：把一天的文字拆成條目，從標題抓代號／類型／人名／工單號／主題／狀態
   純函式、不碰檔案；main process、匯入腳本、測試共用。
   規則來源：見 開發筆記 D005、D006、D007、D008、D009、D017
   ============================================================ */
'use strict';

const STATUSES = ['待處理', '待回覆', '完成'];          // 見 開發筆記 D006
const TYPE_WORDS = ['BUG', 'BB', '規格調整', '新程式'];   // 見 開發筆記 D009

/* 行的種類（見 開發筆記 D005、D008）
   blank：空的或只有空白字元
   body ：Tab 或空白縮排；或沒縮排但「數字＋.」開頭（舊檔 L1663～L1665 那種）
   head ：其他 */
function lineKind(line) {
  if (line.trim() === '') return 'blank';
  if (/^\s/.test(line)) return 'body';
  if (/^\d+\./.test(line)) return 'body';
  return 'head';
}

/* 狀態只認標題行最後面的那三個詞（見 開發筆記 D006） */
const STATUS_RE = new RegExp('\\s*\\[(' + STATUSES.join('|') + ')\\]\\s*$');

/* 工單號：W/B/P ＋ 2～5 碼員工代號 ＋ 8 碼日期 ＋ 3 碼流水號，可帶 -N（見 開發筆記 D017） */
const TICKET_RE = /(?<![A-Za-z0-9])[WBP][A-Za-z0-9]{2,5}20\d{6}\d{3}(?:-\d+)?(?!\d)/g;

/* 程式代號（見 開發筆記 D017）
   開頭那個英數詞：4 字以上、含大寫或數字（排掉 mail、update 這種全小寫英文字）
   其他位置：要長得像代號——英文接 3 位以上數字（CWIN301020、eWCH3050），或中間有底線（TX_GetInvoiceNumber）
   兩種都排掉：連續 8 位以上數字（發票號碼、工單號、單號）、底線開頭或結尾（CPAAPP_ 這種名稱片段） */
function isCodeToken(tok, atStart) {
  if (tok.length < 4 || !/^[A-Za-z]/.test(tok)) return false;
  if (/\d{8,}/.test(tok) || /^_|_$/.test(tok)) return false;
  if (atStart) return /[A-Z0-9]/.test(tok);
  return /^[A-Za-z]{2,}\d{3,}[A-Za-z0-9]*$/.test(tok) || /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]$/.test(tok);
}

/* 人名：「兩個中文字＋問題」，前面要是行首、空白、英文或「看／查」（見 開發筆記 D017）
   「稅額修改問題」的「修改」前面是中文，不算 */
const PERSON_RE = /(?:^|[\sA-Za-z\-看查])([一-鿿]{2})\s*問題/g;

/* 從一行標題抓出所有資訊 */
function headMeta(text) {
  const m = text.match(STATUS_RE);
  const status = m ? m[1] : null;
  const title = m ? text.slice(0, m.index) : text;

  const tickets = [...title.matchAll(TICKET_RE)].map(x => x[0]);

  // 方括號裡的是欄位名（[MF10159]），不算代號
  const scan = title.replace(/\[[^\]]*\]/g, ' ');
  const codes = [];
  for (const x of scan.matchAll(/[A-Za-z0-9_]+/g)) {
    const atStart = x.index === scan.search(/\S/);
    if (isCodeToken(x[0], atStart) && !codes.some(c => c.toUpperCase() === x[0].toUpperCase())) codes.push(x[0]);
  }

  const types = TYPE_WORDS.filter(w => /^[A-Z]+$/.test(w)
    ? new RegExp('(?<![A-Za-z])' + w + '(?![A-Za-z])', 'i').test(title)
    : title.includes(w));

  const people = [];
  for (const x of title.matchAll(PERSON_RE)) if (!people.includes(x[1])) people.push(x[1]);

  const topics = [...title.matchAll(/#([^\s#\[\]]+)/g)].map(x => x[1]);

  return { title: title.trimEnd(), status, codes, types, people, tickets, topics };
}

/* 光頭標題：只有代號＋程式名稱（見 開發筆記 D009）
   行首就是代號、沒有類型字、沒有「XX問題」人名、扣掉代號剩下的字沒有句讀，而且每支代號平均不超過 20 字 */
function isBareHead(meta) {
  if (!meta.codes.length || meta.types.length || meta.people.length) return false;
  const t = meta.title.trim();
  if (!t.startsWith(meta.codes[0])) return false;
  let rest = t;
  for (const c of meta.codes) rest = rest.split(c).join(' ');
  rest = rest.replace(/\s+/g, ' ').trim();
  if (/[，。：:；;！!？?「」『』"、]/.test(rest)) return false;
  return rest.length <= 20 * meta.codes.length;
}

/* 把一天的文字拆成條目
   每筆：heads（標題行，含 line＝這天第幾行、0 起算）、body（內容行）、
         以及從標題彙整的 codes／types／people／tickets／topics／status、results（-> 開頭的內容） */
function parseDay(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let run = [];          // 連續的標題行，還沒接到內容
  let cur = null;        // 正在收內容的那一筆
  let sawBlank = false;

  const flushRun = () => { for (const h of run) entries.push(makeEntry([h])); run = []; };

  lines.forEach((text, line) => {
    const kind = lineKind(text);
    if (kind === 'blank') { sawBlank = true; return; }
    if (kind === 'head') {
      if (sawBlank && run.length) flushRun();       // 空行隔開的標題不算連續
      cur = null;
      run.push({ text, line, meta: headMeta(text) });
      sawBlank = false;
      return;
    }
    sawBlank = false;
    if (run.length) {
      /* 誰共用這段內容（見 開發筆記 D009）：
         緊貼內容的那行一定拿；它是光頭的話，往上連續的光頭也一起拿，遇到不是光頭的就停 */
      let k = run.length - 1;
      if (isBareHead(run[k].meta)) while (k > 0 && isBareHead(run[k - 1].meta)) k--;
      for (let j = 0; j < k; j++) entries.push(makeEntry([run[j]]));
      cur = makeEntry(run.slice(k));
      entries.push(cur);
      run = [];
    } else if (!cur) {
      cur = makeEntry([]);   // 前面沒有標題的內容：不丟，掛在一筆沒標題的條目上
      entries.push(cur);
    }
    cur.body.push({ text, line });
  });
  flushRun();

  for (const e of entries) e.results = e.body.map(b => b.text.trim()).filter(t => t.startsWith('->'));
  return entries;
}

function makeEntry(heads) {
  const uniq = arr => [...new Set(arr)];
  const pick = k => uniq(heads.flatMap(h => h.meta[k]));
  const withStatus = heads.filter(h => h.meta.status);
  return {
    heads: heads.map(h => ({ text: h.text, line: h.line })),
    title: heads.map(h => h.meta.title.trim()).join('\n'),
    status: withStatus.length ? withStatus[withStatus.length - 1].meta.status : null,
    codes: pick('codes'),
    types: pick('types'),
    people: pick('people'),
    tickets: pick('tickets'),
    topics: pick('topics'),
    body: [],
  };
}

module.exports = { STATUSES, TYPE_WORDS, lineKind, headMeta, isBareHead, parseDay };
