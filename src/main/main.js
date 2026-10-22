/* ============================================================
   daybook 主程序：決定資料資料夾、開視窗、讀寫檔案、監看資料夾
   檔案操作只在這裡做；畫面透過 preload 的 window.daybook 呼叫（見 開發筆記 D002）
   ============================================================ */
'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { parseDay } = require('../shared/parser.js');
const { TODO_FILE, dayPath } = require('../shared/paths.js');

/* 資料資料夾（見 開發筆記 D016）：--data-dir ＞ 設定檔 ＞ 第一次啟動跳視窗選。
   有 --data-dir 時完全不讀寫設定檔，Chromium 的使用者資料也改放系統暫存區，
   測試才不會動到使用者真的設定（%APPDATA%\daybook） */
const argDataDir = (() => {
  const i = process.argv.indexOf('--data-dir');
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
})();
if (argDataDir) app.setPath('userData', path.join(app.getPath('temp'), 'daybook-dev-profile'));

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
  const r = await dialog.showOpenDialog(parent, {
    title: '選擇放工作紀錄的資料夾',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
}

async function resolveDataDir() {
  if (argDataDir) return argDataDir;
  const s = readSettings();
  if (s.dataDir && fs.existsSync(s.dataDir)) return s.dataDir;
  const dir = await pickDir();
  if (dir) writeAtomic(settingsFile(), JSON.stringify({ ...s, dataDir: dir }, null, 2));
  return dir;
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

/* 未結：日期條目裡標了 [待處理]／[待回覆] 的（見 開發筆記 D006、D019） */
function listOpen() {
  const out = [];
  for (const date of listDays()) {
    for (const e of parseDay(readText(path.join(dataDir, dayPath(date))))) {
      if (e.status && e.status !== '完成') out.push({ date, status: e.status, title: e.title.split('\n')[0] });
    }
  }
  return out;
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

ipcMain.handle('info', () => ({ dataDir, today: localToday(), canChangeDir: !argDataDir }));
ipcMain.handle('days:list', () => listDays());
ipcMain.handle('day:read', (_, date) => readText(path.join(dataDir, dayPath(date))));
ipcMain.handle('day:write', (_, date, text) => writeDay(date, text));
ipcMain.handle('todo:read', () => readText(path.join(dataDir, TODO_FILE)));
ipcMain.handle('todo:write', (_, text) => writeAtomic(path.join(dataDir, TODO_FILE), text));
ipcMain.handle('open:list', () => listOpen());
ipcMain.handle('dir:change', async () => {
  if (argDataDir) return false;
  const dir = await pickDir(win);
  if (!dir) return false;
  writeAtomic(settingsFile(), JSON.stringify({ ...readSettings(), dataDir: dir }, null, 2));
  dataDir = dir;
  watchData();
  return true;
});

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    title: 'daybook',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  dataDir = await resolveDataDir();
  if (!dataDir) { app.quit(); return; }
  watchData();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
