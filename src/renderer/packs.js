/* ============================================================
   格式（擴充）、外觀（外觀包）、語言三張設定頁共用（見 開發筆記 D185）：
   - 清單一列：名稱（後面淡淡寫版本）、狀態、鈕、先問一次的那塊（D055、D073、D081、D131）；按了展開／收起先問的那塊
   - 擴充、外觀包的清單另開一張（D085）：開、關、點外面關、搜尋
   - 請 AI 寫一個格式（D056）、翻一個語言（D131）：開 Gemini／ChatGPT、複製 prompt、貼回來的一改就作廢、檢查；結果那塊、裡面的鈕
   每一列寫什麼、按了做什麼、結果寫什麼留在 app.js。叫的時候才用到 app.js 的 $、el、act、toast、api。
   畫面用 <script> 載入，排在 app.js 前面
   ============================================================ */
'use strict';

/* 清單一列裡的鈕（data-act 是要做什麼） */
function packBtn(text, act) {
  const b = el('button', 'openBtn extBtn', text);
  b.type = 'button';
  b.dataset.act = act;
  return b;
}
/* 清單一列：data 寫進 tr 的 data-*；名稱放 th（擴充、外觀包、語言的名稱是別人寫的，一律 textContent），ver 有的話後面淡淡寫；
   td 開頭是狀態（state 是 enabled／disabled／incompatible／broken，CSS 照它上色）。回 { tr, td }：鈕、說明、先問的那塊接著放進 td */
function packRow(data, name, ver, state, stateText) {
  const tr = el('tr');
  Object.assign(tr.dataset, data);
  const th = el('th', null, name);
  if (ver) th.append(el('span', 'extVer', ' ' + ver));
  const td = el('td');
  const s = el('span', 'extState', stateText);
  s.dataset.state = state;
  td.append(s);
  tr.append(th, td);
  return { tr, td };
}
/* 先問一次的那塊（D055、D081）：藏著，按 ask 那顆展開，再按 ok 那顆才做、按取消收起來。kind 給了寫在 data-kind（一列有兩塊時分得出來） */
function packConfirm(td, text, [okText, okAct], cancelAct, kind) {
  const box = el('div', 'extConfirm');
  if (kind) box.dataset.kind = kind;
  box.hidden = true;
  box.append(el('p', null, text), packBtn(okText, okAct), packBtn(L('取消'), cancelAct));
  td.append(box);
}
/* 按了一列裡的鈕 b：是展開／收起先問的那塊就做、回 true。asks 是這一列可能有的那幾塊 [{ kind, ask, cancel }]（鈕的 data-act）：
   一次只開一塊，開著的那塊的 ask 鈕先藏起來；沒有的那塊跳過 */
function packAsk(b, asks) {
  const tr = b.closest('tr'), act = b.dataset.act, hit = asks.find(a => a.ask === act || a.cancel === act);
  if (!hit) return false;
  for (const a of asks) {
    const box = tr.querySelector(a.kind ? `.extConfirm[data-kind="${a.kind}"]` : '.extConfirm'), ask = tr.querySelector(`[data-act="${a.ask}"]`);
    if (!box) continue;
    box.hidden = !(a === hit && act === hit.ask);
    ask.hidden = !box.hidden;
  }
  return true;
}
/* 擴充、外觀包清單的搜尋框（D085）：空白隔開的每個詞都要出現（同左上的搜尋，D023），不分大小寫；比的是每一列的 data-find。
   清單重畫（啟用、刪除、裝好）之後也再篩一次，搜的字留著 */
function filterList(table, find, noHit) {
  const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
  for (const tr of table.rows) tr.hidden = !words.every(w => tr.dataset.find.includes(w));
  noHit.hidden = !table.rows.length || [...table.rows].some(tr => !tr.hidden);
}
/* 擴充、外觀包的清單另開一張（D085），蓋在格式頁、外觀頁上面（都是 id）：page 那張、table、搜尋框 find、搜不到的字 noHit、寫資料夾的 dir；
   manage 是打開它的鈕、closeBtn 是 ✕；load() 讀清單、render(r) 畫；action(b) 是按了一列裡的鈕。點外面只關這張，回到底下那頁。回 { close } */
function packList({ page, table, find, noHit, dir, manage, closeBtn, load, render, action }) {
  const close = () => { $(page).hidden = true; };
  const show = async () => {
    const r = await load();
    $(find).value = '';
    render(r);
    $(dir).textContent = r.dir;
    $(page).hidden = false;
    $(find).focus();
  };
  $(manage).addEventListener('click', () => act(show));
  $(closeBtn).addEventListener('click', close);
  $(find).addEventListener('input', () => filterList($(table), $(find), $(noHit)));
  $(page).addEventListener('click', e => {
    if (e.target === $(page)) return close();   // 點外面只關這張，回到底下那頁
    const b = e.target.closest('.extBtn');
    if (b) return action(b);
    const o = e.target.closest('.openBtn[data-open]');
    if (o) act(() => api.openLocation(o.dataset.open));
  });
  return { close };
}

/* 請 AI 寫（D056）、翻（D131）共用的鈕，p 是 id 的開頭（ai、lang）：p+'Copy' 複製 prompt、p+'Gemini'、p+'Chatgpt' 用瀏覽器開那個網站、
   p+'Reply' 貼回來的（一改就叫 clear，上一次的結果作廢）、p+'Try' 檢查。
   ready()：做得了沒（語言要先填要翻成什麼，沒填它自己提示）；copy()：複製 prompt、提示；empty：沒貼就按檢查的提示；check(reply)：檢查、畫結果 */
function aiFlow({ p, ready = () => true, copy, empty, check, clear }) {
  $(p + 'Copy').addEventListener('click', () => act(async () => {
    if (!ready()) return;
    await copy();
  }));
  $(p + 'Gemini').addEventListener('click', () => act(() => api.aiOpen('gemini')));
  $(p + 'Chatgpt').addEventListener('click', () => act(() => api.aiOpen('chatgpt')));
  $(p + 'Reply').addEventListener('input', () => clear());
  $(p + 'Try').addEventListener('click', () => act(async () => {
    if (!ready()) return;
    if (!$(p + 'Reply').value.trim()) return toast(empty, true);
    await check($(p + 'Reply').value);
  }));
}
/* 結果那塊：清掉（class 也清掉）、照 build 畫（build 自己設 aiOk／aiErr）；build 是 null 就收起來 */
function aiResult(box, build) {
  box.replaceChildren();
  box.className = '';
  if (build) build(box);
  box.hidden = !build;
}
/* 結果裡的鈕（複製給 AI、安裝…），點了用 id 認 */
function aiBtn(id, text) {
  const b = el('button', 'openBtn', text);
  b.id = id;
  b.type = 'button';
  return b;
}
