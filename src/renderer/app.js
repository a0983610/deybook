/* ============================================================
   daybook 畫面：左邊搜尋＋日期清單；中間上面「這一天已處理」、下面「待處理」（見 開發筆記 D024），
   搜尋／時間軸時中間換成結果。卡片見 D021、D022；搜尋與時間軸見 D023；文字模式見 D020；
   標題、搜尋的自動補完見 D031、D032；換日快捷鍵見 D033；黑暗模式見 D034；匯出見 D035；
   日曆見 D036；狀態列、F1 快捷鍵表見 D037；日期清單 ↑↓ 換日、每週底色見 D070、D071；標記見 D072；回顧見 D087；
   左欄的剪貼簿見 D093（原本叫暫存，D096）；記事本（中間換成記事本）見 D102。
   檔案一律透過 window.daybook（preload）讀寫。
   ============================================================ */
'use strict';
const api = window.daybook;
const $ = id => document.getElementById(id);
const WEEK = '日一二三四五六';

const st = {
  info: null,
  day: null,          // 正在看（或最後看）的那一天
  view: 'day',        // day | search | timeline | flagged（標記清單，見 開發筆記 D072）| range（回顧，D087）
  flagFilter: '全部', // 標記清單篩哪個分類：'全部'、'未分類' 或分類名稱（見 開發筆記 D076）
  range: null,        // 回顧的起訖 { from, to }（見 開發筆記 D087）
  q: '',              // 搜尋字
  by: null,           // 時間軸：{ code } 或 { event }
  focus: null,        // 打開那天之後要捲到第幾筆
  showHidden: false,  // 待處理底下「已隱藏」有沒有展開（見 開發筆記 D026）
  counts: { done: null, todo: null },   // 標題列寫的筆數（文字模式不算）
  // 已處理、待處理有沒有縮起來，記在這台電腦（見 開發筆記 D027）
  collapsed: (() => { try { return JSON.parse(localStorage.getItem('daybook.collapsed')) || {}; } catch { return {}; } })(),
  mode: (() => { try { return localStorage.getItem('daybook.mode') === 'text' ? 'text' : 'cards'; } catch { return 'cards'; } })(),
  // 日期區用清單還是日曆，記在這台電腦；日曆正在看哪個月（見 開發筆記 D036）
  dayView: (() => { try { return localStorage.getItem('daybook.dayView') === 'cal' ? 'cal' : 'list'; } catch { return 'list'; } })(),
  calMonth: null,     // 'YYYY-MM'
};

/* ---------- 小工具 ---------- */
function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()];
}
const shortDate = d => `${d.slice(5)}（${weekday(d)}）`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(cls, text, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

let toastTimer = null;
function toast(msg, isErr, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || (isErr ? 5000 : 2500));
}
// 主程序丟回來的錯誤長這樣：Error invoking remote method 'card:edit': Error: 這一筆…
const errMsg = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (?:\w+: )?/, '');

/* 寫檔的動作都包在這裡：失敗就跳提示，並重新整理（可能是檔案在外面被改過） */
async function act(fn) {
  try { return await fn(); } catch (e) { toast(errMsg(e), true); await refreshAll(); }
}

/* Tab 鍵插入 Tab 字元，不跳到下一個欄位（Ctrl+Z 復原得了） */
function tabInsert(area) {
  area.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    document.execCommand('insertText', false, '\t');
  });
}

/* Enter（不在輸入法選字中） */
const isEnter = e => e.key === 'Enter' && !e.isComposing;

/* ---------- 文字模式（見 開發筆記 D020）：停手 600ms 自動存檔 ---------- */
function showSave(text) { $('saveState').textContent = text; }
/* show：存檔狀態寫在哪，記事本有自己的（D102） */
function autosave(area, save, show = showSave) {
  const s = { dirty: false, timer: null };
  s.flush = async () => {
    clearTimeout(s.timer);
    if (!s.dirty) return;
    s.dirty = false;
    show('存檔中…');
    await save(area.value);
    show(s.dirty ? '未存檔' : '已存檔');
  };
  area.addEventListener('input', () => {
    s.dirty = true;
    show('未存檔');
    clearTimeout(s.timer);
    s.timer = setTimeout(s.flush, 600);
  });
  area.addEventListener('blur', s.flush);
  return s;
}
const editorSave = autosave($('editor'), text => api.writeDay(st.day, text));
const todoSave = autosave($('todo'), text => api.writeTodo(text));
tabInsert($('editor'));
tabInsert($('todo'));
const flushText = async () => { await editorSave.flush(); await todoSave.flush(); };

/* ---------- 卡片（見 開發筆記 D021、D024、D025） ---------- */
/* 待處理的卡片：「待回覆」一鍵切換（不用下拉選單，見 開發筆記 D025） */
function waitToggle(c, src) {
  const on = c.status === '待回覆';
  const b = button('wait' + (on ? ' on' : ''), '待回覆', () => act(async () => {
    await api.setStatus(src, c.index, c.raw, on ? null : '待回覆');
    await refreshAll();
  }));
  b.title = on ? '點一下取消待回覆' : '點一下標成待回覆（在等別人）';
  return b;
}

/* 已處理的卡片：「標記」還要注意、還沒完的事（見 開發筆記 D072）；左邊「標記」列出全部。
   點了底下冒出一排分類鈕（pick），點一個就標上；標過的再點可以換分類、取消標記（D076；不用下拉，D025） */
const flagLabel = c => (c.flagCat ? '標記·' + c.flagCat : '標記');
function flagToggle(c, src, pick) {
  const b = button('flag' + (c.flagged ? ' on' : ''), c.flagged ? flagLabel(c) : '標記', () => {
    pick.hidden = !pick.hidden;
    if (!pick.hidden) act(() => fillFlagPick(pick, c, src));
  });
  b.title = c.flagged ? '點一下換分類或取消標記（這件事完了）' : '點一下選分類標記：還要注意、還沒完（左邊「標記」列出全部）';
  return b;
}

/* 分類鈕：未分類、自訂的（照清單順序）、＋ 新分類；最後是「取消標記」（標過的）或「取消」（收起來） */
async function fillFlagPick(box, c, src) {
  const cats = await api.flagCats();
  box.textContent = '';
  const opt = (name, cat) => {
    const on = c.flagged && c.flagCat === cat;
    return button('cat' + (on ? ' on' : ''), name, () => {
      if (on) { box.hidden = true; return; }
      act(async () => {
        await api.setFlag(src, c.index, c.raw, true, cat);
        await refreshAll();
      });
    });
  };
  box.appendChild(opt('未分類', null));
  for (const cat of cats) box.appendChild(opt(cat, cat));
  // ＋ 新分類：換成輸入框，Enter 加進分類清單並標上；名稱不行就提示、打的字留著
  const add = button('cat-add', '＋ 新分類', () => {
    const input = el('input', 'cat-new');
    input.placeholder = '新分類（Enter 加上並標記）';
    input.addEventListener('keydown', async e => {
      if (e.key === 'Escape') { input.replaceWith(add); add.focus(); return; }
      if (!isEnter(e)) return;
      e.preventDefault();
      let cat;
      try { cat = await api.addFlagCat(input.value); } catch (err) { toast(errMsg(err), true); return; }
      act(async () => {
        await api.setFlag(src, c.index, c.raw, true, cat);
        await refreshAll();
      });
    });
    add.replaceWith(input);
    input.focus();
  });
  box.appendChild(add);
  box.appendChild(c.flagged
    ? button('unflag', '取消標記', () => act(async () => {
      await api.setFlag(src, c.index, c.raw, false);
      await refreshAll();
    }))
    : button('cancel', '取消', () => { box.hidden = true; }));
}

function chips(c) {
  const box = el('div', 'chips');
  for (const code of c.codes || []) box.appendChild(button('chip code', code, () => showTimeline({ code })));
  if (c.event != null) {
    const b = button('chip event', '^' + c.event, () => showTimeline({ event: c.event }));
    b.title = '這件事每一天的紀錄';
    box.appendChild(b);
  }
  return box;
}

/* 一張卡片。editable：能改（某一天的已處理、待處理）；否則是搜尋／時間軸／標記清單裡唯讀的，前面標日期。
   unflag：標記清單裡的，底下有「取消標記」（見 開發筆記 D072） */
function card(c, { src, editable, showSrc, unflag }) {
  const box = el('div', 'card');
  box.dataset.src = src;
  box.dataset.index = c.index;

  const head = el('div', 'card-head');
  if (showSrc) {
    head.appendChild(src === 'todo' ? el('span', 'src', '待處理') : button('src', shortDate(src), () => openDay(src, c.index)));
  }
  head.appendChild(el('div', 'title', c.title || '（沒有標題）'));
  if (editable && src === 'todo' && c.title) {
    head.appendChild(waitToggle(c, src));
  } else if (c.status) {
    head.appendChild(el('span', 'badge', c.status));
  }
  if (!editable && c.hidden) head.appendChild(el('span', 'badge', '已隱藏'));
  // 標記清單裡只標分類（未分類不標），其他地方標「標記·分類」（見 開發筆記 D076）
  if (!editable && c.flagged && (!unflag || c.flagCat)) head.appendChild(el('span', 'badge', unflag ? c.flagCat : flagLabel(c)));
  box.appendChild(head);

  if ((c.codes && c.codes.length) || c.event != null) box.appendChild(chips(c));
  if (c.body.length) {
    const body = el('div', 'body');
    for (const l of c.body) body.appendChild(el('div', l.trim().startsWith('->') ? 'line upd-line' : 'line', l));
    box.appendChild(body);
  }
  if (editable && c.title) addActions(box, c, src);
  if (unflag) {
    const row = el('div', 'actions');
    row.appendChild(button('unflag', '取消標記', () => act(async () => {
      await api.setFlag(src, c.index, c.raw, false);
      await refreshAll();
    })));
    box.appendChild(row);
  }
  return box;
}

function addActions(box, c, src) {
  const row = el('div', 'actions');
  const updBox = el('div', 'upd-box');
  updBox.hidden = true;
  const input = el('input', 'upd-text');
  input.placeholder = src === 'todo' ? '進展（Enter 存，會帶今天日期）'
    : src === st.info.today ? '後續（Enter 存）' : '今天的後續（Enter 存，會記在今天、用 ^編號 串起來）';
  updBox.appendChild(input);
  const pick = el('div', 'actions flag-pick');   // 標記的分類鈕（見 開發筆記 D076）
  pick.hidden = true;

  if (src !== 'todo') row.appendChild(flagToggle(c, src, pick));
  row.appendChild(button('upd', '+ 更新', () => { updBox.hidden = !updBox.hidden; if (!updBox.hidden) input.focus(); }));
  if (src === 'todo') {
    const done = button('done', '處理完 ↑', () => act(async () => {
      await api.markDone(c.index, c.raw, st.day);
      toast(`已移到 ${st.day.slice(5)} 已處理`);
      await refreshAll();
      showNewDone();
    }));
    done.title = '整筆（含進展）搬到上面這一天的已處理';
    row.appendChild(done);
    // 已處理+未完標籤（見 開發筆記 D091）：跟處理完一樣搬上去，再標上內建分類「未完」
    const unfinished = button('unfinished', '已處理+未完標籤', () => act(async () => {
      await api.markDone(c.index, c.raw, st.day, true);
      toast(`已移到 ${st.day.slice(5)} 已處理，標上「未完」`);
      await refreshAll();
      showNewDone();
    }));
    unfinished.title = '整筆（含進展）搬到上面這一天的已處理，並標上「未完」標記';
    row.appendChild(unfinished);
    const hide = button('hide', c.hidden ? '取消隱藏' : '隱藏', () => act(async () => {
      await api.setHidden(c.index, c.raw, !c.hidden);
      await refreshAll();
    }));
    hide.title = c.hidden ? '放回待處理清單' : '先收起來不看（還在，展開「已隱藏」就找得到）';
    row.appendChild(hide);
  }
  row.appendChild(button('edit', '編輯', () => startEdit(box, c, src)));
  // 不跳詢問，誤刪按 Ctrl+Z 復原（見 開發筆記 D028）
  row.appendChild(button('del', '刪除', () => act(async () => {
    await api.deleteCard(src, c.index, c.raw);
    toast('已刪除（Ctrl+Z 復原）');
    await refreshAll();
  })));

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; updBox.hidden = true; return; }
    if (!isEnter(e)) return;
    e.preventDefault();
    act(async () => {
      const r = await api.addUpdate(src, c.index, c.raw, input.value);
      input.value = '';
      if (r.where === 'today') toast(`已記在今天（^${r.event}）`);
      await refreshAll();
    });
  });
  box.append(row, pick, updBox);
}

function startEdit(box, c, src) {
  box.classList.add('editing');
  box.textContent = '';
  const t = el('textarea', 'edit-title');
  t.value = c.title;
  t.rows = Math.max(1, c.title.split('\n').length);
  const b = el('textarea', 'edit-body');
  b.value = c.body.join('\n');
  b.rows = Math.max(3, c.body.length + 1);
  b.spellcheck = t.spellcheck = false;
  tabInsert(b);
  const save = () => act(async () => {
    // 狀態、隱藏、標記不在這裡改（在卡片上一鍵切換），原本的照舊留著
    await api.editCard(src, c.index, c.raw, { title: t.value, body: b.value, status: c.status, hidden: c.hidden, flagged: c.flagged, flagCat: c.flagCat, event: c.event });
    await refreshAll();
  });
  for (const area of [t, b]) area.addEventListener('keydown', e => { if (isEnter(e) && e.ctrlKey) { e.preventDefault(); save(); } });
  const row = el('div', 'actions');
  row.append(button('save', '儲存（Ctrl+Enter）', save), button('cancel', '取消', () => refreshAll()));
  box.append(t, b, row);
  b.focus();
}

