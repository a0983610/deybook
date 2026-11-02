/* ============================================================
   收介面上要翻的字（見 開發筆記 D131）→ src/shared/i18n-keys.json（語言頁的 prompt、算缺幾條都照它）
   - JS：L('…')、LK('…') 的第一個參數（字串，或沒有 ${} 的 `…`）
   - HTML：index.html、capture.html 的文字節點、title／placeholder／aria-label／alt，
     規則跟 shared/i18n.js 的 translateDom 一樣（有中文或全形標點才算；code、kbd、pre、textarea、script、style、translate="no" 裡的文字不算）
     node tools/i18n-keys.cjs              重寫 i18n-keys.json
     node tools/i18n-keys.cjs --check      只比，不一樣就列出差異（parser 測試 I18N 也比）
     node tools/i18n-keys.cjs --audit [檔…] 列出還沒包 L() 的中文字串：改程式的人自己看，資料裡的字（[待回覆]、待辦.md…）本來就不包。
                                           那一行的註解寫「不翻」就不列；好幾行的（例如給 AI 的 prompt）前後各一行註解寫「不翻開始」「不翻結束」
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { norm, NEEDS, ATTRS } = require('../src/shared/i18n.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src/shared/i18n-keys.json');
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/');

/* 要收的檔，照這個順序（prompt 也照這個順序分段）：畫面的 HTML、app.js，截圖那層，主程序，shared */
function sourceFiles() {
  const list = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).filter(f => re.test(f)).sort().map(f => path.join(ROOT, dir, f));
  return [
    path.join(ROOT, 'src/renderer/index.html'),
    path.join(ROOT, 'src/renderer/app.js'),
    path.join(ROOT, 'src/renderer/capture.html'),
    path.join(ROOT, 'src/renderer/capture.js'),
    path.join(ROOT, 'src/main/main.js'),
    ...list('src/main', /\.js$/).filter(f => !f.endsWith('main.js')),
    ...list('src/shared', /\.js$/),
    ...list('src/shared/formats', /\.js$/),
  ];
}

/* ---------- JS：簡單的 lexer，分得出註解、字串、template、regex ---------- */
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
/* tokens：{ t: 'id'|'str'|'tpl'|'re'|'p'|'num', v（id、p 的字）, raw, line, cjk（tpl 的文字部分有沒有中文）, subs（tpl 有沒有 ${}） } */
function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  const prevSig = () => toks[toks.length - 1];
  const regexOk = () => {
    const p = prevSig();
    if (!p) return true;
    if (p.t === 'p') return !/^[)\]]$/.test(p.v);
    if (p.t === 'id') return KEYWORDS_BEFORE_REGEX.has(p.v);
    return false;
  };
  function readTemplate() {   // i 在 ` 上；回傳 { raw, text（文字部分接起來）, subs }
    const start = i;
    let text = '', subs = false;
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        subs = true;
        i += 2;
        const inner = lexUntilBrace();
        toks.push(...inner);
        continue;
      }
      if (src[i] === '\n') line++;
      text += src[i++];
    }
    i++;
    return { raw: src.slice(start, i), text, subs };
  }
  function lexUntilBrace() {   // ${ … } 裡面：照一般程式 lex 到配對的 }
    const saved = toks.length;
    let depth = 0;
    const out = [];
    while (i < src.length) {
      if (src[i] === '}' && depth === 0) { i++; break; }
      const before = toks.length;
      step();
      for (const tk of toks.slice(before)) {
        if (tk.t === 'p' && tk.v === '{') depth++;
        if (tk.t === 'p' && tk.v === '}') depth--;
      }
    }
    out.push(...toks.splice(saved));
    return out;
  }
  function step() {
    const c = src[i];
    if (c === '\n') { line++; i++; return; }
    if (/\s/.test(c)) { i++; return; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; return; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      line += (src.slice(i, stop).match(/\n/g) || []).length;
      i = stop;
      return;
    }
    if (c === '\'' || c === '"') {
      const start = i, ln = line;
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++;
      toks.push({ t: 'str', raw: src.slice(start, i), line: ln });
      return;
    }
    if (c === '`') {
      const ln = line;
      const at = toks.length;
      const r = readTemplate();
      toks.splice(at, 0, { t: 'tpl', raw: r.raw, line: ln, cjk: NEEDS.test(r.text), subs: r.subs });
      return;
    }
    if (c === '/' && regexOk()) {
      const start = i, ln = line;
      let cls = false;
      i++;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        else if (d === '\n') break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] || '')) i++;
      toks.push({ t: 're', raw: src.slice(start, i), line: ln });
      return;
    }
    if (/[A-Za-z_$À-￿]/.test(c)) {
      const start = i;
      while (i < src.length && /[\w$À-￿]/.test(src[i])) i++;
      toks.push({ t: 'id', v: src.slice(start, i), line });
      return;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < src.length && /[\w.]/.test(src[i])) i++;
      toks.push({ t: 'num', v: src.slice(start, i), line });
      return;
    }
    toks.push({ t: 'p', v: c, line });
    i++;
  }
  while (i < src.length) step();
  return toks;
}
const ctx = vm.createContext({});
const literal = raw => vm.runInContext('(' + raw + ')', ctx);   // 只拿來算原始碼裡的字串字面值（跳脫字元照 JS 的）

