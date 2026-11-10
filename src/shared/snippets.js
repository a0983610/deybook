/* ============================================================
   剪貼簿（見 開發筆記 D093；原本叫「暫存」，D096）：對 剪貼簿.md 的文字做加／改／刪／搬一筆（搬 D125），
   加／改名／刪分類（D195），純函式、不碰檔案。
   寫法照紀錄：沒縮排的行是標題，Tab 縮排的行是內文（點卡片複製的就是內文）；「# 名稱」那行是分類，底下到下一個分類的都屬於它，
   第一個分類前面的是沒分類的（D195）。
   跟紀錄不一樣的地方——內文要原封不動複製出去，所以不沿用 parser.js：
   - 標題整行就是標題，行尾的 [待回覆]、^編號 這些不拆；連續兩行標題各是一筆
   - 內文的空行留著（寫成只有一個 Tab 的行），頭尾的空白、空行也留著（D127）
   每個改動都帶 index（第幾筆）和 expected（那一筆原本的原文），對不上就報錯不寫（同 entries.js）；分類也是（第幾個＋那一行）。
   ============================================================ */
'use strict';
const { Conflict } = require('./entries.js');
const { L } = require('./i18n.js');

const CAT_RE = /^#[ \t]+(\S.*)$/;   // 分類那行：# 開頭、空白、名稱（D195）；「#123」「## 」不算，照舊是標題

/* 一行一行讀：Tab（或空白）開頭是內文，去掉一層縮排（Tab 或最多 4 個空白，同 entries.js）；
   空行先記著，後面還有同一筆的內文才算內文裡的空行；第一個標題前面的內文掛在一筆沒標題的上面，不丟。
   「# 名稱」是分類（D195）：之後的每一筆 cat 是它的第幾個（-1 是第一個分類前面、沒分類的）；分類後面直接接內文的也掛在一筆沒標題的上面 */
function parse(lines) {
  const snips = [], cats = [];
  let cur = null, blanks = 0;
  lines.forEach((text, line) => {
    if (text === '') { blanks++; return; }
    const m = CAT_RE.exec(text);
    if (m) {
      cats.push({ name: m[1].trim(), line });
      cur = null;
    } else if (/^[\t ]/.test(text)) {
      if (!cur) { cur = { title: '', body: [], start: line, end: line, cat: cats.length - 1 }; snips.push(cur); }
      else if (cur.body.length) for (; blanks; blanks--) cur.body.push('');
      cur.body.push(text.replace(/^(\t| {1,4})/, ''));
      cur.end = line;
    } else {
      cur = { title: text.trim(), body: [], start: line, end: line, cat: cats.length - 1 };
      snips.push(cur);
    }
    blanks = 0;
  });
  return { snips, cats };
}

const rawOf = (lines, s) => lines.slice(s.start, s.end + 1).join('\n');

/* 每一筆給畫面用的樣子：原文（之後改動時當 expected）、標題、內文（一行一個）、第幾個分類（-1 沒分類） */
function listSnips(text) {
  const lines = text.split(/\r?\n/);
  return parse(lines).snips.map((s, index) => ({ index, raw: rawOf(lines, s), title: s.title, body: s.body, cat: s.cat }));
}

/* 分類（D195）：名稱、那一行的原文（之後改名、刪、放進去時當 expected） */
function listSnipCats(text) {
  const lines = text.split(/\r?\n/);
  return parse(lines).cats.map((c, index) => ({ index, name: c.name, raw: lines[c.line] }));
}

/* 一筆 → 行。標題只能一行、去掉頭尾空白；內文原封不動（見 開發筆記 D127；原本會拿掉頭尾的空行、結尾的空白，D093）：
   每行前面加一個 Tab，空行寫成只有 Tab——頭尾的空行、最後的換行也是，讀回來（parse）才分得出來。整段都是空白才報錯。
   標題是「# 名稱」的樣子會被讀成分類（D195），不給存 */
