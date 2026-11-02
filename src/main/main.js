/* ============================================================
   daybook 主程序：決定資料資料夾、開視窗、讀寫檔案、監看資料夾
   檔案操作只在這裡做；畫面透過 preload 的 window.daybook 呼叫（見 開發筆記 D002）
   ============================================================ */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, utilityProcess, clipboard, ClipboardItem, screen, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { TODO_FILE, FLAG_CATS_FILE, SNIP_FILE, OLD_SNIP_FILE, NOTE_DIR, ISO_DATE_RE, dayPath } = require('../shared/paths.js');
const { checkCat } = require('../shared/parser.js');
const ent = require('../shared/entries.js');
const snip = require('../shared/snippets.js');
const notes = require('../shared/notes.js');
const srch = require('../shared/search.js');
const { FORMATS, EXPORT_FORMATS, formatName, exportData } = require('../shared/formats/index.js');
const imp = require('../shared/import.js');
const exts = require('./extensions.js');
const aiExt = require('./ai-ext.js');
const skins = require('./skins.js');
const winState = require('./window-state.js');
const { zipDir } = require('./backup.js');
const mdView = require('./md-view.js');
const shots = require('../shared/shots.js');
const shot = require('./shot.js');
const i18n = require('../shared/i18n.js');
const { L, LK, joinList: listJoin } = i18n;   // listJoin：「A、B、C」兩兩用 L() 的模板接（D131）
const locales = require('./locales.js');

/* 文件檢視的 .html 用 docview://local/<路徑> 開（見 開發筆記 D122）：要在 app 準備好之前登記。
   standard：檔案裡的相對路徑（圖、css）才接得起來；secure：當成安全的來源，不被當混合內容擋。
   截圖頁的縮圖用 shot://local/<相對路徑>（D129），一起登記（只能登記一次） */
protocol.registerSchemesAsPrivileged([
  { scheme: 'docview', privileges: { standard: true, secure: true } },
  { scheme: 'shot', privileges: { standard: true, secure: true } },
]);

/* 啟動參數 --名稱 <路徑>（開發、測試用） */
const argPath = name => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
};

/* 資料資料夾（見 開發筆記 D016、D041）：--data-dir ＞ 設定檔 ＞ 都沒有就在畫面上請使用者選（不在啟動時跳視窗）。
   有 --data-dir 時完全不讀寫設定檔，Chromium 的使用者資料也改放系統暫存區，
   測試才不會動到使用者真的設定（%APPDATA%\daybook）。
   暫存區的資料夾名稱帶資料資料夾路徑的雜湊：試用版和 e2e 同時開也各用各的，互不干擾 */
const argDataDir = argPath('--data-dir');
if (argDataDir) {
  const tag = require('crypto').createHash('md5').update(argDataDir.toLowerCase()).digest('hex').slice(0, 8);
  app.setPath('userData', path.join(app.getPath('temp'), 'daybook-dev-profile-' + tag));
}
/* 測試用：設定檔、Chromium 使用者資料改放這個資料夾——測「還沒選資料夾」的畫面，不碰 %APPDATA%\daybook（見 開發筆記 D041） */
const argUserData = argPath('--user-data');
if (argUserData && !argDataDir) app.setPath('userData', argUserData);
/* 測試用：選資料夾不跳視窗，直接當作選了這個（原生視窗 CDP 點不到，見 開發筆記 D041） */
const argPickDir = argPath('--pick-dir');
/* 測試用：匯入選檔不跳視窗，直接當作選了這個檔（見 開發筆記 D044） */
const argPickFile = argPath('--pick-file');
/* 測試用：MD 檢視「釘資料夾」不跳視窗，照順序當作選了這些資料夾（可以給好幾次，用到最後一個就一直是它，見 開發筆記 D118） */
const argPickMdDirs = process.argv.flatMap((a, i) => (a === '--pick-md-dir' && process.argv[i + 1] ? [path.resolve(process.argv[i + 1])] : []));
/* 測試用：「外觀」頁「用圖檔做一個」的選圖不跳視窗，直接當作選了這張圖（見 開發筆記 D066） */
const argPickImage = argPath('--pick-image');
/* 測試用：兩種以上格式都認得時不跳視窗，直接當作選了名稱（label）是這個的格式；清單裡沒有就當作取消（見 開發筆記 D058） */
const argPickFormat = process.argv.includes('--pick-format') ? process.argv[process.argv.indexOf('--pick-format') + 1] || '' : null;
/* 測試用：匯入時資料夾裡已經有的日子，不跳視窗，直接當作按了「加進去」或「略過」；其他的字當作取消（見 開發筆記 D063） */
const argExisting = process.argv.includes('--existing') ? process.argv[process.argv.indexOf('--existing') + 1] || '' : null;
/* 測試用：匯出、AI 匯出格式試跑的「存一份看看」不跳存檔視窗，直接寫進這個資料夾（見 開發筆記 D035、D079） */
const argExportDir = argPath('--export-dir');
/* 測試用：說明頁的「開啟位置」、記事清單、頁籤、文件檢視清單右鍵的「在檔案總管中顯示」「用瀏覽器開」不真的開、「開 Gemini／ChatGPT」、文件檢視裡的網址連結不真的開瀏覽器，
   把路徑、網址一行一行寫進這個檔（見 開發筆記 D051、D056、D117、D118、D120、D121、D122） */
const argOpenLog = argPath('--open-log');
/* 測試用：「複製 prompt」、點左欄剪貼簿的卡片、記事清單、頁籤、MD 檢視清單右鍵「複製路徑」「複製相對路徑」時不寫系統剪貼簿，寫進這個檔——測試不蓋掉使用者剪貼簿裡的東西（見 開發筆記 D056、D093、D117、D120、D121） */
const argClipFile = argPath('--clipboard-file');
/* 測試用：「外觀」頁刪外觀包、「格式」頁刪擴充、記事本刪一份不丟資源回收筒，搬進這個資料夾——測試不在使用者的資源回收筒留東西（見 開發筆記 D073、D081、D102） */
const argTrashDir = argPath('--trash-dir');
/* 測試用：視窗放到螢幕外、不搶焦點、不上工作列，再開一次也不叫到前面——commit 前跑 e2e 不打擾正在用電腦的人（見 開發筆記 D052） */
const argQuietWindow = process.argv.includes('--quiet-window');
/* 測試用：視窗不收真的滑鼠（點得穿過去），只收測試從 CDP 送進來的——完整跑時使用者動到滑鼠不會蓋掉測試的滑鼠位置（見 開發筆記 D080） */
const argIgnoreMouse = process.argv.includes('--ignore-mouse');
/* 測試用：「＋ 截圖」不抓真的螢幕，拿這張圖當唯一的螢幕——測試不截到使用者的畫面（見 開發筆記 D129） */
const argShotImage = argPath('--shot-image');
/* 測試用：截圖頁「變更資料夾…」不跳視窗，直接當作選了這個資料夾（見 開發筆記 D129） */
const argPickShotDir = argPath('--pick-shot-dir');

/* 只能開一個視窗（見 開發筆記 D030）：再開一次就把已開的那個叫到前面，自己結束。
   鎖跟著上面的 userData 走：正式用鎖 %APPDATA%\daybook；--data-dir 各鎖各的暫存資料夾，試用版和 e2e 互不擋 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

/* 格式的外部擴充（匯入、匯出，見 開發筆記 D055、D078）：放在使用者資料底下的 extensions\（正式是 %APPDATA%\daybook\extensions）。
   啟用了哪些 { 名稱: 版本 } 記在設定檔；有 --data-dir 時不讀寫設定檔（D016），只記到關掉為止 */
const extDir = () => path.join(app.getPath('userData'), 'extensions');
let extEnabledDev = {};
const extEnabled = () => (argDataDir ? extEnabledDev : readSettings().extensions || {});
function setExtEnabled(map) {
  if (argDataDir) extEnabledDev = map;
  else writeAtomic(settingsFile(), JSON.stringify({ ...readSettings(), extensions: map }, null, 2));
}
const scanExts = () => exts.scan(extDir(), app.getVersion(), extEnabled());
/* 擴充程序拿不到這裡的字典：用環境變數帶語言檔在哪、用哪一個，它自己讀（ext-host.js 開頭，D131） */
const forkExtHost = () => utilityProcess.fork(path.join(__dirname, 'ext-host.js'), [], {
  serviceName: 'daybook 擴充',   // 不翻：程序的內部名稱
  env: { ...process.env, DAYBOOK_LANG_DIR: langDir(), DAYBOOK_LANG_ID: langId() || '' },
});

/* 外觀包（見 開發筆記 D062）：放在使用者資料底下的 skins\（正式是 %APPDATA%\daybook\skins）。
   啟用的是哪一個（名稱）記在設定檔；有 --data-dir 時不讀寫設定檔（D016），只記到關掉為止 */
const skinDir = () => path.join(app.getPath('userData'), 'skins');
let skinDev = null;
const skinEnabled = () => (argDataDir ? skinDev : readSettings().skin || null);
function setSkinEnabled(name) {
  if (argDataDir) skinDev = name;
  else writeAtomic(settingsFile(), JSON.stringify({ ...readSettings(), skin: name }, null, 2));
}
const scanSkins = () => skins.scan(skinDir(), app.getVersion(), skinEnabled());

/* 介面語言（見 開發筆記 D131）：語言檔放在使用者資料底下的 locales\（正式是 %APPDATA%\daybook\locales），一個語言一個 .json。
   用哪一個（檔名，不含 .json；null 是內建的繁體中文）記在設定檔；有 --data-dir 時不讀寫設定檔（D016），只記到關掉為止。
   啟動、換語言時讀進來：主程序的訊息用 L()，畫面（重新載入時）向 i18n:get 同步拿 */
const langDir = () => path.join(app.getPath('userData'), 'locales');
let langDev = null;
const langId = () => (argDataDir ? langDev : readSettings().lang || null);
function setLangId(id) {
  if (argDataDir) langDev = id;
  else writeAtomic(settingsFile(), JSON.stringify({ ...readSettings(), lang: id }, null, 2));
}
let langNow = { lang: null, dict: null };
function loadLang() {
  langNow = locales.load(langDir(), langId()) || { lang: null, dict: null };
  i18n.setDict(langNow.dict);
}
loadLang();
ipcMain.on('i18n:get', e => { e.returnValue = langNow; });

/* MD 檢視釘住的資料夾（見 開發筆記 D118）：完整路徑，照釘的順序，記在設定檔（是這台電腦的資料夾，不跟著紀錄資料夾走）；
   有 --data-dir 時不讀寫設定檔（D016），只記到關掉為止 */
let mdRootsDev = [];
const mdRoots = () => (argDataDir ? mdRootsDev : readSettings().mdRoots || []);
function setMdRoots(list) {
  if (argDataDir) mdRootsDev = list;
  else writeAtomic(settingsFile(), JSON.stringify({ ...readSettings(), mdRoots: list }, null, 2));
  watchMd();
}

