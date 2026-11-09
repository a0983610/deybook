/* ============================================================
   外觀包（見 開發筆記 D062）：換背景圖、空白時的插圖。一個外觀包一個資料夾，
   放在 %APPDATA%\daybook\skins\<資料夾>\，package.json 寫用哪幾張圖；只有圖、沒有程式，一次啟用一個。
   - scan：只讀 package.json、看圖檔在不在；每次要用時重讀，丟進去就有、不用重開（同匯入格式擴充，D055）
   - load：啟用的那個的圖讀成 data: 網址給畫面（檔案只在主程序讀，D002）
   - readImage、create：「外觀」頁的「用圖檔做一個」選圖、開新的外觀包（D066）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { compatible, VERSION_RE, RANGE_RE } = require('./extensions.js');
const { L, LK, joinList: listJoin } = require('../shared/i18n.js');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const PARTS = { background: LK('背景圖'), empty: LK('空白時的插圖') };   // 顯示時才 L()：主程序換語言不重開（D131）
const OPACITY = 0.12;   // 背景圖沒寫 opacity 時多淡
/* 背景圖放哪（D066）：cover 是鋪滿（沒寫就是它），其他九個是不鋪滿、照 size（佔畫面寬幾 %）放在那個位置 */
const POSITIONS = ['cover', 'top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
const SIZE = 30;
const mimeOf = file => MIME[path.extname(file).slice(1).toLowerCase()];
const TYPES = () => listJoin(['png', 'jpg', 'gif', 'webp', 'svg']);

/* 一張圖：要放在外觀包的資料夾裡（分享給別人才帶得走）、是認得的圖檔、檔案在；回傳完整路徑 */
function imageFile(dir, key, image) {
  if (typeof image !== 'string' || !image.trim()) throw new Error(L('contributes.skin.{key}.image 要寫圖檔名稱', { key }));
  const file = path.resolve(dir, image);
  const rel = path.relative(dir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(L('圖檔要放在外觀包的資料夾裡：{image}', { image }));
  if (!mimeOf(file)) throw new Error(L('圖檔要是 {types}：{image}', { types: TYPES(), image }));
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new Error(L('找不到圖檔 {image}', { image }));
  return file;
}

/* 背景圖的 opacity、position、size：沒寫（null）都可以，寫了就要對。key 是錯誤訊息裡寫的位置：background 或 background[1]（好幾張時，D067） */
function checkBackground(key, o, p, s) {
  if (o != null && !(typeof o === 'number' && o > 0 && o <= 1)) throw new Error(L('contributes.skin.{key}.opacity 要是 0～1 之間的數字，例如 0.12', { key }));
  if (p != null && !POSITIONS.includes(p)) throw new Error(L('contributes.skin.{key}.position 要是 {list} 其中一個', { key, list: listJoin(POSITIONS) }));
  if (s != null && !(typeof s === 'number' && s >= 1 && s <= 100)) throw new Error(L('contributes.skin.{key}.size 要是 1～100 之間的數字（佔畫面寬幾 %），例如 30', { key }));
}

/* 讀一個外觀包的 package.json；name、version、engines 的規則跟匯入格式擴充一樣（D055）。缺東西就丟錯，寫缺什麼 */
function readManifest(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, ''));   // 記事本存的會帶 BOM
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? L('沒有 package.json') : L('package.json 不是正確的 JSON'));
  }
  const str = v => typeof v === 'string' && v.trim() !== '';
  if (!pkg || !str(pkg.name)) throw new Error(L('package.json 少了 name'));
  if (!VERSION_RE.test(pkg.version)) throw new Error(L('package.json 的 version 要寫成 x.y.z'));
  const range = pkg.engines && pkg.engines.daybook;
  if (!RANGE_RE.test(range)) throw new Error(L('package.json 的 engines.daybook 要寫成 ^版本號，例如 ^1.10.0'));   // 跟擴充（extensions.js）同一句，翻譯只要一條
  const skin = pkg.contributes && pkg.contributes.skin;
  if (!skin || !Object.keys(PARTS).some(k => skin[k])) throw new Error(L('package.json 的 contributes.skin 沒有 background 也沒有 empty'));
  const x = { name: pkg.name, displayName: str(pkg.displayName) ? pkg.displayName : pkg.name, version: pkg.version, range, background: null, empty: null };
  if (skin.background) {
    // 一張寫物件、好幾張寫陣列（D067）；讀進來一律是陣列，後面的疊在上面
    const many = Array.isArray(skin.background);
    const list = many ? skin.background : [skin.background];
    if (!list.length) throw new Error(L('contributes.skin.background 是空的陣列，至少要一張'));
    x.background = list.map((item, i) => {
      const b = item || {};
      const key = many ? `background[${i}]` : 'background';
      checkBackground(key, b.opacity, b.position, b.size);
      return { file: imageFile(dir, key, b.image), opacity: b.opacity == null ? OPACITY : b.opacity,
        position: b.position == null ? 'cover' : b.position, size: b.size == null ? SIZE : b.size };
    });
  }
  if (skin.empty) x.empty = { file: imageFile(dir, 'empty', skin.empty.image) };
  x.parts = [];
  if (x.background) x.parts.push(x.background.length > 1 ? L('背景圖 {n} 張', { n: x.background.length }) : L(PARTS.background));
  if (x.empty) x.parts.push(L(PARTS.empty));
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
      x.reason = L('name 跟資料夾「{folder}」的外觀包重複', { folder: dup.folder });
    } else if (!compatible(x.range, appVersion)) {
      x.state = 'incompatible';
      x.reason = L('要 daybook {range}，現在是 {version}', { range: x.range, version: appVersion });
    } else {
      x.state = enabled === x.name ? 'enabled' : 'disabled';
    }
  }
  return list;
}

