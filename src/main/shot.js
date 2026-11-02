/* ============================================================
   截圖的框選（見 開發筆記 D129）：每個螢幕蓋一層無邊框、在最上層的視窗（renderer/capture.html），
   底下是按下去那一刻抓的畫面（停住）；使用者拉框、畫框和箭頭，按完成把框裡那塊組成 png 傳回來。
   一次只有一輪；Esc、取消、其中一層被關掉都算取消。存檔、複製在 main.js
   ============================================================ */
'use strict';
const path = require('path');
const { BrowserWindow, desktopCapturer, screen, nativeImage, ipcMain } = require('electron');
const { L } = require('../shared/i18n.js');

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

module.exports = { grabScreens, fakeFrames, capture };
