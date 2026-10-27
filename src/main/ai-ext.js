/* ============================================================
   請別的 AI（Gemini、ChatGPT）寫匯入格式擴充（見 開發筆記 D056）：
   - buildPrompt：給 AI 的 prompt，寫明擴充的規格、要回什麼、哪些字不能用
   - checkReply：AI 回的那一段先檢查、不執行——拆出 package.json 和 index.js，看欄位、語法（只編譯）、禁用的字
   - tryRun：檢查過了才在獨立程序拿使用者的檔試跑，跟真的匯入同一條路（認格式、拆、checkParsed）
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
const { formatName } = require('../shared/formats/index.js');

const PKG_MARK = '===== package.json =====';
const CODE_MARK = '===== index.js =====';
const markRe = file => new RegExp(`^\\s*=+\\s*${file.replace('.', '\\.')}\\s*=+\\s*$`);
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/* 程式和註解裡都不能出現的字：拿得到 require、process、全域物件、動態產生程式、連網路的路 */
const BANNED = ['require', 'import', 'process', 'eval', 'Function', 'constructor', '__proto__', 'globalThis', 'global', 'arguments', 'fetch', 'WebSocket'];
const SAMPLE_LINES = 12;   // 預覽每一天最多列幾行

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
    '- detect(text)：傳進整份檔的文字，回 true／false，是不是這種格式。daybook 還有兩種內建格式，兩種以上都說是時會問我這次要用哪一種，',
    '  所以跟內建格式像也沒關係；但不要寬到連別種檔都認，不然我每次匯入都會被問：',
    '  - daybook Markdown（daybook 自己匯出的）：第一行有字的是「# 」開頭，有「## 2026-01-05」這種日期標題',
    '  - 舊記事本：有一行只寫日期（例如「1/5」）、或「---2026---」、或剛好是「週報」兩個字的一行',
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
   有錯時 pkg 是 null */
function checkReply(text, appVersion) {
  let parts;
  try { parts = splitReply(text); } catch (e) { return { errors: [e.message], manifest: null, pkg: null, code: null }; }
  const errors = [];
  let pkg = null, m = null;
  try { pkg = JSON.parse(parts.pkgText); } catch (e) { errors.push('package.json 不是正確的 JSON：' + e.message); }
  if (pkg) {
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
   回傳 { errors } 或 { folder: 要裝進哪個資料夾（同名的就裝回原本那個）, preview } */
async function tryRun({ check, text, list, extRoot, exists, fork, timeoutMs }) {
  const m = check.manifest;
  const old = list.find(x => x.name === m.name && x.state !== 'broken');
  const folder = old ? old.folder : m.name;
  if (!old && fs.existsSync(path.join(extRoot, folder))) return { errors: [`擴充資料夾裡已經有「${folder}」這個資料夾：請 AI 換一個 name`] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-ai-'));
  const file = path.join(tmp, 'index.js');
  fs.writeFileSync(file, check.code);
  const mine = m.formats.map(f => ({ ...f, ext: m.displayName, file }));
  const host = exts.startHost(fork, [...exts.enabledFormats(list.filter(x => x !== old)), ...mine], timeoutMs);
  // 別的格式也認得時，試跑用 AI 寫的這個；真的匯入時會問使用者（見 開發筆記 D058），預覽先寫還有誰認得
  let plan, also = [];
  const pickMine = hits => { also = hits.filter(f => f.file !== file); return hits.find(f => f.file === file) || null; };
  try {
    plan = await imp.planImport(text, exists, host, pickMine);
  } catch (e) {
    return { errors: [e.message] };
  } finally {
    host.kill();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (!plan) return { errors: [`這個檔被認成${also.map(formatName).join('和')}，不是 AI 寫的格式：AI 寫的 detect 要認得這個檔`] };
  if (plan.formatFile !== file) return { errors: [`這個檔被認成「${plan.format}」，不是 AI 寫的格式：AI 寫的 detect 要認得這個檔`] };
  if (!plan.days.length && !plan.todo && !plan.todoSkipped) return { errors: ['AI 寫的 parse 沒有拆出任何一天，也沒有待處理'] };
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
      skipped: plan.skipped.length,
      todoLines: plan.todo ? lines(plan.todo).length : 0,
      todoSkipped: plan.todoSkipped,
      samples: plan.days.slice(0, 3).map(d => {
        const ls = lines(d.text);
        return { date: d.date, text: ls.slice(0, SAMPLE_LINES).join('\n'), more: Math.max(0, ls.length - SAMPLE_LINES) };
      }),
    },
  };
}

module.exports = { BANNED, PKG_MARK, CODE_MARK, buildPrompt, splitReply, checkReply, tryRun };
