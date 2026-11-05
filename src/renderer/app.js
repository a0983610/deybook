/* ============================================================
   daybook 畫面：左邊搜尋＋日期清單；中間上面「這一天已處理」、下面「待處理」（見 開發筆記 D024），
   搜尋／時間軸時中間換成結果。卡片見 D021、D022；搜尋與時間軸見 D023；文字模式見 D020（唯讀見 D141）；
   標題、搜尋的自動補完見 D031、D032；換日快捷鍵見 D033；黑暗模式見 D034；匯出見 D035；
   日曆見 D036；狀態列、F1 快捷鍵表見 D037；日期清單 ↑↓ 換日、每週底色見 D070、D071；標記見 D072；回顧見 D087；
   左欄的剪貼簿見 D093（原本叫暫存，D096）；記事本（中間換成記事本）見 D102。
   檔案一律透過 window.daybook（preload）讀寫。
   ============================================================ */
'use strict';
const api = window.daybook;
const $ = id => document.getElementById(id);
// 星期幾的簡寫，畫面上顯示用（換語言時照語言檔，見 開發筆記 D131）；日曆表頭、日期清單、回顧小標都用這個
const WEEK = [LK('日'), LK('一'), LK('二'), LK('三'), LK('四'), LK('五'), LK('六')];

const st = {
  info: null,
  day: null,          // 正在看（或最後看）的那一天
  view: 'day',        // day | search | timeline | flagged（標記清單，見 開發筆記 D072）| range（回顧，D087）
  flagFilter: '全部', // 不翻：哨兵值。標記清單篩哪個分類：'全部'、'未分類' 或分類名稱（見 開發筆記 D076）
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
  return L(WEEK[new Date(y, m - 1, d).getDay()]);
}
const shortDate = d => L('{date}（{w}）', { date: d.slice(5), w: weekday(d) });
// 好幾個名稱接成一串用 shared/i18n.js 的 joinList（全域的）：「A、B」兩兩用 L('{a}、{b}') 接（見 開發筆記 D131）
// 好幾句接成一串：「A；B」也一樣兩兩接（不把「；」單獨當 key：AI 回的頭尾空白會被去掉）
const semiList = list => (list.length ? list.reduce((a, b) => L('{a}；{b}', { a, b })) : '');

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

/* 有卡片在編輯（見 開發筆記 D140）：要做會重畫中間的事（別張卡片的動作、新增、Ctrl+Z、換日、搜尋、時間軸、換模式）前先問一次；
   放棄就照做（重畫時編輯框收掉），取消（Esc、點外面）就什麼都不做、留在原地。
   用畫面上的框（樣子照記事本的 #noteAsk），不用原生 confirm：原生的會把視窗叫到最前面（安靜跑不能搶焦點，D052）。回 true＝照做 */
let editAsking = null;   // 問的時候：Promise 的 resolve
function editGuard() {
  if (!document.querySelector('.card.editing')) return Promise.resolve(true);
  if (editAsking) return Promise.resolve(false);   // 已經在問了：這一下不算
  $('editAsk').hidden = false;
  $('editAskCancel').focus();   // 游標先放在取消：按 Enter 不會丟掉打的字
  return new Promise(res => { editAsking = res; });
}
function editAskDone(ok) {
  const res = editAsking;
  editAsking = null;
  $('editAsk').hidden = true;
  if (res) res(ok);
}
$('editAskDrop').addEventListener('click', () => editAskDone(true));
$('editAskCancel').addEventListener('click', () => editAskDone(false));
$('editAsk').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editAskDone(false); } });
$('editAsk').addEventListener('mousedown', e => { if (e.target === $('editAsk')) editAskDone(false); });   // 點外面（灰的那層）
const cardAct = async fn => { if (await editGuard()) return act(fn); };

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


/* ---------- 卡片（見 開發筆記 D021、D024、D025） ---------- */
/* 待處理的卡片：「待回覆」一鍵切換（不用下拉選單，見 開發筆記 D025） */
function waitToggle(c, src) {
  const on = c.status === '待回覆';   // 不翻：資料裡的狀態
  const b = button('wait' + (on ? ' on' : ''), L('待回覆'), () => cardAct(async () => {
    await api.setStatus(src, c.index, c.raw, on ? null : '待回覆');   // 不翻：寫進檔案的狀態
    await refreshAll();
  }));
  b.title = on ? L('點一下取消待回覆') : L('點一下標成待回覆（在等別人）');
  return b;
}

/* 已處理的卡片：「標記」還要注意、還沒完的事（見 開發筆記 D072）；左邊「標記」列出全部。
   點了底下冒出一排分類鈕（pick），點一個就標上；標過的再點可以換分類、取消標記（D076；不用下拉，D025） */
const flagLabel = c => (c.flagCat ? L('標記·{cat}', { cat: c.flagCat }) : L('標記'));
function flagToggle(c, src, pick) {
  const b = button('flag' + (c.flagged ? ' on' : ''), c.flagged ? flagLabel(c) : L('標記'), () => {
    pick.hidden = !pick.hidden;
    if (!pick.hidden) act(() => fillFlagPick(pick, c, src));
  });
  b.title = c.flagged ? L('點一下換分類或取消標記（這件事完了）') : L('點一下選分類標記：還要注意、還沒完（左邊「標記」列出全部）');
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
      cardAct(async () => {
        await api.setFlag(src, c.index, c.raw, true, cat);
        await refreshAll();
      });
    });
  };
  box.appendChild(opt(L('未分類'), null));
  for (const cat of cats) box.appendChild(opt(cat, cat));
  // ＋ 新分類：換成輸入框，Enter 加進分類清單並標上；名稱不行就提示、打的字留著
  const add = button('cat-add', L('＋ 新分類'), () => {
    const input = el('input', 'cat-new');
    input.placeholder = L('新分類（Enter 加上並標記）');
    input.addEventListener('keydown', async e => {
      if (e.key === 'Escape') { input.replaceWith(add); add.focus(); return; }
      if (!isEnter(e)) return;
      e.preventDefault();
      let cat;
      try { cat = await api.addFlagCat(input.value); } catch (err) { toast(errMsg(err), true); return; }
      cardAct(async () => {
        await api.setFlag(src, c.index, c.raw, true, cat);
        await refreshAll();
      });
    });
    add.replaceWith(input);
    input.focus();
  });
  box.appendChild(add);
  box.appendChild(c.flagged
    ? button('unflag', L('取消標記'), () => cardAct(async () => {
      await api.setFlag(src, c.index, c.raw, false);
      await refreshAll();
    }))
    : button('cancel', L('取消'), () => { box.hidden = true; }));
}

function chips(c) {
  const box = el('div', 'chips');
  for (const code of c.codes || []) box.appendChild(button('chip code', code, () => showTimeline({ code })));
  if (c.event != null) {
    const b = button('chip event', '^' + c.event, () => showTimeline({ event: c.event }));
    b.title = L('這件事每一天的紀錄');
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
    head.appendChild(src === 'todo' ? el('span', 'src', L('待處理')) : button('src', shortDate(src), () => openDay(src, c.index)));
  }
  head.appendChild(el('div', 'title', c.title || L('（沒有標題）')));
  if (editable && src === 'todo' && c.title) {
    head.appendChild(waitToggle(c, src));
  } else if (c.status) {
    head.appendChild(el('span', 'badge', L(c.status)));   // 跟「待回覆」按鈕同一個字；舊的「待處理」「完成」沒有 key，照原字（D131）
  }
  if (!editable && c.hidden) head.appendChild(el('span', 'badge', L('已隱藏')));
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
    row.appendChild(button('unflag', L('取消標記'), () => act(async () => {
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
  input.placeholder = src === 'todo' ? L('進展（Enter 存，會帶今天日期）')
    : src === st.info.today ? L('後續（Enter 存）') : L('今天的後續（Enter 存，會記在今天、用 ^編號 串起來）');
  updBox.appendChild(input);
  const pick = el('div', 'actions flag-pick');   // 標記的分類鈕（見 開發筆記 D076）
  pick.hidden = true;

  if (src !== 'todo') row.appendChild(flagToggle(c, src, pick));
  row.appendChild(button('upd', L('+ 更新'), () => { updBox.hidden = !updBox.hidden; if (!updBox.hidden) input.focus(); }));
  if (src === 'todo') {
    const done = button('done', L('處理完 ↑'), () => cardAct(async () => {
      await api.markDone(c.index, c.raw, st.day);
      toast(L('已移到 {date} 已處理', { date: st.day.slice(5) }));
      await refreshAll();
      showNewDone();
    }));
    done.title = L('整筆（含進展）搬到上面這一天的已處理');
    row.appendChild(done);
    // 已處理+未完標籤（見 開發筆記 D091）：跟處理完一樣搬上去，再標上內建分類「未完」
    const unfinished = button('unfinished', L('已處理+未完標籤'), () => cardAct(async () => {
      await api.markDone(c.index, c.raw, st.day, true);
      toast(L('已移到 {date} 已處理，標上「未完」', { date: st.day.slice(5) }));
      await refreshAll();
      showNewDone();
    }));
    unfinished.title = L('整筆（含進展）搬到上面這一天的已處理，並標上「未完」標記');
    row.appendChild(unfinished);
    const hide = button('hide', c.hidden ? L('取消隱藏') : L('隱藏'), () => cardAct(async () => {
      await api.setHidden(c.index, c.raw, !c.hidden);
      await refreshAll();
    }));
    hide.title = c.hidden ? L('放回待處理清單') : L('先收起來不看（還在，展開「已隱藏」就找得到）');
    row.appendChild(hide);
  }
  row.appendChild(button('edit', L('編輯'), () => startEdit(box, c, src)));
  // 不跳詢問，誤刪按 Ctrl+Z 復原（見 開發筆記 D028）
  row.appendChild(button('del', L('刪除'), () => cardAct(async () => {
    await api.deleteCard(src, c.index, c.raw);
    toast(L('已刪除（Ctrl+Z 復原）'));
    await refreshAll();
  })));

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; updBox.hidden = true; return; }
    if (!isEnter(e)) return;
    e.preventDefault();
    cardAct(async () => {
      const r = await api.addUpdate(src, c.index, c.raw, input.value);
      input.value = '';
      if (r.where === 'today') toast(L('已記在今天（^{event}）', { event: r.event }));
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
  // 存不進去（標題不行、這一筆在別的地方被改過）就提示、編輯框留著，改的字不洗掉（見 開發筆記 D140）；存好才重畫
  const save = async () => {
    try {
      // 狀態、隱藏、標記不在這裡改（在卡片上一鍵切換），原本的照舊留著
      await api.editCard(src, c.index, c.raw, { title: t.value, body: b.value, status: c.status, hidden: c.hidden, flagged: c.flagged, flagCat: c.flagCat, event: c.event });
    } catch (e) { toast(errMsg(e), true); return; }
    await act(refreshAll);
  };
  for (const area of [t, b]) area.addEventListener('keydown', e => { if (isEnter(e) && e.ctrlKey) { e.preventDefault(); save(); } });
  const row = el('div', 'actions');
  row.append(button('save', L('儲存（Ctrl+Enter）'), save), button('cancel', L('取消'), () => refreshAll()));
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
  $('modeBtn').textContent = cards ? L('文字模式') : L('卡片模式');
  // 文字模式唯讀（見 開發筆記 D141）：標題旁邊寫明，免得以為打得進去
  $('saveState').textContent = day && !cards ? L('唯讀：要改切回卡片模式') : '';
  paneHeads();
  applySizes();
}

/* 已處理／待處理的標題列：▾ 展開、▸ 縮起來，後面寫筆數（見 開發筆記 D027） */
function paneHeads() {
  for (const [key, box, head, name] of [['done', 'doneBox', 'doneHead', L('已處理')], ['todo', 'todoBox', 'todoHead', L('待處理')]]) {
    const c = !!st.collapsed[key];
    $(box).classList.toggle('collapsed', c);
    const n = st.counts[key];
    $(head).textContent = `${c ? '▸' : '▾'} ${name}` + (n == null ? '' : L('（{n}）', { n }));
    $(head).title = c ? L('點一下展開') : L('點一下縮起來，讓輸入區大一點');
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
const SIDE_MIN = 150, PANE_MIN = 60;
const formMin = () => parseFloat(getComputedStyle($('newForm')).minHeight);   // 照 style.css 的 #newForm min-height：內容字變大會跟著變（D113）
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
      // 拉過的晚縮：跟著內容走的那塊縮的係數是 1000（style.css .pane），放不下時先縮它到 60px，還不夠才縮拉過的；全部都拉過就一起照比例縮。
      // 拉過的不能用小於 1 的係數（原本 0.001）：還能縮的那幾塊係數加起來小於 1 時，放不下的只縮掉那個比例，其餘撐出視窗（放大時就會，D074〈後續〉）
      else if (sizes[k] != null) flex = `0 1 ${sizes[k]}px`;
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

/* ---------- 最左邊的頁籤列（見 開發筆記 D083）：像 VS Code 的活動列，「日記本」「剪貼簿」（D093、D096）、「常用」（D134，跟剪貼簿同一套） ----------
   點正在看的那個收起左欄、點另一個（或左欄收著時）打開並換成它；收起來、放哪一個都記在這台電腦（開起來時 theme.js 已經套上）。
   收起來時兩個都不算選到 */
const sideOff = () => document.documentElement.dataset.side === 'off';
function setSideOff(off) {
  if (off) document.documentElement.dataset.side = 'off';
  else delete document.documentElement.dataset.side;
  try { localStorage.setItem('daybook.sideOff', off ? '1' : ''); } catch { /* 記不住就算了 */ }
  actState();
}
// 左欄換成剪貼簿、常用（D134）時設 data-side-view；放日記本（記事本、文件檢視時是它們的清單）時拿掉
const SIDE_VIEWS = ['snip', 'launch'];
const sideView = () => (SIDE_VIEWS.includes(document.documentElement.dataset.sideView) ? document.documentElement.dataset.sideView : 'journal');
function showSide(view) {
  const v = SIDE_VIEWS.includes(view) ? view : '';
  if (v) document.documentElement.dataset.sideView = v;
  else delete document.documentElement.dataset.sideView;
  try { localStorage.setItem('daybook.sideView', v); } catch { /* 記不住就算了 */ }
  setSideOff(false);
}
/* 記事本（D102）：中間換成記事本；開著時點日記本先回到日記，再打開左欄換成它。
   點剪貼簿不回日記（D110）：跟日記同一套，開著就收起左欄、沒開就打開換成剪貼簿；剪貼簿開著沒只記一份，日記、記事本共用（D112）。
   記事清單（D116）：左欄放日記本的那格，記事本時換成記事清單（sideView 照樣是 'journal'）。點「記事本」：沒開就打開、左欄換成清單；
   開著時跟日記的「日記本」一樣，清單開著就收起左欄，沒開（收著、放剪貼簿）就打開換成清單。
   MD 檢視（D118）跟記事本同一套：中間換成轉好的 .md、左欄放日記本的那格換成 MD 檢視的清單 */
const noteMode = () => document.documentElement.dataset.view === 'note';
const mdMode = () => document.documentElement.dataset.view === 'md';
const shotMode = () => document.documentElement.dataset.view === 'shot';   // 截圖（D129）：中間換成截圖頁，沒有自己的左欄
const actClick = view => {
  if (noteMode() && view === 'journal') { setNoteMode(false); showSide(view); return; }
  if (mdMode() && view === 'journal') { setMdMode(false); showSide(view); return; }
  if (shotMode() && view === 'journal') { setShotMode(false); showSide(view); return; }
  if (!sideOff() && sideView() === view) setSideOff(true); else showSide(view);
};
function actState() {
  const on = v => !noteMode() && !mdMode() && !shotMode() && !sideOff() && sideView() === v;
  const snipOn = !sideOff() && sideView() === 'snip';   // 記事本、MD 檢視開著時也算（D112）
  const listOn = !sideOff() && sideView() === 'journal';   // 記事本、MD 檢視的清單開著
  $('actJournal').classList.toggle('on', on('journal'));
  $('actJournal').title = noteMode() || mdMode() || shotMode() ? L('日記本：回到日記') : on('journal') ? L('日記本：點一下收起左欄，中間大一點') : L('日記本：點一下打開左欄（搜尋、日期）');
  $('actSnip').classList.toggle('on', snipOn);
  $('actSnip').title = snipOn ? L('剪貼簿：點一下收起左欄，中間大一點') : L('剪貼簿：常用的文字放這裡，點一下就複製');
  $('actNote').classList.toggle('on', noteMode());
  $('actNote').title = noteMode() && listOn ? L('記事本：點一下收起記事清單，中間大一點') : noteMode() ? L('記事本：點一下打開記事清單') : L('記事本：隨手記，左邊記事清單、上面開著的頁籤');
  $('actMd').classList.toggle('on', mdMode());
  $('actMd').title = mdMode() && listOn ? L('文件檢視：點一下收起清單，中間大一點') : mdMode() ? L('文件檢視：點一下打開清單') : L('文件檢視：看釘住的資料夾裡的 .md、.html（AI 產出的報告、筆記、規格），只看不改');
  $('actShot').classList.toggle('on', shotMode());
  $('actShot').title = L('截圖：框選畫面的一塊、畫框和箭頭，存成編號；管理截過的圖');
  const launchOn = !sideOff() && sideView() === 'launch';   // 跟剪貼簿一樣，記事本、文件檢視、截圖開著時也算（D134）
  $('actLaunch').classList.toggle('on', launchOn);
  $('actLaunch').title = launchOn ? L('常用：點一下收起左欄，中間大一點') : L('常用：常開的程式、資料夾、網址放這裡，點一下就開');
}
$('actJournal').addEventListener('click', () => actClick('journal'));
$('actSnip').addEventListener('click', () => actClick('snip'));
$('actLaunch').addEventListener('click', () => actClick('launch'));
$('actNote').addEventListener('click', () => {
  if (!noteMode()) { showSide('journal'); setNoteMode(true); return; }
  if (!sideOff() && sideView() === 'journal') setSideOff(true); else showSide('journal');
});
$('actMd').addEventListener('click', () => {
  if (!mdMode()) { showSide('journal'); setMdMode(true); return; }
  if (!sideOff() && sideView() === 'journal') setSideOff(true); else showSide('journal');
});
$('actShot').addEventListener('click', () => { if (!shotMode()) setShotMode(true); });   // 沒有自己的左欄，開著時再點不做事
actState();
/* Ctrl+1～9：換到頁籤列的第幾個（見 開發筆記 D168）。照畫面上的順序（外觀頁調的 order，D151）、藏起來的不算（D146）、齒輪不算；
   做的事跟用滑鼠點那顆一樣（按到正在看的就收起左欄）：被快捷鍵表、設定頁、問存不存這些蓋住時滑鼠點不到，按鍵也不換。
   key 是按的鍵（.html 裡按的由 postMessage 帶過來）；是 1～9 就回 true */
function actKey(key) {
  if (!/^[1-9]$/.test(key)) return false;
  const b = [...document.querySelectorAll('#activity button:not(#actSettings)')]
    .filter(x => getComputedStyle(x).display !== 'none')
    .sort((x, y) => getComputedStyle(x).order - getComputedStyle(y).order)[key - 1];
  if (!b) return true;
  const r = b.getBoundingClientRect();
  if (!b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))) return true;
  b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));   // 開著的選單照「點外面」收起來（同 D164）
  b.focus();   // 焦點也跟滑鼠點一樣到那顆上（換走的那頁的輸入框不留著焦點）
  b.click();
  return true;
}

/* ---------- 剪貼簿（見 開發筆記 D093；原本叫暫存，D096）：左欄換成一張張卡片，點卡片把內文複製到系統剪貼簿 ----------
   存在資料夾的 剪貼簿.md；新增放最後面（D126）。編輯中（含新增）外面改了檔、或別的動作重畫，都先不重畫這塊 */
const SNIP_EMPTY = L('剪貼簿還是空的。按「＋ 新增」放一段常用的文字，之後點一下就複製。');
const snipBusy = () => !!document.querySelector('.snip.editing');
async function refreshSnips() {
  const list = await api.listSnips();   // 先讀好再換，畫面不閃（D045）
  $('snipList').replaceChildren(...(list.length ? list.map(snipCard) : [el('div', 'empty', SNIP_EMPTY)]));
}
/* 編輯表單「日期符號 ▸」展開的說明（D095）：符號表只列補零的六個，其他寫一行；例子點了插進內文。認哪些符號在 datefill.js */
// 符號的意思合成一句翻（D131）：單獨一個「日」已經是星期日的簡寫，分開當 key 會撞；翻譯切不出六個就照中文
const SNIP_SYM_NAMES = (() => {
  const src = '年、月、日、時、分、秒';   // 不翻：翻譯切不出六個時的備用（就是下一行的原文）
  const names = L('年、月、日、時、分、秒').split(/\s*[、,，;；]\s*/);
  return names.length === 6 ? names : src.split('、');   // 不翻：切原文
})();
const SNIP_SYMS = ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss'].map((k, i) => [k, SNIP_SYM_NAMES[i]]);
const SNIP_EXAMPLES = ['{yyyy.MM.dd HH:mm}', '{yyyy-MM-dd}', '{M/d}'];
/* 內文裡的日期符號（{yyyy.MM.dd HH:mm}，D094）：卡片上照寫的顯示、標顏色；複製時才換成當下（datefill.js） */
function snipBody(text) {
  const box = el('div', 'snip-body');
  for (const p of dateSegments(text)) box.append(p.date ? el('span', 'snip-date', p.text) : p.text);
  return box;
}
function snipCard(s) {
  const box = el('div', 'snip');
  const name = s.title || L('（沒有標題）');
  const copy = button('snip-copy', null, () => act(async () => {
    if (!s.body.length) { toast(L('「{name}」沒有內文', { name }), true); return; }
    await api.copyText(fillDates(s.body.join('\n'), new Date()));
    toast(L('已複製「{name}」', { name }));
  }));
  copy.title = L('點一下複製內文；拖拉或 Alt+↑↓ 調順序');
  copy.append(el('div', 'snip-title', name), snipBody(s.body.join('\n')));
  // 調順序（D125）：整張卡片拖得動（放開在哪見下面 snipDropAt）；游標在卡片上 Alt+↑↓ 搬一格，碰到頂、底就不動
  box.draggable = true;
  box.addEventListener('dragstart', e => {
    if (snipBusy()) { e.preventDefault(); toast(SNIP_BUSY_MOVE, true); return; }
    snipDrag = s;
    e.dataTransfer.effectAllowed = 'move';
  });
  copy.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const to = s.index + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= $('snipList').querySelectorAll(':scope > .snip').length) return;
    if (snipBusy()) { toast(SNIP_BUSY_MOVE, true); return; }
    snipMove(s, to, true);
  });
  const tools = el('div', 'actions snip-tools');
  tools.append(button('edit', L('編輯'), () => snipEdit(box, s)), button('del', L('刪除'), () => act(async () => {
    await api.deleteSnip(s.index, s.raw);   // 不跳詢問，誤刪按 Ctrl+Z 復原（D028）
    toast(L('已刪除（Ctrl+Z 復原）'));
    await refreshSnips();
  })));
  box.append(copy, tools);
  return box;
}
/* 新增（s 是 null）、編輯共用：標題 Enter 換到內文，Ctrl+Enter 儲存；儲存失敗（沒填）表單留著 */
function snipEdit(box, s) {
  box.className = 'snip editing';
  box.draggable = false;   // 不然在標題、內文裡用滑鼠選字會變成拖整張（同記事清單改名，D125）
  box.textContent = '';
  const t = el('input', 'snip-title-in');
  t.value = s ? s.title : '';
  t.placeholder = L('標題　Enter 換到內文');
  const b = el('textarea', 'snip-body-in');
  b.value = s ? s.body.join('\n') : '';
  b.placeholder = L('要複製的內文（Tab 可縮排；{yyyy.MM.dd HH:mm} 這種複製時換成當下的日期時間）');
  b.rows = Math.max(3, Math.min(12, (s ? s.body.length : 0) + 1));
  t.spellcheck = b.spellcheck = false;
  tabInsert(b);
  // 內文有日期符號時，底下即時預覽複製出去的樣子（D094）
  const pv = el('div', 'snip-preview');
  const preview = () => {
    pv.hidden = !dateSegments(b.value).some(p => p.date);
    pv.textContent = L('複製時：{text}', { text: fillDates(b.value, new Date()) });
  };
  b.addEventListener('input', preview);
  preview();
  // 日期符號的說明（D095）：點「日期符號 ▸」展開符號表和例子，點例子插進內文游標的位置（execCommand，內文裡 Ctrl+Z 復原得了）
  const help = el('div', 'snip-help');
  help.hidden = true;
  const helpBtn = button('snip-help-toggle', L('日期符號 ▸'), () => {
    help.hidden = !help.hidden;
    helpBtn.textContent = help.hidden ? L('日期符號 ▸') : L('日期符號 ▾');
  });
  const syms = el('div', 'snip-syms');
  for (const [k, v] of SNIP_SYMS) syms.append(el('code', null, k), el('span', null, v));
  const ins = el('div', 'actions snip-ins');
  for (const x of SNIP_EXAMPLES) {
    const eb = button(null, x, () => { b.focus(); document.execCommand('insertText', false, x); });   // focus 回內文會回到原本的游標位置
    eb.title = L('插進內文游標的位置');
    ins.append(eb);
  }
  help.append(el('div', null, L('寫在大括號裡，複製時換成當下（大小寫有分）：')), syms, el('div', null, L('yy 是年兩碼；M、d、H 不補零')), el('div', null, L('點了插進內文：')), ins);
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
  row.append(button('save', L('儲存（Ctrl+Enter）'), save), button('cancel', L('取消'), () => act(refreshSnips)));
  box.append(t, b, pv, helpBtn, help, row);
  (s ? b : t).focus();
}
$('snipAdd').addEventListener('click', () => {
  const open = $('snipList').querySelector('.snip[data-new]');
  if (open) { open.querySelector('input').focus(); return; }   // 已經開著一張新的
  const box = el('div');
  box.dataset.new = '';
  $('snipList').querySelector(':scope > .empty')?.remove();
  $('snipList').append(box);   // 新的放最後面（D126）：表單開在存了以後的位置
  snipEdit(box, null);
  $('snipList').scrollTop = $('snipList').scrollHeight;   // 捲到底看得到整張：游標進標題時只把標題捲到中間，左欄矮時儲存鈕會被切掉
});
/* 調順序（見 開發筆記 D125）：拖拉、Alt+↑↓ 都走 snipMove，存回 剪貼簿.md 的先後，Ctrl+Z 復原得了。
   有一張在編輯（含新增）時不給搬：搬完要重畫，打到一半的會被洗掉 */
const SNIP_BUSY_MOVE = L('先儲存或取消正在編輯的那張，再調順序');
let snipDrag = null;   // 拖著的那一筆（listSnips 給的，帶 index、raw）
const snipMove = (s, to, focus) => act(async () => {
  await api.moveSnip(s.index, s.raw, to);
  await refreshSnips();
  if (focus) $('snipList').querySelectorAll(':scope > .snip .snip-copy')[to]?.focus();   // 鍵盤搬的游標跟著那張，接著按得到
});
/* 放開會插在哪：滑鼠下面有幾張卡片的中線在它上面，就插在第幾張前面（卡片中間的空隙、最下面的空白也算得出來）；
   to 是搬完以後它是第幾筆，搬回原地的不算（不畫線、放開也不動） */