/* 截圖（見 開發筆記 D129）：截圖資料夾、用過的最大號（清掉了也不重用）記在設定檔——是這台電腦的資料夾，不跟著紀錄資料夾走、備份不包。
   預設是桌面的 截圖\（使用者原本手動存編號截圖的地方）。有 --data-dir 時不讀寫設定檔（D016）：放在暫存的使用者資料底下，只記到關掉為止 */
let shotDirDev = null, shotNoDev = 0;
const shotDir = () => (argDataDir ? shotDirDev || path.join(app.getPath('userData'), '截圖') : readSettings().shotDir || path.join(app.getPath('desktop'), '截圖'));   // 不翻：固定的資料夾名稱
const shotNo = () => (argDataDir ? shotNoDev : readSettings().shotNo || 0);
function setShotSetting(key, value) {
  if (argDataDir) { if (key === 'shotDir') shotDirDev = value; else shotNoDev = value; }
  else writeAtomic(settingsFile(), JSON.stringify({ ...readSettings(), [key]: value }, null, 2));
}

/* 先寫暫存檔再改名：寫到一半當掉，原檔也不會壞 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  parsed.delete(file);   // 自己寫的直接作廢，不靠修改時間（FAT32 隨身碟只準到 2 秒，見 開發筆記 D064）
}

async function pickMdDir(parent) {
  if (argPickMdDirs.length) return argPickMdDirs.length > 1 ? argPickMdDirs.shift() : argPickMdDirs[0];
  const r = await dialog.showOpenDialog(parent, { title: L('釘一個放 .md、.html 的資料夾（文件檢視）'), properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
}

async function pickDir(parent) {
  if (argPickDir) return argPickDir;
  const r = await dialog.showOpenDialog(parent, {
    title: L('選擇放工作紀錄的資料夾'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
}

/* 選要匯入的檔：副檔名照登記的格式、加上已啟用的擴充（見 開發筆記 D047、D055） */
async function pickImportFile(parent) {
  if (argPickFile) return argPickFile;
  const all = [...FORMATS, ...exts.enabledFormats(scanExts())];
  const r = await dialog.showOpenDialog(parent, {
    title: L('選擇要匯入的檔案（{formats}）', { formats: listJoin(all.map(f => L(f.label))) }),
    properties: ['openFile'],
    filters: [{ name: L('能匯入的檔'), extensions: [...new Set(all.flatMap(f => f.extensions))] }, { name: L('全部檔案'), extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
}

/* 兩種以上格式都認得要匯入的檔：問使用者這次用哪一種（見 開發筆記 D058）。取消回 null */
async function pickFormatOf(candidates) {
  if (argPickFormat != null) return candidates.find(f => f.label === argPickFormat) || null;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: L('要用哪一種格式匯入'),
    message: L('這個檔同時像好幾種格式，這次要用哪一種匯入？'),
    detail: candidates.map(f => L('{format}：{hint}', { format: formatName(f), hint: L(f.hint) })).join('\n'),
    buttons: [...candidates.map(formatName), L('取消')],
    cancelId: candidates.length,
    noLink: true,
  });
  return candidates[r.response] || null;
}

/* 要匯入的日子（或待處理）資料夾裡已經有了：一次問全部要加進去還是略過（見 開發筆記 D063）。回 '加進去'／'略過'，取消回 null。
   回傳值、--existing 比對的是中文原文（不跟著介面語言換），按鈕上的字才用 L() */
async function askExisting(plan) {
  const choices = [LK('加進去'), LK('略過')];
  if (argExisting != null) return choices.includes(argExisting) ? argExisting : null;
  const dates = plan.existing.map(d => d.date);
  const n = dates.length;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: L('資料夾裡已經有了'),
    message: !n ? L('資料夾裡已經有待處理的資料，要加進去還是略過？')
      : plan.todoExisting ? L('資料夾裡已經有 {n} 天和待處理的資料，要加進去還是略過？', { n })
        : L('資料夾裡已經有 {n} 天的資料，要加進去還是略過？', { n }),
    detail: (n ? listJoin(dates.slice(0, 10)) + (n > 10 ? ' ' + L('…共 {n} 天', { n }) : '') + '\n\n' : '')
      + L('加進去：一筆一筆比，已經有一模一樣的那筆就不再加，其他接在最後面。\n略過：這些不匯，其他照匯。'),
    buttons: [...choices.map(c => L(c)), L('取消')],
    cancelId: choices.length,
    noLink: true,
  });
  return choices[r.response] || null;
}

