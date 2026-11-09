/* ============================================================
   記事本、文件檢視的頁籤共用（見 開發筆記 D184）：頁籤的樣子、預覽（D116）、關掉後換到哪份（D120）、
   右鍵選單（D120）、按鍵、Ctrl+Tab 清單、重開剛關掉的、中鍵、拖拉（D160）。照 VS Code。
   w 是 'note' 或 'md'；兩邊不一樣的地方是 app.js 叫 setupTabs 時給的 TAB_SIDES.note、TAB_SIDES.md（欄位見 setupTabs）。
   叫的時候才用到 app.js 的 $、el、button、act、toast、api、isEnter 和 menu.js。畫面用 <script> 載入，排在 app.js 前面
   ============================================================ */
'use strict';

let TAB_SIDES = null;   // { note, md }：兩邊不一樣的地方（setupTabs 給）
let tabWhich = null, tabBlocked = null;   // 現在開著的是哪一邊（都不是回 null）；在問存不存、頁籤改名中（按鍵攔下來、不做）

/* 一個頁籤（D116、D118）：名稱（點了換過去）＋開著好幾份同名的時後面淡淡寫在哪個資料夾（hint，null 是不寫）＋×。
   on 正在看的、dirty 改過沒存（●）、preview 預覽（斜體）；dbl(tab) 點兩下；拖得動（D160） */
function tabEl({ key, name, on, dirty, preview, hint, title, open, dbl, close, closeTitle }) {
  const tab = el('div', 'noteTab' + (on ? ' on' : '') + (dirty ? ' dirty' : '') + (preview ? ' preview' : ''));
  tab.dataset.key = key;
  tab.draggable = true;   // 拖頁籤調順序（D160）
  const nm = button('noteName', name, open);
  if (hint != null) nm.append(el('span', 'noteDirHint', hint));
  nm.title = title;
  nm.addEventListener('dblclick', () => dbl(tab));
  const del = button('noteDel', '×', close);
  del.title = closeTitle;
  tab.append(nm, del);
  return tab;
}

/* 換到 k 之前排好頁籤（D116）：pad 是 notePad／mdPad（用到 open、preview）。
   from：'list' 清單上點一下，還沒開的開成預覽（有預覽的就換掉它、放在它的位置）；'pin' 點兩下，還沒開的開成一般的、預覽的留下來。沒給是點頁籤 */
function tabPlace(pad, k, from) {
  if (from && !pad.open.includes(k)) {
    const i = from === 'list' ? pad.open.indexOf(pad.preview) : -1;
    if (i >= 0) pad.open[i] = k; else pad.open.push(k);
    if (from === 'list') pad.preview = k;
  } else if (from === 'pin' && pad.preview === k) pad.preview = null;
}
/* 關掉 keys 時，正在看的 cur 也在裡面：換到右邊那份，沒有就左邊那份（都關了是 null，D120）；cur 沒被關掉回 undefined（不用換） */
function tabNext(open, cur, keys) {
  const i = cur == null ? -1 : open.indexOf(cur);
  if (i < 0 || !keys.includes(open[i])) return undefined;
  return [...open.slice(i + 1), ...open.slice(0, i).reverse()].find(k => !keys.includes(k)) || null;
}
/* 頁籤拿掉 keys；預覽的被拿掉就沒有預覽 */
function tabForget(pad, keys) {
  pad.open = pad.open.filter(k => !keys.includes(k));
  if (keys.includes(pad.preview)) pad.preview = null;
}

/* ---------- 頁籤的按鍵、拖拉（見 開發筆記 D160）----------
   Ctrl+W、中鍵點頁籤：關掉（跟 × 一樣，改過沒存的先問）。Ctrl+PageDown／PageUp：右邊／左邊那個（到頭繞回來）。
   Ctrl+Tab／Ctrl+Shift+Tab：照最近看過的順序（tabMru），按住 Ctrl 跳出清單（#tabSwitch），放開 Ctrl 換過去。
   Ctrl+Shift+T：重開剛關掉的（tabClosed，放回原本的位置；新記事、檔案不見了的跳過；只記這次開著 daybook 的）。拖頁籤調順序。
   一定要攔下來（preventDefault）：Electron 預設選單的 Ctrl+W 是關掉整個視窗。游標在 .html 裡按的，網頁裡的監聽（DOC_HOOKS）攔下來轉過來 */
