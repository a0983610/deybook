/* ============================================================
   語言檔（見 開發筆記 D131）：介面換成別的語言。一個語言一個 JSON 檔，放在 %APPDATA%\daybook\locales\<名稱>.json：
     { "daybookLocale": 1, "name": "English", "lang": "en", "strings": { "原文": "翻譯", … } }
   原文就是程式裡 L('原文') 的那句、HTML 的固定文字（這版全部的列在 src/shared/i18n-keys.json，tools/i18n-keys.cjs 收的）。
   只有字、沒有程式，所以不用像擴充那樣按「啟用」、版本不用合；原文改了、加了，那幾條就是「缺的」，照中文顯示。
   - scan：列出語言檔，每個算這版的字翻了幾條、缺幾條；壞掉的寫原因（每次打開語言頁重讀，丟進去就有）
   - load：讀一個給 L() 用 { lang, dict }
   - buildPrompt：請 AI 翻（全部，或那個語言缺的）；AI 回「代號 翻譯」一行一條（代號是原文 md5 的前 6 碼，跟順序無關，分好幾次回、隔天再貼都對得上）
   - checkReply：拆 AI 回的、一條一條檢查；buildFeedback：有問題的那幾條組成一段請 AI 重翻
   - install：寫成語言檔；同名的合併（新的蓋過、原本有的留著）——AI 分好幾段回、補翻缺的都走這條
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { L } = require('../shared/i18n.js');

const FORMAT = 1;
const CHUNK = 200;   // AI 一次回幾條（回太長會被截掉）
const NL = '↵';      // 原文、翻譯裡的換行（一條要擠在一行）
const SP = '␣';      // 翻譯頭尾要留的空白：一行一條的格式會去掉頭尾空白，被元件切開的片段（英文接在按鈕、<b> 旁邊）要靠它留空白
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const PH_RE = /\{\w+\}/g;
// 不比 <…> 標籤：翻譯一律當字放（textContent、文字節點、屬性），寫了標籤也不會變成 HTML；
// 比的話原文的「<每一版不同的名稱>」翻成 <a different name…> 會被當成連結標籤擋掉（扮外部 AI 實測踩到，D131）
const bag = (s, re) => (s.match(re) || []).sort().join(' ');

let groups = null;
const keyGroups = () => groups || (groups = require('../shared/i18n-keys.json'));
const allKeys = () => Object.values(keyGroups()).flat();
const idOf = k => crypto.createHash('md5').update(k).digest('hex').slice(0, 6);
let ids = null;
const idMap = () => ids || (ids = new Map(allKeys().map(k => [idOf(k), k])));

/* 名稱 → 檔名（不含 .json）：拿掉 Windows 檔名不能用的字 */
const fileOf = name => String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim();

/* 讀一個語言檔；不對就丟錯，寫哪裡不對 */
function readPack(file) {
  let o;
  try {
    o = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));   // 記事本存的會帶 BOM
  } catch {
    throw new Error(L('不是正確的 JSON'));
  }
  if (!o || o.daybookLocale !== FORMAT) throw new Error(L('不是 daybook 的語言檔（少了 "daybookLocale": 1）'));
  if (typeof o.name !== 'string' || !o.name.trim()) throw new Error(L('少了 name（語言的名稱）'));
  if (o.lang != null && !(typeof o.lang === 'string' && LANG_RE.test(o.lang))) throw new Error(L('lang 要是語言代碼，例如 en、ja、zh-CN'));
  if (!o.strings || typeof o.strings !== 'object' || Array.isArray(o.strings)) throw new Error(L('少了 strings（原文對翻譯）'));
  const strings = {};
  for (const [k, v] of Object.entries(o.strings)) if (typeof v === 'string' && v.trim() !== '') strings[k] = v;
  return { name: o.name.trim(), lang: o.lang || null, strings };
}

/* 語言檔資料夾裡每個 .json，照檔名排：{ id（檔名不含 .json）, name, lang, done（這版的字翻了幾條）, missing, total, state: 'ok'｜'broken', reason } */
function scan(dir) {
  if (!fs.existsSync(dir)) return [];
  const keys = allKeys();
  return fs.readdirSync(dir).filter(f => /\.json$/i.test(f)).sort().map(f => {
    const id = f.replace(/\.json$/i, '');
    const x = { id, name: id, lang: null, done: 0, missing: keys.length, total: keys.length, state: 'broken', reason: '' };
    try {
      const p = readPack(path.join(dir, f));
      const done = keys.filter(k => p.strings[k] !== undefined).length;
      Object.assign(x, { name: p.name, lang: p.lang, done, missing: keys.length - done, state: 'ok' });
    } catch (e) {
      x.reason = e.message;
    }
    return x;
  });
}