/* AI 寫的擴充試跑選檔（見 開發筆記 D056）：副檔名照那個擴充的格式，它還沒裝，選匯入檔的清單裡沒有它 */
async function pickTryFile(formats) {
  if (argPickFile) return argPickFile;
  const r = await dialog.showOpenDialog(win, {
    title: L('選一個要用這個格式匯入的檔來試跑（{formats}）', { formats: listJoin(formats.map(f => f.label)) }),
    properties: ['openFile'],
    filters: [{ name: listJoin(formats.map(f => f.label)), extensions: [...new Set(formats.flatMap(f => f.extensions))] }, { name: L('全部檔案'), extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
}

/* 啟動時決定資料資料夾；沒有就是 null，畫面會請使用者選（見 開發筆記 D041）。
   設定檔裡有、但那個資料夾不見了（隨身碟沒插、被搬走）：記在 lostDir，畫面上告訴使用者 */
let lostDir = null;
function resolveDataDir() {
  if (argDataDir) return argDataDir;
  const s = readSettings();
  if (s.dataDir && fs.existsSync(s.dataDir)) return s.dataDir;
  if (s.dataDir) lostDir = s.dataDir;
  return null;
}

let dataDir = null;
let win = null;
let watcher = null;

const readText = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* 有每日檔的日期，新的在前 */
function listDays() {
  const dir = path.join(dataDir, 'journal');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map(f => path.basename(String(f)).match(/^(\d{4}-\d{2}-\d{2})\.md$/))
    .filter(Boolean).map(m => m[1])
    .sort().reverse();
}

/* 畫面存檔原樣寫入（見 開發筆記 D020）；那天還沒有檔、內容又是空的，就不建空檔 */
function writeDay(date, text) {
  const file = path.join(dataDir, dayPath(date));
  if (!fs.existsSync(file) && text.trim() === '') return;
  writeAtomic(file, text);
}

/* src：'YYYY-MM-DD'（每日檔）、'todo'（待辦.md）或 'snip'（剪貼簿.md，D093、D096）；日期由 dayPath 驗格式 */
const fileOf = src => path.join(dataDir, src === 'todo' ? TODO_FILE : src === 'snip' ? SNIP_FILE : dayPath(src));
const writeSrc = (src, text) => writeAtomic(fileOf(src), text);

/* 搜尋、時間軸、提示用的索引（見 開發筆記 D064）：日記多半只往後加，讀過、parse 過的檔記起來；
   每次還是列一次檔案、逐檔比修改時間和大小，有變才重讀，外面改了舊的日子也抓得到 */
let parsed = new Map();   // 檔案路徑 → { mtimeMs, size, day }
function index() {
  const next = new Map();
  const out = [...listDays(), 'todo'].map(src => {
    const file = fileOf(src);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) return srch.buildIndex([{ src, text: '' }])[0];   // 還沒有待辦.md
    let c = parsed.get(file);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      c = { mtimeMs: st.mtimeMs, size: st.size, day: srch.buildIndex([{ src, text: fs.readFileSync(file, 'utf8') }])[0] };
    }
    next.set(file, c);
    return c.day;
  });
  parsed = next;   // 不見了的檔不留
  return out;
}

/* + 更新
   - 待處理（見 開發筆記 D024）：接在那一筆底下，帶今天日期 ->MM/DD …
   - 今天的已處理：接在同一筆底下（見 D022）
   - 過去的已處理：原本那筆沒有事件編號就先編一個，再在今天記一筆同編號的（見 D022）；
     原本那筆有標記的話，標記搬到今天這筆（清單上永遠是最新進度那筆，見 D072） */
function addUpdate(src, index_, raw, text) {
  const today = localToday();
  const srcText = readText(fileOf(src));
  const u = String(text).trim().replace(/^->\s*/, '');
  if (!u) throw new Error(L('更新內容不能空白'));
  if (src === 'todo') {
    writeSrc(src, ent.appendUpdate(srcText, index_, raw, `${today.slice(5, 7)}/${today.slice(8)} ${u}`));
    return { where: 'same' };
  }
  if (src === today) {
    writeSrc(src, ent.appendUpdate(srcText, index_, raw, u));
    return { where: 'same' };
  }
  const e = ent.listEntries(srcText)[index_];
  if (!e || e.raw !== raw) throw new ent.Conflict(L('這一筆在別的地方被改過了，畫面已重新整理，請再操作一次'));
  let id = e.event;
  let next = srcText;
  if (id == null) {
    id = srch.maxEvent(index()) + 1;
    next = ent.setEvent(next, index_, raw, id);
  }
  if (e.flagged) next = ent.setFlagged(next, index_, ent.listEntries(next)[index_].raw, false);   // 加了編號原文會變，拿新的
  if (next !== srcText) writeSrc(src, next);
  // 已處理不帶狀態（狀態只在待處理用，見 開發筆記 D024）；標記連分類一起搬（D076）
  const card = { title: e.title.split('\n').join(' '), body: '->' + u, status: null, flagged: e.flagged, flagCat: e.flagCat, event: id };
  writeSrc(today, ent.addEntry(readText(fileOf(today)), card));
  return { where: 'today', event: id };
}

/* 標記的分類（見 開發筆記 D076）：自訂的清單存在資料資料夾的 標記分類.json（{ "categories": [...] }），跟著紀錄走；
   紀錄裡有、清單沒有的（文字模式打的、匯入的）也列出來，接在後面。
   內建的「未完」一律排第一個、不寫進檔（待處理卡片「已處理+未完標籤」標的就是它，見 D089、D091） */
const PENDING_CAT = '未完';   // 不翻：寫進紀錄的分類名稱 [標記:未完]
const catsFile = () => path.join(dataDir, FLAG_CATS_FILE);
function readCats() {
  const t = readText(catsFile());
  if (!t.trim()) return [];
  let j;
  try { j = JSON.parse(t); } catch { throw new Error(L('資料夾裡的 {file} 讀不懂（不是 JSON），用記事本打開修好再試', { file: FLAG_CATS_FILE })); }
  return j && Array.isArray(j.categories) ? j.categories.filter(c => typeof c === 'string') : [];
}
function flagCats() {
  const list = [PENDING_CAT, ...readCats().filter(c => c !== PENDING_CAT)];
  for (const it of srch.flaggedItems(index())) if (it.flagCat && !list.includes(it.flagCat)) list.push(it.flagCat);
  return list;
}
/* 新分類接在清單最後面；已經有的不重複加。回傳整理過的名稱（標記時用） */
function addCat(name) {
  const c = checkCat(name);
  const list = readCats();
  if (!list.includes(c)) writeAtomic(catsFile(), JSON.stringify({ categories: [...list, c] }, null, 2) + '\n');
  return c;
}

/* 處理完（見 開發筆記 D024）：待處理那一筆整段（含進展）搬進那一天的已處理，狀態拿掉。
   unfinished：「已處理+未完標籤」，搬過去再標上內建分類「未完」（D091）。
   先寫那一天、再從待辦.md 拿掉——中途出錯頂多兩邊都有，不會兩邊都沒有 */
function markDone(index_, raw, date, unfinished) {
  const dayFile = path.join(dataDir, dayPath(date));   // 只能搬進某一天（dayPath 驗日期格式）
  const { rest, taken } = ent.takeEntry(readText(fileOf('todo')), index_, raw, unfinished ? PENDING_CAT : null);
  writeAtomic(dayFile, ent.appendLines(readText(dayFile), taken));
  writeSrc('todo', rest);
}

/* 要匯出的那段（見 開發筆記 D035）：日期區間（from～to，含頭尾）或全部（最後接待處理）。
   回傳 { name: 檔名（不含副檔名）, data: 給匯出格式的資料（exportData，D078） } */
function exportRange(req) {
  const days = listDays().reverse();   // 舊的在前
  let pick, title, name;
  // title 寫進匯出的檔（daybook Markdown 第一行、Excel），是檔案內容不翻；name 是存檔視窗預設的檔名，跟著介面語言
  if (req.all) {
    pick = days;
    title = '工作紀錄（全部）' + (days.length ? ` ${days[0]} ～ ${days[days.length - 1]}` : '');   // 不翻：匯出檔的內容
    name = L('工作紀錄_全部_{date}', { date: localToday() });
  } else {
    const { from, to } = req;
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) throw new Error(L('起訖日期要填完整'));
    if (from > to) throw new Error(L('起日不能晚於訖日'));
    pick = days.filter(d => d >= from && d <= to);
    if (!pick.length) throw new Error(L('{from} ～ {to} 沒有紀錄', { from, to }));
    title = `工作紀錄 ${from} ～ ${to}`;   // 不翻：匯出檔的內容
    name = L('工作紀錄_{from}_{to}', { from, to });
  }
  return {
    name,
    data: exportData({
      title, from: pick[0] || null, to: pick[pick.length - 1] || null, all: req.all,
      days: pick.map(d => ({ date: d, text: readText(fileOf(d)) })),
      todo: req.all ? readText(fileOf('todo')) : null,
    }),
  };
}

/* 能匯出的格式（見 開發筆記 D078）：內建的＋已啟用擴充的（每次重讀，擴充啟用、停用了就跟著變）。key 給畫面的下拉選單用，內建的就是 id */
const exportFormatList = () => [...EXPORT_FORMATS.map(f => ({ ...f, key: f.id })), ...exts.enabledExportFormats(scanExts())];

/* 存檔視窗（匯出、AI 匯出格式的「存一份看看」、備份共用）：預設下載資料夾，同一次開著記住上次存的資料夾；取消回 null */
let lastExportDir = null;
async function pickSaveFile(name, fmt, title = L('匯出成{format}', { format: L(fmt.label) })) {
  if (argExportDir) return path.join(argExportDir, name);
  const r = await dialog.showSaveDialog(win, {
    title,
    defaultPath: path.join(lastExportDir || app.getPath('downloads'), name),
    filters: [{ name: L(fmt.label), extensions: [fmt.extension] }],
  });
  if (r.canceled || !r.filePath) return null;
  lastExportDir = path.dirname(r.filePath);
  return r.filePath;
}

/* 匯出成一個檔（見 開發筆記 D035、D078）：格式是畫面下拉選單選的（req.format＝key），範圍見 exportRange。
   擴充的格式在獨立程序跑（同匯入，D055），先跑完再跳存檔視窗：出錯就不用選位置。
   回傳的是文字就用 UTF-8 寫、位元組照寫。取消回 null */
async function exportFile(req) {
  const fmt = exportFormatList().find(f => f.key === req.format);
  if (!fmt) throw new Error(L('沒有這個匯出格式（擴充停用或拿掉了？）：重新選一次'));
  const { name, data } = exportRange(req);
  let out;
  if (fmt.file) {
    const host = exts.startHost(forkExtHost, [fmt]);
    try { out = await host.write(fmt, data); } finally { host.kill(); }
  } else {
    out = fmt.write(data);
  }
  const file = await pickSaveFile(`${name}.${fmt.extension}`, fmt);
  if (!file) return null;
  fs.writeFileSync(file, out);
  return file;
}

/* 備份（見 開發筆記 D097）：整個紀錄資料夾壓成一個 zip，壓好才跳存檔視窗讓使用者選放哪（同匯出：出錯就不用選位置）。
   檔名帶日期時間，同一天備份好幾次不會撞名。取消回 null */
async function backupData() {
  if (!dataDir) throw new Error(L('先選資料夾'));
  const buf = zipDir(dataDir);
  const d = new Date();
  const name = L('daybook備份_{date}_{time}.zip', { date: localToday(), time: String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') });
  const file = await pickSaveFile(name, { label: L('zip 壓縮檔'), extension: 'zip' }, L('備份：整個紀錄資料夾壓成一個 zip，選要存在哪'));
  if (!file) return null;
  fs.writeFileSync(file, buf);
  return file;
}

/* 要匯入的檔一律當 UTF-8 讀；匯入和 AI 擴充的試跑共用（見 開發筆記 D056） */
function readImportText(file) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
  catch { throw new Error(L('這個檔不是 UTF-8 編碼：用記事本打開，「另存新檔」時編碼選 UTF-8，再匯入一次')); }
}

/* 匯入（見 開發筆記 D044、D047）：選檔 → 認格式、拆成每日檔＋待辦.md，寫進目前的資料夾。原檔只讀。
   已經有內容的日子、待辦.md：一次問要加進去還是略過，加進去是一筆一筆比、一模一樣的不再加（D063）；
   整批算一個動作，Ctrl+Z 一次復原。取消（選檔、選格式、加進去還是略過）回 null。
   有啟用的擴充：開一個獨立程序跑它們的 detect / parse，匯完就關（見 D055）；兩種以上格式都認得就問用哪一種（D058） */
async function importFile() {
  if (!dataDir) throw new Error(L('先選資料夾'));
  const file = await pickImportFile(win);
  if (!file) return null;
  const text = readImportText(file);
  const has = rel => readText(path.join(dataDir, rel)).trim() !== '';
  const list = scanExts();
  const formats = exts.enabledFormats(list);
  const host = formats.length ? exts.startHost(forkExtHost, formats) : null;
  let plan;
  try {
    plan = await imp.planImport(text, has, host, pickFormatOf);
  } catch (e) {
    const off = list.filter(x => x.state === 'disabled').length;
    if (e.unknownFormat && off) e.message += L('（有 {n} 個擴充還沒啟用：左下角齒輪「設定」的「格式」）', { n: off });
    throw e;
  } finally {
    if (host) host.kill();
  }
  if (!plan) return null;
  const old = plan.existing.map(d => [d.date, d.text]).concat(plan.todoExisting ? [['todo', plan.todo]] : []);
  const how = old.length ? await askExisting(plan) : '略過';   // 不翻：askExisting 回的是中文原文
  if (!how) return null;
  const writes = plan.write.map(d => [d.date, d.text]).concat(plan.todo && !plan.todoExisting ? [['todo', plan.todo]] : []);
  let merged = null;
  if (how === '加進去') {   // 不翻：同上
    merged = { days: plan.existing.length, todo: plan.todoExisting, added: 0, dup: 0 };
    for (const [src, text] of old) {
      const m = imp.mergeEntries(readText(fileOf(src)), text, src === 'todo' ? L('待處理') : src);
      merged.added += m.added;
      merged.dup += m.dup;
      if (m.added) writes.push([src, m.text]);
    }
  }
  withUndo(LK('匯入'), writes.map(w => w[0]), () => {
    for (const [src, text] of writes) writeSrc(src, text);
  });
  return {
    format: plan.format,
    written: plan.write.length,
    skipped: merged ? [] : plan.existing.map(d => d.date),
    merged,
    todoLines: plan.todo && !plan.todoExisting ? plan.todo.replace(/\n$/, '').split('\n').length : 0,
    todoSkipped: !merged && plan.todoExisting,
  };
}

/* 外部改了檔（人用編輯器改、Claude 改）就通知畫面；連續的事件合併成一次。記事本\ 的 .txt 也算（D102）；
   有資料夾之後（D116）記事本\ 底下的都算（資料夾建、改名、刪掉也要重畫清單），寫檔時的 .tmp 不算 */
function watchData() {
  if (watcher) watcher.close();
  let timer = null;
  const changed = new Set();
  watcher = fs.watch(dataDir, { recursive: true }, (_, name) => {
    if (!name) return;
    const n = String(name);
    if (!n.endsWith('.md') && !((n === NOTE_DIR || n.startsWith(NOTE_DIR + path.sep)) && !n.endsWith('.tmp'))) return;
    changed.add(n.split(path.sep).join('/'));
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send('data:changed', [...changed]);
      changed.clear();
    }, 150);
  });
}

// dataDir 是 null：還沒選資料夾，畫面顯示「選擇資料夾」（見 開發筆記 D041）
ipcMain.handle('info', () => ({ dataDir, lostDir, today: localToday(), canChangeDir: !argDataDir, version: app.getVersion() }));

/* 說明頁的「檔案放在哪」（見 開發筆記 D048、D049）：daybook 在這台電腦會放東西的地方，路徑照實際算。
   給拿到 exe 的人看的：可攜版、安裝版兩格都列，正在用的那種標出來（開發時兩種都不是，照一般位置寫）。
   可攜版的啟動器會設 PORTABLE_EXECUTABLE_FILE；安裝版的程式資料夾裡有 electron-builder 放的「Uninstall daybook.exe」 */
function filesInfo() {
  const exeDir = path.dirname(process.execPath);
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE || null;
  const mode = portableExe ? 'portable'
    : app.isPackaged && fs.existsSync(path.join(exeDir, `Uninstall ${app.getName()}.exe`)) ? 'installed' : null;
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  const at = p => (p ? { path: p, exists: fs.existsSync(p) } : null);
  return {
    mode,
    data: at(dataDir),
    shots: at(shotDir()),   // 截圖資料夾（見 開發筆記 D129）
    userData: at(app.getPath('userData')),
    extensions: at(extDir()),   // 格式擴充（匯入、匯出）放這裡（見 開發筆記 D055、D078）
    skins: at(skinDir()),   // 外觀包放這裡（見 開發筆記 D062）
    locales: at(langDir()),   // 語言檔放這裡（見 開發筆記 D131）
    portableExe: mode === 'portable' ? at(portableExe) : null,
    unpack: mode === 'portable' ? at(exeDir) : null,   // 不是可攜版就不知道名稱（打包時隨機產生）
    tempDir: app.getPath('temp'),
    // 安裝版：正在用就是程式所在的資料夾，不然寫預設的位置（electron-builder 的 multiUser.nsh）
    installed: at(mode === 'installed' ? exeDir : path.join(local, 'Programs', app.getName())),
    // 安裝版裝的時候，安裝程式把自己複製一份放這裡（electron-builder 的 installer.nsh）；解除安裝時 build\installer.nsh 會一起刪（見 開發筆記 D050）
    updater: at(path.join(local, `${app.getName()}-updater`)),
    // 解除安裝程式的暫存複本（NSIS 共用的名稱，見 開發筆記 D050〈後續〉）
    nsu: at(path.join(app.getPath('temp'), '~nsu.tmp', 'Un_A.exe')),
  };
}
ipcMain.handle('files:info', () => filesInfo());

