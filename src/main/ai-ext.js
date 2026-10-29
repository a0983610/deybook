/* ============================================================
   請別的 AI（Gemini、ChatGPT）寫格式擴充（見 開發筆記 D056；匯出格式見 D079）：
   - buildPrompt／buildExportPrompt：給 AI 的 prompt（匯入／匯出），寫明擴充的規格、要回什麼、哪些字不能用
   - checkReply：AI 回的那一段先檢查、不執行——拆出 package.json 和 index.js，看欄位、語法（只編譯）、禁用的字
   - tryRun：匯入格式檢查過了才在獨立程序拿使用者的檔試跑，跟真的匯入同一條路（認格式、拆、checkParsed）
   - tryExport：匯出格式檢查過了才在獨立程序拿使用者的紀錄試跑匯出，跟真的匯出同一條路
   - buildFeedback：沒通過時「複製給 AI」的那段，貼回給 AI 改（D061）
   禁用的字擋得住一般寫法裡讀寫檔案、連網路的程式，擋不住刻意繞過的（例如把字拆開再拼），
   所以安裝前還是要讓使用者看過提醒再按（同 D055）
   ============================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const exts = require('./extensions.js');
const imp = require('../shared/import.js');
const { FORMATS, formatName, exportData } = require('../shared/formats/index.js');

const PKG_MARK = '===== package.json =====';
const CODE_MARK = '===== index.js =====';
const markRe = file => new RegExp(`^\\s*=+\\s*${file.replace('.', '\\.')}\\s*=+\\s*$`);
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/* 程式和註解裡都不能出現的字：拿得到 require、process、全域物件、動態產生程式、連網路的路 */
const BANNED = ['require', 'import', 'process', 'eval', 'Function', 'constructor', '__proto__', 'globalThis', 'global', 'arguments', 'fetch', 'WebSocket'];
const SAMPLE_LINES = 12;   // 預覽每一天最多列幾行
const EXCERPT_LINES = 20;  // 試跑錯誤附給 AI 看的檔案開頭，最多幾行有字的（見 開發筆記 D061）
const HEAD_LINES = 30;     // 匯出試跑的預覽：文字列開頭幾行（D079）
/* 這次要 AI 寫哪一種（D079）：package.json 的 contributes 要列哪一個、不能列哪一個 */
const KINDS = {
  import: { name: '匯入', list: 'importFormats', other: 'exportFormats' },
  export: { name: '匯出', list: 'exportFormats', other: 'importFormats' },
};

