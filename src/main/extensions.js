/* ============================================================
   匯入、匯出格式的外部擴充（見 開發筆記 D047、D055、D078）：像 VS Code 的擴充，一個擴充一個資料夾，
   放在 %APPDATA%\daybook\extensions\<資料夾>\，package.json 宣告提供哪些格式，程式檔給 detect / parse（匯入）、write（匯出）。
   - scan：只讀 package.json、不跑擴充的程式；每次要用時重讀，丟進去就有、不用重開
   - startHost：擴充的程式只在匯入、匯出時、在獨立程序（ext-host.js）跑；丟錯、自己結束、跑太久都不會拖垮 daybook
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { L } = require('../shared/i18n.js');

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const RANGE_RE = /^\^(\d+)\.(\d+)\.(\d+)$/;
const EXT_RE = /^[A-Za-z0-9]+$/;   // 匯出的副檔名：存檔視窗、檔名用，不含「.」

/* engines.daybook 只認 ^X.Y.Z：第一碼一樣、而且不比 X.Y.Z 舊（第一碼是資料格式不相容才跳，見 D039） */
function compatible(range, version) {
  const r = RANGE_RE.exec(range).slice(1).map(Number);
  const v = version.split('.').map(Number);
  return v[0] === r[0] && (v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2]));
}

/* 讀一個擴充的 package.json；缺東西就丟錯，寫缺什麼 */
function readManifest(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, ''));   // 記事本存的會帶 BOM
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? L('沒有 package.json') : L('package.json 不是正確的 JSON'));
  }
  const m = checkManifest(pkg);
  const file = path.resolve(dir, m.main);
  if (!fs.existsSync(file)) throw new Error(L('找不到程式檔 {file}', { file: m.main }));
  return { name: m.name, displayName: m.displayName, version: m.version, range: m.range, formats: m.formats, exportFormats: m.exportFormats, file };
}

/* package.json 的欄位對不對（不碰檔案；AI 寫的擴充貼回來時也用這個，見 開發筆記 D056）。缺東西就丟錯，寫缺什麼 */
function checkManifest(pkg) {
  const str = v => typeof v === 'string' && v.trim() !== '';
  if (!pkg || !str(pkg.name)) throw new Error(L('package.json 少了 name'));
  if (!VERSION_RE.test(pkg.version)) throw new Error(L('package.json 的 version 要寫成 x.y.z'));
  const range = pkg.engines && pkg.engines.daybook;
  if (!RANGE_RE.test(range)) throw new Error(L('package.json 的 engines.daybook 要寫成 ^版本號，例如 ^1.10.0'));
  // 匯入（importFormats）、匯出（exportFormats，D078）至少要有一種；兩種都有就是同一個擴充能匯入也能匯出
  const list = k => (pkg.contributes && pkg.contributes[k] != null ? pkg.contributes[k] : []);
  const fmts = list('importFormats'), outs = list('exportFormats');
  if (!Array.isArray(fmts) || !Array.isArray(outs) || (!fmts.length && !outs.length)) {
    throw new Error(L('package.json 的 contributes 沒有列格式：要有 importFormats（匯入）或 exportFormats（匯出）'));
  }
  if (!fmts.every(f => f && str(f.id) && str(f.label) && str(f.hint) && Array.isArray(f.extensions) && f.extensions.length && f.extensions.every(str))) {
    throw new Error(L('contributes.importFormats 每一種格式都要有 id、label、hint、extensions'));
  }
  if (new Set(fmts.map(f => f.id)).size !== fmts.length) throw new Error(L('contributes.importFormats 的 id 重複'));
  if (!outs.every(f => f && str(f.id) && str(f.label) && str(f.hint) && typeof f.extension === 'string' && EXT_RE.test(f.extension))) {
    throw new Error(L('contributes.exportFormats 每一種格式都要有 id、label、hint、extension（副檔名，只寫英文、數字，不含「.」）'));
  }
  if (new Set(outs.map(f => f.id)).size !== outs.length) throw new Error(L('contributes.exportFormats 的 id 重複'));
  return {
    name: pkg.name,
    displayName: str(pkg.displayName) ? pkg.displayName : pkg.name,
    version: pkg.version,
    range,
    formats: fmts.map(({ id, label, hint, extensions }) => ({ id, label, hint, extensions })),
    exportFormats: outs.map(({ id, label, hint, extension }) => ({ id, label, hint, extension })),
    main: str(pkg.main) ? pkg.main : 'index.js',   // 沒寫跟 Node 一樣找 index.js
  };
}

