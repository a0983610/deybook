/* ============================================================
   daybook 畫面：左邊搜尋＋日期清單、中間那一天的卡片（或搜尋／時間軸結果）、右邊待辦區＋未結
   卡片的做法見 開發筆記 D021、D022；搜尋與時間軸見 D023；文字模式（整天文字編輯）見 D020。
   檔案一律透過 window.daybook（preload）讀寫。
   ============================================================ */
'use strict';
const api = window.daybook;
const $ = id => document.getElementById(id);
const WEEK = '日一二三四五六';
const STATUSES = ['待處理', '待回覆', '完成'];

const st = {
  info: null,
  day: null,          // 正在看（或最後看）的那一天
  view: 'day',        // day | search | timeline
  q: '',              // 搜尋字
  by: null,           // 時間軸：{ code } 或 { event }
  focus: null,        // 打開那天之後要捲到第幾筆
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
function tabInsert(el_) {
  el_.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    document.execCommand('insertText', false, '\t');
  });
}

/* Enter（不在輸入法選字中）／Ctrl+Enter */
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

/* ---------- 卡片（見 開發筆記 D021） ---------- */
function statusSelect(value) {
  const s = el('select', 'status');
  for (const [v, label] of [['', '一般'], ...STATUSES.map(x => [x, x])]) {
    const o = el('option', null, label);
    o.value = v;
    s.appendChild(o);
  }
  s.value = value || '';
  return s;
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

/* 一張卡片。editable：能改（某一天、待辦區）；否則是搜尋／時間軸裡唯讀的，前面標日期 */
function card(c, { src, editable, showSrc }) {
  const box = el('div', 'card');
  box.dataset.src = src;
  box.dataset.index = c.index;

  const head = el('div', 'card-head');
  if (showSrc) {
    head.appendChild(src === 'todo' ? el('span', 'src', '待辦') : button('src', shortDate(src), () => openDay(src, c.index)));
  }
  head.appendChild(el('div', 'title', c.title || '（沒有標題）'));
  if (editable && src !== 'todo' && c.title) {
    const s = statusSelect(c.status);
    s.addEventListener('change', () => act(async () => {
      await api.setStatus(src, c.index, c.raw, s.value || null);
      await refreshAll();
    }));
    head.appendChild(s);
  } else if (c.status) {
    head.appendChild(el('span', 'badge', c.status));
  }
  box.appendChild(head);

  if ((c.codes && c.codes.length) || c.event != null) box.appendChild(chips(c));
  if (c.body.length) {
    const body = el('div', 'body');
    for (const l of c.body) body.appendChild(el('div', l.trim().startsWith('->') ? 'line upd-line' : 'line', l));
    box.appendChild(body);
  }
  if (c.latest) box.appendChild(el('div', 'latest', `最近進展 ${c.latest.src.slice(5)}：${c.latest.text}`));
  if (editable && c.title) addActions(box, c, src);
  return box;
}

function addActions(box, c, src) {
  const row = el('div', 'actions');
  const updBox = el('div', 'upd-box');
  updBox.hidden = true;
  const input = el('input', 'upd-text');
  input.placeholder = src === st.info.today ? '進展（Enter 存）' : '今天的進展（Enter 存，會記在今天、用 ^編號 串起來）';
  updBox.appendChild(input);

  row.appendChild(button('upd', '+ 更新', () => { updBox.hidden = !updBox.hidden; if (!updBox.hidden) input.focus(); }));
  row.appendChild(button('edit', '編輯', () => startEdit(box, c, src)));
  row.appendChild(button('del', '刪除', () => {
    if (!confirm('刪除這一筆？\n\n' + c.title)) return;
    act(async () => { await api.deleteCard(src, c.index, c.raw); await refreshAll(); });
  }));

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
  const s = statusSelect(c.status);
  const save = () => act(async () => {
    await api.editCard(src, c.index, c.raw, { title: t.value, body: b.value, status: s.value || null, event: c.event });
    await refreshAll();
  });
  for (const area of [t, b]) area.addEventListener('keydown', e => { if (isEnter(e) && e.ctrlKey) { e.preventDefault(); save(); } });
  const row = el('div', 'actions');
  if (src !== 'todo') row.appendChild(s);
  row.append(button('save', '儲存（Ctrl+Enter）', save), button('cancel', '取消', () => refreshAll()));
  box.append(t, b, row);
  b.focus();
}

/* 有卡片在編輯、或更新框打了字：外部改檔時先不重畫，免得打到一半被洗掉 */
const isBusy = () => !!document.querySelector('.card.editing') || [...document.querySelectorAll('.upd-text')].some(i => i.value.trim());

/* ---------- 中間：某一天／搜尋／時間軸 ---------- */
function layout() {
  const day = st.view === 'day';
  $('cards').hidden = !(day && st.mode === 'cards');
  $('newForm').hidden = !(day && st.mode === 'cards');
  $('editor').hidden = !(day && st.mode === 'text');
  $('results').hidden = day;
  $('backBtn').hidden = day;
  $('modeBtn').hidden = !day;
  $('modeBtn').textContent = st.mode === 'cards' ? '文字模式' : '卡片模式';
  $('todoCards').hidden = $('todoForm').hidden = st.mode !== 'cards';
  $('todo').hidden = st.mode !== 'text';
}

async function renderDayCards() {
  const box = $('cards');
  box.textContent = '';
  const cards = await api.listCards(st.day);
  for (const c of cards) box.appendChild(card(c, { src: st.day, editable: true }));
  if (!cards.length) box.appendChild(el('div', 'empty', '這天還沒有紀錄，在下面新增第一筆'));
  if (st.focus != null) {
    const target = box.querySelector(`.card[data-index="${st.focus}"]`);
    if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('flash'); }
    st.focus = null;
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
    $('dayTitle').textContent = `${st.day}（${weekday(st.day)}）` + (st.day === st.info.today ? '　今天' : '');
    if (st.mode === 'cards') {
      showSave('');
      await renderDayCards();
    } else if (!editorSave.dirty) {
      const text = await api.readDay(st.day);
      if (text !== $('editor').value) $('editor').value = text;
    }
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
}
async function showTimeline(by) {
  await flushText();
  st.view = 'timeline';
  st.by = by;
  await refreshCenter();
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

/* ---------- 右：待辦區＋未結 ---------- */
async function refreshTodo() {
  if (st.mode === 'text') {
    if (!todoSave.dirty) {
      const text = await api.readTodo();
      if (text !== $('todo').value) $('todo').value = text;
    }
    return;
  }
  const box = $('todoCards');
  box.textContent = '';
  for (const c of await api.listCards('todo')) box.appendChild(card(c, { src: 'todo', editable: true }));
}

async function refreshOpen() {
  const ul = $('openList');
  ul.textContent = '';
  for (const it of await api.listOpen()) {
    const li = el('li');
    li.append(el('span', 'st', `[${it.status}]`), el('span', 'date', it.src.slice(5)), document.createTextNode(it.title.split('\n')[0]));
    li.addEventListener('click', () => openDay(it.src, it.index));
    ul.appendChild(li);
  }
}

async function refreshAll() {
  await refreshDays();
  await refreshCenter();
  await refreshTodo();
  await refreshOpen();
}

/* ---------- 新增表單 ---------- */
function newForm(titleEl, bodyEl, statusEl, src) {
  const add = () => {
    const title = titleEl.value.trim();
    if (!title) { toast('標題不能空白', true); titleEl.focus(); return; }
    act(async () => {
      await api.addCard(src(), { title, body: bodyEl.value, status: statusEl ? statusEl.value || null : null });
      titleEl.value = '';
      bodyEl.value = '';
      if (statusEl) statusEl.value = '';
      await refreshAll();
      titleEl.focus();
    });
  };
  titleEl.addEventListener('keydown', e => {
    if (!isEnter(e)) return;
    e.preventDefault();
    if (e.ctrlKey) add(); else bodyEl.focus();
  });
  bodyEl.addEventListener('keydown', e => { if (isEnter(e) && e.ctrlKey) { e.preventDefault(); add(); } });
  tabInsert(bodyEl);
  return add;
}
const addNew = newForm($('newTitle'), $('newBody'), $('newStatus'), () => st.day);
$('newForm').addEventListener('submit', e => { e.preventDefault(); addNew(); });
newForm($('todoTitle'), $('todoBody'), null, () => 'todo');
$('todoForm').addEventListener('submit', e => e.preventDefault());

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
   卡片模式下有卡片在編輯就先不重畫中間和待辦區 */
api.onChanged(async () => {
  await refreshDays();
  await refreshOpen();
  if (!isBusy()) {
    await refreshCenter();
    await refreshTodo();
  }
});

(async () => {
  st.info = await api.info();
  $('dirPath').textContent = st.info.dataDir;
  $('dirPath').title = st.info.dataDir;
  $('dirBtn').disabled = !st.info.canChangeDir;
  st.day = st.info.today;
  await refreshAll();
})();