function snipDropAt(e) {
  if (!snipDrag) return null;
  const cards = [...$('snipList').querySelectorAll(':scope > .snip')];
  const at = cards.filter(c => { const r = c.getBoundingClientRect(); return r.top + r.height / 2 < e.clientY; }).length;
  const to = at > snipDrag.index ? at - 1 : at;
  return to === snipDrag.index ? null : { at, to, cards };
}
// 插進去的位置畫一條線：插在第 at 張前面就畫在它上緣，插在最後面就畫在最後一張下緣
function snipDropMark(d) {
  for (const c of $('snipList').querySelectorAll('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after');
  if (!d) return;
  if (d.at < d.cards.length) d.cards[d.at].classList.add('drop-before');
  else d.cards[d.at - 1].classList.add('drop-after');
}
$('snipList').addEventListener('dragover', e => {
  const d = snipDropAt(e);
  snipDropMark(d);
  if (!d) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
$('snipList').addEventListener('dragleave', e => { if (!$('snipList').contains(e.relatedTarget)) snipDropMark(null); });
$('snipList').addEventListener('dragend', () => { snipDrag = null; snipDropMark(null); });
$('snipList').addEventListener('drop', e => {
  const d = snipDropAt(e), s = snipDrag;
  snipDrag = null;
  snipDropMark(null);
  if (!d) return;
  e.preventDefault();
  snipMove(s, d.to, false);
});

/* ---------- 常用（見 開發筆記 D134）：左欄換成常開的程式、檔案、資料夾、網址，點一下就開（程式就執行、資料夾用檔案總管、網址用瀏覽器） ----------
   存在這台電腦的設定檔（不在紀錄資料夾）；一筆用第幾筆＋target 認（跟剪貼簿的 index、raw 一樣，對不上主程序會拒絕）。
   調順序照剪貼簿（D125）：拖拉、Alt+↑↓；從檔案總管拖進來是加。編輯中（含加網址）別的動作重畫時先不重畫這塊 */
const LAUNCH_EMPTY = L('還沒有常用的。按上面的鈕加程式、資料夾、網址，或從檔案總管拖進來；之後點一下就開。');
const launchBusy = () => !!document.querySelector('.lp.editing');
async function refreshLaunch() {
  const list = await api.launchList();   // 先讀好再換，畫面不閃（D045）
  $('launchList').replaceChildren(...(list.length ? list.map(launchCard) : [el('div', 'empty', LAUNCH_EMPTY)]));
}
// 沒有 Windows 給的圖示時自己畫（資料夾、網址、找不到的；16×16 線條，照左欄上面那幾顆的畫法）
const LP_SVG = {
  url: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c-2.4 2.4-2.4 10.6 0 13M8 1.5c2.4 2.4 2.4 10.6 0 13',
  dir: 'M1.5 13.5v-10h4.5l1.5 1.5h7v8.5z',
  file: 'M3.5 14.5v-13h6l3 3v10zM9.5 1.5v3h3',
};
function lpIcon(x) {
  if (x.icon) { const img = el('img', 'lp-icon'); img.src = x.icon; img.alt = ''; return img; }
  const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
  for (const [k, v] of [['viewBox', '0 0 16 16'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.1'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) s.setAttribute(k, v);
  s.setAttribute('class', 'lp-icon');
  p.setAttribute('d', LP_SVG[x.kind] || LP_SVG.file);
  s.append(p);
  return s;
}
const launchOpen = x => act(async () => {
  await api.launchOpen(x.index, x.target);
  toast(L('已開啟「{name}」', { name: x.name }));
});
const launchRemove = x => act(async () => {
  await api.launchRemove(x.index, x.target);   // 只從清單拿掉，檔案、資料夾不動；不跳詢問（跟文件檢視的不釘一樣，D118）
  toast(L('已從常用拿掉「{name}」', { name: x.name }));
  await refreshLaunch();
});
function launchCard(x) {
  const box = el('div', 'lp' + (x.kind === 'missing' ? ' missing' : ''));
  const open = button('lp-open', null, () => launchOpen(x));
  open.title = x.target;   // 不翻：路徑、網址
  const text = el('span', 'lp-text');
  text.append(el('span', 'lp-name', x.name), el('span', 'lp-target', x.kind === 'missing' ? L('找不到：{path}', { path: x.target }) : x.target));
  open.append(lpIcon(x), text);
  // 調順序（照剪貼簿，D125）：整張拖得動；游標在上面 Alt+↑↓ 搬一格，碰到頂、底就不動
  box.draggable = true;
  box.addEventListener('dragstart', e => {
    if (launchBusy()) { e.preventDefault(); toast(LAUNCH_BUSY_MOVE, true); return; }
    launchDrag = x;
    e.dataTransfer.effectAllowed = 'move';
  });
  open.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const to = x.index + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= $('launchList').querySelectorAll(':scope > .lp').length) return;
    if (launchBusy()) { toast(LAUNCH_BUSY_MOVE, true); return; }
    launchMove(x, to, true);
  });
  box.addEventListener('contextmenu', e => {   // 右鍵選單（見下面 launchMenu）；編輯中的不出
    if (box.classList.contains('editing')) return;
    e.preventDefault();
    launchMenuAt = x;
    let { clientX: cx, clientY: cy } = e;
    if (!cx && !cy) { const r = box.getBoundingClientRect(); cx = r.left + 16; cy = r.bottom; }   // 鍵盤（選單鍵、Shift+F10）叫出來的：放在那張底下
    launchMenu(true, cx, cy);
  });
  // 滑過出現 ✎ ×（照記事清單，D116）：卡片矮，用字的「編輯」「刪除」會蓋到卡片中間、點了變成編輯
  const tools = el('span', 'lp-tools');
  const ed = button('edit', '✎', () => launchEdit(box, x));
  ed.title = L('編輯');
  const del = button('del', '×', () => launchRemove(x));
  del.title = L('從常用拿掉（檔案、資料夾不動）');
  tools.append(ed, del);
  box.append(open, tools);
  return box;
}
/* 編輯（x 是 null 時是加網址）：名稱（空的照預設：檔名、資料夾名稱、網址的主機名稱），網址的那筆多一格網址；
   程式、檔案、資料夾的路徑不能改（底下淡淡寫出來），要換就加一筆新的。Enter 儲存、Esc 取消；存不了（網址不對）表單留著 */
function launchEdit(box, x) {
  box.className = 'lp editing';
  box.draggable = false;   // 不然在框裡用滑鼠選字會變成拖整張（同剪貼簿，D125）
  box.textContent = '';
  const n = el('input', 'lp-name-in');
  n.value = x ? x.name : '';
  n.placeholder = L('名稱（空白就照預設）');
  const isUrl = !x || x.kind === 'url';
  const u = isUrl ? el('input', 'lp-url-in') : null;
  if (u) { u.value = x ? x.target : ''; u.placeholder = L('網址（http:// 或 https:// 開頭）'); }
  for (const f of [n, u]) if (f) f.spellcheck = false;
  const save = () => act(async () => {
    if (x) await api.launchEdit(x.index, x.target, { name: n.value, url: u ? u.value : undefined });
    else await api.launchAddUrl(n.value, u.value);
    await refreshLaunch();
  });
  for (const f of [n, u]) {
    if (!f) continue;
    f.addEventListener('keydown', e => {
      if (isEnter(e)) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); act(refreshLaunch); }
    });
  }
  const row = el('div', 'actions');
  row.append(button('save', L('儲存（Enter）'), save), button('cancel', L('取消'), () => act(refreshLaunch)));
  box.append(...(u ? [u, n] : [n, el('div', 'lp-path', x.target)]), row);
  (x ? n : u).focus();
}
const launchAdded = r => {
  if (r) toast(r.dup ? L('「{name}」已經在常用裡了', { name: r.name }) : L('已加到常用：{name}', { name: r.name }));
};
const launchPick = dir => act(async () => {
  const r = await api.launchAdd(dir);
  launchAdded(r);
  if (r && !launchBusy()) await refreshLaunch();
});
$('lpAddFile').addEventListener('click', () => launchPick(false));
$('lpAddDir').addEventListener('click', () => launchPick(true));
$('lpAddUrl').addEventListener('click', () => {
  const open = $('launchList').querySelector('.lp[data-new]');
  if (open) { open.querySelector('input').focus(); return; }   // 已經開著一張
  const box = el('div');
  box.dataset.new = '';
  $('launchList').querySelector(':scope > .empty')?.remove();
  $('launchList').append(box);   // 加在最後面：表單開在存了以後的位置（同剪貼簿，D126）
  launchEdit(box, null);
  $('launchList').scrollTop = $('launchList').scrollHeight;
});
/* 調順序（照剪貼簿的 snipMove、snipDropAt，D125）；從檔案總管拖檔案、資料夾進來是加（路徑由 preload 的 webUtils 拿） */
const LAUNCH_BUSY_MOVE = L('先儲存或取消正在編輯的那張，再調順序');
let launchDrag = null;   // 拖著的那一筆（launchList 給的，帶 index、target）
const launchMove = (x, to, focus) => act(async () => {
  await api.launchMove(x.index, x.target, to);
  await refreshLaunch();
  if (focus) $('launchList').querySelectorAll(':scope > .lp .lp-open')[to]?.focus();
});
function launchDropAt(e) {
  if (!launchDrag) return null;
  const cards = [...$('launchList').querySelectorAll(':scope > .lp')];
  const at = cards.filter(c => { const r = c.getBoundingClientRect(); return r.top + r.height / 2 < e.clientY; }).length;
  const to = at > launchDrag.index ? at - 1 : at;
  return to === launchDrag.index ? null : { at, to, cards };
}
function launchDropMark(d) {
  for (const c of $('launchList').querySelectorAll('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after');
  if (!d) return;
  if (d.at < d.cards.length) d.cards[d.at].classList.add('drop-before');
  else d.cards[d.at - 1].classList.add('drop-after');
}
const lpFiles = e => !launchDrag && [...e.dataTransfer.types].includes('Files');   // 從外面拖檔案進來（不是在清單裡搬）
$('launchList').addEventListener('dragover', e => {
  if (lpFiles(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $('launchList').classList.add('drop-in');
    return;
  }
  const d = launchDropAt(e);
  launchDropMark(d);
  if (!d) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
$('launchList').addEventListener('dragleave', e => {
  if ($('launchList').contains(e.relatedTarget)) return;
  launchDropMark(null);
  $('launchList').classList.remove('drop-in');
});
$('launchList').addEventListener('dragend', () => { launchDrag = null; launchDropMark(null); });
$('launchList').addEventListener('drop', e => {
  $('launchList').classList.remove('drop-in');
  if (lpFiles(e)) {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    act(async () => {
      const r = await api.launchAddPaths(paths);
      if (r.added.length) toast(L('已加到常用：{name}', { name: joinList(r.added) }));
      else if (r.dup.length) toast(L('「{name}」已經在常用裡了', { name: joinList(r.dup) }));
      else toast(L('拖進來的不是找得到的檔案或資料夾'), true);
      if (!launchBusy()) await refreshLaunch();
    });
    return;
  }
  const d = launchDropAt(e), x = launchDrag;
  launchDrag = null;
  launchDropMark(null);
  if (!d) return;
  e.preventDefault();
  launchMove(x, d.to, false);
});
/* 右鍵選單：開啟、編輯；在檔案總管中顯示（網址、找不到的沒有）、複製路徑／複製網址；從常用拿掉。按右鍵的那張框起來，選單收起來就拿掉 */
let launchMenuAt = null;   // 按右鍵的那一筆（launchList 給的）
const launchCardOf = x => (x ? $('launchList').querySelectorAll(':scope > .lp')[x.index] : null);
const launchMenuBack = () => launchCardOf(launchMenuAt)?.querySelector('.lp-open')?.focus();   // Esc、複製、在檔案總管中顯示之後游標回那一張
function launchMenu(open, x, y) {
  const m = $('launchMenu');
  m.hidden = !open;
  for (const c of $('launchList').querySelectorAll('.lp.sel')) c.classList.remove('sel');
  if (!open) return;
  const at = launchMenuAt, url = at.kind === 'url';
  launchCardOf(at)?.classList.add('sel');
  m.querySelector('[data-act="reveal"]').hidden = url || at.kind === 'missing';
  m.querySelector('[data-act="copy"]').hidden = url;
  m.querySelector('[data-act="copyUrl"]').hidden = !url;
  placeMenu(m, x, y);
}
$('launchMenu').addEventListener('click', e => {
  const what = e.target.closest('button')?.dataset.act, at = launchMenuAt;
  if (!what) return;
  launchMenu(false);
  if (what === 'open') { launchOpen(at); return; }
  if (what === 'edit') { const c = launchCardOf(at); if (c) launchEdit(c, at); return; }
  if (what === 'remove') { launchRemove(at); return; }
  act(async () => {
    if (what === 'reveal') await api.launchReveal(at.index, at.target);
    else { await api.copyText(at.target); toast(what === 'copyUrl' ? L('已複製網址') : L('已複製路徑')); }
    launchMenuBack();
  });
});
document.addEventListener('mousedown', e => { if (!$('launchMenu').hidden && !e.target.closest('#launchMenu')) launchMenu(false); });

/* ---------- 記事本（見 開發筆記 D102）：中間換成記事本，一份一個檔（資料夾的 記事本\名稱.txt） ----------
   存檔照 VS Code（D105）：Ctrl+S 才存，改過沒存的頁籤上一個 ●；「＋」開的新記事先不建檔，Ctrl+S 取名才存成檔。
   沒存的內容（新記事、改過沒存的）停手 0.6 秒暫存到這台電腦，關掉再開還在。正在看哪一份記在這台電腦。
   左邊記事清單、上面只放開著的頁籤（D116，照 VS Code）：記事本\ 底下可以開資料夾，記事、資料夾都用相對路徑認（工作/週會）；
   清單上點一下開成預覽的頁籤（點下一份就換掉）、點兩下或打字就留下來；× 是關掉頁籤，檔案還在，刪除在清單上。
   開著哪幾份、哪個是預覽、展開了哪些資料夾都記在這台電腦。
   一份記事是 { name, untitled }（name 是相對路徑；untitled＝還沒存成檔的新記事，name 就是頁籤上的名稱）。
   外面改了檔：沒改過的換成檔案的內容，改過沒存的留著畫面上的；在改名時先不重畫頁籤、清單 */
const notePad = {
  loaded: false,     // 暫存讀回來了沒：還沒讀就不寫，免得蓋掉上次留下的
  files: [],         // 記事本\ 底下全部的記事（相對路徑）
  dirs: [],          // 全部的資料夾（相對路徑）
  times: {},         // 每份記事的 [修改時間, 建立時間]（相對路徑 → 毫秒），清單照時間排用（D132）
  untitled: [],      // 新記事的名稱，照新增的順序
  folder: new Map(), // 新記事要存在哪個資料夾（名稱 → 相對路徑，'' 是最上層）
  open: [],          // 開著的頁籤（noteKey），照開的順序
  preview: null,     // 預覽的那個頁籤（noteKey）
  expanded: new Set(), // 清單上展開的資料夾
  sel: null,         // 清單上選到的那行（'f:' 記事、'd:' 資料夾＋相對路徑）：新增加在它的資料夾裡
  bufs: new Map(),   // 沒存的內容（key 見 noteKey）：新記事一定有，有名字的改過沒存才有
  shown: null,       // 文字框裡放的是哪一份（noteKey）
  saved: null,       // 文字框那份在檔案裡的內容（比對有沒有改過）；新記事、檔案不見了是 null
  timer: null,
};
let noteCur = (() => {
  try {
    const name = localStorage.getItem('daybook.note');
    return name ? { name, untitled: localStorage.getItem('daybook.noteUntitled') === '1' } : null;
  } catch { return null; }
})();
// 多游標（D106）：{ sels: [[anchor, head], …]（照位置排）, main: 文字框自己的是第幾個, whole: Ctrl+D 從沒選字開始的 }；一個游標時是 null
let noteMulti = null;
let noteDrag = null;   // 記事清單拖著的那行（noteKey，資料夾是 'd:'；D116），沒在拖是 null
const noteKey = n => (n.untitled ? 'u:' : 'f:') + n.name;
const noteOf = k => (k.startsWith('u:') ? { name: k.slice(2), untitled: true } : { name: k.slice(2) });
const sameNote = (a, b) => !!a && !!b && noteKey(a) === noteKey(b);
// 相對路徑（跟 shared/notes.js 的 parentOf、baseOf、within 一樣；畫面沒載入那個檔）
const noteParent = rel => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
const noteBase = rel => rel.slice(rel.lastIndexOf('/') + 1);
const noteWithin = (a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x === y || x.startsWith(y + '/'); };
// 新記事有字才算沒存（空的跟 VS Code 一樣不標 ●）
const noteDirty = n => n.untitled ? !!notePad.bufs.get(noteKey(n)) : notePad.bufs.has(noteKey(n));
const noteBusy = () => !!document.querySelector('.note-rename');
function setNoteCur(n) {
  noteCur = n;
  try {
    localStorage.setItem('daybook.note', n ? n.name : '');
    localStorage.setItem('daybook.noteUntitled', n && n.untitled ? '1' : '');
  } catch { /* 記不住就算了 */ }
  if (n && !n.untitled) {   // 清單跟著選到它、打開它在的資料夾（照 VS Code）
    notePad.sel = 'f:' + n.name;
    for (let d = noteParent(n.name); d; d = noteParent(d)) notePad.expanded.add(d);
    noteSaveList();
  }
}
/* 開著的頁籤、預覽、展開的資料夾記在這台電腦（還沒讀回上次記的就不寫，免得蓋掉） */
function noteSaveList() {
  if (!notePad.loaded) return;
  try {
    localStorage.setItem('daybook.noteTabs', JSON.stringify({ open: notePad.open, preview: notePad.preview }));
    localStorage.setItem('daybook.noteDirs', JSON.stringify([...notePad.expanded]));
  } catch { /* 記不住就算了 */ }
}
const noteTabs = () => notePad.open.map(noteOf);
/* 改名、搬了之後：開著的、預覽、沒存的、正在看的、選到的跟著換相對路徑；搬、改名的是資料夾（dir）就連底下的、展開的、新記事要存的地方一起換 */
function noteRekey(from, to, dir) {
  const map = p => (p === from ? to : dir && p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  const mapKey = k => {
    if (!k || !/^[fd]:/.test(k)) return k;   // 新記事不動
    const isDir = k[0] === 'd', p = k.slice(2);
    // 記事 a（a.txt）跟資料夾 a 可以同時有：改的是記事就不動資料夾，改的是資料夾就不動同名的那份記事
    if (isDir !== !!dir && (isDir || p === from)) return k;
    return k.slice(0, 2) + map(p);
  };
  notePad.open = notePad.open.map(mapKey);
  notePad.preview = mapKey(notePad.preview);
  notePad.sel = mapKey(notePad.sel);
  notePad.bufs = new Map([...notePad.bufs].map(([k, v]) => [mapKey(k), v]));
  notePad.shown = mapKey(notePad.shown);
  tabMru.note = tabMru.note.map(mapKey);   // Ctrl+Tab、Ctrl+Shift+T 記的也跟著換（D160）
  for (const c of tabClosed.note) c.key = mapKey(c.key);
  if (dir) {
    notePad.expanded = new Set([...notePad.expanded].map(map));
    for (const [n, d] of notePad.folder) notePad.folder.set(n, map(d));
  }
  if (noteCur && mapKey(noteKey(noteCur)) !== noteKey(noteCur)) setNoteCur(noteOf(mapKey(noteKey(noteCur))));
  noteSaveList();
}
/* 文字框的字收進 bufs：跟檔案一樣就不算改過；預覽的改了字就留下來（D116） */
function noteSync() {
  if (!noteCur || notePad.shown !== noteKey(noteCur)) return;
  const v = $('noteText').value;
  if (noteCur.untitled || v !== notePad.saved) notePad.bufs.set(noteKey(noteCur), v);
  else notePad.bufs.delete(noteKey(noteCur));
  if (notePad.preview === noteKey(noteCur) && noteDirty(noteCur)) { notePad.preview = null; noteSaveList(); }
}
/* 頁籤上的 ●、預覽的斜體、右上角的字 */
function noteMark() {
  for (const t of $('noteTabs').querySelectorAll('.noteTab[data-key]')) {
    const k = t.dataset.key;
    t.classList.toggle('dirty', noteDirty(noteOf(k)));
    t.classList.toggle('preview', notePad.preview === k);
  }
  $('noteSave').textContent = !noteCur ? '' : noteCur.untitled || noteDirty(noteCur) ? L('未存檔') : L('已存檔');
}
/* 暫存（D105）：停手 0.6 秒、換一份、存檔、刪掉、離開記事本時寫；關視窗、重新載入時（beforeunload）同步寫完才放行 */
const noteBackupData = () => ({
  untitled: notePad.untitled.map(name => ({ name, text: notePad.bufs.get('u:' + name) || '', folder: notePad.folder.get(name) || '' })),
  dirty: [...notePad.bufs].filter(([k]) => k.startsWith('f:')).map(([k, text]) => ({ name: k.slice(2), text })),
});
function noteBackup() {
  clearTimeout(notePad.timer);
  if (!notePad.loaded) return;
  noteSync();
  return api.writeNoteBackup(st.info.dataDir, noteBackupData()).catch(e => toast(errMsg(e), true));
}
addEventListener('beforeunload', () => {
  if (!notePad.loaded) return;
  noteSync();
  api.writeNoteBackupSync(st.info.dataDir, noteBackupData());
});
function setNoteMode(on) {
  if (on) document.documentElement.dataset.view = 'note';
  else delete document.documentElement.dataset.view;
  try { localStorage.setItem('daybook.view', on ? 'note' : ''); } catch { /* 記不住就算了 */ }
  actState();
  statusHints();   // 從 MD 檢視換過來時，狀態列不要留著 MD 檢視的（D118）
  if (!on) return noteBackup();   // 打到一半的先暫存
  return act(async () => { await refreshNotes(); $('noteText').focus(); });
}
/* MD 檢視（D118）：從記事本換過來時，打到一半的先暫存（跟離開記事本一樣） */
function setMdMode(on) {
  if (on && noteMode()) noteBackup();
  if (on) document.documentElement.dataset.view = 'md';
  else delete document.documentElement.dataset.view;
  try { localStorage.setItem('daybook.view', on ? 'md' : ''); } catch { /* 記不住就算了 */ }
  actState();
  statusHints();   // 狀態列換成 MD 檢視的／日記的
  if (on) return act(async () => { await refreshMd(); $('mdView').focus(); });
}
async function refreshNotes() {
  if (!notePad.loaded) {   // 第一次打開記事本：讀回上次沒存的（D105）、開著哪幾份（D116）
    const b = await api.readNoteBackup(st.info.dataDir);
    if (!notePad.loaded) {
      for (const u of b.untitled) { notePad.untitled.push(u.name); notePad.bufs.set('u:' + u.name, u.text); notePad.folder.set(u.name, u.folder || ''); }
      for (const d of b.dirty) notePad.bufs.set('f:' + d.name, d.text);
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('daybook.noteTabs')); } catch { /* 讀不到就當沒記過 */ }
      // 還沒記過（更新到有清單的這版後第一次打開）：只開上次在看的那份（使用者選的），新記事、改過沒存的下面會補上
      notePad.open = Array.isArray(saved?.open) ? saved.open.filter(k => typeof k === 'string') : noteCur ? [noteKey(noteCur)] : [];
      notePad.preview = typeof saved?.preview === 'string' ? saved.preview : null;
      try { notePad.expanded = new Set(JSON.parse(localStorage.getItem('daybook.noteDirs')) || []); } catch { /* 讀不到就全部收著 */ }
      notePad.loaded = true;
      if (noteCur && !noteCur.untitled) setNoteCur(noteCur);   // 清單選到正在看的那份
    }
  }
  noteSync();
  ({ files: notePad.files, dirs: notePad.dirs, times: notePad.times } = await api.listNotes());
  // 開著的頁籤：檔案不見了（外面刪掉、改名）又沒改過的拿掉；新記事、改過沒存的一定開著（沒開的接在最後面）
  const keep = k => (k.startsWith('u:') ? notePad.untitled.includes(k.slice(2)) : notePad.files.includes(k.slice(2)) || notePad.bufs.has(k));
  const open = notePad.open.filter((k, i, a) => keep(k) && a.indexOf(k) === i);
  for (const k of notePad.bufs.keys()) if (!open.includes(k) && keep(k)) open.push(k);
  notePad.open = open;
  if (!open.includes(notePad.preview)) notePad.preview = null;
  for (const d of notePad.expanded) if (!notePad.dirs.includes(d)) notePad.expanded.delete(d);
  if (notePad.sel && !(notePad.sel[0] === 'd' ? notePad.dirs : notePad.files).includes(notePad.sel.slice(2))) notePad.sel = null;
  const tabs = noteTabs();
  // 第一次、或那一份在外面被改名、刪掉了（沒改過）：看第一份
  if (!tabs.some(t => sameNote(t, noteCur))) setNoteCur(tabs[0] || null);
  if (noteCur) tabTouch('note', noteKey(noteCur));   // Ctrl+Tab 照最近看過的（D160）
  noteSaveList();
  if (!noteBusy()) {
    $('noteTabs').replaceChildren(...tabs.map(noteTab));
    if (!noteDrag) noteListRender();   // 拖拉中不重畫清單：拖著的那行被換掉，這次拖拉就斷了（拖完 dragend 再畫）
  }
  $('noteEdit').hidden = !noteCur;
  $('noteEmpty').hidden = !!noteCur;
  $('noteEmpty').textContent = notePad.files.length ? L('沒有開著的記事。從左邊的記事清單點一份來看，或按上面的「＋」新增一份。') : L('還沒有記事。按上面的「＋」新增一份。');
  if (!noteCur) { notePad.shown = null; noteMark(); return; }
  const cur = noteCur, k = noteKey(cur);
  const disk = cur.untitled || !notePad.files.includes(cur.name) ? null : await api.readNote(cur.name);
  if (!sameNote(cur, noteCur)) return;   // 讀的時候換了一份：那邊會再讀
  if (disk && disk.notUtf8) {   // 不是 UTF-8 的檔不開（見 開發筆記 D139）：關掉那個頁籤，檔案不動
    toast(L('「{name}」不是 UTF-8 編碼，打不開：用記事本打開，「另存新檔」時編碼選 UTF-8，再開一次', { name: noteBase(cur.name) }), true, 8000);
    await noteClose([k]);
    return;
  }
  const a = $('noteText');
  if (notePad.shown !== k) {   // 換了一份：沒存的優先，沒有就是檔案的
    a.value = notePad.bufs.has(k) ? notePad.bufs.get(k) : disk ?? '';
    notePad.shown = k;
    noteMulti = null;   // 多游標（D106）是那一份的
  } else if (a.value === notePad.saved && disk != null && disk !== a.value) {   // 同一份、沒改過：換成檔案現在的內容（外面改了）
    a.value = disk;
    noteMulti = null;
  }
  notePad.saved = disk;
  noteSync();
  noteMark();
  noteRender();   // 換了內容：行號、找到的字重算（程式改 value 不會觸發 input）
  $('noteTabs').querySelector('.noteTab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
$('noteText').addEventListener('input', () => {
  noteSync();
  noteMark();
  clearTimeout(notePad.timer);
  notePad.timer = setTimeout(noteBackup, 600);
});
/* 有名字的寫進檔案；在外面被刪掉、改名了就照原本的路徑再建一份 */
const noteStore = (rel, text) => (notePad.files.includes(rel) ? api.writeNote(rel, text)
  : api.createNote(noteParent(rel), noteBase(rel), text, notePad.untitled));
/* Ctrl+S：有名字的寫進檔案；新記事先在頁籤上取名 */
const noteSave = () => act(async () => {
  if (!noteCur || noteBusy()) return;
  noteSync();
  if (noteCur.untitled) { noteNameIt(noteCur); return; }
  if (!noteDirty(noteCur)) return;
  const cur = noteCur, text = $('noteText').value;
  await noteStore(cur.name, text);
  if (sameNote(cur, noteCur)) notePad.saved = text;
  else if (notePad.bufs.get(noteKey(cur)) === text) notePad.bufs.delete(noteKey(cur));   // 存的時候換了一份
  noteSync();
  noteMark();
  noteBackup();
  if (!notePad.files.includes(cur.name)) await refreshNotes();
});

/* 行號（D103）：自動換行，行號照真的換行算、折下來的不標號。文字框底下墊一層一模一樣的透明字（#noteMirror），
   一行一個 div，量每個 div 的位置放行號；找字開著時（D104）找到的字在這層包 <mark>，透過文字框看得到；
   多游標（D106）時文字框自己那個以外的選取、游標也畫在這層。
   打字、換一份、視窗大小變了就重畫（同一個畫面更新只畫一次）；捲動時這層和行號跟著文字框捲 */
const noteFind = { hits: [], at: -1 };   // 找到的位置 [起, 訖)、目前第幾個
let noteFrame = 0;
const noteLater = () => { if (!noteFrame) noteFrame = requestAnimationFrame(() => { noteFrame = 0; noteRender(); }); };
function noteScroll() {
  const t = $('noteText').scrollTop;
  $('noteMirror').scrollTop = t;
  $('noteGutter').scrollTop = t;
}
function noteRender() {
  const a = $('noteText'), m = $('noteMirror');
  if (!noteCur || !a.clientWidth) return;   // 沒有記事、或記事本沒開（量不到）
  const v = a.value;
  // 找字開著就照現在的內容重找；目前那個的順序不變（超過就最後一個）
  if (!$('noteFind').hidden) {
    noteFind.hits = noteMatches(v, $('noteFindQ').value);
    noteFind.at = noteFind.hits.length ? Math.min(Math.max(noteFind.at, 0), noteFind.hits.length - 1) : -1;
    noteFindCount();
  }
  // 寬高照文字框扣掉捲軸（clientWidth），換行才一樣
  m.style.width = a.clientWidth + 'px';
  m.style.height = a.clientHeight + 'px';
  // 要標的（都照位置排好）：找到的字（不會跨行）；多游標的其他選取（可能跨行）、其他游標
  const hits = noteFind.hits;
  const others = noteMulti ? noteMulti.sels.filter((_, i) => i !== noteMulti.main) : [];
  const sels = others.filter(s => s[0] !== s[1]).map(s => [selLo(s), selHi(s)]);
  const carets = others.map(s => s[1]).sort((x, y) => x - y);
  const rows = [];
  let pos = 0, hp = 0, sp = 0, cp = 0;
  for (const line of v.split('\n')) {
    const row = el('div');
    const end = pos + line.length;
    while (sp < sels.length && sels[sp][1] <= pos) sp++;
    while (cp < carets.length && carets[cp] < pos) cp++;
    const hs = [], ss = [], cs = [];
    for (let i = hp; i < hits.length && hits[i][0] < end; i++) hs.push(i);
    for (let i = sp; i < sels.length && sels[i][0] < end; i++) ss.push(sels[i]);
    for (let i = cp; i < carets.length && carets[i] <= end; i++) cs.push(carets[i]);
    // 切開的地方：每個標記的頭尾；游標要包住後面那一個字（在行尾就包前面那一個），畫在那個字的左（右）邊
    const cuts = new Set([pos, end]);
    for (const i of hs) { cuts.add(hits[i][0]); cuts.add(hits[i][1]); }
    for (const s of ss) { cuts.add(Math.max(s[0], pos)); cuts.add(Math.min(s[1], end)); }
    for (const c of cs) {
      if (c < end) { cuts.add(c); cuts.add(c + (v.codePointAt(c) > 0xffff ? 2 : 1)); }
      else if (end > pos) cuts.add(end - (/[\udc00-\udfff]/.test(v[end - 1]) && end - pos > 1 ? 2 : 1));
    }
    const pts = [...cuts].sort((x, y) => x - y);
    for (let j = 0; j + 1 < pts.length; j++) {
      const x = pts[j], y = pts[j + 1];
      const hit = hs.find(i => hits[i][0] <= x && hits[i][1] >= y);
      const cls = [];
      if (hit !== undefined && hit === noteFind.at) cls.push('on');
      if (ss.some(s => s[0] <= x && s[1] >= y)) cls.push('sel');
      if (cs.includes(x)) cls.push('caret');
      if (y === end && cs.includes(end)) cls.push('caret-end');
      if (hit === undefined && !cls.length) row.append(v.slice(x, y));
      else row.append(el(hit !== undefined ? 'mark' : 'span', cls.join(' ') || null, v.slice(x, y)));
    }
    if (!line) {   // 空行也要佔一行高
      if (cs.includes(pos)) row.append(el('span', 'caret-empty'));
      row.append(el('br'));
    }
    rows.push(row);
    while (hp < hits.length && hits[hp][0] <= end) hp++;
    pos = end + 1;
  }
  m.replaceChildren(...rows);
  const nums = $('noteNums');
  nums.style.width = Math.max(2, String(rows.length).length) + 'ch';
  nums.style.height = m.scrollHeight + 'px';
  nums.replaceChildren(...rows.map((r, i) => {
    const n = el('div', null, String(i + 1));
    n.style.top = r.offsetTop + 'px';
    return n;
  }));
  noteScroll();
}
$('noteText').addEventListener('input', noteLater);
$('noteText').addEventListener('scroll', noteScroll);
new ResizeObserver(noteLater).observe($('noteWrap'));   // 視窗大小、縮放變了，換行跟著變

/* 找字（D104）：只找正在看的那份，不分大小寫、照字面找。打字就找，從游標後面那個開始；
   Enter／↓ 下一個、Shift+Enter／↑ 上一個（到底了繞回來）；Esc、× 關掉，游標回文字框、選著目前那個。找的字留著，下次打開還在 */
function noteMatches(text, q) {
  if (!q) return [];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return [...text.matchAll(re)].map(x => [x.index, x.index + x[0].length]);
}
function noteFindCount() {
  const n = noteFind.hits.length;
  $('noteFindN').textContent = n ? `${noteFind.at + 1} / ${n}` : $('noteFindQ').value ? L('沒有結果') : '';
}
/* 目前那個捲到看得到的地方（在畫面外才捲，放在上面三分之一），文字框也選著它 */
function noteFindShow() {
  noteMulti = null;   // 選著找到的那個，回到一個游標（D106）
  noteRender();
  const hit = noteFind.hits[noteFind.at];
  if (!hit) return;
  const a = $('noteText');
  a.setSelectionRange(hit[0], hit[1]);
  const mk = $('noteMirror').querySelector('mark.on');
  if (mk && (mk.offsetTop < a.scrollTop || mk.offsetTop + mk.offsetHeight > a.scrollTop + a.clientHeight)) {
    a.scrollTop = mk.offsetTop - a.clientHeight / 3;
    noteScroll();
  }
}
function noteFindRun() {
  noteFind.hits = noteMatches($('noteText').value, $('noteFindQ').value);
  const caret = $('noteText').selectionStart;
  const i = noteFind.hits.findIndex(x => x[0] >= caret);
  noteFind.at = noteFind.hits.length ? (i < 0 ? 0 : i) : -1;
  noteFindCount();
  noteFindShow();
}
function noteFindStep(d) {
  const n = noteFind.hits.length;
  if (!n) return;
  noteFind.at = (noteFind.at + d + n) % n;
  noteFindCount();
  noteFindShow();
}
function noteFindOpen() {
  if (!noteCur) return;
  const a = $('noteText');
  const sel = a.value.slice(a.selectionStart, a.selectionEnd);
  if (sel && !sel.includes('\n')) $('noteFindQ').value = sel;   // 選著一段字就拿來找（跟 VS Code 一樣）
  if ($('noteFind').hidden) noteReplShow(false);   // 剛打開：只有找字那列（Ctrl+H 才有取代，D108）
  $('noteFind').hidden = false;
  $('noteFindQ').focus();
  $('noteFindQ').select();
  noteFindRun();   // 從游標（選著一段就是它的開頭）後面那個開始
}
function noteFindClose() {
  if ($('noteFind').hidden) return;
  const hit = noteFind.hits[noteFind.at];
  $('noteFind').hidden = true;
  noteFind.hits = [];
  noteFind.at = -1;
  if (hit) noteMulti = null;
  noteRender();
  const a = $('noteText');
  a.focus();
  if (hit) a.setSelectionRange(hit[0], hit[1]);
}
/* F3／Shift+F3（見 開發筆記 D150，照 VS Code）：框開著就下一個／上一個；框關著：叫出框、游標留在原地，用上次找的字（沒有才拿選著的字），
   從游標（選著一段就是它的後面）往後找、Shift+F3 往前；從沒找過、也沒選字就跟 Ctrl+F 一樣 */
function noteFindKey(d) {
  if (!noteCur) return;
  if (!$('noteFind').hidden) { noteFindStep(d); return; }
  const a = $('noteText');
  if (!$('noteFindQ').value) {
    const sel = a.value.slice(a.selectionStart, a.selectionEnd);
    if (!sel || sel.includes('\n')) { noteFindOpen(); return; }
    $('noteFindQ').value = sel;
  }
  noteReplShow(false);   // 剛打開：只有找字那列（同 Ctrl+F）
  $('noteFind').hidden = false;
  const hits = noteFind.hits = noteMatches(a.value, $('noteFindQ').value);
  const i = d > 0 ? hits.findIndex(x => x[0] >= a.selectionEnd) : hits.findLastIndex(x => x[1] <= a.selectionStart);
  noteFind.at = hits.length ? (i < 0 ? (d > 0 ? 0 : hits.length - 1) : i) : -1;
  noteFindCount();
  noteFindShow();
}
$('noteFindQ').addEventListener('input', noteFindRun);
$('noteFindQ').addEventListener('keydown', e => {
  if (isEnter(e)) { e.preventDefault(); noteFindStep(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); noteFindClose(); }
});
$('noteText').addEventListener('keydown', e => { if (e.key === 'Escape' && !$('noteFind').hidden) { e.preventDefault(); noteFindClose(); } });
$('noteFindNext').addEventListener('click', () => noteFindStep(1));
$('noteFindPrev').addEventListener('click', () => noteFindStep(-1));
$('noteFindClose').addEventListener('click', noteFindClose);

/* 取代（見 開發筆記 D108）：Ctrl+H 打開找字的框、多一列「取代」（▸ 也能開關）；找的規則跟找字一樣（不分大小寫、照字面），換上去的照打的字。
   取代：換掉目前那個，跳到換上去的字後面那個；全部取代：一次換掉全部，提示換了幾個。都走 noteApply，Ctrl+Z 一次復原 */
function noteReplShow(on) {
  $('noteReplRow').hidden = !on;
  $('noteFindMore').textContent = on ? '▾' : '▸';
  $('noteFindMore').setAttribute('aria-expanded', String(on));
}
function noteReplOpen() {
  noteFindOpen();
  if (!noteCur) return;
  noteReplShow(true);
  if ($('noteFindQ').value) { $('noteReplQ').focus(); $('noteReplQ').select(); }   // 要找的已經有了（選著字、上次找的）：直接打要換成什麼
}
function noteReplOne() {
  const hit = noteFind.hits[noteFind.at];
  if (!hit) return;
  const r = $('noteReplQ').value;
  noteApply([[hit[0], hit[1], r]], [[hit[0] + r.length, hit[0] + r.length]], 0);
  noteFind.hits = noteMatches($('noteText').value, $('noteFindQ').value);
  const i = noteFind.hits.findIndex(x => x[0] >= hit[0] + r.length);
  noteFind.at = noteFind.hits.length ? (i < 0 ? 0 : i) : -1;
  noteFindCount();
  noteFindShow();
}
function noteReplAll() {
  const hits = noteFind.hits;
  if (!hits.length) return;
  const r = $('noteReplQ').value;
  let d = 0, p = 0;
  for (const [x, y] of hits) { p = x + d + r.length; d += r.length - (y - x); }   // 游標放在最後換的那個後面
  noteApply(hits.map(([x, y]) => [x, y, r]), [[p, p]], 0);
  noteFind.hits = noteMatches($('noteText').value, $('noteFindQ').value);
  noteFind.at = noteFind.hits.length ? 0 : -1;
  noteFindCount();
  noteRender();
  toast(L('已取代 {n} 個', { n: hits.length }));
}
$('noteFindMore').addEventListener('click', () => noteReplShow($('noteReplRow').hidden));
$('noteRepl1').addEventListener('click', noteReplOne);
$('noteReplAll').addEventListener('click', noteReplAll);
$('noteReplQ').addEventListener('keydown', e => {
  if (isEnter(e) && e.ctrlKey && e.altKey) { e.preventDefault(); noteReplAll(); }
  else if (isEnter(e)) { e.preventDefault(); noteReplOne(); }
  if (e.key === 'Escape') { e.preventDefault(); noteFindClose(); }
});
$('noteFindQ').addEventListener('keydown', e => {   // 找字那列也能全部取代（取代那列開著時）
  if (isEnter(e) && e.ctrlKey && e.altKey && !$('noteReplRow').hidden) { e.preventDefault(); e.stopImmediatePropagation(); noteReplAll(); }
}, true);

/* 跳到第幾行（見 開發筆記 D108）：Ctrl+G 上面中間跳出小框，打行號按 Enter 跳過去：游標放行頭，在畫面外就捲到上面三分之一（跟找字一樣）；
   比最後一行大就到最後一行，不是數字就不動；Esc、點別的地方關掉 */
function noteGotoOpen() {
  if (!noteCur) return;
  const q = $('noteGotoQ');
  q.placeholder = L('跳到第幾行（1～{n}），按 Enter', { n: $('noteText').value.split('\n').length });
  q.value = '';
  $('noteGoto').hidden = false;
  q.focus();
}
function noteGoto(line) {
  const a = $('noteText'), lines = a.value.split('\n');
  const n = Math.min(line, lines.length);
  let p = 0;
  for (let i = 0; i < n - 1; i++) p += lines[i].length + 1;
  noteMulti = null;
  a.focus();
  a.setSelectionRange(p, p);
  noteRender();
  const row = $('noteMirror').children[n - 1];
  if (row && (row.offsetTop < a.scrollTop || row.offsetTop + row.offsetHeight > a.scrollTop + a.clientHeight)) {
    a.scrollTop = row.offsetTop - a.clientHeight / 3;
    noteScroll();
  }
}
$('noteGotoQ').addEventListener('keydown', e => {
  if (isEnter(e)) {
    e.preventDefault();
    const n = parseInt($('noteGotoQ').value, 10);
    if (!(n >= 1)) return;
    $('noteGoto').hidden = true;
    noteGoto(n);
  }
  if (e.key === 'Escape') { e.preventDefault(); $('noteGoto').hidden = true; $('noteText').focus(); }
});
$('noteGotoQ').addEventListener('blur', () => { $('noteGoto').hidden = true; });

/* ---------- 多游標（見 開發筆記 D106）：照 VS Code 的 Ctrl+D ----------
   Ctrl+D：沒選字就選游標所在的那個詞；選著字就再選下一個一樣的（大小寫要一樣，到底了從頭找，已經選了的跳過）。
   好幾個選取時，打字、輸入法、Backspace、Delete、Enter、Tab、貼上、剪下、複製、方向鍵、Home、End 都每一個一起；
   Esc、點一下、全選、Ctrl+Z 回到一個（最後選的那個）。
   選取一律寫成 [anchor, head]（head 是游標那頭）。文字框自己的選取是 noteMulti.main 那個，其他的畫在墊底那層（noteRender） */
function selLo(s) { return Math.min(s[0], s[1]); }
function selHi(s) { return Math.max(s[0], s[1]); }
let noteWord = null;   // Ctrl+D 從沒選字開始選到的詞 { from, to, v }：下一個 Ctrl+D 就不找黏在英數字中間的
let noteEditing = false;   // 自己在改（noteApply）：beforeinput 不要再攔
function noteSels() {
  if (noteMulti) return noteMulti.sels;
  const a = $('noteText');
  return [a.selectionDirection === 'backward' ? [a.selectionEnd, a.selectionStart] : [a.selectionStart, a.selectionEnd]];
}
const noteMainIdx = () => noteMulti ? noteMulti.main : 0;
/* 換成這組選取：照位置排、重疊的（游標碰在一起的也算）併成一個；剩一個就是一般的文字框 */
function noteSetSels(sels, main, whole) {
  const a = $('noteText');
  const list = sels.map((s, i) => ({ s: [...s], main: i === main })).sort((x, y) => selLo(x.s) - selLo(y.s) || selHi(x.s) - selHi(y.s));
  const out = [];
  for (const o of list) {
    const p = out[out.length - 1];
    if (p && (selLo(o.s) < selHi(p.s) || selLo(o.s) === selHi(p.s) && (o.s[0] === o.s[1] || p.s[0] === p.s[1]))) {
      p.s = [selLo(p.s), Math.max(selHi(p.s), selHi(o.s))];
      p.main = p.main || o.main;
    } else out.push(o);
  }
  const m = out.findIndex(o => o.main);
  noteMulti = out.length > 1 ? { sels: out.map(o => o.s), main: m, whole: !!whole } : null;
  const [x, y] = out[m].s;
  a.setSelectionRange(Math.min(x, y), Math.max(x, y), x > y ? 'backward' : 'forward');
  noteRender();
}
const noteSingle = () => { if (noteMulti) { noteMulti = null; noteRender(); } };
/* 一次改好幾段（[起, 訖, 換成的字]，照位置排、不重疊）：包成一次 insertText，Ctrl+Z 一次復原；改完換成 sels（改完的位置） */
function noteApply(edits, sels, main) {
  const a = $('noteText'), v = a.value, whole = noteMulti && noteMulti.whole;
  edits = edits.filter(([x, y, t]) => x < y || t);
  if (edits.length) {
    const from = edits[0][0], to = edits[edits.length - 1][1];
    let mid = '', p = from;
    for (const [x, y, t] of edits) { mid += v.slice(p, x) + t; p = y; }
    mid += v.slice(p, to);
    const top = a.scrollTop, prev = document.activeElement;
    if (prev !== a) a.focus({ preventScroll: true });   // execCommand 改的是有焦點的那個（取代時焦點在取代的框，D108）
    noteEditing = true;
    a.setSelectionRange(from, to);
    document.execCommand(mid ? 'insertText' : 'delete', false, mid);
    noteEditing = false;
    if (prev !== a && prev) prev.focus({ preventScroll: true });
    a.scrollTop = top;   // 插進去的地方離得遠時，文字框會捲到最後改的那裡；捲回來，下面再捲到主要那個游標
  }
  noteSetSels(sels, main, whole);
  noteReveal();
}
/* 每個選取各換一段：fn(選取, 第幾個) 回 [起, 訖, 字]（可以比選取大，例如 Backspace 多刪前面一個字）；改完游標在換上的字後面 */
function noteEachEdit(fn) {
  const sels = noteSels(), main = noteMainIdx();
  const edits = [];
  for (const e of sels.map(fn)) {   // 選取照位置排，換的範圍也是；重疊的（例如兩個游標都往前刪到同一個詞）併起來
    const p = edits[edits.length - 1];
    if (p && e[0] < p[1]) { p[1] = Math.max(p[1], e[1]); p[2] += e[2]; p.n++; } else edits.push(Object.assign([...e], { n: 1 }));
  }
  let d = 0;
  const out = [];
  for (const [x, y, t, ] of edits) { const c = x + d + t.length; out.push([c, c]); d += t.length - (y - x); }
  // 併過的就少幾個游標，主要那個照順序對過去
  let k = 0, mi = 0;
  edits.forEach((e, i) => { if (main >= k && main < k + e.n) mi = i; k += e.n; });
  noteApply(edits, out, mi);
}
/* 詞（Ctrl+D、Ctrl+←→）：用 Intl.Segmenter 切，中文也切得出詞（週會、發票），英數字一串一個 */
// 行頭、行尾（p 在第 0 格時 lastIndexOf 的起點會變成 0，開頭就是換行的話會找到它，所以另外判斷）
const noteLineStart = (v, p) => p > 0 ? v.lastIndexOf('\n', p - 1) + 1 : 0;
const noteLineEnd = (v, p) => { const e = v.indexOf('\n', p); return e < 0 ? v.length : e; };
const noteSeg = new Intl.Segmenter('zh-TW', { granularity: 'word' });
function noteWords(v, p) {   // p 那一行的詞 [[起, 訖], …]
  const s = noteLineStart(v, p);
  return [...noteSeg.segment(v.slice(s, noteLineEnd(v, p)))].filter(x => x.isWordLike).map(x => [s + x.index, s + x.index + x.segment.length]);
}
function noteWordAt(v, p) {
  const ws = noteWords(v, p);
  return ws.find(w => w[0] <= p && p < w[1]) || ws.find(w => w[1] === p) || null;
}
function noteWordLeft(v, p) {
  const s = noteLineStart(v, p);
  if (p === s) return Math.max(0, p - 1);
  const w = noteWords(v, p).filter(x => x[0] < p).pop();
  return w ? w[0] : s;
}
function noteWordRight(v, p) {
  const e = noteLineEnd(v, p);
  if (p === e) return Math.min(v.length, p + 1);
  const w = noteWords(v, p).find(x => x[1] > p);
  return w ? w[1] : e;
}
const notePrev = (v, p) => p - (p > 1 && /[\udc00-\udfff]/.test(v[p - 1]) ? 2 : 1);   // 前一個字（emoji 這種兩格的一起）
const noteNext = (v, p) => p + (v.codePointAt(p) > 0xffff ? 2 : 1);
/* 位置 p 在畫面上的哪裡：量墊底那層（D103）那一行裡的字 */
function notePosRect(p) {
  const v = $('noteText').value;
  const row = $('noteMirror').children[(v.slice(0, p).match(/\n/g) || []).length];
  if (!row) return null;
  let left = p - noteLineStart(v, p);
  const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (left > n.length) { left -= n.length; continue; }
    const r = document.createRange();
    r.setStart(n, left);
    const rect = r.getClientRects()[0];
    if (rect) return rect;
    break;
  }
  return row.getBoundingClientRect();
}
/* 主要那個游標在畫面外才捲，捲到剛好看得到（上下留內距） */
function noteReveal() {
  const a = $('noteText');
  const r = notePosRect(noteSels()[noteMainIdx()][1]);
  if (!r) return;
  const box = a.getBoundingClientRect(), pad = 12;
  if (r.top < box.top + pad) a.scrollTop -= box.top + pad - r.top;
  else if (r.bottom > box.top + a.clientHeight - pad) a.scrollTop += r.bottom - (box.top + a.clientHeight - pad);
  noteScroll();
}
/* Ctrl+D */
function noteAddNext() {
  const v = $('noteText').value, sels = noteSels(), main = noteMainIdx(), m = sels[main];
  if (m[0] === m[1]) {   // 沒選字：選游標所在的詞（好幾個游標就每個都選）
    const ws = sels.map(s => noteWordAt(v, s[1]));
    if (!ws[main]) return;
    if (!noteMulti) noteWord = { from: ws[0][0], to: ws[0][1], v };
    noteSetSels(sels.map((s, i) => ws[i] || s), main, true);
    noteReveal();
    return;
  }
  const q = v.slice(selLo(m), selHi(m));
  const whole = noteMulti ? noteMulti.whole : !!noteWord && noteWord.v === v && noteWord.from === selLo(m) && noteWord.to === selHi(m);
  // 從沒選字開始的：英數字的詞不找黏在英數字中間的（apple 不找 pineapple 裡的）；中文沒有空白隔開，不管
  const glued = (a, b) => /\w/.test(a || '') && /\w/.test(b || '');
  const ok = i => !sels.some(s => selLo(s) < i + q.length && selHi(s) > i)
    && !(whole && (glued(v[i - 1], q[0]) || glued(q[q.length - 1], v[i + q.length])));
  let i = v.indexOf(q, selHi(m));
  while (i >= 0 && !ok(i)) i = v.indexOf(q, i + 1);
  if (i < 0) {   // 到底了：從頭找到主要那個為止
    i = v.indexOf(q);
    while (i >= 0 && i < selLo(m) && !ok(i)) i = v.indexOf(q, i + 1);
    if (i >= selLo(m)) i = -1;
  }
  if (i < 0) return;   // 全部都選了
  noteSetSels([...sels, [i, i + q.length]], sels.length, whole);
  noteReveal();
}
/* 方向鍵、Home、End（多游標時）：每一個一起動；Shift 是拉選取；上下照真的換行算、欄位一樣（折行不算） */
function noteMove(key, ctrl, shift) {
  const v = $('noteText').value;
  const lineStart = p => noteLineStart(v, p), lineEnd = p => noteLineEnd(v, p);
  const sels = noteSels().map(([an, hd]) => {
    let h = hd;
    const empty = an === hd;
    if (key === 'ArrowLeft') h = !shift && !empty ? Math.min(an, hd) : ctrl ? noteWordLeft(v, hd) : hd > 0 ? notePrev(v, hd) : 0;
    else if (key === 'ArrowRight') h = !shift && !empty ? Math.max(an, hd) : ctrl ? noteWordRight(v, hd) : hd < v.length ? noteNext(v, hd) : hd;
    else if (key === 'Home') { const s = lineStart(hd), f = s + v.slice(s, lineEnd(hd)).search(/\S|$/); h = hd === f ? s : f; }
    else if (key === 'End') h = lineEnd(hd);
    else {   // ↑↓
      const s = lineStart(hd), col = hd - s;
      if (key === 'ArrowUp') h = s === 0 ? 0 : Math.min(lineStart(s - 1) + col, s - 1);
      else { const e = lineEnd(hd); h = e === v.length ? v.length : Math.min(e + 1 + col, lineEnd(e + 1)); }
    }
    return [shift ? an : h, h];
  });
  noteSetSels(sels, noteMainIdx(), noteMulti && noteMulti.whole);
  noteReveal();
}
/* ---------- 整行、縮排（見 開發筆記 D107）：照 VS Code ----------
   都照「選取碰到的那幾行」做（選到下一行的行頭為止的，那一行不算）；多游標時每一段一起；走 noteApply，Ctrl+Z 一次復原 */
/* 選取碰到的行：[[第一行行頭, 最後一行行尾], …]，重疊的併起來（adjacent：連著的也併） */
function noteBlocks(v, sels, adjacent) {
  const out = [];
  for (const s of sels) {
    const a = selLo(s), b = selHi(s);
    const blk = [noteLineStart(v, a), noteLineEnd(v, b > a && noteLineStart(v, b) === b ? b - 1 : b)];
    const p = out[out.length - 1];
    if (p && (blk[0] <= p[1] || adjacent && blk[0] === p[1] + 1)) p[1] = Math.max(p[1], blk[1]); else out.push(blk);
  }
  return out;
}
const noteBlockOf = (blocks, s) => blocks.find(([a, b]) => selLo(s) >= a && selLo(s) <= b);
/* 改了好幾段之後，原本的位置 x 在哪：在 x 前面改的照長短推；x 被換掉的那段裡就停在那段開頭；剛好插在 x 的不推（縮排時行頭的游標留在行頭） */
function noteMapPos(x, edits) {
  let d = 0;
  for (const [f, t, s] of edits) {
    if (f >= x) break;
    if (t <= x) { d += s.length - (t - f); continue; }
    return f + d;
  }
  return x + d;
}
/* Alt+↑↓：整行往上／往下搬（碰到頂、底就不動） */
function noteMoveLines(dir) {
  const v = $('noteText').value, sels = noteSels();
  const blocks = noteBlocks(v, sels, true);
  if (dir < 0 ? blocks[0][0] === 0 : blocks[blocks.length - 1][1] === v.length) return;
  const edits = [], shift = new Map();
  for (const b of blocks) {
    const [s, e] = b;
    if (dir < 0) {   // 跟上一行換位置
      const ps = noteLineStart(v, s - 1);
      edits.push([ps, e, v.slice(s, e) + '\n' + v.slice(ps, s - 1)]);
      shift.set(b, ps - s);
    } else {
      const ne = noteLineEnd(v, e + 1);
      edits.push([s, ne, v.slice(e + 1, ne) + '\n' + v.slice(s, e)]);
      shift.set(b, ne - e);
    }
  }
  noteApply(edits, sels.map(x => { const k = shift.get(noteBlockOf(blocks, x)); return [x[0] + k, x[1] + k]; }), noteMainIdx());
}
/* Shift+Alt+↑↓：整行複製一份，游標跟著到下面那份（↓）或留在上面那份（↑） */
function noteCopyLines(dir) {
  const v = $('noteText').value, sels = noteSels();
  const blocks = noteBlocks(v, sels, false);
  const edits = [], shift = new Map();
  let d = 0;
  for (const b of blocks) {
    const t = v.slice(b[0], b[1]) + '\n';
    edits.push([b[0], b[0], t]);
    shift.set(b, d + (dir > 0 ? t.length : 0));
    d += t.length;
  }
  noteApply(edits, sels.map(x => { const k = shift.get(noteBlockOf(blocks, x)); return [x[0] + k, x[1] + k]; }), noteMainIdx());
}
/* Ctrl+Shift+K、沒選字時的 Ctrl+X：刪掉整行；游標到接上來的那一行（刪的是最後一行就是上一行）、欄位盡量一樣 */
function noteDeleteLines() {
  const v = $('noteText').value, sels = noteSels();
  const blocks = noteBlocks(v, sels, true);
  const edits = [], out = [];
  let d = 0;
  for (const b of blocks) {
    const [s, e] = b, h = sels.find(x => noteBlockOf(blocks, x) === b)[1];
    const col = h - noteLineStart(v, h);
    const last = e === v.length;
    const [ls, le] = !last ? [e + 1, noteLineEnd(v, e + 1)] : s > 0 ? [noteLineStart(v, s - 1), s - 1] : [0, 0];
    const p = (last ? ls : s) - d + Math.min(col, le - ls);
    edits.push(last ? [Math.max(0, s - 1), e, ''] : [s, e + 1, '']);
    out.push([p, p]);
    d += edits[edits.length - 1][1] - edits[edits.length - 1][0];
  }
  noteApply(edits, out, Math.min(noteMainIdx(), out.length - 1));
}
/* Tab、Shift+Tab：選取跨好幾行（或 Shift+Tab）就每一行行頭加一個 Tab（空行不加）／拿掉一個 Tab 或最多 4 個空白；不然把選取換成 Tab */
function noteIndent(back) {
  const v = $('noteText').value, sels = noteSels();
  const blocks = noteBlocks(v, sels, false);
  if (!back && !blocks.some(([s, e]) => v.slice(s, e).includes('\n'))) { noteEachEdit(s => [selLo(s), selHi(s), '\t']); return; }
  const edits = [];
  for (const [s, e] of blocks) {
    for (let ls = s; ls <= e; ls = noteLineEnd(v, ls) + 1) {
      const le = noteLineEnd(v, ls);
      if (!back) { if (le > ls) edits.push([ls, ls, '\t']); continue; }
      const m = v.slice(ls, le).match(/^(\t| {1,4})/);
      if (m) edits.push([ls, ls + m[0].length, '']);
    }
  }
  if (edits.length) noteApply(edits, sels.map(s => [noteMapPos(s[0], edits), noteMapPos(s[1], edits)]), noteMainIdx());
}
/* Enter：新的一行帶上一行行頭的 Tab、空白（游標前面那段） */
function noteEnter() {
  const v = $('noteText').value;
  noteEachEdit(s => { const a = selLo(s); return [a, selHi(s), '\n' + v.slice(noteLineStart(v, a), a).match(/^[\t ]*/)[0]]; });
}

/* 鍵盤：Ctrl+D、整行、縮排、Enter 什麼時候都收（D106、D107）；其他的只在多游標時收。
   在 capture 階段先攔，找字的 Esc（D104）才不會也跑一次 */
$('noteText').addEventListener('keydown', e => {
  if (e.isComposing || e.key === 'Process') return;
  const k = e.key, ctrl = e.ctrlKey, shift = e.shiftKey, alt = e.altKey;
  const take = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (ctrl && !shift && !alt && k.toLowerCase() === 'd') { take(); noteAddNext(); return; }
  if (alt && !ctrl && (k === 'ArrowUp' || k === 'ArrowDown')) { take(); (shift ? noteCopyLines : noteMoveLines)(k === 'ArrowUp' ? -1 : 1); return; }
  if (ctrl && shift && !alt && k.toLowerCase() === 'k') { take(); noteDeleteLines(); return; }
  if (k === 'Tab' && !ctrl && !alt) { take(); noteIndent(shift); return; }
  if (k === 'Enter' && !ctrl && !alt) { take(); noteEnter(); return; }
  if (!noteMulti) return;
  const v = $('noteText').value;
  if (k === 'Escape' && !ctrl && !shift && !alt) { take(); noteSingle(); }
  else if (!alt && (['ArrowLeft', 'ArrowRight'].includes(k) || !ctrl && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k))) { take(); noteMove(k, ctrl, shift); }
  else if (k === 'Backspace' && !alt) {
    take();
    noteEachEdit(s => s[0] !== s[1] ? [selLo(s), selHi(s), ''] : [ctrl ? noteWordLeft(v, s[1]) : Math.max(0, notePrev(v, s[1])), s[1], '']);
  } else if (k === 'Delete' && !alt) {
    take();
    noteEachEdit(s => s[0] !== s[1] ? [selLo(s), selHi(s), ''] : [s[1], ctrl ? noteWordRight(v, s[1]) : Math.min(v.length, noteNext(v, s[1])), '']);
  } else if (ctrl && !alt && ['a', 'z', 'y'].includes(k.toLowerCase())) noteSingle();   // 全選、復原、取消復原：交給文字框，回到一個
  else if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(k)) noteSingle();   // 沒做的移動：交給文字框
}, true);
/* 打字（多游標時）：每個選取都換成打的字；拖放這些沒做的，交給文字框、回到一個 */
$('noteText').addEventListener('beforeinput', e => {
  if (!noteMulti || noteEditing || e.isComposing || e.inputType.includes('Composition')) return;
  if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
    e.preventDefault();
    const t = e.data ?? (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
    noteEachEdit(s => [selLo(s), selHi(s), t]);
  } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
    e.preventDefault();
    noteEachEdit(s => [selLo(s), selHi(s), '\n']);
  } else noteSingle();
});
/* 輸入法（多游標時）：選字中只在文字框自己那個游標打，選好了再補到其他的 */
let noteComp = null;
$('noteText').addEventListener('compositionstart', () => {
  noteComp = noteMulti ? { v: $('noteText').value, sels: noteMulti.sels.map(s => [...s]), main: noteMulti.main } : null;
});
$('noteText').addEventListener('compositionend', e => {
  const c = noteComp;
  noteComp = null;
  if (!c) return;
  setTimeout(() => {   // 等輸入法自己收完再改
    const v = $('noteText').value, t = e.data || '', m = c.sels[c.main];
    if (v !== c.v.slice(0, selLo(m)) + t + c.v.slice(selHi(m))) { noteMulti = null; noteRender(); return; }   // 輸入法做了別的事：回到一個游標
    const d = t.length - (selHi(m) - selLo(m));
    const at = x => x > selLo(m) ? x + d : x;   // 原本的位置 → 現在的位置
    const edits = [], sels = [];
    let dd = 0;
    c.sels.forEach((s, i) => {
      if (i === c.main) { const p = selLo(m) + t.length + dd; sels.push([p, p]); return; }
      edits.push([at(selLo(s)), at(selHi(s)), t]);
      const p = at(selLo(s)) + dd + t.length;
      sels.push([p, p]);
      dd += t.length - (selHi(s) - selLo(s));
    });
    noteMulti = { sels: c.sels, main: c.main, whole: false };
    noteApply(edits, sels, c.main);
  });
});
/* 複製、剪下：沒選字就是整行（D107，連換行）；多游標時每個選取的字一行一個。
   貼上：整行複製來的、又沒選字，插在游標那一行上面（D107）；多游標時行數跟游標一樣多就一個游標一行，不然每個都貼整段 */
let noteLineClip = null;   // 上次整行複製的字：貼的時候認得出來
function noteClip(e, cut) {
  const v = $('noteText').value, sels = noteSels();
  if (sels.every(s => s[0] === s[1])) {
    e.preventDefault();
    noteLineClip = noteBlocks(v, sels, false).map(([s, t]) => v.slice(s, t) + '\n').join('');
    e.clipboardData.setData('text/plain', noteLineClip);
    if (cut) noteDeleteLines();
    return;
  }
  noteLineClip = null;
  if (!noteMulti) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', sels.map(s => v.slice(selLo(s), selHi(s))).join('\n'));
  if (cut) noteEachEdit(s => [selLo(s), selHi(s), '']);
}
$('noteText').addEventListener('copy', e => noteClip(e, false));
$('noteText').addEventListener('cut', e => noteClip(e, true));
$('noteText').addEventListener('paste', e => {
  const t = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'), sels = noteSels();
  if (t && t === noteLineClip && sels.every(s => s[0] === s[1])) {
    e.preventDefault();
    const v = $('noteText').value;
    const starts = [...new Set(sels.map(s => noteLineStart(v, s[1])))];
    const lines = t.slice(0, -1).split('\n');   // 多游標、行數一樣多：一行插一個
    const edits = starts.map((ls, i) => [ls, ls, starts.length > 1 && lines.length === starts.length ? lines[i] + '\n' : t]);
    // 游標跟著自己那一行往下推（插在它行頭的也算）
    noteApply(edits, sels.map(s => { const k = edits.filter(([f]) => f <= s[1]).reduce((n, x) => n + x[2].length, 0); return [s[0] + k, s[1] + k]; }), noteMainIdx());
    return;
  }
  if (!noteMulti) return;
  e.preventDefault();
  const lines = t.split('\n'), n = sels.length;
  noteEachEdit((s, i) => [selLo(s), selHi(s), lines.length === n ? lines[i] : t]);
});
$('noteText').addEventListener('mousedown', noteSingle);   // 點一下：交給文字框，回到一個
/* 頁籤（D116 起只放開著的）：寫最後一段的名稱；開著好幾份同名的（在不同資料夾）後面淡淡寫在哪個資料夾。
   點兩下：預覽的是留下來，其他是改名；× 是關掉 */
function noteTab(n) {
  const k = noteKey(n), base = n.untitled ? n.name : noteBase(n.name);
  const tab = el('div', 'noteTab' + (sameNote(n, noteCur) ? ' on' : '') + (noteDirty(n) ? ' dirty' : '') + (notePad.preview === k ? ' preview' : ''));
  tab.dataset.key = k;
  tab.draggable = true;   // 拖頁籤調順序（D160）
  const nm = button('noteName', base, () => openNote(n));
  if (!n.untitled && notePad.open.some(o => o !== k && o.startsWith('f:') && noteBase(o.slice(2)).toLowerCase() === base.toLowerCase())) {
    nm.append(el('span', 'noteDirHint', noteParent(n.name) || L('最上層')));
  }
  const where = notePad.folder.get(n.name);
  nm.title = n.untitled ? (where ? L('{name}（還沒存檔；點兩下或 Ctrl+S 取名存檔，存在「{where}」）', { name: n.name, where }) : L('{name}（還沒存檔；點兩下或 Ctrl+S 取名存檔）', { name: n.name }))
    : !notePad.files.includes(n.name) ? L('{name}（檔案在外面被刪掉或改名了；Ctrl+S 照這個名稱再存一份）', { name: n.name })
    : notePad.preview === k ? L('{name}（預覽：清單上點下一份就換掉；點兩下或打字就留下來）', { name: n.name }) : L('{name}（點兩下改名）', { name: n.name });
  nm.addEventListener('dblclick', () => {
    if (notePad.preview !== k) { renameNote(tab, n); return; }
    notePad.preview = null;
    noteSaveList();
    act(refreshNotes);
  });
  const del = button('noteDel', '×', () => closeNote(n));
  del.title = n.untitled ? L('關掉（有字會先問要不要存）') : L('關掉（改過沒存會先問；檔案還在，要刪在左邊的記事清單）');
  tab.append(nm, del);
  return tab;
}
/* 換一份：沒存的留在 bufs、暫存起來，游標放到開頭。
   from（D116）：'list' 是清單上點一下，還沒開的開成預覽（有預覽的就換掉它、放在它的位置），游標留在清單（照 VS Code）；
   'pin' 是點兩下，還沒開的開成一般的頁籤、預覽的留下來。沒給是點頁籤 */
const openNote = (n, from) => act(async () => {
  const k = noteKey(n);
  if (from && !notePad.open.includes(k)) {
    const i = from === 'list' ? notePad.open.indexOf(notePad.preview) : -1;
    if (i >= 0) notePad.open[i] = k; else notePad.open.push(k);
    if (from === 'list') notePad.preview = k;
  } else if (from === 'pin' && notePad.preview === k) notePad.preview = null;
  if (!sameNote(n, noteCur)) {
    noteSync();
    setNoteCur(n);
    await refreshNotes();
    $('noteText').setSelectionRange(0, 0);
    noteBackup();
  } else if (from) await refreshNotes();   // 同一份：預覽留下來、清單選到它
  if (from === 'list') return;
  if (!noteBusy()) $('noteText').focus();   // 點兩下改名時，第一下換過來之後不要把游標從改名框搶走
});
/* 新記事（D105）：新記事 N，頁籤接在最後面；先不建檔。
   存在清單上選到的資料夾（選到的是記事就是它在的那個；沒選是最上層，D116）。頁籤列的「＋」、清單上面那顆都是這個 */
const noteTarget = () => {
  const s = notePad.sel, d = !s ? '' : s[0] === 'd' ? s.slice(2) : noteParent(s.slice(2));
  return notePad.dirs.includes(d) ? d : '';
};
const noteNew = () => act(async () => {
  noteSync();
  const folder = noteTarget();
  const name = await api.newNoteName(notePad.untitled, folder);
  notePad.untitled.push(name);
  notePad.folder.set(name, folder);
  notePad.bufs.set('u:' + name, '');
  notePad.open.push('u:' + name);
  setNoteCur({ name, untitled: true });
  await refreshNotes();
  noteBackup();
  $('noteText').focus();
});
$('noteAdd').addEventListener('click', noteNew);
$('nlAddNote').addEventListener('click', noteNew);
/* 新記事取名的預設（D105）：第一個有字的行，拿掉檔名不能用的字，最多 40 個字 */
const noteSuggest = text => (text.split('\n').find(l => l.trim()) || '')
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 40).replace(/[.\s]+$/, '');
const noteNameIt = n => {
  const tab = [...$('noteTabs').querySelectorAll('.noteTab')].find(t => t.dataset.key === noteKey(n));
  if (tab) renameNote(tab, n);
};
/* 改名、新記事取名存檔（D105）：頁籤換成輸入框；Enter 改好（名稱不行就提示、留著改），Esc 取消，點別的地方也算改好（不行就還原）。
   新記事預設帶第一行，改好就建檔（存在新增時選到的資料夾，D116）；有名字的改過沒存的跟著換名稱，還是沒存 */
function renameNote(tab, n) {
  if (noteBusy()) return;
  const input = el('input', 'note-rename');
  const base = n.untitled ? n.name : noteBase(n.name);
  input.value = n.untitled ? noteSuggest(notePad.bufs.get(noteKey(n)) || '') || n.name : base;
  input.spellcheck = false;
  tab.replaceChildren(input);
  input.focus();
  input.select();
  let state = 'editing';
  const finish = async (ok, blur) => {
    if (state !== 'editing') return;
    const to = input.value.trim();
    if (ok && (n.untitled || to !== base)) {
      state = 'saving';
      try {
        noteSync();
        const k = noteKey(n), buf = notePad.bufs.get(k);
        const others = notePad.untitled.filter(u => !(n.untitled && u === n.name));
        if (n.untitled) {
          const rel = await api.createNote(notePad.folder.get(n.name) || '', to, buf || '', others);
          notePad.bufs.delete(k);
          notePad.untitled = others;
          notePad.folder.delete(n.name);
          notePad.open = notePad.open.map(o => (o === k ? 'f:' + rel : o));
          if (sameNote(n, noteCur)) {
            setNoteCur({ name: rel });
            notePad.shown = 'f:' + rel;
            notePad.saved = buf || '';
          }
        } else noteRekey(n.name, await api.renameNote(n.name, to, others), false);
        noteBackup();
      } catch (e) {
        toast(errMsg(e), true);
        state = 'editing';
        if (!blur) { input.focus(); return; }
      }
    }
    state = 'done';
    input.remove();
    await act(refreshNotes);
    if (!blur && noteCur) $('noteText').focus();   // Enter、Esc：回到文字框接著打（點別的地方的不搶）
  };
  input.addEventListener('keydown', e => {
    if (isEnter(e)) { e.preventDefault(); finish(true, false); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false, false); }
  });
  input.addEventListener('blur', () => finish(true, true));
}
/* ×（D116 起是關掉頁籤，檔案還在；刪除在清單上）：改過沒存的先問存／不存／取消，新記事沒字直接關（D105） */
const closeNote = n => act(async () => {
  noteSync();
  if (noteDirty(n)) { noteAsk({ n }); return; }
  await noteClose([noteKey(n)], true);
});
/* 關掉這幾個頁籤（沒存的丟掉）：關掉、刪掉、存好再關都走這裡。關掉的有正在看的那份就換到右邊那份，沒有就左邊那份。
   focus：使用者關的（×、右鍵、Ctrl+W、中鍵，D160）——關完游標回文字框、記進「剛關掉的」（Ctrl+Shift+T 重開）；刪掉、打不開的不記 */