/* 啟用的那個外觀包的圖，讀成 data: 網址：{ background: [{ url, opacity, position, size }, …] | null, empty: { url } | null } */
const dataUrl = file => `data:${mimeOf(file)};base64,${fs.readFileSync(file).toString('base64')}`;
const load = x => ({
  background: x.background && x.background.map(b => ({ url: dataUrl(b.file), opacity: b.opacity, position: b.position, size: b.size })),
  empty: x.empty && { url: dataUrl(x.empty.file) },
});

/* 「用圖檔做一個」選的圖（D066）：讀成 data: 網址給畫面預覽、去背；不是認得的圖就丟錯 */
function readImage(file) {
  if (!mimeOf(file)) throw new Error(L('圖檔要是 {types}：{image}', { types: TYPES(), image: path.basename(file) }));
  return { name: path.basename(file), url: dataUrl(file) };
}

/* data: 網址 → { ext, data }：畫面送回來的圖（選的原檔，或去背後的 png） */
function fromDataUrl(url) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(url));
  const ext = m && Object.keys(MIME).find(k => MIME[k] === m[1]);   // image/jpeg 取 jpg
  if (!ext) throw new Error(L('圖檔要是 {types}', { types: TYPES() }));
  return { ext, data: Buffer.from(m[2], 'base64') };
}

/* 用圖檔開一個新的外觀包（D066）：跟手寫的一樣是一個資料夾＋圖＋package.json，分享照舊把資料夾給人。
   spec：{ displayName, background: [{ url, opacity, position, size }, …] | null, empty: { url } | null }，url 是 data: 網址。
   背景圖一張寫成物件、好幾張寫成陣列（D067），圖存成 background.*、background-2.*…
   資料夾名稱＝名稱拿掉 Windows 不能用的字；已經有這個資料夾、或別的外觀包的 name 是它，就接「 (2)」「 (3)」…
   name 就用資料夾名稱。回傳 name */
function create(dir, appVersion, spec) {
  const title = String(spec.displayName || '').trim() || L('我的外觀');
  const bgs = spec.background || [];
  if (!bgs.length && !spec.empty) throw new Error(L('至少要選一張圖：背景圖或空白時的插圖'));
  const files = [];
  const skin = {};
  const list = bgs.map((b, i) => {
    checkBackground(bgs.length > 1 ? `background[${i}]` : 'background', b.opacity, b.position, b.size);
    const img = fromDataUrl(b.url);
    const image = `background${i ? '-' + (i + 1) : ''}.${img.ext}`;
    files.push([image, img.data]);
    const o = { image, opacity: b.opacity == null ? OPACITY : b.opacity, position: b.position || 'cover' };
    if (o.position !== 'cover') o.size = b.size == null ? SIZE : b.size;
    return o;
  });
  if (list.length) skin.background = list.length === 1 ? list[0] : list;
  if (spec.empty) {
    const img = fromDataUrl(spec.empty.url);
    files.push([`empty.${img.ext}`, img.data]);
    skin.empty = { image: `empty.${img.ext}` };
  }
  const base = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim() || L('我的外觀');
  const names = new Set(scan(dir, appVersion, null).map(x => x.name));
  let folder = base;
  for (let i = 2; fs.existsSync(path.join(dir, folder)) || names.has(folder); i++) folder = `${base} (${i})`;
  const d = path.join(dir, folder);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, data] of files) fs.writeFileSync(path.join(d, f), data);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    name: folder, displayName: title, version: '1.0.0', engines: { daybook: '^' + appVersion }, contributes: { skin },
  }, null, 2) + '\n');
  return folder;
}

module.exports = { scan, load, readImage, create, EXTS: Object.keys(MIME) };