/* 說明頁的「開啟位置」（見 開發筆記 D051）：畫面只給是哪一格，路徑在這裡重算（畫面不能指定任意路徑，同 D002）。
   資料夾就打開它；檔案（可攜版的 exe、Un_A.exe）就打開它所在的資料夾並選取它。
   可攜版解壓的資料夾不是正在用的話不知道名稱，打開暫存區。
   擴充資料夾（在「格式」頁，D056、D078）、外觀包資料夾（在「外觀」頁，D062）還沒有就先建：要裝的人才有地方放（見 D055）；
   截圖資料夾（截圖頁的「開啟資料夾」，D129）也是 */
ipcMain.handle('files:open', async (_, key) => {
  if (key === 'extensions') fs.mkdirSync(extDir(), { recursive: true });
  if (key === 'skins') fs.mkdirSync(skinDir(), { recursive: true });
  if (key === 'shots') fs.mkdirSync(shotDir(), { recursive: true });
  if (key === 'locales') fs.mkdirSync(langDir(), { recursive: true });   // 語言檔資料夾（「語言」頁，D131）也是
  const f = filesInfo();
  const p = { data: f.data, shots: f.shots, userData: f.userData, extensions: f.extensions, skins: f.skins, locales: f.locales, portableExe: f.portableExe, unpack: f.unpack || { path: f.tempDir, exists: fs.existsSync(f.tempDir) },
    installed: f.installed, updater: f.updater, nsu: f.nsu }[key];
  if (!p || !p.exists) throw new Error(L('這個位置目前沒有'));
  if (argOpenLog) return fs.appendFileSync(argOpenLog, p.path + '\n');
  if (fs.statSync(p.path).isDirectory()) {
    const err = await shell.openPath(p.path);
    if (err) throw new Error(L('打不開：{err}', { err }));
  } else {
    shell.showItemInFolder(p.path);
  }
});
/* 「格式」頁（見 開發筆記 D055、D056、D078）：內建的匯入、匯出格式，擴充資料夾和裡面的每個擴充（每次重讀，不用重開） */
const extList = () => ({
  dir: extDir(),
  builtin: FORMATS.map(({ label, hint }) => ({ label, hint: L(hint) })),
  builtinExport: EXPORT_FORMATS.map(({ label, hint, extension }) => ({ label, hint: L(hint), extension })),
  exts: scanExts().map(({ folder, name, displayName, version, formats, exportFormats, state, reason }) => ({ folder, name, displayName, version, formats, exportFormats, state, reason })),
});
ipcMain.handle('ext:list', () => extList());
/* 啟用／停用：只能啟用現在讀得到、未啟用的；記下名稱＋版本，改版要再啟用一次 */
ipcMain.handle('ext:enable', (_, name, on) => {
  const map = { ...extEnabled() };
  if (on) {
    const x = scanExts().find(e => e.name === name);
    if (!x || x.state !== 'disabled') throw new Error(L('這個擴充現在不能啟用，關掉「格式」再打開看看'));
    map[name] = x.version;
  } else {
    delete map[name];
  }
  setExtEnabled(map);
  return extList();
});
/* 刪除（見 開發筆記 D081，照外觀包的 D073）：整個資料夾丟到資源回收筒，要救回來去那裡還原。壞掉的也能刪。
   用資料夾名稱找（name 重複的壞掉那個跟好的同名），只能刪清單上有的。
   刪的是設定檔記著啟用的、而且沒有同名的留著，就一起停用：不然之後放進同名的會自己變成已啟用 */
ipcMain.handle('ext:delete', async (_, folder) => {
  const x = scanExts().find(e => e.folder === folder);
  if (!x) throw new Error(L('找不到這個擴充，關掉「格式」再打開看看'));
  const dir = path.join(extDir(), x.folder);
  if (argTrashDir) fs.renameSync(dir, path.join(argTrashDir, x.folder));
  else await shell.trashItem(dir);
  const map = { ...extEnabled() };
  if (map[x.name] && !scanExts().some(e => e.name === x.name)) {
    delete map[x.name];
    setExtEnabled(map);
  }
  return extList();
});

/* 「外觀」頁（見 開發筆記 D062）：外觀包資料夾裡的每個外觀包（每次重讀，不用重開） */
const skinList = () => ({
  dir: skinDir(),
  skins: scanSkins().map(({ folder, name, displayName, version, parts, state, reason }) => ({ folder, name, displayName, version, parts, state, reason })),
});
ipcMain.handle('skin:list', () => skinList());
/* 啟用／停用：一次只啟用一個，啟用別的就換掉現在的；只能啟用現在讀得到、未啟用的。只有圖、不跑程式，不用再按一次確定 */
ipcMain.handle('skin:enable', (_, name, on) => {
  if (on) {
    const x = scanSkins().find(s => s.name === name);
    if (!x || x.state !== 'disabled') throw new Error(L('這個外觀包現在不能啟用，關掉外觀再打開看看'));
  }
  setSkinEnabled(on ? name : null);
  return skinList();
});
/* 畫面一開、換外觀包時拿圖；沒啟用、或啟用的那個現在壞掉、不見了，回 null（照原本的樣子） */
ipcMain.handle('skin:load', () => {
  const x = scanSkins().find(s => s.state === 'enabled');
  return x ? skins.load(x) : null;
});
/* 「用圖檔做一個」（見 開發筆記 D066）：選圖讀成 data: 網址給畫面預覽、去背（取消回 null）；
   建立時開一個新的外觀包資料夾、寫 package.json，順便啟用（換掉現在的） */
ipcMain.handle('skin:pick', async () => {
  let file = argPickImage;
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: L('選一張圖'), properties: ['openFile'], filters: [{ name: L('圖檔'), extensions: skins.EXTS }] });
    if (r.canceled) return null;
    file = r.filePaths[0];
  }
  return skins.readImage(file);
});
ipcMain.handle('skin:create', (_, spec) => {
  const name = skins.create(skinDir(), app.getVersion(), spec);
  setSkinEnabled(name);
  return { name, ...skinList() };
});
/* 刪除（見 開發筆記 D073）：整個資料夾丟到資源回收筒，要救回來去那裡還原。壞掉的也能刪。
   用資料夾名稱找（name 重複的壞掉那個跟好的同名），只能刪清單上有的。
   刪的是設定檔記的那個（啟用中、或啟用後壞掉的）就一起停用，免得之後放進同名的又自己啟用；同名的還留著一個就不動 */
ipcMain.handle('skin:delete', async (_, folder) => {
  const x = scanSkins().find(s => s.folder === folder);
  if (!x) throw new Error(L('找不到這個外觀包，關掉外觀再打開看看'));
  const dir = path.join(skinDir(), x.folder);
  if (argTrashDir) fs.renameSync(dir, path.join(argTrashDir, x.folder));
  else await shell.trashItem(dir);
  if (skinEnabled() === x.name && !scanSkins().some(s => s.name === x.name)) setSkinEnabled(null);
  return skinList();
});

/* 「語言」頁（見 開發筆記 D131）：內建的繁體中文＋語言檔資料夾裡的每個（每次重讀，丟進去就有）；current 是現在用的（null 是繁體中文）。
   換語言、裝好、刪掉現在用的：主程序先換掉 L() 的字典，畫面接著自己重新載入。
   請 AI 翻：複製 prompt → 開 Gemini／ChatGPT（用 ai:open）→ 貼回 AI 回的 → 檢查 → 安裝並換成這個語言；裝的是檢查過的那一份（同 D056） */
const langList = () => ({ dir: langDir(), current: langId(), packs: locales.scan(langDir()) });
ipcMain.handle('lang:list', () => langList());
ipcMain.handle('lang:set', (_, id) => {
  if (id != null && !locales.scan(langDir()).some(x => x.id === id && x.state === 'ok')) throw new Error(L('這個語言檔現在讀不到，關掉「語言」再打開看看'));
  setLangId(id || null);
  loadLang();
});
ipcMain.handle('lang:prompt', (_, target) => locales.buildPrompt(langDir(), target));
ipcMain.handle('lang:copy', (_, target) => {
  const text = locales.buildPrompt(langDir(), target);
  if (argClipFile) return fs.writeFileSync(argClipFile, text);
  clipboard.writeText(text);
});
let langPending = null;   // 檢查過、等使用者按「安裝」的那一份（checkReply 回的＋token）
/* 回給畫面的不帶 good（原文對翻譯，很長）；problems 最多 50 條 */
ipcMain.handle('lang:check', (_, reply, target) => {
  langPending = { ...locales.checkReply(langDir(), reply, target), token: require('crypto').randomUUID() };
  const { good, problems, ...rest } = langPending;
  return { ...rest, problems: problems.slice(0, 50), more: Math.max(0, problems.length - 50) };
});
ipcMain.handle('lang:feedback', (_, token) => {
  if (!langPending || langPending.token !== token) throw new Error(L('要先按「檢查」'));
  const text = locales.buildFeedback(langPending);
  if (argClipFile) return fs.writeFileSync(argClipFile, text);
  clipboard.writeText(text);
});
ipcMain.handle('lang:install', (_, token) => {
  if (!langPending || langPending.token !== token || !langPending.n) throw new Error(L('要先按「檢查」，認得出翻譯的才能安裝'));
  const id = locales.install(langDir(), langPending);
  langPending = null;
  setLangId(id);
  loadLang();
});
/* 刪除：丟到資源回收筒（壞掉的也能刪）；刪的是現在用的就換回繁體中文，回傳的 reload 是 true（畫面要重新載入） */
ipcMain.handle('lang:delete', async (_, id) => {
  const x = locales.scan(langDir()).find(p => p.id === id);
  if (!x) throw new Error(L('找不到這個語言檔，關掉「語言」再打開看看'));
  const file = path.join(langDir(), x.id + '.json');
  if (argTrashDir) fs.renameSync(file, path.join(argTrashDir, x.id + '.json'));
  else await shell.trashItem(file);
  const reload = langId() === id;
  if (reload) { setLangId(null); loadLang(); }
  return { ...langList(), reload };
});

/* 請 AI 寫格式擴充（見 開發筆記 D056；匯出格式見 D079）：複製 prompt → 開 Gemini／ChatGPT → 貼回 AI 回的那段 →
   檢查（不執行）→ 在獨立程序試跑、預覽（匯入：選檔來拆；匯出：拿資料夾裡全部的紀錄匯出）→ 使用者按「安裝並啟用」才裝。
   kind：畫面上選的 'import'｜'export'。網址固定在這裡，畫面只給是哪一個 */
