/* ============================================================
   daybook 主程序：決定資料資料夾、開視窗、讀寫檔案、監看資料夾
   檔案操作只在這裡做；畫面透過 preload 的 window.daybook 呼叫（見 開發筆記 D002）
   ============================================================ */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, utilityProcess, clipboard, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { TODO_FILE, FLAG_CATS_FILE, ISO_DATE_RE, dayPath } = require('../shared/paths.js');
const { checkCat } = require('../shared/parser.js');
const ent = require('../shared/entries.js');
const srch = require('../shared/search.js');
const { FORMATS, EXPORT_FORMATS, formatName, exportData } = require('../shared/formats/index.js');
const imp = require('../shared/import.js');
const exts = require('./extensions.js');
const aiExt = require('./ai-ext.js');
const skins = require('./skins.js');
const winState = require('./window-state.js');

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
/* 測試用：「外觀」頁「用圖檔做一個」的選圖不跳視窗，直接當作選了這張圖（見 開發筆記 D066） */
const argPickImage = argPath('--pick-image');
/* 測試用：兩種以上格式都認得時不跳視窗，直接當作選了名稱（label）是這個的格式；清單裡沒有就當作取消（見 開發筆記 D058） */
const argPickFormat = process.argv.includes('--pick-format') ? process.argv[process.argv.indexOf('--pick-format') + 1] || '' : null;
/* 測試用：匯入時資料夾裡已經有的日子，不跳視窗，直接當作按了「加進去」或「略過」；其他的字當作取消（見 開發筆記 D063） */
const argExisting = process.argv.includes('--existing') ? process.argv[process.argv.indexOf('--existing') + 1] || '' : null;
/* 測試用：匯出、AI 匯出格式試跑的「存一份看看」不跳存檔視窗，直接寫進這個資料夾（見 開發筆記 D035、D079） */
const argExportDir = argPath('--export-dir');
/* 測試用：說明頁的「開啟位置」不真的開檔案總管、「開 Gemini／ChatGPT」不真的開瀏覽器，把路徑、網址一行一行寫進這個檔（見 開發筆記 D051、D056） */
const argOpenLog = argPath('--open-log');
/* 測試用：「複製 prompt」不寫剪貼簿，寫進這個檔——測試不蓋掉使用者剪貼簿裡的東西（見 開發筆記 D056） */
const argClipFile = argPath('--clipboard-file');
/* 測試用：「外觀」頁刪外觀包、「格式」頁刪擴充不丟資源回收筒，搬進這個資料夾——測試不在使用者的資源回收筒留東西（見 開發筆記 D073、D081） */
const argTrashDir = argPath('--trash-dir');
/* 測試用：視窗放到螢幕外、不搶焦點、不上工作列，再開一次也不叫到前面——commit 前跑 e2e 不打擾正在用電腦的人（見 開發筆記 D052） */
const argQuietWindow = process.argv.includes('--quiet-window');
/* 測試用：視窗不收真的滑鼠（點得穿過去），只收測試從 CDP 送進來的——完整跑時使用者動到滑鼠不會蓋掉測試的滑鼠位置（見 開發筆記 D080） */
const argIgnoreMouse = process.argv.includes('--ignore-mouse');

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
const forkExtHost = () => utilityProcess.fork(path.join(__dirname, 'ext-host.js'), [], { serviceName: 'daybook 擴充' });

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