/* 擴充資料夾裡的每個擴充，照資料夾名稱排：{ folder, name, displayName, version, range, formats, exportFormats, file, state, reason }
   state：enabled 已啟用｜disabled 未啟用（沒啟用過，或改版了要再啟用一次）｜incompatible 版本不合｜broken 壞掉（reason 寫原因）
   enabled：使用者啟用過的 { 名稱: 版本 } */
function scan(dir, appVersion, enabled) {
  if (!fs.existsSync(dir)) return [];
  const folders = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const list = [];
  for (const folder of folders) {
    const x = { folder, name: folder, displayName: folder, version: '', range: '', formats: [], exportFormats: [], file: null, state: 'broken', reason: '' };
    list.push(x);
    try {
      Object.assign(x, readManifest(path.join(dir, folder)));
    } catch (e) {
      x.reason = e.message;
      continue;
    }
    const dup = list.find(o => o !== x && o.state !== 'broken' && o.name === x.name);
    if (dup) {
      x.reason = L('name 跟資料夾「{folder}」的擴充重複', { folder: dup.folder });
    } else if (!compatible(x.range, appVersion)) {
      x.state = 'incompatible';
      x.reason = L('要 daybook {range}，現在是 {version}', { range: x.range, version: appVersion });
    } else if (enabled[x.name] === x.version) {
      x.state = 'enabled';
    } else {
      x.state = 'disabled';
      if (enabled[x.name]) x.reason = L('改版了（啟用的是 {version}），要再啟用一次', { version: enabled[x.name] });
    }
  }
  return list;
}

/* 已啟用的擴充提供的格式，跟內建格式同一個樣子，另外帶 ext（擴充名稱）、file（程式檔） */
const enabledFormats = list => list.filter(x => x.state === 'enabled')
  .flatMap(x => x.formats.map(f => ({ ...f, ext: x.displayName, file: x.file })));
/* 匯出格式（見 開發筆記 D078）：同上，另外帶 key（「擴充名稱/格式 id」，畫面上的下拉選單用；name 不會重複，見 scan） */
const enabledExportFormats = list => list.filter(x => x.state === 'enabled')
  .flatMap(x => x.exportFormats.map(f => ({ ...f, key: x.name + '/' + f.id, ext: x.displayName, file: x.file })));

/* 開一個獨立程序跑擴充。fork() 回傳 Electron utilityProcess 那種子程序：postMessage、on('message')、on('exit')、kill。
   formats：要跑的格式（enabledFormats 的）。回傳：
     detect(text) → 每一種格式認不認得 [true/false…]
     parse(format, text) → 那一種格式拆出來的結果（還沒檢查，見 import.js 的 checkParsed）
     write(format, data) → 那一種匯出格式寫出來的內容：文字，或位元組（Buffer）（D078）
     kill()
   擴充丟錯、讓程序結束、超過 timeoutMs 都丟錯，寫是哪個擴充 */
function startHost(fork, formats, timeoutMs = 10000) {
  const child = fork();
  let alive = true;
  let pending = null;   // 正在等的那一次 { resolve, reject, timer, names, running }
  const finish = () => { const p = pending; pending = null; clearTimeout(p.timer); return p; };
  child.on('message', m => {
    if (!pending) return;
    if (m.running != null) { pending.running = m.running; return; }   // 開始跑第幾個：跑太久時才知道是誰
    const p = finish();
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(L('擴充「{name}」出錯：{error}', { name: p.names[m.at], error: m.error })));
  });
  child.on('exit', code => {
    alive = false;
    if (!pending) return;
    const p = finish();
    p.reject(new Error(L('擴充「{name}」讓擴充程序結束了（exit {code}）', { name: p.names[p.running] || '?', code })));
  });
  const call = (op, jobs, input) => new Promise((resolve, reject) => {
    if (!alive) return reject(new Error(L('擴充程序已經結束了')));
    const names = jobs.map(f => f.ext);
    const timer = setTimeout(() => {
      const p = finish();
      child.kill();
      reject(new Error(L('擴充「{name}」跑太久（超過 {sec} 秒），已經停掉', { name: names[p.running] || '?', sec: timeoutMs / 1000 })));
    }, timeoutMs);
    pending = { resolve, reject, timer, names, running: null };
    child.postMessage({ op, jobs: jobs.map(f => ({ id: f.id, file: f.file })), input });
  });
  return {
    formats,
    detect: text => call('detect', formats, text),
    parse: (format, text) => call('parse', [format], text),
    // 位元組在 ext-host.js 包成 { bytes: base64 } 傳回來
    write: async (format, data) => { const v = await call('write', [format], data); return typeof v === 'string' ? v : Buffer.from(v.bytes, 'base64'); },
    kill: () => { if (alive) child.kill(); },
  };
}

module.exports = { compatible, checkManifest, scan, enabledFormats, enabledExportFormats, startHost, VERSION_RE, RANGE_RE };