async function noteClose(keys, focus) {
  if (focus) tabRemember('note', keys);
  const tabs = notePad.open, i = noteCur ? tabs.indexOf(noteKey(noteCur)) : -1;
  if (i >= 0 && keys.includes(tabs[i])) {
    const next = [...tabs.slice(i + 1), ...tabs.slice(0, i).reverse()].find(k => !keys.includes(k));
    setNoteCur(next ? noteOf(next) : null);
  }
  for (const k of keys) {
    notePad.bufs.delete(k);
    if (k.startsWith('u:')) { notePad.untitled = notePad.untitled.filter(u => u !== k.slice(2)); notePad.folder.delete(k.slice(2)); }
  }
  notePad.open = notePad.open.filter(k => !keys.includes(k));
  if (keys.includes(notePad.preview)) notePad.preview = null;
  noteBackup();
  await refreshNotes();
  if (focus && noteCur) $('noteText').focus();
}
/* 改過沒存的按 ×：問存／不存／取消（照 VS Code、Notepad++）。存＝新記事在頁籤上取名存檔、有名字的寫進檔案再關；Esc、點外面＝取消。
   刪除也問這一次：有記事的資料夾（D116，游標先放在取消）、按 Delete 鍵（D117，游標放在「確定刪除」，問完游標回清單）。
   頁籤右鍵一次關好幾個（D120，使用者選一次問）：改過沒存的列出來，好幾份時是「全部存」「全部不存」；新記事沒名字，存的時候留著不關（要自己取名） */
