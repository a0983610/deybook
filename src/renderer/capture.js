/* ============================================================
   截圖蓋的那層（見 開發筆記 D129）：一個螢幕一層。底下是按下去那一刻的畫面（停住）。
   拉框選範圍 → 框旁邊出現工具列：框、箭頭、直線（D130）、復原、取消、完成。框好之後在框裡拉是畫，框外拉是重新框。
   用哪個工具記在這台電腦（localStorage，跟主視窗同一個來源；D130），下次打開照上次的。
   完成（Enter）：框裡那塊連畫上去的組成 png 交給主程序（存成下一號、複製）。Esc 任何時候都是不截了。
   座標都用 CSS px（這層不跟主視窗的縮放，e2e E90 量過）；組圖時照畫面實際像素和 CSS px 的比例換算，高 DPI 的螢幕截出來也是實際像素
   ============================================================ */
'use strict';
const api = window.shot;
const $ = id => document.getElementById(id);
const COLOR = '#e53935';   // 框、箭頭的顏色（紅）
const LINE = 3;            // 線寬（CSS px）
const MIN = 3;             // 比這個小的框、線當作只是點一下

const bg = $('bg');
let frame = null;          // { width, height }：這個螢幕的實際像素
let state = 'idle';        // idle 還沒框｜selecting 拉框中｜edit 框好了｜drawing 畫框、箭頭中｜saving 送出去了
let sel = null;            // 框的範圍 { x, y, w, h }（CSS px）
let anchor = null;         // 拉框的起點
let shapes = [];           // 畫上去的 [{ type: 'rect'|'arrow'|'line', x1, y1, x2, y2 }]，相對於框的左上角
const TOOLS = { rect: 'tRect', arrow: 'tArrow', line: 'tLine' };   // 工具 → 按鈕
let tool = 'rect';

/* 主程序給的是 BGRA（toBitmap），轉成 RGBA 畫上去；一律不透明 */
async function init() {
  const f = await api.frame();
  if (!f) return api.cancel();
  const { width, height } = f;
  const src = f.data, px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = src[i + 2];
    px[i + 1] = src[i + 1];
    px[i + 2] = src[i];
    px[i + 3] = 255;
  }
  bg.width = width;
  bg.height = height;
  bg.getContext('2d').putImageData(new ImageData(px, width, height), 0, 0);
  frame = { width, height };
  api.ready();
}

const ratio = () => ({ x: frame.width / innerWidth, y: frame.height / innerHeight });
const pt = e => ({ x: Math.max(0, Math.min(innerWidth, e.clientX)), y: Math.max(0, Math.min(innerHeight, e.clientY)) });
const inSel = p => sel && p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h;

function drawShapes(g, list) {
  g.strokeStyle = COLOR;
  g.fillStyle = COLOR;
  g.lineWidth = LINE;
  g.lineCap = 'round';
  for (const s of list) {
    if (s.type === 'rect') {
      g.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
      continue;
    }
    if (s.type === 'line') {   // 直線（D130）：兩端圓頭，沒有箭頭
      g.beginPath();
      g.moveTo(s.x1, s.y1);
      g.lineTo(s.x2, s.y2);
      g.stroke();
      continue;
    }
    // 箭頭：線畫到箭頭底部（不從尖端凸出去），尖端一個實心三角形
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = Math.min(16, Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * 0.6);
    g.beginPath();
    g.moveTo(s.x1, s.y1);
    g.lineTo(s.x2 - Math.cos(a) * head * 0.8, s.y2 - Math.sin(a) * head * 0.8);
    g.stroke();
    g.beginPath();
    g.moveTo(s.x2, s.y2);
    g.lineTo(s.x2 - head * Math.cos(a - Math.PI / 7), s.y2 - head * Math.sin(a - Math.PI / 7));
    g.lineTo(s.x2 - head * Math.cos(a + Math.PI / 7), s.y2 - head * Math.sin(a + Math.PI / 7));
    g.closePath();
    g.fill();
  }
}

/* 工具列：框的下面靠右；下面放不下放上面；上下都放不下放在框裡面右下角 */
function placeTools() {
  const t = $('tools'), w = t.offsetWidth, h = t.offsetHeight;
  let top = sel.y + sel.h + 6;
  if (top + h > innerHeight) top = sel.y - h - 6;
  if (top < 0) top = sel.y + sel.h - h - 6;
  t.style.left = Math.max(0, Math.min(innerWidth - w, sel.x + sel.w - w)) + 'px';
  t.style.top = Math.max(0, top) + 'px';
}