const AI_SITES = { gemini: 'https://gemini.google.com/app', chatgpt: 'https://chatgpt.com/' };
let aiPending = null;   // 試跑通過、等使用者按「安裝並啟用」的那一個 { token, pkg, code, folder, outputs, formats }；裝的就是試跑過的這份，不再拿畫面上的字
const aiKind = kind => (kind === 'export' ? 'export' : 'import');
const aiPrompt = kind => (aiKind(kind) === 'export' ? aiExt.buildExportPrompt : aiExt.buildPrompt)(app.getVersion());
ipcMain.handle('ai:prompt', (_, kind) => aiPrompt(kind));
ipcMain.handle('ai:copy', (_, kind) => {
  const text = aiPrompt(kind);
  if (argClipFile) return fs.writeFileSync(argClipFile, text);
  clipboard.writeText(text);
});
ipcMain.handle('ai:open', async (_, site) => {
  const url = AI_SITES[site];
  if (!url) throw new Error(L('不認得的網站'));
  if (argOpenLog) return fs.appendFileSync(argOpenLog, url + '\n');
  await shell.openExternal(url);
});
/* 沒通過時「複製給 AI」（見 開發筆記 D061）：r 是 ai:try 回的 { kind, stage, errors, excerpt } */
ipcMain.handle('ai:feedback', (_, r) => {
  const text = aiExt.buildFeedback(r);
  if (argClipFile) return fs.writeFileSync(argClipFile, text);
  clipboard.writeText(text);
});
/* 回傳 { kind, stage: 'check'｜'run', errors, excerpt: 試跑看不出原因時附的檔案開頭（D061） } 沒通過；通過回預覽＋token；選檔取消回 null */
ipcMain.handle('ai:try', async (_, reply, kind) => {
  aiPending = null;
  kind = aiKind(kind);
  const check = aiExt.checkReply(reply, app.getVersion(), kind);
  if (check.errors.length) return { kind, stage: 'check', errors: check.errors };
  const token = require('crypto').randomBytes(8).toString('hex');
  if (kind === 'export') {
    // 匯出格式拿資料夾裡全部的紀錄試跑（D079）：跟按「匯出全部」給的一樣
    if (!dataDir) throw new Error(L('先選資料夾：試跑要拿你的紀錄來匯出'));
    const r = await aiExt.tryExport({ check, data: exportRange({ all: true }).data, list: scanExts(), extRoot: extDir(), fork: forkExtHost });
    if (r.errors) return { kind, stage: 'run', errors: r.errors };
    aiPending = { token, pkg: check.pkg, code: check.code, folder: r.folder, outputs: r.outputs, formats: check.manifest.exportFormats };
    return { ...r.preview, token };
  }
  const file = await pickTryFile(check.manifest.formats);
  if (!file) return null;
  const has = rel => readText(path.join(dataDir, rel)).trim() !== '';
  const r = await aiExt.tryRun({
    check, text: readImportText(file), list: scanExts(), extRoot: extDir(), exists: dataDir ? has : () => false, fork: forkExtHost,
  });
  if (r.errors) return { kind, stage: 'run', errors: r.errors, excerpt: r.excerpt };
  aiPending = { token, pkg: check.pkg, code: check.code, folder: r.folder };
  return { ...r.preview, kind, file: path.basename(file), token };
});
/* 匯出格式試跑的「存一份看看…」（見 開發筆記 D079）：存的是試跑時匯出的那一份（i：第幾種格式），打開來看對不對；取消回 null */
ipcMain.handle('ai:save', async (_, token, i) => {
  if (!aiPending || aiPending.token !== token || !aiPending.outputs || aiPending.outputs[i] == null) throw new Error(L('要先按「檢查並試跑…」，通過了才能存'));
  const fmt = aiPending.formats[i], out = aiPending.outputs[i];
  const file = await pickSaveFile(L('工作紀錄_試跑.{ext}', { ext: fmt.extension }), fmt);
  if (!file) return null;
  fs.writeFileSync(file, out);
  return file;
});
/* 裝進擴充資料夾、啟用（使用者選的：裝好就啟用、不匯入）。同名的裝回原本那個資料夾，只換 package.json 和 index.js */
ipcMain.handle('ai:install', (_, token) => {
  if (!aiPending || aiPending.token !== token) throw new Error(L('要先按「檢查並試跑…」，通過了才能安裝'));
  const { pkg, code, folder } = aiPending;
  aiPending = null;
  const dir = path.join(extDir(), folder);
  writeAtomic(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeAtomic(path.join(dir, 'index.js'), code);
  setExtEnabled({ ...extEnabled(), [pkg.name]: pkg.version });
  return extList();
});

ipcMain.handle('days:list', () => listDays());
ipcMain.handle('day:read', (_, date) => readText(path.join(dataDir, dayPath(date))));
ipcMain.handle('day:write', (_, date, text) => writeDay(date, text));
ipcMain.handle('todo:read', () => readText(path.join(dataDir, TODO_FILE)));
ipcMain.handle('todo:write', (_, text) => writeAtomic(path.join(dataDir, TODO_FILE), text));
ipcMain.handle('search', (_, q) => srch.search(index(), q));
ipcMain.handle('timeline', (_, by) => (by.event != null ? srch.timelineByEvent(index(), by.event) : srch.timelineByCode(index(), by.code)));
// 自動補完的候選（見 開發筆記 D031、D032）：畫面在檔案變了之後、下次打字時才來拿
ipcMain.handle('suggest', () => srch.suggestions(index()));
ipcMain.handle('export:formats', () => exportFormatList().map(({ key, label, hint, extension, ext }) => ({ key, label, hint: L(hint), extension, ext: ext || null })));
ipcMain.handle('export', (_, req) => exportFile(req));
ipcMain.handle('backup', () => backupData());
ipcMain.handle('import:file', () => importFile());
/* 亮／暗（見 開發筆記 D034）：畫面切了就跟著切，視窗標題列、底色才會一起變；'system' 是跟 Windows 設定 */
ipcMain.handle('theme:set', (_, t) => {
  nativeTheme.themeSource = ['dark', 'light'].includes(t) ? t : 'system';
  paintWindow();
});
/* 標題列自己畫（見 開發筆記 D100）：右邊最小化／放大／關閉是 Electron 畫的（titleBarOverlay），
   顏色要跟網頁畫的那條（style.css 的 --title-bg、--title-fg）一樣，改的話兩邊一起改 */
const TITLE_BAR_H = 35;   // VS Code 的標題列高度
const titleBarColors = () => (nativeTheme.shouldUseDarkColors
  ? { color: '#3c3c3c', symbolColor: '#cccccc' }    // VS Code Dark+ 的 titleBar.activeBackground／activeForeground
  : { color: '#f8f8f8', symbolColor: '#1e1e1e' });  // VS Code Light Modern 的
/* 視窗底色（見 開發筆記 D115）：照 VS Code 設成畫面的底色（style.css 的 --bg，改的話兩邊一起改）。
   沒設是 Electron 預設的白，最小化的動畫有時會畫成整片底色，黑暗模式就閃一下白 */
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#fafaf8');
function paintWindow() {
  if (win && !win.isDestroyed()) {
    win.setTitleBarOverlay(titleBarColors());
    win.setBackgroundColor(windowBg());
  }
}
nativeTheme.on('updated', paintWindow);   // 跟 Windows 設定時，Windows 切亮暗
/* 復原（見 開發筆記 D028）：卡片的每個寫檔動作，記下動到的檔「改之前／改之後」的內容；
   Ctrl+Z 時那幾個檔都還是「改之後」的樣子才還原——之後又被改過（外部編輯、文字模式）就不動，免得蓋掉。
   label 是動作名稱（LK 標過的中文原文），回給畫面、寫進錯誤時才 L()：中途換了語言也照新的語言顯示（D131） */
const undoStack = [];
const readOrNull = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
function withUndo(label, srcs, fn) {
  const files = [...new Set(srcs.map(fileOf))];
  const before = files.map(readOrNull);
  const result = fn();
  const after = files.map(readOrNull);
  if (files.some((_, i) => before[i] !== after[i])) {
    undoStack.push({ label, files, before, after });
    if (undoStack.length > 50) undoStack.shift();
  }
  return result;
}
function undo() {
  const op = undoStack.pop();
  if (!op) return null;
  if (op.files.some((f, i) => readOrNull(f) !== op.after[i])) throw new Error(L('「{op}」之後檔案又被改過，不能復原', { op: L(op.label) }));
  op.files.forEach((f, i) => (op.before[i] == null ? fs.rmSync(f, { force: true }) : writeAtomic(f, op.before[i])));
  return L(op.label);
}

ipcMain.handle('cards:list', (_, src) => ent.listEntries(readText(fileOf(src))));
ipcMain.handle('card:add', (_, src, card) => withUndo(LK('新增'), [src], () => writeSrc(src, ent.addEntry(readText(fileOf(src)), card))));
ipcMain.handle('card:edit', (_, src, i, raw, card) => withUndo(LK('編輯'), [src], () => writeSrc(src, ent.editEntry(readText(fileOf(src)), i, raw, card))));
ipcMain.handle('card:delete', (_, src, i, raw) => withUndo(LK('刪除'), [src], () => writeSrc(src, ent.deleteEntry(readText(fileOf(src)), i, raw))));
ipcMain.handle('card:status', (_, src, i, raw, status) => withUndo(LK('待回覆'), [src], () => writeSrc(src, ent.setStatus(readText(fileOf(src)), i, raw, status))));
// + 更新可能動到原本那筆和今天的檔（見 D022、D024）
ipcMain.handle('card:update', (_, src, i, raw, text) => withUndo(LK('更新'), [src, localToday()], () => addUpdate(src, i, raw, text)));
ipcMain.handle('card:done', (_, i, raw, date, unfinished) => withUndo(unfinished ? LK('已處理+未完標籤') : LK('處理完'), ['todo', date], () => markDone(i, raw, date, unfinished)));
// 隱藏只給待處理用（見 開發筆記 D026）
ipcMain.handle('card:hidden', (_, i, raw, hidden) => withUndo(hidden ? LK('隱藏') : LK('取消隱藏'), ['todo'],
  () => writeSrc('todo', ent.setHidden(readText(fileOf('todo')), i, raw, hidden))));
// 標記給已處理用：還要注意、還沒完（見 開發筆記 D072）；左邊「標記」列出全部。cat 是分類，沒給是未分類（D076）
ipcMain.handle('card:flag', (_, src, i, raw, flagged, cat) => withUndo(flagged ? LK('標記') : LK('取消標記'), [src],
  () => writeSrc(src, ent.setFlagged(readText(fileOf(src)), i, raw, flagged, cat))));
ipcMain.handle('flagged', () => srch.flaggedItems(index()));
ipcMain.handle('range', (_, from, to) => srch.rangeItems(index(), from, to));
// 分類清單、加新分類（見 開發筆記 D076）；加分類不算卡片動作，Ctrl+Z 不復原
ipcMain.handle('flag:cats', () => flagCats());
ipcMain.handle('flag:addCat', (_, name) => addCat(name));
/* 剪貼簿（見 開發筆記 D093；原本叫「暫存」，D096）：加、改、刪、搬跟卡片一樣 Ctrl+Z 復原得了（刪除不跳詢問，D028） */
/* 舊檔名 暫存.md 改名成 剪貼簿.md（D096）：讀、改之前先看，只有舊的才改名；兩個都有就用新的、舊的不動。
   改之前就要先改名，withUndo 記的「改之前」才是搬過來的內容（不然復原會把檔刪掉）。改名失敗照樣丟錯，畫面跳提示，不會當成空的 */
function snipMigrate() {
  const old = path.join(dataDir, OLD_SNIP_FILE);
  if (!fs.existsSync(fileOf('snip')) && fs.existsSync(old)) fs.renameSync(old, fileOf('snip'));
}
const snipWrite = (label, fn) => { snipMigrate(); return withUndo(label, ['snip'], () => writeSrc('snip', fn(readText(fileOf('snip'))))); };
ipcMain.handle('snips:list', () => { snipMigrate(); return snip.listSnips(readText(fileOf('snip'))); });
ipcMain.handle('snip:add', (_, s) => snipWrite(LK('剪貼簿新增'), t => snip.addSnip(t, s)));
ipcMain.handle('snip:edit', (_, i, raw, s) => snipWrite(LK('剪貼簿編輯'), t => snip.editSnip(t, i, raw, s)));
ipcMain.handle('snip:delete', (_, i, raw) => snipWrite(LK('剪貼簿刪除'), t => snip.deleteSnip(t, i, raw)));
ipcMain.handle('snip:move', (_, i, raw, to) => snipWrite(LK('剪貼簿搬移'), t => snip.moveSnip(t, i, raw, to)));   // 調順序（D125）
/* 複製：Windows 的剪貼簿文字換行是 \r\n，主程序的 clipboard.writeText 不會幫忙轉（網頁那條路才會），自己轉；
   原本就是 \r\n 的不會變成 \r\r\n */
ipcMain.handle('snip:copy', (_, text) => {
  const t = process.platform === 'win32' ? String(text).replace(/\r?\n/g, '\r\n') : String(text);
  if (argClipFile) return fs.writeFileSync(argClipFile, t);
  clipboard.writeText(t);
});
/* 記事本（見 開發筆記 D102）：資料夾的 記事本\ 裡一份一個 .txt，檔名就是名稱；名稱、路徑的規則在 notes.js。
   可以開資料夾（D116）：記事、資料夾都用相對路徑認（工作/週會），畫面傳來的要是清單上有的才拼成路徑（不能拿來指到別的地方）。
   不走 withUndo：打的字由文字框自己復原；刪除丟資源回收筒，要救去那裡還原。
   存檔照 VS Code（D105）：畫面按 Ctrl+S 才寫檔；「＋」開的新記事不建檔，取名存檔時才建（note:create）。
   others 是畫面上還沒存的新記事的名稱，取名、改名也不能跟它們同名 */
const noteDir = () => path.join(dataDir, NOTE_DIR);
const noteAbs = rel => path.join(noteDir(), ...rel.split('/'));
/* 記事本\ 底下全部的記事和資料夾（一層一層進去）：{ files, dirs }，相對路徑；順序畫面自己排（照名稱，D116）。還沒有資料夾就是空的 */
function listNotes() {
  const files = [], dirs = [];
  const walk = rel => {
    let items;
    try { items = fs.readdirSync(rel ? noteAbs(rel) : noteDir(), { withFileTypes: true }); } catch { return; }
    for (const f of items) {
      if (f.isDirectory()) { dirs.push(notes.joinRel(rel, f.name)); walk(notes.joinRel(rel, f.name)); }
      else if (f.isFile() && notes.nameOf(f.name)) files.push(notes.joinRel(rel, notes.nameOf(f.name)));
    }
  };
  walk('');
  return { files, dirs };
}
// 同一個資料夾裡的名稱（取名、改名、搬過去時不能撞）
const namesIn = (list, dir) => list.filter(r => notes.parentOf(r) === dir).map(notes.baseOf);
/* 外面改名、刪掉了就報錯 */
function noteFile(rel) {
  if (!listNotes().files.includes(rel)) throw new Error(L('找不到「{name}」，可能在外面被改名或刪掉了', { name: rel }));
  return noteAbs(rel) + notes.EXT;
}
function noteFolder(rel) {
  if (rel && !listNotes().dirs.includes(rel)) throw new Error(L('找不到資料夾「{name}」，可能在外面被改名或刪掉了', { name: rel }));
  return rel;
}
const noteTrash = async abs => {
  if (argTrashDir) fs.renameSync(abs, path.join(argTrashDir, path.basename(abs)));
  else await shell.trashItem(abs);
};
ipcMain.handle('notes:list', () => listNotes());
ipcMain.handle('note:read', (_, rel) => notes.decode(fs.readFileSync(noteFile(rel))));
ipcMain.handle('note:write', (_, rel, text) => writeAtomic(noteFile(rel), text));
ipcMain.handle('note:newName', (_, others = [], dir = '') => notes.newName([...namesIn(listNotes().files, dir), ...others]));
/* 存在 dir 那個資料夾；資料夾在外面被刪掉了就照原本的路徑再建（跟「照原本的名稱再存一份」一樣，D105） */
ipcMain.handle('note:create', (_, dir, name, text, others = []) => {
  const { files, dirs } = listNotes();
  const d = !dir || dirs.includes(dir) ? dir : notes.checkPath(dir);
  const rel = notes.joinRel(d, notes.checkName(name, [...namesIn(files, d), ...others]));
  writeAtomic(noteAbs(rel) + notes.EXT, text);
  return rel;
});
ipcMain.handle('note:rename', (_, from, to, others = []) => {
  const file = noteFile(from), dir = notes.parentOf(from);
  const rel = notes.joinRel(dir, notes.checkName(to, [...namesIn(listNotes().files, dir).filter(n => n !== notes.baseOf(from)), ...others]));
  if (rel !== from) fs.renameSync(file, noteAbs(rel) + notes.EXT);
  return rel;
});
/* text：改過沒存的內容，先寫進去再丟，資源回收筒裡的才是最新的（D105）；檔案在外面被刪掉了就照原本的路徑建一份再丟
   （跟別份只差大小寫的不建，免得蓋到那一份） */
ipcMain.handle('note:delete', async (_, rel, text = null) => {
  let file;
  const { files, dirs } = listNotes();
  if (text == null || files.includes(rel)) file = noteFile(rel);
  else {
    const dir = notes.parentOf(rel), d = !dir || dirs.includes(dir) ? dir : notes.checkPath(dir);
    file = noteAbs(notes.joinRel(d, notes.checkName(notes.baseOf(rel), namesIn(files, d)))) + notes.EXT;
  }
  if (text != null) writeAtomic(file, text);
  await noteTrash(file);
});
/* 拖到別的資料夾（D116）：記事或資料夾搬進 to（'' 是最上層），名稱不變；那裡已經有同名的、資料夾搬進自己底下都不行 */
ipcMain.handle('note:move', (_, from, to, isDir) => {
  const { files, dirs } = listNotes();
  if (!(isDir ? dirs : files).includes(from)) throw new Error(L('找不到「{name}」，可能在外面被改名或刪掉了', { name: from }));
  noteFolder(to);
  if (isDir && notes.within(to, from)) throw new Error(L('不能把資料夾搬到它自己裡面'));
  const rel = notes.joinRel(to, notes.baseOf(from)), ext = isDir ? '' : notes.EXT;
  if (rel === from) return rel;
  if (fs.existsSync(noteAbs(rel) + ext)) throw new Error(L('「{dir}」裡已經有「{name}」了', { dir: to || NOTE_DIR, name: notes.baseOf(from) }));
  fs.renameSync(noteAbs(from) + ext, noteAbs(rel) + ext);
  return rel;
});
/* 資料夾（D116）：建在 parent 裡面、改名、整個丟資源回收筒。
   dirty 是裡面改過沒存的記事 [{ name, text }]：跟刪一份一樣先寫進去再丟（外面刪掉的照原本的路徑建回來） */
ipcMain.handle('noteDir:add', (_, parent, name) => {
  const p = noteFolder(parent);
  const rel = notes.joinRel(p, notes.checkName(name, namesIn(listNotes().dirs, p)));
  if (fs.existsSync(noteAbs(rel))) throw new Error(L('已經有「{name}」了', { name: notes.baseOf(rel) }));
  fs.mkdirSync(noteAbs(rel), { recursive: true });
  return rel;
});
ipcMain.handle('noteDir:rename', (_, from, to) => {
  if (!from) throw new Error(L('沒有指定資料夾'));
  noteFolder(from);
  const dirs = listNotes().dirs, p = notes.parentOf(from);
  const rel = notes.joinRel(p, notes.checkName(to, namesIn(dirs, p).filter(n => n !== notes.baseOf(from))));
  if (rel === from) return rel;
  if (rel.toLowerCase() !== from.toLowerCase() && fs.existsSync(noteAbs(rel))) throw new Error(L('已經有「{name}」了', { name: notes.baseOf(rel) }));
  fs.renameSync(noteAbs(from), noteAbs(rel));
  return rel;
});
ipcMain.handle('noteDir:delete', async (_, rel, dirty = []) => {
  if (!rel) throw new Error(L('沒有指定資料夾'));
  noteFolder(rel);
  const files = listNotes().files;
  for (const d of dirty) {
    if (d.name.toLowerCase() === rel.toLowerCase() || !notes.within(d.name, rel)) continue;   // 記事 a 跟資料夾 a 可以同時有：只寫資料夾底下的
    writeAtomic(noteAbs(files.includes(d.name) ? d.name : notes.checkPath(d.name)) + notes.EXT, d.text);
  }
  await noteTrash(noteAbs(rel));
});
/* 右鍵選單（D117）：完整路徑（複製用）；用檔案總管打開它在的資料夾、選到它。路徑一樣只認清單上有的 */
const notePathOf = (rel, isDir) => (isDir ? noteAbs(noteFolder(rel)) : noteFile(rel));
ipcMain.handle('note:path', (_, rel, isDir) => notePathOf(rel, isDir));
ipcMain.handle('note:reveal', (_, rel, isDir) => {
  const p = notePathOf(rel, isDir);
  if (argOpenLog) return fs.appendFileSync(argOpenLog, p + '\n');
  shell.showItemInFolder(p);
});
/* 記事本沒存的內容（見 開發筆記 D105）：照 VS Code、Notepad++ 放在這台電腦的 %APPDATA%\daybook\note-backup\，不放紀錄資料夾。
   一個紀錄資料夾一個檔（檔名是資料夾路徑的雜湊）：{ dir, untitled: [{ name, text, folder }], dirty: [{ name, text }] }，都沒有就刪掉。
   folder 是新記事要存在哪個資料夾、dirty 的 name 是相對路徑（D116；之前的版本沒有 folder，就是最上層）。
   dir 由畫面給：換資料夾後重新載入前寫的那一次，是舊資料夾的 */
const noteBackupFile = dir => path.join(app.getPath('userData'), 'note-backup',
  require('crypto').createHash('md5').update(String(dir).toLowerCase()).digest('hex').slice(0, 8) + '.json');
function writeNoteBackup(dir, b) {
  const file = noteBackupFile(dir);
  if (!b.untitled.length && !b.dirty.length) return fs.rmSync(file, { force: true });
  writeAtomic(file, JSON.stringify({ dir, untitled: b.untitled, dirty: b.dirty }));
}
ipcMain.handle('noteBackup:read', (_, dir) => {
  try {
    const b = JSON.parse(fs.readFileSync(noteBackupFile(dir), 'utf8'));
    return { untitled: b.untitled || [], dirty: b.dirty || [] };
  } catch { return { untitled: [], dirty: [] }; }   // 沒有、壞掉了：當作沒有
});
ipcMain.handle('noteBackup:write', (_, dir, b) => writeNoteBackup(dir, b));
// 關視窗、重新載入時（畫面的 beforeunload）：要等寫完才放行，不然最後 0.6 秒打的字會掉
ipcMain.on('noteBackup:writeSync', (e, dir, b) => {
  try { writeNoteBackup(dir, b); } catch { /* 寫不進去也不能擋住關視窗 */ }
  e.returnValue = true;
});
/* 文件檢視（原本叫 MD 檢視，見 開發筆記 D118；也看 .html，D122）：唯讀，不寫任何檔。清單是每個釘住的資料夾 { dir, files（相對路徑）, missing（資料夾不在了） }。
   畫面傳來的檔要是釘住的資料夾底下的 .md、.html 才讀（不能拿來讀別的檔）；.md 轉成 HTML 再給畫面（md-view.js），.html 給 docview 網址 */
const mdUnder = file => {   // 在某個釘住的資料夾底下（不含資料夾本身）：回完整路徑，不是回 null
  const f = path.resolve(String(file));
  const under = r => { const rel = path.relative(r, f); return !!rel && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel); };
  return mdRoots().some(under) ? f : null;
};
const mdIn = file => (mdView.isDoc(String(file)) ? mdUnder(file) : null);
ipcMain.handle('md:list', () => Promise.all(mdRoots().map(async dir =>
  (fs.existsSync(dir) ? { dir, files: await mdView.listDocs(dir) } : { dir, files: [], missing: true }))));
