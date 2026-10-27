/* ============================================================
   daybook 畫面：左邊搜尋＋日期清單；中間上面「這一天已處理」、下面「待處理」（見 開發筆記 D024），
   搜尋／時間軸時中間換成結果。卡片見 D021、D022；搜尋與時間軸見 D023；文字模式見 D020；
   標題、搜尋的自動補完見 D031、D032；換日快捷鍵見 D033；黑暗模式見 D034；匯出見 D035；
   日曆見 D036；狀態列、F1 快捷鍵表見 D037。
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

/* 先讀好再清空重畫：清空後才 await，中間會畫出空的清單（閃一下、捲動位置跑回最上面，見 開發筆記 D045） */
async function renderList(box, src, emptyText) {
  const cards = await api.listCards(src);
  box.textContent = '';
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
  /* 隱藏的收在最底下「已隱藏 N 筆」，點一下展開／收起（見 開發筆記 D026）；先讀好再清空（見 D045） */
  const box = $('todoCards');
  const cards = await api.listCards('todo');
  box.textContent = '';
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

/* ---------- 左：日期清單／日曆 ---------- */
async function refreshDays() {
  const files = await api.listDays();
  const days = files.includes(st.info.today) ? files : [st.info.today, ...files];
  renderCalendar(new Set(files));
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

/* ---------- 自動補完（見 開發筆記 D031、D032）：候選用灰字接在打的字後面，Tab 收下，不理它照打就好。
   不是下拉選單（見 D025）。候選在檔案變了之後作廢，下次打字再跟主程序拿 ---------- */
let sugg = null;   // 主程序給的 { titles, words }（promise）
const loadSugg = () => (sugg = sugg || api.suggestions().catch(() => ({ titles: [], words: [] })));

/* pick(候選, 輸入框的字) → { from, text }：把 from 之後換成 text；沒有就 null。回傳更新灰字的函式 */
function ghost(input, pick) {
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
  let cur = null;
  let composing = false;   // 輸入法選字中不補
  const clear = () => { cur = null; typed.textContent = rest.textContent = ''; };
  const update = async () => {
    const s = await loadSugg();
    const v = input.value;
    const atEnd = input.selectionStart === v.length && input.selectionEnd === v.length;
    const c = !composing && document.activeElement === input && atEnd && v.trim() ? pick(s, v) : null;
    if (!c) return clear();
    cur = { ...c, v };
    typed.textContent = v;
    rest.textContent = c.text.slice(v.length - c.from);
    if (box.scrollWidth > box.clientWidth) clear();   // 放不下（框裡會捲動、疊不準，或只看得到一半）：乾脆不顯示
  };
  for (const ev of ['input', 'focus', 'click', 'keyup']) input.addEventListener(ev, update);
  input.addEventListener('blur', clear);
  input.addEventListener('compositionstart', () => { composing = true; clear(); });
  input.addEventListener('compositionend', () => { composing = false; update(); });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || !cur || cur.v !== input.value) return;
    e.preventDefault();
    input.setSelectionRange(cur.from, input.value.length);
    document.execCommand('insertText', false, cur.text);   // 用 insertText：框裡自己的 Ctrl+Z 退得回來
  });
  return update;
}

/* 標題：整格是某個「代號＋程式名稱」的開頭（不分大小寫），最近用過的優先（見 開發筆記 D031） */
function pickTitle(s, v) {
  const t = s.titles.find(x => x.length > v.length && x.toLowerCase().startsWith(v.toLowerCase()));
  return t ? { from: 0, text: t } : null;
}

/* 搜尋（見 開發筆記 D032）：先找搜過的（整格是它的開頭，搜越多次越前面）；
   沒有再把最後一個詞補成內容裡的代號、程式名稱、人名 */
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
  const lv = v.toLowerCase();
  const h = searchLog().filter(x => x.q.length > v.length && x.q.toLowerCase().startsWith(lv)).sort((a, b) => b.n - a.n || b.t - a.t)[0];
  if (h) return { from: 0, text: h.q };
  const m = v.match(/\S+$/);
  if (!m) return null;
  const w = s.words.find(x => x.length > m[0].length && x.toLowerCase().startsWith(m[0].toLowerCase()));
  return w ? { from: m.index, text: w } : null;
}

const titleGhost = ghost($('newTitle'), pickTitle);
ghost($('q'), pickSearch);