/* 用哪一個：{ lang, dict }；id 是 null（繁體中文）、找不到、壞掉都回 null（照中文） */
function load(dir, id) {
  if (!id || path.basename(id) !== id) return null;
  try {
    const p = readPack(path.join(dir, id + '.json'));
    return { lang: p.lang, dict: p.strings };
  } catch {
    return null;
  }
}

/* 名稱跟哪個裝好的一樣（不分大小寫）：補翻缺的、合併都靠它 */
const sameName = (dir, name) => scan(dir).find(x => x.state === 'ok' && x.name.toLowerCase() === name.toLowerCase()) || null;

/* 要翻的字：同名的已經裝了就只列它缺的 */
function todoKeys(dir, name) {
  const have = sameName(dir, name);
  if (!have) return { keys: allKeys(), have: null };
  const p = readPack(path.join(dir, have.id + '.json'));
  return { keys: allKeys().filter(k => p.strings[k] === undefined), have };
}

/* 原文那一欄：每段（檔）一行 # 標題 */
// 不翻開始：給 AI 看的分段標題
const GROUP_NAMES = {
  'src/renderer/index.html': '主視窗的固定文字：按鈕、標題、說明',
  'src/renderer/app.js': '主視窗上跟著狀況變的字：提示、訊息、清單',
  'src/renderer/capture.html': '截圖時蓋在螢幕上的那層：工具列',
  'src/main/main.js': '跳出來的視窗、錯誤訊息',
};
// 不翻結束
const oneLine = s => s.replace(/\r?\n/g, NL);

function buildPrompt(dir, target) {
  const name = String(target || '').trim();
  if (!name) throw new Error(L('先填要翻成哪個語言'));
  const { keys, have } = todoKeys(dir, name);
  const want = new Set(keys);
  const body = [];
  for (const [file, list] of Object.entries(keyGroups())) {
    const mine = list.filter(k => want.has(k));
    if (!mine.length) continue;
    body.push('', `# ${GROUP_NAMES[file] || file.replace(/^src\//, '')}`);
    for (const k of mine) body.push(`${idOf(k)} ${oneLine(k)}`);
  }
  // 不翻開始：給 AI 看的，照中文寫（AI 看得懂，D056 的 prompt 也是）
  return [
    `你要把一個軟體（daybook，Windows 上記每天工作的小工具）的介面文字，從繁體中文翻成「${name}」。`,
    ...(have ? [`之前已經翻了一部分，這次只列還沒翻的 ${keys.length} 條。`] : []),
    '翻好的我會整段貼回 daybook，它照代號換上去，所以格式一定要照下面寫。',
    '',
    '## 回覆格式',
    '- 放在程式碼區塊（```）裡。區塊第一行寫 `@lang 語言代碼`（BCP 47，例如 en、ja、zh-CN、ko）。',
    '- 接著一行一條：`代號 翻譯`。代號是原文前面那 6 個英數字，照抄；代號和翻譯中間一個空白。',
    `- 條數很多，一次回不完：每次最多回 ${CHUNK} 條，區塊後面寫「還有 N 條，說『繼續』接著翻」，等我說「繼續」再回下一段（每段一樣放在程式碼區塊裡，第一行一樣寫 @lang）。`,
    '- 不要改代號、不要漏條、不要合併成一條；沒把握的也照翻。`#` 開頭的分段行不用回，區塊外面不用說明。',
    '',
    '## 翻譯規則',
    '1. 這是軟體的介面：短、口語，用這個語言的軟體慣用的說法（例如「取消」「確定」「設定」「複製」）。',
    '2. `{n}`、`{name}` 這種大括號整段照抄（大括號裡的字不翻），程式會換成數字、名稱；可以照語序搬位置。',
    `3. \`${NL}\` 是換行，翻譯要換行的地方也寫 \`${NL}\`。`,
    '4. 這些照原樣、不翻：',
    '   - 方括號的標記 `[待回覆]`、`[隱藏]`、`[標記]`、`[標記:分類]`、`[待處理]`、`[完成]`（使用者的紀錄檔裡真的寫這些字，翻了就對不上）',
    '   - 內建的標記分類「未完」（紀錄檔裡寫成 `[標記:未完]`，畫面上也照這兩個字顯示）',
    '   - 檔名、資料夾名，例如 `待辦.md`、`剪貼簿.md`、`標記分類.json`、`記事本\\`、`保留\\`、`截圖\\`、`%APPDATA%\\daybook`',
    '   - 按鍵（Ctrl+F、Alt+←、Esc）、`^編號`、`#主題`、網址、程式碼、package.json 的欄位名稱、`yyyy`、`MM`、`dd`、`HH` 這類日期符號',
    '   - daybook、Gemini、ChatGPT、Markdown、Excel、VS Code、Windows 這些名稱',
    '5. 「」引起來的通常是畫面上別的按鈕、頁面的名稱：照那個按鈕翻的寫（同一個詞前後要一致），引號換成這個語言的習慣。',
    '6. 同一段話被畫面元件（按鈕、粗體、按鍵、路徑）切成好幾條時會連著列（例如「一個擴充一個資料夾，放進」「開啟位置」），翻的時候要讓接起來讀得通；頭尾的標點照原文放。',
    `   接起來時詞和詞、句子和句子中間要空白的語言（例如英文），翻譯開頭或結尾要留空白的地方寫 \`${SP}\`（一行一條的格式留不住頭尾的空白），例如「（淡淡蓋在整個畫面上）和」→ \`${SP}(faintly over the whole window) and${SP}\`。`,
    '   為了接起來通順，可以改句型、把標點移到另一條（例如英文要的逗號），意思對就好。',
    '7. 單獨一個字的「日」「一」「二」「三」「四」「五」「六」是星期幾的縮寫（日＝星期日），翻成這個語言的縮寫（英文 Sun、Mon…）。',
    '8. 原文用 `…` 結尾的按鈕，按了會再跳出東西，翻譯也用 `…` 結尾。',
    '',
    `## 要翻的字（共 ${keys.length} 條；# 開頭的是分段，寫這段在畫面哪裡，不用翻）`,
    ...body,
  ].join('\n') + '\n';
  // 不翻結束
}