function buildPrompt(appVersion) {
  const pkg = {
    name: '英文小寫、數字、- 組成，例如 my-weekly-txt',
    displayName: '給人看的名稱',
    version: '1.0.0',
    main: 'index.js',
    engines: { daybook: '^' + appVersion },
    contributes: { importFormats: [{ id: '英文小寫、數字、- 組成', label: '格式名稱', hint: '一句話說這種格式長怎樣', extensions: ['txt'] }] },
  };
  // 「轉換」「年份」「認不得的行」和 daybook 怎麼認內容行，是拿 subagent 扮外部 AI 實測後補的：AI 會問、使用者答不出來的寫進來（見 開發筆記 D059）
  return [
    '請幫我寫一個 daybook 的「匯入格式擴充」，把我的舊紀錄檔拆成 daybook 一天一份的紀錄。',
    '我的檔案開頭貼在最後面。看不出規則的地方先問我，不要猜；只看開頭判斷不了的（例如跨年那段、檔案結尾、有縮排的段落），告訴我要再貼哪一段。',
    '',
    '【daybook 一天的紀錄怎麼寫】',
    '- 一天一份純文字。沒縮排的行是「標題」（一件事），底下縮排的行是那件事的內容；縮排用 Tab，每深一層多一個 Tab',
    '- daybook 把空白（半形、全形）或 Tab 開頭的行都當成內容；沒縮排、但「數字.」開頭的行（例如「1. 」）也當成內容，不是標題',
    '- 內容裡「->」開頭的行是處理結果；標題行最後面的「[待回覆]」表示在等別人回覆',
    '- 另外有一份「待處理」：還沒做完的事，寫法一樣，不分哪一天',
    '',
    '【轉換：可以改結構，不能改內容】',
    '- 可以做：拿掉清單符號（例如「- 」「* 」「- [x] 」「1. 」）、縮排換成 Tab、別的箭頭（例如「→」「=>」）換成「->」、',
    '  我的檔案裡表示「等回覆」的記號換成標題行尾的「[待回覆]」、日期行和分隔線不放進內容、日子跟日子之間的空行丟掉',
    '- 每一種轉換都要先問我、我同意了才做；沒問過的一律照原文抄',
    '- 不能做：改字、摘要、合併或刪掉重複的行、調順序、自己加標題',
    '',
    '【年份】',
    '- 檔案裡有寫年份就照檔案',
    '- 沒寫年份：問我從哪一年開始，寫成程式最上面的常數（註解寫這是起始年份）',
    '- 只有「12 月之後接 1 月」算跨年；其他日期往回跳（例如 11/5 後面出現 10/6）、同一天出現兩次，都丟錯，不要猜',
    '',
    '【認不得的行】',
    '- 碰到認不得的行（例如日期後面多了字的「1/5 (一)」「1/6請假」、不該縮排的地方縮排了），一律丟錯，不要猜',
    '- 錯誤訊息一行一個問題，寫「第 N 行：那行原文：哪裡不對」，一次列完（太多就列前 20 個，再寫還有幾個）；我會整段貼回來給你改',
    '',
    '【你要回什麼】',
    '回一個程式碼區塊，裡面照順序放兩個檔，用下面這兩行隔開（照抄，不要改）；區塊外面可以用幾行寫你做了哪些假設、要注意什麼：',
    PKG_MARK,
    '（package.json 的內容）',
    CODE_MARK,
    '（index.js 的內容）',
    '',
    '【package.json】',
    JSON.stringify(pkg, null, 2),
    '',
    '【index.js】',
    'module.exports = { formats: { "<上面的 id>": { detect, parse } } };',
    '- detect(text)：傳進整份檔的文字，回 true／false，是不是這種格式。daybook 還有別的格式（內建的和我裝的擴充），兩種以上都說是時會問我這次要用哪一種，',
    '  所以跟別的格式像也沒關係；但不要寬到連別種檔都認，不然我每次匯入都會被問。內建的格式：',
    '  - daybook Markdown（daybook 自己匯出的）：第一行有字的是「# 」開頭，有「## 2026-01-05」這種日期標題',
    '- parse(text)：傳進整份檔的文字，回 { days: [{ date: "YYYY-MM-DD", text: "那天的內容" }], todo: "待處理的內容" 或 null }',
    '  - 同一天只能出現一次，日期要是真的日期',
    '  - 格式不對就 throw new Error(...)（寫法照上面【認不得的行】），這段訊息會給我看',
    '',
    '【限制：daybook 會先檢查，不合就不收】',
    '- 只做文字處理：不讀寫檔案、不連網路、不用 async／Promise，10 秒內要跑完',
    '- 程式和註解裡都不能出現這些字（大小寫一樣才算，function 可以用）：' + BANNED.join('、'),
    '- 註解用繁體中文',
    '',
    '【我的檔案開頭】',
    '',
  ].join('\n');
}