/* 一個 JS 檔：L／LK 的 key（照出現順序）、還沒包的中文字串 */
function scanJs(file) {
  const src = fs.readFileSync(file, 'utf8');
  const toks = lex(src);
  const keys = [], loose = [], errors = [];
  const lines = src.split('\n');
  const skipLine = new Set();
  let inSkip = false;
  lines.forEach((ln, n) => {
    if (/不翻開始/.test(ln)) inSkip = true;
    if (inSkip || /不翻/.test(ln)) skipLine.add(n + 1);
    if (/不翻結束/.test(ln)) inSkip = false;
  });
  toks.forEach((tk, k) => {
    if (tk.t !== 'str' && tk.t !== 'tpl') return;
    const a = toks[k - 1], b = toks[k - 2];
    const isArg = a && a.t === 'p' && a.v === '(' && b && b.t === 'id' && (b.v === 'L' || b.v === 'LK') && !(toks[k - 3] && toks[k - 3].t === 'p' && toks[k - 3].v === '.');
    if (isArg) {
      if (tk.t === 'tpl' && tk.subs) { errors.push(`${rel(file)}:${tk.line} ${b.v}() 的原文不能用 \${}，改成 {名稱} 再傳 params`); return; }
      const v = literal(tk.raw);
      if (v !== v.trim()) errors.push(`${rel(file)}:${tk.line} ${b.v}() 的原文頭尾不要有空白：${JSON.stringify(v)}`);
      keys.push(v);
      return;
    }
    const hasCjk = tk.t === 'tpl' ? tk.cjk : NEEDS.test(tk.raw);
    if (hasCjk && !skipLine.has(tk.line)) loose.push({ line: tk.line, text: tk.raw.length > 90 ? tk.raw.slice(0, 90) + '…' : tk.raw });
  });
  return { keys, loose, errors };
}