// 釘資料夾：跳選資料夾的視窗；取消回 null，已經釘了回 { dir, dup: true }
ipcMain.handle('md:add', async () => {
  const dir = await pickMdDir(win);
  if (!dir) return null;
  if (mdRoots().some(r => r.toLowerCase() === dir.toLowerCase())) return { dir, dup: true };
  setMdRoots([...mdRoots(), dir]);
  return { dir };
});
ipcMain.handle('md:remove', (_, dir) => setMdRoots(mdRoots().filter(r => r !== dir)));   // 不釘了：檔案不動
/* 讀一份：.md 回 { html }（轉好的）；.html 回 { url }（docview 網址，帶修改時間和大小——檔案改了網址才變，iframe 才重新載入，D122）。
   這個網址記成 docAllowed：iframe 只准載入這一個，裡面點連結換頁的都攔下來（docNav） */
let docAllowed = null;
const DOC_ERR = LK('只能看釘住的資料夾裡的 .md、.html');
ipcMain.handle('md:read', (_, file) => {
  const f = mdIn(file);
  if (!f) throw new Error(L(DOC_ERR));
  if (mdView.isMd(f)) return { html: mdView.render(notes.decode(fs.readFileSync(f))) };
  const st = fs.statSync(f);
  docAllowed = mdView.docUrl(f, `${st.mtimeMs}-${st.size}`);
  return { url: docAllowed };
});
// 文件裡的相對連結（other.md、../a/b.html#段落）：換成完整路徑；不是釘住的資料夾裡、存在的 .md、.html 回 null
ipcMain.handle('md:resolve', (_, from, href) => {
  const f = mdIn(from);
  let p = null;
  try { p = decodeURIComponent(String(href).replace(/[?#].*$/, '')); } catch { /* 編碼壞掉的連結：當作開不了 */ }
  const t = f && p ? mdIn(path.resolve(path.dirname(f), p)) : null;
  return t && fs.existsSync(t) ? t : null;
});
// 頁籤、清單右鍵「在檔案總管中顯示」（D120、D121）：釘住的資料夾裡的 .md，或釘住的資料夾本身、底下的資料夾；測試帶 --open-log 時寫路徑不真的開
const mdDirIn = p => {
  const d = path.resolve(String(p));
  const under = r => { const rel = path.relative(r, d); return !rel || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel)); };
  return mdRoots().some(under) && fs.existsSync(d) && fs.statSync(d).isDirectory() ? d : null;
};
ipcMain.handle('md:reveal', (_, file) => {
  const f = mdIn(file) || mdDirIn(file);
  if (!f) throw new Error(L('只能看釘住的資料夾裡的 .md、.html、資料夾'));
  if (argOpenLog) return fs.appendFileSync(argOpenLog, f + '\n');
  shell.showItemInFolder(f);
});
// 右鍵「用瀏覽器開」（D122，只有 .html）：用 Windows 設定的預設程式開那個檔（小工具、要印的時候用）；測試帶 --open-log 時寫路徑不真的開
ipcMain.handle('md:browser', async (_, file) => {
  const f = mdIn(file);
  if (!f || !mdView.isHtml(f)) throw new Error(L('只有 .html 能用瀏覽器開'));
  if (argOpenLog) return fs.appendFileSync(argOpenLog, f + '\n');
  const err = await shell.openPath(f);
  if (err) throw new Error(err);
});
// 網址連結用瀏覽器開；只開 http、https、mailto
async function openOut(url) {
  if (!/^(https?|mailto):/i.test(String(url))) throw new Error(L('只開得了網址（http、https）、寄信（mailto）的連結'));
  if (argOpenLog) return fs.appendFileSync(argOpenLog, url + '\n');
  await shell.openExternal(url);
}
ipcMain.handle('md:link', (_, url) => openOut(url));
/* .html 裡點連結（D122）：iframe 換頁、開新視窗都攔下來（主視窗的 will-frame-navigate、setWindowOpenHandler 叫這裡）。
   網址用瀏覽器開；連到釘住的資料夾裡的 .md、.html 就請畫面開成頁籤（md:open）；其他的不理。同一頁的 #段落不會到這裡（照常跳） */
function docNav(url) {
  if (/^(https?|mailto):/i.test(url)) { openOut(url).catch(() => { /* 開不了就算了 */ }); return; }
  const f = mdView.docFile(url), t = f && mdIn(f);
  if (t && fs.existsSync(t) && win && !win.isDestroyed()) win.webContents.send('md:open', t);
}
/* .html 和它用到的圖、css、字型（D122）：docview://local/<路徑>，只給釘住的資料夾底下的檔。
   網頁加 CSP：程式不跑、不連到外面（使用者選的）；字型在沙盒（opaque origin）裡要 CORS 才載得到，一律加 Access-Control-Allow-Origin */
async function serveDoc(req) {
  const f = mdUnder(mdView.docFile(req.url) || '');
  if (!f) return new Response('', { status: 403 });
  let body;
  try { body = await fs.promises.readFile(f); } catch { return new Response('', { status: 404 }); }
  const headers = { 'Content-Type': mdView.mimeOf(f), 'Access-Control-Allow-Origin': '*' };   // 網頁不寫 charset：照檔案裡的 <meta charset>（Word 轉的常是 big5）
  if (mdView.isHtml(f)) headers['Content-Security-Policy'] = mdView.DOC_CSP;
  return new Response(body, { headers });
}
/* 釘住的資料夾裡 .md、.html 改了、多了、少了（檔案、資料夾改名、刪掉也算）就通知畫面；連續的事件合併成一次。
   node_modules、.git 裡的不算；不是 .md、.html 的檔只改內容不算 */
let mdWatchers = [], mdTimer = null;
function watchMd() {
  for (const w of mdWatchers) w.close();
  mdWatchers = [];
  for (const dir of mdRoots()) {
    try {
      const w = fs.watch(dir, { recursive: true }, (type, name) => {
        const n = name ? String(name) : '';
        if (mdView.skipped(n) || (type === 'change' && !mdView.isDoc(n))) return;
        clearTimeout(mdTimer);
        mdTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('md:changed'); }, 150);
      });
      w.on('error', () => { /* 資料夾被刪掉、隨身碟拔掉：清單上寫找不到 */ });
      mdWatchers.push(w);
    } catch { /* 資料夾不在：清單上寫找不到 */ }
  }
}
/* ---------- 截圖（見 開發筆記 D129）：取代 Windows 剪取工具 ----------
   截好的存成截圖資料夾最上層的 <編號>.png、複製到剪貼簿；要留下來的取名搬進 保留\。畫面傳來的一律是相對路徑，
   只認編號的截圖、保留\ 裡的 .png（shots.checkRel），不能拿來動別的檔。刪除、清掉都丟資源回收筒，不走 withUndo */
