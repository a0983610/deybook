/* ============================================================
   外觀包（見 開發筆記 D062）：換背景圖、空白時的插圖。一個外觀包一個資料夾，
   放在 %APPDATA%\daybook\skins\<資料夾>\，package.json 寫用哪幾張圖；只有圖、沒有程式，一次啟用一個。
   - scan：只讀 package.json、看圖檔在不在；每次要用時重讀，丟進去就有、不用重開（同匯入格式擴充，D055）
   - load：啟用的那個的圖讀成 data: 網址給畫面（檔案只在主程序讀，D002）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { compatible, VERSION_RE, RANGE_RE } = require('./extensions.js');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const PARTS = { background: '背景圖', empty: '空白時的插圖' };
const OPACITY = 0.12;   // 背景圖沒寫 opacity 時多淡
const mimeOf = file => MIME[path.extname(file).slice(1).toLowerCase()];

/* 一張圖：要放在外觀包的資料夾裡（分享給別人才帶得走）、是認得的圖檔、檔案在；回傳完整路徑 */
function imageFile(dir, key, image) {
  if (typeof image !== 'string' || !image.trim()) throw new Error(`contributes.skin.${key}.image 要寫圖檔名稱`);
  const file = path.resolve(dir, image);
  const rel = path.relative(dir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`圖檔要放在外觀包的資料夾裡：${image}`);
  if (!mimeOf(file)) throw new Error(`圖檔要是 png、jpg、gif、webp、svg：${image}`);
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new Error(`找不到圖檔 ${image}`);
  return file;
}

/* 讀一個外觀包的 package.json；name、version、engines 的規則跟匯入格式擴充一樣（D055）。缺東西就丟錯，寫缺什麼 */
function readManifest(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, ''));   // 記事本存的會帶 BOM
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? '沒有 package.json' : 'package.json 不是正確的 JSON');
  }
  const str = v => typeof v === 'string' && v.trim() !== '';
  if (!pkg || !str(pkg.name)) throw new Error('package.json 少了 name');
  if (!VERSION_RE.test(pkg.version)) throw new Error('package.json 的 version 要寫成 x.y.z');
  const range = pkg.engines && pkg.engines.daybook;
  if (!RANGE_RE.test(range)) throw new Error('package.json 的 engines.daybook 要寫成 ^版本號，例如 ^1.14.0');
  const skin = pkg.contributes && pkg.contributes.skin;
  if (!skin || !Object.keys(PARTS).some(k => skin[k])) throw new Error('package.json 的 contributes.skin 沒有 background 也沒有 empty');
  const x = { name: pkg.name, displayName: str(pkg.displayName) ? pkg.displayName : pkg.name, version: pkg.version, range, background: null, empty: null };
  if (skin.background) {
    const o = skin.background.opacity;
    if (o != null && !(typeof o === 'number' && o > 0 && o <= 1)) throw new Error('contributes.skin.background.opacity 要是 0～1 之間的數字，例如 0.12');
    x.background = { file: imageFile(dir, 'background', skin.background.image), opacity: o == null ? OPACITY : o };
  }
  if (skin.empty) x.empty = { file: imageFile(dir, 'empty', skin.empty.image) };
  x.parts = Object.keys(PARTS).filter(k => x[k]).map(k => PARTS[k]);
  return x;
}

/* 外觀包資料夾裡的每個外觀包，照資料夾名稱排：{ folder, name, displayName, version, range, parts, background, empty, state, reason }
   state：enabled 已啟用｜disabled 未啟用｜incompatible 版本不合｜broken 壞掉（reason 寫原因），跟匯入格式擴充一樣
   enabled：啟用的那個的名稱，沒有是 null */
function scan(dir, appVersion, enabled) {
  if (!fs.existsSync(dir)) return [];
  const folders = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const list = [];
  for (const folder of folders) {
    const x = { folder, name: folder, displayName: folder, version: '', range: '', parts: [], background: null, empty: null, state: 'broken', reason: '' };
    list.push(x);
    try {
      Object.assign(x, readManifest(path.join(dir, folder)));
    } catch (e) {
      x.reason = e.message;
      continue;
    }
    const dup = list.find(o => o !== x && o.state !== 'broken' && o.name === x.name);
    if (dup) {
      x.reason = `name 跟資料夾「${dup.folder}」的外觀包重複`;
    } else if (!compatible(x.range, appVersion)) {
      x.state = 'incompatible';
      x.reason = `要 daybook ${x.range}，現在是 ${appVersion}`;
    } else {
      x.state = enabled === x.name ? 'enabled' : 'disabled';
    }
  }
  return list;
}

/* 啟用的那個外觀包的圖，讀成 data: 網址：{ background: { url, opacity } | null, empty: { url } | null } */
const dataUrl = file => `data:${mimeOf(file)};base64,${fs.readFileSync(file).toString('base64')}`;
const load = x => ({
  background: x.background && { url: dataUrl(x.background.file), opacity: x.background.opacity },
  empty: x.empty && { url: dataUrl(x.empty.file) },
});

/* 「外觀」頁上給人照著改的 package.json：engines 填現在的版本 */
const sample = appVersion => JSON.stringify({
  name: 'my-skin', displayName: '我的外觀', version: '1.0.0', engines: { daybook: '^' + appVersion },
  contributes: { skin: { background: { image: 'background.jpg', opacity: OPACITY }, empty: { image: 'empty.png' } } },
}, null, 2);

module.exports = { scan, load, sample };
