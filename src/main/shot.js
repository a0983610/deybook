/* ============================================================
   截圖的框選（見 開發筆記 D129）：每個螢幕蓋一層無邊框、在最上層的視窗（renderer/capture.html），
   底下是按下去那一刻抓的畫面（停住）；使用者拉框、畫框和箭頭，按完成把框裡那塊組成 png 傳回來。
   一次只有一輪；Esc、取消、其中一層被關掉都算取消。
   存檔、複製、截圖頁的清單和動作、shot:// 網址在下面的 setupIpc（D190 從 main.js 搬來）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, desktopCapturer, screen, nativeImage, ipcMain, dialog, ClipboardItem } = require('electron');
const { L } = require('../shared/i18n.js');
const shots = require('../shared/shots.js');
const notes = require('../shared/notes.js');

const PAGE = path.join(__dirname, '..', 'renderer', 'capture.html');
const PRELOAD = path.join(__dirname, '..', 'shot-preload.js');

/* 一個螢幕的畫面：bounds 是螢幕在桌面上的位置（DIP），width、height 是實際像素，data 是 BGRA 的像素（toBitmap） */
function frameOf(img, bounds) {
  const { width, height } = img.getSize();
  const data = img.toBitmap();
  if (data.length !== width * height * 4) throw new Error(L('螢幕的畫面讀不懂（像素數對不上）'));
  return { bounds, width, height, data };
}

/* 抓每個螢幕。desktopCapturer 的縮圖會縮放到 thumbnailSize 裡面：同樣大小的螢幕一起抓、給它們實際的像素大小，才不會被放大縮小。
   抓到的跟螢幕用 display_id 對（2026-11-02 在使用者的兩個 1920×1080 量過對得上） */
async function grabScreens() {
  const groups = new Map();
  for (const d of screen.getAllDisplays()) {
    const size = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
    const k = `${size.width}x${size.height}`;
    if (!groups.has(k)) groups.set(k, { size, list: [] });
    groups.get(k).list.push(d);
  }
  const frames = [];
  for (const { size, list } of groups.values()) {
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    for (const d of list) {
      const s = srcs.find(x => x.display_id === String(d.id));
      if (s && !s.thumbnail.isEmpty()) frames.push(frameOf(s.thumbnail, d.bounds));
    }
  }
  if (!frames.length) throw new Error(L('抓不到螢幕的畫面'));
  return frames;
}

/* 測試用（--shot-image）：不抓螢幕，拿這張圖當唯一的螢幕 */
function fakeFrames(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(L('讀不到測試用的圖：{file}', { file }));
  const { width, height } = img.getSize();
  return [frameOf(img, { x: 0, y: 0, width, height })];
}

let cur = null;   // 正在截的這一輪：{ wins: Map(webContents.id → { win, frame, show }), resolve }

/* 蓋上去、等使用者截完：回傳組好的 png（Buffer），取消回 null。
   quiet：測試安靜跑，蓋的那層也放到螢幕外、不搶焦點（D052）；ignoreMouse：完整跑時不收真的滑鼠（D080）。
   主視窗調過的縮放（Ctrl+=，D042）不會套到這層（e2e E90 量過：主視窗 125% 時這層照 100%） */
