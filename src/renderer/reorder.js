/* ============================================================
   剪貼簿、常用的卡片清單共用（見 開發筆記 D183）：拖拉、Alt+↑↓ 調順序（D125），「＋ 新增」的表單開在最後面、捲到底（D126）。
   卡片長什麼樣、存到哪、編輯表單的欄位和按鍵留在 app.js。叫的時候才用到 app.js 的 act、toast、el、listBusyStop。
   畫面用 <script> 載入，排在 app.js 前面（全域的 makeReorder）
   ============================================================ */
'use strict';

/* 一個調得了順序的卡片清單，回 { hook(box, handle, x), add(before, where) }：
   list：清單的 id；card：卡片的 class；handle：卡片上按得到的那顆的 class（Alt+↑↓ 按在它上面、鍵盤搬完游標回它）
   busy()：有一張在編輯（含新增）——不給搬，提示 busyMsg（搬完要重畫，打到一半的會被洗掉，D125）
   save(x, to)：把 x（清單給的那一筆，帶 index）存成第 to 筆；refresh()：重畫清單
   files：從外面拖檔案進來（常用）{ over(e), leave(), drop(e) }；清單裡正在搬的時候不算
   edit(box, where)：「＋ 新增」在 box 裡開表單（where 是 add 給的，原樣傳過來）
   清單裡夾著分類那行時（剪貼簿，D195）多給三個，不給就是只有卡片、to 是第幾筆：
   head：分類那行的 class（不能拖，但算位置：放開、Alt+↑↓ 可以越過它）
   target(x, at, els)：x 放在 els[at] 前面（at 是 els.length 就是最後面）要存成的 to，搬回原地回 null
   focus(to)：鍵盤搬完，游標回哪一顆
   hook：每張卡片畫好時叫，整張拖得動、handle 上 Alt+↑↓ 搬一格；add：「＋ 新增」，表單開在 before 前面（沒給就是最後面） */
function makeReorder({ list, card, handle, busy, busyMsg, save, refresh, files, edit, head, target, focus }) {
  const ul = document.getElementById(list);
  let drag = null;   // 拖著的那一筆
  const els = () => [...ul.querySelectorAll(head ? `:scope > .${card}, :scope > .${head}` : `:scope > .${card}`)];
  // 只有卡片：插在第 at 張前面，搬完以後是第 to 筆
  const toOf = target || ((x, at) => { const to = at > x.index ? at - 1 : at; return to === x.index ? null : to; });
  const focusOf = focus || (to => ul.querySelectorAll(`:scope > .${card} .${handle}`)[to]?.focus());
  const move = (x, to, keys) => act(async () => {
    await save(x, to);
    await refresh();
    if (keys) focusOf(to);   // 鍵盤搬的游標跟著那張，接著按得到
  });
  /* 放開會插在哪：滑鼠下面有幾張卡片（和分類那行）的中線在它上面，就插在第幾張前面（卡片中間的空隙、最下面的空白也算得出來）；
     to 是搬完以後在哪，搬回原地的不算（不畫線、放開也不動） */
  function dropAt(e) {
    if (!drag) return null;
    const cards = els();
    const at = cards.filter(c => { const r = c.getBoundingClientRect(); return r.top + r.height / 2 < e.clientY; }).length;
    const to = toOf(drag, at, cards);
    return to == null ? null : { at, to, cards };
  }
  // 插進去的位置畫一條線：插在第 at 張前面就畫在它上緣，插在最後面就畫在最後一張下緣
  function dropMark(d) {
    for (const c of ul.querySelectorAll('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after');
    if (!d) return;
    if (d.at < d.cards.length) d.cards[d.at].classList.add('drop-before');
    else d.cards[d.at - 1].classList.add('drop-after');
  }
  const isFiles = e => !!files && !drag && [...e.dataTransfer.types].includes('Files');   // 從外面拖檔案進來（不是在清單裡搬）
  ul.addEventListener('dragover', e => {
    if (isFiles(e)) { files.over(e); return; }
    const d = dropAt(e);
    dropMark(d);
    if (!d) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  ul.addEventListener('dragleave', e => {
    if (ul.contains(e.relatedTarget)) return;
    dropMark(null);
    files?.leave();
  });
  ul.addEventListener('dragend', () => { drag = null; dropMark(null); });
  ul.addEventListener('drop', e => {
    files?.leave();
    if (isFiles(e)) { files.drop(e); return; }
    const d = dropAt(e), x = drag;
    drag = null;
    dropMark(null);
    if (!d) return;
    e.preventDefault();
    move(x, d.to, false);
  });
  return {
    hook(box, h, x) {
      box.draggable = true;
      box.addEventListener('dragstart', e => {
        if (busy()) { e.preventDefault(); toast(busyMsg, true); return; }
        drag = x;
        e.dataTransfer.effectAllowed = 'move';
      });
      // 上：放在上一個前面；下：放在下一個後面（＝再下一個前面）。上一個、下一個是分類那行就是越過它、換到隔壁那段（D195）。碰到頂、底就不動
      h.addEventListener('keydown', e => {
        if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const all = els(), i = all.indexOf(box);
        const at = e.key === 'ArrowUp' ? i - 1 : i + 2;
        if (i < 0 || at < 0 || at > all.length) return;
        if (busy()) { toast(busyMsg, true); return; }
        const to = toOf(x, at, all);
        if (to != null) move(x, to, true);
      });
    },
    add(before, where) {
      const open = ul.querySelector(`.${card}[data-new]`);
      if (open) { open.querySelector('input').focus(); return; }   // 已經開著一張新的
      if (listBusyStop(list)) return;   // 別張在編輯（D174）
      const box = el('div');
      box.dataset.new = '';
      ul.querySelector(':scope > .empty')?.remove();
      ul.insertBefore(box, before || null);   // 新的放最後面（D126；有分類時是那一段的最後面，D195）：表單開在存了以後的位置
      edit(box, where);
      // 看得到整張：游標進第一格時只把那格捲到中間，左欄矮時儲存鈕會被切掉。最後一張就捲到底；在中間（D195）就捲到下緣露出來
      if (!before) { ul.scrollTop = ul.scrollHeight; return; }
      const over = box.getBoundingClientRect().bottom - ul.getBoundingClientRect().bottom;
      if (over > 0) ul.scrollTop += over;
    },
  };
}