/* AI 回的整段 → { lang, items: [{ id, text, line }] }：認 `代號 翻譯`（前面多了清單符號、代號包了 `、中間是冒號也認），其他行（說明、``` ）略過 */
function parseReply(text) {
  let lang = null;
  const items = [];
  String(text).replace(/\r\n?/g, '\n').split('\n').forEach((raw, n) => {
    const s = raw.trim();
    let m = /^@lang\s+(\S+)/i.exec(s);
    if (m) { lang = m[1]; return; }
    m = /^(?:[-*]\s+|\d+[.)]\s+)?`?([0-9a-f]{6})`?(?:\s*[:：|｜]\s*|\s+)(.+)$/i.exec(s);
    if (m) items.push({ id: m[1].toLowerCase(), text: m[2].trim().split(NL).join('\n').split(SP).join(' '), line: n + 1 });
  });
  return { lang, items };
}

/* 檢查：{ name, lang, good: { 原文: 翻譯 }, n, problems: [{ id, key, text, why, line }], missing（裝了之後還缺幾條）, total, merge（同名已經裝了的名稱） }
   有問題的那條不收，其他照收；一條都沒認出來 n 是 0 */
function checkReply(dir, reply, target) {
  const name = String(target || '').trim();
  if (!name) throw new Error(L('先填要翻成哪個語言'));
  if (!fileOf(name)) throw new Error(L('語言的名稱不能只有符號：{name}', { name }));
  const { lang, items } = parseReply(reply);
  const map = idMap();
  const good = {}, problems = [];
  for (const it of items) {
    const key = map.get(it.id);
    if (!key) {
      problems.push({ id: it.id, key: null, text: it.text, line: it.line, why: L('代號對不上：不是這版 daybook 的字') });
      continue;
    }
    if (bag(key, PH_RE) !== bag(it.text, PH_RE)) {
      const want = bag(key, PH_RE);
      problems.push({ id: it.id, key, text: it.text, line: it.line,
        why: want ? L('大括號跟原文不一樣：要有 {want}', { want }) : L('原文沒有大括號，翻譯也不能有') });
      continue;
    }
    // 原文頭尾有空白的（接在別的字後面），翻譯也照樣留
    good[key] = /^\s*/.exec(key)[0] + it.text + /\s*$/.exec(key)[0];
  }
  const langOk = lang && LANG_RE.test(lang) ? lang : null;
  if (lang && !langOk) problems.push({ id: '@lang', key: null, text: lang, line: 0, why: L('@lang 要是語言代碼，例如 en、ja、zh-CN') });
  const have = sameName(dir, name);
  const old = have ? readPack(path.join(dir, have.id + '.json')).strings : {};
  const keys = allKeys();
  const missing = keys.filter(k => good[k] === undefined && old[k] === undefined).length;
  return { name, lang: langOk || (have && have.lang) || null, good, n: Object.keys(good).length, problems, missing, total: keys.length, merge: have ? have.name : null };
}

/* 有問題的那幾條組成一段，貼回給 AI 重翻（D061 的「複製給 AI」那套）。r 是 checkReply 回的 */
function buildFeedback(r) {
  // 不翻開始：給 AI 看的
  const lines = ['你上次回的這幾條有問題，照前面的規則和格式重翻（程式碼區塊、第一行 @lang，只回這幾條）：', ''];
  for (const p of r.problems) {
    if (p.key) lines.push(`${p.id} ${oneLine(p.key)}`, `  ← 你回的：${oneLine(p.text)}；${p.why}`);
    else lines.push(`${p.id} ${oneLine(p.text)}`, `  ← ${p.why}`);
  }
  return lines.join('\n') + '\n';
  // 不翻結束
}