function shotFile(rel) {
  const parts = shots.checkRel(rel);
  if (!parts) throw new Error(L('只能動截圖資料夾裡的截圖'));
  const f = path.join(shotDir(), ...parts);
  if (!fs.existsSync(f)) throw new Error(L('找不到「{name}」，可能在外面被改名或刪掉了', { name: rel }));
  return f;
}
/* 截圖頁的清單：items 是編號的、kept 是保留的，都是 { rel, name, mtimeMs, day }；順序畫面自己排 */
function scanShots() {
  const dir = shotDir();
  const ents = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };   // 資料夾還沒有：空的
  const item = rel => {
    const s = fs.statSync(path.join(dir, ...rel.split('/')), { throwIfNoEntry: false });
    return s && { rel, name: path.parse(rel).name, mtimeMs: s.mtimeMs, day: shots.dayOf(s.mtimeMs) };
  };
  const items = ents(dir).filter(e => e.isFile() && shots.numOf(e.name) != null).map(e => item(e.name));
  const kept = ents(path.join(dir, shots.KEEP_DIR)).filter(e => e.isFile() && shots.checkRel(shots.KEEP_DIR + '/' + e.name))
    .map(e => item(shots.KEEP_DIR + '/' + e.name));
  return { dir, today: localToday(), items: items.filter(Boolean), kept: kept.filter(Boolean) };
}
/* 畫面上那份清單的樣子（每張的相對路徑＋修改時間）：監看收到事件時比這個，有變才通知畫面。
   這台電腦的 NTFS 會更新「上次存取時間」（fsutil 查到 DisableLastAccess = 2），畫面讀縮圖也會觸發監看，不比的話打開截圖頁就多重畫一次（量過） */