/* 匯出格式的 prompt（見 開發筆記 D079）：write(data) 拿到什麼用 exportData 對一份虛構的紀錄組出來（D065），欄位改了這裡跟著變 */
const EXPORT_SAMPLE = {
  title: '工作紀錄 2026-03-02 ～ 2026-03-03', from: '2026-03-02', to: '2026-03-03', all: true,
  days: [
    { date: '2026-03-02', text: '準備下週簡報資料 ^3 [標記:等客戶]\n\t1.整理數據\n\t\t先列大綱\n\t->先寄初稿給主管\n' },
    { date: '2026-03-03', text: 'XYZ2010 訂單查詢 BUG\n\t查詢條件少了日期\n\t->改好了\n' },
  ],
  todo: '週會紀錄 [待回覆]\n\t->03/03 等主管回覆\n',
};
function buildExportPrompt(appVersion) {
  const pkg = {
    name: '英文小寫、數字、- 組成，例如 my-weekly-csv',
    displayName: '給人看的名稱',
    version: '1.0.0',
    main: 'index.js',
    engines: { daybook: '^' + appVersion },
    contributes: { exportFormats: [{ id: '英文小寫、數字、- 組成', label: '格式名稱', hint: '一句話說這種格式長怎樣', extension: '副檔名，不含「.」，例如 csv' }] },
  };
  return [
    '請幫我寫一個 daybook 的「匯出格式擴充」，把 daybook 的工作紀錄轉成我要的檔案。',
    '我要的檔案長怎樣寫在最後面。看不出規則的地方（例如要哪些欄位、什麼順序、日期怎麼寫、待處理要不要）先問我，不要猜。',
    '',
    '【daybook 的紀錄長怎樣】',
    '- 一天一份純文字。沒縮排的行是「標題」（一件事），底下 Tab 縮排的行是那件事的內容，每深一層多一個 Tab',
    '- 內容裡「->」開頭的行是處理結果',
    '- 標題行最後面可能有：^數字（事件編號，跨好幾天的同一件事用同一個號碼）、[隱藏]、[標記] 或 [標記:分類]（還要注意的事）、[待回覆]（在等別人回覆）',
    '- 好幾行標題可能共用底下同一段內容，算一筆',
    '- 另外有一份「待處理」：還沒做完的事，寫法一樣，不分哪一天',
    '',
    '【匯出時 daybook 給你什麼】',
    'write(data) 拿到的 data 長這樣（例子，紀錄是虛構的）：',
    JSON.stringify(exportData(EXPORT_SAMPLE), null, 2),
    '- title：建議的標題；from、to：第一天、最後一天；all：是不是「匯出全部」',
    '- days：照日期排，舊的在前；沒寫東西的日子不列。weekday 是星期幾（日一二三四五六）',
    '- text 是那天的原文；entries 是 daybook 拆好的每一筆，要用哪一個都可以',
    '- heads：標題行原文（含行尾那些標記）；title：標題，不含行尾標記和 ^編號，好幾行標題用換行接起來',
    '- 那天最前面的內容如果沒有標題，會是一筆 heads 是 []、title 是空字串的，照樣要匯出、不要丟錯',
    '- body：內容一行一行，第一層縮排已經拿掉，更深的還是 Tab 開頭',
    '- status：狀態的字（例如「待回覆」），沒有是 null；hidden：有沒有 [隱藏]；flagged、flagCat：有沒有標記、標記的分類（沒分類是 null）；event：事件編號，沒有是 null',
    '- codes、types、people、tickets、topics：daybook 從標題自動抓的程式代號、類型、人名、工單號、#主題',
    '- todo：使用者按「匯出全部」才有，不然是 null',
    '',
    '【轉換】',
    '- 照我說的挑欄位、排版；我沒說的，字照原文，不要摘要、改字、調順序',
    '- 每一種取捨先問我、我同意了才做',
    '',
    '【你要回什麼】',
    '回一個程式碼區塊，裡面照順序放兩個檔，用下面這兩行隔開（照抄，不要改）；區塊外面可以用幾行寫你做了哪些假設、要注意什麼：',
    PKG_MARK,
    '（package.json 的內容）',
    CODE_MARK,
    '（index.js 的內容）',
    '',
    '【package.json】',
    JSON.stringify(pkg, null, 2),
    '',
    '【index.js】',
    'module.exports = { formats: { "<上面的 id>": { write } } };',
    '- write(data)：回整個檔案的內容。文字檔回字串（daybook 用 UTF-8 存）；二進位檔回 Uint8Array（daybook 照位元組存）',
    '- 要給 Excel 開的 CSV：字串最前面加 "\\uFEFF"，不然 Excel 會把中文當亂碼；欄位裡有逗號、雙引號、換行的，整個欄位用雙引號包起來、裡面的雙引號寫兩次',
    '  Excel 開 CSV 時「=」開頭的格子會變成公式；「->」開頭的照字顯示，不用處理（前面加「\'」反而會連「\'」一起顯示出來）',
    // 要 Excel 時 AI 不必自己組 zip：回表格、daybook 用內建的組（見 開發筆記 D086）
    '- 要 Excel（.xlsx）：不要自己組檔，write 回 { sheets: [...] }，daybook 用內建的 Excel 組成 .xlsx；package.json 的 extension 寫 xlsx',
    '  例：return { sheets: [{ name: "工作紀錄", columns: [["日期", 11], ["標題", 36]], rows: [[{ date: "2026-03-02" }, "準備下週簡報資料"]] }] };',
    '  - 一張工作表 { name, columns, rows }：name 1～31 個字、不能有 \\ / ? * [ ] :、不能重複；columns 是 [欄名, 欄寬]，欄寬 1～255（約幾個半形字寬）；rows 一列一個陣列，照 columns 的順序，最多跟 columns 一樣多格',
    '  - 一格可以是：文字、數字、{ date: "YYYY-MM-DD" }（存成 Excel 的日期，篩選、排序照日期；那欄寬至少 11，不然 Excel 顯示 ####）、null 或 ""（空的）；文字照字顯示，「=」開頭也不會變公式',
    '  - 第一列是欄名（粗體、凍結），整張可以篩選；格子靠上、文字自動換行，一格裡要換行用 "\\n"（Tab 在格子裡看不出來）',
    '  - daybook 內建的 Excel 是一筆一列：日期｜星期｜標題｜內容｜狀態｜標記｜事件｜代號（匯出全部時待處理另一張），跟我要的一樣就不用寫',
    '- 資料有問題就 throw new Error(...)，這段訊息會給我看',
    '',
    '【限制：daybook 會先檢查，不合就不收】',
    '- 只做文字處理：不讀寫檔案、不連網路、不用 async／Promise，10 秒內要跑完',
    '- 程式和註解裡都不能出現這些字（大小寫一樣才算，function 可以用）：' + BANNED.join('、'),
    '- 註解用繁體中文',
    '',
    '【我要的檔案長怎樣】',
    '',
  ].join('\n');
}