function formatSnip(snip) {
  const title = String(snip.title || '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) throw new Error(L('標題不能空白'));
  if (CAT_RE.test(title)) throw new Error(L('標題不能用「# 」開頭（那是分類的寫法）'));
  const body = String(snip.body || '').replace(/\r\n?/g, '\n');
  if (!body.trim()) throw new Error(L('內文不能空白（要複製的就是內文）'));
  return [title, ...body.split('\n').map(l => '\t' + l)];
}

function locate(text, index, expected) {
  const lines = text.split(/\r?\n/);
  const s = parse(lines).snips[index];
  if (!s || rawOf(lines, s) !== expected) throw new Conflict(L('剪貼簿的這一筆在別的地方被改過了，請再操作一次'));
  return { lines, s };
}

/* 要放進第 cat 個分類（-1 是沒分類那段，不用對）：那一行要是 expected，不然丟 Conflict（D195） */
function checkCat(lines, all, cat, expected) {
  if (cat === -1) return;
  const c = all.cats[cat];
  if (!c || lines[c.line] !== expected) throw new Conflict(L('剪貼簿的這個分類在別的地方被改過了，請再操作一次'));
}

/* 第 cat 個分類那段的最後面（D195）：最後一筆的下一行；還沒有卡片就是分類那行的下一行（沒分類那段是第 0 行） */
function endOf(all, cat) {
  const last = all.snips.filter(s => s.cat === cat).pop();
  return last ? last.end + 1 : cat >= 0 ? all.cats[cat].line + 1 : 0;
}

/* 把 add 插在第 at 行前面。後面只剩空行（插在檔案最後面）就照 D126：結尾的空行收掉、接上去、補一個換行 */
function insertLines(lines, at, add) {
  if (lines.slice(at).some(l => l !== '')) { lines.splice(at, 0, ...add); return lines.join('\n'); }
  const head = lines.slice(0, at).join('\n').replace(/\n+$/, '');
  return (head ? head + '\n' : '') + add.join('\n') + '\n';
}

/* 新的放那一段的最後面（見 開發筆記 D126；原本放最前面，D093）：to 是 { cat, raw }（D195，沒給是沒分類那段）；
   沒有分類時就是接在檔案最後一行後面，原本的一個字都不動 */
function addSnip(text, snip, to = { cat: -1 }) {
  const add = formatSnip(snip);
  const lines = text.split(/\r?\n/);
  const all = parse(lines);
  checkCat(lines, all, to.cat, to.raw);
  return insertLines(lines, endOf(all, to.cat), add);
}

function editSnip(text, index, expected, snip) {
  const { lines, s } = locate(text, index, expected);
  lines.splice(s.start, s.end - s.start + 1, ...formatSnip(snip));
  return lines.join('\n');
}

function deleteSnip(text, index, expected) {
  const { lines, s } = locate(text, index, expected);
  lines.splice(s.start, s.end - s.start + 1);
  return lines.join('\n');
}

/* 搬一筆（見 開發筆記 D125）：第 index 筆搬到 to = { cat, raw, at }——第 cat 個分類（-1 沒分類）的第 at 張（搬完以後；跨分類 D195）。
   只搬那一筆的行，筆跟筆中間的空行留在原地。
   一段最前面沒標題的那筆（外面改的）不能搬、別筆也不能搬到它前面：它只有內文，搬了會接到別筆底下 */
function moveSnip(text, index, expected, to) {
  const { lines, s } = locate(text, index, expected);
  const { cat, raw, at } = to || {};
  checkCat(lines, parse(lines), cat, raw);
  if (!s.title) throw new Error(L('最前面那筆沒有標題，它和它前面都不能搬；先編輯補上標題'));
  const cut = lines.splice(s.start, s.end - s.start + 1);
  const rest = parse(lines);   // 分類那幾行沒動，第幾個分類照舊
  const mine = rest.snips.filter(x => x.cat === cat);
  if (!Number.isInteger(at) || at < 0 || at > mine.length) throw new Error(L('剪貼簿沒有那個位置，請再操作一次'));
  if (mine[at] && !mine[at].title) throw new Error(L('最前面那筆沒有標題，它和它前面都不能搬；先編輯補上標題'));
  lines.splice(mine[at] ? mine[at].start : endOf(rest, cat), 0, ...cut);
  return lines.join('\n');
}

/* ---------- 分類（D195）：「# 名稱」一行。名稱一行、去頭尾空白，不能空白、不能跟別的分類同名（收起來是照名稱記的） ---------- */
function catLine(all, name, self) {
  const n = String(name || '').replace(/[\r\n]+/g, ' ').trim();
  if (!n) throw new Error(L('分類名稱不能空白'));
  if (all.cats.some((c, i) => i !== self && c.name === n)) throw new Error(L('已經有「{name}」這個分類', { name: n }));
  return '# ' + n;
}

function locateCat(text, index, expected) {
  const lines = text.split(/\r?\n/);
  const all = parse(lines);
  if (!Number.isInteger(index) || index < 0) throw new Conflict(L('剪貼簿的這個分類在別的地方被改過了，請再操作一次'));
  checkCat(lines, all, index, expected);
  return { lines, all, c: all.cats[index] };
}

/* 新的分類放在檔案最後面（底下還沒有卡片） */
function addSnipCat(text, name) {
  const lines = text.split(/\r?\n/);
  return insertLines(lines, lines.length, [catLine(parse(lines), name, -1)]);
}

function renameSnipCat(text, index, expected, name) {
  const { lines, all, c } = locateCat(text, index, expected);
  lines[c.line] = catLine(all, name, index);
  return lines.join('\n');
}

/* 刪分類：卡片留著，整段（分類那行到最後一張，中間的空行跟著）搬到最上面沒分類那段的最後面，分類那行拿掉。
   最前面是沒標題的那筆（外面改的）不刪：它只有內文，搬過去會接到別筆底下 */
function deleteSnipCat(text, index, expected) {
  const { lines, all, c } = locateCat(text, index, expected);
  const mine = all.snips.filter(s => s.cat === index);
  if (mine[0] && !mine[0].title) throw new Error(L('這個分類最前面那筆沒有標題，先編輯補上標題再刪分類'));
  const block = lines.splice(c.line, (mine.length ? mine[mine.length - 1].end : c.line) - c.line + 1);
  block.shift();   // 分類那行
  while (block[0] === '') block.shift();   // 分類那行跟第一張中間的空行不帶過去
  if (!block.length) return lines.join('\n');
  return insertLines(lines, endOf(parse(lines), -1), block);
}

module.exports = { listSnips, listSnipCats, formatSnip, addSnip, editSnip, deleteSnip, moveSnip, addSnipCat, renameSnipCat, deleteSnipCat };