let noteAsking = null;   // { n }：問存不存；{ del, count, key }：問刪除（del 是清單那行的 key，count 是資料夾裡有幾份記事）；{ close, dirty }：一次關好幾個（都是 noteKey）
const noteKeyName = k => (k.startsWith('u:') ? k.slice(2) : noteBase(k.slice(2)));   // 頁籤上寫的名稱
function noteAsk(a) {
  noteAsking = a;
  const del = !!a.del, many = a.dirty && a.dirty.length > 1, newOnes = a.dirty ? a.dirty.filter(k => k.startsWith('u:')).length : 0;
  const base = del ? noteBase(a.del.slice(2)) : a.dirty ? noteKeyName(a.dirty[0]) : a.n.untitled ? a.n.name : noteBase(a.n.name);
  $('noteAskMsg').textContent = many ? L('有 {n} 份還沒存，要存起來嗎？', { n: a.dirty.length }) : !del ? L('「{name}」還沒存，要存起來嗎？', { name: base })
    : a.count ? L('「{name}」資料夾裡有 {n} 份記事，整個丟到資源回收筒？', { name: base, n: a.count })
    : a.del[0] === 'd' ? L('把「{name}」資料夾丟到資源回收筒？', { name: base }) : L('把「{name}」丟到資源回收筒？', { name: base });
  $('noteAskSub').textContent = a.dirty ? (many ? L('{list}。', { list: joinList(a.dirty.map(noteKeyName)) }) : '') + (newOnes ? L('新記事沒有名字，存的時候先留著不關（自己取名）。') : L('不存的話，這次改的就不見了（檔案留著上次存的）。'))
    : del ? L('要救回來，到資源回收筒還原就好。') : a.n.untitled ? L('不存的話，打的字就不見了。') : L('不存的話，這次改的就不見了（檔案留著上次存的）。');
  $('noteAskSave').textContent = del ? L('確定刪除') : many ? L('全部存') : L('存');
  $('noteAskDrop').textContent = many ? L('全部不存') : L('不存');
  $('noteAskDrop').hidden = del;
  $('noteAsk').hidden = false;
  (del && !a.key ? $('noteAskCancel') : $('noteAskSave')).focus();
}
function noteAskDone(choice) {
  const a = noteAsking;
  noteAsking = null;
  $('noteAsk').hidden = true;
  if (!a) return;
  if (a.del) {
    if (choice === 'save') act(async () => { await noteRemoveNow(a.del); if (a.key) noteListFocus(); });
    else if (a.key) noteListFocus();
    return;
  }
  if (a.close) {   // 一次關好幾個（D120）：存＝有名字的寫進去再關、新記事留著；不存＝全部關掉；取消＝都不關
    const keep = choice === 'save' ? a.dirty.filter(k => k.startsWith('u:')) : [];
    if (choice === 'save') act(async () => {
      for (const k of a.dirty) if (k.startsWith('f:')) await noteStore(k.slice(2), notePad.bufs.get(k));
      await noteClose(a.close.filter(k => !keep.includes(k)), true);
      if (keep.length) toast(L('{n} 份新記事還沒取名，留著沒關', { n: keep.length }));
    });
    else if (choice === 'drop') act(() => noteClose(a.close, true));
    else if (noteCur) $('noteText').focus();
    return;
  }
  const n = a.n, k = noteKey(n);
  if (choice === 'save' && n.untitled) noteNameIt(n);
  else if (choice === 'save') act(async () => { await noteStore(n.name, notePad.bufs.get(k)); await noteClose([k], true); });
  else if (choice === 'drop') act(() => noteClose([k], true));
  else if (noteCur) $('noteText').focus();
}
$('noteAskSave').addEventListener('click', () => noteAskDone('save'));
$('noteAskDrop').addEventListener('click', () => noteAskDone('drop'));
$('noteAskCancel').addEventListener('click', () => noteAskDone(null));
$('noteAsk').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); noteAskDone(null); } });
$('noteAsk').addEventListener('mousedown', e => { if (e.target === $('noteAsk')) noteAskDone(null); });   // 點外面（灰的那層）

/* ---------- 記事清單（見 開發筆記 D116）：記事本時左欄放這個，照 VS Code 的檔案總管 ----------
   照名稱排（數字照大小、不分大小寫；記事可以換成修改時間、建立日期，D132）、資料夾在前面；點資料夾展開／收起，點記事開成預覽、點兩下留著（openNote）。
   點了的那行是「選到的」，新增加在它的資料夾裡；點空白的地方不選（最上層）。
   滑過、選到的那行出現 ✎ 改名、× 丟資源回收筒（記事不問，D102；有記事的資料夾問一次，使用者選的）；拖到資料夾搬過去 */
const noteColl = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/* 排序（見 開發筆記 D132）：記事清單、文件檢視清單上面的排序鈕，照名稱／修改時間／建立日期，時間的可以換新的在上面、舊的在上面。
   兩個清單各記各的（這台電腦的 daybook.noteSort、daybook.mdSort），沒記過照名稱、新的在上面。
   資料夾不跟著：一律在前面、照名稱（使用者選的）。時間一樣、讀不到時間的照名稱 */
const listSort = { note: { by: 'name', desc: true }, md: { by: 'name', desc: true } };
for (const w of ['note', 'md']) {
  try {
    const s = JSON.parse(localStorage.getItem(`daybook.${w}Sort`));
    if (['name', 'mtime', 'birth'].includes(s?.by)) listSort[w] = { by: s.by, desc: s.desc !== false };
  } catch { /* 讀不到就照名稱 */ }
}
const nameOrder = (a, b) => noteColl.compare(noteBase(a), noteBase(b));
// 檔案的排法：w 是哪個清單，times 是相對路徑 → [修改時間, 建立時間]
function fileOrder(w, times) {
  const s = listSort[w], i = s.by === 'mtime' ? 0 : 1;
  if (s.by === 'name') return nameOrder;
  return (a, b) => ((times[a]?.[i] || 0) - (times[b]?.[i] || 0)) * (s.desc ? -1 : 1) || nameOrder(a, b);
}
/* 排序鈕點了在底下彈出 #sortMenu（兩個清單共用）：選到的打勾，照名稱時「新的在上面／舊的在上面」淡色點不了。
   點一個就收起來、照新的排；再點排序鈕、Esc、點外面也收起來（Esc、選了之後游標回排序鈕） */
let sortMenuAt = null;   // 'note'、'md'：開著的是哪個清單的
const sortBtn = w => $(w === 'md' ? 'mdSort' : 'nlSort');
function sortMenu(w) {
  const m = $('sortMenu');
  if (sortMenuAt) sortBtn(sortMenuAt).setAttribute('aria-expanded', 'false');
  sortMenuAt = w || null;
  m.hidden = !w;
  if (!w) return;
  const s = listSort[w];
  for (const b of m.querySelectorAll('[data-by]')) b.setAttribute('aria-checked', String(b.dataset.by === s.by));
  for (const b of m.querySelectorAll('[data-desc]')) {
    b.setAttribute('aria-checked', String(!!b.dataset.desc === s.desc));
    b.disabled = s.by === 'name';
  }
  sortBtn(w).setAttribute('aria-expanded', 'true');
  const r = sortBtn(w).getBoundingClientRect();
  placeMenu(m, r.left, r.bottom + 2);
}
for (const w of ['note', 'md']) sortBtn(w).addEventListener('click', () => sortMenu(sortMenuAt === w ? null : w));
$('sortMenu').addEventListener('click', e => {
  const b = e.target.closest('button'), w = sortMenuAt;
  if (!b || !w) return;
  if (b.dataset.by) listSort[w].by = b.dataset.by; else listSort[w].desc = !!b.dataset.desc;
  try { localStorage.setItem(`daybook.${w}Sort`, JSON.stringify(listSort[w])); } catch { /* 記不住就算了 */ }
  sortMenu(null);
  sortBtn(w).focus();
  if (w === 'md') mdListRender(); else noteListRender();
});
document.addEventListener('mousedown', e => { if (!$('sortMenu').hidden && !e.target.closest('#sortMenu, #nlSort, #mdSort')) sortMenu(null); });
// 記事在不在這個資料夾底下（記事 a 跟資料夾 a 可以同時有，自己不算）
const noteUnder = (f, dir) => f.toLowerCase().startsWith(dir.toLowerCase() + '/');
function noteListRender() {
  const had = $('noteTree').contains(document.activeElement);   // 游標在清單上：重畫後放回選到的那行（F2、Delete 才接得下去，D117）
  // 找記事（D117）：只看名稱、不分大小寫，空白隔開的每個詞都要有；留下符合的記事和它們在的資料夾（都打開，不記成展開）
  const words = $('nlQ').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = words.length ? new Set(notePad.files.filter(f => words.every(w => noteBase(f).toLowerCase().includes(w)))) : null;
  const hitDirs = new Set();
  if (hit) for (const f of hit) for (let d = noteParent(f); d; d = noteParent(d)) hitDirs.add(d);
  const order = fileOrder('note', notePad.times);   // 記事照選的排，資料夾照名稱（D132）
  const rows = [];
  const walk = (dir, depth) => {
    for (const d of notePad.dirs.filter(x => noteParent(x) === dir && (!hit || hitDirs.has(x))).sort(nameOrder)) {
      rows.push(noteRow(d, true, depth, !!hit));
      if (hit || notePad.expanded.has(d)) walk(d, depth + 1);
    }
    for (const f of notePad.files.filter(x => noteParent(x) === dir && (!hit || hit.has(x))).sort(order)) rows.push(noteRow(f, false, depth));
  };
  walk('', 0);
  if (hit && !hit.size) rows.push(el('div', 'nlNone', L('沒有符合的記事')));
  $('noteTree').replaceChildren(...rows);
  if (had) noteListFocus();
}
// 游標放回清單：選到的那行，沒有（沒選、被篩掉、收在資料夾裡）就是清單本身
const noteListFocus = () => (noteRowOf(notePad.sel)?.querySelector('.nlName') || $('noteTree')).focus();
/* 資料夾前面的箭頭（記事清單、文件檢視清單，D163）：照 VS Code 的 chevron，打開時轉 90 度看按鈕的 aria-expanded（style.css）。
   大綱的標題列（index.html）是同一個圖 */
const ARROW_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function arrowEl() {
  const s = el('span', 'nlArrow');
  s.innerHTML = ARROW_SVG;   // 固定的字串，不是檔案裡的東西
  return s;
}
function noteRow(rel, isDir, depth, opened) {
  const k = (isDir ? 'd:' : 'f:') + rel, open = opened || notePad.expanded.has(rel);
  const row = el('div', 'nlRow' + (notePad.sel === k ? ' sel' : '') + (!isDir && noteCur && noteKey(noteCur) === k ? ' on' : ''));
  row.dataset.key = k;
  row.draggable = true;
  row.style.paddingLeft = 4 + depth * 12 + (isDir ? 0 : 16) + 'px';   // 記事空出箭頭的位置，名稱跟同一層的資料夾對齊
  const name = button('nlName', isDir ? null : noteBase(rel), () => noteListClick(k));
  name.setAttribute('role', 'treeitem');
  name.title = rel;
  if (isDir) {
    name.append(arrowEl(), noteBase(rel));
    name.setAttribute('aria-expanded', String(open));
  } else name.addEventListener('dblclick', () => openNote(noteOf(k), 'pin'));
  const tools = el('span', 'nlTools');
  const ren = button(null, '✎', () => noteListRename(row, k));
  ren.title = L('改名');
  const del = button(null, '×', () => noteRemove(k));
  del.title = isDir ? L('刪除這個資料夾（丟到資源回收筒；裡面有記事會先問）') : L('刪除（丟到資源回收筒）');
  tools.append(ren, del);
  row.append(name, tools);
  return row;
}
const noteRowOf = k => [...$('noteTree').querySelectorAll('.nlRow')].find(r => r.dataset.key === k);
function noteListClick(k) {
  notePad.sel = k;
  if (k[0] === 'f') { openNote(noteOf(k), 'list'); return; }
  const d = k.slice(2);
  if (notePad.expanded.has(d)) notePad.expanded.delete(d); else notePad.expanded.add(d);
  noteSaveList();
  noteListRender();
}
$('noteTree').addEventListener('click', e => {
  // 只認點在空白的地方（點在一行上時，那行的按鈕可能已經把自己換掉、不在畫面上了，往上找不到 .nlRow）
  if (e.target !== e.currentTarget) return;
  notePad.sel = null;
  noteListRender();
});
$('nlCollapse').addEventListener('click', () => {
  notePad.expanded.clear();
  noteSaveList();
  noteListRender();
});
/* 清單上的輸入框（改名、新資料夾）：把 row 換成輸入框；Enter 做 commit（丟錯就提示、框留著改），Esc 取消，
   點別的地方也算 Enter（丟錯就還原）；做完重畫。跟頁籤的改名一樣（renameNote）。
   Enter、Esc 之後游標回清單選到的那行（照 VS Code，F2 改完接著按得到，D117）；點別的地方的不搶 */
function noteInput(row, value, commit) {
  const input = el('input', 'note-rename');
  input.value = value;
  input.spellcheck = false;
  row.draggable = false;
  row.replaceChildren(input);
  input.focus();
  input.select();
  let state = 'editing';
  const finish = async (ok, blur) => {
    if (state !== 'editing') return;
    if (ok) {
      state = 'saving';
      try { await commit(input.value.trim()); } catch (e) {
        toast(errMsg(e), true);
        state = 'editing';
        if (!blur) { input.focus(); return; }
      }
    }
    state = 'done';
    input.remove();
    await act(refreshNotes);
    if (!blur) noteListFocus();
  };
  input.addEventListener('keydown', e => {
    if (isEnter(e)) { e.preventDefault(); finish(true, false); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false, false); }
  });
  input.addEventListener('blur', () => finish(true, true));
}
/* 改名：記事、資料夾都是同一個資料夾裡換名稱；開著的頁籤、沒存的跟著換。改的那行算選到（照 VS Code，D117） */
function noteListRename(row, k) {
  if (noteBusy()) return;
  notePad.sel = k;
  const isDir = k[0] === 'd', from = k.slice(2);
  noteInput(row, noteBase(from), async to => {
    if (to === noteBase(from)) return;
    noteSync();
    noteRekey(from, isDir ? await api.renameNoteDir(from, to) : await api.renameNote(from, to, notePad.untitled), isDir);
    noteBackup();
  });
}
/* 新增資料夾：加在選到的資料夾裡（展開它），那裡多一行輸入框，Enter 建、空的不建；建好選到它。清單上面那顆、右鍵選單都是這個 */
function noteAddDir() {
  if (noteBusy()) return;
  const parent = noteTarget();
  if (parent) notePad.expanded.add(parent);
  noteSaveList();
  noteListRender();
  const row = el('div', 'nlRow');
  row.style.paddingLeft = 4 + (parent ? parent.split('/').length : 0) * 12 + 'px';
  const at = parent && noteRowOf('d:' + parent);
  if (at) at.after(row); else $('noteTree').prepend(row);
  noteInput(row, '', async name => {
    if (!name) return;
    notePad.sel = 'd:' + await api.addNoteDir(parent, name);
  });
  row.scrollIntoView({ block: 'nearest' });
}
$('nlAddDir').addEventListener('click', noteAddDir);
/* 刪除（×、右鍵）：記事不問，改過沒存的先寫進去再丟（D105）、開著的頁籤關掉；資料夾裡有記事先問一次，沒有就直接丟。
   key 是按 Delete 鍵（D117）：一律先問，游標放在「確定刪除」，Enter 就是確定（使用者選的） */
const noteRemove = (k, key) => act(async () => {
  noteSync();
  const count = k[0] === 'd' ? notePad.files.filter(f => noteUnder(f, k.slice(2))).length : 0;
  if (key || count) noteAsk({ del: k, count, key }); else await noteRemoveNow(k);
});
async function noteRemoveNow(k) {
  const rel = k.slice(2);
  if (k[0] === 'd') { await noteDelDir(rel); return; }
  await api.deleteNote(rel, notePad.bufs.has(k) ? notePad.bufs.get(k) : null);
  await noteClose([k]);
  toast(L('已把「{name}」丟到資源回收筒', { name: noteBase(rel) }));
}
async function noteDelDir(rel) {
  noteSync();
  const keys = [...new Set([...notePad.open, ...notePad.bufs.keys()])].filter(k => k.startsWith('f:') && noteUnder(k.slice(2), rel));
  await api.deleteNoteDir(rel, keys.filter(k => notePad.bufs.has(k)).map(k => ({ name: k.slice(2), text: notePad.bufs.get(k) })));
  for (const d of [...notePad.expanded]) if (noteWithin(d, rel)) notePad.expanded.delete(d);
  await noteClose(keys);
  toast(L('已把「{name}」資料夾丟到資源回收筒', { name: noteBase(rel) }));
}
/* 拖拉搬過去：拖到資料夾那行＝搬進那個資料夾，拖到記事那行＝搬進它在的資料夾，拖到空白的地方＝最上層；
   原本就在那裡的、資料夾拖進自己裡面都不算（不框、放開也不動） */
function noteDropTo(e) {
  if (!noteDrag) return null;
  const k = e.target.closest('.nlRow')?.dataset.key;
  const to = !k ? '' : k[0] === 'd' ? k.slice(2) : noteParent(k.slice(2)), from = noteDrag.slice(2);
  if (noteParent(from) === to || noteDrag[0] === 'd' && noteWithin(to, from)) return null;
  return to;
}
function noteDropMark(to) {
  for (const r of $('noteTree').querySelectorAll('.drop')) r.classList.remove('drop');
  $('noteTree').classList.remove('drop');
  if (to != null) (to ? noteRowOf('d:' + to) : $('noteTree'))?.classList.add('drop');
}
$('noteTree').addEventListener('dragstart', e => {
  const k = e.target.closest('.nlRow')?.dataset.key;
  if (!k) return;
  noteDrag = k;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', k.slice(2));
});
$('noteTree').addEventListener('dragover', e => {
  const to = noteDropTo(e);
  noteDropMark(to);
  if (to == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
$('noteTree').addEventListener('dragleave', e => { if (!$('noteTree').contains(e.relatedTarget)) noteDropMark(null); });
$('noteTree').addEventListener('dragend', () => { noteDrag = null; noteDropMark(null); if (!noteBusy()) noteListRender(); });   // 拖的時候沒畫的補畫
$('noteTree').addEventListener('drop', e => {
  const to = noteDropTo(e), k = noteDrag;
  noteDrag = null;
  noteDropMark(null);
  if (to == null) return;
  e.preventDefault();
  act(async () => {
    noteSync();
    const rel = await api.moveNote(k.slice(2), to, k[0] === 'd');
    noteRekey(k.slice(2), rel, k[0] === 'd');
    if (to) notePad.expanded.add(to);
    notePad.sel = k.slice(0, 2) + rel;
    noteSaveList();
    noteBackup();
    await refreshNotes();
  });
});
/* 找記事（D117）：清單上面那格，打字就篩（noteListRender）；Enter 開第一份（留著、游標進文字框），
   Esc 有字先清掉、沒字回文字框。記事本開著時 Ctrl+P 跳進來（在下面「快捷鍵」那段） */
$('nlQ').addEventListener('input', noteListRender);
$('nlQ').addEventListener('keydown', e => {
  if (isEnter(e)) {
    e.preventDefault();
    const k = $('noteTree').querySelector('.nlRow[data-key^="f:"]')?.dataset.key;
    if (k) { notePad.sel = k; openNote(noteOf(k), 'pin'); }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if ($('nlQ').value) { $('nlQ').value = ''; noteListRender(); } else if (noteCur) $('noteText').focus();
  }
});
/* F2 改名、Delete 刪除（D117）：游標在清單上（點過清單上那一行）時，對選到的那行；那行看不到（收在資料夾裡、被篩掉）就不動 */
$('noteTree').addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.shiftKey || e.target.closest('.note-rename') || !['F2', 'Delete'].includes(e.key)) return;
  const row = noteRowOf(notePad.sel);
  if (!row) return;
  e.preventDefault();
  if (e.key === 'F2') noteListRename(row, notePad.sel); else noteRemove(notePad.sel, true);
});
/* 右鍵選單（D117）：在記事、資料夾上按右鍵先選到它（新增就加在它的資料夾裡，照 VS Code）；空白的地方不選、只有新增（最上層）。
   點一個做完就收起來；Esc、點外面也收起來 */