/* 檔案開頭有字的行，寫行號、原文用 JSON 字串（看得出 Tab、空白）。detect 不認得、parse 什麼都沒拆出來時，
   AI 只看過使用者貼的開頭，錯誤訊息本身給不了線索，附這段給它看（見 開發筆記 D061）。行號跟 parse 拿到的一樣（BOM 不算） */
function excerpt(text) {
  return String(text).replace(/^﻿/, '').split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => l.trim())
    .slice(0, EXCERPT_LINES).map(([n, l]) => `第 ${n} 行：${JSON.stringify(l)}`);
}

/* 檢查、試跑沒通過時「複製給 AI」的那段（見 開發筆記 D061）：哪一步沒過、每一條問題、檔案開頭（有的話）、請 AI 回完整的兩個檔。
   r：ai:try 回的 { kind, stage, errors, excerpt }；匯出格式（kind 'export'，D079）試跑的是拿我的紀錄匯出 */
function buildFeedback({ kind, stage, errors, excerpt: lines }) {
  return [
    stage === 'check' ? '我把你寫的擴充貼進 daybook，檢查沒通過（daybook 先檢查、還沒執行程式）：'
      : kind === 'export' ? '我把你寫的擴充貼進 daybook，拿我的紀錄試跑匯出沒通過：' : '我把你寫的擴充貼進 daybook，拿我的整份檔試跑沒通過：',
    ...errors.map(e => '- ' + String(e).replace(/\n/g, '\n  ')),
    ...(lines && lines.length ? ['', '我的檔案開頭（有字的行；"" 裡是原文，\\t 是 Tab）：', ...lines] : []),
    '',
    `請照上面改好，照原本的格式回完整的兩個檔（用「${PKG_MARK}」「${CODE_MARK}」兩行隔開），不要只回改的地方。`,
    '如果是我的檔案本身有例外的寫法、你不確定怎麼處理，先問我，不要猜。',
  ].join('\n');
}

/* AI 回的那一段拆成 package.json 和 index.js 的文字。整則回覆照貼（前後有說明、有 ```）也行；
   index.js 從分隔線下一行算第 1 行（開頭的 ``` 那行不算），錯誤訊息的行號照這個 */