/* 先寫暫存檔再改名：寫到一半當掉，原檔也不會壞 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  parsed.delete(file);   // 自己寫的直接作廢，不靠修改時間（FAT32 隨身碟只準到 2 秒，見 開發筆記 D064）
}

async function pickDir(parent) {
  if (argPickDir) return argPickDir;
  const r = await dialog.showOpenDialog(parent, {
    title: '選擇放工作紀錄的資料夾',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
}

/* 選要匯入的檔：副檔名照登記的格式、加上已啟用的擴充（見 開發筆記 D047、D055） */
async function pickImportFile(parent) {
  if (argPickFile) return argPickFile;
  const all = [...FORMATS, ...exts.enabledFormats(scanExts())];
  const r = await dialog.showOpenDialog(parent, {
    title: '選擇要匯入的檔案（' + all.map(f => f.label).join('、') + '）',
    properties: ['openFile'],
    filters: [{ name: '能匯入的檔', extensions: [...new Set(all.flatMap(f => f.extensions))] }, { name: '全部檔案', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
}

/* 兩種以上格式都認得要匯入的檔：問使用者這次用哪一種（見 開發筆記 D058）。取消回 null */
async function pickFormatOf(candidates) {
  if (argPickFormat != null) return candidates.find(f => f.label === argPickFormat) || null;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: '要用哪一種格式匯入',
    message: '這個檔同時像好幾種格式，這次要用哪一種匯入？',
    detail: candidates.map(f => `${formatName(f)}：${f.hint}`).join('\n'),
    buttons: [...candidates.map(formatName), '取消'],
    cancelId: candidates.length,
    noLink: true,
  });
  return candidates[r.response] || null;
}

/* 要匯入的日子（或待處理）資料夾裡已經有了：一次問全部要加進去還是略過（見 開發筆記 D063）。回 '加進去'／'略過'，取消回 null */
async function askExisting(plan) {
  const choices = ['加進去', '略過'];
  if (argExisting != null) return choices.includes(argExisting) ? argExisting : null;
  const dates = plan.existing.map(d => d.date);
  const what = dates.length ? ` ${dates.length} 天` + (plan.todoExisting ? '和待處理' : '') : '待處理';
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: '資料夾裡已經有了',
    message: `資料夾裡已經有${what}的資料，要加進去還是略過？`,
    detail: (dates.length ? dates.slice(0, 10).join('、') + (dates.length > 10 ? ` …共 ${dates.length} 天` : '') + '\n\n' : '')
      + '加進去：一筆一筆比，已經有一模一樣的那筆就不再加，其他接在最後面。\n略過：這些不匯，其他照匯。',
    buttons: [...choices, '取消'],
    cancelId: choices.length,
    noLink: true,
  });
  return choices[r.response] || null;
}