/* ---------- 新增表單：兩顆按鈕，加到待處理、或直接記成這一天的已處理（見 開發筆記 D025） ---------- */
function addNew(where) {
  const title = $('newTitle').value.trim();
  if (!title) { toast('標題不能空白', true); $('newTitle').focus(); return; }
  const src = where === 'done' ? st.day : 'todo';
  act(async () => {
    await api.addCard(src, { title, body: $('newBody').value });
    $('newTitle').value = '';
    $('newBody').value = '';
    titleGhost();   // 程式清掉的字不會觸發 input 事件，灰字要自己清
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
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('q').focus(); $('q').select(); }
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

/* 匯出 Markdown（見 開發筆記 D035）：按「匯出…」打開起訖兩格日期；預設這週一到今天 */
function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
$('exportBtn').addEventListener('click', () => {
  const bar = $('exportBar');
  bar.hidden = !bar.hidden;
  if (bar.hidden) return;
  if (!$('expFrom').value || !$('expTo').value) {
    const [y, m, d] = st.info.today.split('-').map(Number);
    const t = new Date(y, m - 1, d);
    $('expFrom').value = isoOf(new Date(y, m - 1, d - ((t.getDay() + 6) % 7)));
    $('expTo').value = st.info.today;
  }
  $('expFrom').focus();
});
async function doExport(req) {
  await flushText();
  act(async () => {
    const file = await api.exportMd(req);
    if (file) toast('已匯出：' + file);
  });
}
$('expRange').addEventListener('click', () => doExport({ from: $('expFrom').value, to: $('expTo').value }));
$('expAll').addEventListener('click', () => doExport({ all: true }));

/* ---------- 底部狀態列（見 開發筆記 D037）：游標在哪就寫那裡能按的快捷鍵；F1 打開全部（index.html 的 #help）。
   改快捷鍵時這裡跟 #help 都要改 ---------- */
const HINTS = [
  ['#newTitle', [['Tab', '帶入灰字'], ['Enter', '換到內文'], ['Ctrl+Enter', '加到待處理'], ['Ctrl+Shift+Enter', '加到已處理']]],
  ['#newBody', [['Tab', '縮排'], ['Ctrl+Enter', '加到待處理'], ['Ctrl+Shift+Enter', '加到已處理']]],
  ['#q', [['Enter', '搜尋'], ['Tab', '帶入灰字'], ['Esc', '清掉、回到那天']]],
  ['.upd-text', [['Enter', '存'], ['Esc', '取消']]],
  ['.edit-title', [['Ctrl+Enter', '儲存']]],
  ['.edit-body', [['Tab', '縮排'], ['Ctrl+Enter', '儲存']]],
  ['#editor, #todo', [['Tab', '縮排']]],
];
// 游標不在上面那些輸入框時
const HINT_DEFAULT = [['Ctrl+F', '搜尋'], ['Alt+← / Alt+→', '換日'], ['Alt+Home', '今天'], ['Ctrl+Z', '復原'], ['Alt', '選單列']];
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
// Esc 關掉：在 capture 階段先攔下來，搜尋框的 Esc（清掉搜尋字）才不會一起跑
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || $('help').hidden) return;
  e.preventDefault();
  e.stopPropagation();
  toggleHelp(false);
}, true);

/* 外部改了檔（見 開發筆記 D020）：文字模式下有未存的修改就保留畫面上的；
   卡片模式下有卡片在編輯就先不重畫中間 */
api.onChanged(async () => {
  sugg = null;   // 自動補完的候選跟著作廢（見 開發筆記 D031）
  await refreshDays();
  if (!isBusy()) await refreshCenter();
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

/* 從舊記事本匯入（見 開發筆記 D044）：已經有的日子跳過；結果字比較多，提示留久一點 */
function importSummary(r) {
  const parts = [`匯入 ${r.written} 天`];
  if (r.skipped.length) {
    const list = r.skipped.slice(0, 5).map(d => d.slice(5)).join('、') + (r.skipped.length > 5 ? '…' : '');
    parts.push(`跳過 ${r.skipped.length} 天（資料夾裡已經有了：${list}）`);
  }
  if (r.todoLines) parts.push(`待處理 ${r.todoLines} 行`);
  if (r.todoSkipped) parts.push('待處理已經有內容，舊檔的待辦區沒匯');
  return parts.join('；') + (r.written || r.todoLines ? '（Ctrl+Z 可以整批復原）' : '');
}
$('importBtn').addEventListener('click', () => act(async () => {
  await flushText();
  const r = await api.importTxt();
  if (!r) return;
  toast(importSummary(r), false, 10000);
  await refreshAll();
}));
// 還沒選資料夾時：先選資料夾、再選舊檔；匯完重新載入，結果留到載入後再顯示
$('setupImport').addEventListener('click', async () => {
  if (!(await api.changeDir())) return;
  let note = null;
  try {
    const r = await api.importTxt();
    if (r) note = { msg: importSummary(r) };
  } catch (e) {
    note = { msg: errMsg(e), err: true };
  }
  try { if (note) sessionStorage.setItem('daybook.toast', JSON.stringify(note)); } catch { /* 顯示不了就算了 */ }
  location.reload();
});

(async () => {
  st.info = await api.info();
  $('dirPath').textContent = st.info.dataDir || '';
  $('dirPath').title = st.info.dataDir || '';
  $('dirBtn').disabled = !st.info.canChangeDir;
  if (!st.info.dataDir) { showSetup(); return; }
  st.day = st.info.today;
  st.calMonth = st.day.slice(0, 7);
  await refreshAll();
  // 「從舊記事本匯入」重新載入前留下的結果（見 開發筆記 D044）
  try {
    const note = JSON.parse(sessionStorage.getItem('daybook.toast'));
    sessionStorage.removeItem('daybook.toast');
    if (note) toast(note.msg, note.err, 10000);
  } catch { /* 沒有就算了 */ }
})();