/* 有卡片在編輯、更新框打了字、或標記的分類鈕開著：外部改檔時先不重畫，免得打到一半被洗掉
   （分類鈕要點兩下，中間剛好收到上一個動作自己寫檔的通知，會被收掉，見 開發筆記 D076） */
const isBusy = () => !!document.querySelector('.card.editing, .flag-pick:not([hidden])') || [...document.querySelectorAll('.upd-text')].some(i => i.value.trim());

/* ---------- 中間：某一天（上已處理、下待處理）／搜尋／時間軸 ---------- */
function layout() {
  const day = st.view === 'day';
  const cards = st.mode === 'cards';
  $('center').classList.toggle('text-mode', !cards);   // 文字模式兩塊照比例分高度（見 開發筆記 D029）
  $('doneBox').hidden = $('todoBox').hidden = !day;
  $('cards').hidden = $('todoCards').hidden = !cards;
  $('editor').hidden = $('todo').hidden = cards;
  $('newForm').hidden = !(day && cards);
  $('results').hidden = day;
  $('rangeBar').hidden = st.view !== 'range';
  $('rangeBtn').classList.toggle('on', st.view === 'range');
  $('backBtn').hidden = day;
  $('modeBtn').hidden = !day;
  $('modeBtn').textContent = cards ? '文字模式' : '卡片模式';
  paneHeads();
  applySizes();
}

/* 已處理／待處理的標題列：▾ 展開、▸ 縮起來，後面寫筆數（見 開發筆記 D027） */
function paneHeads() {
  for (const [key, box, head, name] of [['done', 'doneBox', 'doneHead', '已處理'], ['todo', 'todoBox', 'todoHead', '待處理']]) {
    const c = !!st.collapsed[key];
    $(box).classList.toggle('collapsed', c);
    const n = st.counts[key];
    $(head).textContent = `${c ? '▸' : '▾'} ${name}` + (n == null ? '' : `（${n}）`);
    $(head).title = c ? '點一下展開' : '點一下縮起來，讓輸入區大一點';
  }
}
function togglePane(key) {
  st.collapsed[key] = !st.collapsed[key];
  try { localStorage.setItem('daybook.collapsed', JSON.stringify(st.collapsed)); } catch { /* 記不住就算了 */ }
  paneHeads();
  applySizes();
}
$('doneHead').addEventListener('click', () => togglePane('done'));
$('todoHead').addEventListener('click', () => togglePane('todo'));

/* ---------- 分隔線：拉動調整左欄寬度，已處理／待處理／輸入區的高度（見 開發筆記 D074） ----------
   像 VS Code 那樣拉：線兩邊的區塊互相讓，讓的那邊縮到最小還在拉，就接著縮再過去那塊；拉多大就多大（內容少會空、多就捲動）。
   點兩下回到預設：左欄 180px、高度跟著內容走（D029）、文字模式各一半。
   記在這台電腦：side、done、todo 是 px，text 是文字模式已處理佔兩塊的幾成；沒拉過（或點兩下還原）是 null。
   輸入區不記，永遠是剩下的 */
const SIDE_MIN = 150, PANE_MIN = 60, FORM_MIN = 140;   // FORM_MIN 跟 style.css 的 #newForm min-height 一樣
const sizes = (() => { try { return JSON.parse(localStorage.getItem('daybook.sizes')) || {}; } catch { return {}; } })();
const saveSizes = () => { try { localStorage.setItem('daybook.sizes', JSON.stringify(sizes)); } catch { /* 記不住就算了 */ } };

/* 左欄寬度：開起來時 theme.js 已經套上（不會先閃一下 180px），這裡管拉的時候、點兩下還原 */
function applySide() {
  if (sizes.side) document.documentElement.style.setProperty('--side-w', `${sizes.side}px`);
  else document.documentElement.style.removeProperty('--side-w');
}

/* 中間由上到下、分得到高度的區塊：縮起來的只剩標題列，不算；卡片模式最底下是輸入區，文字模式沒有 */
function stack() {
  const s = ['done', 'todo'].filter(k => !st.collapsed[k]);
  if (st.mode === 'cards') s.push('form');
  return s;
}
const boxOf = k => $(k === 'form' ? 'newForm' : `${k}Box`);

function applySizes() {
  const text = st.mode !== 'cards';
  for (const k of ['done', 'todo']) {
    let flex = '';   // 沒拉過：照 style.css（卡片模式跟著內容走、文字模式各一半）
    if (!st.collapsed[k]) {
      if (text) { if (sizes.text != null) flex = `${Math.round((k === 'done' ? sizes.text : 1 - sizes.text) * 1000)} 1 0px`; }
      // 拉過的幾乎不縮：放不下時先縮跟著內容走的那塊；全部都拉過、視窗又太小，才一起照比例縮
      else if (sizes[k] != null) flex = `0 0.001 ${sizes[k]}px`;
    }
    boxOf(k).style.flex = flex;
  }
  // 線在那塊和底下那塊中間；底下沒有分得到高度的（文字模式待處理縮起來、待處理是最後一塊）就不出現
  const s = stack(), day = st.view === 'day';
  $('sashDone').hidden = !(day && s[0] === 'done' && s.length > 1);
  $('sashTodo').hidden = !(day && s.includes('todo') && s.indexOf('todo') < s.length - 1);
}

/* 拖拉：axis 是 col（左右拉）或 row（上下拉）；start() 在按下時量好現在的大小，回傳「拉了 d px 時怎麼套」 */
function sash(id, axis, start, reset) {
  const bar = $(id);
  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const at = ev => axis === 'col' ? ev.clientX : ev.clientY;
    const p0 = at(e), move = start();
    let moved = false;
    const onMove = ev => {
      const d = at(ev) - p0;
      if (!moved && Math.abs(d) < 3) return;   // 只是點一下（或點兩下還原）不算拉，免得跟著內容走的變成固定
      moved = true;
      move(d);
    };
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    document.body.dataset.resizing = axis;
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('lostpointercapture', () => {   // 放開、或被系統打斷都會到這裡
      bar.removeEventListener('pointermove', onMove);
      bar.classList.remove('dragging');
      delete document.body.dataset.resizing;
      if (moved) saveSizes();
    }, { once: true });
  });
  bar.addEventListener('dblclick', () => { reset(); saveSizes(); });
}

sash('sashSide', 'col', () => {
  const w0 = $('days').getBoundingClientRect().width;
  return d => { sizes.side = Math.round(Math.max(SIDE_MIN, Math.min(innerWidth / 2, w0 + d))); applySide(); };
}, () => { sizes.side = null; applySide(); });

/* ---------- 最左邊的頁籤列（見 開發筆記 D083）：像 VS Code 的活動列，「日記本」「剪貼簿」（D093、D096） ----------
   點正在看的那個收起左欄、點另一個（或左欄收著時）打開並換成它；收起來、放哪一個都記在這台電腦（開起來時 theme.js 已經套上）。
   收起來時兩個都不算選到 */
const sideOff = () => document.documentElement.dataset.side === 'off';
function setSideOff(off) {
  if (off) document.documentElement.dataset.side = 'off';
  else delete document.documentElement.dataset.side;
  try { localStorage.setItem('daybook.sideOff', off ? '1' : ''); } catch { /* 記不住就算了 */ }
  actState();
}
const sideView = () => (document.documentElement.dataset.sideView === 'snip' ? 'snip' : 'journal');
function showSide(view) {
  if (view === 'snip') document.documentElement.dataset.sideView = 'snip';
  else delete document.documentElement.dataset.sideView;
  try { localStorage.setItem('daybook.sideView', view === 'snip' ? 'snip' : ''); } catch { /* 記不住就算了 */ }
  setSideOff(false);
}
/* 記事本（D102）：中間換成記事本、左欄收起來（只是藏起來，sideOff、sideView 照留）；開著時點日記本、剪貼簿先回到日記，再打開左欄換成它 */
const noteMode = () => document.documentElement.dataset.view === 'note';
const actClick = view => {
  if (noteMode()) { setNoteMode(false); showSide(view); return; }
  if (!sideOff() && sideView() === view) setSideOff(true); else showSide(view);
};
function actState() {
  const on = v => !noteMode() && !sideOff() && sideView() === v;
  $('actJournal').classList.toggle('on', on('journal'));
  $('actJournal').title = on('journal') ? '日記本：點一下收起左欄，中間大一點' : '日記本：點一下打開左欄（搜尋、日期）';
  $('actSnip').classList.toggle('on', on('snip'));
  $('actSnip').title = on('snip') ? '剪貼簿：點一下收起左欄，中間大一點' : '剪貼簿：常用的文字放這裡，點一下就複製';
  $('actNote').classList.toggle('on', noteMode());
  $('actNote').title = noteMode() ? '記事本：點一下回到日記' : '記事本：隨手記，一份一個頁籤';
}
$('actJournal').addEventListener('click', () => actClick('journal'));
$('actSnip').addEventListener('click', () => actClick('snip'));
$('actNote').addEventListener('click', () => setNoteMode(!noteMode()));
actState();

/* ---------- 剪貼簿（見 開發筆記 D093；原本叫暫存，D096）：左欄換成一張張卡片，點卡片把內文複製到系統剪貼簿 ----------
   存在資料夾的 剪貼簿.md；新增放最前面。編輯中（含新增）外面改了檔、或別的動作重畫，都先不重畫這塊 */
const SNIP_EMPTY = '剪貼簿還是空的。按「＋ 新增」放一段常用的文字，之後點一下就複製。';
const snipBusy = () => !!document.querySelector('.snip.editing');
async function refreshSnips() {
  const list = await api.listSnips();   // 先讀好再換，畫面不閃（D045）
  $('snipList').replaceChildren(...(list.length ? list.map(snipCard) : [el('div', 'empty', SNIP_EMPTY)]));
}
/* 編輯表單「日期符號 ▸」展開的說明（D095）：符號表只列補零的六個，其他寫一行；例子點了插進內文。認哪些符號在 datefill.js */
const SNIP_SYMS = [['yyyy', '年'], ['MM', '月'], ['dd', '日'], ['HH', '時'], ['mm', '分'], ['ss', '秒']];
const SNIP_EXAMPLES = ['{yyyy.MM.dd HH:mm}', '{yyyy-MM-dd}', '{M/d}'];
/* 內文裡的日期符號（{yyyy.MM.dd HH:mm}，D094）：卡片上照寫的顯示、標顏色；複製時才換成當下（datefill.js） */
function snipBody(text) {
  const box = el('div', 'snip-body');
  for (const p of dateSegments(text)) box.append(p.date ? el('span', 'snip-date', p.text) : p.text);
  return box;
}
function snipCard(s) {
  const box = el('div', 'snip');
  const name = s.title || '（沒有標題）';
  const copy = button('snip-copy', null, () => act(async () => {
    if (!s.body.length) { toast(`「${name}」沒有內文`, true); return; }
    await api.copyText(fillDates(s.body.join('\n'), new Date()));
    toast(`已複製「${name}」`);
  }));
  copy.title = '點一下複製內文';
  copy.append(el('div', 'snip-title', name), snipBody(s.body.join('\n')));
  const tools = el('div', 'actions snip-tools');
  tools.append(button('edit', '編輯', () => snipEdit(box, s)), button('del', '刪除', () => act(async () => {
    await api.deleteSnip(s.index, s.raw);   // 不跳詢問，誤刪按 Ctrl+Z 復原（D028）
    toast('已刪除（Ctrl+Z 復原）');
    await refreshSnips();
  })));
  box.append(copy, tools);
  return box;
}
/* 新增（s 是 null）、編輯共用：標題 Enter 換到內文，Ctrl+Enter 儲存；儲存失敗（沒填）表單留著 */
function snipEdit(box, s) {
  box.className = 'snip editing';
  box.textContent = '';
  const t = el('input', 'snip-title-in');
  t.value = s ? s.title : '';
  t.placeholder = '標題　Enter 換到內文';
  const b = el('textarea', 'snip-body-in');
  b.value = s ? s.body.join('\n') : '';
  b.placeholder = '要複製的內文（Tab 可縮排；{yyyy.MM.dd HH:mm} 這種複製時換成當下的日期時間）';
  b.rows = Math.max(3, Math.min(12, (s ? s.body.length : 0) + 1));
  t.spellcheck = b.spellcheck = false;
  tabInsert(b);
  // 內文有日期符號時，底下即時預覽複製出去的樣子（D094）
  const pv = el('div', 'snip-preview');
  const preview = () => {
    pv.hidden = !dateSegments(b.value).some(p => p.date);
    pv.textContent = '複製時：' + fillDates(b.value, new Date());
  };
  b.addEventListener('input', preview);
  preview();
  // 日期符號的說明（D095）：點「日期符號 ▸」展開符號表和例子，點例子插進內文游標的位置（execCommand，內文裡 Ctrl+Z 復原得了）
  const help = el('div', 'snip-help');
  help.hidden = true;
  const helpBtn = button('snip-help-toggle', '日期符號 ▸', () => {
    help.hidden = !help.hidden;
    helpBtn.textContent = help.hidden ? '日期符號 ▸' : '日期符號 ▾';
  });
  const syms = el('div', 'snip-syms');
  for (const [k, v] of SNIP_SYMS) syms.append(el('code', null, k), el('span', null, v));
  const ins = el('div', 'actions snip-ins');
  for (const x of SNIP_EXAMPLES) {
    const eb = button(null, x, () => { b.focus(); document.execCommand('insertText', false, x); });   // focus 回內文會回到原本的游標位置
    eb.title = '插進內文游標的位置';
    ins.append(eb);
  }
  help.append(el('div', null, '寫在大括號裡，複製時換成當下（大小寫有分）：'), syms, el('div', null, 'yy 是年兩碼；M、d、H 不補零'), el('div', null, '點了插進內文：'), ins);
  const save = () => act(async () => {
    const v = { title: t.value, body: b.value };
    if (s) await api.editSnip(s.index, s.raw, v);
    else await api.addSnip(v);
    await refreshSnips();
  });
  t.addEventListener('keydown', e => {
    if (!isEnter(e)) return;
    e.preventDefault();
    if (e.ctrlKey) save(); else b.focus();
  });
  b.addEventListener('keydown', e => { if (isEnter(e) && e.ctrlKey) { e.preventDefault(); save(); } });
  const row = el('div', 'actions');
  row.append(button('save', '儲存（Ctrl+Enter）', save), button('cancel', '取消', () => act(refreshSnips)));
  box.append(t, b, pv, helpBtn, help, row);
  (s ? b : t).focus();
}
$('snipAdd').addEventListener('click', () => {
  const open = $('snipList').querySelector('.snip[data-new]');
  if (open) { open.querySelector('input').focus(); return; }   // 已經開著一張新的
  const box = el('div');
  box.dataset.new = '';
  $('snipList').querySelector(':scope > .empty')?.remove();
  $('snipList').prepend(box);
  snipEdit(box, null);
});

