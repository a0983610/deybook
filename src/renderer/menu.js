/* ============================================================
   選單共用（見 開發筆記 D182）：設定、記事清單、頁籤、文件檢視清單、排序、常用、截圖 7 個選單的
   開、收、點外面收、點了一項就收、Esc 收了游標回哪、鍵盤叫出來時擺哪；Esc 一次收一層（選單、對話框）。
   每個選單自己的項目（藏哪些、淡色、打勾）、按的那行框起來、點了做什麼留在 app.js。
   畫面用 <script> 載入，排在 app.js 前面（全域的 placeMenu、menuXY、makeMenu、escLayers）
   ============================================================ */
'use strict';

/* 右鍵選單擺在按的地方，超出視窗就往左、往上；游標放在看得到的第一項（D117、D120、D121） */
function placeMenu(m, x, y) {
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(0, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(0, Math.min(y, innerHeight - r.height - 4)) + 'px';
  [...m.querySelectorAll('button')].find(b => b.offsetParent)?.focus();
}

/* contextmenu 的座標；鍵盤（選單鍵、Shift+F10）叫出來的沒有座標：放在 el（那一行、那一張、那個頁籤）底下 */
function menuXY(e, el) {
  let { clientX: x, clientY: y } = e;
  if (!x && !y && el) { const r = el.getBoundingClientRect(); x = r.left + 16; y = r.bottom; }
  return [x, y];
}

/* 一個選單（id 是 index.html 裡那個 role="menu"），回 { on, open(...), close(), esc() }：
   show(m, ...)：打開時設定項目、擺位置（open 帶的參數照傳）
   hide()：收起來時要做的（拿掉按的那行的框、aria-expanded）；打開前也先做一次，把上次的清掉
   back()：Esc 收起來之後游標回哪；不給就不動（設定的選單，D092）
   keep：點在這些上面不算外面（排序鈕、齒輪：它們自己開關選單）
   pick(act, b)：點了選單裡的一項（那顆鈕的 data-act、那顆鈕）；一律先收起來再叫 */
function makeMenu(id, { show, hide, back, keep, pick }) {
  const m = document.getElementById(id), inside = keep ? `#${id}, ${keep}` : `#${id}`;
  const me = {
    get on() { return !m.hidden; },
    open(...a) { m.hidden = false; hide?.(); show(m, ...a); },
    close() { m.hidden = true; hide?.(); },
    esc() { me.close(); back?.(); },
  };
  m.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    me.close();
    pick?.(b.dataset.act, b);
  });
  document.addEventListener('mousedown', e => { if (!m.hidden && !e.target.closest(inside)) me.close(); });
  return me;
}

/* Esc 一次收一層：layers 照先收的排，每一層是一個選單（makeMenu 回的），或 [對話框的 id…, 關掉的函式]（同一層的一起關）。
   在 capture 階段先攔下來，搜尋框的 Esc（清掉搜尋字）才不會一起跑；都沒開著就不攔 */
function escLayers(layers) {
  const on = x => (Array.isArray(x) ? x[0].some(id => !document.getElementById(id).hidden) : x.on);
  document.addEventListener('keydown', e => {
    const top = e.key === 'Escape' && layers.find(on);
    if (!top) return;
    e.preventDefault();
    e.stopPropagation();
    if (Array.isArray(top)) top[1](); else top.esc();
  }, true);
}
