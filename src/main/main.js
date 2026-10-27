/* ============================================================
   daybook 主程序：決定資料資料夾、開視窗、讀寫檔案、監看資料夾
   檔案操作只在這裡做；畫面透過 preload 的 window.daybook 呼叫（見 開發筆記 D002）
   ============================================================ */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { TODO_FILE, ISO_DATE_RE, dayPath } = require('../shared/paths.js');
const ent = require('../shared/entries.js');
const srch = require('../shared/search.js');
const { toMarkdown } = require('../shared/formats/daybook-md.js');
const { FORMATS } = require('../shared/formats/index.js');
const imp = require('../shared/import.js');

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
/* 測試用：匯出不跳存檔視窗，直接寫進這個資料夾（見 開發筆記 D035） */
const argExportDir = argPath('--export-dir');
/* 測試用：說明頁的「開啟位置」不真的開檔案總管，把路徑一行一行寫進這個檔（見 開發筆記 D051） */
const argOpenLog = argPath('--open-log');
/* 測試用：視窗放到螢幕外、不搶焦點、不上工作列，再開一次也不叫到前面——commit 前跑 e2e 不打擾正在用電腦的人（見 開發筆記 D052） */
const argQuietWindow = process.argv.includes('--quiet-window');

/* 只能開一個視窗（見 開發筆記 D030）：再開一次就把已開的那個叫到前面，自己結束。
   鎖跟著上面的 userData 走：正式用鎖 %APPDATA%\daybook；--data-dir 各鎖各的暫存資料夾，試用版和 e2e 互不擋 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

/* 先寫暫存檔再改名：寫到一半當掉，原檔也不會壞 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

async function pickDir(parent) {
  if (argPickDir) return argPickDir;
  const r = await dialog.showOpenDialog(parent, {
    title: '選擇放工作紀錄的資料夾',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
}

/* 選要匯入的檔：副檔名照登記的格式（見 開發筆記 D047） */
async function pickImportFile(parent) {
  if (argPickFile) return argPickFile;
  const r = await dialog.showOpenDialog(parent, {
    title: '選擇要匯入的檔案（' + FORMATS.map(f => f.label).join('、') + '）',
    properties: ['openFile'],
    filters: [{ name: '能匯入的檔', extensions: [...new Set(FORMATS.flatMap(f => f.extensions))] }, { name: '全部檔案', extensions: ['*'] }],
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

/* 搜尋、時間軸每次都重新讀全部檔（見 開發筆記 D023） */
function index() {
  const sources = listDays().map(d => ({ src: d, text: readText(fileOf(d)) }));
  sources.push({ src: 'todo', text: readText(fileOf('todo')) });
  return srch.buildIndex(sources);
}

/* + 更新
   - 待處理（見 開發筆記 D024）：接在那一筆底下，帶今天日期 ->MM/DD …
   - 今天的已處理：接在同一筆底下（見 D022）
   - 過去的已處理：原本那筆沒有事件編號就先編一個，再在今天記一筆同編號的（見 D022） */
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
  if (id == null) {
    id = srch.maxEvent(index()) + 1;
    writeSrc(src, ent.setEvent(srcText, index_, raw, id));
  }
  // 已處理不帶狀態（狀態只在待處理用，見 開發筆記 D024）
  const card = { title: e.title.split('\n').join(' '), body: '->' + u, status: null, event: id };
  writeSrc(today, ent.addEntry(readText(fileOf(today)), card));
  return { where: 'today', event: id };
}

/* 處理完（見 開發筆記 D024）：待處理那一筆整段（含進展）搬進那一天的已處理，狀態拿掉。
   先寫那一天、再從待辦.md 拿掉——中途出錯頂多兩邊都有，不會兩邊都沒有 */
function markDone(index_, raw, date) {
  const dayFile = path.join(dataDir, dayPath(date));   // 只能搬進某一天（dayPath 驗日期格式）
  const { rest, taken } = ent.takeEntry(readText(fileOf('todo')), index_, raw);
  writeAtomic(dayFile, ent.appendLines(readText(dayFile), taken));
  writeSrc('todo', rest);
}

/* 匯出成一份 Markdown（見 開發筆記 D035）：日期區間（from～to，含頭尾）或全部（最後接待處理）。
   跳存檔視窗讓使用者選位置；取消回 null */
let lastExportDir = null;
async function exportMd(req) {
  const days = listDays().reverse();   // 舊的在前
  let pick, title, name;
  if (req.all) {
    pick = days;
    title = '工作紀錄（全部）' + (days.length ? ` ${days[0]} ～ ${days[days.length - 1]}` : '');
    name = `工作紀錄_全部_${localToday()}.md`;
  } else {
    const { from, to } = req;
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) throw new Error('起訖日期要填完整');
    if (from > to) throw new Error('起日不能晚於訖日');
    pick = days.filter(d => d >= from && d <= to);
    if (!pick.length) throw new Error(`${from} ～ ${to} 沒有紀錄`);
    title = `工作紀錄 ${from} ～ ${to}`;
    name = `工作紀錄_${from}_${to}.md`;
  }
  const md = toMarkdown({
    title,
    days: pick.map(d => ({ date: d, text: readText(fileOf(d)) })),
    todo: req.all ? readText(fileOf('todo')) : null,
  });
  let file;
  if (argExportDir) {
    file = path.join(argExportDir, name);
  } else {
    const r = await dialog.showSaveDialog(win, {
      title: '匯出成 Markdown',
      defaultPath: path.join(lastExportDir || app.getPath('downloads'), name),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
    lastExportDir = path.dirname(file);
  }
  fs.writeFileSync(file, md, 'utf8');
  return file;
}

/* 匯入（見 開發筆記 D044、D047）：選檔 → 認格式、拆成每日檔＋待辦.md，寫進目前的資料夾。原檔只讀。
   已經有內容的日子跳過、待辦.md 已經有內容也不蓋；整批算一個動作，Ctrl+Z 一次復原。取消回 null */
async function importFile() {
  if (!dataDir) throw new Error('先選資料夾');
  const file = await pickImportFile(win);
  if (!file) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
  catch { throw new Error('這個檔不是 UTF-8 編碼：用記事本打開，「另存新檔」時編碼選 UTF-8，再匯入一次'); }
  const has = rel => readText(path.join(dataDir, rel)).trim() !== '';
  const plan = imp.planImport(text, has);
  const srcs = plan.write.map(d => d.date).concat(plan.todo ? ['todo'] : []);
  withUndo('匯入', srcs, () => {
    for (const d of plan.write) writeSrc(d.date, d.text);
    if (plan.todo) writeSrc('todo', plan.todo);
  });
  return {
    format: plan.format,
    written: plan.write.length,
    skipped: plan.skipped.map(d => d.date),
    todoLines: plan.todo ? plan.todo.replace(/\n$/, '').split('\n').length : 0,
    todoSkipped: plan.todoSkipped,
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
   可攜版解壓的資料夾不是正在用的話不知道名稱，打開暫存區 */
ipcMain.handle('files:open', async (_, key) => {
  const f = filesInfo();
  const p = { data: f.data, userData: f.userData, portableExe: f.portableExe, unpack: f.unpack || { path: f.tempDir, exists: fs.existsSync(f.tempDir) },
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
ipcMain.handle('days:list', () => listDays());
ipcMain.handle('day:read', (_, date) => readText(path.join(dataDir, dayPath(date))));
ipcMain.handle('day:write', (_, date, text) => writeDay(date, text));
ipcMain.handle('todo:read', () => readText(path.join(dataDir, TODO_FILE)));
ipcMain.handle('todo:write', (_, text) => writeAtomic(path.join(dataDir, TODO_FILE), text));
ipcMain.handle('search', (_, q) => srch.search(index(), q));
ipcMain.handle('timeline', (_, by) => (by.event != null ? srch.timelineByEvent(index(), by.event) : srch.timelineByCode(index(), by.code)));
// 自動補完的候選（見 開發筆記 D031、D032）：畫面在檔案變了之後、下次打字時才來拿
ipcMain.handle('suggest', () => srch.suggestions(index()));
ipcMain.handle('export', (_, req) => exportMd(req));
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
ipcMain.handle('card:done', (_, i, raw, date) => withUndo('處理完', ['todo', date], () => markDone(i, raw, date)));
// 隱藏只給待處理用（見 開發筆記 D026）
ipcMain.handle('card:hidden', (_, i, raw, hidden) => withUndo(hidden ? '隱藏' : '取消隱藏', ['todo'],
  () => writeSrc('todo', ent.setHidden(readText(fileOf('todo')), i, raw, hidden))));
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
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    title: `daybook ${app.getVersion()}`,   // 標題帶版本號（package.json 的 version，見 開發筆記 D039）
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),   // 呆呆樹懶（見 開發筆記 D038）
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
  if (argQuietWindow) win.showInactive();   // 顯示在螢幕外、不搶焦點（見 開發筆記 D052）
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