/* ---------- 記事本（見 開發筆記 D102）：中間換成記事本，上面一排頁籤一份一個（資料夾的 記事本\名稱.txt） ----------
   停手 600ms 自動存（跟文字模式同一套 autosave）；換一份、新增、改名、離開記事本之前先存。正在看哪一份記在這台電腦。
   外面改了檔：沒有打到一半的才換成檔案的內容；在改名時先不重畫頁籤 */
let noteCur = (() => { try { return localStorage.getItem('daybook.note') || null; } catch { return null; } })();
const noteSave = autosave($('noteText'), text => api.writeNote(noteCur, text).catch(e => toast(errMsg(e), true)), t => { $('noteSave').textContent = t; });
tabInsert($('noteText'));
const noteBusy = () => !!document.querySelector('.note-rename');
function setNoteCur(name) {
  noteCur = name;
  try { localStorage.setItem('daybook.note', name || ''); } catch { /* 記不住就算了 */ }
}
function setNoteMode(on) {
  if (on) document.documentElement.dataset.view = 'note';
  else delete document.documentElement.dataset.view;
  try { localStorage.setItem('daybook.view', on ? 'note' : ''); } catch { /* 記不住就算了 */ }
  actState();
  if (!on) return act(noteSave.flush);   // 打到一半的先存
  return act(async () => { await refreshNotes(); $('noteText').focus(); });
}
async function refreshNotes() {
  const list = await api.listNotes();
  if (!list.includes(noteCur)) {   // 第一次、或那一份在外面被改名、刪掉了：看第一份
    clearTimeout(noteSave.timer);
    noteSave.dirty = false;
    setNoteCur(list[0] || null);
  }
  if (!noteBusy()) $('noteTabs').replaceChildren(...list.map(noteTab));
  $('noteText').hidden = !noteCur;
  $('noteEmpty').hidden = !!noteCur;
  if (!noteCur) { $('noteSave').textContent = ''; return; }
  const name = noteCur;
  const text = await api.readNote(name);
  // 讀的時候又打了字、或換了一份，就不蓋
  if (name === noteCur && !noteSave.dirty && text !== $('noteText').value) $('noteText').value = text;
  $('noteTabs').querySelector('.noteTab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function noteTab(name) {
  const tab = el('div', 'noteTab' + (name === noteCur ? ' on' : ''));
  const nm = button('noteName', name, () => openNote(name));
  nm.title = `${name}（點兩下改名）`;
  nm.addEventListener('dblclick', () => renameNote(tab, name));
  const del = button('noteDel', '×', () => deleteNote(name));
  del.title = '刪除（丟到資源回收筒）';
  tab.append(nm, del);
  return tab;
}
/* 換一份：先存這份，游標放到開頭 */
const openNote = name => act(async () => {
  if (name !== noteCur) {
    await noteSave.flush();
    setNoteCur(name);
    await refreshNotes();
    $('noteText').setSelectionRange(0, 0);
  }
  if (!noteBusy()) $('noteText').focus();   // 點兩下改名時，第一下換過來之後不要把游標從改名框搶走
});
$('noteAdd').addEventListener('click', () => act(async () => {
  await noteSave.flush();
  setNoteCur(await api.addNote());   // 新記事 N，接在最後面
  await refreshNotes();
  $('noteText').focus();
}));
/* 改名：頁籤換成輸入框；Enter 改好（名稱不行就提示、留著改），Esc 取消，點別的地方也算改好（不行就還原） */
function renameNote(tab, name) {
  if (noteBusy()) return;
  const input = el('input', 'note-rename');
  input.value = name;
  input.spellcheck = false;
  tab.replaceChildren(input);
  input.focus();
  input.select();
  let state = 'editing';
  const finish = async (ok, blur) => {
    if (state !== 'editing') return;
    const to = input.value.trim();
    if (ok && to !== name) {
      state = 'saving';
      try {
        await noteSave.flush();   // 打到一半的先存進原本的名稱
        const n = await api.renameNote(name, to);
        if (noteCur === name) setNoteCur(n);
      } catch (e) {
        toast(errMsg(e), true);
        state = 'editing';
        if (!blur) { input.focus(); return; }
      }
    }
    state = 'done';
    input.remove();
    await act(refreshNotes);
  };
  input.addEventListener('keydown', e => {
    if (isEnter(e)) { e.preventDefault(); finish(true, false); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false, false); }
  });
  input.addEventListener('blur', () => finish(true, true));
}
/* 刪除：不問，丟資源回收筒（使用者選的）。刪的是正在看的那份就換到右邊那份，沒有就左邊那份 */
const deleteNote = name => act(async () => {
  const list = await api.listNotes();
  if (name === noteCur) { clearTimeout(noteSave.timer); noteSave.dirty = false; }   // 要丟掉的那份不用再存
  await api.deleteNote(name);
  if (name === noteCur) {
    const i = list.indexOf(name);
    setNoteCur(list[i + 1] || list[i - 1] || null);
  }
  toast(`已把「${name}」丟到資源回收筒`);
  await refreshNotes();
  if (noteCur) $('noteText').focus();
});

/* 設定（見 開發筆記 D092）：頁籤列最底下的齒輪，點了在右邊彈出小選單，點一個就打開那張（備份是直接做，D097）、選單收起來。
   選單分類（D098）：「資料」匯入、匯出、備份；「自訂」格式、外觀。
   點外面也收起來；Esc 在下面「Esc 關掉」那段一起攔 */
function settingsMenu(open) {
  const m = $('settingsMenu');
  m.hidden = !open;
  $('actSettings').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const r = $('actSettings').getBoundingClientRect();
  m.style.left = r.right + 4 + 'px';
  m.style.bottom = innerHeight - r.bottom + 'px';
}
$('actSettings').addEventListener('click', () => settingsMenu($('settingsMenu').hidden));
$('settingsMenu').addEventListener('click', e => { if (e.target.closest('button')) settingsMenu(false); });
document.addEventListener('mousedown', e => {
  if (!$('settingsMenu').hidden && !e.target.closest('#settingsMenu, #actSettings')) settingsMenu(false);
});

/* after 那塊和它底下那塊中間的線。往下拉：after 變大，底下的由近到遠讓（各自縮到最小為止）；往上拉反過來 */
const dragStack = after => () => {
  const s = stack(), i = s.indexOf(after);
  const h0 = s.map(k => boxOf(k).getBoundingClientRect().height);
  const min = s.map(k => k === 'form' ? FORM_MIN : PANE_MIN);
  // 跟著內容走、但放不下在捲動的那塊，高度是分剩的：拉別的線也要照現在的高度定住，不然讓出來的會被它拿走、線不跟著游標
  const full = s.map(k => k !== 'form' && sizes[k] == null && st.mode === 'cards'
    && (l => l.scrollHeight > l.clientHeight + 1)($(k === 'done' ? 'cards' : 'todoCards')));
  return d => {
    const h = h0.slice();
    const grow = d > 0 ? i : i + 1;
    const give = [];
    if (d > 0) for (let k = i + 1; k < s.length; k++) give.push(k);
    else for (let k = i; k >= 0; k--) give.push(k);
    let need = Math.abs(d);
    for (const k of give) { const t = Math.min(need, Math.max(0, h[k] - min[k])); h[k] -= t; need -= t; }
    h[grow] += Math.abs(d) - need;
    if (st.mode === 'cards') s.forEach((k, j) => { if (k !== 'form' && (h[j] !== h0[j] || full[j])) sizes[k] = Math.round(h[j]); });
    else sizes.text = h[0] / (h[0] + h[1]);
    applySizes();
  };
};
/* 點兩下：線上下那兩塊回到預設（輸入區本來就是剩下的） */
const resetStack = after => () => {
  if (st.mode !== 'cards') sizes.text = null;
  else { const s = stack(), i = s.indexOf(after); for (const k of s.slice(i, i + 2)) if (k !== 'form') sizes[k] = null; }
  applySizes();
};
sash('sashDone', 'row', dragStack('done'), resetStack('done'));
sash('sashTodo', 'row', dragStack('todo'), resetStack('todo'));

/* 外觀頁「還原預設大小」（見 開發筆記 D075）：全部回到沒拉過；縮放、縮起來不動 */
const sized = () => Object.values(sizes).some(v => v != null);
$('sizeReset').addEventListener('click', () => {
  for (const k in sizes) sizes[k] = null;
  saveSizes();
  applySide();
  applySizes();
  $('sizeReset').disabled = true;
  toast('已還原預設大小');
});

/* 清單空的時候那一行；外觀包有空白時的插圖就放在字上面（見 開發筆記 D062） */
let skinEmpty = null;   // 空白時的插圖（data: 網址），沒有是 null；applySkin 放
function emptyBox(text) {
  const box = el('div', 'empty', text);
  if (skinEmpty) {
    const img = el('img', 'skinEmpty');
    img.src = skinEmpty;
    img.alt = '';
    box.prepend(img);
  }
  return box;
}

/* 先讀好再清空重畫：清空後才 await，中間會畫出空的清單（閃一下、捲動位置跑回最上面，見 開發筆記 D045） */
async function renderList(box, src, emptyText) {
  const cards = await api.listCards(src);
  box.textContent = '';
  for (const c of cards) box.appendChild(card(c, { src, editable: true }));
  if (!cards.length) box.appendChild(emptyBox(emptyText));
  return cards;
}

async function renderDay() {
  $('dayTitle').textContent = `${st.day}（${weekday(st.day)}）` + (st.day === st.info.today ? '　今天' : '');
  if (st.mode === 'text') {
    st.counts.done = null;
    paneHeads();
    if (!editorSave.dirty) {
      const text = await api.readDay(st.day);
      if (text !== $('editor').value) $('editor').value = text;
    }
    return;
  }
  showSave('');
  st.counts.done = (await renderList($('cards'), st.day, '這天還沒有處理過的事')).length;
  paneHeads();
  if (st.focus != null) {
    const target = $('cards').querySelector(`.card[data-index="${st.focus}"]`);
    if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('flash'); }
    st.focus = null;
  }
}

/* 已處理多一筆（＋ 已處理、處理完 ↑、已處理+未完標籤，見 開發筆記 D099）：新的接在最後面，捲到那一筆的頂端；
   重畫照 D045 會留在原本的捲動位置，不捲的話新的那筆常在看不到的底下。頂端留跟清單上緣一樣的空 */
function showNewDone() {
  const list = $('cards'), c = list.lastElementChild;
  if (c) list.scrollTop += c.getBoundingClientRect().top - list.getBoundingClientRect().top - parseFloat(getComputedStyle(list).paddingTop);
}

async function renderTodo() {
  if (st.mode === 'text') {
    st.counts.todo = null;
    paneHeads();
    if (!todoSave.dirty) {
      const text = await api.readTodo();
      if (text !== $('todo').value) $('todo').value = text;
    }
    return;
  }
  /* 隱藏的收在最底下「已隱藏 N 筆」，點一下展開／收起（見 開發筆記 D026）；先讀好再清空（見 D045） */
  const box = $('todoCards');
  const cards = await api.listCards('todo');
  box.textContent = '';
  const shown = cards.filter(c => !c.hidden);
  const hidden = cards.filter(c => c.hidden);
  st.counts.todo = shown.length;
  paneHeads();
  for (const c of shown) box.appendChild(card(c, { src: 'todo', editable: true }));
  if (!shown.length) box.appendChild(emptyBox(hidden.length ? '沒有待處理的事（有隱藏的）' : '沒有待處理的事'));
  if (hidden.length) {
    box.appendChild(button('hiddenToggle', `${st.showHidden ? '▾' : '▸'} 已隱藏 ${hidden.length} 筆`, () => {
      st.showHidden = !st.showHidden;
      renderTodo();
    }));
    if (st.showHidden) {
      for (const c of hidden) {
        const el_ = card(c, { src: 'todo', editable: true });
        el_.classList.add('is-hidden');
        box.appendChild(el_);
      }
    }
  }
}

function renderResults(title, items, emptyText = '沒有找到') {
  $('dayTitle').textContent = title;
  const box = $('results');
  box.textContent = '';
  for (const it of items) box.appendChild(card(it, { src: it.src, editable: false, showSrc: true, unflag: st.view === 'flagged' }));
  if (!items.length) box.appendChild(el('div', 'empty', emptyText));
}

async function refreshCenter() {
  layout();
  if (st.view === 'search') {
    const items = await api.search(st.q);
    renderResults(`搜尋「${st.q}」：${items.length} 筆` + (items.length >= 300 ? '（只列前 300 筆）' : ''), items);
  } else if (st.view === 'timeline') {
    const items = await api.timeline(st.by);
    renderResults(st.by.code != null ? `${st.by.code} 時間軸：${items.length} 筆` : `事件 ^${st.by.event}：${items.length} 筆`, items);
  } else if (st.view === 'flagged') {
    const [items, cats] = await Promise.all([api.flagged(), api.flagCats()]);
    renderFlagged(items, cats);
  } else if (st.view === 'range') {
    await renderRange();
  } else {
    await renderDay();
    await renderTodo();
  }
}

