/* ============================================================
   文件檢視找字（見 開發筆記 D147、D149）：.md（畫面的 #mdView）、.html（iframe 裡，主程序把這份原文塞進去跑）共用同一套。
   - 看得到的字接成一串再找：粗體、連結切開的詞也找得到；區塊（段落、表格的格、清單項目…）、<br> 之間放 SEP（不是空白），不會跨過去
   - 藏起來的（display:none、visibility:hidden）不找；收起來的 <details> 裡的照找，目前那個在裡面就打開（跟 Chrome 一樣）
   - 不分大小寫、照字面；打的空白對得到一段空白（換行、&nbsp;、全形空白）：原始檔在句子中間換行，畫面上只是一個空白
   - 標顏色用 CSS Custom Highlight，不動 DOM
   主程序 require（parser 測 pattern、讀原文塞進 iframe）；畫面用 <script>、iframe 塞原文，都是全域的 daybookFind
   ============================================================ */
(function (root) {
  'use strict';
  const SEP = '\u0001';
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/;
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BODY|CAPTION|CENTER|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|MENU|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

  /* 要找的字 → RegExp：不分大小寫、照字面；打的一段空白對到一段空白（\s 含換行、&nbsp;、全形空白）。整個都是空白就照字面 */
  function pattern(q) {
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(q.trim() ? q.split(/\s+/).map(esc).join('\\s+') : esc(q), 'giu');
  }

  /* 看得到嗎（元素）：checkVisibility；收起來的 <details> 裡的也算（它自己看得到、中間沒有藏起來的）。同一次找字記著算過的 */
  function visibleFn(win) {
    const memo = new Map();
    const shown = el => {
      let v = memo.get(el);
      if (v !== undefined) return v;
      v = el.checkVisibility({ visibilityProperty: true });
      const d = v ? null : el.closest('details:not([open])');
      if (d && d !== el && shown(d)) {
        v = true;
        for (let x = el; x && x !== d; x = x.parentElement) {
          const cs = win.getComputedStyle(x);
          if (cs.display === 'none' || cs.visibility === 'hidden') { v = false; break; }
        }
      }
      memo.set(el, v);
      return v;
    };
    return shown;
  }

  /* el 底下看得到的字接成一串，記每個文字節點從第幾個字開始 */
  function textOf(el) {
    const doc = el.ownerDocument, shown = visibleFn(doc.defaultView);
    const segs = [];
    let text = '', last;
    const w = doc.createTreeWalker(el, 5 /* SHOW_ELEMENT | SHOW_TEXT */, { acceptNode: n => (n.nodeType === 1 && SKIP.test(n.tagName) ? 2 /* REJECT */ : 1) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 1) { if (n.tagName === 'BR') text += SEP; continue; }
      const p = n.parentElement;
      if (!n.data || !p || !shown(p)) continue;
      let b = p;
      while (b !== el && !BLOCK.test(b.tagName)) b = b.parentElement;
      if (b !== last) { text += SEP; last = b; }
      segs.push([text.length, n]);
      text += n.data;
    }
    return { text, segs };
  }

  /* el 底下找 q：每個找到的是一個 Range */
  function find(el, q) {
    if (!q) return [];
    const { text, segs } = textOf(el);
    // 第 i 個字在哪個節點的第幾個：起點找開頭 ≤ i 的最後一段，終點找開頭 < i 的最後一段（落在前一段的尾巴，不是下一段的頭）
    const at = (i, end) => {
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (end ? segs[m][0] < i : segs[m][0] <= i) lo = m; else hi = m - 1; }
      return [segs[lo][1], i - segs[lo][0]];
    };
    return [...text.matchAll(pattern(q))].map(m => {
      const r = el.ownerDocument.createRange();
      r.setStart(...at(m.index, false));
      r.setEnd(...at(m.index + m[0].length, true));
      return r;
    });
  }

  /* 一個找字的狀態：在 el 底下找，scroller 是捲的那塊（.md 是 #mdView，.html 是整頁），names 是標顏色用的兩個 highlight（全部、目前那個） */
  function finder(el, scroller, names) {
    const doc = el.ownerDocument, win = doc.defaultView;
    const st = { hits: [], at: -1 };
    const res = () => ({ n: st.hits.length, at: st.at });
    const view = () => (scroller === doc.scrollingElement ? { top: 0, bottom: win.innerHeight } : scroller.getBoundingClientRect());
    function paint() {
      const hl = win.CSS.highlights;
      if (!st.hits.length) { hl.delete(names[0]); hl.delete(names[1]); return; }
      hl.set(names[0], new win.Highlight(...st.hits));
      const on = new win.Highlight(st.hits[st.at]);
      on.priority = 1;   // 疊在全部的上面
      hl.set(names[1], on);
    }
    /* 目前那個：在收起來的 <details> 裡就打開；在畫面外才捲，放在上面三分之一（同記事本 D104）；在自己左右捲的那塊裡（寬的表格、程式碼）左右也捲 */
    function show() {
      const r = st.hits[st.at];
      if (!r) return;
      for (let d = r.startContainer.parentElement.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) d.open = true;
      const vb = view();
      let b = r.getBoundingClientRect();
      if (b.top < vb.top || b.bottom > vb.bottom) { scroller.scrollTop += b.top - vb.top - scroller.clientHeight / 3; b = r.getBoundingClientRect(); }
      for (let x = r.startContainer.parentElement; x && x !== el && x !== scroller; x = x.parentElement) {
        if (x.scrollWidth > x.clientWidth && /auto|scroll/.test(win.getComputedStyle(x).overflowX)) {
          const xb = x.getBoundingClientRect();
          if (b.left < xb.left || b.right > xb.right) x.scrollLeft += b.left - xb.left - x.clientWidth / 3;
          break;
        }
      }
    }
    return {
      // 找 q，從 start（Range）的起點以後第一個開始；沒有就從畫面上看得到的第一個
      run(q, start) {
        st.hits = find(el, q);
        const top = view().top;
        const i = st.hits.findIndex(r => (start ? r.compareBoundaryPoints(win.Range.START_TO_START, start) >= 0 : r.getBoundingClientRect().bottom > top));
        st.at = st.hits.length ? (i < 0 ? 0 : i) : -1;
        paint();
        show();
        return res();
      },
      step(d) {
        const n = st.hits.length;
        if (n) { st.at = (st.at + d + n) % n; paint(); show(); }
        return res();
      },
      // F3／Shift+F3 框關著時（D150，照 VS Code）：找 q，跳到 start（Range：選著的、點過的地方）後面第一個（d < 0：前面最後一個），沒有就繞回來；
      // 沒有 start 就從畫面上看得到的第一個（d < 0：它的前一個）
      jump(q, start, d) {
        st.hits = find(el, q);
        const n = st.hits.length;
        let i;
        if (start) {
          i = d > 0 ? st.hits.findIndex(r => r.compareBoundaryPoints(win.Range.END_TO_START, start) >= 0)   // 它的開頭在 start 的結尾以後
            : st.hits.findLastIndex(r => r.compareBoundaryPoints(win.Range.START_TO_END, start) <= 0);     // 它的結尾在 start 的開頭以前
        } else {
          const top = view().top;
          i = st.hits.findIndex(r => r.getBoundingClientRect().bottom > top);
          if (d < 0) i = (i < 0 ? n : i) - 1;
        }
        st.at = n ? (i < 0 ? (d > 0 ? 0 : n - 1) : i) : -1;
        paint();
        show();
        return res();
      },
      // 內容換了重找，目前那個的順序不變（超過就最後一個）；at 不給就照原本的
      refresh(q, at) {
        if (at !== undefined) st.at = at;
        st.hits = find(el, q);
        st.at = st.hits.length ? Math.min(Math.max(st.at, 0), st.hits.length - 1) : -1;
        paint();
        return res();
      },
      // 收起來：顏色拿掉，回目前那個（叫的人拿去選著）
      close() {
        const r = st.hits[st.at] || null;
        st.hits = [];
        st.at = -1;
        paint();
        return r;
      },
      current: () => st.hits[st.at] || null,
    };
  }

  /* .html 的 iframe 裡（主程序把這份原文塞進去後叫，D149）：一頁一個 finder，顏色自己加一段 <style>（iframe 一律白底，用淺色那組，同 style.css 的 --find-*）。
     op：open（選著一段字就拿來找、從它開始）、run（打字：從目前那個開始）、step、refresh（重新載入後：照原本的順序）、close（選著目前那個）、
     jump（F3 框關著，D150：用畫面傳來的上次的字，沒有才拿選著的字，從選著的地方往後；都沒有回 q 空的，畫面改成跟 Ctrl+F 一樣） */
  let page = null;
  function pageOp(op, a) {
    const doc = root.document;
    if (op === 'close' && !page) return null;
    if (!page) {
      const s = doc.createElement('style');
      s.textContent = '::highlight(daybook-find){background-color:rgba(234,92,0,.33)}::highlight(daybook-find-on){background-color:#a8ac94}';
      (doc.head || doc.documentElement).append(s);
      page = finder(doc.body, doc.scrollingElement || doc.documentElement, ['daybook-find', 'daybook-find-on']);
    }
    const s = root.getSelection();
    const r = s.rangeCount && doc.body.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
    const t = r ? s.toString() : '';
    const sel = t && !t.includes('\n') ? t : '';   // 選著的字（不跨行）
    if (op === 'open') {
      const q = sel || String(a.q || '');
      return { q, ...page.run(q, r || page.current()) };
    }
    if (op === 'jump') {
      const q = String(a.q || '') || sel;
      return q ? { q, ...page.jump(q, r, a.d) } : { q: '', n: 0, at: -1 };
    }
    if (op === 'run') return page.run(String(a.q || ''), page.current());
    if (op === 'step') return page.step(a.d);
    if (op === 'refresh') return page.refresh(String(a.q || ''), a.at);
    const cur = page.close();
    if (cur) { s.removeAllRanges(); s.addRange(cur); }
    return null;
  }

  const api = { SEP, pattern, textOf, find, finder, pageOp };
  if (typeof module !== 'undefined' && module.exports && !root.document) module.exports = api;
  else root.daybookFind = api;
})(typeof window !== 'undefined' ? window : globalThis);
