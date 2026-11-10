/* 文件檢視（原本叫 MD 檢視，見 開發筆記 D118、D122）：唯讀看釘住的資料夾裡的 .md、.html（AI 產出的報告、筆記、規格）。
   - listDocs：資料夾底下全部的 .md、.html、.htm（一層一層進去），相對路徑（/ 隔開）、不排序（畫面照名稱，或修改時間、建立日期排，D132）。
     node_modules、.git 不進去（套件、版本紀錄裡的不是要看的）；用非同步讀，釘到很大的資料夾也不會卡住整個程式
   - render：md 轉成畫面的 HTML，用 marked（D119），GFM：表格、核取清單、刪除線。
     檔案裡的 HTML 照原字顯示、不當 HTML，只有 <br> 換行（AI 常在表格裡用）、<!-- 註解 --> 不顯示；圖片不顯示，換成「〔圖：說明〕」。
     標題帶錨點 data-anchor（D159，照 GitHub 的算法，slugOf）：[x](#段落)、[x](別份.md#段落) 跳得過去，大綱也用它
   - .html 不轉：畫面用沙盒的 iframe 直接開，網址是 docview://local/<路徑>（D122），主程序照這個網址讀檔給它（docFile、mimeOf） */
'use strict';
const fs = require('fs');
const path = require('path');
const url = require('url');
const { Marked, TextRenderer } = require('marked');
const { L } = require('../shared/i18n.js');

const SKIP = new Set(['node_modules', '.git']);
const isMd = name => /\.md$/i.test(name);
const isHtml = name => /\.html?$/i.test(name);
const isDoc = name => isMd(name) || isHtml(name);
// 路徑（\ 或 / 隔開）裡有沒有 node_modules、.git 那一層
const skipped = rel => String(rel).split(/[\\/]/).some(s => SKIP.has(s.toLowerCase()));

async function listDocs(root) {
  const files = [];
  const walk = async rel => {
    let ents;
    try { ents = await fs.promises.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true }); } catch { return; }   // 讀不到的資料夾（沒權限）跳過
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name.toLowerCase())) await walk(r); }   // 捷徑（symlink、junction）不是 isDirectory，不會繞圈
      else if (e.isFile() && isDoc(e.name)) files.push(r);
    }
  };
  await walk('');
  return files;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const unesc = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, x) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[x]);
/* 標題的錨點（D159）：照 GitHub（github-slugger）——字轉小寫，拿掉標點、符號（留字母、數字、_、-、空白），每個空白換成 -；
   同一份裡重複的後面接 -1、-2。字是標題畫出來看得到的（**粗**、`code`、[連結] 只留字；檔案裡的 HTML 標籤拿掉，跟 GitHub 畫成 HTML 後的字一樣）。
   放 data-anchor 不放 id：標題叫 help、q 這種會跟畫面自己的 id 撞（getElementById 拿到標題）。slugs 是這一份用過的，render 開頭清掉 */