async function openDay(date, focusIndex) {
  await flushText();
  st.view = 'day';
  st.day = date;
  st.calMonth = date.slice(0, 7);   // 日曆跟著翻到那一天的月份
  st.focus = focusIndex == null ? null : focusIndex;
  await refreshCenter();
  await refreshDays();
}
async function showSearch(q) {
  await flushText();
  st.view = 'search';
  st.q = q;
  await refreshCenter();
  await refreshDays();
}
async function showTimeline(by) {
  await flushText();
  st.view = 'timeline';
  st.by = by;
  await refreshCenter();
  await refreshDays();
}
/* 標記清單上面一排篩選鈕（見 開發筆記 D076）：全部、未分類、各分類（照分類清單的順序），後面寫筆數，點了只列那一類。
   「全部」「未分類」不能當分類名稱（parser.js 的 checkCat），所以直接拿來當篩選的值 */
function renderFlagged(items, cats) {
  const keyOf = it => it.flagCat || '未分類';
  const keys = ['全部', '未分類', ...cats];
  if (!keys.includes(st.flagFilter)) st.flagFilter = '全部';
  const all = st.flagFilter === '全部';
  const shown = all ? items : items.filter(it => keyOf(it) === st.flagFilter);
  renderResults(all ? `標記：${items.length} 筆` : `標記（${st.flagFilter}）：${shown.length} 筆`, shown, all ? '沒有標記的事' : '這個分類沒有標記的事');
  const bar = el('div', 'flag-filter');
  for (const k of keys) {
    const n = k === '全部' ? items.length : items.filter(it => keyOf(it) === k).length;
    const b = button('cat' + (k === st.flagFilter ? ' on' : ''), `${k} ${n}`, () => { st.flagFilter = k; renderFlagged(items, cats); });
    b.dataset.cat = k;
    bar.appendChild(b);
  }
  $('results').prepend(bar);
}

/* 標記清單（見 開發筆記 D072）：所有標記過的已處理，舊的在前；清單上可以直接取消標記；上面可以篩分類（D076） */
async function showFlagged() {
  await flushText();
  st.view = 'flagged';
  await refreshCenter();
  await refreshDays();
}
$('flagList').addEventListener('click', () => showFlagged());

/* 回顧（見 開發筆記 D087）：一段時間的已處理，每天一段小標（點了打開那天），底下是那天的卡片（唯讀），舊的在前。
   右上角「回顧」一律打開這週；‹ › 換一週、或自己填起訖 */
async function renderRange() {
  const { from, to } = st.range;
  $('rangeFrom').value = from;
  $('rangeTo').value = to;
  const bad = from > to;
  const items = bad ? [] : await api.range(from, to);   // 先讀好再清空（見 D045）
  $('dayTitle').textContent = `回顧 ${from} ～ ${to}` + (bad ? '' : `：${items.length} 筆`);
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.src)) byDay.set(it.src, []);
    byDay.get(it.src).push(it);
  }
  const box = $('results');
  box.textContent = '';
  for (const [date, list] of byDay) {
    const h = button('rangeDay', `${date}（${weekday(date)}）· ${list.length} 筆`, () => openDay(date));
    h.title = '打開這一天';
    box.appendChild(h);
    for (const it of list) box.appendChild(card(it, { src: date, editable: false }));
  }
  if (!items.length) box.appendChild(el('div', 'empty', bad ? '起日不能晚於訖日' : '這段時間沒有處理過的事'));
}
/* date 那一週：星期一～星期日（一週從星期一開始，跟日曆一樣，見 D036）；這週的話到今天 */
function weekOf(date) {
  const mon = new Date(mondayOf(date));
  const from = isoOf(mon);
  const sun = isoOf(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6));
  return { from, to: from <= st.info.today && st.info.today <= sun ? st.info.today : sun };
}
/* ‹ ›：起日那一週的前一週／後一週（自己填的起訖也是照起日那週換）；回顧、匯出列共用（D088） */
function stepWeek(from, n) {
  const mon = new Date(mondayOf(from));
  return weekOf(isoOf(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7 * n)));
}
async function showRange(range) {
  await flushText();
  st.view = 'range';
  st.range = range;
  await refreshCenter();
  await refreshDays();
}
$('rangeBtn').addEventListener('click', () => showRange(weekOf(st.info.today)));
$('rangePrev').addEventListener('click', () => showRange(stepWeek(st.range.from, -1)));
$('rangeNext').addEventListener('click', () => showRange(stepWeek(st.range.from, 1)));
// 「匯出這段…」：打開匯出列、起訖帶回顧的（匯出列已經開著也蓋過去）；之後回顧再換，匯出的不跟著換（見 開發筆記 D088）
$('rangeExport').addEventListener('click', () => {
  $('expFrom').value = st.range.from;
  $('expTo').value = st.range.to;
  openExport();
});
// 日期框清空的不算（起訖都要有才換）
for (const id of ['rangeFrom', 'rangeTo']) {
  $(id).addEventListener('change', () => {
    if ($('rangeFrom').value && $('rangeTo').value) showRange({ from: $('rangeFrom').value, to: $('rangeTo').value });
  });
}

/* ---------- 左：日期清單／日曆 ---------- */
/* 那一週的星期一（一週從星期一開始，跟日曆一樣，見 開發筆記 D036） */
function mondayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(d - ((t.getDay() + 6) % 7));
  return t.getTime();
}

async function refreshDays() {
  const files = await api.listDays();
  const days = files.includes(st.info.today) ? files : [st.info.today, ...files];
  renderCalendar(new Set(files));
  $('flagList').classList.toggle('on', st.view === 'flagged');
  const nav = $('dayList');
  // 重畫會把按鈕整個換掉：游標原本在清單上，就放回正在看的那天，↑↓ 才能接著換（見 開發筆記 D070）
  const hadFocus = nav.contains(document.activeElement);
  nav.textContent = '';
  let month = null;
  let week = null, band = false;   // 每週一段底色，一週淺一週深，照清單上的順序換（見 開發筆記 D071）
  for (const date of days) {
    if (date.slice(0, 7) !== month) {
      month = date.slice(0, 7);
      nav.appendChild(el('h3', null, month));
    }
    const w = mondayOf(date);
    if (week != null && w !== week) band = !band;
    week = w;
    const b = button(band ? 'wk-alt' : null, shortDate(date), () => openDay(date));
    b.dataset.date = date;
    b.classList.toggle('on', st.view === 'day' && date === st.day);
    nav.appendChild(b);
  }
  if (hadFocus) {
    const on = nav.querySelector('button.on');
    if (on) on.focus();
  }
}
/* 游標在日期清單上（點過日期）：↑↓ 換上一天／下一天，跟 Alt+→／Alt+← 一樣（見 開發筆記 D070）。
   清單新的在上：↑ 是比較新的那天、↓ 是比較舊的 */
$('dayList').addEventListener('keydown', e => {
  if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();   // 不讓清單自己捲動
  stepDay(e.key === 'ArrowUp' ? 'ArrowRight' : 'ArrowLeft');
});

/* 日曆（見 開發筆記 D036）：一週從星期一開始；有紀錄的日子字亮、底下一個點。
   沒紀錄的也能點：打開空的那天，可以補記（沒加東西就不會產生檔案） */
function renderCalendar(has) {
  const [y, m] = st.calMonth.split('-').map(Number);
  $('calTitle').textContent = st.calMonth;
  const grid = $('calGrid');
  grid.textContent = '';
  for (const w of '一二三四五六日') grid.appendChild(el('span', 'wd', w));
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;   // 1 號前面空幾格
  for (let i = 0; i < lead; i++) grid.appendChild(el('span'));
  const n = new Date(y, m, 0).getDate();
  for (let d = 1; d <= n; d++) {
    const date = `${st.calMonth}-${String(d).padStart(2, '0')}`;
    const b = button(null, String(d), () => openDay(date));
    b.dataset.date = date;
    b.classList.toggle('has', has.has(date));
    b.classList.toggle('today', date === st.info.today);
    b.classList.toggle('on', st.view === 'day' && date === st.day);
    b.title = `${date.slice(5)}（${weekday(date)}）` + (has.has(date) ? '' : '　沒有紀錄');
    grid.appendChild(b);
  }
}
function shiftMonth(k) {
  const [y, m] = st.calMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + k, 1);
  st.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  refreshDays();
}
$('calPrev').addEventListener('click', () => shiftMonth(-1));
$('calNext').addEventListener('click', () => shiftMonth(1));

function dayViewMode() {
  const cal = st.dayView === 'cal';
  $('dayList').hidden = cal;
  $('calendar').hidden = !cal;
  $('viewList').classList.toggle('on', !cal);
  $('viewCal').classList.toggle('on', cal);
}
function setDayView(v) {
  st.dayView = v;
  try { localStorage.setItem('daybook.dayView', v); } catch { /* 記不住就算了 */ }
  dayViewMode();
}
$('viewList').addEventListener('click', () => setDayView('list'));
$('viewCal').addEventListener('click', () => setDayView('cal'));
dayViewMode();

async function refreshAll() {
  sugg = null;
  await refreshDays();
  await refreshCenter();
  if (!snipBusy()) await refreshSnips();   // Ctrl+Z 復原的可能是剪貼簿（D093）
  if (noteMode()) await refreshNotes();   // 開起來就是記事本、或記事本的動作出錯（D102）
}

/* Alt+← / Alt+→：前一天／後一天有紀錄的日子；Alt+Home：今天（見 開發筆記 D033） */
async function stepDay(key) {
  let target = st.info.today;
  if (key !== 'Home') {
    const days = await api.listDays();
    if (!days.includes(st.info.today)) days.push(st.info.today);
    days.sort();
    target = key === 'ArrowLeft' ? days.filter(d => d < st.day).pop() : days.find(d => d > st.day);
  }
  if (!target) return;
  await openDay(target);
  const on = $('dayList').querySelector('button.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

/* ---------- 自動補完（見 開發筆記 D054；灰字是 D031、D032 來的）：打字時框下面跳出候選清單（自己跳出來、不用點開，
   不是 D025 說的下拉選單），↑↓ 選，選中的那個用灰字接在框裡預覽。
   Tab 收下；按過 ↑↓ 之後 Enter 也收下（沒按過照舊：換到內文／搜尋／換行）；Esc 關掉；Ctrl+Space 叫出來。
   候選在檔案變了之後作廢，下次打字再跟主程序拿 ---------- */
let sugg = null;   // 主程序給的 { titles, words, lines }（promise）
const loadSugg = () => (sugg = sugg || api.suggestions().catch(() => ({ titles: [], words: [], lines: [] })));
const SUGG_MAX = 10;   // 清單最多列幾個

/* 開頭或中間對得上（不分大小寫；一模一樣的不算，沒東西好補） */
function hits(list, typed, key = x => x.t) {
  const lt = typed.toLowerCase();
  return list.filter(x => { const k = key(x).toLowerCase(); return k !== lt && k.includes(lt); });
}

/* 單行輸入框的灰字：疊在框上、跟框裡的字對齊；打的字那段透明，只看得到後面補的 */
function inputGhost(input) {
  const box = input.parentElement.querySelector('.ghost');
  const typed = el('span', 'typed');
  const rest = el('span', 'rest');
  box.append(typed, rest);
  // 灰字要跟框裡的字疊得剛好：字型、內距、框線寬照抄輸入框
  const cs = getComputedStyle(input);
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) box.style[k] = cs[k];
  // 搜尋框右邊有 × 清除鈕（約一個字寬），灰字不要疊到它；放不下就整段不顯示（下面量 scrollWidth）
  if (input.type === 'search') box.style.paddingRight = `calc(${cs.paddingRight} + 1em)`;
  const clear = () => { typed.textContent = rest.textContent = ''; };
  return {
    clear,
    /* more：接在後面的灰字。回傳清單要貼著的位置 */
    show(ctx, more) {
      typed.textContent = input.value;
      rest.textContent = more;
      if (box.scrollWidth > box.clientWidth) clear();   // 放不下（框裡會捲動、疊不準，或只看得到一半）：乾脆不顯示
      const r = input.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom };
    },
  };
}

/* 多行輸入框（內文）的灰字：照抄一份同樣大小、同樣換行的透明字疊在上面，灰字接在游標後面。
   順便量出游標那一行在哪，清單貼著那一行。灰字擠到下一行（放不下）就不顯示 */