function splitReply(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const p = lines.findIndex(l => markRe('package.json').test(l));
  const c = lines.findIndex(l => markRe('index.js').test(l));
  if (p < 0 || c < p) throw new Error(`找不到「${PKG_MARK}」「${CODE_MARK}」這兩行分隔線（要照這個順序）：請 AI 照 prompt 的格式重回一次`);
  const fence = l => /^\s*```/.test(l);
  let code = lines.slice(c + 1);
  if (code.length && fence(code[0])) code = code.slice(1);
  const end = code.findIndex(fence);
  if (end >= 0) code = code.slice(0, end);
  return {
    pkgText: lines.slice(p + 1, c).filter(l => !fence(l)).join('\n'),
    code: code.join('\n').replace(/\s+$/, '') + '\n',
  };
}

/* 先檢查、不執行（見 開發筆記 D056）。回傳 { errors: [每一條問題], manifest, pkg: 要寫的 package.json, code }；
   有錯時 pkg 是 null。kind：這次寫的是 'import' 匯入格式還是 'export' 匯出格式（D079），一次只寫一種，試跑才知道要怎麼跑 */
function checkReply(text, appVersion, kind = 'import') {
  let parts;
  try { parts = splitReply(text); } catch (e) { return { errors: [e.message], manifest: null, pkg: null, code: null }; }
  const errors = [];
  let pkg = null, m = null;
  try { pkg = JSON.parse(parts.pkgText); } catch (e) { errors.push('package.json 不是正確的 JSON：' + e.message); }
  if (pkg) {
    const k = KINDS[kind], c = pkg.contributes || {};
    if (!Array.isArray(c[k.list]) || !c[k.list].length) errors.push(`這次要寫的是${k.name}格式：package.json 的 contributes 要有 ${k.list}`);
    if (c[k.other] != null) errors.push(`這次要寫的是${k.name}格式：package.json 的 contributes 不要有 ${k.other}`);
    try {
      m = exts.checkManifest(pkg);
      if (!NAME_RE.test(m.name)) errors.push('package.json 的 name 只能用英文小寫、數字、-（會拿來當資料夾名稱）');
      if (m.main !== 'index.js') errors.push('package.json 的 main 要是 index.js');
      if (!exts.compatible(m.range, appVersion)) errors.push(`package.json 的 engines.daybook 是 ${m.range}，跟現在的 daybook ${appVersion} 不相容，要寫 ^${appVersion}`);
    } catch (e) {
      errors.push(e.message);
      m = null;
    }
  }
  try {
    new vm.Script(parts.code, { filename: 'index.js' });   // 只編譯、不執行
  } catch (e) {
    const at = /index\.js:(\d+)/.exec(e.stack || '');
    errors.push(`index.js ${at ? `第 ${at[1]} 行` : ''}語法錯誤：${e.message}`);
  }
  parts.code.split('\n').forEach((l, i) => {
    for (const w of BANNED) {
      if (new RegExp(`\\b${w}\\b`).test(l)) errors.push(`index.js 第 ${i + 1} 行有「${w}」：只能做文字處理，這個字不能出現（註解裡也不行）`);
    }
  });
  return { errors, manifest: m, pkg: errors.length ? null : { ...pkg, main: 'index.js' }, code: parts.code };
}

/* 檢查過的擴充拿使用者的檔試跑（見 開發筆記 D056）：已啟用的擴充（同名的舊版除外）＋這一個一起認格式、拆、checkParsed，
   跟真的匯入同一條路。程式先寫到系統暫存區、跑完就刪。
   check：checkReply 沒有錯的結果；list：exts.scan 的結果；extRoot：擴充資料夾；exists：資料夾裡已經有哪些日子（同 planImport）
   回傳 { errors, excerpt: AI 看不出原因時附的檔案開頭（D061） } 或 { folder: 要裝進哪個資料夾（同名的就裝回原本那個）, preview } */
/* 要裝進哪個資料夾：同名的（壞掉的不算）裝回它原本那個、取代它；不然用 name，擴充資料夾裡已經有這個資料夾就不收 */
function target(m, list, extRoot) {
  const old = list.find(x => x.name === m.name && x.state !== 'broken');
  const folder = old ? old.folder : m.name;
  if (!old && fs.existsSync(path.join(extRoot, folder))) return { error: `擴充資料夾裡已經有「${folder}」這個資料夾：請 AI 換一個 name` };
  return { old, folder };
}
/* AI 的程式先寫到系統暫存區（試跑完就刪） */
function tmpCode(code) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-ai-'));
  const file = path.join(tmp, 'index.js');
  fs.writeFileSync(file, code);
  return { tmp, file };
}
const rmTmp = tmp => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

async function tryRun({ check, text, list, extRoot, exists, fork, timeoutMs }) {
  const m = check.manifest;
  const t0 = target(m, list, extRoot);
  if (t0.error) return { errors: [t0.error] };
  const { old, folder } = t0;
  const { tmp, file } = tmpCode(check.code);
  const mine = m.formats.map(f => ({ ...f, ext: m.displayName, file }));
  const host = exts.startHost(fork, [...exts.enabledFormats(list.filter(x => x !== old)), ...mine], timeoutMs);
  // 別的格式也認得時，試跑用 AI 寫的這個；真的匯入時會問使用者（見 開發筆記 D058），預覽先寫還有誰認得
  let plan, also = [];
  const pickMine = hits => { also = hits.filter(f => f.file !== file); return hits.find(f => f.file === file) || null; };
  try {
    // 先看 AI 寫的 detect 認不認得：不認得就停在這裡。不然會拿別的格式去拆，報的錯跟 AI 寫的程式無關
    // （實測：當時內建的舊記事本接手，回的是「沒有 ---年份--- 標記」），AI 照著改會改錯方向（見 開發筆記 D061）
    const t = text.replace(/^﻿/, '');
    const hits = await host.detect(t);
    if (!hits.slice(-mine.length).some(Boolean)) {
      const others = [...FORMATS.filter(f => f.detect(t)), ...host.formats.filter((f, i) => hits[i] && f.file !== file)];
      return { errors: [`AI 寫的 detect 不認得這個檔（${others.length ? `這個檔被認成${others.map(formatName).join('和')}` : '別的格式也都不認得'}）：要認得這個檔`], excerpt: excerpt(text) };
    }
    plan = await imp.planImport(text, exists, host, pickMine);
  } catch (e) {
    return { errors: [e.message] };
  } finally {
    host.kill();
    rmTmp(tmp);
  }
  if (plan.formatFile !== file) return { errors: [`這個檔被認成「${plan.format}」，不是 AI 寫的格式：AI 寫的 detect 要認得這個檔`] };
  // AI 看不出原因，附檔案開頭（見 開發筆記 D061）
  if (!plan.days.length && !plan.todo) return { errors: ['AI 寫的 parse 沒有拆出任何一天，也沒有待處理'], excerpt: excerpt(text) };
  const dates = plan.days.map(d => d.date).sort();
  const lines = t => t.replace(/\n$/, '').split('\n');
  return {
    folder,
    preview: {
      name: m.name,
      displayName: m.displayName,
      version: m.version,
      formats: m.formats.map(({ label, hint }) => ({ label, hint })),
      replaces: old ? { displayName: old.displayName, version: old.version } : null,
      also: also.map(formatName),
      days: plan.days.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      existing: plan.existing.length,
      todoLines: plan.todo ? lines(plan.todo).length : 0,
      todoExisting: plan.todoExisting,
      samples: plan.days.slice(0, 3).map(d => {
        const ls = lines(d.text);
        return { date: d.date, text: ls.slice(0, SAMPLE_LINES).join('\n'), more: Math.max(0, ls.length - SAMPLE_LINES) };
      }),
    },
  };
}

/* 檢查過的匯出格式擴充拿使用者的紀錄試跑（見 開發筆記 D079）：在獨立程序跑每一種格式的 write，跟真的匯出同一條路（startHost 的 write）。
   data：主程序用 exportData 組好的「匯出全部」。回傳 { errors } 或
   { folder, outputs: 每一種格式匯出的結果（文字或 Buffer，「存一份看看」用）, preview } */
async function tryExport({ check, data, list, extRoot, fork, timeoutMs }) {
  const m = check.manifest;
  const t0 = target(m, list, extRoot);
  if (t0.error) return { errors: [t0.error] };
  const { tmp, file } = tmpCode(check.code);
  const mine = m.exportFormats.map(f => ({ ...f, ext: m.displayName, file }));
  const host = exts.startHost(fork, mine, timeoutMs);
  const outputs = [];
  try {
    for (const f of mine) outputs.push(await host.write(f, data));
  } catch (e) {
    return { errors: [e.message] };
  } finally {
    host.kill();
    rmTmp(tmp);
  }
  return {
    folder: t0.folder,
    outputs,
    preview: {
      kind: 'export',
      name: m.name,
      displayName: m.displayName,
      version: m.version,
      replaces: t0.old ? { displayName: t0.old.displayName, version: t0.old.version } : null,
      days: data.days.length,
      todo: !!data.todo,
      outputs: mine.map((f, i) => {
        const o = outputs[i];
        if (typeof o !== 'string') return { label: f.label, hint: f.hint, extension: f.extension, text: false, size: o.length };
        const ls = o.replace(/\r?\n$/, '').split(/\r?\n/);
        return { label: f.label, hint: f.hint, extension: f.extension, text: true, size: Buffer.byteLength(o),
          lines: o ? ls.length : 0, head: ls.slice(0, HEAD_LINES).join('\n'), more: Math.max(0, ls.length - HEAD_LINES) };
      }),
    },
  };
}

module.exports = { BANNED, PKG_MARK, CODE_MARK, buildPrompt, buildExportPrompt, splitReply, checkReply, tryRun, tryExport, excerpt, buildFeedback };