/* 裝：寫成 <名稱>.json；同名的（不分大小寫）合併進它原本的檔。回傳 id（檔名不含 .json）。
   同名的檔在、但讀不出來：不蓋掉（可能是使用者自己改壞的），請他先處理 */
function install(dir, r) {
  const have = sameName(dir, r.name);
  const id = have ? have.id : fileOf(r.name);
  const file = path.join(dir, id + '.json');
  let old = { lang: null, strings: {} };
  if (fs.existsSync(file)) {
    try { old = readPack(file); } catch (e) { throw new Error(L('已經有一個 {file}，讀不出來（{why}）：先刪掉或改名', { file: id + '.json', why: e.message })); }
  }
  const strings = { ...old.strings, ...r.good };
  // 照這版原文的順序排（看檔案時跟畫面的順序一樣），舊版才有的字放最後面
  const order = [...allKeys().filter(k => strings[k] !== undefined), ...Object.keys(strings).filter(k => !idMap().has(idOf(k)))];
  const out = { daybookLocale: FORMAT, name: have ? have.name : r.name, lang: r.lang || old.lang || null, strings: Object.fromEntries(order.map(k => [k, strings[k]])) };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return id;
}

/* ---------- 「語言」頁的 ipcMain handler（D190 從 main.js 搬來）----------
   main.js 啟動時叫一次。給的是 main.js 的：langDir（語言檔資料夾）、langId／setLangId（設定檔記的用哪一個）、loadLang（換掉主程序 L() 的字典）、sys。
   Electron 在這裡才 require：parser 測試直接 require 這支，不帶 Electron。
   內建的繁體中文＋語言檔資料夾裡的每個（每次重讀，丟進去就有）；current 是現在用的（null 是繁體中文）。
   換語言、裝好、刪掉現在用的：主程序先換掉 L() 的字典，畫面接著自己重新載入。
   請 AI 翻：複製 prompt → 開 Gemini／ChatGPT（用 ai:open）→ 貼回 AI 回的 → 檢查 → 安裝並換成這個語言；裝的是檢查過的那一份（同 D056） */
function setupIpc({ langDir, langId, setLangId, loadLang, sys }) {
  const { ipcMain } = require('electron');
  const langList = () => ({ dir: langDir(), current: langId(), packs: scan(langDir()) });
  ipcMain.handle('lang:list', () => langList());
  ipcMain.handle('lang:set', (_, id) => {
    if (id != null && !scan(langDir()).some(x => x.id === id && x.state === 'ok')) throw new Error(L('這個語言檔現在讀不到，關掉「語言」再打開看看'));
    setLangId(id || null);
    loadLang();
  });
  ipcMain.handle('lang:prompt', (_, target) => buildPrompt(langDir(), target));
  ipcMain.handle('lang:copy', (_, target) => sys.copyText(buildPrompt(langDir(), target)));
  let langPending = null;   // 檢查過、等使用者按「安裝」的那一份（checkReply 回的＋token）
  /* 回給畫面的不帶 good（原文對翻譯，很長）；problems 最多 50 條 */
  ipcMain.handle('lang:check', (_, reply, target) => {
    langPending = { ...checkReply(langDir(), reply, target), token: crypto.randomUUID() };
    const { good, problems, ...rest } = langPending;
    return { ...rest, problems: problems.slice(0, 50), more: Math.max(0, problems.length - 50) };
  });
  ipcMain.handle('lang:feedback', (_, token) => {
    if (!langPending || langPending.token !== token) throw new Error(L('要先按「檢查」'));
    sys.copyText(buildFeedback(langPending));
  });
  ipcMain.handle('lang:install', (_, token) => {
    if (!langPending || langPending.token !== token || !langPending.n) throw new Error(L('要先按「檢查」，認得出翻譯的才能安裝'));
    const id = install(langDir(), langPending);
    langPending = null;
    setLangId(id);
    loadLang();
  });
  /* 刪除：丟到資源回收筒（壞掉的也能刪）；刪的是現在用的就換回繁體中文，回傳的 reload 是 true（畫面要重新載入） */
  ipcMain.handle('lang:delete', async (_, id) => {
    const x = scan(langDir()).find(p => p.id === id);
    if (!x) throw new Error(L('找不到這個語言檔，關掉「語言」再打開看看'));
    await sys.trash(path.join(langDir(), x.id + '.json'));
    const reload = langId() === id;
    if (reload) { setLangId(null); loadLang(); }
    return { ...langList(), reload };
  });
}

module.exports = { scan, load, buildPrompt, parseReply, checkReply, buildFeedback, install, setupIpc, idOf, allKeys, fileOf, CHUNK };