/* ---------- HTML：照 DOM 的樣子切文字節點 ---------- */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'ellipse']);
const SKIP_TAGS = new Set(['script', 'style', 'code', 'kbd', 'pre', 'textarea']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', times: '×', hellip: '…', middot: '·', rarr: '→', larr: '←', uarr: '↑', darr: '↓' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] !== undefined ? ENT[e] : m;
});
function scanHtml(file) {
  const src = fs.readFileSync(file, 'utf8');
  const keys = [];
  const stack = [];   // { tag, skip（文字不算）, no（translate="no"，屬性也不算） }
  const top = () => stack[stack.length - 1] || { skip: false, no: false };
  let i = 0;
  const text = s => {
    if (!NEEDS.test(s) || top().skip) return;
    keys.push(norm(decode(s)));
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt) + 3; continue; }
    if (src.startsWith('<!', lt)) { i = src.indexOf('>', lt) + 1; continue; }
    const gt = src.indexOf('>', lt);
    const tagSrc = src.slice(lt + 1, gt);
    i = gt + 1;
    if (tagSrc[0] === '/') {
      const name = tagSrc.slice(1).trim().toLowerCase();
      while (stack.length && stack.pop().tag !== name) { /* 收到配對的那層 */ }
      continue;
    }
    const name = /^[\w-]+/.exec(tagSrc)[0].toLowerCase();
    const attrs = {};
    for (const m of tagSrc.slice(name.length).matchAll(/([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g)) {
      attrs[m[1].toLowerCase()] = decode(m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[2] || '');
    }
    const no = top().no || attrs.translate === 'no';
    if (!no) for (const a of ATTRS) if (attrs[a] && NEEDS.test(attrs[a])) keys.push(norm(attrs[a]));
    if (name === 'script' || name === 'style') {   // 裡面不是 HTML，直接跳到結束標籤
      i = src.toLowerCase().indexOf(`</${name}`, i);
      i = src.indexOf('>', i) + 1;
      continue;
    }
    if (VOID.has(name) || tagSrc.trimEnd().endsWith('/')) continue;
    stack.push({ tag: name, skip: top().skip || SKIP_TAGS.has(name) || no, no });
  }
  return { keys, loose: [], errors: [] };
}

/* 全部收起來：{ keys: { 檔: [原文…] }（同一句只算第一次出現的檔）, loose: { 檔: [{ line, text }] }, errors: [] } */
function collect(files = sourceFiles()) {
  const seen = new Set();
  const keys = {}, loose = {}, errors = [];
  for (const f of files) {
    const r = f.endsWith('.html') ? scanHtml(f) : scanJs(f);
    errors.push(...r.errors);
    const mine = r.keys.filter(k => !seen.has(k) && seen.add(k));
    if (mine.length) keys[rel(f)] = mine;
    if (r.loose.length) loose[rel(f)] = r.loose;
  }
  // 給 AI 的代號（md5 前 6 碼，見 main/locales.js）不能撞
  const ids = new Map();
  for (const k of seen) {
    const id = crypto.createHash('md5').update(k).digest('hex').slice(0, 6);
    if (ids.has(id)) errors.push(`代號 ${id} 撞了：${JSON.stringify(ids.get(id))}、${JSON.stringify(k)}（改一下其中一句的字）`);
    ids.set(id, k);
  }
  return { keys, loose, errors };
}

const stringify = keys => JSON.stringify(keys, null, 1) + '\n';
/* 硬碟上的 i18n-keys.json 是不是跟現在收到的一樣。換行先統一：git 的 autocrlf 在別的 clone checkout 出來會是 CRLF */
const isCurrent = keys => fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') === stringify(keys);

module.exports = { collect, lex, scanJs, scanHtml, stringify, isCurrent, OUT };

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--audit') {
      const files = args.slice(1).length ? args.slice(1).map(f => path.resolve(f)) : sourceFiles();
      const { loose, errors } = collect(files);
      for (const [f, list] of Object.entries(loose)) {
        console.log(`${f}（${list.length}）`);
        for (const x of list) console.log(`  ${x.line}: ${x.text}`);
      }
      if (errors.length) console.log(errors.join('\n'));
      if (!Object.keys(loose).length && !errors.length) console.log('沒有還沒包 L() 的中文字串');
    } else {
      const { keys, errors } = collect();
      if (errors.length) throw new Error(errors.join('\n'));
      const out = stringify(keys);
      const n = Object.values(keys).reduce((a, l) => a + l.length, 0);
      if (args[0] === '--check') {
        if (!isCurrent(keys)) throw new Error('i18n-keys.json 不是最新的：跑 node tools/i18n-keys.cjs');
        console.log(`i18n-keys.json 是最新的（${n} 條）`);
      } else {
        fs.writeFileSync(OUT, out);
        console.log(`寫好 ${rel(OUT)}：${n} 條，${Object.keys(keys).length} 個檔`);
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