/* AI 寫的擴充試跑選檔（見 開發筆記 D056）：副檔名照那個擴充的格式，它還沒裝，選匯入檔的清單裡沒有它 */
async function pickTryFile(formats) {
  if (argPickFile) return argPickFile;
  const r = await dialog.showOpenDialog(win, {
    title: '選一個要用這個格式匯入的檔來試跑（' + formats.map(f => f.label).join('、') + '）',
    properties: ['openFile'],
    filters: [{ name: formats.map(f => f.label).join('、'), extensions: [...new Set(formats.flatMap(f => f.extensions))] }, { name: '全部檔案', extensions: ['*'] }],
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

/* src：'YYYY-MM-DD'（每日檔）或 'todo'（待辦.md）；日期由 dayPath 驗格式 */
const fileOf = src => path.join(dataDir, src === 'todo' ? TODO_FILE : dayPath(src));
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
  if (!u) throw new Error('更新內容不能空白');
  if (src === 'todo') {
    writeSrc(src, ent.appendUpdate(srcText, index_, raw, `${today.slice(5, 7)}/${today.slice(8)} ${u}`));
    return { where: 'same' };
  }
  if (src === today) {
    writeSrc(src, ent.appendUpdate(srcText, index_, raw, u));
    return { where: 'same' };
  }
  const e = ent.listEntries(srcText)[index_];
  if (!e || e.raw !== raw) throw new ent.Conflict('這一筆在別的地方被改過了，畫面已重新整理，請再操作一次');
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
const PENDING_CAT = '未完';
const catsFile = () => path.join(dataDir, FLAG_CATS_FILE);
function readCats() {
  const t = readText(catsFile());
  if (!t.trim()) return [];
  let j;
  try { j = JSON.parse(t); } catch { throw new Error(`資料夾裡的 ${FLAG_CATS_FILE} 讀不懂（不是 JSON），用記事本打開修好再試`); }
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
  if (req.all) {
    pick = days;
    title = '工作紀錄（全部）' + (days.length ? ` ${days[0]} ～ ${days[days.length - 1]}` : '');
    name = `工作紀錄_全部_${localToday()}`;
  } else {
    const { from, to } = req;
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) throw new Error('起訖日期要填完整');
    if (from > to) throw new Error('起日不能晚於訖日');
    pick = days.filter(d => d >= from && d <= to);
    if (!pick.length) throw new Error(`${from} ～ ${to} 沒有紀錄`);
    title = `工作紀錄 ${from} ～ ${to}`;
    name = `工作紀錄_${from}_${to}`;
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

/* 存檔視窗（匯出、AI 匯出格式的「存一份看看」共用）：預設下載資料夾，同一次開著記住上次存的資料夾；取消回 null */
let lastExportDir = null;
async function pickSaveFile(name, fmt) {
  if (argExportDir) return path.join(argExportDir, name);
  const r = await dialog.showSaveDialog(win, {
    title: `匯出成${fmt.label}`,
    defaultPath: path.join(lastExportDir || app.getPath('downloads'), name),
    filters: [{ name: fmt.label, extensions: [fmt.extension] }],
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
  if (!fmt) throw new Error('沒有這個匯出格式（擴充停用或拿掉了？）：重新選一次');
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

/* 要匯入的檔一律當 UTF-8 讀；匯入和 AI 擴充的試跑共用（見 開發筆記 D056） */
function readImportText(file) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
  catch { throw new Error('這個檔不是 UTF-8 編碼：用記事本打開，「另存新檔」時編碼選 UTF-8，再匯入一次'); }
}

/* 匯入（見 開發筆記 D044、D047）：選檔 → 認格式、拆成每日檔＋待辦.md，寫進目前的資料夾。原檔只讀。
   已經有內容的日子、待辦.md：一次問要加進去還是略過，加進去是一筆一筆比、一模一樣的不再加（D063）；
   整批算一個動作，Ctrl+Z 一次復原。取消（選檔、選格式、加進去還是略過）回 null。
   有啟用的擴充：開一個獨立程序跑它們的 detect / parse，匯完就關（見 D055）；兩種以上格式都認得就問用哪一種（D058） */
async function importFile() {
  if (!dataDir) throw new Error('先選資料夾');
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
    if (e.unknownFormat && off) e.message += `（有 ${off} 個擴充還沒啟用：右上角「格式」）`;
    throw e;
  } finally {
    if (host) host.kill();
  }
  if (!plan) return null;
  const old = plan.existing.map(d => [d.date, d.text]).concat(plan.todoExisting ? [['todo', plan.todo]] : []);
  const how = old.length ? await askExisting(plan) : '略過';
  if (!how) return null;
  const writes = plan.write.map(d => [d.date, d.text]).concat(plan.todo && !plan.todoExisting ? [['todo', plan.todo]] : []);
  let merged = null;
  if (how === '加進去') {
    merged = { days: plan.existing.length, todo: plan.todoExisting, added: 0, dup: 0 };
    for (const [src, text] of old) {
      const m = imp.mergeEntries(readText(fileOf(src)), text, src === 'todo' ? '待處理' : src);
      merged.added += m.added;
      merged.dup += m.dup;
      if (m.added) writes.push([src, m.text]);
    }
  }
  withUndo('匯入', writes.map(w => w[0]), () => {
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

/* 外部改了檔（人用編輯器改、Claude 改）就通知畫面；連續的事件合併成一次 */
function watchData() {
  if (watcher) watcher.close();
  let timer = null;
  const changed = new Set();
  watcher = fs.watch(dataDir, { recursive: true }, (_, name) => {
    if (!name || !String(name).endsWith('.md')) return;
    changed.add(String(name).split(path.sep).join('/'));
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send('data:changed', [...changed]);
      changed.clear();
    }, 150);
  });
}

// dataDir 是 null：還沒選資料夾，畫面顯示「選擇資料夾」（見 開發筆記 D041）
ipcMain.handle('info', () => ({ dataDir, lostDir, today: localToday(), canChangeDir: !argDataDir }));

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
    userData: at(app.getPath('userData')),
    extensions: at(extDir()),   // 格式擴充（匯入、匯出）放這裡（見 開發筆記 D055、D078）
    skins: at(skinDir()),   // 外觀包放這裡（見 開發筆記 D062）
    portableExe: mode === 'portable' ? at(portableExe) : null,
    unpack: mode === 'portable' ? at(exeDir) : null,   // 不是可攜版就不知道名稱（打包時隨機產生）
    tempDir: app.getPath('temp'),
    // 安裝版：正在用就是程式所在的資料夾，不然寫預設的位置（electron-builder 的 multiUser.nsh）
    installed: at(mode === 'installed' ? exeDir : path.join(local, 'Programs', app.getName())),
    // 安裝版裝的時候，安裝程式把自己複製一份放這裡，解除安裝不會刪（electron-builder 的 installer.nsh／uninstaller.nsh）
    updater: at(path.join(local, `${app.getName()}-updater`)),
    // 解除安裝程式的暫存複本（NSIS 共用的名稱，見 開發筆記 D050〈後續〉）
    nsu: at(path.join(app.getPath('temp'), '~nsu.tmp', 'Un_A.exe')),
  };
}
ipcMain.handle('files:info', () => filesInfo());

/* 說明頁的「開啟位置」（見 開發筆記 D051）：畫面只給是哪一格，路徑在這裡重算（畫面不能指定任意路徑，同 D002）。
   資料夾就打開它；檔案（可攜版的 exe、Un_A.exe）就打開它所在的資料夾並選取它。
   可攜版解壓的資料夾不是正在用的話不知道名稱，打開暫存區。
   擴充資料夾（在「格式」頁，D056、D078）、外觀包資料夾（在「外觀」頁，D062）還沒有就先建：要裝的人才有地方放（見 D055） */
ipcMain.handle('files:open', async (_, key) => {
  if (key === 'extensions') fs.mkdirSync(extDir(), { recursive: true });
  if (key === 'skins') fs.mkdirSync(skinDir(), { recursive: true });
  const f = filesInfo();
  const p = { data: f.data, userData: f.userData, extensions: f.extensions, skins: f.skins, portableExe: f.portableExe, unpack: f.unpack || { path: f.tempDir, exists: fs.existsSync(f.tempDir) },
    installed: f.installed, updater: f.updater, nsu: f.nsu }[key];
  if (!p || !p.exists) throw new Error('這個位置目前沒有');
  if (argOpenLog) return fs.appendFileSync(argOpenLog, p.path + '\n');
  if (fs.statSync(p.path).isDirectory()) {
    const err = await shell.openPath(p.path);
    if (err) throw new Error('打不開：' + err);
  } else {
    shell.showItemInFolder(p.path);
  }
});
/* 「格式」頁（見 開發筆記 D055、D056、D078）：內建的匯入、匯出格式，擴充資料夾和裡面的每個擴充（每次重讀，不用重開） */
const extList = () => ({
  dir: extDir(),
  builtin: FORMATS.map(({ label, hint }) => ({ label, hint })),
  builtinExport: EXPORT_FORMATS.map(({ label, hint, extension }) => ({ label, hint, extension })),
  exts: scanExts().map(({ folder, name, displayName, version, formats, exportFormats, state, reason }) => ({ folder, name, displayName, version, formats, exportFormats, state, reason })),
});
ipcMain.handle('ext:list', () => extList());
/* 啟用／停用：只能啟用現在讀得到、未啟用的；記下名稱＋版本，改版要再啟用一次 */
ipcMain.handle('ext:enable', (_, name, on) => {
  const map = { ...extEnabled() };
  if (on) {
    const x = scanExts().find(e => e.name === name);
    if (!x || x.state !== 'disabled') throw new Error('這個擴充現在不能啟用，關掉「格式」再打開看看');
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
  if (!x) throw new Error('找不到這個擴充，關掉「格式」再打開看看');
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
    if (!x || x.state !== 'disabled') throw new Error('這個外觀包現在不能啟用，關掉外觀再打開看看');
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
    const r = await dialog.showOpenDialog(win, { title: '選一張圖', properties: ['openFile'], filters: [{ name: '圖檔', extensions: skins.EXTS }] });
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
  if (!x) throw new Error('找不到這個外觀包，關掉外觀再打開看看');
  const dir = path.join(skinDir(), x.folder);
  if (argTrashDir) fs.renameSync(dir, path.join(argTrashDir, x.folder));
  else await shell.trashItem(dir);
  if (skinEnabled() === x.name && !scanSkins().some(s => s.name === x.name)) setSkinEnabled(null);
  return skinList();
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
  if (!url) throw new Error('不認得的網站');
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
    if (!dataDir) throw new Error('先選資料夾：試跑要拿你的紀錄來匯出');
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
  if (!aiPending || aiPending.token !== token || !aiPending.outputs || aiPending.outputs[i] == null) throw new Error('要先按「檢查並試跑…」，通過了才能存');
  const fmt = aiPending.formats[i], out = aiPending.outputs[i];
  const file = await pickSaveFile(`工作紀錄_試跑.${fmt.extension}`, fmt);
  if (!file) return null;
  fs.writeFileSync(file, out);
  return file;
});
/* 裝進擴充資料夾、啟用（使用者選的：裝好就啟用、不匯入）。同名的裝回原本那個資料夾，只換 package.json 和 index.js */
ipcMain.handle('ai:install', (_, token) => {
  if (!aiPending || aiPending.token !== token) throw new Error('要先按「檢查並試跑…」，通過了才能安裝');
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
ipcMain.handle('export:formats', () => exportFormatList().map(({ key, label, hint, extension, ext }) => ({ key, label, hint, extension, ext: ext || null })));
ipcMain.handle('export', (_, req) => exportFile(req));
ipcMain.handle('import:file', () => importFile());
/* 亮／暗（見 開發筆記 D034）：畫面切了就跟著切，視窗標題列才會一起變；'system' 是跟 Windows 設定 */
ipcMain.handle('theme:set', (_, t) => { nativeTheme.themeSource = ['dark', 'light'].includes(t) ? t : 'system'; });
/* 復原（見 開發筆記 D028）：卡片的每個寫檔動作，記下動到的檔「改之前／改之後」的內容；
   Ctrl+Z 時那幾個檔都還是「改之後」的樣子才還原——之後又被改過（外部編輯、文字模式）就不動，免得蓋掉 */
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
  if (op.files.some((f, i) => readOrNull(f) !== op.after[i])) throw new Error(`「${op.label}」之後檔案又被改過，不能復原`);
  op.files.forEach((f, i) => (op.before[i] == null ? fs.rmSync(f, { force: true }) : writeAtomic(f, op.before[i])));
  return op.label;
}

ipcMain.handle('cards:list', (_, src) => ent.listEntries(readText(fileOf(src))));
ipcMain.handle('card:add', (_, src, card) => withUndo('新增', [src], () => writeSrc(src, ent.addEntry(readText(fileOf(src)), card))));
ipcMain.handle('card:edit', (_, src, i, raw, card) => withUndo('編輯', [src], () => writeSrc(src, ent.editEntry(readText(fileOf(src)), i, raw, card))));
ipcMain.handle('card:delete', (_, src, i, raw) => withUndo('刪除', [src], () => writeSrc(src, ent.deleteEntry(readText(fileOf(src)), i, raw))));
ipcMain.handle('card:status', (_, src, i, raw, status) => withUndo('待回覆', [src], () => writeSrc(src, ent.setStatus(readText(fileOf(src)), i, raw, status))));
// + 更新可能動到原本那筆和今天的檔（見 D022、D024）
ipcMain.handle('card:update', (_, src, i, raw, text) => withUndo('更新', [src, localToday()], () => addUpdate(src, i, raw, text)));
ipcMain.handle('card:done', (_, i, raw, date, unfinished) => withUndo(unfinished ? '已處理+未完標籤' : '處理完', ['todo', date], () => markDone(i, raw, date, unfinished)));
// 隱藏只給待處理用（見 開發筆記 D026）
ipcMain.handle('card:hidden', (_, i, raw, hidden) => withUndo(hidden ? '隱藏' : '取消隱藏', ['todo'],
  () => writeSrc('todo', ent.setHidden(readText(fileOf('todo')), i, raw, hidden))));
// 標記給已處理用：還要注意、還沒完（見 開發筆記 D072）；左邊「標記」列出全部。cat 是分類，沒給是未分類（D076）
ipcMain.handle('card:flag', (_, src, i, raw, flagged, cat) => withUndo(flagged ? '標記' : '取消標記', [src],
  () => writeSrc(src, ent.setFlagged(readText(fileOf(src)), i, raw, flagged, cat))));
ipcMain.handle('flagged', () => srch.flaggedItems(index()));
ipcMain.handle('range', (_, from, to) => srch.rangeItems(index(), from, to));
// 分類清單、加新分類（見 開發筆記 D076）；加分類不算卡片動作，Ctrl+Z 不復原
ipcMain.handle('flag:cats', () => flagCats());
ipcMain.handle('flag:addCat', (_, name) => addCat(name));
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
    autoHideMenuBar: true,   // 原生選單列不會跟著變暗：平常藏起來，按 Alt 才出現（見 開發筆記 D034）
    ...(argQuietWindow ? { x: -20000, y: -20000, show: false, skipTaskbar: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('page-title-updated', e => e.preventDefault());   // 不讓網頁的 <title> 蓋掉帶版本號的標題
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
  createWindow();
  // 可攜版當掉留下的解壓資料夾，視窗開好再清（見 開發筆記 D050）。只有打包後的才清：開發、測試不去動這台電腦的暫存區
  if (app.isPackaged) {
    setImmediate(() => require('./cleanup.js').cleanPortableLeftovers(app.getPath('temp'), path.dirname(process.execPath), require('original-fs')));
  }
});

app.on('window-all-closed', () => app.quit());
