/* 文件檢視（原本叫 MD 檢視，見 開發筆記 D118、D122）：唯讀看釘住的資料夾裡的 .md、.html（AI 產出的報告、筆記、規格）。
   - listDocs：資料夾底下全部的 .md、.html、.htm（一層一層進去），相對路徑（/ 隔開）、不排序（畫面照名稱，或修改時間、建立日期排，D132）。
     node_modules、.git 不進去（套件、版本紀錄裡的不是要看的）；用非同步讀，釘到很大的資料夾也不會卡住整個程式
   - render：md 轉成畫面的 HTML，用 marked（D119），GFM：表格、核取清單、刪除線。
     檔案裡的 HTML 照原字顯示、不當 HTML，只有 <br> 換行（AI 常在表格裡用）、<!-- 註解 --> 不顯示；圖片不顯示，換成「〔圖：說明〕」
   - .html 不轉：畫面用沙盒的 iframe 直接開，網址是 docview://local/<路徑>（D122），主程序照這個網址讀檔給它（docFile、mimeOf） */
'use strict';
const fs = require('fs');
const path = require('path');
const url = require('url');
const { Marked } = require('marked');
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
const md = new Marked({
  gfm: true,
  renderer: {
    html({ text, block }) {
      if (/^\s*<!--[\s\S]*-->\s*$/.test(text)) return '';
      if (!block && /^<br\s*\/?>$/i.test(text)) return '<br>';
      return block ? `<p class="mdRaw">${esc(text.replace(/\n+$/, ''))}</p>` : esc(text);
    },
    image({ text, href }) { return `<span class="mdImg">${esc(L('〔圖：{alt}〕', { alt: text || href }))}</span>`; },
  },
});
const render = text => md.parse(String(text));

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
// 給 iframe 的檔案類型：文件檢視會用到的（網頁、圖、字型、css）；其他的照二進位給
const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.emz': 'application/octet-stream',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
};
const mimeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
/* .html 的 CSP（D122，使用者選不跑程式、不連網）：只認自己（docview:）和 data: 的樣式、圖、字型、影音，程式一律不跑、不連到外面 */
const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline' docview:; img-src docview: data:; font-src docview: data:; media-src docview: data:";

module.exports = { isMd, isHtml, isDoc, skipped, listDocs, render, docUrl, docFile, mimeOf, DOC_CSP };