function areaGhost(area) {
  const box = el('div', 'ghostArea');
  const pre = el('span');          // 這一行打的字之前
  const seg = el('span');          // 這一行打的字
  const rest = el('span', 'rest');
  const post = el('span');         // 游標之後
  box.append(pre, seg, rest, post);
  box.hidden = true;
  document.body.appendChild(box);
  const cs = getComputedStyle(area);
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) box.style[k] = cs[k];
  return {
    clear() { box.hidden = true; },
    show(ctx, more) {
      const r = area.getBoundingClientRect();
      const bx = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const by = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      // 用 clientWidth／Height：有捲軸時扣掉捲軸，換行的寬度才一樣
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${area.clientWidth + bx}px`, height: `${area.clientHeight + by}px` });
      const v = area.value;
      pre.textContent = v.slice(0, ctx.start);
      seg.textContent = v.slice(ctx.start, ctx.caret);
      rest.textContent = more;
      post.textContent = v.slice(ctx.caret);
      box.hidden = false;
      box.scrollTop = area.scrollTop;
      const sr = seg.getClientRects();
      const line = sr[sr.length - 1];
      const gr = rest.getClientRects();
      if (more && (gr.length !== 1 || Math.abs(gr[0].top - line.top) > 1)) rest.textContent = '';
      return { left: sr[0].left, top: line.top, bottom: line.bottom };
    },
  };
}

/* 掛上自動補完。pick(候選, 游標前這一段的字) → [{ from, text, note }]：收下時把這一段的 from～游標換成 text。
   這一段：單行框是整格；內文是游標那一行（不含開頭的縮排）。游標要在（那一行的）最後面才補。
   enterThrough：Enter 收下之後讓框自己的 Enter 照做（搜尋框：帶入就搜）。回傳關掉清單的函式 */
function suggest(input, pick, { enterThrough = false } = {}) {
  const multi = input.tagName === 'TEXTAREA';
  const ghost = multi ? areaGhost(input) : inputGhost(input);
  const list = $('suggest');
  let open = false;        // 打字（或 Ctrl+Space）之後才開；Esc、收下、游標移走就關
  let anchor = '';         // 開的時候框裡的字＋游標；變了（不是打字）就關
  let items = [], sel = 0, moved = false, composing = false, accepting = false;
  const keyNow = () => `${input.selectionStart}:${input.selectionEnd}:${input.value}`;
  const caretAt = () => {
    const { value: v, selectionStart: a, selectionEnd: b } = input;
    if (a !== b || (multi ? a < v.length && v[a] !== '\n' : a !== v.length)) return null;
    const ls = multi ? v.lastIndexOf('\n', a - 1) + 1 : 0;
    const ind = v.slice(ls, a).match(/^\s*/)[0].length;
    return { start: ls + ind, caret: a, text: v.slice(ls + ind, a) };
  };
  const hide = () => {
    items = [];
    ghost.clear();
    if (list.owner === input) { list.hidden = true; list.owner = null; }
  };
  const close = () => { open = false; hide(); };
  const render = ctx => {
    list.textContent = '';
    items.forEach((it, i) => {
      const typed = input.value.slice(it.from, ctx.caret).toLowerCase();
      const k = Math.max(0, it.text.toLowerCase().indexOf(typed));
      const o = el('div', i === sel ? 'opt on' : 'opt');
      const txt = el('span', 'txt');
      txt.append(it.text.slice(0, k), el('span', 'hl', it.text.slice(k, k + typed.length)), it.text.slice(k + typed.length));
      o.append(txt, el('span', 'note', it.note));
      o.addEventListener('mousedown', e => { e.preventDefault(); accept(i); });   // preventDefault：焦點留在框裡
      list.appendChild(o);
    });
    // 灰字：選中的那個是接著打的字往下寫的（開頭對得上）才預覽
    const it = items[sel];
    const typed = input.value.slice(it.from, ctx.caret);
    const at = ghost.show(ctx, it.text.toLowerCase().startsWith(typed.toLowerCase()) ? it.text.slice(typed.length) : '');
    list.owner = input;
    list.hidden = false;
    list.style.minWidth = multi ? '' : `${input.offsetWidth}px`;
    const w = list.offsetWidth, h = list.offsetHeight;
    const bottom = $('statusBar').getBoundingClientRect().top;
    list.style.left = `${Math.max(0, Math.min(at.left, innerWidth - w - 8))}px`;
    list.style.top = `${at.bottom + h <= bottom ? at.bottom : Math.max(0, at.top - h)}px`;   // 下面放不下就放上面
  };
  const refresh = async () => {
    const s = await loadSugg();
    const ctx = caretAt();
    if (!open || composing || document.activeElement !== input || keyNow() !== anchor || !ctx || !ctx.text.trim()) return hide();
    const seen = new Set();
    items = pick(s, ctx.text)
      .map(x => ({ ...x, from: ctx.start + x.from, pre: x.text.toLowerCase().startsWith(ctx.text.slice(x.from).toLowerCase()) }))
      .filter(x => { const r = input.value.slice(0, x.from) + x.text; return !seen.has(r) && seen.add(r); })   // 收下後一樣的只留一個
      .sort((a, b) => b.pre - a.pre)   // 開頭對得上的排前面；sort 是穩定的，其餘照 pick 給的順序
      .slice(0, SUGG_MAX);
    sel = 0;
    moved = false;
    if (!items.length) return hide();
    render(ctx);
  };
  const reopen = () => { open = true; anchor = keyNow(); refresh(); };
  const accept = i => {
    const ctx = caretAt();
    if (!ctx || keyNow() !== anchor) return close();
    accepting = true;   // insertText 會觸發 input 事件，不要又打開
    input.setSelectionRange(items[i].from, ctx.caret);
    document.execCommand('insertText', false, items[i].text);   // 用 insertText：框裡自己的 Ctrl+Z 退得回來
    accepting = false;
    close();
  };
  input.addEventListener('input', e => { if (!accepting && !e.isComposing) reopen(); });
  input.addEventListener('compositionstart', () => { composing = true; hide(); });   // 輸入法選字中不補
  input.addEventListener('compositionend', () => { composing = false; reopen(); });
  for (const ev of ['keyup', 'click']) input.addEventListener(ev, () => { if (open && keyNow() !== anchor) close(); });   // 游標移走
  input.addEventListener('blur', close);
  if (multi) input.addEventListener('scroll', () => { const ctx = caretAt(); if (items.length && ctx) render(ctx); });
  // 要比框自己的 keydown（Enter、Esc、Tab 縮排）先掛上，攔下來的才不會再做一次
  input.addEventListener('keydown', e => {
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (!items.length || keyNow() !== anchor) {
      if (e.key === ' ' && e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); reopen(); }
      return;
    }
    if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      stop();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      moved = true;
      render(caretAt());
    } else if (plain && e.key === 'Tab') {
      stop();
      accept(sel);
    } else if (plain && isEnter(e) && moved) {
      accept(sel);
      if (!enterThrough) stop();
    } else if (e.key === 'Escape') {
      stop();
      close();
    }
  });
  return close;
}

/* 標題（見 開發筆記 D031、D054）：以前的整行標題、「代號＋程式名稱」，用過越多次越前面 */
const pickTitle = (s, v) => hits(s.titles, v).map(x => ({ from: 0, text: x.t, note: `${x.n} 次` }));

/* 內文（見 開發筆記 D054）：以前寫過的內文行，標題欄現在這個標題底下寫過的排前面 */
function pickLine(s, v) {
  const t = $('newTitle').value.trim().replace(/\s+/g, ' ');
  const hs = hits(s.lines, v);
  return hs.filter(x => x.heads.includes(t)).concat(hs.filter(x => !x.heads.includes(t)))
    .map(x => ({ from: 0, text: x.t, note: `${x.n} 次` }));
}

/* 搜尋（見 開發筆記 D032、D054）：先列搜過的（整格對得上，搜越多次越前面），
   再列把最後一個詞補成內容裡的代號、程式名稱、人名的 */
function searchLog() {
  try { return JSON.parse(localStorage.getItem('daybook.searches')) || []; } catch { return []; }
}
function logSearch(q) {
  const log = searchLog();
  const x = log.find(y => y.q.toLowerCase() === q.toLowerCase());
  if (x) Object.assign(x, { q, n: x.n + 1, t: Date.now() }); else log.push({ q, n: 1, t: Date.now() });
  log.sort((a, b) => b.t - a.t);
  // 記在這台電腦，最多 200 筆（跟縮起來、文字模式一樣，見 開發筆記 D027）
  try { localStorage.setItem('daybook.searches', JSON.stringify(log.slice(0, 200))); } catch { /* 記不住就算了 */ }
}
function pickSearch(s, v) {
  const log = searchLog().sort((a, b) => b.n - a.n || b.t - a.t);
  const out = hits(log, v, x => x.q).map(x => ({ from: 0, text: x.q, note: `搜過 ${x.n} 次` }));
  const m = v.match(/\S+$/);
  if (m) out.push(...hits(s.words, m[0]).map(x => ({ from: m.index, text: x.t, note: `${x.n} 筆` })));
  return out;
}

const closeTitleSugg = suggest($('newTitle'), pickTitle);
const closeBodySugg = suggest($('newBody'), pickLine);
suggest($('q'), pickSearch, { enterThrough: true });

/* ---------- 新增表單：兩顆按鈕，加到待處理、或直接記成這一天的已處理（見 開發筆記 D025） ---------- */
function addNew(where) {
  const title = $('newTitle').value.trim();
  if (!title) { toast('標題不能空白', true); $('newTitle').focus(); return; }
  const src = where === 'done' ? st.day : 'todo';
  act(async () => {
    await api.addCard(src, { title, body: $('newBody').value });
    $('newTitle').value = '';
    $('newBody').value = '';
    closeTitleSugg();   // 程式清掉的字不會觸發 input 事件，提示要自己關
    closeBodySugg();
    await refreshAll();
    if (src !== 'todo') showNewDone();
    else if ($('todoCards').lastElementChild) $('todoCards').lastElementChild.scrollIntoView({ block: 'nearest' });
    $('newTitle').focus();
  });
}
/* Ctrl+Enter 加到待處理、Ctrl+Shift+Enter 加到已處理；標題只按 Enter 是換到內文 */
const addKey = e => {
  if (!isEnter(e) || !e.ctrlKey) return false;
  e.preventDefault();
  addNew(e.shiftKey ? 'done' : 'todo');
  return true;
};
$('newTitle').addEventListener('keydown', e => {
  if (addKey(e) || !isEnter(e)) return;
  e.preventDefault();
  $('newBody').focus();
});
$('newBody').addEventListener('keydown', addKey);
tabInsert($('newBody'));
$('newForm').addEventListener('submit', e => { e.preventDefault(); addNew('todo'); });
$('addDone').addEventListener('click', () => addNew('done'));

/* ---------- 其他事件 ---------- */
$('q').addEventListener('keydown', e => {
  if (isEnter(e)) {
    e.preventDefault();
    const q = $('q').value.trim().replace(/\s+/g, ' ');
    if (q) { logSearch(q); showSearch(q); }
  } else if (e.key === 'Escape') {
    $('q').value = '';
    openDay(st.day);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'F1') { e.preventDefault(); toggleHelp(); }   // 全部快捷鍵（見 開發筆記 D037）
  // 縮放（見 開發筆記 D042）：Ctrl+= 不用按 Shift；攔下來，選單的縮放才不會再跑一次
  if (e.ctrlKey && !e.altKey && ['=', '+', '-', '0'].includes(e.key)) { e.preventDefault(); stepZoom(e.key === '-' ? -1 : e.key === '0' ? 0 : 1); }
  if (!st.info || !st.info.dataDir) return;   // 還沒選資料夾：其他會動到資料的快捷鍵都不理（見 開發筆記 D041）
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (noteMode()) setNoteMode(false);   // 記事本時搜尋框看不到：先回到日記（D102）
    if (sideOff() || sideView() !== 'journal') showSide('journal');   // 左欄收起來、或放的是剪貼簿時搜尋框看不到：先打開日記本（D083、D093）
    $('q').focus(); $('q').select();
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && ['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) { e.preventDefault(); stepDay(e.key); }
  /* Ctrl+Z：游標在輸入框裡就交給輸入框自己復原打的字；不在的話復原上一個卡片動作（見 開發筆記 D028） */
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea')) {
    e.preventDefault();
    act(async () => {
      const label = await api.undo();
      toast(label ? `已復原：${label}` : '沒有可以復原的動作');
      await refreshAll();
    });
  }
});
$('backBtn').addEventListener('click', () => openDay(st.day));
$('modeBtn').addEventListener('click', async () => {
  await flushText();
  st.mode = st.mode === 'cards' ? 'text' : 'cards';
  try { localStorage.setItem('daybook.mode', st.mode); } catch { /* 記不住就算了 */ }
  await refreshAll();
});
$('dirBtn').addEventListener('click', async () => {
  if (await api.changeDir()) location.reload();
});

/* 黑暗模式（見 開發筆記 D034）：一鍵切換亮／暗，記在這台電腦；沒切過就跟 Windows 設定（theme.js 開頭就套上）。
   主程序也跟著切，視窗標題列才會一起變 */
const isDark = () => (document.documentElement.dataset.theme
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
const themeBtn = () => { $('themeBtn').textContent = isDark() ? '淺色模式' : '黑暗模式'; };
$('themeBtn').addEventListener('click', () => {
  const t = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('daybook.theme', t); } catch { /* 記不住就算了 */ }
  api.setTheme(t);
  themeBtn();
});
if (document.documentElement.dataset.theme) api.setTheme(document.documentElement.dataset.theme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeBtn);   // 跟系統時，Windows 切了按鈕字也要跟著換
themeBtn();

/* 匯出（見 開發筆記 D035）：按「匯出…」打開格式、起訖兩格日期；預設這週一到今天。
   格式是下拉選單（D078）：每次打開都重讀（擴充啟用、停用了就跟著變），選過的記在這台電腦，那個格式不在了就用第一個 */
function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function fillExportFormats() {
  const list = await api.exportFormats();
  let saved = null;
  try { saved = localStorage.getItem('daybook.exportFormat'); } catch { /* 記不住就算了 */ }
  $('expFmt').replaceChildren(...list.map(f => {
    const o = el('option', null, `${f.label}（.${f.extension}${f.ext ? `，擴充「${f.ext}」` : ''}）`);
    o.value = f.key;
    o.title = f.hint;
    return o;
  }));
  $('expFmt').value = list.some(f => f.key === saved) ? saved : list[0].key;
}
$('expFmt').addEventListener('change', () => {
  try { localStorage.setItem('daybook.exportFormat', $('expFmt').value); } catch { /* 記不住就算了 */ }
});
/* 打開匯出列：起訖沒填過就是這週一到今天。回顧那列的「匯出這段…」先填好起訖再叫這個（見 開發筆記 D088） */
function openExport() {
  $('exportBar').hidden = false;
  if (!$('expFrom').value || !$('expTo').value) {
    const [y, m, d] = st.info.today.split('-').map(Number);
    const t = new Date(y, m - 1, d);
    $('expFrom').value = isoOf(new Date(y, m - 1, d - ((t.getDay() + 6) % 7)));
    $('expTo').value = st.info.today;
  }
  act(fillExportFormats);
  $('expFrom').focus();
}
/* 「匯出…」在齒輪「設定」選單裡（D098）：按了一律打開（開著就停在原本填的），收起來用匯出列最後的 ✕ */
$('exportBtn').addEventListener('click', openExport);
$('expClose').addEventListener('click', () => { $('exportBar').hidden = true; });
/* ‹ ›：起日那一週的上一週／下一週，跟回顧一樣（stepWeek，見 開發筆記 D088）；起日清空了就從這週算 */
for (const [id, n] of [['expPrev', -1], ['expNext', 1]]) {
  $(id).addEventListener('click', () => {
    const w = stepWeek($('expFrom').value || st.info.today, n);
    $('expFrom').value = w.from;
    $('expTo').value = w.to;
  });
}
async function doExport(req) {
  await flushText();
  act(async () => {
    const file = await api.exportFile({ ...req, format: $('expFmt').value });
    if (file) toast('已匯出：' + file);
  });
}
$('expRange').addEventListener('click', () => doExport({ from: $('expFrom').value, to: $('expTo').value }));
$('expAll').addEventListener('click', () => doExport({ all: true }));

/* 備份（見 開發筆記 D097）：齒輪「設定」選單的「備份…」；文字模式打到一半的先存，再壓整個資料夾 */
$('backupBtn').addEventListener('click', async () => {
  await flushText();
  act(async () => {
    const file = await api.backup();
    if (file) toast('已備份：' + file);
  });
});

/* ---------- 底部狀態列（見 開發筆記 D037）：游標在哪就寫那裡能按的快捷鍵；F1 打開全部（index.html 的 #help）。
   改快捷鍵時這裡跟 #help 都要改 ---------- */
const HINTS = [
  ['#newTitle', [['↑↓', '選提示'], ['Tab', '帶入提示'], ['Enter', '換到內文'], ['Ctrl+Enter', '加到待處理'], ['Ctrl+Shift+Enter', '加到已處理']]],
  ['#newBody', [['↑↓', '選提示'], ['Tab', '帶入提示／縮排'], ['Ctrl+Enter', '加到待處理'], ['Ctrl+Shift+Enter', '加到已處理']]],
  ['#q', [['Enter', '搜尋'], ['↑↓', '選提示'], ['Tab', '帶入提示'], ['Esc', '關提示／清掉、回到那天']]],
  ['.upd-text', [['Enter', '存'], ['Esc', '取消']]],
  ['.cat-new', [['Enter', '加上並標記'], ['Esc', '取消']]],   // 標記的新分類（見 開發筆記 D076）
  ['.edit-title', [['Ctrl+Enter', '儲存']]],
  ['.edit-body', [['Tab', '縮排'], ['Ctrl+Enter', '儲存']]],
  ['#editor, #todo', [['Tab', '縮排']]],
  ['#dayList button', [['↑↓', '換日'], ['Alt+Home', '今天'], ['Ctrl+F', '搜尋'], ['Ctrl+Z', '復原']]],   // 見 開發筆記 D070
  // 剪貼簿（見 開發筆記 D093）
  ['.snip-copy', [['Enter', '複製內文'], ['Ctrl+Z', '復原']]],
  ['.snip-title-in', [['Enter', '換到內文'], ['Ctrl+Enter', '儲存']]],
  ['.snip-body-in', [['Tab', '縮排'], ['Ctrl+Enter', '儲存']]],
  // 記事本（見 開發筆記 D102）
  ['#noteText', [['Tab', '縮排'], ['', '停手就自動存']]],
  ['.note-rename', [['Enter', '改名'], ['Esc', '取消']]],
];
// 游標不在上面那些輸入框時
const HINT_DEFAULT = [['Ctrl+F', '搜尋'], ['Alt+← / Alt+→', '換日'], ['Alt+Home', '今天'], ['Ctrl+Z', '復原']];
function statusHints() {
  const a = document.activeElement;
  const hit = a && HINTS.find(([sel]) => a.matches(sel));
  const noData = st.info && !st.info.dataDir;   // 還沒選資料夾（見 開發筆記 D041）
  const box = $('statusKeys');
  box.textContent = '';
  for (const [k, d] of noData ? [['', '先選一個資料夾放工作紀錄']] : hit ? hit[1] : HINT_DEFAULT) {
    const s = el('span');
    if (k) s.append(el('kbd', null, k), ' ');
    s.append(d);
    box.appendChild(s);
  }
}
document.addEventListener('focusin', statusHints);
document.addEventListener('focusout', () => setTimeout(statusHints));   // focusout 當下 activeElement 還沒換好
statusHints();

/* ---------- 畫面縮放（見 開發筆記 D042）：Ctrl+= / Ctrl+- / Ctrl+0、Ctrl＋滾輪，整個畫面一起縮放；
   記在這台電腦（theme.js 開頭就套上），狀態列右邊顯示比例、點一下還原 ---------- */
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];   // 跟 Chrome 的級距一樣
let zoom = (() => { try { const z = Number(localStorage.getItem('daybook.zoom')); return ZOOMS.includes(z) ? z : 1; } catch { return 1; } })();
function setZoom(z) {
  zoom = z;
  api.setZoom(z);
  document.documentElement.style.setProperty('--zoom', String(z));   // 標題列不跟著縮放，照這個縮回去（見 開發筆記 D100）
  try { localStorage.setItem('daybook.zoom', String(z)); } catch { /* 記不住就算了 */ }
  $('zoomBtn').textContent = Math.round(z * 100) + '%';
}
function stepZoom(dir) {   // +1 放大、-1 縮小、0 還原
  if (!dir) return setZoom(1);
  const i = ZOOMS.indexOf(zoom);
  setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))]);
}
// 滾輪：累積到一格（100）才跳一級，觸控板捏合一次送很多小的才不會一下跳到底
let wheelSum = 0;
window.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  wheelSum += e.deltaY;
  if (Math.abs(wheelSum) < 100) return;
  stepZoom(wheelSum < 0 ? 1 : -1);
  wheelSum = 0;
}, { passive: false });
$('zoomBtn').addEventListener('click', () => stepZoom(0));
$('zoomBtn').textContent = Math.round(zoom * 100) + '%';

const toggleHelp = show => { $('help').hidden = !(show ?? $('help').hidden); };
$('helpBtn').addEventListener('click', () => toggleHelp());
$('helpClose').addEventListener('click', () => toggleHelp(false));
$('help').addEventListener('click', e => { if (e.target === $('help')) toggleHelp(false); });   // 點外面關掉

/* 說明（見 開發筆記 D048）：之後別的說明也放這頁。「檔案放在哪」打開時跟主程序拿這台電腦實際的路徑。
   給拿到 exe 的人看的（D049）：可攜版、安裝版兩格都列，正在用的那種標「你現在用的」；
   可攜版不是正在用的話，exe 在哪、解壓的資料夾叫什麼都不知道，寫說明不寫路徑 */
async function showInfo() {
  const f = await api.filesInfo();
  const put = (id, p, text) => {
    $(id).textContent = p ? p.path : text || '（還沒選）';
    $(id).toggleAttribute('data-missing', !!p && !p.exists);
    $(id).toggleAttribute('data-placeholder', !p && !!text);
  };
  put('fData', f.data);
  put('fUserData', f.userData);
  put('fPortable', f.portableExe, 'exe 放在哪就在哪');
  put('fUnpack', f.unpack, f.tempDir + '\\<每一版不同的名稱>');
  put('fInstalled', f.installed);
  put('fUpdater', f.updater);
  put('fNsu', f.nsu);   // 解除安裝程式的暫存複本（見 開發筆記 D050〈後續〉）
  $('fPortableNow').hidden = f.mode !== 'portable';
  $('fInstalledNow').hidden = f.mode !== 'installed';
  /* 開啟位置（見 開發筆記 D051）：位置目前沒有就變灰；不是可攜版時不知道 exe 在哪，不放；
     解壓的資料夾不知道名稱時打開暫存區 */
  const where = { data: f.data, userData: f.userData, portableExe: f.portableExe, unpack: f.unpack || { exists: true },
    installed: f.installed, updater: f.updater, nsu: f.nsu };
  for (const b of $('info').querySelectorAll('.openBtn[data-open]')) {
    const p = where[b.dataset.open];
    b.disabled = !p || !p.exists;
    b.title = b.disabled ? '這個位置目前沒有' : '用檔案總管打開';
  }
  $('info').querySelector('.openBtn[data-open="portableExe"]').hidden = !f.portableExe;
  $('info').hidden = false;
}
const closeInfo = () => { $('info').hidden = true; };
$('infoBtn').addEventListener('click', () => act(showInfo));
$('infoClose').addEventListener('click', closeInfo);
$('info').addEventListener('click', e => {
  if (e.target === $('info')) return closeInfo();   // 點外面關掉
  const b = e.target.closest('.openBtn');
  if (b) act(() => api.openLocation(b.dataset.open));
});

/* ---------- 格式頁（見 開發筆記 D055、D056、D078）：齒輪「設定」的「格式」（D092）。內建的匯入、匯出格式，裝了幾個擴充，請 AI 寫一個新的格式。
   擴充資料夾裡的每個擴充列在另一張（「管理擴充…」，D085），蓋在格式頁上面，可以搜尋。
   擴充的名稱、格式是別人的 package.json 寫的，一律放 textContent。
   未啟用的按「啟用」先展開提醒，再按「確定啟用」才真的啟用 ---------- */
const aiKind = () => ($('fmt').dataset.ai === 'export' ? 'export' : 'import');   // 要 AI 寫匯入還是匯出（D079）
async function showFmt() {
  const r = await api.extList();
  renderExts(r);
  $('aiPromptText').textContent = await api.aiPrompt(aiKind());
  $('fmt').hidden = false;
}
/* 擴充、外觀包清單的搜尋框（D085）：空白隔開的每個詞都要出現（同左上的搜尋，D023），不分大小寫；比的是每一列的 data-find。
   清單重畫（啟用、刪除、裝好）之後也再篩一次，搜的字留著 */
function filterList(table, find, noHit) {
  const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
  for (const tr of table.rows) tr.hidden = !words.every(w => tr.dataset.find.includes(w));
  noHit.hidden = !table.rows.length || [...table.rows].some(tr => !tr.hidden);
}
async function showExtList() {
  const r = await api.extList();
  $('extFind').value = '';
  renderExts(r);
  $('fExt').textContent = r.dir;
  $('extList').hidden = false;
  $('extFind').focus();
}
const EXT_STATE = { enabled: '已啟用', disabled: '未啟用', incompatible: '版本不合', broken: '壞掉了' };
const outText = f => `${f.label}（.${f.extension}，${f.hint}）`;   // 匯出格式：多寫副檔名
/* 擴充的程式什麼時候會跑：照它提供匯入、匯出哪幾種 */
const extWhen = x => [x.formats.length && '按「匯入…」', x.exportFormats.length && '匯出'].filter(Boolean).join('或');
function renderExts(r) {
  $('fmtBuiltin').textContent = r.builtin.map(f => `${f.label}（${f.hint}）`).join('、');
  $('fmtBuiltinOut').textContent = r.builtinExport.map(outText).join('、');
  const btn = (text, act) => { const b = el('button', 'openBtn extBtn', text); b.type = 'button'; b.dataset.act = act; return b; };
  $('extTable').replaceChildren(...r.exts.map(x => {
    const tr = el('tr');
    tr.dataset.ext = x.name;
    tr.dataset.folder = x.folder;   // 刪除用資料夾名稱找（壞掉的、name 重複的也刪得到，同外觀包，見 開發筆記 D073、D081）
    tr.dataset.find = [x.displayName, x.name, x.folder, ...x.formats.map(f => f.label), ...x.exportFormats.map(f => f.label)].join('\n').toLowerCase();
    const th = el('th', null, x.displayName);
    if (x.version) th.append(el('span', 'extVer', ' ' + x.version));
    const td = el('td');
    const state = el('span', 'extState', EXT_STATE[x.state] + (x.reason ? '：' + x.reason : ''));
    state.dataset.state = x.state;
    td.append(state);
    if (x.state === 'enabled') td.append(btn('停用', 'off'));
    if (x.state === 'disabled') td.append(btn('啟用', 'ask'));
    td.append(btn('刪除', 'delAsk'));
    if (x.formats.length) td.append(el('p', null, '匯入：' + x.formats.map(f => `${f.label}（${f.hint}）`).join('、')));
    if (x.exportFormats.length) td.append(el('p', null, '匯出：' + x.exportFormats.map(outText).join('、')));
    // 啟用、刪除都先問一次：按了展開底下那塊，再按「確定…」才做（D055、D081）
    const confirm = (kind, text, ok, cancel) => {
      const box = el('div', 'extConfirm');
      box.dataset.kind = kind;
      box.hidden = true;
      box.append(el('p', null, text), btn(ok[0], ok[1]), btn('取消', cancel));
      td.append(box);
    };
    if (x.state === 'disabled') {
      confirm('on', `「${x.displayName}」的程式會在你${extWhen(x)}時執行，可以讀寫你電腦上所有你能碰的檔案（跟 VS Code 的擴充一樣，沒有隔離）。確定是信得過的人給的再啟用。`,
        ['確定啟用', 'on'], 'cancel');
    }
    confirm('del', `把「${x.displayName}」的資料夾（${x.folder}）丟到資源回收筒？要救回來，到資源回收筒還原就好。`, ['確定刪除', 'del'], 'delCancel');
    tr.append(th, td);
    return tr;
  }));
  $('extNone').hidden = r.exts.length > 0;
  filterList($('extTable'), $('extFind'), $('extNoHit'));
  // 格式頁上的摘要（D085）
  $('extSum').textContent = r.exts.length ? `已裝 ${r.exts.length} 個、啟用 ${r.exts.filter(x => x.state === 'enabled').length} 個` : '還沒有裝';
}
/* 展開／收起「確定啟用」「確定刪除」那塊：一次只開一塊，開著的那塊的按鈕先藏起來 */
const EXT_ASK = { ask: ['on', true], cancel: ['on', false], delAsk: ['del', true], delCancel: ['del', false] };
function extAction(b) {
  const tr = b.closest('tr');
  if (EXT_ASK[b.dataset.act]) {
    const [kind, open] = EXT_ASK[b.dataset.act];
    for (const [k, askAct] of [['on', 'ask'], ['del', 'delAsk']]) {
      const box = tr.querySelector(`.extConfirm[data-kind="${k}"]`), ask = tr.querySelector(`[data-act="${askAct}"]`);
      if (!box) continue;
      box.hidden = !(open && k === kind);
      ask.hidden = !box.hidden;
    }
    return;
  }
  if (b.dataset.act === 'del') {
    const name = tr.querySelector('th').firstChild.textContent;
    return act(async () => { renderExts(await api.deleteExt(tr.dataset.folder)); toast('已丟到資源回收筒：' + name); });
  }
  act(async () => renderExts(await api.enableExt(tr.dataset.ext, b.dataset.act === 'on')));
}

/* 請 AI 寫一個新的格式（見 開發筆記 D056）：貼回來的先由主程序檢查（不執行），過了才試跑（匯入選檔來拆；匯出拿資料夾裡的紀錄匯出，D079）；
   預覽裡按「安裝並啟用」，主程序裝的是試跑過的那一份。框裡的字一改、換寫匯入或匯出，預覽就作廢、要重新試跑 */
let aiToken = null, aiName = null, aiDone = null;   // 預覽通過的那一份；aiDone 是那一份的種類（裝好之後的提示用）
let aiFail = null;   // 沒通過的那次 { kind, stage, errors, excerpt }：「複製給 AI」用（見 開發筆記 D061）
function aiShow(build) {
  const box = $('aiResult');
  box.replaceChildren();
  box.className = '';
  aiToken = aiName = aiDone = null;
  if (build) build(box);
  box.hidden = !build;
}
function aiErrors(r) {
  aiShow(box => {
    box.className = 'aiErr';
    box.append(el('p', null, r.stage === 'check' ? '檢查沒通過，程式沒有執行：' : '試跑沒通過，沒有安裝：'));
    const ul = el('ul');
    for (const m of r.errors) ul.append(el('li', null, m));
    box.append(ul);
    // 試跑看不出原因的錯誤附了檔案開頭，一起給 AI（見 開發筆記 D061）
    if (r.excerpt) box.append(el('p', null, '你的檔案開頭（會一起複製給 AI，讓它看得出哪裡不對）：'), el('pre', null, r.excerpt.join('\n')));
    const b = el('button', 'openBtn', '複製給 AI');
    b.id = 'aiFeedback';
    b.type = 'button';
    box.append(el('p', null, '按「複製給 AI」，貼回給 AI 請它照著改，再把新的那段貼進來。'), b);
  });
  aiFail = r;
}
/* 匯出格式的預覽（D079）：拿資料夾裡全部的紀錄匯出，每一種格式列大小、文字的開頭，可以存一份打開來看 */
function aiExportPreview(box, p) {
  box.append(el('p', null, `「${p.displayName}」${p.version}，匯出格式：` + p.outputs.map(outText).join('、')));
  if (p.replaces) box.append(el('p', 'aiWarn', `會取代已經裝的「${p.replaces.displayName}」${p.replaces.version}。`));
  box.append(el('p', null, `試跑：拿資料夾裡全部的紀錄（${p.days} 天${p.todo ? '＋待處理' : ''}）匯出`));
  const size = n => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);
  p.outputs.forEach((o, i) => {
    const day = el('div', 'aiDay');
    const save = el('button', 'openBtn aiSave', '存一份看看…');
    save.type = 'button';
    save.dataset.i = i;
    day.append(el('b', null, `${o.label}（.${o.extension}）：` + (o.text ? `文字 ${o.lines} 行` : '二進位檔') + `，${size(o.size)}`), save);
    if (o.text) day.append(el('pre', null, o.head + (o.more ? `\n…（還有 ${o.more} 行）` : '')));
    box.append(day);
  });
  box.append(el('p', 'aiWarn', `「${p.displayName}」的程式會在你匯出時執行，可以讀寫你電腦上所有你能碰的檔案（daybook 的檢查擋得住一般寫法，擋不住刻意繞過的）。上面匯出的對，再安裝。`));
}
function aiPreview(p) {
  aiShow(box => {
    box.className = 'aiOk';
    if (p.kind === 'export') aiExportPreview(box, p);
    else aiImportPreview(box, p);
    const b = el('button', 'openBtn', '安裝並啟用');
    b.id = 'aiInstall';
    b.type = 'button';
    box.append(b);
  });
  aiToken = p.token;
  aiName = p.displayName;
  aiDone = p.kind;
}
function aiImportPreview(box, p) {
  box.append(el('p', null, `「${p.displayName}」${p.version}，格式：` + p.formats.map(f => `${f.label}（${f.hint}）`).join('、')));
  if (p.replaces) box.append(el('p', 'aiWarn', `會取代已經裝的「${p.replaces.displayName}」${p.replaces.version}。`));
  // 別的格式也認得這個檔：試跑用的是 AI 寫的，匯入時會問用哪一種（見 開發筆記 D058）
  if (p.also.length) box.append(el('p', null, `${p.also.join('、')}也認得這個檔，匯入時會問你這次要用哪一種。`));
  const sum = [`試跑 ${p.file}：拆出 ${p.days} 天` + (p.days ? `（${p.first} ～ ${p.last}）` : '')];
  // 已經有的：匯入時會問要加進去還是略過（見 開發筆記 D063）
  if (p.existing) sum.push(`其中 ${p.existing} 天資料夾裡已經有，匯入時會問要加進去還是略過`);
  if (p.todoLines) sum.push(`待處理 ${p.todoLines} 行` + (p.todoExisting ? '（資料夾裡的待處理已經有內容，匯入時一起問）' : ''));
  box.append(el('p', null, sum.join('；')));
  for (const s of p.samples) {
    const day = el('div', 'aiDay');
    day.append(el('b', null, s.date), el('pre', null, s.text + (s.more ? `\n…（還有 ${s.more} 行）` : '')));
    box.append(day);
  }
  box.append(el('p', 'aiWarn', `「${p.displayName}」的程式會在你按「匯入…」時執行，可以讀寫你電腦上所有你能碰的檔案（daybook 的檢查擋得住一般寫法，擋不住刻意繞過的）。上面拆出來的對，再安裝。`));
}
$('aiCopy').addEventListener('click', () => act(async () => {
  await api.aiCopy(aiKind());
  toast('prompt 已複製：貼到 Gemini 或 ChatGPT 的對話框，' + (aiKind() === 'export' ? '再寫你要的檔案長怎樣' : '再貼你的檔案開頭幾十行'));
}));
$('aiGemini').addEventListener('click', () => act(() => api.aiOpen('gemini')));
$('aiChatgpt').addEventListener('click', () => act(() => api.aiOpen('chatgpt')));
$('aiReply').addEventListener('input', () => aiShow(null));
// 換寫匯入或匯出（D079）：說明的字、prompt 跟著換，上一次的結果作廢
$('fmt').addEventListener('change', e => {
  if (e.target.name !== 'aiKind') return;
  $('fmt').dataset.ai = e.target.value;
  aiShow(null);
  act(async () => { $('aiPromptText').textContent = await api.aiPrompt(aiKind()); });
});
$('aiTry').addEventListener('click', () => act(async () => {
  if (!$('aiReply').value.trim()) return toast('先把 AI 回的那段貼進框裡', true);
  const r = await api.aiTry($('aiReply').value, aiKind());
  if (!r) return;   // 選檔取消
  if (r.errors) aiErrors(r);
  else aiPreview(r);
}));
$('aiResult').addEventListener('click', e => {
  if (e.target.closest('#aiFeedback')) {
    const r = aiFail;
    return act(async () => { await api.aiFeedback(r); toast('已複製：貼回給 AI，請它照著改'); });
  }
  const save = e.target.closest('.aiSave');
  if (save) {
    const token = aiToken;
    return act(async () => { const f = await api.aiSave(token, Number(save.dataset.i)); if (f) toast('已存：' + f); });
  }
  if (!e.target.closest('#aiInstall')) return;
  const token = aiToken, name = aiName, kind = aiDone;
  act(async () => {
    renderExts(await api.aiInstall(token));
    aiShow(box => {
      box.className = 'aiOk';
      box.append(el('p', null, `已安裝並啟用「${name}」：之後` + (kind === 'export' ? '在齒輪「設定」的「匯出…」選這個格式。' : '用齒輪「設定」的「匯入…」匯入。')));
    });
  });
});

const closeFmt = () => { $('fmt').hidden = true; };
$('fmtBtn').addEventListener('click', () => act(showFmt));
$('fmtClose').addEventListener('click', closeFmt);
$('fmt').addEventListener('click', e => {
  if (e.target === $('fmt')) closeFmt();   // 點外面關掉
});
const closeExtList = () => { $('extList').hidden = true; };
$('extManage').addEventListener('click', () => act(showExtList));
$('extListClose').addEventListener('click', closeExtList);
$('extFind').addEventListener('input', () => filterList($('extTable'), $('extFind'), $('extNoHit')));
$('extList').addEventListener('click', e => {
  if (e.target === $('extList')) return closeExtList();   // 點外面只關這張，回到格式頁
  const ext = e.target.closest('.extBtn');
  if (ext) return extAction(ext);
  const b = e.target.closest('.openBtn[data-open]');
  if (b) act(() => api.openLocation(b.dataset.open));
});

/* ---------- 外觀（見 開發筆記 D062）：齒輪「設定」的「外觀」（D092）。外觀包資料夾裡的每個外觀包，一次啟用一個（只有圖、不跑程式，按一下就換）。
   背景圖淡淡蓋在整個畫面上、點得穿過去（黑暗模式暗一點，見 style.css 的 #skinBg）；
   空白時的插圖放在「這天還沒有處理過的事」「沒有待處理的事」上面（emptyBox）。
   外觀包的名稱是別人的 package.json 寫的，一律放 textContent ---------- */
/* 背景圖放哪（D066）：cover 鋪滿（style.css 的預設），其他九個照 size（佔畫面寬幾 %）放在那個位置。
   一張一層（D067：每張的濃淡不一樣，要分開的元素才做得到），後面的疊在上面。真的背景圖、「用圖檔做一個」的小畫面預覽共用 */
const BG_POS = { 'top-left': 'left top', top: 'center top', 'top-right': 'right top', left: 'left center', center: 'center center',
  right: 'right center', 'bottom-left': 'left bottom', bottom: 'center bottom', 'bottom-right': 'right bottom' };
function placeBg(box, b) {
  const cover = !BG_POS[b.position];
  box.style.backgroundImage = `url("${b.url}")`;
  box.style.opacity = String(b.opacity);
  box.style.backgroundPosition = cover ? '' : BG_POS[b.position];
  box.style.backgroundSize = cover ? '' : `${b.size}% auto`;
}
function bgLayers(box, list) {
  box.replaceChildren(...list.map(b => { const d = el('div', 'skinLayer'); placeBg(d, b); return d; }));
}
async function applySkin() {
  const s = await api.skinLoad();
  const list = (s && s.background) || [];
  $('skinBg').hidden = !list.length;
  bgLayers($('skinBg'), list);
  skinEmpty = s && s.empty ? s.empty.url : null;
}
async function showSkin() {
  const r = await api.skinList();
  renderSkins(r);
  $('sizeReset').disabled = !sized();   // 沒拉過就變灰（D075）
  $('skin').hidden = false;
  mkPreview();
}
/* 外觀包的清單列在另一張（「管理外觀包…」，D085），蓋在外觀頁上面，可以搜尋（同擴充清單） */
async function showSkinList() {
  const r = await api.skinList();
  $('skinFind').value = '';
  renderSkins(r);
  $('fSkins').textContent = r.dir;
  $('skinList').hidden = false;
  $('skinFind').focus();
}
function renderSkins(r) {
  const btn = (text, act) => { const b = el('button', 'openBtn extBtn', text); b.type = 'button'; b.dataset.act = act; return b; };
  $('skinTable').replaceChildren(...r.skins.map(x => {
    const tr = el('tr');
    tr.dataset.skin = x.name;
    tr.dataset.folder = x.folder;   // 刪除用資料夾名稱找（壞掉的、name 重複的也刪得到，見 開發筆記 D073）
    tr.dataset.find = [x.displayName, x.name, x.folder].join('\n').toLowerCase();
    const th = el('th', null, x.displayName);
    if (x.version) th.append(el('span', 'extVer', ' ' + x.version));
    const td = el('td');
    const state = el('span', 'extState', EXT_STATE[x.state] + (x.reason ? '：' + x.reason : ''));
    state.dataset.state = x.state;
    td.append(state);
    if (x.state === 'enabled') td.append(btn('停用', 'off'));
    if (x.state === 'disabled') td.append(btn('啟用', 'on'));
    td.append(btn('刪除', 'ask'));
    if (x.parts.length) td.append(el('p', null, '有：' + x.parts.join('、')));
    // 刪除先問一次（同擴充的「確定啟用」，D055）：按「刪除」展開，再按「確定刪除」才丟資源回收筒
    const box = el('div', 'extConfirm');
    box.hidden = true;
    box.append(el('p', null, `把「${x.displayName}」的資料夾（${x.folder}）丟到資源回收筒？要救回來，到資源回收筒還原就好。`),
      btn('確定刪除', 'del'), btn('取消', 'cancel'));
    td.append(box);
    tr.append(th, td);
    return tr;
  }));
  $('skinNone').hidden = r.skins.length > 0;
  filterList($('skinTable'), $('skinFind'), $('skinNoHit'));
  // 外觀頁上的摘要（D085）：一次只啟用一個，寫是哪一個
  const on = r.skins.find(x => x.state === 'enabled');
  $('skinSum').textContent = r.skins.length ? `已裝 ${r.skins.length} 個、` + (on ? `用的是「${on.displayName}」` : '沒有啟用') : '還沒有';
}
function skinAction(b) {
  const tr = b.closest('tr');
  const ask = tr.querySelector('[data-act="ask"]'), box = tr.querySelector('.extConfirm');
  if (b.dataset.act === 'ask' || b.dataset.act === 'cancel') {
    box.hidden = b.dataset.act === 'cancel';
    ask.hidden = !box.hidden;
    return;
  }
  act(async () => {
    if (b.dataset.act === 'del') {
      renderSkins(await api.deleteSkin(tr.dataset.folder));
      toast('已丟到資源回收筒：' + tr.querySelector('th').firstChild.textContent);
    } else {
      renderSkins(await api.enableSkin(tr.dataset.skin, b.dataset.act === 'on'));
    }
    await applySkin();
    if (!isBusy()) await refreshCenter();   // 空白時的插圖跟著換；有卡片在編輯就先不重畫（同外部改檔，D020）
  });
}
const closeSkin = () => { $('skin').hidden = true; };
$('skinBtn').addEventListener('click', () => act(showSkin));
$('skinClose').addEventListener('click', closeSkin);
$('skin').addEventListener('click', e => {
  if (e.target === $('skin')) closeSkin();   // 點外面關掉
});
const closeSkinList = () => { $('skinList').hidden = true; };
$('skinManage').addEventListener('click', () => act(showSkinList));
$('skinListClose').addEventListener('click', closeSkinList);
$('skinFind').addEventListener('input', () => filterList($('skinTable'), $('skinFind'), $('skinNoHit')));
$('skinList').addEventListener('click', e => {
  if (e.target === $('skinList')) return closeSkinList();   // 點外面只關這張，回到外觀頁
  const b = e.target.closest('.extBtn');
  if (b) return skinAction(b);
  const o = e.target.closest('.openBtn[data-open]');
  if (o) act(() => api.openLocation(o.dataset.open));
});

/* ---------- 用圖檔做一個外觀包（見 開發筆記 D066、D067）：選圖 → 要的話去背（cutout.js）→ 背景圖每張各自調濃淡、位置、大小 → 建立並啟用。
   一張圖一格 { box, name, src: 選的原檔, out: 要存的, job, timer, pos }：沒去背 out 就是原檔（照原樣存、不重新編碼，gif 會動的照樣會動），去背是 png。
   背景圖可以好幾張（mk.bgs，照順序、後面的疊在上面，格子照 #mkBgTpl 一張開一個）；空白時的插圖一張（mk.empty，格子固定在頁面上） ---------- */
const mk = { bgs: [], empty: null };
const CAN_CUT = /^data:image\/(png|jpeg|webp);/;   // gif（只會拿到第一格）、svg（向量圖）不去背
const mkQ = (s, sel) => s.box.querySelector(sel);
const mkEmptyBox = () => $('mk').querySelector('.mkPart[data-part="empty"]');
const slotOf = box => (box.dataset.part === 'empty' ? mk.empty : mk.bgs.find(s => s.box === box));
const mkAlive = s => s === mk.empty || mk.bgs.includes(s);
const mkBgOf = s => ({ url: s.out, opacity: Number(mkQ(s,'.mkOpacity').value) / 100, position: s.pos, size: Number(mkQ(s,'.mkSize').value) });

/* 小畫面預覽、數字、按鈕狀態跟著目前的設定 */
function mkPreview() {
  bgLayers($('mkScreenBg'), mk.bgs.map(mkBgOf));
  $('mkScreenRow').hidden = !mk.bgs.length;
  $('mkScreen').style.aspectRatio = `${innerWidth} / ${innerHeight}`;   // 跟現在的視窗一樣比例，位置、大小才看得準
  mk.bgs.forEach((s, i) => {
    mkQ(s,'.mkNo').textContent = `第 ${i + 1} 張`;
    mkQ(s,'.mkOpacityV').textContent = `${mkQ(s,'.mkOpacity').value}%`;
    const cover = s.pos === 'cover';
    mkQ(s,'.mkSize').disabled = cover;
    mkQ(s,'.mkSizeV').textContent = cover ? '鋪滿時不用調' : `畫面寬的 ${mkQ(s,'.mkSize').value}%`;
    for (const b of s.box.querySelectorAll('.mkPos button')) b.classList.toggle('on', b.dataset.pos === s.pos);
  });
  for (const box of $('mk').querySelectorAll('.mkPart')) {
    box.querySelector('.mkTolBox').classList.toggle('off', !box.querySelector('.mkCut').checked);
    box.querySelector('.mkTolV').textContent = box.querySelector('.mkTol').value;
  }
  $('mkBgAdd').textContent = mk.bgs.length ? '＋ 再加一張…' : '選圖…';
  $('mkCreate').disabled = !mk.bgs.length && !mk.empty;
}

/* 去背：畫到 canvas、拿出像素給 cutout、存成 png；沒勾就用原檔。拖滑桿時會連續來好幾次，只留最後一次的結果 */
async function mkProcess(s) {
  const job = s.job = (s.job || 0) + 1;
  let out = s.src;
  if (mkQ(s,'.mkCut').checked) {
    const img = new Image();
    img.src = s.src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    cutout(d, Number(mkQ(s,'.mkTol').value));
    g.putImageData(d, 0, 0);
    out = c.toDataURL('image/png');
  }
  if (!mkAlive(s) || s.job !== job) return;   // 處理的時候拿掉了、又動了設定
  s.out = out;
  mkQ(s,'.mkThumb').src = out;
  mkPreview();
}

/* 選圖：背景圖是多加一張（取消就不加）；插圖是換掉那一張 */
async function mkPick(kind) {
  const r = await api.skinPick();
  if (!r) return;
  let s;
  if (kind === 'empty') {
    s = mk.empty = { box: mkEmptyBox() };
  } else {
    s = { box: $('mkBgTpl').content.firstElementChild.cloneNode(true), pos: 'cover' };
    mk.bgs.push(s);
    $('mkBgList').append(s.box);
  }
  Object.assign(s, { name: r.name, src: r.url, out: r.url });
  mkQ(s,'.mkFile').textContent = r.name;
  mkQ(s,'.mkBody').hidden = false;
  mkQ(s,'.mkDrop').hidden = false;
  const can = CAN_CUT.test(r.url);
  mkQ(s,'.mkCut').checked = false;
  mkQ(s,'.mkCut').disabled = !can;
  mkQ(s,'.mkNoCut').hidden = can;
  await mkProcess(s);
}

/* 不用了：背景圖那張整格拿掉；插圖那格收起來 */
function mkDrop(s) {
  if (s === mk.empty) {
    mk.empty = null;
    mkQ(s,'.mkFile').textContent = '';
    mkQ(s,'.mkBody').hidden = true;
    mkQ(s,'.mkDrop').hidden = true;
    mkQ(s,'.mkThumb').removeAttribute('src');
  } else {
    mk.bgs = mk.bgs.filter(x => x !== s);
    s.box.remove();
  }
  mkPreview();
}

async function mkCreate() {
  const r = await api.skinCreate({ displayName: $('mkName').value, background: mk.bgs.length ? mk.bgs.map(mkBgOf) : null, empty: mk.empty && { url: mk.empty.out } });
  renderSkins(r);
  await applySkin();
  if (!isBusy()) await refreshCenter();   // 空白時的插圖跟著換（同啟用）
  const made = r.skins.find(x => x.name === r.name);
  toast(`做好「${made ? made.displayName : r.name}」並啟用了`);
  for (const s of [...mk.bgs]) mkDrop(s);
  if (mk.empty) mkDrop(mk.empty);
  $('mkName').value = '我的外觀';
}

$('mk').addEventListener('click', e => {
  const box = e.target.closest('.mkPart');
  const s = box && slotOf(box);
  if (e.target.closest('#mkBgAdd')) return act(() => mkPick('background'));
  if (e.target.closest('.mkPick')) return act(() => mkPick('empty'));   // 只有插圖那格有「選圖…」
  if (e.target.closest('.mkDrop')) return s && mkDrop(s);
  const p = e.target.closest('.mkPos button');
  if (p && s) { s.pos = p.dataset.pos; return mkPreview(); }
  if (e.target.closest('#mkCreate')) return act(mkCreate);
});
$('mk').addEventListener('input', e => {
  mkPreview();
  if (!e.target.matches('.mkCut, .mkTol')) return;
  const s = slotOf(e.target.closest('.mkPart'));
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => act(() => mkProcess(s)), e.target.matches('.mkTol') ? 150 : 0);   // 拖滑桿停一下才重算
});

// Esc 關掉（設定的小選單、快捷鍵表、說明、格式、外觀）：在 capture 階段先攔下來，搜尋框的 Esc（清掉搜尋字）才不會一起跑
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || ($('settingsMenu').hidden && $('help').hidden && $('info').hidden && $('fmt').hidden && $('skin').hidden && $('extList').hidden && $('skinList').hidden)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!$('settingsMenu').hidden) { settingsMenu(false); return; }   // 選單開著時只收選單（D092）
  // 擴充、外觀包的清單蓋在格式頁、外觀頁上面：先只關它，回到底下那頁（D085）
  if (!$('extList').hidden || !$('skinList').hidden) {
    closeExtList();
    closeSkinList();
    return;
  }
  toggleHelp(false);
  closeInfo();
  closeFmt();
  closeSkin();
}, true);

/* 外部改了檔（見 開發筆記 D020）：文字模式下有未存的修改就保留畫面上的；
   卡片模式下有卡片在編輯就先不重畫中間；剪貼簿也一樣，在編輯剪貼簿就先不重畫（D093）。
   記事本（D102）：開著才重讀；只有記事本的檔變了（多半是自己存的）日記就不重畫 */
api.onChanged(async files => {
  if (noteMode()) await refreshNotes();
  if (files.every(f => f.startsWith('記事本/'))) return;   // paths.js 的 NOTE_DIR
  sugg = null;   // 自動補完的候選跟著作廢（見 開發筆記 D031）
  await refreshDays();
  if (!isBusy()) await refreshCenter();
  if (!snipBusy()) await refreshSnips();
});

/* 還沒選資料夾（見 開發筆記 D041）：蓋一張「選擇資料夾」的卡片；選好就重新載入 */
function showSetup() {
  $('setup').hidden = false;
  if (st.info.lostDir) {
    $('setupLost').hidden = false;
    $('setupLost').textContent = `原本的資料夾找不到了：${st.info.lostDir}（隨身碟沒插、或被搬走？放回原位再開，或重新選一個）`;
  }
  statusHints();
  $('setupPick').focus();
}
$('setupPick').addEventListener('click', async () => {
  if (await api.changeDir()) location.reload();
});

/* 匯入（見 開發筆記 D044、D047）：已經有的日子略過、或加進去（D063）；結果字比較多，提示留久一點。寫出認成哪種格式 */
function importSummary(r) {
  const parts = [`匯入 ${r.written} 天（${r.format}）`];
  if (r.skipped.length) {
    const list = r.skipped.slice(0, 5).map(d => d.slice(5)).join('、') + (r.skipped.length > 5 ? '…' : '');
    parts.push(`跳過 ${r.skipped.length} 天（資料夾裡已經有了：${list}）`);
  }
  if (r.merged) {
    const what = r.merged.days ? ` ${r.merged.days} 天` + (r.merged.todo ? '和待處理' : '') : '待處理';
    parts.push(`資料夾裡已經有的${what}：加進 ${r.merged.added} 筆` + (r.merged.dup ? `，${r.merged.dup} 筆一模一樣的沒加` : ''));
  }
  if (r.todoLines) parts.push(`待處理 ${r.todoLines} 行`);
  if (r.todoSkipped) parts.push('待處理已經有內容，檔案裡的待處理沒匯');
  return parts.join('；') + (r.written || r.todoLines || (r.merged && r.merged.added) ? '（Ctrl+Z 可以整批復原）' : '');
}
$('importBtn').addEventListener('click', () => act(async () => {
  await flushText();
  const r = await api.importFile();
  if (!r) return;
  toast(importSummary(r), false, 10000);
  await refreshAll();
}));
// 還沒選資料夾時：先選資料夾、再選檔案；匯完重新載入，結果留到載入後再顯示
$('setupImport').addEventListener('click', async () => {
  if (!(await api.changeDir())) return;
  let note = null;
  try {
    const r = await api.importFile();
    if (r) note = { msg: importSummary(r) };
  } catch (e) {
    note = { msg: errMsg(e), err: true };
  }
  try { if (note) sessionStorage.setItem('daybook.toast', JSON.stringify(note)); } catch { /* 顯示不了就算了 */ }
  location.reload();
});

(async () => {
  st.info = await api.info();
  $('titleText').textContent = `daybook ${st.info.version}`;   // 跟視窗標題一樣帶版本號（D039、D100）
  $('dirPath').textContent = st.info.dataDir || '';
  $('dirPath').title = st.info.dataDir || '';
  $('dirBtn').disabled = !st.info.canChangeDir;
  // 外觀包（見 開發筆記 D062）：第一次畫卡片前先放好，空白時的插圖才不會晚一步才出現；讀不到圖照原本的樣子開
  try { await applySkin(); } catch (e) { toast(errMsg(e), true); }
  if (!st.info.dataDir) { showSetup(); return; }
  st.day = st.info.today;
  st.calMonth = st.day.slice(0, 7);
  await refreshAll();
  // 選資料夾卡片上的「匯入…」重新載入前留下的結果（見 開發筆記 D044）
  try {
    const note = JSON.parse(sessionStorage.getItem('daybook.toast'));
    sessionStorage.removeItem('daybook.toast');
    if (note) toast(note.msg, note.err, 10000);
  } catch { /* 沒有就算了 */ }
})();
