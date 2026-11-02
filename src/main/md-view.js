/* MD 檢視（見 開發筆記 D118）：唯讀看釘住的資料夾裡的 .md（AI 產出的報告、筆記）。
   - listMd：資料夾底下全部的 .md（一層一層進去），相對路徑（/ 隔開）、不排序（畫面照名稱排）。
     node_modules、.git 不進去（套件、版本紀錄裡的 .md 不是要看的）；用非同步讀，釘到很大的資料夾也不會卡住整個程式
   - render：md 轉成畫面的 HTML，用 marked（D119），GFM：表格、核取清單、刪除線。
     檔案裡的 HTML 照原字顯示、不當 HTML，只有 <br> 換行（AI 常在表格裡用）、<!-- 註解 --> 不顯示；圖片不顯示，換成「〔圖：說明〕」 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');

const SKIP = new Set(['node_modules', '.git']);
const isMd = name => /\.md$/i.test(name);
// 路徑（\ 或 / 隔開）裡有沒有 node_modules、.git 那一層
const skipped = rel => String(rel).split(/[\\/]/).some(s => SKIP.has(s.toLowerCase()));

async function listMd(root) {
  const files = [];
  const walk = async rel => {
    let ents;
    try { ents = await fs.promises.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true }); } catch { return; }   // 讀不到的資料夾（沒權限）跳過
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name.toLowerCase())) await walk(r); }   // 捷徑（symlink、junction）不是 isDirectory，不會繞圈
      else if (e.isFile() && isMd(e.name)) files.push(r);
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
    image({ text, href }) { return `<span class="mdImg">〔圖：${esc(text || href)}〕</span>`; },
  },
});
const render = text => md.parse(String(text));

module.exports = { isMd, skipped, listMd, render };