const tabMru = { note: [], md: [] };      // 最近看過的在前面（記事本是 noteKey、文件檢視是完整路徑）；畫的時候（refreshNotes、mdRender）把正在看的放最前面
const tabClosed = { note: [], md: [] };   // 剛關掉的 { key, at（原本第幾個）}，最後關的在最後面，最多記 30 個
function tabTouch(w, k) {
  if (!k) return;
  const m = tabMru[w], i = m.indexOf(k);
  if (i >= 0) m.splice(i, 1);
  m.unshift(k);
}
// 記下使用者關掉的（×、Ctrl+W、中鍵、右鍵）。一次關好幾個時從右邊的先記：重開時從左邊的一個一個放回去，位置才對
function tabRemember(w, keys) {
  const T = TAB_SIDES[w], open = T.open(), list = tabClosed[w];
  list.push(...keys.map(key => ({ key, at: open.indexOf(key) })).filter(x => x.at >= 0 && T.reopenable(x.key)).sort((a, b) => b.at - a.at));
  if (list.length > 30) list.splice(0, list.length - 30);
}
function tabReopen(w) {
  const T = TAB_SIDES[w], open = T.open();
  for (let e = tabClosed[w].pop(); e; e = tabClosed[w].pop()) {
    if (open.includes(e.key) || !T.exists(e.key)) continue;   // 已經開著、檔案不見了：跳過，重開再前一個
    open.splice(Math.min(e.at, open.length), 0, e.key);
    T.go(e.key);
    return;
  }
}
/* Ctrl+Tab 的清單：照最近看過的列開著的（正在看的在最前面），一按就選到第二個（Ctrl+Shift+Tab 是最後一個）；焦點搬到清單上，放開 Ctrl 的 keyup 才收得到 */
let tabSw = null;   // 清單開著時：{ w, keys, at（選到第幾個）}
function tabSwitch(w, d) {
  if (!tabSw) {
    const open = TAB_SIDES[w].open(), keys = [...tabMru[w].filter(k => open.includes(k)), ...open.filter(k => !tabMru[w].includes(k))];
    if (keys.length < 2) return;
    tabSw = { w, keys, at: 0 };
  }
  const T = TAB_SIDES[tabSw.w], n = tabSw.keys.length, m = $('tabSwitch');
  tabSw.at = (tabSw.at + d + n) % n;
  m.replaceChildren(...tabSw.keys.map((k, i) => {
    const it = el('div', 'tsItem' + (i === tabSw.at ? ' on' : ''), T.name(k));
    it.setAttribute('role', 'option');
    it.setAttribute('aria-selected', String(i === tabSw.at));
    const dir = T.dir(k);
    if (dir) it.append(el('span', 'noteDirHint', dir));
    return it;
  }));
  if (m.hidden) {
    m.hidden = false;
    const r = $(T.bar).getBoundingClientRect();
    m.style.left = Math.max(4, r.left + (r.width - m.offsetWidth) / 2) + 'px';
    m.style.top = r.bottom + 4 + 'px';
    m.focus();
  }
  m.children[tabSw.at].scrollIntoView({ block: 'nearest' });
}
// 收起清單：go 是換到選到的那個（選到的是正在看的就不換），不換就游標回內容
function tabSwitchEnd(go) {
  if (!tabSw) return;
  const { w, keys, at } = tabSw;
  tabSw = null;
  $('tabSwitch').hidden = true;
  if (go && at > 0) TAB_SIDES[w].go(keys[at]); else TAB_SIDES[w].back();
}
/* 頁籤的按鍵：記事本、文件檢視開著、按著 Ctrl 時。key、shift 是按的鍵（網頁裡按的由 postMessage 帶過來）。是頁籤的鍵就回 true，呼叫的那邊攔下來 */
function tabKey(key, shift) {
  const w = tabWhich();
  const k = key.length === 1 ? key.toLowerCase() : key;
  const what = k === 'w' && !shift ? 'close' : k === 't' && shift ? 'reopen' : k === 'Tab' ? 'switch' : !shift && (k === 'PageDown' || k === 'PageUp') ? 'step' : null;
  if (!w || !what) return false;
  if (tabBlocked()) return true;   // 在問存不存、頁籤改名中：攔下來、不做
  const T = TAB_SIDES[w], open = T.open(), cur = T.cur();
  if (what === 'close') { if (cur) T.closeOne(cur, true); }
  else if (what === 'reopen') tabReopen(w);
  else if (what === 'switch') tabSwitch(w, shift ? -1 : 1);
  else if (open.length > 1) T.go(open[(open.indexOf(cur) + (k === 'PageDown' ? 1 : -1) + open.length) % open.length]);
  return true;
}
/* 中鍵點頁籤：關掉（跟 × 一樣）。拖頁籤：放在哪個頁籤的左半邊就插在它前面、右半邊就插在後面（只在同一排裡搬） */
let tabDrag = null;   // 拖著的頁籤 { w, key }
const tabAfter = (tab, e) => { const r = tab.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
function tabDropMark(tab, after) {
  for (const t of document.querySelectorAll('.noteTab.dropL, .noteTab.dropR')) t.classList.remove('dropL', 'dropR');
  if (tab) tab.classList.add(after ? 'dropR' : 'dropL');
}

/* ---------- 頁籤的右鍵選單（見 開發筆記 D120）：照 VS Code ----------
   按右鍵的那個頁籤不會換成正在看的（照 VS Code）。關閉跟 × 一樣；關閉其他、關閉右側、全部關閉在記事本碰到改過沒存的，一次問（noteAsk 的 { close }）。
   在檔案總管中顯示、複製路徑：還沒存的新記事、檔案在外面不見了的記事沒有路徑，那兩項藏起來；沒有可以關的那項淡色點不了 */
let tabMenuAt = null;   // { w, key }：按右鍵的是哪一邊的哪個頁籤（文件檢視是完整路徑、記事本是 noteKey）
let tabMenu = null;   // makeMenu 回的（setupTabs 建）；Esc 收在 app.js 的 escLayers

/* 兩邊不一樣的地方（TAB_SIDES.note、TAB_SIDES.md），每一邊：
   strip：頁籤列的 id；bar：Ctrl+Tab 清單擺在它底下正中間；open()：開著的（照頁籤順序，拿到的就是那一份、搬順序直接改它）；cur()：正在看的
   go(k)：換過去、游標進內容；back()：游標回內容；closeOne(k, focus)：關一個，跟 × 一樣（focus：關完游標回內容）；closeMany(keys)：右鍵一次關好幾個
   busy()：改名中（不出選單、中鍵不關、不能拖）；reopenable(k)：關掉時記不記（新記事不記）；exists(k)：檔案還在（重開用）
   name(k)、dir(k)：Ctrl+Tab 清單寫的名稱、後面淡淡寫的資料夾；redraw()：拖完記下順序、重畫頁籤
   右鍵選單：noPath(k)（沒有路徑：藏在檔案總管中顯示、複製路徑）、html(k)（多「用瀏覽器開」）、browser(k)、reveal(k)、path(k)（回路徑，可以是 Promise）
   which()：現在開著的是哪一邊（都不是回 null）；blocked()：在問存不存、頁籤改名中 */
function setupTabs({ note, md, which, blocked }) {
  TAB_SIDES = { note, md };
  tabWhich = which;
  tabBlocked = blocked;
  tabMenu = makeMenu('tabMenu', {
    show(m, x, y) {
      const { w, key } = tabMenuAt, T = TAB_SIDES[w], keys = T.open();
      m.querySelector('[data-act="others"]').disabled = keys.length < 2;
      m.querySelector('[data-act="right"]').disabled = keys.indexOf(key) === keys.length - 1;
      m.querySelector('.tmPath').hidden = T.noPath(key);
      m.querySelector('[data-act="browser"]').hidden = !T.html(key);   // 用瀏覽器開：只有 .html（D122）
      placeMenu(m, x, y);
    },
    // 選單收起來之後游標回到那一邊的內容（Esc、複製路徑、在檔案總管中顯示）；文件檢視照 mdBack，.html 回正在看的 iframe（#mdView 那時藏著，見 開發筆記 D120〈後續〉）
    back: () => TAB_SIDES[tabMenuAt.w].back(),
    pick(what) {
      const { w, key } = tabMenuAt, T = TAB_SIDES[w], keys = T.open(), i = keys.indexOf(key);
      if (i < 0) return;   // 選單開著時那個頁籤已經關掉了（外面刪了檔）
      if (what === 'close') { T.closeOne(key, true); return; }
      const which = what === 'others' ? keys.filter(k => k !== key) : what === 'right' ? keys.slice(i + 1) : what === 'all' ? [...keys] : null;
      if (which) { T.closeMany(which); return; }
      act(async () => {
        if (what === 'browser') await T.browser(key);
        else if (what === 'reveal') await T.reveal(key);
        else { await api.copyText(await T.path(key)); toast(L('已複製路徑')); }
        TAB_SIDES[tabMenuAt.w].back();
      });
    },
  });
  for (const w of ['note', 'md']) {
    $(TAB_SIDES[w].strip).addEventListener('contextmenu', e => {
      e.preventDefault();
      const tab = e.target.closest('.noteTab');
      if (!tab || TAB_SIDES[w].busy()) return;   // 頁籤上的空白、改名中不出選單
      tabMenuAt = { w, key: tab.dataset.key };
      tabMenu.open(...menuXY(e, tab));   // 鍵盤叫出來的：放在頁籤底下
    });
  }
  $('tabSwitch').addEventListener('keydown', e => {
    if (!tabSw) return;
    e.preventDefault();
    e.stopPropagation();   // 畫面那邊的快捷鍵不要再跑
    if (e.key === 'Tab') tabSwitch(tabSw.w, e.shiftKey ? -1 : 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') tabSwitch(tabSw.w, e.key === 'ArrowDown' ? 1 : -1);
    else if (isEnter(e)) tabSwitchEnd(true);
    else if (e.key === 'Escape') tabSwitchEnd(false);
  });
  $('tabSwitch').addEventListener('keyup', e => { if (e.key === 'Control') tabSwitchEnd(true); });
  $('tabSwitch').addEventListener('focusout', e => { if (!$('tabSwitch').contains(e.relatedTarget)) tabSwitchEnd(false); });   // 點了別的地方、視窗沒焦點：不換
  $('tabSwitch').addEventListener('click', e => {
    const it = e.target.closest('.tsItem');
    if (!it || !tabSw) return;
    tabSw.at = [...$('tabSwitch').children].indexOf(it);
    tabSwitchEnd(true);
  });
  for (const w of ['note', 'md']) {
    const T = TAB_SIDES[w], bar = $(T.strip);
    // 中鍵按下去的預設動作攔掉：不攔的話記事本的頁籤收不到 auxclick（mousedown、mouseup 都在同一個元素、中間沒重畫，文件檢視的卻收得到；原因沒查到，D160）
    bar.addEventListener('mousedown', e => { if (e.button === 1 && e.target.closest('.noteTab')) e.preventDefault(); });
    bar.addEventListener('auxclick', e => {
      const tab = e.button === 1 && e.target.closest('.noteTab');
      if (!tab || T.busy()) return;
      e.preventDefault();
      T.closeOne(tab.dataset.key, false);
    });
    bar.addEventListener('dragstart', e => {
      const tab = e.target.closest('.noteTab');
      if (!tab || T.busy()) { e.preventDefault(); return; }
      tabDrag = { w, key: tab.dataset.key };
      e.dataTransfer.effectAllowed = 'move';
    });
    bar.addEventListener('dragover', e => {
      const tab = e.target.closest('.noteTab');
      if (!tabDrag || tabDrag.w !== w || !tab) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tabDropMark(tab, tabAfter(tab, e));
    });
    bar.addEventListener('dragleave', e => { if (!bar.contains(e.relatedTarget)) tabDropMark(null); });
    bar.addEventListener('drop', e => {
      const tab = e.target.closest('.noteTab'), d = tabDrag;
      tabDropMark(null);
      if (!d || d.w !== w || !tab) return;
      e.preventDefault();
      const open = T.open(), from = open.indexOf(d.key);
      if (from < 0 || tab.dataset.key === d.key) return;
      const after = tabAfter(tab, e);
      open.splice(from, 1);
      open.splice(open.indexOf(tab.dataset.key) + (after ? 1 : 0), 0, d.key);
      T.redraw();
    });
    bar.addEventListener('dragend', () => { tabDrag = null; tabDropMark(null); });
  }
}