const slugs = new Map();
function slugOf(text) {
  const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
  let s = base;
  while (slugs.has(s)) { slugs.set(base, slugs.get(base) + 1); s = base + '-' + slugs.get(base); }
  slugs.set(s, 0);
  return s;
}
const plain = new TextRenderer();
const md = new Marked({
  gfm: true,
  renderer: {
    html({ text, block }) {
      if (/^\s*<!--[\s\S]*-->\s*$/.test(text)) return '';
      if (!block && /^<br\s*\/?>$/i.test(text)) return '<br>';
      return block ? `<p class="mdRaw">${esc(text.replace(/\n+$/, ''))}</p>` : esc(text);
    },
    image({ text, href }) { return `<span class="mdImg">${esc(L('〔圖：{alt}〕', { alt: text || href }))}</span>`; },
    heading({ tokens, depth }) {
      const text = unesc(this.parser.parseInline(tokens, plain).replace(/<[^>]*>/g, ''));
      return `<h${depth} data-anchor="${esc(slugOf(text))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});
const render = text => { slugs.clear(); return md.parse(String(text)); };

/* .html 的網址（D122）：docview://local/C:/路徑/檔名.html（照 file: 網址的編碼），version 接在 ?v= 後面——檔案改了網址就變，iframe 才會重新載入。
   檔案裡的相對路徑（圖、css）照這個網址接，一樣是 docview://local/…，主程序照 docFile 換回路徑 */
const DOC_PREFIX = 'docview://local/';
const docUrl = (file, version) => url.pathToFileURL(file).href.replace(/^file:\/\/\//, DOC_PREFIX) + (version ? '?v=' + encodeURIComponent(version) : '');
// docview 網址 → 路徑；不是 docview://local/ 的、編碼壞掉的回 null（? # 後面不算）
function docFile(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'docview:' || x.host !== 'local') return null;
    return url.fileURLToPath('file://' + x.pathname);
  } catch { return null; }
}
// 給 iframe 的檔案類型：文件檢視會用到的（網頁、圖、字型、css、程式 D148）；其他的照二進位給
const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.emz': 'application/octet-stream',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
};
const mimeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
/* .html 的 CSP（D122 不連網；程式 D148 改成會跑）：只認自己（docview:）和 data: 的樣式、圖、字型、影音，網頁裡寫的、旁邊的 .js 會跑；
   其他都是 default-src 'none'：不連到外面（fetch、XHR、外面的程式、字型都擋）、不能再開 iframe */
const DOC_CSP = "default-src 'none'; script-src 'unsafe-inline' docview:; style-src 'unsafe-inline' docview:; img-src docview: data:; font-src docview: data:; media-src docview: data:";

/* ---------- 文件檢視的 ipcMain handler、.html 的監聽和找字、docview: 網址、監看釘住的資料夾（D190 從 main.js 搬來）----------
   main.js 啟動時叫一次。給的是 main.js 的：win（主視窗，叫的時候才拿）、mdRoots／setMdRoots（設定檔記的釘住的資料夾）、pickMdDir（選資料夾的視窗）、
   timesOf（每份的修改、建立時間，D132）、openOut（網址用瀏覽器開，常用也用）、sys。Electron 在這裡才 require：parser 測試直接 require 這支，不帶 Electron。
   回 main.js 要用的：docAllowed()（畫面最後讀的那份 .html 的網址）、docNavByUser、DOC_HOOKS（開視窗時掛）、serveDoc（docview: 網址）、watchMd、docClear */
function setupIpc({ win, mdRoots, setMdRoots, pickMdDir, timesOf, openOut, sys }) {
  const { ipcMain, session } = require('electron');
  const notes = require('../shared/notes.js');
  const { LK } = require('../shared/i18n.js');
  /* 文件檢視（原本叫 MD 檢視，見 開發筆記 D118；也看 .html，D122）：唯讀，不寫任何檔。清單是每個釘住的資料夾 { dir, files（相對路徑）, times（每份的修改、建立時間，D132）, missing（資料夾不在了） }。
     畫面傳來的檔要是釘住的資料夾底下的 .md、.html 才讀（不能拿來讀別的檔）；.md 轉成 HTML 再給畫面，.html 給 docview 網址 */
  const mdUnder = file => {   // 在某個釘住的資料夾底下（不含資料夾本身）：回完整路徑，不是回 null
    const f = path.resolve(String(file));
    const under = r => { const rel = path.relative(r, f); return !!rel && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel); };
    return mdRoots().some(under) ? f : null;
  };
  const mdIn = file => (isDoc(String(file)) ? mdUnder(file) : null);
  ipcMain.handle('md:list', () => Promise.all(mdRoots().map(async dir => {
    if (!fs.existsSync(dir)) return { dir, files: [], times: {}, missing: true };
    const files = await listDocs(dir);
    return { dir, files, times: await timesOf(files, f => path.join(dir, ...f.split('/'))) };   // 照修改時間、建立日期排用（D132）
  })));
  // 釘資料夾：跳選資料夾的視窗；取消回 null，已經釘了回 { dir, dup: true }
  ipcMain.handle('md:add', async () => {
    const dir = await pickMdDir(win());
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
    if (isMd(f)) return { html: render(notes.decode(fs.readFileSync(f))) };
    const st = fs.statSync(f);
    docAllowed = docUrl(f, `${st.mtimeMs}-${st.size}`);
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
    sys.showItemInFolder(f);
  });
  // 右鍵「用瀏覽器開」（D122，只有 .html）：用 Windows 設定的預設程式開那個檔（小工具、要印的時候用）；測試帶 --open-log 時寫路徑不真的開
  ipcMain.handle('md:browser', async (_, file) => {
    const f = mdIn(file);
    if (!f || !isHtml(f)) throw new Error(L('只有 .html 能用瀏覽器開'));
    const err = await sys.openPath(f);
    if (err) throw new Error(L('打不開：{err}', { err }));   // 同「開啟位置」、常用（D131：畫面上看得到的字要 L()）
  });
  // 網址連結用瀏覽器開；只開 http、https、mailto（openOut 在 main.js，常用也用）
  ipcMain.handle('md:link', (_, url) => openOut(url));
  /* .html 裡點連結（D122）：iframe 換頁、開新視窗都攔下來（主視窗的 will-frame-navigate、setWindowOpenHandler 叫這裡）。
     網址用瀏覽器開；連到釘住的資料夾裡的 .md、.html 就請畫面開成頁籤（md:open）；其他的不理。同一頁的 #段落不會到這裡（照常跳） */
  function docNav(url) {
    if (/^(https?|mailto):/i.test(url)) { openOut(url).catch(() => { /* 開不了就算了 */ }); return; }
    const f = docFile(url), t = f && mdIn(f);
    if (t && fs.existsSync(t) && win() && !win().isDestroyed()) win().webContents.send('md:open', t, new URL(url).hash.slice(1));   // # 後面的（D159）：連到 .md 的段落，開好了捲過去
  }
  /* .html 的程式會跑（D148）：網頁要換頁、開新視窗，使用者 1 秒內在網頁裡點過、按過才交給 docNav；程式自己要開的（一載入就跳轉、寫壞了一直開）不理。
     Electron 給的換頁、開新視窗沒有「是不是使用者點的」，主程序的 input-event 也收不到點在 iframe（別的程序）裡的，
     所以在網頁裡放監聽記時間（DOC_HOOKS，isTrusted 的才算，網頁的程式假造不出來），要開的時候回頭問（問要換頁的那個 frame；開新視窗 Electron 沒給是哪個，問正在看的）。
     開過的 .html 每份留一個 iframe（D155）：正在看的是網址跟 docAllowed（畫面最後讀的那份）一樣的那個，#段落不算 */
  const docFrame = () => (win() && !win().isDestroyed() ? win().webContents.mainFrame.frames.find(f => f.url.split('#')[0] === docAllowed) || null : null);
  async function docNavByUser(url, f = docFrame()) {
    const t = f ?await f.executeJavaScript('window.__daybookInput || 0').catch(() => 0) : 0;
    if (Date.now() - t < 1000) docNav(url);
  }
  /* .html 的捲軸照畫面的（見 開發筆記 D164）：值抄 style.css 的捲軸那段（D077），改的話兩邊一起改；寬度跟 .md 那塊一樣 10px。
     亮暗照 prefers-color-scheme：iframe 的跟著 nativeTheme.themeSource，就是畫面切的那個（theme:set）。
     放在 @layer 裡：網頁自己設了捲軸的，照網頁的（沒放 layer 的樣式一律比它優先）。用 adoptedStyleSheets，不動網頁的 DOM */
  const DOC_SCROLL_CSS = `@layer daybook {
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner, ::-webkit-scrollbar-thumb { background: transparent; }
  :hover::-webkit-scrollbar-thumb { background: rgba(100, 100, 100, 0.4); }
  :hover { --hovered: 1; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(100, 100, 100, 0.7); }
  ::-webkit-scrollbar-thumb:active { background: rgba(0, 0, 0, 0.6); }
  @media (prefers-color-scheme: dark) {
    :hover::-webkit-scrollbar-thumb { background: rgba(121, 121, 121, 0.4); }
    ::-webkit-scrollbar-thumb:hover { background: rgba(100, 100, 100, 0.7); }
    ::-webkit-scrollbar-thumb:active { background: rgba(191, 191, 191, 0.4); }
  }
}`;
  /* 網頁載入完放進去的監聽（主程序塞的，跑在網頁裡）：記使用者最後一次真的點、真的按鍵的時間（docNavByUser）；
     焦點在網頁裡按 Ctrl+F、Esc、F3 時通知畫面（postMessage）：畫面收不到 iframe 裡的按鍵，找字的框靠這個打開、收起來、找下一個（D149、D150）；Ctrl+P 找文件也是（D158）；
     頁籤的按鍵（Ctrl+W、Ctrl+Tab、Ctrl+PageUp／PageDown、Ctrl+Shift+T）和放開 Ctrl（Ctrl+Tab 的清單）也是，Ctrl+W 一定要攔：預設選單的 Ctrl+W 會關掉整個視窗（D160）；
     Ctrl+1～9 換到頁籤列的第幾個也是（D168）；
     載完、畫完一格通知畫面（painted）：新建的 iframe 墊在原本的畫面底下，收到才換上（D154）；
     網頁裡點下去通知畫面（down）：畫面的選單靠 document 的 mousedown 判斷點外面，收不到 iframe 裡的（D164）；
     捲軸照畫面的（DOC_SCROLL_CSS，D164） */
  const DOC_HOOKS = `if (!window.__daybookHooks) {
  window.__daybookHooks = 1;
  const painted = () => requestAnimationFrame(() => setTimeout(() => parent.postMessage({ daybook: 'painted' }, '*')));
  if (document.readyState === 'complete') painted(); else addEventListener('load', painted, { once: true });
  const sb = new CSSStyleSheet();
  sb.replaceSync(${JSON.stringify(DOC_SCROLL_CSS)});
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sb];
  for (const t of ['pointerdown', 'keydown']) addEventListener(t, e => { if (e.isTrusted) window.__daybookInput = Date.now(); }, true);
  addEventListener('pointerdown', e => { if (e.isTrusted) parent.postMessage({ daybook: 'down' }, '*'); }, true);
  addEventListener('keydown', e => {
    if (!e.isTrusted) return;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); parent.postMessage({ daybook: 'find' }, '*'); }
    else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); parent.postMessage({ daybook: 'quick' }, '*'); }
    else if (e.key === 'F3' && !e.ctrlKey && !e.altKey) { e.preventDefault(); parent.postMessage({ daybook: 'f3', back: e.shiftKey }, '*'); }
    else if (e.key === 'Escape') parent.postMessage({ daybook: 'esc' }, '*');
    else if (e.ctrlKey && !e.altKey && (/^w$/i.test(e.key) && !e.shiftKey || /^t$/i.test(e.key) && e.shiftKey || e.key === 'Tab' || !e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown'))) {
      e.preventDefault();
      parent.postMessage({ daybook: 'tabkey', key: e.key, shift: e.shiftKey }, '*');
    }
    else if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); parent.postMessage({ daybook: 'actkey', key: e.key }, '*'); }
  }, true);
  addEventListener('keyup', e => { if (e.isTrusted && e.key === 'Control') parent.postMessage({ daybook: 'ctrlup' }, '*'); }, true);
} 1`;
  /* .html 找字（D149）：找字的程式（shared/docfind.js 的原文，跟 .md 用的同一份）塞進網頁跑；op、要找的字照 JSON 帶進去，不拼成程式碼。
     iframe 換了（重新載入）會沒有，每次都先看在不在 */
  const DOC_FIND_SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'docfind.js'), 'utf8');
  ipcMain.handle('doc:find', (_, op, arg) => {
    const f = docFrame();
    if (!f) return null;
    return f.executeJavaScript(`if (!window.daybookFind) {\n${DOC_FIND_SRC}\n}\ndaybookFind.pageOp(${JSON.stringify(String(op))}, ${JSON.stringify(arg && typeof arg === 'object' ? arg : {})})`)
      .catch(() => null);
  });
  /* .html 存的東西（localStorage、IndexedDB…，見 開發筆記 D152）：文件檢視只是檢視器，不留著——關掉 daybook 時清；
     開起來、載入任何一份之前也清一次（當掉、被砍掉時沒清到的）。daybook 開著的時候照留（換頁籤、關頁籤都不清）。
     全部 .html 共用一個來源（D148），只清它、不動 daybook 自己的 localStorage */
  const docClear = () => session.defaultSession.clearStorageData({ origin: 'docview://local' }).catch(() => { /* 清不掉就算了 */ });
  /* .html 和它用到的圖、css、字型（D122）：docview://local/<路徑>，只給釘住的資料夾底下的檔。
     網頁加 CSP：程式不跑、不連到外面（使用者選的）；字型在沙盒（opaque origin）裡要 CORS 才載得到，一律加 Access-Control-Allow-Origin */
  async function serveDoc(req) {
    const f = mdUnder(docFile(req.url) || '');
    if (!f) return new Response('', { status: 403 });
    let body;
    try { body = await fs.promises.readFile(f); } catch { return new Response('', { status: 404 }); }
    const headers = { 'Content-Type': mimeOf(f), 'Access-Control-Allow-Origin': '*' };   // 網頁不寫 charset：照檔案裡的 <meta charset>（Word 轉的常是 big5）
    if (isHtml(f)) headers['Content-Security-Policy'] = DOC_CSP;
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
          if (skipped(n) || (type === 'change' && !isDoc(n))) return;
          clearTimeout(mdTimer);
          mdTimer = setTimeout(() => { if (win() && !win().isDestroyed()) win().webContents.send('md:changed'); }, 150);
        });
        w.on('error', () => { /* 資料夾被刪掉、隨身碟拔掉：清單上寫找不到 */ });
        mdWatchers.push(w);
      } catch { /* 資料夾不在：清單上寫找不到 */ }
    }
  }
  return { docAllowed: () => docAllowed, docNavByUser, DOC_HOOKS, serveDoc, watchMd, docClear };
}

module.exports = { isMd, isHtml, isDoc, skipped, listDocs, render, docUrl, docFile, mimeOf, DOC_CSP, setupIpc };