const shotSigOf = r => [...r.items, ...r.kept].map(s => `${s.rel}:${s.mtimeMs}`).sort().join('|');
let shotSig = null;
function listShots() {
  const r = scanShots();
  shotSig = shotSigOf(r);
  watchShots();
  return r;
}
/* 複製到剪貼簿：圖（image/png）＋檔案（text/uri-list，Windows 那邊是 FileDrop，跟檔案總管 Ctrl+C 一樣）一起放。
   只放圖的話，Claude Code 在 Windows Terminal 按 Ctrl+V 收不到（要按 Alt+V）；檔案總管複製的檔案 Ctrl+V 貼得進去、Teams 也收（使用者說的），所以檔案也放（D129〈後續〉）。
   Electron 45 的剪貼簿沒有 writeImage 了（electron.d.ts 只剩 read、write、readText、writeText、has、clear），包成 ClipboardItem 用 write 寫；
   2026-11-02 拿使用者的截圖試過：Windows 那邊有 PNG、Bitmap、FileDrop，ContainsImage 是 True，GetFileDropList 的路徑跟檔案一字不差（路徑有中文）。
   測試帶 --clipboard-file 時一樣先組好 ClipboardItem，再從裡面拿出來：png 寫進那個檔、檔案的網址寫進 <那個檔>.uri，不碰使用者的剪貼簿（同 D093） */
async function copyShot(file, png = fs.readFileSync(file)) {
  const item = new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }), 'text/uri-list': pathToFileURL(file).href });
  if (argClipFile) {
    fs.writeFileSync(argClipFile, Buffer.from(await (await item.getType('image/png')).arrayBuffer()));
    return fs.writeFileSync(argClipFile + '.uri', await (await item.getType('text/uri-list')).text());
  }
  await clipboard.write([item]);
}
const shotTrash = async f => {
  if (argTrashDir) fs.renameSync(f, path.join(argTrashDir, path.basename(f)));
  else await shell.trashItem(f);
};
/* 存成下一號（資料夾裡最大的號、設定檔記的用過的最大號，比較大的 +1）、記下這一號、複製。'wx'：不蓋掉已經有的檔 */
async function saveShot(png) {
  const dir = shotDir();
  fs.mkdirSync(dir, { recursive: true });
  const no = shots.nextNo(fs.readdirSync(dir), shotNo());
  fs.writeFileSync(path.join(dir, no + '.png'), png, { flag: 'wx' });
  setShotSetting('shotNo', no);
  await copyShot(path.join(dir, no + '.png'), png);
  watchShots();
  return { name: String(no), rel: no + '.png' };
}
/* 「＋ 截圖」：daybook 自己先變透明（不藏起來：還是最前面的程式，蓋上去那層才拿得到鍵盤），等畫面換掉再抓每個螢幕，
   蓋一層讓使用者框選、畫框箭頭 → 存、複製。取消回 null；正在截的時候再按也回 null。
   SHOT_HIDE_MS：變透明到抓畫面中間等多久（Claude 定的；真的螢幕上 daybook 有沒有被截進去還沒量過，見 D129） */
const SHOT_HIDE_MS = 150;
let shooting = false;
ipcMain.handle('shot:capture', async () => {
  if (shooting || !win || win.isDestroyed()) return null;
  shooting = true;
  let png = null;
  try {
    win.setOpacity(0);
    await new Promise(r => setTimeout(r, SHOT_HIDE_MS));
    const frames = argShotImage ? shot.fakeFrames(argShotImage) : await shot.grabScreens();
    png = await shot.capture(frames, { quiet: argQuietWindow, ignoreMouse: argIgnoreMouse });
  } finally {
    shooting = false;
    if (!win.isDestroyed()) {
      win.setOpacity(1);
      if (!argQuietWindow) win.focus();   // 安靜跑不搶焦點（D052）
    }
  }
  return png ? await saveShot(png) : null;
});
ipcMain.handle('shots:list', () => listShots());
ipcMain.handle('shot:copy', (_, rel) => copyShot(shotFile(rel)));
/* 留下來：編號的取名搬進 保留\（名稱規則照記事本，同名不分大小寫）；打了 .png 的不再多加一個。回傳新的相對路徑 */
ipcMain.handle('shot:keep', (_, rel, name) => {
  const parts = shots.checkRel(rel);
  if (!parts || parts.length !== 1) throw new Error(L('只有編號的截圖能留下來'));
  const from = shotFile(rel), keepDir = path.join(shotDir(), shots.KEEP_DIR);
  let have = [];
  try { have = fs.readdirSync(keepDir).filter(f => /\.png$/i.test(f)).map(f => f.slice(0, -4)); } catch { /* 還沒有 保留\ */ }
  const n = notes.checkName(String(name == null ? '' : name).trim().replace(/\.png$/i, ''), have);
  fs.mkdirSync(keepDir, { recursive: true });
  fs.renameSync(from, path.join(keepDir, n + '.png'));
  return shots.KEEP_DIR + '/' + n + '.png';
});
ipcMain.handle('shot:delete', (_, rel) => shotTrash(shotFile(rel)));
/* 清掉 N 天前的：編號的截圖裡，那一天（修改時間）在 today−N（含）以前的丟資源回收筒，保留的不動。
   dry：只算不丟（畫面先問「N 張丟到資源回收筒？」用），回 { cut, n } */
ipcMain.handle('shot:clean', async (_, days, dry) => {
  const cut = shots.cutoffDay(localToday(), days);
  const old = scanShots().items.filter(i => i.day <= cut);
  if (!dry) for (const i of old) await shotTrash(path.join(shotDir(), i.rel));
  return { cut, n: old.length };
});
/* 變更資料夾：原本那個不動；編號照設定檔記的用過的最大號接下去（新資料夾裡有更大的就從它接）。取消回 null */
ipcMain.handle('shot:pickDir', async () => {
  let dir = argPickShotDir;
  if (!dir) {
    const r = await dialog.showOpenDialog(win, { title: L('選放截圖的資料夾'), defaultPath: shotDir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    dir = r.filePaths[0];
  }
  setShotSetting('shotDir', dir);
  return dir;
});
/* 截圖資料夾裡多了、少了、改名（外面用檔案總管動的也算）就通知畫面；連續的事件合併成一次。
   截圖頁第一次列清單時才開始看（每次開 daybook 不必去碰桌面）；資料夾還沒有就等存第一張時再看 */
let shotWatcher = null, shotWatched = null, shotTimer = null;
function watchShots() {
  const dir = shotDir();
  if (shotWatcher && shotWatched === dir) return;
  if (shotWatcher) shotWatcher.close();
  shotWatcher = null;
  shotWatched = dir;
  try {
    shotWatcher = fs.watch(dir, { recursive: true }, () => {
      clearTimeout(shotTimer);
      shotTimer = setTimeout(() => {
        if (!win || win.isDestroyed() || shotSigOf(scanShots()) === shotSig) return;   // 只是讀了檔（存取時間變了）：清單沒變，不重畫
        win.webContents.send('shot:changed');
      }, 150);
    });
    shotWatcher.on('error', () => { /* 資料夾被刪掉：清單上就是空的 */ });
  } catch { /* 資料夾還沒有 */ }
}
/* 縮圖、放大看（D129）：shot://local/<相對路徑（整段 encodeURIComponent）>?v=<修改時間>，只給截圖資料夾裡的截圖 */
async function serveShot(req) {
  let f;
  try { f = shotFile(decodeURIComponent(new URL(req.url).pathname.slice(1))); } catch { return new Response('', { status: 404 }); }
  try { return new Response(await fs.promises.readFile(f), { headers: { 'Content-Type': 'image/png' } }); } catch { return new Response('', { status: 404 }); }
}

ipcMain.handle('undo', () => undo());
ipcMain.handle('dir:change', async () => {
  if (argDataDir) return false;
  const dir = await pickDir(win);
  if (!dir) return false;
  writeAtomic(settingsFile(), JSON.stringify({ ...readSettings(), dataDir: dir }, null, 2));
  dataDir = dir;
  lostDir = null;
  watchData();
  return true;
});

function createWindow() {
  // 上次關掉時的大小、位置、最大化（見 開發筆記 D082）；有 --data-dir 時不讀寫設定檔（D016），每次都照預設
  const last = argDataDir ? {} : winState.restore(readSettings().window, screen.getAllDisplays().map(d => d.workArea));
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    ...last.bounds,
    title: `daybook ${app.getVersion()}`,   // 標題帶版本號（package.json 的 version，見 開發筆記 D039）
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),   // 趴著探頭的樹懶（見 開發筆記 D069）
    // 標題列自己畫（index.html 的 #titleBar），35px 跟 VS Code 一樣高；原生的比較細（見 開發筆記 D100）。
    // 這樣原生選單列就叫不出來了（原本藏起來、按 Alt 才出現，D034）
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(), height: TITLE_BAR_H },
    backgroundColor: windowBg(),   // 畫面的底色，不是預設的白（見 開發筆記 D115）
    ...(argQuietWindow ? { x: -20000, y: -20000, show: false, skipTaskbar: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('page-title-updated', e => e.preventDefault());   // 不讓網頁的 <title> 蓋掉帶版本號的標題
  // MD 檢視（D118）會顯示別人寫的連結：Ctrl／Shift／中鍵點、拖連結進視窗都不能開新視窗或把畫面換成那個網頁（會拿到 window.daybook）。
  // 畫面自己重新載入（換資料夾後的 location.reload）也會走 will-navigate，網址跟現在一樣的放行。
  // 文件檢視的 .html（D122）在 iframe 裡：只准載入畫面要的那一個（docAllowed），裡面點連結換頁、開新視窗都攔下來交給 docNav
  win.webContents.setWindowOpenHandler(({ url }) => { docNav(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.webContents.on('will-frame-navigate', e => {
    if (e.isMainFrame || e.url === docAllowed) return;
    e.preventDefault();
    docNav(e.url);
  });
  if (last.maximized && !argQuietWindow) win.maximize();   // 安靜跑不放大：放大會回到螢幕上（D052）
  if (!argDataDir) {
    // 關掉時記下來：最大化的也記沒放大時的大小位置，下次還原得回去。記不下來就算了，不能擋住關視窗
    win.on('close', () => {
      try {
        writeAtomic(settingsFile(), JSON.stringify({ ...readSettings(), window: { ...win.getNormalBounds(), maximized: win.isMaximized() } }, null, 2));
      } catch { /* 下次照上上次的開 */ }
    });
  }
  if (argQuietWindow) win.showInactive();   // 顯示在螢幕外、不搶焦點（見 開發筆記 D052）
  if (argIgnoreMouse) win.setIgnoreMouseEvents(true);   // 見 開發筆記 D080
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (argQuietWindow) return;   // 測試安靜跑：不叫到前面（見 開發筆記 D052）
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  dataDir = resolveDataDir();
  if (dataDir) watchData();
  watchMd();
  protocol.handle('docview', serveDoc);   // 文件檢視的 .html（D122）
  protocol.handle('shot', serveShot);     // 截圖頁的縮圖（D129）
  createWindow();
  // 可攜版當掉留下的解壓資料夾，視窗開好再清（見 開發筆記 D050）。只有打包後的才清：開發、測試不去動這台電腦的暫存區
  if (app.isPackaged) {
    setImmediate(() => require('./cleanup.js').cleanPortableLeftovers(app.getPath('temp'), path.dirname(process.execPath), require('original-fs')));
  }
});

app.on('window-all-closed', () => app.quit());
