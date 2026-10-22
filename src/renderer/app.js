/* ============================================================
   daybook 畫面：左邊搜尋＋日期清單；中間上面「這一天已處理」、下面「待處理」（見 開發筆記 D024），
   搜尋／時間軸時中間換成結果。卡片見 D021、D022；搜尋與時間軸見 D023；文字模式見 D020。
   檔案一律透過 window.daybook（preload）讀寫。
   ============================================================ */
'use strict';
const api = window.daybook;
const $ = id => document.getElementById(id);
const WEEK = '日一二三四五六';

const st = {
  info: null,
  day: null,          // 正在看（或最後看）的那一天
  view: 'day',        // day | search | timeline
  q: '',              // 搜尋字
  by: null,           // 時間軸：{ code } 或 { event }
  focus: null,        // 打開那天之後要捲到第幾筆
  showHidden: false,  // 待處理底下「已隱藏」有沒有展開（見 開發筆記 D026）
  counts: { done: null, todo: null },   // 標題列寫的筆數（文字模式不算）
  // 已處理、待處理有沒有縮起來，記在這台電腦（見 開發筆記 D027）
  collapsed: (() => { try { return JSON.parse(localStorage.getItem('daybook.collapsed')) || {}; } catch { return {}; } })(),
  mode: (() => { try { return localStorage.getItem('daybook.mode') === 'text' ? 'text' : 'cards'; } catch { return 'cards'; } })(),
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
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 2500);
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
function autosave(area, save) {
  const s = { dirty: false, timer: null };
  s.flush = async () => {
    clearTimeout(s.timer);
    if (!s.dirty) return;
    s.dirty = false;
    showSave('存檔中…');
    await save(area.value);
    showSave(s.dirty ? '未存檔' : '已存檔');
  };
  area.addEventListener('input', () => {
    s.dirty = true;
    showSave('未存檔');
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

/* 一張卡片。editable：能改（某一天的已處理、待處理）；否則是搜尋／時間軸裡唯讀的，前面標日期 */
function card(c, { src, editable, showSrc }) {
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
  box.appendChild(head);

  if ((c.codes && c.codes.length) || c.event != null) box.appendChild(chips(c));
  if (c.body.length) {
    const body = el('div', 'body');
    for (const l of c.body) body.appendChild(el('div', l.trim().startsWith('->') ? 'line upd-line' : 'line', l));
    box.appendChild(body);
  }
  if (editable && c.title) addActions(box, c, src);
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

  row.appendChild(button('upd', '+ 更新', () => { updBox.hidden = !updBox.hidden; if (!updBox.hidden) input.focus(); }));
  if (src === 'todo') {
    const done = button('done', '處理完 ↑', () => act(async () => {
      await api.markDone(c.index, c.raw, st.day);
      toast(`已移到 ${st.day.slice(5)} 已處理`);
      await refreshAll();
    }));
    done.title = '整筆（含進展）搬到上面這一天的已處理';
    row.appendChild(done);
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
  box.append(row, updBox);
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
    // 狀態、隱藏不在這裡改（在卡片上一鍵切換），原本的照舊留著
    await api.editCard(src, c.index, c.raw, { title: t.value, body: b.value, status: c.status, hidden: c.hidden, event: c.event });
    await refreshAll();
  });
  for (const area of [t, b]) area.addEventListener('keydown', e => { if (isEnter(e) && e.ctrlKey) { e.preventDefault(); save(); } });
  const row = el('div', 'actions');
  row.append(button('save', '儲存（Ctrl+Enter）', save), button('cancel', '取消', () => refreshAll()));
  box.append(t, b, row);
  b.focus();
}

/* 有卡片在編輯、或更新框打了字：外部改檔時先不重畫，免得打到一半被洗掉 */
const isBusy = () => !!document.querySelector('.card.editing') || [...document.querySelectorAll('.upd-text')].some(i => i.value.trim());

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
  $('backBtn').hidden = day;
  $('modeBtn').hidden = !day;
  $('modeBtn').textContent = cards ? '文字模式' : '卡片模式';
  paneHeads();
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
}
$('doneHead').addEventListener('click', () => togglePane('done'));
$('todoHead').addEventListener('click', () => togglePane('todo'));

async function renderList(box, src, emptyText) {
  box.textContent = '';
  const cards = await api.listCards(src);
  for (const c of cards) box.appendChild(card(c, { src, editable: true }));
  if (!cards.length) box.appendChild(el('div', 'empty', emptyText));
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
  /* 隱藏的收在最底下「已隱藏 N 筆」，點一下展開／收起（見 開發筆記 D026） */
  const box = $('todoCards');
  box.textContent = '';
  const cards = await api.listCards('todo');
  const shown = cards.filter(c => !c.hidden);
  const hidden = cards.filter(c => c.hidden);
  st.counts.todo = shown.length;
  paneHeads();
  for (const c of shown) box.appendChild(card(c, { src: 'todo', editable: true }));
  if (!shown.length) box.appendChild(el('div', 'empty', hidden.length ? '沒有待處理的事（有隱藏的）' : '沒有待處理的事'));
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

function renderResults(title, items) {
  $('dayTitle').textContent = title;
  const box = $('results');
  box.textContent = '';
  for (const it of items) box.appendChild(card(it, { src: it.src, editable: false, showSrc: true }));
  if (!items.length) box.appendChild(el('div', 'empty', '沒有找到'));
}

async function refreshCenter() {
  layout();
  if (st.view === 'search') {
    const items = await api.search(st.q);
    renderResults(`搜尋「${st.q}」：${items.length} 筆` + (items.length >= 300 ? '（只列前 300 筆）' : ''), items);
  } else if (st.view === 'timeline') {
    const items = await api.timeline(st.by);
    renderResults(st.by.code != null ? `${st.by.code} 時間軸：${items.length} 筆` : `事件 ^${st.by.event}：${items.length} 筆`, items);
  } else {
    await renderDay();
    await renderTodo();
  }
}

async function openDay(date, focusIndex) {
  await flushText();
  st.view = 'day';
  st.day = date;
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

/* ---------- 左：日期清單 ---------- */
async function refreshDays() {
  const days = await api.listDays();
  if (!days.includes(st.info.today)) days.unshift(st.info.today);
  const nav = $('dayList');
  nav.textContent = '';
  let month = null;
  for (const date of days) {
    if (date.slice(0, 7) !== month) {
      month = date.slice(0, 7);
      nav.appendChild(el('h3', null, month));
    }
    const b = button(null, shortDate(date), () => openDay(date));
    b.dataset.date = date;
    b.classList.toggle('on', st.view === 'day' && date === st.day);
    nav.appendChild(b);
  }
}

async function refreshAll() {
  await refreshDays();
  await refreshCenter();
}

/* ---------- 新增表單：兩顆按鈕，加到待處理、或直接記成這一天的已處理（見 開發筆記 D025） ---------- */
function addNew(where) {
  const title = $('newTitle').value.trim();
  if (!title) { toast('標題不能空白', true); $('newTitle').focus(); return; }
  const src = where === 'done' ? st.day : 'todo';
  act(async () => {
    await api.addCard(src, { title, body: $('newBody').value });
    $('newTitle').value = '';
    $('newBody').value = '';
    await refreshAll();
    const list = src === 'todo' ? $('todoCards') : $('cards');
    if (list.lastElementChild) list.lastElementChild.scrollIntoView({ block: 'nearest' });
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
    const q = $('q').value.trim();
    if (q) showSearch(q);
  } else if (e.key === 'Escape') {
    $('q').value = '';
    openDay(st.day);
  }
});
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('q').focus(); $('q').select(); }
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

/* 外部改了檔（見 開發筆記 D020）：文字模式下有未存的修改就保留畫面上的；
   卡片模式下有卡片在編輯就先不重畫中間 */
api.onChanged(async () => {
  await refreshDays();
  if (!isBusy()) await refreshCenter();
});

(async () => {
  st.info = await api.info();
  $('dirPath').textContent = st.info.dataDir;
  $('dirPath').title = st.info.dataDir;
  $('dirBtn').disabled = !st.info.canChangeDir;
  st.day = st.info.today;
  await refreshAll();
})();