let noteMenuKey = null;
function noteMenu(open, x, y) {
  const m = $('noteMenu');
  m.hidden = !open;
  if (!open) return;
  for (const g of m.querySelectorAll('.nmItem')) g.hidden = !noteMenuKey;
  placeMenu(m, x, y);
}
/* 右鍵選單擺在按的地方，超出視窗就往左、往上；游標放在看得到的第一項（記事清單、頁籤、MD 檢視清單的右鍵選單共用，D117、D120、D121） */
function placeMenu(m, x, y) {
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(0, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(0, Math.min(y, innerHeight - r.height - 4)) + 'px';
  [...m.querySelectorAll('button')].find(b => b.offsetParent)?.focus();
}
$('noteTree').addEventListener('contextmenu', e => {
  e.preventDefault();
  if (noteBusy()) return;
  noteMenuKey = e.target.closest('.nlRow')?.dataset.key || null;
  notePad.sel = noteMenuKey;
  noteListRender();
  let { clientX: x, clientY: y } = e;
  if (!x && !y && noteMenuKey) { const r = noteRowOf(noteMenuKey).getBoundingClientRect(); x = r.left + 16; y = r.bottom; }   // 鍵盤（選單鍵、Shift+F10）叫出來的：放在那行底下
  noteMenu(true, x, y);
});
$('noteMenu').addEventListener('click', e => {
  const what = e.target.closest('button')?.dataset.act, k = noteMenuKey;
  if (!what) return;
  noteMenu(false);
  if (what === 'note') noteNew();
  else if (what === 'dir') noteAddDir();
  else if (what === 'rename') noteListRename(noteRowOf(k), k);
  else if (what === 'delete') noteRemove(k);
  else if (what === 'reveal') act(() => api.revealNote(k.slice(2), k[0] === 'd'));
  else if (what === 'copy') act(async () => { await api.copyText(await api.notePath(k.slice(2), k[0] === 'd')); toast(L('已複製路徑')); });
});
document.addEventListener('mousedown', e => { if (!$('noteMenu').hidden && !e.target.closest('#noteMenu')) noteMenu(false); });

/* ---------- 文件檢視（見 開發筆記 D118，原本叫 MD 檢視；也看 .html，D122）：唯讀看釘住的資料夾裡的 .md、.html（AI 產出的報告、筆記、規格） ----------
   程式裡的名稱照舊用 md（mdPad、mdMode、#mdPane…），畫面上的字是「文件檢視」。
   左欄是清單：最上面一層是釘住的資料夾（照釘的順序），底下只列有 .md、.html 的資料夾和那些檔，照名稱排、資料夾在前面（同記事清單，D116；檔案可以換成修改時間、建立日期，D132）。
   上面一排頁籤只放開著的：清單上點一下開成預覽、點兩下留著，× 關掉（同記事本）。一份用完整路徑認。
   .md 由主程序轉成 HTML；檔案在外面改了就重讀，內容變了才重畫（捲到哪留著）。.html 放進沙盒的 iframe（mdFrame），改了就重新載入（回到最上面）。
   開著哪些、預覽、正在看的、展開的資料夾記在這台電腦 */
const mdPad = {
  loaded: false,      // 讀回上次記的了沒：還沒讀就不寫，免得蓋掉
  roots: [],          // 釘住的資料夾 [{ dir, files（相對路徑）, times（每份的修改、建立時間，D132）, missing }]
  files: new Set(),   // 清單上全部的 .md（完整路徑）
  open: [],           // 開著的頁籤（完整路徑），照開的順序
  preview: null,      // 預覽的那個頁籤
  cur: null,          // 正在看的
  expanded: new Set(), // 展開的資料夾（完整路徑；釘住的資料夾本身也算）
  scroll: new Map(),  // 每一份捲到哪（換頁籤、離開再回來照舊）
  shown: null,        // 畫面上放的是哪一份
  html: null,         // 畫面上放的 HTML（內容沒變就不重畫）
};
const mdJoin = (dir, rel) => mdTrim(dir) + '\\' + rel.split('/').join('\\');
const mdBase = p => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
const mdParent = p => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const mdName = p => mdBase(p).replace(/\.md$/i, '');
const mdTrim = dir => dir.replace(/[\\/]+$/, '');   // 釘的是磁碟機（C:\）時拿掉最後的 \，接路徑才不會多一個
const mdUnder = (p, dir) => p.toLowerCase().startsWith(mdTrim(dir).toLowerCase() + '\\');
function mdSave() {
  if (!mdPad.loaded) return;
  try {
    localStorage.setItem('daybook.mdTabs', JSON.stringify({ open: mdPad.open, preview: mdPad.preview, cur: mdPad.cur }));
    localStorage.setItem('daybook.mdDirs', JSON.stringify([...mdPad.expanded]));
  } catch { /* 記不住就算了 */ }
}
async function refreshMd() {
  if (!mdPad.loaded) {
    try {
      const s = JSON.parse(localStorage.getItem('daybook.mdTabs')) || {};
      if (Array.isArray(s.open)) mdPad.open = s.open.filter(k => typeof k === 'string');
      if (typeof s.preview === 'string') mdPad.preview = s.preview;
      if (typeof s.cur === 'string') mdPad.cur = s.cur;
      mdPad.expanded = new Set(JSON.parse(localStorage.getItem('daybook.mdDirs')) || []);
    } catch { /* 讀不到就當沒記過 */ }
    mdPad.loaded = true;
  }
  mdPad.roots = await api.mdList();
  mdPad.files = new Set(mdPad.roots.flatMap(r => r.files.map(f => mdJoin(r.dir, f))));
  // 檔案不見了（外面刪掉、改名，或不釘那個資料夾了）：頁籤拿掉
  mdPad.open = mdPad.open.filter((k, i, a) => mdPad.files.has(k) && a.indexOf(k) === i);
  if (!mdPad.open.includes(mdPad.preview)) mdPad.preview = null;
  if (!mdPad.open.includes(mdPad.cur)) mdPad.cur = mdPad.open[0] || null;
  await mdRender();
}
/* 照 mdPad 畫頁籤、清單、內容（不重讀清單） */
async function mdRender() {
  mdSave();
  tabTouch('md', mdPad.cur);   // Ctrl+Tab 照最近看過的（D160）
  $('mdTabs').replaceChildren(...mdPad.open.map(mdTab));
  mdListRender();
  const cur = mdPad.cur, v = $('mdView');
  if (!cur) v.hidden = true;   // 有的話讀完才換（.md 下面打開、.html 看要不要蓋著）：讀的這一下原本的畫面照留（D155）
  $('mdEmpty').hidden = !!cur;
  $('mdEmpty').textContent = mdPad.roots.length ? L('沒有開著的文件。從左邊的清單點一份來看。') : L('還沒有釘資料夾。在左邊清單上面按「＋」，選一個放 .md、.html 的資料夾（例如 AI 寫報告的地方）。');
  if (!cur) { mdPad.shown = mdPad.html = null; v.replaceChildren(); mdFrame(null, null); mdFindRefresh(); mdOutlineRender(); return; }
  const doc = await api.mdRead(cur);   // .md：{ html }；.html：{ url }
  if (cur !== mdPad.cur) return;   // 讀的時候換了一份：那邊會再畫
  mdFrame(cur, doc.url || null);
  if (doc.url) {
    // 新建的 iframe 還沒畫好（D154）：原本看得到的先蓋著——原本是 .html 的話是那份 iframe（還沒藏），不然是 .md 那塊（補底色，有字的話字也留著）；
    // 畫好了 mdFrameShow 再收。不用等的（留著的、同一份重新載入）.md 那塊馬上收
    const f = $('docFrame'), cover = f.classList.contains('wait') && ![...mdFrames.values()].some(x => x !== f && x.classList.contains('on'));
    v.hidden = !cover;
    if (!cover) v.replaceChildren();
    mdPad.shown = cur;
    mdPad.html = null;
  } else {
    v.hidden = false;
    if (mdPad.shown !== cur || doc.html !== mdPad.html) {   // 同一份、內容沒變就不重畫：選著的字、捲到哪都留著
      v.innerHTML = doc.html;
      for (const a of v.querySelectorAll('a[href]')) a.title = a.getAttribute('href');
      mdPad.shown = cur;
      mdPad.html = doc.html;
    }
    v.scrollTop = mdPad.scroll.get(cur) || 0;
  }
  mdFindRefresh();
  mdOutlineRender();
  $('mdTabs').querySelector('.noteTab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
/* 大綱（D159）：左欄清單底下，正在看的 .md 的標題（#mdView 裡的 h1～h6），照層級縮排（最大的那層不縮）；點一下捲到那段（同 #段落 的連結，mdScrollTo）。
   捲的時候標出現在看到哪一段（mdOutlineMark）。.html、沒開著的、沒有標題的寫一行說明（照 VS Code 大綱的空的時候）。
   收起來、打開記在這台電腦（daybook.mdOutline） */
let mdHeads = [];   // 大綱上那幾個標題（#mdView 裡的元素），跟 #mdOutlineList 的一行一行同順序
function mdOutlineRender() {
  const cur = mdPad.cur, list = $('mdOutlineList');
  mdHeads = cur && !mdIsHtml(cur) && mdPad.shown === cur ? [...$('mdView').querySelectorAll('h1, h2, h3, h4, h5, h6')] : [];
  const none = !cur ? L('沒有開著的文件') : mdIsHtml(cur) ? L('.html 沒有大綱') : !mdHeads.length ? L('這份沒有標題') : null;
  if (none) { list.replaceChildren(el('div', 'nlNone', none)); return; }
  const top = Math.min(...mdHeads.map(h => Number(h.tagName[1])));
  list.replaceChildren(...mdHeads.map(h => {
    const row = el('div', 'nlRow');
    row.style.paddingLeft = 12 + (Number(h.tagName[1]) - top) * 12 + 'px';
    const b = button('nlName', h.textContent, () => mdScrollTo(h));
    b.title = h.textContent;
    b.setAttribute('role', 'treeitem');
    row.append(b);
    return row;
  }));
  mdOutlineMark();
}
/* 現在看到哪一段：頂端已經到內容最上面（差 2px 內，點大綱、#段落就是捲到這裡）的最後一個標題；
   還沒捲（最上面）是第一個；捲到底（捲得動的時候）是最後一個——最後幾段太短，捲不到最上面 */
function mdOutlineMark() {
  if (!mdHeads.length) return;
  const v = $('mdView'), y = v.getBoundingClientRect().top + 2;
  let at = v.scrollTop < 1 ? 0 : -1;
  if (v.scrollHeight > v.clientHeight + 2 && v.scrollTop + v.clientHeight >= v.scrollHeight - 2) at = mdHeads.length - 1;
  else for (let i = 0; i < mdHeads.length && mdHeads[i].getBoundingClientRect().top <= y; i++) at = i;
  const rows = [...$('mdOutlineList').children];
  rows.forEach((r, i) => r.classList.toggle('on', i === at));
  rows[at]?.scrollIntoView({ block: 'nearest' });
}
let mdOutlineFrame = 0;
$('mdView').addEventListener('scroll', () => { if (!mdOutlineFrame) mdOutlineFrame = requestAnimationFrame(() => { mdOutlineFrame = 0; mdOutlineMark(); }); });
/* 捲到這個標題：放在內容最上面（照 VS Code 的 Markdown 預覽）。捲到哪當下就記：scroll 事件晚一格才來，
   這中間外面改了檔的重畫（mdRender 照記的捲回去）會把它蓋回原本的地方（e2e 碰過一次，D159） */
const mdScrollTo = h => {
  const v = $('mdView');
  v.scrollTop += h.getBoundingClientRect().top - v.getBoundingClientRect().top;
  if (mdPad.shown) mdPad.scroll.set(mdPad.shown, v.scrollTop);
};
const unhash = s => { try { return decodeURIComponent(s); } catch { return s; } };   // 連結 # 後面的：marked 會把中文編碼成 %xx；編碼壞掉的照原字
/* #段落（D159）：hash 是 # 後面的，對標題的 data-anchor（md-view.js 照 GitHub 算的）；一樣的沒有就不分大小寫再找一次。找到捲過去、回 true */
function mdAnchor(hash) {
  const id = unhash(hash);
  const find = s => (s ? $('mdView').querySelector(`[data-anchor="${CSS.escape(s)}"]`) : null);
  const h = find(id) || find(id.toLowerCase());
  if (h) mdScrollTo(h);
  return !!h;
}
function mdOutlineFold(off) {
  $('mdOutline').classList.toggle('off', off);
  $('mdOutlineHead').setAttribute('aria-expanded', String(!off));   // 箭頭照這個轉（D163）
  applyOutline();
}
/* 大綱的高度（D162）：清單和大綱中間的線（#sashOutline）拉動，照 D074 拉多大就多大；點兩下回到跟著內容走（最多四成）。
   記在 daybook.sizes 的 outline（px），外觀頁「還原預設大小」一起還原（D075）。大綱收起來時線不出現、不套。拉的時候清單最少留 60px、大綱最少 48px（標題列＋一行） */
const OUTLINE_MIN = 48, MDTREE_MIN = 60;
function applyOutline() {
  const o = $('mdOutline'), off = o.classList.contains('off'), set = !off && sizes.outline != null;
  o.style.flex = set ? `0 1 ${sizes.outline}px` : '';
  o.style.maxHeight = set ? 'none' : '';
  $('sashOutline').hidden = off;
}
try { mdOutlineFold(localStorage.getItem('daybook.mdOutline') === 'off'); } catch { /* 讀不到就打開 */ }
sash('sashOutline', 'row', () => {
  const h0 = $('mdOutline').getBoundingClientRect().height, most = h0 + $('mdTree').getBoundingClientRect().height - MDTREE_MIN;
  return d => { sizes.outline = Math.round(Math.max(OUTLINE_MIN, Math.min(most, h0 - d))); applyOutline(); };   // 往下拉大綱變矮
}, () => { sizes.outline = null; applyOutline(); });
$('mdOutlineHead').addEventListener('click', () => {
  const off = !$('mdOutline').classList.contains('off');
  mdOutlineFold(off);
  try { localStorage.setItem('daybook.mdOutline', off ? 'off' : ''); } catch { /* 記不住就算了 */ }
});
/* .html 的 iframe（D122）：開過的每份留一個（D155，原本要用時才建、不用就拿掉）：藏著的用 visibility:hidden，切回來不重新載入，捲到哪、網頁裡的狀態都留著。
   最多留 MD_KEEP 份（最近看過的，使用者定的），超過拿掉最久沒看的；頁籤關掉就拿掉；還沒畫好就換走的不留（留著的都畫好過，切回來馬上看得到）。
   外面改了（網址換了）：看得到的馬上重新載入，藏著的切回來才重新載入。正在看的那個 id 是 docFrame（找字、Esc、F3、painted 都只認它）。
   程式可以跑（D148，原本不跑）：allow-scripts；allow-same-origin 讓程式用得了 localStorage——來源是 docview://local，跟 daybook（file://）不同，
   照樣碰不到 window.daybook（主程序的 CSP 照舊不連網）；allow-popups：target=_blank 的連結才會送到主程序（docNav，使用者點的才開）。
   載好了（重新載入、換一份）找字的框開著就重找（D149）。
   新建的先墊在原本的畫面底下（class wait；放在其他 iframe 前面，一樣 z-index 時就在它們底下），網頁畫好了才換上：不然畫出來之前會先看到 iframe 的白底（D154）。
   「畫好了」由主程序塞進網頁的監聽（DOC_HOOKS）載完、畫完一格後送 painted；load 比畫出來早，照 load 換還會白一格。
   保險：載完 0.5 秒還沒收到（監聽沒放進去）也換上。src 在放進畫面之前給：沒 src 就放進去會先載 about:blank */
const MD_KEEP = 8;
const mdFrames = new Map();   // 路徑 → iframe，照最近看過的排（最前面的最久沒看）
function mdFrame(key, url) {
  const was = $('docFrame'), kept = url ? mdFrames.get(key) : null;
  if (was && was !== kept) {
    was.removeAttribute('id');
    if (was.classList.contains('wait')) mdFrameDrop(was);
  }
  if (!url) for (const x of mdFrames.values()) x.classList.remove('on');   // 換到 .md、沒開著的：都藏起來
  else if (kept) {   // 留著的：馬上換上，其他藏起來；還在等畫好的（同一份又畫一次，例如點兩下）蓋著它的不動
    if (!kept.classList.contains('wait')) for (const x of mdFrames.values()) if (x !== kept) x.classList.remove('on');
    kept.classList.add('on');
    if (kept.getAttribute('src') !== url) kept.src = url;   // 外面改了：切回來才重新載入
  } else {   // 新建的：原本看得到的（別份 iframe 也一樣）等它畫好了才藏（mdFrameShow）
    const f = el('iframe');
    f.className = 'docFrame on wait';
    f.dataset.key = key;
    f.setAttribute('sandbox', 'allow-popups allow-scripts allow-same-origin');
    f.addEventListener('load', () => {
      if (f.classList.contains('wait')) setTimeout(() => mdFrameShow(f), 500);
      if (f.id === 'docFrame' && !$('mdFind').hidden && mdMode()) mdFindHtml('refresh', { q: $('mdFindQ').value, at: mdFind.at });
    });
    f.src = url;
    $('mdWrap').prepend(f);
    mdFrames.set(key, f);
  }
  if (url) {
    const f = mdFrames.get(key);
    f.id = 'docFrame';
    mdFrames.delete(key);   // 排到最後（最近看過的）
    mdFrames.set(key, f);
  }
  // 頁籤關掉的拿掉；超過 MD_KEEP 份拿掉最久沒看的（正在看的不算）
  for (const f of [...mdFrames.values()]) if (!mdPad.open.includes(f.dataset.key)) mdFrameDrop(f);
  for (const f of [...mdFrames.values()]) if (mdFrames.size > MD_KEEP && f.id !== 'docFrame') mdFrameDrop(f);
}
function mdFrameDrop(f) {
  mdFrames.delete(f.dataset.key);
  f.remove();
}
function mdFrameShow(f) {   // 墊在底下的畫好了：換上來，原本蓋著的（別份 iframe、.md 那塊）收掉；不是正在看的（換走就拿掉了）、已經換上的不動
  if (f.id !== 'docFrame' || !f.classList.contains('wait')) return;
  for (const x of mdFrames.values()) if (x !== f) x.classList.remove('on');
  f.classList.remove('wait');
  $('mdView').hidden = true;
  $('mdView').replaceChildren();
}
// 捲到哪隨時記著（離開 MD 檢視時這塊藏起來，捲的位置會歸零，回來再放回去）
$('mdView').addEventListener('scroll', () => { if (mdPad.shown && !$('mdView').hidden && mdMode()) mdPad.scroll.set(mdPad.shown, $('mdView').scrollTop); });

/* 找字（見 開發筆記 D147、D149）：照記事本的（D104）——Ctrl+F 右上角小框，只找正在看的那份；怎麼找、標顏色、捲過去都在 shared/docfind.js（.md、.html 共用）。
   Enter／↓ 下一個、Shift+Enter／↑ 上一個（到底了繞回來）；Esc、× 關掉，選著目前那個。選著一段字（不跨行）按 Ctrl+F 就拿來找、從它開始；
   沒選就從畫面上看得到的第一個開始；打字從目前那個開始。找的字留著，下次打開還在。
   .md 在畫面裡找（mdFinder）；.html 在 iframe 裡（別的來源，畫面碰不到）：請主程序把同一套塞進網頁跑（api.docFind），iframe 載好了（重新載入、換一份）就重找。
   框開著時內容重畫了就重找，目前那個的順序不變（超過就最後一個）；頁籤都關了就收起來 */
const mdFinder = daybookFind.finder($('mdView'), $('mdView'), ['md-find', 'md-find-on']);
const mdFind = { n: 0, at: -1, seq: 0 };   // 框上寫的：共幾個、目前第幾個；seq：.html 要問主程序，打字快時只收最後一次的
const mdHtml = () => !!$('docFrame');   // 開著的是 .html（iframe 只在那時候才有）
function mdFindCount(r) {
  if (r) { mdFind.n = r.n; mdFind.at = r.at; }
  $('mdFindN').textContent = mdFind.n ? `${mdFind.at + 1} / ${mdFind.n}` : $('mdFindQ').value ? L('沒有結果') : '';
}
/* .html：請主程序在 iframe 裡跑（op 見 docfind.js 的 pageOp）；回來時框收了、或之後又叫了一次就不算 */
async function mdFindHtml(op, arg) {
  const seq = ++mdFind.seq;
  const r = await api.docFind(op, arg);
  if (seq !== mdFind.seq || $('mdFind').hidden) return null;
  if (r) mdFindCount(r);
  return r;
}
function mdFindRun() {   // 打字：從目前那個開始找
  if (mdHtml()) mdFindHtml('run', { q: $('mdFindQ').value });
  else mdFindCount(mdFinder.run($('mdFindQ').value, mdFinder.current()));
}
function mdFindStep(d) {
  if (mdHtml()) mdFindHtml('step', { d });
  else mdFindCount(mdFinder.step(d));
}
async function mdFindOpen() {
  if (!mdHtml() && $('mdView').hidden) return;   // 沒有開著的：不理
  if (mdHtml()) {   // 選著的字在 iframe 裡，主程序那邊拿
    $('mdFind').hidden = false;
    $('mdFindQ').focus();
    const r = await mdFindHtml('open', { q: $('mdFindQ').value });
    if (r) { $('mdFindQ').value = r.q; $('mdFindQ').select(); mdFindCount(); }
    return;
  }
  const s = getSelection();
  const r = s.rangeCount && $('mdView').contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;   // 游標一進框就換掉，先抄下來
  const t = r ? s.toString() : '';
  if (t && !t.includes('\n')) $('mdFindQ').value = t;   // 選著一段字就拿來找（跟記事本一樣）
  $('mdFind').hidden = false;
  $('mdFindQ').focus();
  $('mdFindQ').select();
  mdFindCount(mdFinder.run($('mdFindQ').value, r || mdFinder.current()));   // 開著再按：從目前那個開始，不跳走
}
/* F3／Shift+F3（見 開發筆記 D150，照 VS Code）：框開著就下一個／上一個；框關著：叫出框、焦點不動，用上次找的字（沒有才拿選著的字），
   從選著的、點過的地方往後（往前）跳；從沒找過、也沒選字就跟 Ctrl+F 一樣（游標進框讓人打字） */
async function mdFindKey(d) {
  if (!mdHtml() && $('mdView').hidden) return;   // 沒有開著的：不理
  if (!$('mdFind').hidden) { mdFindStep(d); return; }
  if (mdHtml()) {   // 選著的字、從哪裡往後都在 iframe 裡，主程序那邊算
    $('mdFind').hidden = false;
    const r = await mdFindHtml('jump', { q: $('mdFindQ').value, d });
    if (r && r.q) { $('mdFindQ').value = r.q; mdFindCount(); } else if (r) mdFindOpen();
    return;
  }
  const s = getSelection();
  const sel = s.rangeCount && $('mdView').contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
  const t = sel ? s.toString() : '';
  const q = $('mdFindQ').value || (t && !t.includes('\n') ? t : '');
  if (!q) { mdFindOpen(); return; }
  $('mdFindQ').value = q;
  $('mdFind').hidden = false;
  mdFindCount(mdFinder.jump(q, sel, d));
}
/* quiet：頁籤都關了（mdFindRefresh 收的），游標、選取不動 */
function mdFindClose(quiet) {
  if ($('mdFind').hidden) return;
  $('mdFind').hidden = true;
  mdFind.n = 0;
  mdFind.at = -1;
  mdFind.seq++;
  const r = mdFinder.close();   // .md 的顏色拿掉
  if (mdHtml()) { api.docFind('close'); if (!quiet) $('docFrame').focus(); return; }   // .html：網頁裡的顏色拿掉、選著目前那個，游標回網頁
  if (quiet || $('mdView').hidden) return;
  $('mdView').focus();
  if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
}
function mdFindRefresh() {
  if ($('mdFind').hidden || !mdMode()) return;   // 不在文件檢視（藏著量不到看不看得到）：回來時 setMdMode 會再畫一次
  if (!mdPad.cur) { mdFindClose(true); return; }
  if (mdHtml()) {   // .md 的顏色先拿掉。.html：新建的 iframe 載好了才找（mdFrame 的 load）；留著的（D155）換回來不會再載入，馬上找
    mdFinder.close();
    if (!$('docFrame').classList.contains('wait')) mdFindHtml('refresh', { q: $('mdFindQ').value, at: mdFind.at });
    return;
  }
  mdFindCount(mdFinder.refresh($('mdFindQ').value, mdFind.at));
}
$('mdFindQ').addEventListener('input', mdFindRun);
$('mdFindQ').addEventListener('keydown', e => {
  if (isEnter(e)) { e.preventDefault(); mdFindStep(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); mdFindClose(); }
});
$('mdView').addEventListener('keydown', e => { if (e.key === 'Escape' && !$('mdFind').hidden) { e.preventDefault(); mdFindClose(); } });
$('mdFindNext').addEventListener('click', () => mdFindStep(1));
$('mdFindPrev').addEventListener('click', () => mdFindStep(-1));
$('mdFindClose').addEventListener('click', () => mdFindClose());
/* .html 裡按 Ctrl+F、Esc（D149）：焦點在 iframe 裡時畫面收不到按鍵，主程序塞進網頁的監聽用 postMessage 通知（只認現在那個 iframe 送的）。
   painted：網頁畫好了，墊在底下的換上來（D154）；它不是按鍵，不在文件檢視時也照收 */
addEventListener('message', e => {
  const f = $('docFrame');
  if (!f || e.source !== f.contentWindow || !e.data) return;
  if (e.data.daybook === 'painted') requestAnimationFrame(() => requestAnimationFrame(() => mdFrameShow(f)));   // 畫面這邊再等兩格，網頁畫好的才接得上（快取的網頁快到這邊還沒接上，換上還會白一格）
  if (!mdMode()) return;
  if (e.data.daybook === 'down') f.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));   // 網頁裡點了：當作點在 iframe 上，開著的選單照「點外面」收起來（D164）
  if (e.data.daybook === 'find') mdFindOpen();
  if (e.data.daybook === 'esc') mdFindClose();
  if (e.data.daybook === 'f3') mdFindKey(e.data.back ? -1 : 1);   // F3／Shift+F3（D150）：焦點留在網頁裡
  if (e.data.daybook === 'quick') mdQuick();   // Ctrl+P 找文件（D158）
  if (e.data.daybook === 'tabkey') tabKey(String(e.data.key), !!e.data.shift);   // 頁籤的按鍵（D160）
  if (e.data.daybook === 'actkey') actKey(String(e.data.key));   // Ctrl+1～9 換到頁籤列的第幾個（D168）
  if (e.data.daybook === 'ctrlup') tabSwitchEnd(true);   // 網頁裡放開 Ctrl：焦點還沒搬到 Ctrl+Tab 的清單上就放開的那一下（清單沒開著就不做事）
});
/* 頁籤：樣子照記事本的；開著好幾份同名的（例如每個專案都有 README）後面淡淡寫在哪個資料夾。預覽的點兩下留下來 */
function mdTab(p) {
  const tab = el('div', 'noteTab' + (p === mdPad.cur ? ' on' : '') + (p === mdPad.preview ? ' preview' : ''));
  tab.dataset.key = p;
  tab.draggable = true;   // 拖頁籤調順序（D160）
  const nm = button('noteName', mdName(p), () => mdOpen(p));
  if (mdPad.open.some(o => o !== p && mdName(o).toLowerCase() === mdName(p).toLowerCase())) nm.append(el('span', 'noteDirHint', mdBase(mdParent(p)) || mdParent(p)));
  nm.title = p === mdPad.preview ? L('{name}（預覽：清單上點下一份就換掉；點兩下留下來）', { name: p }) : p;
  nm.addEventListener('dblclick', () => mdOpen(p, 'pin'));
  const del = button('noteDel', '×', () => mdClose([p]));
  del.title = L('關掉（檔案不會動）');
  tab.append(nm, del);
  return tab;
}
/* 換一份。from：'list' 清單上點一下，還沒開的開成預覽（有預覽的就換掉它、放在它的位置）；'pin' 點兩下，留下來。沒給是點頁籤 */
const mdOpen = (p, from) => act(async () => {
  if (from && !mdPad.open.includes(p)) {
    const i = from === 'list' ? mdPad.open.indexOf(mdPad.preview) : -1;
    if (i >= 0) mdPad.open[i] = p; else mdPad.open.push(p);
    if (from === 'list') mdPad.preview = p;
  } else if (from === 'pin' && mdPad.preview === p) mdPad.preview = null;
  mdPad.cur = p;
  // 清單上打開它在的資料夾，一路到釘住的那個（連結開的也看得到在哪）
  const root = mdPad.roots.find(r => mdUnder(p, r.dir));
  if (root) {
    for (let d = mdParent(p); d.length > mdTrim(root.dir).length; d = mdParent(d)) mdPad.expanded.add(d);
    mdPad.expanded.add(root.dir);
  }
  await mdRender();
});
/* 關掉這幾個頁籤（×、頁籤右鍵，D120）；關掉的有正在看的那份就換到右邊那份，沒有就左邊那份（同記事本的 noteClose） */
const mdClose = keys => act(async () => {
  tabRemember('md', keys);   // Ctrl+Shift+T 重開（D160）
  const tabs = mdPad.open, i = tabs.indexOf(mdPad.cur);
  if (i >= 0 && keys.includes(tabs[i])) mdPad.cur = [...tabs.slice(i + 1), ...tabs.slice(0, i).reverse()].find(k => !keys.includes(k)) || null;
  mdPad.open = tabs.filter(k => !keys.includes(k));
  if (keys.includes(mdPad.preview)) mdPad.preview = null;
  for (const k of keys) mdPad.scroll.delete(k);
  await mdRender();
});
function mdListRender() {
  const rows = [];
  // 找文件（D158）：比「釘住的資料夾的名稱/相對路徑」（名稱和所在的資料夾，照 VS Code 的 Ctrl+P），不分大小寫、空白隔開的每個詞都要有；
  // 留下符合的檔和它們在的資料夾（都打開，不記成展開），一份都沒有的釘住資料夾不列
  const words = $('mdQ').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let found = 0;
  if (!mdPad.roots.length) rows.push(el('div', 'nlNone', L('還沒有釘資料夾。按上面的「＋」選一個放 .md、.html 的資料夾。')));
  for (const r of mdPad.roots) {
    const top = (mdBase(r.dir) || r.dir).toLowerCase() + '/';
    const files = words.length ? r.files.filter(f => words.every(w => (top + f.toLowerCase()).includes(w))) : r.files;
    if (words.length && !files.length) continue;
    found += files.length;
    const order = fileOrder('md', r.times);   // 檔案照選的排，資料夾照名稱（D132）
    const open = !!words.length || mdPad.expanded.has(r.dir);
    rows.push(mdRow(r.dir, 'root', 0, open, r));
    if (!open) continue;
    if (r.missing || !r.files.length) { rows.push(el('div', 'nlNone', r.missing ? L('找不到這個資料夾（搬走、改名，或隨身碟沒插）') : L('裡面沒有 .md、.html'))); continue; }
    const dirs = new Set();
    for (const f of files) for (let d = noteParent(f); d; d = noteParent(d)) dirs.add(d);
    const walk = (dir, depth) => {
      for (const d of [...dirs].filter(x => noteParent(x) === dir).sort(nameOrder)) {
        const p = mdJoin(r.dir, d), o = !!words.length || mdPad.expanded.has(p);
        rows.push(mdRow(p, 'dir', depth, o, r));
        if (o) walk(d, depth + 1);
      }
      for (const f of files.filter(x => noteParent(x) === dir).sort(order)) rows.push(mdRow(mdJoin(r.dir, f), 'file', depth, false, r));
    };
    walk('', 1);
  }
  if (words.length && !found) rows.push(el('div', 'nlNone', L('沒有符合的文件')));
  $('mdTree').replaceChildren(...rows);
}
/* 找文件（D158）：清單上面那格，打字就篩（mdListRender）；Enter 開第一份（留著、游標進內容），Esc 有字先清掉、沒字回內容（同找記事，D117）。
   文件檢視開著時 Ctrl+P 跳進來（mdQuick；在下面「快捷鍵」那段，游標在 .html 裡按的由網頁裡的監聽通知） */
const mdBack = () => ($('docFrame') || $('mdView')).focus();   // 游標回內容：.html 是正在看的那個 iframe
function mdQuick() {
  if (sideOff() || sideView() !== 'journal') showSide('journal');   // 清單收著、放剪貼簿時先打開清單
  $('mdQ').focus();
  $('mdQ').select();
}
$('mdQ').addEventListener('input', mdListRender);
$('mdQ').addEventListener('keydown', e => {
  if (isEnter(e)) {
    e.preventDefault();
    const p = $('mdTree').querySelector('.nlRow[data-kind="file"]')?.dataset.key;
    if (p) mdOpen(p, 'pin').then(mdBack);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if ($('mdQ').value) { $('mdQ').value = ''; mdListRender(); } else if (mdPad.cur) mdBack();
  }
});
// kind：'root' 釘住的資料夾、'dir' 底下的資料夾、'file' 一份 .md；r 是它在哪個釘住的資料夾（右鍵的複製相對路徑從這裡算，D121）
function mdRow(p, kind, depth, open, r) {
  const row = el('div', 'nlRow' + (kind === 'root' ? ' mdRoot' : '') + (kind === 'file' && p === mdPad.cur ? ' on' : ''));
  row.dataset.key = p;
  row.dataset.kind = kind;
  row.dataset.root = r.dir;
  row.style.paddingLeft = 4 + depth * 12 + (kind === 'file' ? 16 : 0) + 'px';   // .md 空出箭頭的位置，名稱跟同一層的資料夾對齊
  const name = button('nlName', kind === 'file' ? mdName(p) : null, () => (kind === 'file' ? mdOpen(p, 'list') : mdToggle(p)));
  name.setAttribute('role', 'treeitem');
  name.title = p;
  if (kind === 'file') name.addEventListener('dblclick', () => mdOpen(p, 'pin'));
  else {
    name.append(arrowEl(), mdBase(p) || p);   // 釘的是磁碟機（C:\）就寫整個路徑
    if (r.missing) name.append(el('span', 'noteDirHint', L('找不到')));
    name.setAttribute('aria-expanded', String(open));
  }
  row.append(name);
  if (kind === 'root') {
    const tools = el('span', 'nlTools');
    const del = button(null, '×', () => mdUnpin(p));
    del.title = L('不釘這個資料夾（檔案不會動）');
    tools.append(del);
    row.append(tools);
  }
  return row;
}
function mdToggle(p) {
  if (mdPad.expanded.has(p)) mdPad.expanded.delete(p); else mdPad.expanded.add(p);
  mdSave();
  mdListRender();
}
// 不釘：檔案不動，那個資料夾裡開著的頁籤關掉（refreshMd 照清單拿掉）
const mdUnpin = dir => act(async () => {
  await api.mdRemove(dir);
  for (const d of [...mdPad.expanded]) if (d === dir || mdUnder(d, dir)) mdPad.expanded.delete(d);
  await refreshMd();
});
// 釘資料夾：清單上面的「＋」、清單右鍵的「釘資料夾…」（D121）
const mdPin = () => act(async () => {
  const r = await api.mdAdd();
  if (!r) return;
  if (r.dup) { toast(L('「{dir}」已經釘了', { dir: r.dir })); return; }
  mdPad.expanded.add(r.dir);
  await refreshMd();
});
$('mdAddRoot').addEventListener('click', mdPin);
$('mdCollapse').addEventListener('click', () => {
  mdPad.expanded.clear();
  mdSave();
  mdListRender();
});
/* 清單的右鍵選單（D121，唯讀，不放改名、刪除）：按右鍵的那行框起來（選單收起來就拿掉，MD 檢視沒有「選到的那行」）。
   .md、資料夾：在檔案總管中顯示、複製路徑、複製相對路徑（從它在的那個釘住的資料夾算起、/ 隔開）；
   釘住的資料夾：在檔案總管中顯示（找不到的不放）、複製路徑、不釘這個資料夾；空白的地方：只有釘資料夾… */
let mdMenuAt = null;   // { p, kind, root }：按右鍵的那行（完整路徑、種類、它在的釘住的資料夾）；空白的地方是 null
function mdMenu(open, x, y) {
  const m = $('mdMenu');
  m.hidden = !open;
  for (const r of $('mdTree').querySelectorAll('.nlRow.sel')) r.classList.remove('sel');
  if (!open) return;
  const at = mdMenuAt, root = at?.kind === 'root';
  mdRowOf(at?.p)?.classList.add('sel');
  m.querySelector('.mmPath').hidden = !at;
  m.querySelector('[data-act="browser"]').hidden = !(at?.kind === 'file' && mdIsHtml(at.p));   // 用瀏覽器開：只有 .html（D122）
  m.querySelector('[data-act="reveal"]').hidden = root && !!mdPad.roots.find(r => r.dir === at.p)?.missing;
  m.querySelector('[data-act="rel"]').hidden = root;
  m.querySelector('.mmPin').hidden = !!at && !root;
  m.querySelector('[data-act="pin"]').hidden = !!at;
  m.querySelector('[data-act="unpin"]').hidden = !root;
  placeMenu(m, x, y);
}
const mdRowOf = p => [...$('mdTree').querySelectorAll('.nlRow')].find(r => r.dataset.key === p);
const mdMenuBack = () => mdRowOf(mdMenuAt?.p)?.querySelector('.nlName')?.focus();   // Esc、複製、在檔案總管中顯示之後游標回那一行
$('mdTree').addEventListener('contextmenu', e => {
  e.preventDefault();
  const row = e.target.closest('.nlRow');
  mdMenuAt = row ? { p: row.dataset.key, kind: row.dataset.kind, root: row.dataset.root } : null;
  let { clientX: x, clientY: y } = e;
  if (!x && !y && row) { const r = row.getBoundingClientRect(); x = r.left + 16; y = r.bottom; }   // 鍵盤（選單鍵、Shift+F10）叫出來的：放在那行底下
  mdMenu(true, x, y);
});
$('mdMenu').addEventListener('click', e => {
  const what = e.target.closest('button')?.dataset.act, at = mdMenuAt;
  if (!what) return;
  mdMenu(false);
  if (what === 'pin') { mdPin(); return; }
  if (what === 'unpin') { mdUnpin(at.p); return; }
  act(async () => {
    if (what === 'browser') await api.mdBrowser(at.p);
    else if (what === 'reveal') await api.mdReveal(at.p);
    else if (what === 'copy') { await api.copyText(at.p); toast(L('已複製路徑')); }
    else { await api.copyText(at.p.slice(mdTrim(at.root).length + 1).split('\\').join('/')); toast(L('已複製相對路徑')); }
    mdMenuBack();
  });
});
document.addEventListener('mousedown', e => { if (!$('mdMenu').hidden && !e.target.closest('#mdMenu')) mdMenu(false); });
/* 連結：網址（http、https、mailto）用瀏覽器開；相對路徑連到釘住的資料夾裡的 .md、.html 就在這裡開（留著）；其他的不開。
   Ctrl／Shift／中鍵點也走這裡（不然會開出新視窗，主程序也擋了，D118）。.html 裡的連結由主程序攔（docNav），連到文件的送 md:open 過來（D122） */
const MD_NOLINK = L('這個連結開不了：只開網址、釘住的資料夾裡的 .md、.html');
function mdLinkClick(e) {
  const a = e.target.closest('a[href]');
  if (!a || (e.type === 'auxclick' && e.button !== 1)) return;
  e.preventDefault();
  const href = a.getAttribute('href'), cur = mdPad.cur;
  if (/^(https?|mailto):/i.test(href)) { act(() => api.mdLink(href)); return; }
  if (href.startsWith('#')) { if (!mdAnchor(href.slice(1))) toast(L('這份裡沒有「{id}」這一段', { id: unhash(href) })); return; }   // 這份裡的段落（D159）
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) { toast(MD_NOLINK); return; }
  const i = href.indexOf('#');
  act(async () => mdGoto(await api.mdResolve(cur, href), i < 0 ? '' : href.slice(i + 1)));
}
// 開連到的那一份（留著）；清單上沒有的提示。hash：別份.md#段落（D159），開好了捲到那段，那份沒有那段就照原本捲到的地方
function mdGoto(p, hash) {
  const hit = p && [...mdPad.files].find(f => f.toLowerCase() === p.toLowerCase());   // 連結的大小寫可能跟檔名不一樣（Windows 不分）
  if (hit) mdOpen(hit, 'pin').then(() => { if (hash && mdPad.cur === hit && !mdIsHtml(hit)) mdAnchor(hash); });
  else toast(p ? L('這份不在清單上（node_modules、.git 裡的不列）') : MD_NOLINK);
}
const mdIsHtml = p => /\.html?$/i.test(p);
$('mdView').addEventListener('click', mdLinkClick);
$('mdView').addEventListener('auxclick', mdLinkClick);
api.onMdChanged(() => { if (mdMode()) act(refreshMd); });
api.onMdOpen((p, hash) => { if (mdMode()) mdGoto(p, hash); });