function render() {
  const editing = state === 'edit' || state === 'drawing';
  $('dim').hidden = !!sel;
  $('hint').hidden = state !== 'idle';
  $('sel').hidden = $('size').hidden = !sel;
  $('tools').hidden = !(sel && editing);
  if (!sel) return;
  Object.assign($('sel').style, { left: sel.x + 'px', top: sel.y + 'px', width: sel.w + 'px', height: sel.h + 'px' });
  const r = ratio();
  $('size').textContent = `${Math.round(sel.w * r.x)} × ${Math.round(sel.h * r.y)}`;   // 存出去的實際像素
  $('size').style.left = sel.x + 'px';
  $('size').style.top = (sel.y >= 24 ? sel.y - 22 : sel.y + 2) + 'px';
  const ink = $('ink'), d = devicePixelRatio || 1;
  ink.width = Math.max(1, Math.round(sel.w * d));
  ink.height = Math.max(1, Math.round(sel.h * d));
  const g = ink.getContext('2d');
  g.scale(d, d);
  drawShapes(g, shapes);
  if (editing) placeTools();
}

addEventListener('pointerdown', e => {
  if (e.button !== 0 || !frame || state === 'saving' || e.target.closest('#tools')) return;
  const p = pt(e);
  document.body.setPointerCapture(e.pointerId);   // 拉到視窗外面也收得到
  if (state === 'edit' && inSel(p)) {
    shapes.push({ type: tool, x1: p.x - sel.x, y1: p.y - sel.y, x2: p.x - sel.x, y2: p.y - sel.y });
    state = 'drawing';
  } else {
    api.claim();
    anchor = p;
    sel = null;
    shapes = [];
    state = 'selecting';
  }
  render();
});
addEventListener('pointermove', e => {
  const p = pt(e);
  if (state === 'selecting') {
    sel = { x: Math.min(anchor.x, p.x), y: Math.min(anchor.y, p.y), w: Math.abs(p.x - anchor.x), h: Math.abs(p.y - anchor.y) };
    render();
  } else if (state === 'drawing') {
    const s = shapes[shapes.length - 1];
    s.x2 = Math.max(0, Math.min(sel.w, p.x - sel.x));
    s.y2 = Math.max(0, Math.min(sel.h, p.y - sel.y));
    render();
  }
});
addEventListener('pointerup', () => {
  if (state === 'selecting') {
    if (!sel || sel.w < MIN || sel.h < MIN) { sel = null; state = 'idle'; } else state = 'edit';
  } else if (state === 'drawing') {
    const s = shapes[shapes.length - 1];
    if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < MIN) shapes.pop();
    state = 'edit';
  } else return;
  render();
});

function undo() {
  if (state !== 'edit' || !shapes.length) return;
  shapes.pop();
  render();
}
/* 完成：從停住的畫面切出框的那塊（實際像素），畫上框、箭頭，組成 png 送回主程序 */
async function done() {
  if (!sel || state !== 'edit') return;
  state = 'saving';
  const r = ratio();
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sel.w * r.x));
  c.height = Math.max(1, Math.round(sel.h * r.y));
  const g = c.getContext('2d');
  g.drawImage(bg, Math.round(sel.x * r.x), Math.round(sel.y * r.y), c.width, c.height, 0, 0, c.width, c.height);
  g.scale(r.x, r.y);
  drawShapes(g, shapes);
  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  api.done(new Uint8Array(await blob.arrayBuffer()));
}

/* 換工具：按鈕亮起來、記在這台電腦（D130）；記不住就算了 */
const setTool = t => {
  tool = t;
  for (const [k, id] of Object.entries(TOOLS)) $(id).classList.toggle('on', k === t);
  try { localStorage.setItem('daybook.shotTool', t); } catch { /* 記不住就算了 */ }
};
$('tools').addEventListener('mousedown', e => e.preventDefault());   // 點工具列不把焦點搶到按鈕上：Enter 才不會又按到那顆
for (const [k, id] of Object.entries(TOOLS)) $(id).addEventListener('click', () => setTool(k));
// 打開時照上次用的（沒記過、記的不認得就是框）
try { const t = localStorage.getItem('daybook.shotTool'); if (TOOLS[t]) tool = t; } catch { /* 讀不到就是框 */ }
for (const [k, id] of Object.entries(TOOLS)) $(id).classList.toggle('on', k === tool);
$('tUndo').addEventListener('click', undo);
$('tCancel').addEventListener('click', () => api.cancel());
$('tDone').addEventListener('click', done);
addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); api.cancel(); }
  else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); done(); }
  else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
});
// 別的螢幕開始拉框了：這層的框拿掉
api.onReset(() => {
  if (state === 'saving') return;
  sel = null;
  shapes = [];
  state = 'idle';
  render();
});

render();
init();
