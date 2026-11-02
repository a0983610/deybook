/* ============================================================
   介面文字換語言（見 開發筆記 D131）。程式裡寫的是繁體中文原文，L('原文') 查目前語言的翻譯，沒有就照原文。
   - 原文就是 key（不另外編代號）：程式照樣 grep 得到畫面上的字；改了原文，語言檔那條就變成「缺的」，照中文顯示，可以再請 AI 補翻
   - {名稱}：L('已隱藏 {n} 筆', { n }) 把 {n} 換成值；翻譯要留著一樣的 {…}（順序可以換）。params 沒給的 {…} 照原樣留著
   - LK('原文')：只標記「這是要翻的字」（tools/i18n-keys.cjs 收得到），回原文；先存在表裡、顯示時才 L(x) 的用它
   - 畫面（index.html、capture.html）的固定文字不用改 HTML：載入時 translateDom 一個一個文字節點、title／placeholder／aria-label／alt 查表換掉；
     code、kbd、pre、textarea、script、style、translate="no" 裡面的不換
   主程序、shared、測試用 require（字典由主程序 setDict）；畫面用 <script> 載入（全域的 L、LK），字典向 preload 同步拿（i18n()）
   ============================================================ */
(function (root) {
  'use strict';
  let dict = null;

  /* 要不要翻：有中文字或全形標點的才算（純英數、符號的 Ctrl+F、daybook 不用翻） */
  const NEEDS = /[　-〿㐀-鿿豈-﫿＀-￯]/;
  /* HTML 文字節點的 key：空白（含換行、縮排）縮成一個、去頭尾 */
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const SKIP = 'script, style, code, kbd, pre, textarea, [translate="no"]';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  const fill = (s, p) => (p ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(p, k) ? String(p[k]) : m)) : s);
  const lookup = src => (dict && typeof dict[src] === 'string' && dict[src] !== '' ? dict[src] : src);
  const L = (src, params) => fill(String(lookup(String(src))), params);
  const LK = s => s;
  function setDict(d) { dict = d && typeof d === 'object' ? d : null; }
  /* 串名單：兩兩用 '{a}、{b}'、'{a}和{b}' 接（英文翻成 '{a}, {b}'、'{a} and {b}'）。
     不把「、」單獨當 key：檢查 AI 回的會去掉頭尾的空白，', ' 會變成 ','，所以連接的字跟兩邊一起翻 */
  const joinList = arr => (arr.length ? arr.reduce((a, b) => L('{a}、{b}', { a, b })) : '');
  const andList = arr => (arr.length ? arr.reduce((a, b) => L('{a}和{b}', { a, b })) : '');

  /* root 底下每一個要翻的地方：onText(文字節點, key)、onAttr(元素, 屬性名, key)。
     <template> 的內容不在 DOM 樹上（走不到），另外走：app.js 複製出來的就是換好的 */
  function walk(rootEl, onText, onAttr) {
    const doc = rootEl.ownerDocument || rootEl;
    const walker = doc.createTreeWalker(rootEl, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (NEEDS.test(n.nodeValue) && n.parentElement && !n.parentElement.closest(SKIP)) onText(n, norm(n.nodeValue));
    }
    for (const e of rootEl.querySelectorAll(ATTRS.map(a => `[${a}]`).join(','))) {
      if (e.closest('[translate="no"]')) continue;
      for (const a of ATTRS) {
        const v = e.getAttribute(a);
        if (v && NEEDS.test(v)) onAttr(e, a, norm(v));
      }
    }
    for (const tpl of rootEl.querySelectorAll('template')) walk(tpl.content, onText, onAttr);
  }

  /* 換掉 root 底下的固定文字。沒有字典（繁體中文）就不動 */
  function translateDom(rootEl) {
    if (!dict) return;
    walk(rootEl, (n, key) => {
      const tr = lookup(key);
      if (tr !== key) n.nodeValue = /^\s*/.exec(n.nodeValue)[0] + tr + /\s*$/.exec(n.nodeValue)[0];   // 頭尾的空白照原本的（跟旁邊的元素隔開）
    }, (e, a, key) => {
      const tr = lookup(key);
      if (tr !== key) e.setAttribute(a, tr);
    });
  }

  /* root 底下要翻的字（不重複，照找到的順序）：e2e 拿來跟 tools/i18n-keys.cjs 切 HTML 的結果比，兩邊要一樣 */
  function domKeys(rootEl) {
    const out = new Set();
    walk(rootEl, (n, key) => out.add(key), (e, a, key) => out.add(key));
    return [...out];
  }

  const api = { L, LK, joinList, andList, setDict, translateDom, domKeys, fill, norm, NEEDS, SKIP, ATTRS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    // 畫面：字典向 preload 拿（主視窗是 window.daybook，截圖那層是 window.shot），html 的 lang 換成語言的代碼，固定文字馬上換掉
    const bridge = root.daybook || root.shot;
    const got = bridge && bridge.i18n ? bridge.i18n() : null;
    setDict(got && got.dict);
    if (got && got.lang) root.document.documentElement.lang = got.lang;
    root.L = L;
    root.LK = LK;
    root.joinList = joinList;
    root.i18n = api;   // e2e 用 domKeys
    translateDom(root.document.documentElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
