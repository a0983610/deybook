/* ============================================================
   改版本號（見 開發筆記 D039、D123）：
     node tools/bump.cjs minor   加功能（1.0.0 → 1.1.0）
     node tools/bump.cjs patch   只修錯、改文件、小調整（1.0.0 → 1.0.1）
     node tools/bump.cjs major   資料格式改到舊紀錄不能直接用（1.0.0 → 2.0.0）
     node tools/bump.cjs         只印目前版本
   一次改四個地方：package.json 的 version、package-lock.json 的 version 和 packages[""].version、
   README.md 開頭的「版本：**x.y.z**」。四個要一樣才改，不一樣就一個都不動。
   只換版本號那幾個字，其他字原封不動：整份 JSON 重寫會把 package.json 一行的物件拆開（D119 踩過）。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = { pkg: 'package.json', lock: 'package-lock.json', readme: 'README.md' };
const README_RE = /版本：\*\*([^*]*)\*\*/;

/** 下一版：level 是 major、minor、patch */
function next(ver, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ver);
  if (!m) throw new Error(`版本號不是 x.y.z：${ver}`);
  const [a, b, c] = m.slice(1).map(Number);
  if (level === 'major') return `${a + 1}.0.0`;
  if (level === 'minor') return `${a}.${b + 1}.0`;
  if (level === 'patch') return `${a}.${b}.${c + 1}`;
  throw new Error(`跳哪一碼要寫 major、minor、patch：${level}`);
}

/* JSON 檔：前 n 個 "version" 換成 to（npm 寫的 package-lock.json，前兩個就是根的 version、packages[""].version）。
   換完 parse 回來比：keys 指的欄位變成 to、把它們放回 from 之後跟原本一模一樣，才算只改到版本號 */
function swapJson(text, name, keys, from, to) {
  let i = 0;
  const out = text.replace(/("version"\s*:\s*")[^"]*(")/g, (all, a, b) => (i++ < keys.length ? a + to + b : all));
  const before = JSON.parse(text), after = JSON.parse(out);
  for (const k of keys) {
    const o = k.slice(0, -1).reduce((x, p) => x && x[p], after);
    const last = k[k.length - 1];
    if (!o || o[last] !== to) throw new Error(`${name} 的 ${k.join('.')} 沒換到，沒改`);
    o[last] = from;
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`${name} 除了版本號還會改到別的地方，沒改`);
  return out;
}

/** 讀目前的版本號：四個地方各是什麼（找不到是 undefined） */
function versions({ pkg, lock, readme }) {
  const p = JSON.parse(pkg), l = JSON.parse(lock), m = README_RE.exec(readme);
  return {
    'package.json': p.version,
    'package-lock.json version': l.version,
    'package-lock.json packages[""].version': l.packages && l.packages[''] && l.packages[''].version,
    'README.md 開頭「版本：**x.y.z**」': m ? m[1] : undefined,
  };
}

/** 三個檔的內容 → 跳號後的內容；四個地方不一樣、版本號不是 x.y.z 就丟錯 */
function bump(texts, level) {
  const vs = versions(texts);
  const from = vs['package.json'];
  if (Object.values(vs).some(v => v !== from)) {
    throw new Error('版本號不一樣，沒改：\n' + Object.entries(vs).map(([k, v]) => `  ${k}：${v === undefined ? '（找不到）' : v}`).join('\n'));
  }
  const to = next(from, level);
  return {
    from, to,
    pkg: swapJson(texts.pkg, FILES.pkg, [['version']], from, to),
    lock: swapJson(texts.lock, FILES.lock, [['version'], ['packages', '', 'version']], from, to),
    readme: texts.readme.replace(README_RE, `版本：**${to}**`),
  };
}

module.exports = { next, bump };

if (require.main === module) {
  const level = process.argv[2];
  try {
    const texts = {};
    for (const [k, f] of Object.entries(FILES)) texts[k] = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!level) {
      console.log(`目前版本：${versions(texts)['package.json']}`);
      console.log('跳號：node tools/bump.cjs minor（加功能）｜patch（修錯、改文件、小調整）｜major（舊紀錄不能直接用）');
      process.exitCode = 1;
    } else {
      const r = bump(texts, level);
      for (const [k, f] of Object.entries(FILES)) fs.writeFileSync(path.join(ROOT, f), r[k]);
      console.log(`版本號 ${r.from} → ${r.to}（已改 ${Object.values(FILES).join('、')}）`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
