/* ============================================================
   去背（見 開發筆記 D066）：「外觀」頁「用圖檔做一個」勾「去掉邊緣連著的底色」時用。
   把跟圖的邊緣連在一起、顏色跟底色差不多的地方變透明——白底、單色底的插畫、角色圖去得乾淨，背景複雜的照片去不乾淨。
   - 底色：邊緣一圈最多的那一格顏色（R、G、B 各取到 16 階再數）裡、最多的那個顏色；本來就透明的不算
   - 從邊緣往裡面擴散：每個顏色（R、G、B）跟底色最多差 tol（0～255）的算底色，變透明；本來就透明的也走得過去
   - 挨著底色、差一點點（tol～2×tol）的變半透明，邊才不會留一圈白邊
   純函式、不碰 DOM：img 是 { data, width, height }（canvas 的 ImageData），直接改 data，回傳同一個 img。
   畫面用 <script> 載入（全域的 cutout）；測試用 require
   ============================================================ */
'use strict';

function cutout(img, tol) {
  const { data, width: w, height: h } = img;
  if (!w || !h) return img;
  const edge = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
  // 底色：邊緣最多的那一格顏色（16 階一格，jpg 的雜點才不會分散），格子裡最多的那個顏色
  const bins = new Map();
  for (const p of edge) {
    const i = p * 4;
    if (data[i + 3] < 128) continue;
    const k = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | data[i + 2] >> 4;
    const c = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
    const b = bins.get(k) || { n: 0, colors: new Map() };
    b.n++;
    b.colors.set(c, (b.colors.get(c) || 0) + 1);
    bins.set(k, b);
  }
  if (!bins.size) return img;   // 邊緣本來就都是透明的
  let top = null;
  for (const b of bins.values()) if (!top || b.n > top.n) top = b;
  let ref = -1, most = 0;
  for (const [c, n] of top.colors) if (n > most) { ref = c; most = n; }
  const R = ref >> 16, G = ref >> 8 & 255, B = ref & 255;
  const diff = p => Math.max(Math.abs(data[p * 4] - R), Math.abs(data[p * 4 + 1] - G), Math.abs(data[p * 4 + 2] - B));
  const clear = p => data[p * 4 + 3] < 128 || diff(p) <= tol;   // 算底色（走得過去）
  // 從邊緣往裡擴散
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const visit = q => {
    if (seen[q]) return;
    if (clear(q)) { seen[q] = 1; queue[tail++] = q; return; }
    // 挨著底色、差一點點：照差多少變半透明。標成看過，變半透明之後才不會被當成底色、從這裡穿進去
    const d = diff(q);
    if (tol > 0 && d < 2 * tol) {
      seen[q] = 1;
      data[q * 4 + 3] = Math.min(data[q * 4 + 3], Math.round(255 * (d - tol) / tol));
    }
  };
  for (const p of edge) visit(p);
  while (head < tail) {
    const p = queue[head++];
    data[p * 4 + 3] = 0;
    const x = p % w;
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p + w < w * h) visit(p + w);
  }
  return img;
}

if (typeof module === 'object' && module.exports) module.exports = { cutout };