function capture(frames, { quiet, ignoreMouse }) {
  return new Promise(resolve => {
    cur = { wins: new Map(), resolve };
    const cursor = screen.getCursorScreenPoint();
    for (const f of frames) {
      const b = f.bounds;
      const w = new BrowserWindow({
        x: quiet ? -20000 : b.x, y: quiet ? -20000 : b.y, width: b.width, height: b.height,
        frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, enableLargerThanScreen: true, backgroundColor: '#000000',
        webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      const id = w.webContents.id;
      // 畫面畫好了（shot:ready）才顯示，不會先閃一下黑的；滑鼠在的那個螢幕拿焦點，Esc、Enter 才按得到
      const show = () => {
        if (quiet) return w.showInactive();
        w.show();
        if (cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) w.focus();
      };
      cur.wins.set(id, { win: w, frame: f, show });
      w.setAlwaysOnTop(true, 'screen-saver');   // 蓋過工作列
      if (!quiet) w.setBounds(b);   // 開好再設一次：螢幕的縮放比例不一樣時，Windows 可能照 DPI 調過大小（未驗證，使用者兩個螢幕都是 100%）
      if (ignoreMouse) w.setIgnoreMouseEvents(true);
      w.on('closed', () => { if (cur && cur.wins.has(id)) finish(null); });   // 被 Alt+F4 關掉：當作取消
      w.loadFile(PAGE);
    }
  });
}

function finish(png) {
  if (!cur) return;
  const c = cur;
  cur = null;
  for (const { win } of c.wins.values()) if (!win.isDestroyed()) win.destroy();
  c.resolve(png);
}

const mine = e => cur && cur.wins.get(e.sender.id);
// 這一層的畫面：主程序 → 蓋的那層（像素很多，只給要的那一層）
ipcMain.handle('shot:frame', e => { const x = mine(e); return x ? { width: x.frame.width, height: x.frame.height, data: x.frame.data } : null; });
ipcMain.on('shot:ready', e => { const x = mine(e); if (x && !x.win.isDestroyed()) x.show(); });
// 在某一層開始拉框：其他螢幕的框拿掉（一次只框一塊）
ipcMain.on('shot:claim', e => {
  if (!mine(e)) return;
  for (const [id, { win }] of cur.wins) if (id !== e.sender.id && !win.isDestroyed()) win.webContents.send('shot:reset');
});
ipcMain.on('shot:done', (e, png) => { if (mine(e) && png && png.length) finish(Buffer.from(png)); });
ipcMain.on('shot:cancel', e => { if (mine(e)) finish(null); });

/* ---------- 截圖頁的 ipcMain handler（見 開發筆記 D129；D190 從 main.js 搬來）：取代 Windows 剪取工具 ----------
   main.js 啟動時叫一次。給的是 main.js 的：win（主視窗，叫的時候才拿）、settings（記用過的最大號、資料夾）、shotDir／shotNo（設定檔記的）、localToday、sys，
   測試參數 argShotImage（不抓螢幕，D129）、argQuietWindow（D052）、argIgnoreMouse（D080）、argPrintPdf（D142）、argPickShotDir（D129）。回 { serveShot }（shot:// 網址）。
   截好的存成截圖資料夾最上層的 <編號>.png、複製到剪貼簿；要留下來的取名搬進 保留\。畫面傳來的一律是相對路徑，
   只認編號的截圖、保留\ 裡的 .png（shots.checkRel），不能拿來動別的檔。刪除、清掉都丟資源回收筒，不走 withUndo */
function setupIpc({ win, settings, shotDir, shotNo, localToday, sys, argShotImage, argQuietWindow, argIgnoreMouse, argPrintPdf, argPickShotDir }) {
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
     測試帶 --clipboard-file 時一樣先組好 ClipboardItem，再從裡面拿出來：png 寫進那個檔、檔案的網址寫進 <那個檔>.uri，不碰使用者的剪貼簿（同 D093；sys.copyItem，D176） */
  async function copyShot(file, png = fs.readFileSync(file)) {
    await sys.copyItem(new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }), 'text/uri-list': pathToFileURL(file).href }));
  }
  /* 框選好幾張一起複製（D143）：剪貼簿一次只放得下一張圖，只放檔案（text/uri-list 一行一個）——Windows 那邊是 FileDrop 好幾個，跟檔案總管選好幾個 Ctrl+C 一樣。
     2026-11-03 試過：兩個檔（檔名有中文、空白）GetFileDropList 一字不差、ContainsImage 是 False。
     測試帶 --clipboard-file 時：那個檔寫成空的（剪貼簿裡沒有圖）、網址寫進 <那個檔>.uri */
  async function copyShotFiles(files) {
    await sys.copyItem(new ClipboardItem({ 'text/uri-list': files.map(f => pathToFileURL(f).href).join('\r\n') }));
  }
  /* 存成下一號（資料夾裡最大的號、設定檔記的用過的最大號，比較大的 +1）、記下這一號、複製。'wx'：不蓋掉已經有的檔 */
  async function saveShot(png) {
    const dir = shotDir();
    fs.mkdirSync(dir, { recursive: true });
    const no = shots.nextNo(fs.readdirSync(dir), shotNo());
    fs.writeFileSync(path.join(dir, no + '.png'), png, { flag: 'wx' });
    settings.set('shotNo', no);
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
    if (shooting || !win() || win().isDestroyed()) return null;
    shooting = true;
    let png = null;
    try {
      win().setOpacity(0);
      await new Promise(r => setTimeout(r, SHOT_HIDE_MS));
      const frames = argShotImage ? fakeFrames(argShotImage) : await grabScreens();
      png = await capture(frames, { quiet: argQuietWindow, ignoreMouse: argIgnoreMouse });
    } finally {
      shooting = false;
      if (!win().isDestroyed()) {
        win().setOpacity(1);
        if (!argQuietWindow) win().focus();   // 安靜跑不搶焦點（D052）
      }
    }
    return png ? await saveShot(png) : null;
  });
  ipcMain.handle('shots:list', () => listShots());
  ipcMain.handle('shot:copy', (_, rel) => (Array.isArray(rel) ? copyShotFiles(rel.map(shotFile)) : copyShot(shotFile(rel))));   // 一張：圖＋檔案；好幾張（陣列）：只放檔案（D143）
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
  /* 列印（D142）：背景開一個看不到的視窗，只放這張圖（縮到一頁裡、不放大），跳系統的列印對話框（選印表機、份數）；印完、取消都關掉。
     圖用 shot:// 網址讀（同一個 session，D129），網址帶修改時間，換過的圖不拿舊的。取消不算錯；印不出來（印表機設定不對之類）才丟錯給畫面提示 */
  ipcMain.handle('shot:print', async (_, rel) => {
    const f = shotFile(rel);
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const src = `shot://local/${encodeURIComponent(rel)}?v=${fs.statSync(f).mtimeMs}`;
    const html = '<!doctype html><meta charset="utf-8"><title>' + esc(path.parse(f).name) + '</title>'
      + '<style>@page { margin: 10mm; } html, body { height: 100%; margin: 0; } img { display: block; max-width: 100%; max-height: 100%; margin: 0 auto; }</style>'
      + '<img src="' + esc(src) + '">';
    const pw = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try {
      await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));   // 等到 load（圖讀好了）
      if (argPrintPdf) { fs.writeFileSync(argPrintPdf, await pw.webContents.printToPDF({})); return; }
      const [ok, why] = await new Promise(r => pw.webContents.print({}, (...a) => r(a)));
      if (!ok && !/cancel/i.test(why || '')) throw new Error(L('印不出來：{why}', { why }));
    } finally {
      pw.destroy();
    }
  });
  /* 清掉 N 天前的：編號的截圖裡，那一天（修改時間）在 today−N（含）以前的丟資源回收筒，保留的不動。
     dry：只算不丟（畫面先問「N 張丟到資源回收筒？」用），回 { cut, n } */
  ipcMain.handle('shot:clean', async (_, days, dry) => {
    const cut = shots.cutoffDay(localToday(), days);
    const old = scanShots().items.filter(i => i.day <= cut);
    if (!dry) for (const i of old) await sys.trash(path.join(shotDir(), i.rel));
    return { cut, n: old.length };
  });
  /* 變更資料夾：原本那個不動；編號照設定檔記的用過的最大號接下去（新資料夾裡有更大的就從它接）。取消回 null */
  ipcMain.handle('shot:pickDir', async () => {
    let dir = argPickShotDir;
    if (!dir) {
      const r = await dialog.showOpenDialog(win(), { title: L('選放截圖的資料夾'), defaultPath: shotDir(), properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return null;
      dir = r.filePaths[0];
    }
    settings.set('shotDir', dir);
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
          if (!win() || win().isDestroyed() || shotSigOf(scanShots()) === shotSig) return;   // 只是讀了檔（存取時間變了）：清單沒變，不重畫
          win().webContents.send('shot:changed');
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
  return { serveShot };
}

module.exports = { grabScreens, fakeFrames, capture, setupIpc };