/* ---------- 截圖（見 開發筆記 D129）：中間換成截圖頁；「＋ 截圖」由主程序蓋一層框選（renderer/capture.html），存成下一號、複製 ----------
   縮圖用 shot:// 網址（主程序只給截圖資料夾裡的截圖），網址帶修改時間，換了圖才重抓。
   保留的在最上面（照名稱），編號的照日期分段、新的在前（號碼大的在前）。正在取名（留下來）時外面改了先不重畫 */
function setShotMode(on) {
  if (on && noteMode()) noteBackup();   // 從記事本換過來：打到一半的先暫存（同 MD 檢視）
  if (on) document.documentElement.dataset.view = 'shot';
  else delete document.documentElement.dataset.view;
  try { localStorage.setItem('daybook.view', on ? 'shot' : ''); } catch { /* 記不住就算了 */ }
  actState();
  statusHints();
  if (on) return act(async () => { await refreshShots(); $('shotView').focus(); });
}
const shotPad = { list: null };
const shotUrl = s => `shot://local/${encodeURIComponent(s.rel)}?v=${s.mtimeMs}`;
const shotKeeping = () => !!document.querySelector('.shot-name-in');
const shotPick = new Set();   // 拖框選到的（rel，D143）：重畫時照這個框回去，清單上沒了的拿掉
async function refreshShots() {
  const r = await api.shotList();   // 先讀好再換，畫面不閃（D045）
  shotPad.list = r;
  const have = new Set([...r.items, ...r.kept].map(s => s.rel));
  for (const rel of shotPick) if (!have.has(rel)) shotPick.delete(rel);
  $('shotDir').textContent = r.dir;
  $('shotDir').title = L('截圖存在這裡：{dir}', { dir: r.dir });
  const out = [];
  if (r.kept.length) out.push(shotSection(L('保留'), r.kept.slice().sort((a, b) => noteColl.compare(a.name, b.name)), true));
  const days = new Map();
  for (const s of r.items.slice().sort((a, b) => Number(b.name) - Number(a.name))) {
    if (!days.has(s.day)) days.set(s.day, []);
    days.get(s.day).push(s);
  }
  for (const d of [...days.keys()].sort().reverse()) out.push(shotSection(L('{date}（{w}）', { date: d, w: weekday(d) }), days.get(d)));
  if (!out.length) out.push(el('div', 'empty', L('還沒有截圖。按上面的「＋ 截圖」框選畫面的一塊，可以畫框、箭頭；完成就存成下一號，也複製到剪貼簿。')));
  $('shotView').replaceChildren(...out);
  shotCleanAsk(false);
}
/* fold：保留那段（D142）——可以收起來，預設收起來（保留的多了不把新截的擠到下面）；開著還是收著記在這台電腦，重畫照舊 */
function shotSection(title, list, fold) {
  const sec = el(fold ? 'details' : 'section');
  const h = el('h3', null, title);
  h.append(el('span', 'shot-count', ' · ' + L('{n} 張', { n: list.length })));
  const grid = el('div', 'shot-grid');
  grid.append(...list.map(shotCard));
  if (!fold) { sec.append(h, grid); return sec; }
  const sum = el('summary');
  sum.append(h);
  sec.append(sum, grid);
  try { sec.open = localStorage.getItem('daybook.shotKeptOpen') === '1'; } catch { /* 讀不到就收著 */ }
  sec.addEventListener('toggle', () => {
    try { localStorage.setItem('daybook.shotKeptOpen', sec.open ? '1' : ''); } catch { /* 記不住就算了 */ }
    if (sec.open) return;
    const inside = new Set([...sec.querySelectorAll('.shot')].map(c => c.dataset.rel));   // 收起來：裡面選到的取消選取，「複製 N 張」不算看不到的（D143〈後續〉）
    if ([...shotPick].some(rel => inside.has(rel))) shotPickSet([...shotPick].filter(rel => !inside.has(rel)));
  });
  return sec;
}
function shotCard(s) {
  const kept = s.rel.includes('/');
  const box = el('div', 'shot');
  box.dataset.rel = s.rel;
  if (shotPick.has(s.rel)) box.classList.add('picked');
  const img = el('img');
  Object.assign(img, { src: shotUrl(s), alt: s.name, loading: 'lazy', decoding: 'async', draggable: false });
  const open = button('shot-open', null, () => shotBig(s));
  open.title = L('點一下放大看');
  open.append(img);
  const t = new Date(s.mtimeMs);
  const foot = el('div', 'shot-foot');
  foot.append(el('span', 'shot-name', s.name),
    el('span', 'shot-time', kept ? s.day : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`));
  const tools = el('div', 'actions shot-tools');
  tools.append(button('shot-copy', L('複製'), () => act(async () => { await api.shotCopy(s.rel); toast(L('已複製 {name}', { name: s.name })); })));
  if (!kept) tools.append(button('shot-keep', L('留下來'), () => shotKeepForm(box, s)));   // 單張不刪，要刪靠「清掉 N 天前的」（D142）
  box.append(open, foot, tools);
  box.addEventListener('contextmenu', e => {   // 右鍵選單（見下面 shotMenu）；正在取名的不出
    if (e.target.closest('.shot-name-in')) return;
    e.preventDefault();
    let { clientX: cx, clientY: cy } = e;
    if (!cx && !cy) { const r = box.getBoundingClientRect(); cx = r.left + 16; cy = r.bottom; }   // 鍵盤（選單鍵、Shift+F10）叫出來的：放在那張底下
    // 在框選到的上面按（選了好幾張）：對選到的那幾張；在別張上面按：取消選取，只對這一張（照檔案總管，D143）
    const many = shotPick.has(s.rel) && shotPick.size > 1;
    if (!shotPick.has(s.rel)) shotPickSet([]);
    shotMenuAt = { rels: many ? shotPicked() : [s.rel] };
    shotMenu(true, cx, cy);
  });
  return box;
}
/* 留下來：名稱那格換成輸入框，Enter 取名搬進 保留\、Esc 取消；名稱不行（同名、不能用的字）提示、框留著 */
function shotKeepForm(box, s) {
  const input = el('input', 'shot-name-in');
  Object.assign(input, { placeholder: L('取個名字，Enter 留下來'), spellcheck: false, title: L('搬進 保留\\，檔名就是這個名字') });
  box.querySelector('.shot-foot').replaceChildren(input);
  input.addEventListener('keydown', async e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); act(refreshShots); return; }
    if (!isEnter(e)) return;
    e.preventDefault();
    try {
      const rel = await api.shotKeep(s.rel, input.value);
      toast(L('留下來了：{file}', { file: rel.replace('/', '\\') }));
      await refreshShots();
    } catch (err) { toast(errMsg(err), true); input.focus(); }
  });
  input.focus();
}
function shotBig(s) {
  $('shotBigImg').src = shotUrl(s);
  $('shotBigName').textContent = s.name;
  $('shotBig').dataset.rel = s.rel;   // 右鍵選單印哪一張（D142）
  $('shotBig').hidden = false;
}
const closeShotBig = () => { $('shotBig').hidden = true; };
$('shotBig').addEventListener('click', closeShotBig);
$('shotBig').addEventListener('contextmenu', e => {
  e.preventDefault();
  shotMenuAt = { rels: [$('shotBig').dataset.rel], big: true };
  shotMenu(true, e.clientX, e.clientY);
});
/* 右鍵選單（D142）：縮圖、放大看按右鍵：複製（一張是圖＋檔案，同滑過的複製）、列印…（跳系統的列印對話框）。
   框選了好幾張、在選到的上面按：「複製 N 張」（只放檔案），列印藏起來（D143）。按右鍵的那張縮圖框起來，選單收起來就拿掉 */
let shotMenuAt = null;   // { rels, big }：對哪幾張（畫面上的順序）、是不是從放大看叫出來的
const shotCardOf = rel => [...$('shotView').querySelectorAll('.shot')].find(c => c.dataset.rel === rel);
const shotNameOf = rel => rel.split('/').pop().replace(/\.png$/i, '');
const shotMenuBack = () => { if (shotMenuAt && !shotMenuAt.big) shotCardOf(shotMenuAt.rels[0])?.querySelector('.shot-open')?.focus(); };   // Esc 之後游標回那一張
function shotMenu(open, x, y) {
  const m = $('shotMenu');
  m.hidden = !open;
  for (const c of $('shotView').querySelectorAll('.shot.sel')) c.classList.remove('sel');
  if (!open) return;
  const n = shotMenuAt.rels.length;
  m.querySelector('[data-act="copy"]').textContent = n > 1 ? L('複製 {n} 張', { n }) : L('複製');
  m.querySelector('[data-act="print"]').hidden = n > 1;
  if (!shotMenuAt.big && n === 1) shotCardOf(shotMenuAt.rels[0])?.classList.add('sel');
  placeMenu(m, x, y);
}
$('shotMenu').addEventListener('click', e => {
  const what = e.target.closest('button')?.dataset.act, at = shotMenuAt;
  if (!what) return;
  shotMenu(false);
  if (what === 'print') act(() => api.shotPrint(at.rels[0]));
  if (what === 'copy') act(async () => {
    if (at.rels.length > 1) { await api.shotCopy(at.rels); toast(L('已複製 {n} 張（放的是檔案，跟檔案總管複製一樣）', { n: at.rels.length })); }
    else { await api.shotCopy(at.rels[0]); toast(L('已複製 {name}', { name: shotNameOf(at.rels[0]) })); }
  });
});
document.addEventListener('mousedown', e => { if (!$('shotMenu').hidden && !e.target.closest('#shotMenu')) shotMenu(false); });
/* 拖一個框選好幾張（D143）：截圖頁上按住拖，框到的縮圖都選起來（.picked），在選到的上面按右鍵「複製 N 張」。
   拖超過 4px 才算框，只點一下照舊（點縮圖放大看）；從滑過的鈕、取名的框、「保留」小標開始拖不算；收起來的保留那段框不到、收起來時裡面選到的取消選取。
   拖完放開那一下 click 不算（不然在同一張縮圖上放開會打開放大看）；點空白處、Esc 取消選取。框的位置用內容裡的座標，拖的時候捲動也對得上 */
let shotDrag = null, shotDragged = false;   // shotDrag：{ x, y（起點，內容座標）, sx, sy（起點，畫面座標）, cx, cy（現在）, on（拖超過 4px 了） }
function shotPickSet(rels) {
  shotPick.clear();
  for (const rel of rels) shotPick.add(rel);
  for (const c of $('shotView').querySelectorAll('.shot')) c.classList.toggle('picked', shotPick.has(c.dataset.rel));
}
const shotPicked = () => [...$('shotView').querySelectorAll('.shot.picked')].map(c => c.dataset.rel);   // 照畫面上的順序
function shotDragTo() {
  const v = $('shotView'), vr = v.getBoundingClientRect(), d = shotDrag;
  const at = (x, y) => [x - vr.left + v.scrollLeft, y - vr.top + v.scrollTop];
  const [x1, y1] = at(d.cx, d.cy);
  const l = Math.min(d.x, x1), t = Math.min(d.y, y1), r = Math.max(d.x, x1), b = Math.max(d.y, y1);
  let band = $('shotBand');
  if (!band) { band = el('div'); band.id = 'shotBand'; v.append(band); }   // 清單重畫會把它清掉，再放一個
  Object.assign(band.style, { left: l + 'px', top: t + 'px', width: r - l + 'px', height: b - t + 'px' });
  const hit = [];
  for (const c of v.querySelectorAll('.shot')) {
    if (c.closest('details:not([open])')) continue;   // 收起來的保留那段：看不到，但量得到寬高、位置疊在底下的縮圖那裡（不能用寬度是 0 判斷，D143〈後續〉）
    const cr = c.getBoundingClientRect();
    const [cl, ct] = at(cr.left, cr.top);
    if (cl < r && cl + cr.width > l && ct < b && ct + cr.height > t) hit.push(c.dataset.rel);
  }
  shotPickSet(hit);
}
$('shotView').addEventListener('mousedown', e => {
  if (e.button !== 0 || e.target.closest('.shot-tools, .shot-name-in, summary')) return;
  const v = $('shotView'), vr = v.getBoundingClientRect();
  if (e.clientX >= vr.left + v.clientWidth) return;   // 按在捲軸上
  shotDrag = { x: e.clientX - vr.left + v.scrollLeft, y: e.clientY - vr.top + v.scrollTop, sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, on: false };
});
document.addEventListener('mousemove', e => {
  const d = shotDrag;
  if (!d || (!d.on && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4)) return;
  Object.assign(d, { on: true, cx: e.clientX, cy: e.clientY });
  shotDragTo();
});
document.addEventListener('mouseup', () => {
  if (!shotDrag) return;
  if (shotDrag.on) { shotDragged = true; setTimeout(() => { shotDragged = false; }); }   // 接著來的那一下 click 不算
  shotDrag = null;
  $('shotBand')?.remove();
});
$('shotView').addEventListener('scroll', () => { if (shotDrag?.on) shotDragTo(); });
$('shotView').addEventListener('click', e => {
  if (shotDragged) { e.stopPropagation(); e.preventDefault(); return; }
  if (!e.target.closest('.shot, summary')) shotPickSet([]);   // 點空白處：取消選取
}, true);
$('shotView').addEventListener('keydown', e => { if (e.key === 'Escape' && shotPick.size) { e.preventDefault(); shotPickSet([]); } });
$('shotNew').addEventListener('click', () => act(async () => {
  const r = await api.shotCapture();
  if (!r) return;
  toast(L('存成 {file}，也複製到剪貼簿了', { file: r.rel }));
  if (shotMode()) await refreshShots();
}));
/* 清掉 N 天前的：先問一次（幾月幾日以前、幾張，主程序算），確定才丟資源回收筒；天數記在這台電腦 */
try { const d = localStorage.getItem('daybook.shotDays'); if (d) $('shotDays').value = d; } catch { /* 讀不到就 30（index.html 的預設） */ }
function shotCleanAsk(on, msg) {
  $('shotCleanAsk').hidden = !on;
  $('shotClean').hidden = on;
  if (msg) $('shotCleanMsg').textContent = msg;
}
$('shotDays').addEventListener('change', () => {
  try { localStorage.setItem('daybook.shotDays', $('shotDays').value); } catch { /* 記不住就算了 */ }
});
$('shotCleanBtn').addEventListener('click', () => act(async () => {
  const { cut, n } = await api.shotClean(Number($('shotDays').value), true);
  if (!n) { toast(L('沒有 {date}（含）以前的編號截圖', { date: cut })); return; }
  shotCleanAsk(true, L('{date}（含）以前的編號截圖 {n} 張丟到資源回收筒？保留的不動。', { date: cut, n }));
  $('shotCleanOk').focus();
}));
$('shotCleanOk').addEventListener('click', () => act(async () => {
  const { n } = await api.shotClean(Number($('shotDays').value));
  toast(L('清掉 {n} 張，丟到資源回收筒了', { n }));
  await refreshShots();
}));
$('shotCleanNo').addEventListener('click', () => shotCleanAsk(false));
$('shotOpen').addEventListener('click', () => act(() => api.openLocation('shots')));
$('shotPick').addEventListener('click', () => act(async () => {
  const dir = await api.shotPickDir();
  if (!dir) return;
  toast(L('截圖改放在：{dir}', { dir }));
  await refreshShots();
}));
api.onShotChanged(() => { if (shotMode() && !shotKeeping()) act(refreshShots); });

/* ---------- 頁籤的右鍵選單（見 開發筆記 D120）：記事本、MD 檢視共用，照 VS Code ----------
   按右鍵的那個頁籤不會換成正在看的（照 VS Code）。關閉跟 × 一樣；關閉其他、關閉右側、全部關閉在記事本碰到改過沒存的，一次問（noteAsk 的 { close }）。
   在檔案總管中顯示、複製路徑：還沒存的新記事、檔案在外面不見了的記事沒有路徑，那兩項藏起來；沒有可以關的那項淡色點不了 */
let tabMenuAt = null;   // { md, key }：按右鍵的是 MD 檢視（md）還是記事本的哪個頁籤（MD 是完整路徑、記事本是 noteKey）
const tabKeys = md => (md ? mdPad.open : notePad.open);
function tabMenu(open, x, y) {
  const m = $('tabMenu');
  m.hidden = !open;
  if (!open) return;
  const { md, key } = tabMenuAt, keys = tabKeys(md);
  m.querySelector('[data-act="others"]').disabled = keys.length < 2;
  m.querySelector('[data-act="right"]').disabled = keys.indexOf(key) === keys.length - 1;
  m.querySelector('.tmPath').hidden = !md && !notePad.files.includes(key.slice(2));   // 新記事是 'u:'，不會在 files 裡
  m.querySelector('[data-act="browser"]').hidden = !(md && mdIsHtml(key));   // 用瀏覽器開：只有 .html（D122）
  placeMenu(m, x, y);
}
// 選單收起來之後游標回到那一邊的內容（Esc、複製路徑、在檔案總管中顯示）
const tabMenuBack = () => (tabMenuAt?.md ? $('mdView') : noteCur ? $('noteText') : null)?.focus();
for (const md of [false, true]) {
  $(md ? 'mdTabs' : 'noteTabs').addEventListener('contextmenu', e => {
    e.preventDefault();
    const tab = e.target.closest('.noteTab');
    if (!tab || (!md && noteBusy())) return;   // 頁籤上的空白、改名中不出選單
    tabMenuAt = { md, key: tab.dataset.key };
    let { clientX: x, clientY: y } = e;
    if (!x && !y) { const r = tab.getBoundingClientRect(); x = r.left + 16; y = r.bottom; }   // 鍵盤（選單鍵、Shift+F10）叫出來的：放在頁籤底下
    tabMenu(true, x, y);
  });
}
$('tabMenu').addEventListener('click', e => {
  const what = e.target.closest('button')?.dataset.act;
  if (!what) return;
  const { md, key } = tabMenuAt, keys = tabKeys(md), i = keys.indexOf(key);
  tabMenu(false);
  if (i < 0) return;   // 選單開著時那個頁籤已經關掉了（外面刪了檔）
  if (what === 'close') { if (md) mdClose([key]).then(tabMenuBack); else closeNote(noteOf(key)); return; }
  const which = what === 'others' ? keys.filter(k => k !== key) : what === 'right' ? keys.slice(i + 1) : what === 'all' ? [...keys] : null;
  if (which) { if (md) mdClose(which).then(tabMenuBack); else noteCloseMany(which); return; }
  act(async () => {
    if (what === 'browser') await api.mdBrowser(key);
    else if (what === 'reveal') await (md ? api.mdReveal(key) : api.revealNote(key.slice(2), false));
    else { await api.copyText(md ? key : await api.notePath(key.slice(2), false)); toast(L('已複製路徑')); }
    tabMenuBack();
  });
});
document.addEventListener('mousedown', e => { if (!$('tabMenu').hidden && !e.target.closest('#tabMenu')) tabMenu(false); });
/* 記事本一次關好幾個：改過沒存的一次問（D120），都沒改過就直接關 */
const noteCloseMany = keys => act(async () => {
  noteSync();
  const dirty = keys.filter(k => noteDirty(noteOf(k)));
  if (dirty.length) { noteAsk({ close: keys, dirty }); return; }
  await noteClose(keys, true);
});

/* ---------- 頁籤的按鍵、拖拉（見 開發筆記 D160）：記事本、文件檢視共用，照 VS Code ----------
   Ctrl+W、中鍵點頁籤：關掉（跟 × 一樣，改過沒存的先問）。Ctrl+PageDown／PageUp：右邊／左邊那個（到頭繞回來）。
   Ctrl+Tab／Ctrl+Shift+Tab：照最近看過的順序（tabMru），按住 Ctrl 跳出清單（#tabSwitch），放開 Ctrl 換過去。
   Ctrl+Shift+T：重開剛關掉的（tabClosed，放回原本的位置；新記事、檔案不見了的跳過；只記這次開著 daybook 的）。拖頁籤調順序。
   一定要攔下來（preventDefault）：Electron 預設選單的 Ctrl+W 是關掉整個視窗。游標在 .html 裡按的，網頁裡的監聽（DOC_HOOKS）攔下來轉過來 */
const tabMru = { note: [], md: [] };      // 最近看過的在前面（記事本是 noteKey、文件檢視是完整路徑）；畫的時候（refreshNotes、mdRender）把正在看的放最前面
const tabClosed = { note: [], md: [] };   // 剛關掉的 { key, at（原本第幾個）}，最後關的在最後面，最多記 30 個
const tabOpen = w => (w === 'md' ? mdPad.open : notePad.open);
function tabTouch(w, k) {
  if (!k) return;
  const m = tabMru[w], i = m.indexOf(k);
  if (i >= 0) m.splice(i, 1);
  m.unshift(k);
}
// 記下使用者關掉的（×、Ctrl+W、中鍵、右鍵）。一次關好幾個時從右邊的先記：重開時從左邊的一個一個放回去，位置才對
function tabRemember(w, keys) {
  const open = tabOpen(w), list = tabClosed[w];
  list.push(...keys.map(key => ({ key, at: open.indexOf(key) })).filter(x => x.at >= 0 && (w === 'md' || x.key.startsWith('f:'))).sort((a, b) => b.at - a.at));
  if (list.length > 30) list.splice(0, list.length - 30);
}
const tabGo = (w, k) => (w === 'md' ? mdOpen(k).then(mdBack) : openNote(noteOf(k)));   // 換到那份、游標進內容
const tabBack = w => (w === 'md' ? mdBack() : noteCur && $('noteText').focus());
function tabReopen(w) {
  const open = tabOpen(w), has = w === 'md' ? k => mdPad.files.has(k) : k => notePad.files.includes(k.slice(2));
  for (let e = tabClosed[w].pop(); e; e = tabClosed[w].pop()) {
    if (open.includes(e.key) || !has(e.key)) continue;   // 已經開著、檔案不見了：跳過，重開再前一個
    open.splice(Math.min(e.at, open.length), 0, e.key);
    tabGo(w, e.key);
    return;
  }
}
/* Ctrl+Tab 的清單：照最近看過的列開著的（正在看的在最前面），一按就選到第二個（Ctrl+Shift+Tab 是最後一個）；焦點搬到清單上，放開 Ctrl 的 keyup 才收得到 */
let tabSw = null;   // 清單開著時：{ w, keys, at（選到第幾個）}
function tabSwitch(w, d) {
  if (!tabSw) {
    const open = tabOpen(w), keys = [...tabMru[w].filter(k => open.includes(k)), ...open.filter(k => !tabMru[w].includes(k))];
    if (keys.length < 2) return;
    tabSw = { w, keys, at: 0 };
  }
  const n = tabSw.keys.length, m = $('tabSwitch');
  tabSw.at = (tabSw.at + d + n) % n;
  m.replaceChildren(...tabSw.keys.map((k, i) => {
    const it = el('div', 'tsItem' + (i === tabSw.at ? ' on' : ''), tabSw.w === 'md' ? mdName(k) : noteKeyName(k));
    it.setAttribute('role', 'option');
    it.setAttribute('aria-selected', String(i === tabSw.at));
    const dir = tabSw.w === 'md' ? mdBase(mdParent(k)) : k.startsWith('f:') ? noteParent(k.slice(2)) || L('最上層') : '';
    if (dir) it.append(el('span', 'noteDirHint', dir));
    return it;
  }));
  if (m.hidden) {
    m.hidden = false;
    const r = $(tabSw.w === 'md' ? 'mdBar' : 'noteBar').getBoundingClientRect();
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
  if (go && at > 0) tabGo(w, keys[at]); else tabBack(w);
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
/* 頁籤的按鍵：記事本、文件檢視開著、按著 Ctrl 時。key、shift 是按的鍵（網頁裡按的由 postMessage 帶過來）。是頁籤的鍵就回 true，呼叫的那邊攔下來 */
function tabKey(key, shift) {
  const w = mdMode() ? 'md' : noteMode() ? 'note' : null;
  const k = key.length === 1 ? key.toLowerCase() : key;
  const what = k === 'w' && !shift ? 'close' : k === 't' && shift ? 'reopen' : k === 'Tab' ? 'switch' : !shift && (k === 'PageDown' || k === 'PageUp') ? 'step' : null;
  if (!w || !what) return false;
  if (!$('noteAsk').hidden || noteBusy()) return true;   // 在問存不存、頁籤改名中：攔下來、不做
  const open = tabOpen(w), cur = w === 'md' ? mdPad.cur : noteCur && noteKey(noteCur);
  if (what === 'close') { if (cur) { if (w === 'md') mdClose([cur]).then(mdBack); else closeNote(noteCur); } }
  else if (what === 'reopen') tabReopen(w);
  else if (what === 'switch') tabSwitch(w, shift ? -1 : 1);
  else if (open.length > 1) tabGo(w, open[(open.indexOf(cur) + (k === 'PageDown' ? 1 : -1) + open.length) % open.length]);
  return true;
}
/* 中鍵點頁籤：關掉（跟 × 一樣）。拖頁籤：放在哪個頁籤的左半邊就插在它前面、右半邊就插在後面（只在同一排裡搬） */
let tabDrag = null;   // 拖著的頁籤 { md, key }
const tabAfter = (tab, e) => { const r = tab.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
function tabDropMark(tab, after) {
  for (const t of document.querySelectorAll('.noteTab.dropL, .noteTab.dropR')) t.classList.remove('dropL', 'dropR');
  if (tab) tab.classList.add(after ? 'dropR' : 'dropL');
}
for (const md of [false, true]) {
  const bar = $(md ? 'mdTabs' : 'noteTabs');
  // 中鍵按下去的預設動作攔掉：不攔的話記事本的頁籤收不到 auxclick（mousedown、mouseup 都在同一個元素、中間沒重畫，文件檢視的卻收得到；原因沒查到，D160）
  bar.addEventListener('mousedown', e => { if (e.button === 1 && e.target.closest('.noteTab')) e.preventDefault(); });
  bar.addEventListener('auxclick', e => {
    const tab = e.button === 1 && e.target.closest('.noteTab');
    if (!tab || (!md && noteBusy())) return;
    e.preventDefault();
    if (md) mdClose([tab.dataset.key]); else closeNote(noteOf(tab.dataset.key));
  });
  bar.addEventListener('dragstart', e => {
    const tab = e.target.closest('.noteTab');
    if (!tab || (!md && noteBusy())) { e.preventDefault(); return; }
    tabDrag = { md, key: tab.dataset.key };
    e.dataTransfer.effectAllowed = 'move';
  });
  bar.addEventListener('dragover', e => {
    const tab = e.target.closest('.noteTab');
    if (!tabDrag || tabDrag.md !== md || !tab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tabDropMark(tab, tabAfter(tab, e));
  });
  bar.addEventListener('dragleave', e => { if (!bar.contains(e.relatedTarget)) tabDropMark(null); });
  bar.addEventListener('drop', e => {
    const tab = e.target.closest('.noteTab'), d = tabDrag;
    tabDropMark(null);
    if (!d || d.md !== md || !tab) return;
    e.preventDefault();
    const open = tabOpen(md ? 'md' : 'note'), from = open.indexOf(d.key);
    if (from < 0 || tab.dataset.key === d.key) return;
    const after = tabAfter(tab, e);
    open.splice(from, 1);
    open.splice(open.indexOf(tab.dataset.key) + (after ? 1 : 0), 0, d.key);
    if (md) { mdSave(); $('mdTabs').replaceChildren(...mdPad.open.map(mdTab)); } else { noteSaveList(); $('noteTabs').replaceChildren(...noteTabs().map(noteTab)); }
  });
  bar.addEventListener('dragend', () => { tabDrag = null; tabDropMark(null); });
}

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
  const min = s.map(k => k === 'form' ? formMin() : PANE_MIN);
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
  applyOutline();   // 大綱的高度（D162）
  $('sizeReset').disabled = true;
  toast(L('已還原預設大小'));
});

/* 外觀頁「頁籤列」（見 開發筆記 D146）：勾掉的頁籤藏起來，日記本不能藏。改了馬上套上（html 的 data-hide-tabs，style.css 照它藏）、
   記在這台電腦，theme.js 開頭就套上。藏的是正在看的那個：中間回日記（記事本打到一半的照樣暫存，同點「日記本」）；
   左欄開著、放的是它就換回日記本那格（收著的不打開，之後打開都走 showSide） */
const tabBoxes = () => [...document.querySelectorAll('#tabBox input[data-tab]')];
function setHideTabs(list) {
  if (list.length) document.documentElement.dataset.hideTabs = list.join(' ');
  else delete document.documentElement.dataset.hideTabs;
  try { localStorage.setItem('daybook.hideTabs', list.join(' ')); } catch { /* 記不住就算了 */ }
  if (noteMode() && list.includes('note')) setNoteMode(false);
  if (mdMode() && list.includes('md')) setMdMode(false);
  if (shotMode() && list.includes('shot')) setShotMode(false);
  if (!sideOff() && list.includes(sideView())) showSide('journal');
  markTabReset();
}
for (const b of tabBoxes()) b.addEventListener('change', () => setHideTabs(tabBoxes().filter(x => !x.checked).map(x => x.dataset.tab)));

/* 外觀頁「頁籤列」的順序（見 開發筆記 D151）：一列一個頁籤，↑↓ 跟上、下一列換位置，日記本也能搬（藏起來的也照排）。
   改了馬上套上（theme.js 的 applyTabOrder，style.css 照 --ord-xxx 排）、記在這台電腦（跟預設一樣就記空字串），theme.js 開頭就套上。
   外觀頁的列照記的順序排（列的順序就是現在的順序） */
const tabRows = () => [...document.querySelectorAll('#tabBox .tabRow')];
function sortTabRows(o) {
  const rows = tabRows();
  $('tabBox').append(...o.map(k => rows.find(r => r.dataset.ord === k)));
  tabRows().forEach((r, i, all) => { r.querySelector('.tabUp').disabled = !i; r.querySelector('.tabDown').disabled = i === all.length - 1; });
  markTabReset();
}
function setTabOrder(o) {
  applyTabOrder(o);
  try { localStorage.setItem('daybook.tabOrder', o.join(' ') === TABS.join(' ') ? '' : o.join(' ')); } catch { /* 記不住就算了 */ }
  sortTabRows(o);
}
for (const r of tabRows()) {
  const move = d => () => {
    const o = tabRows().map(x => x.dataset.ord), i = o.indexOf(r.dataset.ord);
    [o[i], o[i + d]] = [o[i + d], o[i]];
    setTabOrder(o);
    const [b, other] = d < 0 ? [up, down] : [down, up];
    (b.disabled ? other : b).focus();   // 列搬動時焦點會掉，放回按的那顆（搬到頂、底變灰就換另一顆），連按才搬得動
  };
  const up = button('openBtn tabUp', '↑', move(-1)), down = button('openBtn tabDown', '↓', move(1));
  up.title = L('往上移');
  down.title = L('往下移');
  r.append(up, down);
}
try { sortTabRows(tabOrder(localStorage.getItem('daybook.tabOrder'))); } catch { sortTabRows(TABS); }

/* 外觀頁「還原預設頁籤」（見 開發筆記 D153）：順序、勾選一起回預設（全部勾、照 TABS 排，記的都是空字串）；已經是預設就變灰。
   藏、搬都會叫到這裡（setHideTabs、sortTabRows） */
function markTabReset() {
  $('tabReset').disabled = !document.documentElement.dataset.hideTabs && tabRows().every((r, i) => r.dataset.ord === TABS[i]);
}
$('tabReset').addEventListener('click', () => {
  for (const b of tabBoxes()) b.checked = true;
  setHideTabs([]);
  setTabOrder(TABS);
  toast(L('已還原預設頁籤'));
});

/* 外觀頁「字型」（見 開發筆記 D113）：介面、內容的字型，內容字的大小；改了馬上套上（theme.js 的 applyFont）、記在這台電腦，
   theme.js 開頭就套上。只記改過的，都沒改是 {}。字型清單用 Chromium 的 queryLocalFonts 讀這台電腦裝的，每次打開外觀頁重讀 */
let font = (() => { try { return JSON.parse(localStorage.getItem('daybook.font')) || {}; } catch { return {}; } })();
function setFont(patch) {
  font = { ...font, ...patch };
  for (const k of Object.keys(font)) if (!font[k]) delete font[k];
  applyFont(font);
  try { localStorage.setItem('daybook.font', JSON.stringify(font)); } catch { /* 記不住就算了 */ }
  $('fontReset').disabled = !Object.keys(font).length;
  noteLater();   // 記事本的行號照新的字重新量（字變大時行號欄變寬、ResizeObserver 也會量；只換字型、數字一樣寬時要靠這行）
}
async function fillFonts() {
  let fams = [];
  try { fams = [...new Set((await window.queryLocalFonts()).map(f => f.family))].sort((a, b) => a.localeCompare(b)); } catch { /* 讀不到就只列預設 */ }
  const opt = (value, text) => { const o = el('option', null, text); o.value = value; if (value) o.style.fontFamily = cssFont(value); return o; };
  for (const [id, k, def] of [['fontUi', 'ui', L('預設（微軟正黑體 UI）')], ['fontMono', 'mono', L('預設（Consolas＋微軟正黑體）')]]) {
    const gone = font[k] && !fams.includes(font[k]) ? [opt(font[k], L('{font}（這台電腦沒有）', { font: font[k] }))] : [];   // 選過、後來移除的字型
    $(id).replaceChildren(opt('', def), ...fams.map(f => opt(f, f)), ...gone);
    $(id).value = font[k] || '';
  }
  $('fontSize').value = font.size || FONT_SIZE;
  $('fontReset').disabled = !Object.keys(font).length;
}
$('fontUi').addEventListener('change', () => setFont({ ui: $('fontUi').value }));
$('fontMono').addEventListener('change', () => setFont({ mono: $('fontMono').value }));
$('fontSize').addEventListener('change', () => {   // 方向鍵、上下鈕馬上換；打字的話 Enter 或離開才換
  const size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number($('fontSize').value)) || FONT_SIZE));
  $('fontSize').value = size;
  setFont({ size: size === FONT_SIZE ? null : size });
});
$('fontReset').addEventListener('click', () => {
  font = {};
  setFont({});
  for (const id of ['fontUi', 'fontMono']) $(id).value = '';
  $('fontSize').value = FONT_SIZE;
  toast(L('已還原預設字型'));
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
  $('dayTitle').textContent = L('{date}（{w}）', { date: st.day, w: weekday(st.day) }) + (st.day === st.info.today ? '　' + L('今天') : '');   // 不翻：全形空白只是隔開
  if (st.mode === 'text') {   // 文字模式唯讀（D141）：每次都照檔案；一樣就不換，捲動位置、選的字留著
    st.counts.done = null;
    paneHeads();
    const text = await api.readDay(st.day);
    if (text !== $('editor').value) $('editor').value = text;
    return;
  }
  st.counts.done = (await renderList($('cards'), st.day, L('這天還沒有處理過的事'))).length;
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
  if (st.mode === 'text') {   // 文字模式唯讀（D141）
    st.counts.todo = null;
    paneHeads();
    const text = await api.readTodo();
    if (text !== $('todo').value) $('todo').value = text;
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
  if (!shown.length) box.appendChild(emptyBox(hidden.length ? L('沒有待處理的事（有隱藏的）') : L('沒有待處理的事')));
  if (hidden.length) {
    box.appendChild(button('hiddenToggle', `${st.showHidden ? '▾' : '▸'} ` + L('已隱藏 {n} 筆', { n: hidden.length }), () => {
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

function renderResults(title, items, emptyText = L('沒有找到')) {
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
    renderResults(L('搜尋「{q}」：{n} 筆', { q: st.q, n: items.length }) + (items.length >= 300 ? L('（只列前 300 筆）') : ''), items);
  } else if (st.view === 'timeline') {
    const items = await api.timeline(st.by);
    renderResults(st.by.code != null ? L('{code} 時間軸：{n} 筆', { code: st.by.code, n: items.length }) : L('事件 ^{event}：{n} 筆', { event: st.by.event, n: items.length }), items);
  } else if (st.view === 'flagged') {
    const { items, cats } = await api.flagged();   // 清單和分類一次拿（見 開發筆記 D157）
    renderFlagged(items, cats);
  } else if (st.view === 'range') {
    await renderRange();
  } else {
    await renderDay();
    await renderTodo();
  }
}

async function openDay(date, focusIndex) {
  if (!(await editGuard())) return;   // 有卡片在編輯：先問（D140）
  st.view = 'day';
  st.day = date;
  st.calMonth = date.slice(0, 7);   // 日曆跟著翻到那一天的月份
  st.focus = focusIndex == null ? null : focusIndex;
  await refreshCenter();
  await refreshDays();
}
async function showSearch(q) {
  if (!(await editGuard())) return;
  st.view = 'search';
  st.q = q;
  await refreshCenter();
  await refreshDays();
}
async function showTimeline(by) {
  if (!(await editGuard())) return;
  st.view = 'timeline';
  st.by = by;
  await refreshCenter();
  await refreshDays();
}
/* 標記清單分批畫（見 開發筆記 D157）：一次畫 FLAG_BATCH 張，捲到離底下不到一個畫面高再接下一批。
   flagRest：{ items（篩過的全部）, next（畫到第幾張） }。重畫（取消標記、外面改檔、Ctrl+Z）至少畫回 next 張，捲動位置才不會跑掉（D045）；
   重新打開、換篩選設成 null，從第一批畫起。回顧、搜尋也畫在 #results，所以只在標記清單接 */
const FLAG_BATCH = 300;
let flagRest = null;
function moreFlags() {
  const box = $('results');
  while (st.view === 'flagged' && flagRest && flagRest.next < flagRest.items.length
    && box.scrollHeight - box.scrollTop - box.clientHeight < box.clientHeight) {   // 看不到時高度都是 0，不成立
    const { items, next } = flagRest;
    for (const it of items.slice(next, next + FLAG_BATCH)) box.appendChild(card(it, { src: it.src, editable: false, showSrc: true, unflag: true }));
    flagRest.next = Math.min(next + FLAG_BATCH, items.length);
  }
}
$('results').addEventListener('scroll', moreFlags);

/* 標記清單上面一排篩選鈕（見 開發筆記 D076）：全部、未分類、各分類（照分類清單的順序），後面寫筆數，點了只列那一類。
   「全部」「未分類」不能當分類名稱（parser.js 的 checkCat），所以直接拿來當篩選的值 */
function renderFlagged(items, cats) {
  const keyOf = it => it.flagCat || '未分類';   // 不翻：篩選的值（哨兵）
  const keys = ['全部', '未分類', ...cats];   // 不翻：篩選的值（哨兵），顯示時才換字（name）
  if (!keys.includes(st.flagFilter)) st.flagFilter = '全部';   // 不翻：哨兵值
  const all = st.flagFilter === '全部';   // 不翻：哨兵值
  // 篩選鈕、標題上寫的字：「全部」「未分類」是畫面的字（換語言），分類名稱是使用者取的（照原字）
  const name = k => (k === '全部' ? L('全部') : k === '未分類' ? L('未分類') : k);   // 不翻：比對哨兵值
  const shown = all ? items : items.filter(it => keyOf(it) === st.flagFilter);
  const limit = Math.max(FLAG_BATCH, flagRest ? flagRest.next : 0);   // 先畫一批（D157）；重畫畫回原本那麼多
  renderResults(all ? L('標記：{n} 筆', { n: items.length }) : L('標記（{cat}）：{n} 筆', { cat: name(st.flagFilter), n: shown.length }), shown.slice(0, limit), all ? L('沒有標記的事') : L('這個分類沒有標記的事'));
  flagRest = { items: shown, next: Math.min(limit, shown.length) };
  const bar = el('div', 'flag-filter');
  for (const k of keys) {
    const n = k === '全部' ? items.length : items.filter(it => keyOf(it) === k).length;   // 不翻：哨兵值
    const b = button('cat' + (k === st.flagFilter ? ' on' : ''), `${name(k)} ${n}`, () => { st.flagFilter = k; flagRest = null; renderFlagged(items, cats); });
    b.dataset.cat = k;
    bar.appendChild(b);
  }
  $('results').prepend(bar);
  moreFlags();   // 捲在底下重畫的話，接著補
}

/* 標記清單（見 開發筆記 D072）：所有標記過的已處理，舊的在前；清單上可以直接取消標記；上面可以篩分類（D076） */
async function showFlagged() {
  st.view = 'flagged';
  flagRest = null;   // 重新打開：從第一批畫起（D157）
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
  $('dayTitle').textContent = bad ? L('回顧 {from} ～ {to}', { from, to }) : L('回顧 {from} ～ {to}：{n} 筆', { from, to, n: items.length });
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.src)) byDay.set(it.src, []);
    byDay.get(it.src).push(it);
  }
  const box = $('results');
  box.textContent = '';
  for (const [date, list] of byDay) {
    const h = button('rangeDay', L('{date}（{w}）· {n} 筆', { date, w: weekday(date), n: list.length }), () => openDay(date));
    h.title = L('打開這一天');
    box.appendChild(h);
    for (const it of list) box.appendChild(card(it, { src: date, editable: false }));
  }
  if (!items.length) box.appendChild(el('div', 'empty', bad ? L('起日不能晚於訖日') : L('這段時間沒有處理過的事')));
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
  for (const i of [1, 2, 3, 4, 5, 6, 0]) grid.appendChild(el('span', 'wd', L(WEEK[i])));   // 一週從星期一開始
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
    b.title = shortDate(date) + (has.has(date) ? '' : '　' + L('沒有紀錄'));   // 不翻：全形空白只是隔開
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
  if (!launchBusy()) await refreshLaunch();   // 常用（D134）：開起來、或常用的動作出錯（清單對不上）時
  if (noteMode()) await refreshNotes();   // 開起來就是記事本、或記事本的動作出錯（D102）
  if (mdMode()) await refreshMd();        // MD 檢視也一樣（D118）
  if (shotMode() && !shotKeeping()) await refreshShots();   // 截圖頁也一樣（D129）；正在取名的不洗掉
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
  // 灰字要跟框裡的字疊得剛好：字型、內距、框線寬照抄輸入框；每次顯示前抄，外觀頁換了字型、大小也跟著（D113）
  const cs = getComputedStyle(input);
  const copy = () => {
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) box.style[k] = cs[k];
    // 搜尋框右邊有 × 清除鈕（約一個字寬），灰字不要疊到它；放不下就整段不顯示（下面量 scrollWidth）
    if (input.type === 'search') box.style.paddingRight = `calc(${cs.paddingRight} + 1em)`;
  };
  const clear = () => { typed.textContent = rest.textContent = ''; };
  return {
    clear,
    /* more：接在後面的灰字。回傳清單要貼著的位置 */
    show(ctx, more) {
      copy();
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
  return {
    clear() { box.hidden = true; },
    show(ctx, more) {
      // 每次顯示前抄，外觀頁換了字型、大小也跟著（D113）
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) box.style[k] = cs[k];
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
const pickTitle = (s, v) => hits(s.titles, v).map(x => ({ from: 0, text: x.t, note: L('{n} 次', { n: x.n }) }));

/* 內文（見 開發筆記 D054）：以前寫過的內文行，標題欄現在這個標題底下寫過的排前面 */
function pickLine(s, v) {
  const t = $('newTitle').value.trim().replace(/\s+/g, ' ');
  const hs = hits(s.lines, v);
  return hs.filter(x => x.heads.includes(t)).concat(hs.filter(x => !x.heads.includes(t)))
    .map(x => ({ from: 0, text: x.t, note: L('{n} 次', { n: x.n }) }));
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
  const out = hits(log, v, x => x.q).map(x => ({ from: 0, text: x.q, note: L('搜過 {n} 次', { n: x.n }) }));
  const m = v.match(/\S+$/);
  if (m) out.push(...hits(s.words, m[0]).map(x => ({ from: m.index, text: x.t, note: L('{n} 筆', { n: x.n }) })));
  return out;
}

const closeTitleSugg = suggest($('newTitle'), pickTitle);
const closeBodySugg = suggest($('newBody'), pickLine);
suggest($('q'), pickSearch, { enterThrough: true });

/* ---------- 新增表單：兩顆按鈕，加到待處理、或直接記成這一天的已處理（見 開發筆記 D025） ---------- */
function addNew(where) {
  const title = $('newTitle').value.trim();
  if (!title) { toast(L('標題不能空白'), true); $('newTitle').focus(); return; }
  const src = where === 'done' ? st.day : 'todo';
  cardAct(async () => {
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
/* Ctrl+W 不關掉 daybook（見 開發筆記 D161）：daybook 用 Electron 的預設選單，「Window → Close」是 Ctrl+W，畫面沒攔的地方（日記本、剪貼簿、設定頁…）按了整個視窗就關掉。
   capture 階段一律攔掉預設動作（攔下來選單就不跑，D042），不擋往下傳：記事本、文件檢視的 Ctrl+W 照樣關頁籤（D160）；游標在 .html 裡的由網頁裡的監聽攔 */
addEventListener('keydown', e => { if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'w') e.preventDefault(); }, true);
document.addEventListener('keydown', e => {
  if (e.key === 'F1') { e.preventDefault(); toggleHelp(); }   // 全部快捷鍵（見 開發筆記 D037）
  // 縮放（見 開發筆記 D042）：Ctrl+= 不用按 Shift；攔下來，選單的縮放才不會再跑一次
  if (e.ctrlKey && !e.altKey && ['=', '+', '-', '0'].includes(e.key)) { e.preventDefault(); stepZoom(e.key === '-' ? -1 : e.key === '0' ? 0 : 1); }
  if (!st.info || !st.info.dataDir) return;   // 還沒選資料夾：其他會動到資料的快捷鍵都不理（見 開發筆記 D041）
  if (e.ctrlKey && !e.altKey && tabKey(e.key, e.shiftKey)) { e.preventDefault(); return; }   // 頁籤的按鍵（D160）：Ctrl+W、Ctrl+Tab、Ctrl+PageUp／PageDown、Ctrl+Shift+T
  if (e.ctrlKey && !e.altKey && !e.shiftKey && actKey(e.key)) { e.preventDefault(); return; }   // Ctrl+1～9 換到頁籤列的第幾個（D168）
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (noteMode()) { noteFindOpen(); return; }   // 記事本：找這份裡的字（D104；原本是回到日記，D102）
    if (mdMode()) { mdFindOpen(); return; }   // 文件檢視：找這份裡的字（.md D147、.html D149；原本不理，D118）
    if (shotMode()) return;   // 截圖頁沒有字（D129）：不跳去日記的搜尋框（那格藏著）
    if (sideOff() || sideView() !== 'journal') showSide('journal');   // 左欄收起來、或放的是剪貼簿時搜尋框看不到：先打開日記本（D083、D093）
    $('q').focus(); $('q').select();
  }
  // 焦點在 .html 的 iframe 上、按鍵卻送到畫面（剛點進網頁，網頁還沒拿到焦點的那一下，D150 實測）：Esc 照樣收起找字的框。
  // 網頁拿到焦點後按的走網頁裡的監聽（postMessage）；Ctrl+F、F3 在畫面這裡本來就有
  if (e.key === 'Escape' && mdMode() && !$('mdFind').hidden && document.activeElement === $('docFrame')) mdFindClose();
  if (e.key === 'F3' && !e.ctrlKey && !e.altKey) {   // 找下一個／上一個（D150）：記事本、文件檢視
    if (noteMode()) { e.preventDefault(); noteFindKey(e.shiftKey ? -1 : 1); }
    else if (mdMode()) { e.preventDefault(); mdFindKey(e.shiftKey ? -1 : 1); }
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's' && noteMode()) { e.preventDefault(); noteSave(); }   // 記事本存檔（D105）
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h' && noteMode()) { e.preventDefault(); noteReplOpen(); }   // 記事本取代（D108）
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g' && noteMode()) { e.preventDefault(); noteGotoOpen(); }   // 記事本跳到第幾行（D108）
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p' && mdMode()) { e.preventDefault(); mdQuick(); }   // 找文件（D158）
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p' && noteMode()) {   // 找記事（D117）：清單收著、放剪貼簿時先打開清單
    e.preventDefault();
    if (sideOff() || sideView() !== 'journal') showSide('journal');
    $('nlQ').focus(); $('nlQ').select();
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && ['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) { e.preventDefault(); stepDay(e.key); }
  /* Ctrl+Z：游標在輸入框裡就交給輸入框自己復原打的字；不在的話復原上一個卡片動作（見 開發筆記 D028） */
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea')) {
    e.preventDefault();
    cardAct(async () => {
      const label = await api.undo();
      toast(label ? L('已復原：{label}', { label }) : L('沒有可以復原的動作'));
      await refreshAll();
    });
  }
});
$('backBtn').addEventListener('click', () => openDay(st.day));
$('modeBtn').addEventListener('click', async () => {
  if (!(await editGuard())) return;
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
const themeBtn = () => { $('themeBtn').textContent = isDark() ? L('淺色模式') : L('黑暗模式'); };
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
    const o = el('option', null, f.ext ? L('{label}（.{ext}，擴充「{name}」）', { label: f.label, ext: f.extension, name: f.ext }) : L('{label}（.{ext}）', { label: f.label, ext: f.extension }));
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
  act(async () => {
    const file = await api.exportFile({ ...req, format: $('expFmt').value });
    if (file) toast(L('已匯出：{file}', { file }));
  });
}
$('expRange').addEventListener('click', () => doExport({ from: $('expFrom').value, to: $('expTo').value }));
$('expAll').addEventListener('click', () => doExport({ all: true }));

/* 備份（見 開發筆記 D097）：齒輪「設定」選單的「備份…」；壓整個資料夾 */
$('backupBtn').addEventListener('click', async () => {
  act(async () => {
    const file = await api.backup();
    if (file) toast(L('已備份：{file}', { file }));
  });
});

/* ---------- 底部狀態列（見 開發筆記 D037）：游標在哪就寫那裡能按的快捷鍵；F1 打開全部（index.html 的 #help）。
   改快捷鍵時這裡跟 #help 都要改 ---------- */
const HINTS = [
  ['#newTitle', [['↑↓', L('選提示')], ['Tab', L('帶入提示')], ['Enter', L('換到內文')], ['Ctrl+Enter', L('加到待處理')], ['Ctrl+Shift+Enter', L('加到已處理')]]],
  ['#newBody', [['↑↓', L('選提示')], ['Tab', L('帶入提示／縮排')], ['Ctrl+Enter', L('加到待處理')], ['Ctrl+Shift+Enter', L('加到已處理')]]],
  ['#q', [['Enter', L('搜尋')], ['↑↓', L('選提示')], ['Tab', L('帶入提示')], ['Esc', L('關提示／清掉、回到那天')]]],
  ['.upd-text', [['Enter', L('存')], ['Esc', L('取消')]]],
  ['.cat-new', [['Enter', L('加上並標記')], ['Esc', L('取消')]]],   // 標記的新分類（見 開發筆記 D076）
  ['.edit-title', [['Ctrl+Enter', L('儲存')]]],
  ['.edit-body', [['Tab', L('縮排')], ['Ctrl+Enter', L('儲存')]]],
  ['#editor, #todo', [['Ctrl+C', L('複製選的字（唯讀，要改切回卡片模式）')]]],   // 文字模式唯讀（D141）
  ['#dayList button', [['↑↓', L('換日')], ['Alt+Home', L('今天')], ['Ctrl+F', L('搜尋')], ['Ctrl+Z', L('復原')]]],   // 見 開發筆記 D070
  // 剪貼簿（見 開發筆記 D093）
  ['.snip-copy', [['Enter', L('複製內文')], ['Alt+↑↓', L('調順序')], ['Ctrl+Z', L('復原')]]],   // Alt+↑↓ 見 D125
  ['.snip-title-in', [['Enter', L('換到內文')], ['Ctrl+Enter', L('儲存')]]],
  ['.snip-body-in', [['Tab', L('縮排')], ['Ctrl+Enter', L('儲存')]]],
  // 常用（見 開發筆記 D134）
  ['.lp-open', [['Enter', L('開啟')], ['Alt+↑↓', L('調順序')], [L('右鍵'), L('選單')]]],
  ['.lp-name-in, .lp-url-in', [['Enter', L('儲存')], ['Esc', L('取消')]]],
  // 記事本（見 開發筆記 D102）
  ['#noteText', [['Ctrl+S', L('存檔')], ['Ctrl+F', L('找字')], ['Ctrl+D', L('選下一個一樣的')], ['Alt+↑↓', L('搬這一行')], ['Ctrl+Shift+K', L('刪這一行')]]],
  ['#noteFindQ', [['Enter', L('下一個')], ['Shift+Enter', L('上一個')], ['Ctrl+H', L('取代')], ['Esc', L('關掉')]]],
  ['#noteReplQ', [['Enter', L('取代')], ['Ctrl+Alt+Enter', L('全部取代')], ['Esc', L('關掉')]]],   // 見 開發筆記 D108
  ['#noteGotoQ', [['Enter', L('跳過去')], ['Esc', L('取消')]]],
  ['.note-rename', [['Enter', L('改名／存檔')], ['Esc', L('取消')]]],
  ['#nlQ', [['Enter', L('開第一份')], ['Esc', L('清掉／回文字框')]]],   // 找記事（見 開發筆記 D117）
  ['#mdFindQ', [['Enter', L('下一個')], ['Shift+Enter', L('上一個')], ['Esc', L('關掉')]]],   // 文件檢視找字（見 開發筆記 D147）
  ['#mdQ', [['Enter', L('開第一份')], ['Esc', L('清掉／回文件')]]],   // 找文件（見 開發筆記 D158）
  ['#tabSwitch', [['Tab', L('下一個')], ['Shift+Tab', L('上一個')], [L('放開 Ctrl'), L('換過去')], ['Esc', L('不換')]]],   // Ctrl+Tab 的清單（見 開發筆記 D160）
  ['#noteTree, #noteTree .nlName', [['F2', L('改名')], ['Delete', L('刪除')], [L('右鍵'), L('選單')], ['Ctrl+P', L('找記事')]]],
  ['.shot-name-in', [['Enter', L('留下來')], ['Esc', L('取消')]]],   // 截圖取名（見 開發筆記 D129）
];
// 游標不在上面那些輸入框時
const HINT_DEFAULT = [['Ctrl+F', L('搜尋')], ['Alt+← / Alt+→', L('換日')], ['Alt+Home', L('今天')], ['Ctrl+Z', L('復原')]];
const HINT_MD = [['Ctrl+F', L('找字')], ['F3', L('下一個')], ['Ctrl+P', L('找文件')], ['', L('文件檢視：只看不改，檔案在外面改了會自己更新')]];   // 文件檢視（D118、D122）：日記那幾個在這裡沒用；Ctrl+F 是找字（D147、D149）、F3（D150）、Ctrl+P（D158）
const HINT_SHOT = [['', L('截圖：點縮圖放大看，滑過出現複製、留下來，按右鍵可以複製、列印；拖一個框選好幾張，右鍵一起複製；框選時 Enter 完成、Esc 不截了')]];   // 截圖頁（D129）
function statusHints() {
  const a = document.activeElement;
  const hit = a && HINTS.find(([sel]) => a.matches(sel));
  const noData = st.info && !st.info.dataDir;   // 還沒選資料夾（見 開發筆記 D041）
  const box = $('statusKeys');
  box.textContent = '';
  for (const [k, d] of noData ? [['', L('先選一個資料夾放工作紀錄')]] : hit ? hit[1] : mdMode() ? HINT_MD : shotMode() ? HINT_SHOT : HINT_DEFAULT) {
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

/* F1 的分頁（見 開發筆記 D156）：「通用」＋照頁籤列一頁一個。打開時分頁照外觀頁「頁籤列」現在的順序排（D151，通用在最前面；
   搬 DOM，Tab 走的順序才跟看到的一樣），藏起來的頁 style.css 照 data-hide-tabs 藏（D146）；先停在正在用的那頁。開著時 ←→ 換頁（到頭接另一頭） */
const helpTabs = () => [...$('helpTabs').children];
function helpPage(page) {
  for (const b of helpTabs()) { b.classList.toggle('on', b.dataset.page === page); b.setAttribute('aria-selected', String(b.dataset.page === page)); }
  for (const p of $('helpPages').children) p.classList.toggle('on', p.dataset.page === page);
}
// 正在用的那頁：游標在剪貼簿、常用就是它們；再來看中間是哪一頁；日記時游標不在中間、左欄開著放剪貼簿或常用（剛點了頁籤列）就是左欄那個
function helpNow() {
  const a = document.activeElement;
  if (a?.closest('#snipPane')) return 'snip';
  if (a?.closest('#launchPane')) return 'launch';
  if (noteMode()) return 'note';
  if (mdMode()) return 'md';
  if (shotMode()) return 'shot';
  return !a?.closest('#center') && !sideOff() ? sideView() : 'journal';
}
const toggleHelp = show => {
  const open = show ?? $('help').hidden;
  if (open && $('help').hidden) {
    $('helpTabs').append(...['common', ...tabRows().map(r => r.dataset.ord)].map(k => helpTabs().find(b => b.dataset.page === k)));
    helpPage(helpNow());
  }
  $('help').hidden = !open;
};
for (const b of helpTabs()) b.addEventListener('click', () => helpPage(b.dataset.page));
// capture 階段先攔：游標在後面的輸入框時，←→ 不會跟著動到那裡的游標
document.addEventListener('keydown', e => {
  if ($('help').hidden || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  e.preventDefault();
  e.stopPropagation();
  const tabs = helpTabs().filter(b => getComputedStyle(b).display !== 'none');
  const i = tabs.findIndex(b => b.classList.contains('on'));
  const to = tabs[(i + (e.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
  helpPage(to.dataset.page);
  if (document.activeElement?.closest('#helpTabs')) to.focus();   // 游標在分頁鈕上（點過、Tab 過去）就跟著換過去
}, true);
$('helpBtn').addEventListener('click', () => toggleHelp());
$('helpClose').addEventListener('click', () => toggleHelp(false));
$('help').addEventListener('click', e => { if (e.target === $('help')) toggleHelp(false); });   // 點外面關掉

/* 說明（見 開發筆記 D048）：之後別的說明也放這頁。「檔案放在哪」打開時跟主程序拿這台電腦實際的路徑。
   給拿到 exe 的人看的（D049）：可攜版、安裝版兩格都列，正在用的那種標「你現在用的」；
   可攜版不是正在用的話，exe 在哪、解壓的資料夾叫什麼都不知道，寫說明不寫路徑 */
async function showInfo() {
  const f = await api.filesInfo();
  const put = (id, p, text) => {
    $(id).textContent = p ? p.path : text || L('（還沒選）');
    // 位置不在時後面接「（目前沒有）」：style.css 用 ::after 顯示這個屬性的字（選起來複製不會帶到）；字放這裡才換得了語言（D131）
    if (p && !p.exists) $(id).dataset.missing = L('（目前沒有）');
    else delete $(id).dataset.missing;
    $(id).toggleAttribute('data-placeholder', !p && !!text);
  };
  put('fData', f.data);
  put('fShots', f.shots);   // 截圖資料夾（D129）
  put('fUserData', f.userData);
  put('fPortable', f.portableExe, L('exe 放在哪就在哪'));
  put('fUnpack', f.unpack, f.tempDir + '\\' + L('<每一版不同的名稱>'));
  put('fInstalled', f.installed);
  put('fUpdater', f.updater);
  put('fNsu', f.nsu);   // 解除安裝程式的暫存複本（見 開發筆記 D050〈後續〉）
  $('fPortableNow').hidden = f.mode !== 'portable';
  $('fInstalledNow').hidden = f.mode !== 'installed';
  /* 開啟位置（見 開發筆記 D051）：位置目前沒有就變灰；不是可攜版時不知道 exe 在哪，不放；
     解壓的資料夾不知道名稱時打開暫存區 */
  const where = { data: f.data, shots: f.shots, userData: f.userData, portableExe: f.portableExe, unpack: f.unpack || { exists: true },
    installed: f.installed, updater: f.updater, nsu: f.nsu };
  for (const b of $('info').querySelectorAll('.openBtn[data-open]')) {
    const p = where[b.dataset.open];
    b.disabled = !p || !p.exists;
    b.title = b.disabled ? L('這個位置目前沒有') : L('用檔案總管打開');
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
const EXT_STATE = { enabled: L('已啟用'), disabled: L('未啟用'), incompatible: L('版本不合'), broken: L('壞掉了') };
const outText = f => L('{label}（.{ext}，{hint}）', { label: f.label, ext: f.extension, hint: f.hint });   // 匯出格式：多寫副檔名
const fmtText = f => L('{label}（{hint}）', { label: f.label, hint: f.hint });
/* 啟用前的提醒：擴充的程式什麼時候會跑，照它提供匯入、匯出哪幾種（整句一個，換語言才翻得順，D131） */
const extWarn = x => (x.formats.length && x.exportFormats.length
  ? L('「{name}」的程式會在你按「匯入…」或匯出時執行，可以讀寫你電腦上所有你能碰的檔案（跟 VS Code 的擴充一樣，沒有隔離）。確定是信得過的人給的再啟用。', { name: x.displayName })
  : x.formats.length
    ? L('「{name}」的程式會在你按「匯入…」時執行，可以讀寫你電腦上所有你能碰的檔案（跟 VS Code 的擴充一樣，沒有隔離）。確定是信得過的人給的再啟用。', { name: x.displayName })
    : L('「{name}」的程式會在你匯出時執行，可以讀寫你電腦上所有你能碰的檔案（跟 VS Code 的擴充一樣，沒有隔離）。確定是信得過的人給的再啟用。', { name: x.displayName }));
function renderExts(r) {
  $('fmtBuiltin').textContent = joinList(r.builtin.map(fmtText));
  $('fmtBuiltinOut').textContent = joinList(r.builtinExport.map(outText));
  const btn = (text, act) => { const b = el('button', 'openBtn extBtn', text); b.type = 'button'; b.dataset.act = act; return b; };
  $('extTable').replaceChildren(...r.exts.map(x => {
    const tr = el('tr');
    tr.dataset.ext = x.name;
    tr.dataset.folder = x.folder;   // 刪除用資料夾名稱找（壞掉的、name 重複的也刪得到，同外觀包，見 開發筆記 D073、D081）
    tr.dataset.find = [x.displayName, x.name, x.folder, ...x.formats.map(f => f.label), ...x.exportFormats.map(f => f.label)].join('\n').toLowerCase();
    const th = el('th', null, x.displayName);
    if (x.version) th.append(el('span', 'extVer', ' ' + x.version));
    const td = el('td');
    const state = el('span', 'extState', x.reason ? L('{state}：{reason}', { state: EXT_STATE[x.state], reason: x.reason }) : EXT_STATE[x.state]);
    state.dataset.state = x.state;
    td.append(state);
    if (x.state === 'enabled') td.append(btn(L('停用'), 'off'));
    if (x.state === 'disabled') td.append(btn(L('啟用'), 'ask'));
    td.append(btn(L('刪除'), 'delAsk'));
    if (x.formats.length) td.append(el('p', null, L('匯入：{list}', { list: joinList(x.formats.map(fmtText)) })));
    if (x.exportFormats.length) td.append(el('p', null, L('匯出：{list}', { list: joinList(x.exportFormats.map(outText)) })));
    // 啟用、刪除都先問一次：按了展開底下那塊，再按「確定…」才做（D055、D081）
    const confirm = (kind, text, ok, cancel) => {
      const box = el('div', 'extConfirm');
      box.dataset.kind = kind;
      box.hidden = true;
      box.append(el('p', null, text), btn(ok[0], ok[1]), btn(L('取消'), cancel));
      td.append(box);
    };
    if (x.state === 'disabled') {
      confirm('on', extWarn(x), [L('確定啟用'), 'on'], 'cancel');
    }
    confirm('del', L('把「{name}」的資料夾（{folder}）丟到資源回收筒？要救回來，到資源回收筒還原就好。', { name: x.displayName, folder: x.folder }), [L('確定刪除'), 'del'], 'delCancel');
    tr.append(th, td);
    return tr;
  }));
  $('extNone').hidden = r.exts.length > 0;
  filterList($('extTable'), $('extFind'), $('extNoHit'));
  // 格式頁上的摘要（D085）
  $('extSum').textContent = r.exts.length ? L('已裝 {n} 個、啟用 {on} 個', { n: r.exts.length, on: r.exts.filter(x => x.state === 'enabled').length }) : L('還沒有裝');
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
    return act(async () => { renderExts(await api.deleteExt(tr.dataset.folder)); toast(L('已丟到資源回收筒：{name}', { name })); });
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
    box.append(el('p', null, r.stage === 'check' ? L('檢查沒通過，程式沒有執行：') : L('試跑沒通過，沒有安裝：')));
    const ul = el('ul');
    for (const m of r.errors) ul.append(el('li', null, m));
    box.append(ul);
    // 試跑看不出原因的錯誤附了檔案開頭，一起給 AI（見 開發筆記 D061）
    if (r.excerpt) box.append(el('p', null, L('你的檔案開頭（會一起複製給 AI，讓它看得出哪裡不對）：')), el('pre', null, r.excerpt.join('\n')));
    const b = el('button', 'openBtn', L('複製給 AI'));
    b.id = 'aiFeedback';
    b.type = 'button';
    box.append(el('p', null, L('按「複製給 AI」，貼回給 AI 請它照著改，再把新的那段貼進來。')), b);
  });
  aiFail = r;
}
/* 匯出格式的預覽（D079）：拿資料夾裡全部的紀錄匯出，每一種格式列大小、文字的開頭，可以存一份打開來看 */
function aiExportPreview(box, p) {
  box.append(el('p', null, L('「{name}」{version}，匯出格式：{list}', { name: p.displayName, version: p.version, list: joinList(p.outputs.map(outText)) })));
  if (p.replaces) box.append(el('p', 'aiWarn', L('會取代已經裝的「{name}」{version}。', { name: p.replaces.displayName, version: p.replaces.version })));
  box.append(el('p', null, p.todo ? L('試跑：拿資料夾裡全部的紀錄（{n} 天＋待處理）匯出', { n: p.days }) : L('試跑：拿資料夾裡全部的紀錄（{n} 天）匯出', { n: p.days })));
  const size = n => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);
  p.outputs.forEach((o, i) => {
    const day = el('div', 'aiDay');
    const save = el('button', 'openBtn aiSave', L('存一份看看…'));
    save.type = 'button';
    save.dataset.i = i;
    day.append(el('b', null, o.text ? L('{label}（.{ext}）：文字 {n} 行，{size}', { label: o.label, ext: o.extension, n: o.lines, size: size(o.size) })
      : L('{label}（.{ext}）：二進位檔，{size}', { label: o.label, ext: o.extension, size: size(o.size) })), save);
    if (o.text) day.append(el('pre', null, o.head + (o.more ? '\n' + L('…（還有 {n} 行）', { n: o.more }) : '')));
    box.append(day);
  });
  box.append(el('p', 'aiWarn', L('「{name}」的程式會在你匯出時執行，可以讀寫你電腦上所有你能碰的檔案（daybook 的檢查擋得住一般寫法，擋不住刻意繞過的）。上面匯出的對，再安裝。', { name: p.displayName })));
}
function aiPreview(p) {
  aiShow(box => {
    box.className = 'aiOk';
    if (p.kind === 'export') aiExportPreview(box, p);
    else aiImportPreview(box, p);
    const b = el('button', 'openBtn', L('安裝並啟用'));
    b.id = 'aiInstall';
    b.type = 'button';
    box.append(b);
  });
  aiToken = p.token;
  aiName = p.displayName;
  aiDone = p.kind;
}
function aiImportPreview(box, p) {
  box.append(el('p', null, L('「{name}」{version}，格式：{list}', { name: p.displayName, version: p.version, list: joinList(p.formats.map(fmtText)) })));
  if (p.replaces) box.append(el('p', 'aiWarn', L('會取代已經裝的「{name}」{version}。', { name: p.replaces.displayName, version: p.replaces.version })));
  // 別的格式也認得這個檔：試跑用的是 AI 寫的，匯入時會問用哪一種（見 開發筆記 D058）
  if (p.also.length) box.append(el('p', null, L('{list}也認得這個檔，匯入時會問你這次要用哪一種。', { list: joinList(p.also) })));
  const sum = [p.days ? L('試跑 {file}：拆出 {n} 天（{first} ～ {last}）', { file: p.file, n: p.days, first: p.first, last: p.last }) : L('試跑 {file}：拆出 {n} 天', { file: p.file, n: p.days })];
  // 已經有的：匯入時會問要加進去還是略過（見 開發筆記 D063）
  if (p.existing) sum.push(L('其中 {n} 天資料夾裡已經有，匯入時會問要加進去還是略過', { n: p.existing }));
  if (p.todoLines) sum.push(p.todoExisting ? L('待處理 {n} 行（資料夾裡的待處理已經有內容，匯入時一起問）', { n: p.todoLines }) : L('待處理 {n} 行', { n: p.todoLines }));
  box.append(el('p', null, semiList(sum)));
  for (const s of p.samples) {
    const day = el('div', 'aiDay');
    day.append(el('b', null, s.date), el('pre', null, s.text + (s.more ? '\n' + L('…（還有 {n} 行）', { n: s.more }) : '')));
    box.append(day);
  }
  box.append(el('p', 'aiWarn', L('「{name}」的程式會在你按「匯入…」時執行，可以讀寫你電腦上所有你能碰的檔案（daybook 的檢查擋得住一般寫法，擋不住刻意繞過的）。上面拆出來的對，再安裝。', { name: p.displayName })));
}
$('aiCopy').addEventListener('click', () => act(async () => {
  await api.aiCopy(aiKind());
  toast(aiKind() === 'export' ? L('prompt 已複製：貼到 Gemini 或 ChatGPT 的對話框，再寫你要的檔案長怎樣') : L('prompt 已複製：貼到 Gemini 或 ChatGPT 的對話框，再貼你的檔案開頭幾十行'));
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
  if (!$('aiReply').value.trim()) return toast(L('先把 AI 回的那段貼進框裡'), true);
  const r = await api.aiTry($('aiReply').value, aiKind());
  if (!r) return;   // 選檔取消
  if (r.errors) aiErrors(r);
  else aiPreview(r);
}));
$('aiResult').addEventListener('click', e => {
  if (e.target.closest('#aiFeedback')) {
    const r = aiFail;
    return act(async () => { await api.aiFeedback(r); toast(L('已複製：貼回給 AI，請它照著改')); });
  }
  const save = e.target.closest('.aiSave');
  if (save) {
    const token = aiToken;
    return act(async () => { const f = await api.aiSave(token, Number(save.dataset.i)); if (f) toast(L('已存：{file}', { file: f })); });
  }
  if (!e.target.closest('#aiInstall')) return;
  const token = aiToken, name = aiName, kind = aiDone;
  act(async () => {
    renderExts(await api.aiInstall(token));
    aiShow(box => {
      box.className = 'aiOk';
      box.append(el('p', null, kind === 'export' ? L('已安裝並啟用「{name}」：之後在齒輪「設定」的「匯出…」選這個格式。', { name }) : L('已安裝並啟用「{name}」：之後用齒輪「設定」的「匯入…」匯入。', { name })));
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
  const hidden = (document.documentElement.dataset.hideTabs || '').split(' ');   // 頁籤列（D146）
  for (const b of tabBoxes()) b.checked = !hidden.includes(b.dataset.tab);
  await fillFonts();
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
    const state = el('span', 'extState', x.reason ? L('{state}：{reason}', { state: EXT_STATE[x.state], reason: x.reason }) : EXT_STATE[x.state]);
    state.dataset.state = x.state;
    td.append(state);
    if (x.state === 'enabled') td.append(btn(L('停用'), 'off'));
    if (x.state === 'disabled') td.append(btn(L('啟用'), 'on'));
    td.append(btn(L('刪除'), 'ask'));
    if (x.parts.length) td.append(el('p', null, L('有：{list}', { list: joinList(x.parts) })));
    // 刪除先問一次（同擴充的「確定啟用」，D055）：按「刪除」展開，再按「確定刪除」才丟資源回收筒
    const box = el('div', 'extConfirm');
    box.hidden = true;
    box.append(el('p', null, L('把「{name}」的資料夾（{folder}）丟到資源回收筒？要救回來，到資源回收筒還原就好。', { name: x.displayName, folder: x.folder })),
      btn(L('確定刪除'), 'del'), btn(L('取消'), 'cancel'));
    td.append(box);
    tr.append(th, td);
    return tr;
  }));
  $('skinNone').hidden = r.skins.length > 0;
  filterList($('skinTable'), $('skinFind'), $('skinNoHit'));
  // 外觀頁上的摘要（D085）：一次只啟用一個，寫是哪一個
  const on = r.skins.find(x => x.state === 'enabled');
  $('skinSum').textContent = !r.skins.length ? L('還沒有') : on ? L('已裝 {n} 個、用的是「{name}」', { n: r.skins.length, name: on.displayName }) : L('已裝 {n} 個、沒有啟用', { n: r.skins.length });
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
      toast(L('已丟到資源回收筒：{name}', { name: tr.querySelector('th').firstChild.textContent }));
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
    mkQ(s,'.mkNo').textContent = L('第 {n} 張', { n: i + 1 });
    mkQ(s,'.mkOpacityV').textContent = `${mkQ(s,'.mkOpacity').value}%`;
    const cover = s.pos === 'cover';
    mkQ(s,'.mkSize').disabled = cover;
    mkQ(s,'.mkSizeV').textContent = cover ? L('鋪滿時不用調') : L('畫面寬的 {n}%', { n: mkQ(s,'.mkSize').value });
    for (const b of s.box.querySelectorAll('.mkPos button')) b.classList.toggle('on', b.dataset.pos === s.pos);
  });
  for (const box of $('mk').querySelectorAll('.mkPart')) {
    box.querySelector('.mkTolBox').classList.toggle('off', !box.querySelector('.mkCut').checked);
    box.querySelector('.mkTolV').textContent = box.querySelector('.mkTol').value;
  }
  $('mkBgAdd').textContent = mk.bgs.length ? L('＋ 再加一張…') : L('選圖…');
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
  toast(L('做好「{name}」並啟用了', { name: made ? made.displayName : r.name }));
  for (const s of [...mk.bgs]) mkDrop(s);
  if (mk.empty) mkDrop(mk.empty);
  $('mkName').value = L('我的外觀');
}
$('mkName').value = L('我的外觀');   // 預設名稱：index.html 的 value 是中文，換語言時在這裡換（D131）

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

/* ---------- 語言（見 開發筆記 D131）：齒輪「設定」的「語言」。介面用哪個語言（內建的繁體中文＋語言檔資料夾裡的），選了馬上換、畫面重新載入；
   語言檔清單（翻了幾條、缺幾條、壞掉的原因）、補翻缺的、刪除（先問一次，同外觀包 D073）；
   請 AI 翻一個新的語言：照格式頁那套（D056），貼回來的由主程序檢查，「安裝並換成這個語言」裝的是檢查過的那一份；框裡的字、要翻成什麼一改，結果就作廢。
   語言的名稱是語言檔寫的，一律放 textContent ---------- */
const BUILTIN_LANG = '繁體中文';   // 不翻：語言自己的名稱，介面換成別的語言也要認得出來
let langToken = null;
/* 換了語言（主程序已經換好字典）：畫面重新載入，載入後打開語言頁、提示換成哪個（sessionStorage，同匯入的 daybook.toast） */
function langReload(name) {
  try { sessionStorage.setItem('daybook.reopen', JSON.stringify({ page: 'lang', name })); } catch { /* 開不回來就算了 */ }
  location.reload();
}
async function showLang() {
  renderLang(await api.langList());
  $('lang').hidden = false;
}
const closeLang = () => { $('lang').hidden = true; };
function renderLang(r) {
  const ok = r.packs.filter(x => x.state === 'ok');
  const opt = (value, text) => { const o = el('option', null, text); o.value = value; return o; };
  $('langSel').replaceChildren(opt('', L('{name}（內建）', { name: BUILTIN_LANG })), ...ok.map(x => opt(x.id, x.name)));
  const cur = r.current ? ok.find(x => x.id === r.current) : null;
  $('langSel').value = cur ? cur.id : '';
  // 設定檔記的那個讀不到（被刪掉、改壞了）：照中文開，寫出來
  $('langLost').hidden = !r.current || !!cur;
  $('langLost').textContent = $('langLost').hidden ? '' : L('設定的語言檔「{file}」讀不到，現在照繁體中文顯示。', { file: r.current + '.json' });
  $('fLang').textContent = r.dir;
  const btn = (text, act) => { const b = el('button', 'openBtn extBtn', text); b.type = 'button'; b.dataset.act = act; return b; };
  $('langTable').replaceChildren(...r.packs.map(x => {
    const tr = el('tr');
    tr.dataset.lang = x.id;
    tr.dataset.name = x.name;
    const th = el('th', null, x.name);
    if (x.id !== x.name) th.append(el('span', 'extVer', ' ' + x.id + '.json'));
    const td = el('td');
    const state = el('span', 'extState', x.state === 'broken' ? L('壞掉了：{why}', { why: x.reason }) : x.id === r.current ? L('使用中') : L('未使用'));   // 不寫「沒有用」：會讀成「沒用處」（見 開發筆記 D166）
    state.dataset.state = x.state === 'broken' ? 'broken' : x.id === r.current ? 'enabled' : 'disabled';
    td.append(state);
    if (x.state === 'ok' && x.missing) td.append(btn(L('補翻缺的'), 'more'));
    td.append(btn(L('刪除'), 'delAsk'));
    if (x.state === 'ok') {
      td.append(el('p', null, semiList([...(x.lang ? [L('語言代碼 {lang}', { lang: x.lang })] : []),
        x.missing ? L('這版的字翻了 {done}／{total} 條，缺的 {missing} 條照中文顯示', x) : L('這版的字全部翻好了（{total} 條）', x)])));
    }
    const box = el('div', 'extConfirm');
    box.hidden = true;
    box.append(el('p', null, L('把「{file}」丟到資源回收筒？要救回來，到資源回收筒還原就好。', { file: x.id + '.json' })), btn(L('確定刪除'), 'del'), btn(L('取消'), 'delCancel'));
    td.append(box);
    tr.append(th, td);
    return tr;
  }));
  $('langNone').hidden = r.packs.length > 0;
}
/* 檢查的結果：認得幾條、會補進哪個、裝了還缺幾條、回錯的（沒收）；認得出翻譯才有「安裝並換成這個語言」 */
function langShow(r) {
  const box = $('langResult');
  box.replaceChildren();
  langToken = null;
  box.hidden = !r;
  if (!r) return;
  box.className = r.n ? 'aiOk' : 'aiErr';
  box.append(el('p', null, r.n ? L('認得 {n} 條翻譯。', r) : L('沒有認出翻譯：AI 回的要是一行一條「代號 翻譯」（prompt 裡有寫），整段照貼就好。')));
  if (r.merge) box.append(el('p', null, L('會補進已經裝的「{name}」：原本翻好的留著，這次有的蓋過去。', { name: r.merge })));
  if (r.n) {
    box.append(el('p', null, r.missing ? L('裝了之後，這版的 {total} 條還缺 {missing} 條，照中文顯示；之後再貼、或按上面的「補翻缺的」補。', r)
      : L('裝了之後，這版的 {total} 條全部翻好了。', r)));
    box.append(el('p', null, r.lang ? L('語言代碼：{lang}', r) : L('AI 沒寫 @lang，語言代碼空著（不影響顯示）。')));
  }
  if (r.problems.length) {
    box.append(el('p', 'aiWarn', L('有 {n} 條回錯了，沒收：', { n: r.problems.length + r.more })));
    const ul = el('ul');
    for (const p of r.problems) ul.append(el('li', null, `${p.id} ${p.key || ''} → ${p.text}：${p.why}`));   // 不翻：只是把代號、原文、回的、原因接起來
    if (r.more) ul.append(el('li', null, L('…還有 {n} 條', { n: r.more })));
    const fb = el('button', 'openBtn', L('複製有問題的給 AI'));
    fb.id = 'langFeedback';
    fb.type = 'button';
    box.append(ul, fb);
  }
  if (r.n) {
    const b = el('button', 'openBtn', L('安裝並換成這個語言'));
    b.id = 'langInstall';
    b.type = 'button';
    box.append(b);
  }
  langToken = r.token;
}
const langTarget = () => $('langTarget').value.trim();
const needTarget = () => {
  if (langTarget()) return false;
  toast(L('先填要翻成哪個語言'), true);
  $('langTarget').focus();
  return true;
};
async function langPromptShow() {
  if (!$('langPromptBox').open) return;
  $('langPromptText').textContent = langTarget() ? await api.langPrompt(langTarget()) : L('先填要翻成哪個語言');
}
$('langBtn').addEventListener('click', () => act(showLang));
$('langClose').addEventListener('click', closeLang);
$('langSel').addEventListener('change', () => act(async () => {
  const id = $('langSel').value || null;
  await api.setLang(id);
  langReload(id ? $('langSel').selectedOptions[0].textContent : BUILTIN_LANG);
}));
$('langTarget').addEventListener('input', () => { langShow(null); act(langPromptShow); });
$('langPromptBox').addEventListener('toggle', () => act(langPromptShow));
$('langCopy').addEventListener('click', () => act(async () => {
  if (needTarget()) return;
  await api.langCopy(langTarget());
  toast(L('prompt 已複製：貼到 Gemini 或 ChatGPT 的對話框'));
}));
$('langGemini').addEventListener('click', () => act(() => api.aiOpen('gemini')));
$('langChatgpt').addEventListener('click', () => act(() => api.aiOpen('chatgpt')));
$('langReply').addEventListener('input', () => langShow(null));
$('langTry').addEventListener('click', () => act(async () => {
  if (needTarget()) return;
  if (!$('langReply').value.trim()) return toast(L('先把 AI 回的貼進框裡'), true);
  langShow(await api.langCheck($('langReply').value, langTarget()));
}));
$('lang').addEventListener('click', e => {
  if (e.target === $('lang')) return closeLang();   // 點外面關掉
  const open = e.target.closest('.openBtn[data-open]');
  if (open) return act(() => api.openLocation(open.dataset.open));
  if (e.target.closest('#langFeedback')) {
    const token = langToken;
    return act(async () => { await api.langFeedback(token); toast(L('已複製：貼回給 AI，請它照著重翻')); });
  }
  if (e.target.closest('#langInstall')) {
    const token = langToken, name = langTarget();
    return act(async () => { await api.langInstall(token); langReload(name); });
  }
  const b = e.target.closest('.extBtn');
  if (!b) return;
  const tr = b.closest('tr');
  const ask = tr.querySelector('[data-act="delAsk"]'), box = tr.querySelector('.extConfirm');
  if (b.dataset.act === 'delAsk' || b.dataset.act === 'delCancel') {
    box.hidden = b.dataset.act === 'delCancel';
    ask.hidden = !box.hidden;
    return;
  }
  if (b.dataset.act === 'more') {
    // 補翻缺的：要翻成那個語言，prompt 只列它缺的；裝的時候補進同一個檔
    $('langTarget').value = tr.dataset.name;
    langShow(null);
    act(langPromptShow);
    $('langTarget').scrollIntoView({ block: 'center' });
    $('langTarget').focus();
    return toast(L('「要翻成」填好了：按「複製 prompt」，這次只列還缺的'));
  }
  if (b.dataset.act === 'del') {
    act(async () => {
      const r = await api.deleteLang(tr.dataset.lang);
      if (r.reload) return langReload(BUILTIN_LANG);   // 刪的是現在用的：換回繁體中文
      renderLang(r);
      toast(L('已丟到資源回收筒：{file}', { file: tr.dataset.lang + '.json' }));
    });
  }
});

// Esc 關掉（設定的小選單、記事清單、頁籤、MD 檢視清單、常用、截圖的右鍵選單、清單的排序選單、快捷鍵表、說明、格式、外觀、語言、截圖放大看）：在 capture 階段先攔下來，搜尋框的 Esc（清掉搜尋字）才不會一起跑
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || ($('settingsMenu').hidden && $('noteMenu').hidden && $('tabMenu').hidden && $('mdMenu').hidden && $('launchMenu').hidden && $('shotMenu').hidden && $('sortMenu').hidden && $('help').hidden && $('info').hidden && $('fmt').hidden && $('skin').hidden && $('lang').hidden && $('extList').hidden && $('skinList').hidden && $('shotBig').hidden)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!$('shotMenu').hidden) { shotMenu(false); shotMenuBack(); return; }   // 截圖的右鍵選單：先只收選單（放大看上面叫出來的，放大看留著，D142）
  if (!$('shotBig').hidden) { closeShotBig(); return; }   // 截圖放大看（D129）
  if (!$('settingsMenu').hidden) { settingsMenu(false); return; }   // 選單開著時只收選單（D092）
  if (!$('noteMenu').hidden) { noteMenu(false); noteListFocus(); return; }   // 右鍵選單：收起來、游標回清單（D117）
  if (!$('tabMenu').hidden) { tabMenu(false); tabMenuBack(); return; }   // 頁籤的右鍵選單：收起來、游標回內容（D120）
  if (!$('mdMenu').hidden) { mdMenu(false); mdMenuBack(); return; }   // MD 檢視清單的右鍵選單：收起來、游標回那一行（D121）
  if (!$('launchMenu').hidden) { launchMenu(false); launchMenuBack(); return; }   // 常用的右鍵選單：收起來、游標回那一張（D134）
  if (!$('sortMenu').hidden) { const w = sortMenuAt; sortMenu(null); sortBtn(w).focus(); return; }   // 清單的排序選單：收起來、游標回排序鈕（D132）
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
  closeLang();
}, true);

/* 外部改了檔（見 開發筆記 D020）：文字模式唯讀（D141），照樣換成檔案的內容；
   卡片模式下有卡片在編輯就先不重畫中間；剪貼簿也一樣，在編輯剪貼簿就先不重畫（D093）。
   記事本（D102）：開著才重讀；只有記事本的檔變了（多半是自己存的）日記就不重畫 */
api.onChanged(async files => {
  if (noteMode()) await refreshNotes();
  if (files.every(f => f.startsWith('記事本/'))) return;   // 不翻：資料夾名稱（paths.js 的 NOTE_DIR）
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
    $('setupLost').textContent = L('原本的資料夾找不到了：{dir}（隨身碟沒插、或被搬走？放回原位再開，或重新選一個）', { dir: st.info.lostDir });
  }
  statusHints();
  $('setupPick').focus();
}
$('setupPick').addEventListener('click', async () => {
  if (await api.changeDir()) location.reload();
});

/* 匯入（見 開發筆記 D044、D047）：已經有的日子略過、或加進去（D063）；結果字比較多，提示留久一點。寫出認成哪種格式 */
function importSummary(r) {
  const parts = [L('匯入 {n} 天（{format}）', { n: r.written, format: r.format })];
  if (r.skipped.length) {
    const list = joinList(r.skipped.slice(0, 5).map(d => d.slice(5))) + (r.skipped.length > 5 ? '…' : '');
    parts.push(L('跳過 {n} 天（資料夾裡已經有了：{list}）', { n: r.skipped.length, list }));
  }
  if (r.merged) {
    const m = r.merged;
    parts.push((m.days && m.todo ? L('資料夾裡已經有的 {days} 天和待處理：加進 {n} 筆', { days: m.days, n: m.added })
      : m.days ? L('資料夾裡已經有的 {days} 天：加進 {n} 筆', { days: m.days, n: m.added })
        : L('資料夾裡已經有的待處理：加進 {n} 筆', { n: m.added }))
      + (m.dup ? L('，{n} 筆一模一樣的沒加', { n: m.dup }) : ''));
  }
  if (r.todoLines) parts.push(L('待處理 {n} 行', { n: r.todoLines }));
  if (r.todoSkipped) parts.push(L('待處理已經有內容，檔案裡的待處理沒匯'));
  return semiList(parts) + (r.written || r.todoLines || (r.merged && r.merged.added) ? L('（Ctrl+Z 可以整批復原）') : '');
}
$('importBtn').addEventListener('click', () => act(async () => {
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
  // 設定檔讀不懂（見 開發筆記 D137）：主程序已經把壞檔改名留著，這次當作沒設定
  if (st.info.settingsBad) toast(L('設定檔讀不懂（手改壞了？），已另存成 {file}，這次當作沒設定', { file: st.info.settingsBad }), true, 10000);
  // 換了語言重新載入前留下的（見 開發筆記 D131）：打開語言頁、提示換成哪個；還沒選資料夾也照開
  try {
    const re = JSON.parse(sessionStorage.getItem('daybook.reopen'));
    sessionStorage.removeItem('daybook.reopen');
    if (re && re.page === 'lang') { await showLang(); toast(L('介面換成「{name}」', { name: re.name })); }
  } catch { /* 沒有就算了 */ }
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
