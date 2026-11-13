/* ============================================================
   e2e：開真的 Electron app 操作，再回頭讀磁碟驗（案例表見 e2e測試.md〈e2e 層〉）
   跑法：node tests/e2e.cjs          安靜跑（commit 前用）：視窗在螢幕外、不搶焦點、不上工作列
         node tests/e2e.cjs --full   完整跑：真的開出視窗，E26 真的叫到前面（使用者說要跑才跑，見 開發筆記 D052）
   Playwright 不另外裝，找全域 @playwright/mcp、@playwright/cli 附的（見 開發筆記 D011）。
   自己開 Electron（--remote-debugging-port=0），再用 chromium.connectOverCDP 連進去——
   Playwright 的 _electron.launch 對 Electron 45 會卡住（見 開發筆記 D011〈後續〉）。
   每輪把 tests/fixtures/data 複製到系統暫存區，用 --data-dir 指過去；跑完刪掉。
   案例照順序跑、會沿用前一條留下的資料（例如 E18 搬進 E2 建的今天那個檔）。
   全部通過 exit 0，有失敗 exit 1，測試自己壞掉 exit 2。
   ============================================================ */
'use strict';
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 沒帶就安靜跑：app 都帶 --quiet-window（見 開發筆記 D052）；完整跑帶 --ignore-mouse，視窗真的開出來但不收真的滑鼠，使用者動到滑鼠不會干擾（D080）
const FULL = process.argv.includes('--full');
const { dayPath, TODO_FILE, FLAG_CATS_FILE } = require(path.join(ROOT, 'src/shared/paths.js'));
const srch = require(path.join(ROOT, 'src/shared/search.js'));
const exp = require(path.join(ROOT, 'src/shared/formats/daybook-md.js'));
const fmts = require(path.join(ROOT, 'src/shared/formats/index.js'));   // E31、E57：匯出格式的期望值（見 開發筆記 D078）
const { parseDay } = require(path.join(ROOT, 'src/shared/parser.js'));
const { checkParsed } = require(path.join(ROOT, 'src/shared/import.js'));
const EXAMPLE = path.join(ROOT, 'examples', 'extensions', 'daybook-example-dated');   // E43：範例擴充（見 開發筆記 D055）
const SAMPLE = path.join(__dirname, 'fixtures', 'sample.md');   // E37、E38、E47 匯入用：內建只剩 daybook Markdown（見 開發筆記 D084）
/* 卡片上看得到的東西（見 開發筆記 D046）：E39 匯出再匯回，這些要一模一樣 */
const cardsOf = text => parseDay(text || '').map(e => ({
  heads: e.heads.map(h => h.text), body: e.body.map(b => b.text.replace(/^(\t| {1,4})/, '')), status: e.status, hidden: e.hidden, flagged: e.flagged, flagCat: e.flagCat, event: e.event,
}));

/* 找 playwright：照 block-builders tools/e2e-3d.cjs 的 loadPlaywright 順序 */
function loadPlaywright() {
  const appdata = process.env.APPDATA || '';
  const tries = [
    'playwright',
    path.join(appdata, 'npm/node_modules/@playwright/mcp/node_modules/playwright'),
    path.join(appdata, 'npm/node_modules/@playwright/cli/node_modules/playwright'),
    path.join(appdata, 'npm/node_modules/playwright'),
  ];
  for (const t of tries) { try { return require(t); } catch { /* 換下一個 */ } }
  throw new Error('找不到 playwright（全域 @playwright/mcp 或 @playwright/cli 都沒有）');
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('✗ ' + name + (detail ? '\n    ' + detail : ''));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(50);
  }
}
// app 寫檔一律 \n；fixture 被 git 換成 CRLF 時也要比得起來
const readN = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : null);
const localIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localToday = () => localIso(new Date());
/* 測試用的 png（E49）：w×h，fill(x, y) → [r, g, b, a]。不另外裝套件：zlib 壓、自己算 CRC */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makePng(w, h, fill) {
  const chunk = (type, body) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const out = Buffer.alloc(td.length + 8);
    out.writeUInt32BE(body.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(crc32(td), td.length + 4);
    return out;
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);   // 每一列前面一個 0（不過濾）
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(fill(x, y)).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // 8 bit
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', require('zlib').deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/* 讀 png 的像素（E90 驗截出來的圖）：只認 8 bit、不交錯的 RGB／RGBA（Chromium 存的是這種），五種過濾都解。
   回 { w, h, at(x, y) → [r, g, b] }；畫面的 canvas 讀 shot:// 的圖會被當成跨來源，所以在這裡自己解 */
function readPng(buf) {
  let p = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || body[12] !== 0) throw new Error('png 不是 8 bit、不交錯');
    } else if (t === 'IDAT') idat.push(body);
    p += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[type];
  if (!bpp) throw new Error('png 的顏色類型不認得：' + type);
  const raw = require('zlib').inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + x] = (line[x] + pred) & 0xff;
    }
  }
  return { w, h, at: (x, y) => [...out.subarray((y * w + x) * bpp, (y * w + x) * bpp + 3)] };
}
/* 資料夾快照：相對路徑 → 修改時間；資料夾不在就是 null */
function snapshot(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const out = {};
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, String(f));
    if (fs.statSync(p).isFile()) out[String(f)] = fs.statSync(p).mtimeMs;
  }
  return out;
}
/* 有 --data-dir 時 Chromium 使用者資料放的地方：跟 main.js 同一個算法（見 開發筆記 D016〈後續〉） */
const devProfile = data => path.join(os.tmpdir(),
  'daybook-dev-profile-' + crypto.createHash('md5').update(path.resolve(data).toLowerCase()).digest('hex').slice(0, 8));

/* 資料資料夾裡全部的檔，給 search.js 算期望值用 */
function readSources(data) {
  const out = [];
  const j = path.join(data, 'journal');
  for (const f of fs.readdirSync(j, { recursive: true })) {
    const m = path.basename(String(f)).match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (m) out.push({ src: m[1], text: readN(path.join(j, String(f))) });
  }
  out.push({ src: 'todo', text: readN(path.join(data, TODO_FILE)) || '' });
  return out;
}

/* 匯入、匯出、備份、格式、外觀在左下角齒輪「設定」的小選單裡（見 開發筆記 D092、D098）：先點齒輪再點 sel（#importBtn、#exportBtn、#backupBtn、#fmtBtn、#skinBtn） */
async function viaSettings(page, sel) {
  await page.click('#actSettings');
  await page.click(sel);
}

/* E142：選單鍵、Shift+F10 叫出來的右鍵選單——contextmenu 沒有座標（0, 0）。在 loc 上送一個這樣的 contextmenu，
   回選單左上角相對 loc 左下角的位移（放在那一行、那一張底下是 [16, 0]，見 開發筆記 D182） */
async function keyMenuAt(loc, menu) {
  return loc.evaluate((el, m) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const b = document.getElementById(m).getBoundingClientRect();
    return [Math.round(b.left - r.left), Math.round(b.top - r.bottom)];
  }, menu);
}
/* E142：點外面——在 body 上送一個 mousedown（選單、它的鈕以外的地方），不點到任何東西、不換焦點 */
const outsideDown = page => page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));

/* E9：每個開起來的 daybook 自己說的設定與快取、紀錄資料夾（說明頁那支 filesInfo）。
   不去讀使用者真的 %APPDATA%\daybook、紀錄資料夾，使用者開著 daybook 時跑也不受影響（見 開發筆記 D111） */
const launched = [];

/* 開 Electron，從 stderr 抓 DevTools 位址連進去，拿到主視窗那一頁 */
async function launch(pw, args) {
  const proc = spawn(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, ...args, ...(FULL ? ['--ignore-mouse'] : ['--quiet-window']), '--remote-debugging-port=0'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const url = await new Promise((resolve, reject) => {
    proc.stderr.on('data', b => { err += b; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
    proc.on('exit', c => reject(new Error(`Electron 結束了（exit ${c}）\n${err}`)));
    setTimeout(() => reject(new Error('20 秒內沒等到 DevTools 位址\n' + err)), 20000).unref();
  });
  const browser = await pw.chromium.connectOverCDP(url);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.waitForEvent('page', { timeout: 10000 });
  const close = async () => {
    await browser.close().catch(() => {});
    if (proc.exitCode == null) {
      proc.kill();
      await new Promise(r => proc.once('exit', r));
    }
  };
  // 剛開起來可能還在換頁（evaluate 會被打斷），問到為止；問不到先關掉，不留下程序
  const info = await waitFor(() => page.evaluate(() => window.daybook.filesInfo()).catch(() => null), 10000);
  if (!info) { await close(); throw new Error('10 秒內問不到 filesInfo（E9）'); }
  launched.push({ args: args.join(' '), userData: info.userData && info.userData.path, data: info.data && info.data.path });
  return { page, close, pid: proc.pid, ctx };   // ctx：截圖蓋的那層（另開的視窗，E90）從這裡等
}

/* 叫 Windows PowerShell（5.1）一律走這裡，環境拿掉 PSModulePath（見 開發筆記 D124）：
   從 PowerShell 7 開的終端機，PSModulePath 前面會排上 7 的模組資料夾，5.1 照著找會挑到 7 的模組（Archive 1.2.6）、載不進來；
   拿掉之後 5.1 用自己預設的資料夾。env 是另外要加的環境變數 */
const psEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'));
const powershell = (cmd, env) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { env: { ...psEnv, ...env } });
/* 視窗標題（原生的，CDP 讀到的是網頁 <title>，不一樣）：問 Windows */
const windowTitle = pid => powershell(`(Get-Process -Id ${pid}).MainWindowTitle`).toString().trim();
/* 最前面那個視窗是哪個程序的（E41）：問 Windows */
const foregroundPid = () => Number(powershell(
  'Add-Type -Name W -Namespace U -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); '
  + '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);\'; '
  + '$p = 0; [void][U.W]::GetWindowThreadProcessId([U.W]::GetForegroundWindow(), [ref]$p); $p').toString().trim());

async function run(tmpRoot) {
  const pw = loadPlaywright();
  const data = path.join(tmpRoot, 'data');
  fs.cpSync(path.join(__dirname, 'fixtures', 'data'), data, { recursive: true });
  const exportDir = path.join(tmpRoot, 'export');   // E31：匯出寫到這裡，不跳存檔視窗（見 開發筆記 D035）
  fs.mkdirSync(exportDir);

  let exported = null;   // E31 匯出全部的檔、當時資料夾裡的內容，E39 拿來匯回
  const openLog = path.join(tmpRoot, 'open.log');   // E40：「開啟位置」不真的開檔案總管，路徑寫進這裡（見 開發筆記 D051）
  const clipFile = path.join(tmpRoot, 'clip.txt');   // E65：左欄剪貼簿的複製不寫系統剪貼簿，寫進這裡（見 開發筆記 D093）
  const noteTrash = path.join(tmpRoot, 'note-trash');   // E72、E80、E81：記事清單上刪的不丟使用者的資源回收筒，搬進這裡（見 開發筆記 D102、D116）
  fs.mkdirSync(noteTrash);
  // E82：MD 檢視要釘的兩個資料夾（--pick-md-dir 照順序代替選資料夾的視窗，見 開發筆記 D118）。
  // mdA：一份什麼寫法都有的、一份很長的、子資料夾兩份；node_modules、.git 裡的 .md 不列，只有圖的資料夾不列，不是 .md 的不列
  const mdA = path.join(tmpRoot, 'mdA'), mdB = path.join(tmpRoot, 'mdB');
  const mdLong = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 段。`).join('\n\n');
  for (const [f, text] of [
    ['report.md', '# 週報 <b>粗</b>\n\n| 項目 | 說明 |\n|---|---|\n| 一<br>二 | <script>window.mdBad = 1</script> |\n\n- [x] 做完\n- [ ] 還沒\n\n'
      + '<div class="x">原字</div>\n\n![圖說](a.png)\n\n[網址](https://example.com/x) [說明](子/說明.md#段) [壞的](沒有.md)\n\n```js\nconst a = "<b>";\n```\n'],
    ['long.md', mdLong],
    ['子/說明.md', '# 說明\n\n說明的內文'],
    ['子/README.md', '# A 的 README'],
    ['子/note.txt', '不是 md'],
    ['node_modules/pkg/README.md', '套件的'],
    ['.git/x.md', '版本紀錄的'],
    ['圖/a.png', ''],
  ]) {
    fs.mkdirSync(path.dirname(path.join(mdA, f)), { recursive: true });
    fs.writeFileSync(path.join(mdA, f), text);
  }
  fs.mkdirSync(mdB);
  fs.writeFileSync(path.join(mdB, 'README.md'), '# B 的 README');
  // E85：文件檢視的 .html（見 開發筆記 D122）——自己的 <style>、相對路徑的圖、不該跑的 <script>、各種連結；big5 編碼的一份、另一份 .html
  fs.mkdirSync(path.join(mdB, 'img'));
  fs.writeFileSync(path.join(mdB, 'img', 'pic.png'), makePng(8, 6, () => [0, 128, 255, 255]));
  fs.writeFileSync(path.join(mdB, 'spec.html'), '<!doctype html><html><head><meta charset="utf-8"><style>h1 { color: rgb(255, 0, 0); } .gap { height: 2000px; }</style></head><body>'
    + '<h1>規格標題</h1><img id="pic" src="img/pic.png"><script>document.body.insertAdjacentHTML("beforeend", "<p id=ran>ran</p>")</script>'
    + '<p><a href="https://example.com/h">外面</a> <a href="https://example.com/blank" target="_blank">新視窗</a> <a href="other.html">其他頁</a> '
    + '<a href="../mdA/report.md">跨資料夾</a> <a href="#sec2">跳到第二段</a> <a href="沒有.html">壞的</a></p><div class="gap"></div><h2 id="sec2">第二段</h2></body></html>');
  fs.writeFileSync(path.join(mdB, 'other.html'), '<!doctype html><meta charset="utf-8"><h1>其他頁</h1>');
  fs.writeFileSync(path.join(mdB, 'big5.html'), Buffer.concat([Buffer.from('<!doctype html><meta charset="big5"><p id="t">'), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), Buffer.from('</p>')]));   // 「中文」的 big5
  // --existing 略過：E37 匯入時已經有的日子不跳視窗，當作按了「略過」（見 開發筆記 D063）
  const app = await launch(pw, ['--data-dir', data, '--export-dir', exportDir, '--pick-file', SAMPLE, '--open-log', openLog, '--existing', '略過', '--clipboard-file', clipFile, '--trash-dir', noteTrash,
    '--pick-md-dir', mdA, '--pick-md-dir', mdB]);
  try {
    const win = app.page;
    let dialogs = 0;
    win.on('dialog', d => { dialogs++; d.accept(); });   // 不該跳任何詢問視窗（見 開發筆記 D028），跳了就記下來
    await win.waitForSelector('#dayList button');

    const today = localToday();
    const mmdd = `${today.slice(5, 7)}/${today.slice(8)}`;
    const todayFile = path.join(data, dayPath(today));
    const f0122 = path.join(data, dayPath('2026-01-22'));
    const todoFile = path.join(data, TODO_FILE);
    const doneTitles = () => win.$$eval('#cards .card .title', els => els.map(e => e.textContent));
    const todoTitles = () => win.$$eval('#todoCards .card:not(.is-hidden) .title', els => els.map(e => e.textContent));
    const hiddenTitles = () => win.$$eval('#todoCards .card.is-hidden .title', els => els.map(e => e.textContent));
    const resultSrcs = () => win.$$eval('#results .card', els => els.map(e => e.dataset.src));
    const cardOf = (src, text) => win.locator(`.card[data-src="${src}"]`, { hasText: text }).first();
    const headTitle = () => win.textContent('#dayTitle');
    const editorIs = (sel, want) => waitFor(async () => (await win.inputValue(sel)) === want);
    const addUpdate = async (c, text) => {
      await c.locator('button.upd').click();
      await c.locator('.upd-text').fill(text);
      await c.locator('.upd-text').press('Enter');
    };
    const addNew = async (title, body, button) => {
      await win.fill('#newTitle', title);
      await win.press('#newTitle', 'Enter');
      await win.fill('#newBody', body);
      await win.click(button);
    };

    // E34：視窗標題帶版本號（見 開發筆記 D039）
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    ok('E34 視窗標題是「daybook 版本號」', await waitFor(() => windowTitle(app.pid) === `daybook ${version}`), windowTitle(app.pid));

    // E1
    ok('E1 開起來停在今天',await waitFor(async () => (await headTitle()).includes(today)), '標題：' + (await headTitle()));
    ok('E1 上已處理、下待處理都在', (await win.isVisible('#doneBox')) && (await win.isVisible('#todoBox')) && (await win.isVisible('#newForm')));
    // 匯出列的格式下拉選單（D078）、外觀頁的字型下拉選單（D113）是使用者選的，語言頁的介面語言（D131）跟字型同一類，不算
    ok('E1 畫面上沒有下拉選單（見 開發筆記 D025）', await waitFor(async () => (await win.$$('#todoCards .card')).length > 0) && (await win.$$('select:not(#expFmt, #fontUi, #fontMono, #langSel)')).length === 0);
    // E25：內容少的時候，已處理／待處理不留空白，最後一張卡片底下到區塊底邊不超過 40px（見 開發筆記 D029）
    const gaps = await win.evaluate(() => ['doneBox', 'todoBox'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      const list = document.getElementById(id === 'doneBox' ? 'cards' : 'todoCards');
      return Math.round(box.bottom - list.lastElementChild.getBoundingClientRect().bottom);
    }));
    ok('E25 內容少時不留空白', gaps.every(g => g >= 0 && g < 40), `已處理、待處理底下的空白：${gaps.join('、')}px`);
    const formH = (await win.locator('#newForm').boundingBox()).height;
    ok('E25 空出來的給輸入區', formH > 300, `輸入區高度 ${formH}px`);
    ok('E1 待處理列出 待辦.md 的每一筆', await waitFor(async () => same(await todoTitles(), ['週報', '-MAIL 趙縈問題 APP閃退->請單位交資料', 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期'])),
      JSON.stringify(await todoTitles()));

    // E2：直接記成已處理
    ok('E2 前提：今天原本沒有檔', !fs.existsSync(todayFile));
    await addNew('CWMM3030 備料調撥 BUG', '材料彙總，請將「備料散裝數量」欄位拿掉', '#addDone');
    const want2 = 'CWMM3030 備料調撥 BUG\n\t材料彙總，請將「備料散裝數量」欄位拿掉\n';
    ok('E2 按「＋ 已處理」：寫進今天的檔', await waitFor(() => readN(todayFile) === want2), JSON.stringify(readN(todayFile)));
    ok('E2 卡片出現在上面、表單清空', await waitFor(async () => (await doneTitles()).includes('CWMM3030 備料調撥 BUG') && (await win.inputValue('#newTitle')) === ''));

    // E13：今天的已處理 + 更新
    await addUpdate(cardOf(today, 'CWMM3030 備料調撥 BUG'), '小童說先不改');
    ok('E13 今天的已處理加後續：接在同一筆底下', await waitFor(() => readN(todayFile) === want2 + '\t->小童說先不改\n'), JSON.stringify(readN(todayFile)));

    // E20、E21：快捷鍵——內文按 Ctrl+Enter 加到待處理；標題按 Ctrl+Shift+Enter 直接加到已處理
    const todo0 = readN(todoFile);
    await win.fill('#newTitle', '問小童備料排序');
    await win.press('#newTitle', 'Enter');
    await win.fill('#newBody', '要不要加明細 grid 排序');
    await win.press('#newBody', 'Control+Enter');
    const todo1 = todo0 + '問小童備料排序\n\t要不要加明細 grid 排序\n';
    ok('E20 Ctrl+Enter：加到待處理（寫進 待辦.md）', await waitFor(() => readN(todoFile) === todo1), JSON.stringify(readN(todoFile)));
    ok('E20 卡片出現在下面', await waitFor(async () => (await todoTitles()).includes('問小童備料排序')));
    await win.fill('#newTitle', '查新人程式');
    await win.press('#newTitle', 'Control+Shift+Enter');
    ok('E21 Ctrl+Shift+Enter：加到今天的已處理', await waitFor(() => (readN(todayFile) || '').endsWith('\t->小童說先不改\n查新人程式\n')), JSON.stringify(readN(todayFile)));
    ok('E21 待處理沒有多那筆', readN(todoFile) === todo1, JSON.stringify(readN(todoFile)));

    // E27：標題自動補完（見 開發筆記 D031）——E2 剛記的「CWMM3030 備料調撥」比 09-11 的「備料維護」新，要補它
    const ghostOf = sel => win.$eval(`${sel} + .ghost .rest`, e => e.textContent);
    const focused = () => win.evaluate(() => document.activeElement.id);
    await win.fill('#newTitle', 'cwmm');
    ok('E27 打代號開頭：灰字補上最近用過的「代號＋程式名稱」（剛新增的也算）', await waitFor(async () => (await ghostOf('#newTitle')) === '3030 備料調撥'),
      JSON.stringify(await ghostOf('#newTitle')));
    await win.press('#newTitle', 'Tab');
    ok('E27 Tab 收下：換成原本的寫法、游標還在標題', await waitFor(async () => (await win.inputValue('#newTitle')) === 'CWMM3030 備料調撥') && (await focused()) === 'newTitle',
      `${await win.inputValue('#newTitle')} / ${await focused()}`);
    ok('E27 收下後灰字消失', await waitFor(async () => (await ghostOf('#newTitle')) === ''), JSON.stringify(await ghostOf('#newTitle')));
    await win.fill('#newTitle', '秀屏問題');
    await sleep(200);
    ok('E27 對不上的沒有灰字', (await ghostOf('#newTitle')) === '', JSON.stringify(await ghostOf('#newTitle')));
    await win.press('#newTitle', 'Tab');
    ok('E27 沒有灰字時 Tab 照舊跳到內文、標題不變', (await focused()) === 'newBody' && (await win.inputValue('#newTitle')) === '秀屏問題',
      `${await focused()} / ${await win.inputValue('#newTitle')}`);
    await win.fill('#newTitle', 'CWMM3030 備料維');
    ok('E27 名稱打到一半也補', await waitFor(async () => (await ghostOf('#newTitle')) === '護'), JSON.stringify(await ghostOf('#newTitle')));
    // 只送 keydown：真的按鍵放開時的 keyup 也會重算灰字，會蓋過「新增完要自己清灰字」有沒有做
    await win.dispatchEvent('#newTitle', 'keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    ok('E27 有灰字時直接新增：照打的字記，灰字跟著清掉', await waitFor(() => (readN(todayFile) || '').endsWith('\nCWMM3030 備料維\n'))
      && await waitFor(async () => (await win.inputValue('#newTitle')) === '' && (await ghostOf('#newTitle')) === ''),
      `${JSON.stringify(readN(todayFile))} / 灰字 ${JSON.stringify(await ghostOf('#newTitle'))}`);

    // E42：提示清單（見 開發筆記 D054）——打字就跳出來、↑↓ 選、Tab／按過 ↑↓ 的 Enter 收下、Esc 關、Ctrl+Space 叫出來；內文一行一行補
    // 「CWIN301021 銷退單」開頭的標題有 3 行（01-15、01-22、待辦.md），比今天的 CWMM3030 舊但用得多
    const opts = () => win.$$eval('#suggest:not([hidden]) .opt .txt', es => es.map(e => e.textContent));
    const optOn = () => win.$eval('#suggest .opt.on .txt', e => e.textContent).catch(() => null);
    const listShown = () => win.isVisible('#suggest');
    await win.fill('#newTitle', 'cw');
    ok('E42 打字就跳出清單；用過越多次越前面（不是最近用的）', await waitFor(async () => same((await opts()).slice(0, 2),
      ['CWIN301021 銷退單', 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期'])), JSON.stringify(await opts()));
    ok('E42 灰字預覽選中的那個', (await optOn()) === 'CWIN301021 銷退單' && (await ghostOf('#newTitle')) === 'IN301021 銷退單',
      `${await optOn()} / ${JSON.stringify(await ghostOf('#newTitle'))}`);
    const o1 = await opts();
    await win.press('#newTitle', 'ArrowDown');
    ok('E42 ↓ 選下一個', await waitFor(async () => (await optOn()) === o1[1]), await optOn());
    await win.press('#newTitle', 'ArrowUp');
    await win.press('#newTitle', 'ArrowUp');
    ok('E42 最上面再按 ↑ 跳到最後一個', await waitFor(async () => (await optOn()) === o1[o1.length - 1]), await optOn());
    await win.press('#newTitle', 'Enter');
    ok('E42 按過 ↑↓ 之後 Enter 收下：游標留在標題、清單關掉', await waitFor(async () => (await win.inputValue('#newTitle')) === o1[o1.length - 1])
      && (await focused()) === 'newTitle' && !(await listShown()), `${await win.inputValue('#newTitle')} / ${await focused()}`);
    await win.fill('#newTitle', 'cw');
    await waitFor(listShown);
    await win.press('#newTitle', 'Enter');
    ok('E42 沒按過 ↑↓ 的 Enter 照舊換到內文、標題照打的字', await waitFor(async () => (await focused()) === 'newBody')
      && (await win.inputValue('#newTitle')) === 'cw' && !(await listShown()), `${await focused()} / ${await win.inputValue('#newTitle')}`);
    await win.fill('#newTitle', 'cw');
    await waitFor(listShown);
    await win.press('#newTitle', 'Escape');
    ok('E42 Esc 關掉清單和灰字，字不動', !(await listShown()) && (await ghostOf('#newTitle')) === '' && (await win.inputValue('#newTitle')) === 'cw');
    await win.press('#newTitle', 'Control+Space');
    ok('E42 Ctrl+Space 叫出來', await waitFor(listShown));
    await win.click('#suggest .opt:nth-child(2)');
    ok('E42 點一下收下、游標還在標題', await waitFor(async () => (await win.inputValue('#newTitle')) === o1[1]) && (await focused()) === 'newTitle' && !(await listShown()),
      `${await win.inputValue('#newTitle')} / ${await focused()}`);
    await win.fill('#newTitle', '銷退');
    ok('E42 中間對得上的也列；開頭對不上的沒有灰字', await waitFor(async () => (await opts()).includes('CWIN301021 銷退單')) && (await ghostOf('#newTitle')) === '',
      `${JSON.stringify(await opts())} / ${JSON.stringify(await ghostOf('#newTitle'))}`);
    // 內文：「->雅琪問台應看看」寫在這個標題底下；「->小童說先不改」比較新（今天）但在別的標題底下
    const areaGhost = () => win.$eval('.ghostArea', e => (e.hidden ? '' : e.querySelector('.rest').textContent));
    await win.fill('#newTitle', '雅琦問題：發票作廢後又產生一次作廢的XML');
    await win.fill('#newBody', '第一行\n\t->');
    ok('E42 內文：補游標那一行，同一個標題底下寫過的排前面', await waitFor(async () => same((await opts()).slice(0, 2), ['->雅琪問台應看看', '->小童說先不改'])),
      JSON.stringify(await opts()));
    ok('E42 內文也有灰字', await waitFor(async () => (await areaGhost()) === '雅琪問台應看看'), JSON.stringify(await areaGhost()));
    await win.press('#newBody', 'Tab');
    ok('E42 內文 Tab 收下：只換掉那一行、縮排留著', await waitFor(async () => (await win.inputValue('#newBody')) === '第一行\n\t->雅琪問台應看看') && !(await listShown())
      && (await areaGhost()) === '', JSON.stringify(await win.inputValue('#newBody')));
    await win.fill('#newBody', '->');
    await waitFor(listShown);
    await win.press('#newBody', 'Enter');
    ok('E42 內文沒按過 ↑↓ 的 Enter 照舊換行', await waitFor(async () => (await win.inputValue('#newBody')) === '->\n') && !(await listShown()),
      JSON.stringify(await win.inputValue('#newBody')));
    await win.fill('#newBody', '');
    await win.press('#newBody', 'Tab');
    ok('E42 內文沒有提示時 Tab 照舊縮排', (await win.inputValue('#newBody')) === '\t', JSON.stringify(await win.inputValue('#newBody')));
    await win.fill('#newBody', '');
    await win.fill('#newTitle', '');

    // E17：待處理 + 更新 → 接在底下、帶今天日期
    await addUpdate(cardOf('todo', '問小童備料排序'), '已問，等回覆');
    ok('E17 待處理的進展：接在那筆底下、帶日期', await waitFor(() => readN(todoFile).includes(`問小童備料排序\n\t要不要加明細 grid 排序\n\t->${mmdd} 已問，等回覆\n`)),
      JSON.stringify(readN(todoFile)));

    // E7：待回覆一鍵切換（不用下拉，見 開發筆記 D025）；按鈕緊接在標題後面（D090）
    // 量標題「字」的右邊（Range），不是標題框：框被拉滿的話框跟按鈕之間永遠只差 gap
    const waitGap = await cardOf('todo', '週報').evaluate(c => {
      const r = document.createRange();
      r.selectNodeContents(c.querySelector('.title'));
      return Math.round(c.querySelector('button.wait').getBoundingClientRect().left - r.getBoundingClientRect().right);
    });
    ok('E7 「待回覆」緊接在標題後面（不在最右邊）', waitGap >= 0 && waitGap <= 12, `標題右邊到按鈕 ${waitGap}px`);
    await cardOf('todo', '問小童備料排序').locator('button.wait').click();
    ok('E7 點一下標成待回覆：行尾跟著變', await waitFor(() => readN(todoFile).split('\n').includes('問小童備料排序 [待回覆]')), JSON.stringify(readN(todoFile)));
    ok('E7 按鈕亮起來', await waitFor(async () => /\bon\b/.test(await cardOf('todo', '問小童備料排序').locator('button.wait').getAttribute('class'))));
    await cardOf('todo', '問小童備料排序').locator('button.wait').click();
    ok('E7 再點一下取消：行尾拿掉', await waitFor(() => readN(todoFile).split('\n').includes('問小童備料排序')), JSON.stringify(readN(todoFile)));

    // E8：標題中間有方括號
    const br = 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期';
    const beforeBr = readN(todoFile);
    await cardOf('todo', '折讓證明日期').locator('button.wait').click();
    ok('E8 只動行尾', await waitFor(() => readN(todoFile).split('\n').includes(br + ' [待回覆]')), readN(todoFile));
    ok('E8 標題中間的方括號、其他行都沒變', readN(todoFile).replace(br + ' [待回覆]', br) === beforeBr, readN(todoFile));

    // E18：處理完 → 整筆搬到今天的已處理
    await cardOf('todo', '問小童備料排序').locator('button.done').click();
    ok('E18 處理完：從 待辦.md 拿掉', await waitFor(() => !readN(todoFile).includes('問小童備料排序')), readN(todoFile));
    ok('E18 處理完：整筆（含進展）接在今天的檔最後', await waitFor(() => (readN(todayFile) || '').endsWith(`問小童備料排序\n\t要不要加明細 grid 排序\n\t->${mmdd} 已問，等回覆\n`)),
      JSON.stringify(readN(todayFile)));
    ok('E18 卡片從下面移到上面', await waitFor(async () => (await doneTitles()).includes('問小童備料排序') && !(await todoTitles()).includes('問小童備料排序')));

    // E4：點日期；待處理不分哪一天，一直都在
    await win.click('#dayList button[data-date="2026-01-22"]');
    ok('E4 點日期清單的某一天，上面顯示那天的已處理', await waitFor(async () => same(await doneTitles(), ['CWIN301021 銷退單 BUG', '雅琦問題：發票作廢後又產生一次作廢的XML'])),
      JSON.stringify(await doneTitles()));
    ok('E4 待處理照樣在', (await todoTitles()).includes('週報'), JSON.stringify(await todoTitles()));

    // E3：外部改檔（接在 E4 後面：畫面上已經確定是舊內容）
    fs.appendFileSync(f0122, 'CWIN5890 寄庫批次開帳作業\n\t外部加的\n');
    ok('E3 外部改檔，卡片不用重開就更新', await waitFor(async () => (await doneTitles()).includes('CWIN5890 寄庫批次開帳作業')), JSON.stringify(await doneTitles()));

    // E19：看過去某一天時按處理完 → 搬進那一天
    await cardOf('todo', '趙縈問題').locator('button.done').click();
    ok('E19 處理完搬進正在看的那一天', await waitFor(() => readN(f0122).endsWith('-MAIL 趙縈問題 APP閃退->請單位交資料\n')), JSON.stringify(readN(f0122)));

    // E12：過去的已處理 + 更新 → 今天另記一筆、用 ^1 串起來
    const yq = '雅琦問題：發票作廢後又產生一次作廢的XML';
    await addUpdate(cardOf('2026-01-22', yq), '台應說是排程重送');
    ok('E12 原本那筆加上 ^1', await waitFor(() => readN(f0122).split('\n').includes(yq + ' ^1')), readN(f0122));
    ok('E12 今天另記一筆同編號', await waitFor(() => readN(todayFile).endsWith(yq + ' ^1\n\t->台應說是排程重送\n')), readN(todayFile));

    // E145：接著 E12——01-22 那筆已經有 ^1、沒標記（不會再經過加編號、搬標記那兩步的檢查），+ 更新打字中那筆在外面被改過（打字中外部改檔不重畫，畫面還是舊的）：
    // 提示被改過、兩個檔都不寫（main.js 的 addUpdate 用 entries.js 的 locate 檢查，見 開發筆記 D187）。之後把檔改回來，後面的案例照舊
    const raw0122 = fs.readFileSync(f0122, 'utf8'), todayWas145 = readN(todayFile);
    await cardOf('2026-01-22', yq).locator('button.upd').click();
    await cardOf('2026-01-22', yq).locator('.upd-text').fill('外面改過了');
    const out0122 = raw0122.replace('->雅琪問台應看看', '->雅琪問台應看看（外面改的）');
    fs.writeFileSync(f0122, out0122);
    await sleep(400);   // 監看的通知來過（打字中，中間不重畫）
    await cardOf('2026-01-22', yq).locator('.upd-text').press('Enter');
    ok('E145 過去的已處理 + 更新時那筆在外面被改過：提示、今天的檔和那天的檔都不寫',
      out0122 !== raw0122 && await waitFor(async () => ((await win.textContent('#toast').catch(() => '')) || '').includes('這一筆在別的地方被改過了'))
      && readN(todayFile) === todayWas145 && fs.readFileSync(f0122, 'utf8') === out0122,
      JSON.stringify([await win.textContent('#toast').catch(() => ''), readN(todayFile).slice(-80)]));
    fs.writeFileSync(f0122, raw0122);
    ok('E145 改回來：畫面跟著換回來', await waitFor(async () => {
      const t = await cardOf('2026-01-22', yq).textContent().catch(() => '');
      return t.includes('->雅琪問台應看看') && !t.includes('外面改的');
    }));

    // E15：事件時間軸
    await cardOf('2026-01-22', yq).locator('button.chip.event').click();
    ok('E15 點 ^1 看到這件事每一天的紀錄', await waitFor(async () => same(await resultSrcs(), ['2026-01-22', today])), JSON.stringify(await resultSrcs()));
    ok('E15 標題寫幾筆', (await headTitle()).includes('事件 ^1：2 筆'), await headTitle());
    ok('E15 結果畫面不顯示已處理／待處理', !(await win.isVisible('#doneBox')) && !(await win.isVisible('#todoBox')));

    // E132：前情（見 開發筆記 D171）——接著 E15：今天那筆 ^1 帶 01-22 那筆的內容（淡色、接在自己的內容前面）；01-22 那筆是第一筆不帶；
    // 時間軸不帶；某一天的已處理、搜尋、回顧帶（標記清單見 E133）
    const yqOf = (box, src) => win.locator(`${box} .card[data-src="${src}"]`, { hasText: yq, has: win.locator('button.chip.event') }).first();
    const priorOf = c => c.evaluate(b => {
      const p = b.querySelector('.prior');
      return p && { dates: [...p.querySelectorAll('.prior-date')].map(x => x.textContent), titles: p.querySelectorAll('.prior-title').length,
        lines: [...p.querySelectorAll('.line')].map(x => x.textContent), beforeBody: !!p.nextElementSibling && p.nextElementSibling.matches('.body'),
        muted: getComputedStyle(p).color === getComputedStyle(b.querySelector('.chip.event')).color };
    });
    const yqPrior = { dates: ['01-22（四）'], titles: 0, lines: ['->雅琪問台應看看'], beforeBody: true, muted: true };
    ok('E132 事件時間軸不帶前情', (await win.$$('#results .prior')).length === 0);
    await win.click(`#dayList button[data-date="${today}"]`);
    ok('E132 今天的已處理：^1 那筆帶 01-22 那筆的內容、標日期、標題一樣不寫、接在自己的內容前面、淡色', await waitFor(async () => same(await priorOf(yqOf('#cards', today)), yqPrior)),
      JSON.stringify(await priorOf(yqOf('#cards', today)).catch(e => e.message)));
    await win.fill('#q', '發票作廢後又產生一次作廢的XML');
    await win.press('#q', 'Enter');
    ok('E132 搜尋結果：今天那筆帶、01-22 那筆（第一筆）不帶', await waitFor(async () => same(await priorOf(yqOf('#results', today)), yqPrior) && (await priorOf(yqOf('#results', '2026-01-22'))) === null),
      JSON.stringify([await priorOf(yqOf('#results', today)).catch(e => e.message), await priorOf(yqOf('#results', '2026-01-22')).catch(e => e.message)]));
    await win.click('#rangeBtn');
    ok('E132 回顧（這週）：今天那筆帶', await waitFor(async () => same(await priorOf(yqOf('#results', today)), yqPrior)), JSON.stringify(await priorOf(yqOf('#results', today)).catch(e => e.message)));
    await win.click('#backBtn');

    // E5：搜尋
    await win.fill('#q', '強制結案');
    await win.press('#q', 'Enter');
    ok('E5 搜尋只出現在內容裡的字', await waitFor(async () => same(await resultSrcs(), ['2026-09-11'])), JSON.stringify(await resultSrcs()));
    await win.click('#results .card button.src');
    ok('E5 點結果的日期跳到那天', await waitFor(async () => (await headTitle()).startsWith('2026-09-11')), await headTitle());

    // E48：搜尋記住讀過的檔（見 開發筆記 D064）——外面改了舊的日子（大小一樣）、加一天、刪一天，下一次搜尋都要跟著變
    // 標題連筆數一起比：只比結果的話，上一次的畫面剛好一樣也會綠
    const searched = async (q, want) => {
      await win.fill('#q', q);
      await win.press('#q', 'Enter');
      return waitFor(async () => (await headTitle()) === `搜尋「${q}」：${want.length} 筆` && same(await resultSrcs(), want));
    };
    const f0911 = path.join(data, dayPath('2026-09-11'));
    const raw0911 = fs.readFileSync(f0911);
    const edited0911 = Buffer.from(raw0911.toString('utf8').replace('強制結案', '強迫結案'), 'utf8');
    ok('E48 前提：改過的舊檔大小一樣、字不一樣', edited0911.length === raw0911.length && !edited0911.equals(raw0911));
    fs.writeFileSync(f0911, edited0911);
    ok('E48 外面改了舊的日子：舊字搜不到', await searched('強制結案', []), `${await headTitle()} ${JSON.stringify(await resultSrcs())}`);
    ok('E48 外面改了舊的日子：新字搜得到', await searched('強迫結案', ['2026-09-11']), `${await headTitle()} ${JSON.stringify(await resultSrcs())}`);
    const f0303 = path.join(data, dayPath('2026-03-03'));
    fs.mkdirSync(path.dirname(f0303), { recursive: true });
    fs.writeFileSync(f0303, '外面加的一天\n\t這天才有的字E48加\n');
    ok('E48 外面加一天：搜得到', await searched('E48加', ['2026-03-03']), `${await headTitle()} ${JSON.stringify(await resultSrcs())}`);
    fs.rmSync(f0303);
    ok('E48 外面刪掉那天：搜不到', await searched('這天才有的字', []), `${await headTitle()} ${JSON.stringify(await resultSrcs())}`);
    fs.writeFileSync(f0911, raw0911);
    ok('E48 改回來：舊字又搜得到', await searched('強制結案', ['2026-09-11']), `${await headTitle()} ${JSON.stringify(await resultSrcs())}`);
    await win.click('#results .card button.src');
    ok('E48 回到那天', await waitFor(async () => (await headTitle()).startsWith('2026-09-11')), await headTitle());

    // E6：代號時間軸
    const want6 = srch.timelineByCode(srch.buildIndex(readSources(data)), 'CWMM3030').map(x => x.src);
    ok('E6 前提：CWMM3030 跨了好幾天', want6.length >= 2, JSON.stringify(want6));
    await cardOf('2026-09-11', 'CWMM3030').locator('button.chip.code', { hasText: 'CWMM3030' }).click();
    ok('E6 代號時間軸＝parser 算的、舊的在前', await waitFor(async () => same(await resultSrcs(), want6)), JSON.stringify(await resultSrcs()));
    await win.click('#backBtn');
    ok('E6 回到那天', await waitFor(async () => (await headTitle()).startsWith('2026-09-11') && (await win.isVisible('#todoBox'))), await headTitle());

    // E62：回顧（見 開發筆記 D087）——接著 E6（看的是 09-11）。期望值從磁碟上的檔用 parser 算；最後回到 09-11，E24 的「處理完」要搬進它
    const rangeHeads = () => win.$$eval('#results .rangeDay', els => els.map(e => e.textContent));
    const rangeInputs = async () => [await win.inputValue('#rangeFrom'), await win.inputValue('#rangeTo')];
    const wantRange = (from, to) => {
      const items = srch.rangeItems(srch.buildIndex(readSources(data)), from, to);
      const days = [...new Set(items.map(x => x.src))];
      const wd = d => '日一二三四五六'[new Date(d + 'T00:00').getDay()];
      return { days, title: `回顧 ${from} ～ ${to}：${items.length} 筆`, srcs: items.map(x => x.src),
        heads: days.map(d => `${d}（${wd(d)}）· ${items.filter(x => x.src === d).length} 筆`) };
    };
    const rangeIs = async want => (await headTitle()) === want.title && same(await resultSrcs(), want.srcs) && same(await rangeHeads(), want.heads);
    const rangeNow = async () => JSON.stringify({ title: await headTitle(), srcs: await resultSrcs(), heads: await rangeHeads(), inputs: await rangeInputs() });
    const [y62, m62, d62] = today.split('-').map(Number);
    const mon62 = localIso(new Date(y62, m62 - 1, d62 - ((new Date(y62, m62 - 1, d62).getDay() + 6) % 7)));
    const thisWeek = wantRange(mon62, today);
    ok('E62 前提：這週有今天的紀錄（E2 記的）', thisWeek.days.includes(today), JSON.stringify(thisWeek));
    await win.click('#rangeBtn');
    ok('E62 按「回顧」：這週一到今天、每天一段小標、卡片＝parser 算的', await waitFor(async () => same(await rangeInputs(), [mon62, today]) && await rangeIs(thisWeek)), await rangeNow());
    ok('E62 回顧畫面：「回顧」亮著、有起訖列和「回到那天」、不顯示已處理／待處理', /\bon\b/.test(await win.getAttribute('#rangeBtn', 'class'))
      && await win.isVisible('#rangeBar') && await win.isVisible('#backBtn') && !(await win.isVisible('#doneBox')) && !(await win.isVisible('#todoBox')));
    const jan = wantRange('2026-01-12', '2026-01-25');
    ok('E62 前提：01-12～01-25 有 01-15、01-22 兩天', same(jan.days, ['2026-01-15', '2026-01-22']), JSON.stringify(jan.days));
    await win.fill('#rangeFrom', '2026-01-12');
    await win.fill('#rangeTo', '2026-01-25');
    ok('E62 自己填起訖：只列那段的日子、舊的在前', await waitFor(() => rangeIs(jan)), await rangeNow());
    ok('E62 卡片唯讀：沒有按鈕列、卡片上不標日期', (await win.$$('#results .card .actions')).length === 0 && (await win.$$('#results .card button.src')).length === 0);
    await win.click('#rangeNext');
    ok('E62 ›：起日那週的下一週（01-19～01-25）', await waitFor(async () => same(await rangeInputs(), ['2026-01-19', '2026-01-25']) && await rangeIs(wantRange('2026-01-19', '2026-01-25'))), await rangeNow());
    await win.click('#rangePrev');
    ok('E62 ‹：上一週（01-12～01-18）', await waitFor(async () => same(await rangeInputs(), ['2026-01-12', '2026-01-18']) && await rangeIs(wantRange('2026-01-12', '2026-01-18'))), await rangeNow());
    await win.click('#rangePrev');
    ok('E62 那週沒有紀錄：寫「這段時間沒有處理過的事」', await waitFor(async () => (await headTitle()) === '回顧 2026-01-05 ～ 2026-01-11：0 筆'
      && (await win.textContent('#results')) === '這段時間沒有處理過的事'), await rangeNow());
    const f0106 = path.join(data, dayPath('2026-01-06'));
    fs.writeFileSync(f0106, '外面加的一天E62\n');
    ok('E62 外面加了那週的一天：不用重開就列出來', await waitFor(async () => same(await rangeHeads(), ['2026-01-06（二）· 1 筆'])), await rangeNow());
    fs.rmSync(f0106);
    ok('E62 外面刪掉：又沒有了', await waitFor(async () => (await headTitle()) === '回顧 2026-01-05 ～ 2026-01-11：0 筆'), await rangeNow());
    await win.fill('#rangeFrom', '2026-02-01');
    ok('E62 起日晚於訖日：寫「起日不能晚於訖日」、不列卡片', await waitFor(async () => (await headTitle()) === '回顧 2026-02-01 ～ 2026-01-11'
      && (await win.textContent('#results')) === '起日不能晚於訖日'), await rangeNow());
    await win.fill('#rangeFrom', '2026-01-12');
    await win.fill('#rangeTo', '2026-01-25');
    await waitFor(() => rangeIs(jan));
    // 「匯出這段…」（D088）：匯出列打開、起訖帶回顧的；之後回顧換週，匯出的不跟著換；匯出列開著再按，蓋成回顧現在的
    const expDates = async () => [await win.inputValue('#expFrom'), await win.inputValue('#expTo')];
    await win.click('#rangeExport');
    ok('E62 「匯出這段…」：匯出列打開、起訖是回顧的 01-12～01-25、回顧畫面還在', await waitFor(async () => await win.isVisible('#exportBar')
      && same(await expDates(), ['2026-01-12', '2026-01-25'])) && await rangeIs(jan), JSON.stringify(await expDates()));
    await win.click('#rangeNext');
    await waitFor(async () => same(await rangeInputs(), ['2026-01-19', '2026-01-25']));
    ok('E62 回顧換週：匯出的起訖不跟著換', same(await expDates(), ['2026-01-12', '2026-01-25']), JSON.stringify(await expDates()));
    await win.click('#rangeExport');
    ok('E62 匯出列開著再按「匯出這段…」：蓋成回顧現在的 01-19～01-25', await waitFor(async () => same(await expDates(), ['2026-01-19', '2026-01-25'])) && await win.isVisible('#exportBar'),
      JSON.stringify(await expDates()));
    await win.click('#expClose');
    await win.click('#results .rangeDay:has-text("2026-01-22")');
    ok('E62 點小標：打開那天、起訖列收起來、「回顧」不亮', await waitFor(async () => (await headTitle()).startsWith('2026-01-22') && await win.isVisible('#doneBox')
      && !(await win.isVisible('#rangeBar')) && !/\bon\b/.test(await win.getAttribute('#rangeBtn', 'class'))), await headTitle());
    await win.click('#rangeBtn');
    ok('E62 再按「回顧」：回到這週', await waitFor(async () => same(await rangeInputs(), [mon62, today]) && await rangeIs(wantRange(mon62, today))), await rangeNow());
    await win.click('#backBtn');
    ok('E62 「回到那天」：回到剛才打開的 01-22', await waitFor(async () => (await headTitle()).startsWith('2026-01-22') && await win.isVisible('#todoBox')), await headTitle());

    // E152：回到回顧（見 開發筆記 D198）——接著 E62（看的是 01-22）。測試直接寫 01-07：40 筆有代號的，回顧 01-05～01-11 才捲得動；最後刪掉
    const f0107 = path.join(data, dayPath('2026-01-07'));
    fs.writeFileSync(f0107, Array.from({ length: 40 }, (_, i) => `ERVA${String(i + 1).padStart(3, '0')} 回顧捲動，第 ${i + 1} 筆\n\t內容 ${i + 1}\n`).join(''));
    const backText = () => win.textContent('#backBtn');
    const resTop = () => win.$eval('#results', e => e.scrollTop);
    const r152 = wantRange('2026-01-05', '2026-01-11');
    const range152 = async () => {
      await win.click('#rangeBtn');
      await win.fill('#rangeFrom', '2026-01-05');
      await win.fill('#rangeTo', '2026-01-11');
      return waitFor(() => rangeIs(r152));
    };
    ok('E152 前提：回顧 01-05～01-11 是 01-07 的 40 筆、捲得動', await range152() && r152.srcs.length === 40
      && await win.$eval('#results', e => e.scrollHeight > e.clientHeight * 2), await rangeNow());
    // 第 20 張的代號捲到中間、記下捲到哪；用元素的 click() 點（Playwright 的 click 會先捲）
    const top152 = await win.$eval('#results', e => { e.querySelectorAll('.card .chip.code')[19].scrollIntoView({ block: 'center' }); return e.scrollTop; });
    ok('E152 前提：捲到中間了', top152 > 0, String(top152));
    await win.$eval('#results', e => e.querySelectorAll('.card .chip.code')[19].click());
    ok('E152 點回顧裡的代號：打開時間軸、標題前面是「← 回到回顧」', await waitFor(async () => (await headTitle()).startsWith('ERVA020 時間軸')
      && await win.isVisible('#backBtn') && (await backText()) === '← 回到回顧'), `${await headTitle()} ${await backText()}`);
    await win.click('#results .card button.src');
    ok('E152 再點時間軸上的日期：打開 01-07，還是「← 回到回顧」', await waitFor(async () => (await headTitle()).startsWith('2026-01-07') && await win.isVisible('#doneBox')
      && await win.isVisible('#backBtn') && (await backText()) === '← 回到回顧'), `${await headTitle()} ${await backText()}`);
    await win.click('#backBtn');
    ok('E152 按「← 回到回顧」：回到 01-05～01-11、捲回剛剛的位置、按鈕換回「← 回到那天」', await waitFor(async () => same(await rangeInputs(), ['2026-01-05', '2026-01-11'])
      && await rangeIs(r152) && Math.abs((await resTop()) - top152) <= 1 && (await backText()) === '← 回到那天'),
      JSON.stringify({ top152, now: await resTop(), back: await backText(), range: await rangeNow() }));
    await win.click('#results .rangeDay');
    ok('E152 點小標：打開 01-07、有「← 回到回顧」', await waitFor(async () => (await headTitle()).startsWith('2026-01-07') && await win.isVisible('#backBtn')
      && (await backText()) === '← 回到回顧'), `${await headTitle()} ${await backText()}`);
    await win.click('#dayList button[data-date="2026-01-15"]');
    ok('E152 換去日期清單的另一天：收起來（某一天沒有回去的鈕）', await waitFor(async () => (await headTitle()).startsWith('2026-01-15') && !(await win.isVisible('#backBtn'))),
      `${await headTitle()} ${await win.isVisible('#backBtn')}`);
    await range152();
    await win.click('#results .chip.code:has-text("ERVA001")');
    await waitFor(async () => (await headTitle()).startsWith('ERVA001 時間軸') && (await backText()) === '← 回到回顧');
    await win.click('#flagList');
    ok('E152 從時間軸換去標記清單：收起來、換回「← 回到那天」', await waitFor(async () => (await headTitle()).startsWith('標記') && (await backText()) === '← 回到那天'),
      `${await headTitle()} ${await backText()}`);
    fs.rmSync(f0107);
    await waitFor(async () => (await win.$$('#dayList button[data-date="2026-01-07"]')).length === 0);
    await win.click('#dayList button[data-date="2026-09-11"]');
    await waitFor(async () => (await headTitle()).startsWith('2026-09-11'));

    // E14：刪除待處理（不跳詢問）
    const todoBeforeDel = readN(todoFile);
    await cardOf('todo', '折讓證明日期').locator('button.del').click();
    ok('E14 刪除待處理：待辦.md 沒有那筆', await waitFor(() => !readN(todoFile).includes('折讓證明日期')), readN(todoFile));
    ok('E14 刪除不跳詢問', dialogs === 0, `跳了 ${dialogs} 次`);

    // E24：Ctrl+Z 復原（見 開發筆記 D028）
    const undoKey = async () => { await win.click('#dayTitle'); await win.keyboard.press('Control+Z'); };
    await undoKey();
    ok('E24 Ctrl+Z 復原刪除：待辦.md 回到刪除前', await waitFor(() => readN(todoFile) === todoBeforeDel), readN(todoFile));
    ok('E24 卡片回來了', await waitFor(async () => (await todoTitles()).some(t => t.includes('折讓證明日期'))), JSON.stringify(await todoTitles()));
    const viewDay = path.join(data, dayPath('2026-09-11'));
    const dayBeforeDone = readN(viewDay);
    await cardOf('todo', '折讓證明日期').locator('button.done').click();
    await waitFor(() => !readN(todoFile).includes('折讓證明日期'));
    await undoKey();
    ok('E24 Ctrl+Z 復原處理完：兩個檔都回到原本', await waitFor(() => readN(todoFile) === todoBeforeDel && readN(viewDay) === dayBeforeDone),
      JSON.stringify([readN(todoFile), readN(viewDay)]));
    await cardOf('todo', '折讓證明日期').locator('button.del').click();
    await waitFor(() => !readN(todoFile).includes('折讓證明日期'));
    const afterDel = readN(todoFile);
    fs.appendFileSync(todoFile, '外部加的待處理\n');
    await waitFor(async () => (await todoTitles()).includes('外部加的待處理'));
    await undoKey();
    await sleep(500);
    ok('E24 之後檔案又被改過就不復原（不蓋掉外部的修改）', readN(todoFile) === afterDel + '外部加的待處理\n', readN(todoFile));
    ok('E24 跳出不能復原的提示', ((await win.textContent('#toast').catch(() => '')) || '').includes('不能復原'), await win.textContent('#toast'));
    // 先做一個能復原的動作，再在輸入框裡按 Ctrl+Z：不該把它復原掉
    await cardOf('todo', '週報').locator('button.wait').click();
    await waitFor(() => readN(todoFile).split('\n').includes('週報 [待回覆]'));
    await win.fill('#newTitle', '輸入框裡的 Ctrl+Z');
    await win.press('#newTitle', 'Control+Z');
    await sleep(400);
    ok('E24 游標在輸入框裡時 Ctrl+Z 不動檔案', readN(todoFile).split('\n').includes('週報 [待回覆]'), readN(todoFile));
    await win.fill('#newTitle', '');
    await undoKey();
    ok('E24 離開輸入框再按 Ctrl+Z 才復原', await waitFor(() => readN(todoFile).split('\n').includes('週報')), readN(todoFile));

    // E22：待處理的隱藏（見 開發筆記 D026）
    await cardOf('todo', '週報').locator('button.hide').click();
    ok('E22 隱藏：行尾加 [隱藏]', await waitFor(() => readN(todoFile).split('\n').includes('週報 [隱藏]')), readN(todoFile));
    ok('E22 從清單消失、底下出現「已隱藏 1 筆」', await waitFor(async () => !(await todoTitles()).includes('週報')
      && ((await win.textContent('#todoCards .hiddenToggle').catch(() => '')) || '').includes('已隱藏 1 筆')), JSON.stringify(await todoTitles()));
    ok('E22 沒展開時看不到隱藏的卡片', same(await hiddenTitles(), []), JSON.stringify(await hiddenTitles()));
    await win.fill('#q', '週報');
    await win.press('#q', 'Enter');
    ok('E22 隱藏的搜尋得到、標「已隱藏」', await waitFor(async () => ((await cardOf('todo', '週報').textContent().catch(() => '')) || '').includes('已隱藏')),
      JSON.stringify(await resultSrcs()));
    await win.click('#backBtn');
    await win.waitForSelector('#todoCards .hiddenToggle');
    await win.click('#todoCards .hiddenToggle');
    ok('E22 點一下展開，看得到隱藏的卡片', await waitFor(async () => same(await hiddenTitles(), ['週報'])), JSON.stringify(await hiddenTitles()));
    await cardOf('todo', '週報').locator('button.wait').click();
    ok('E22 隱藏的也能標待回覆：兩個標記都在', await waitFor(() => readN(todoFile).split('\n').includes('週報 [隱藏] [待回覆]')), readN(todoFile));
    await cardOf('todo', '週報').locator('button.hide').click();
    ok('E22 取消隱藏：[隱藏] 拿掉、待回覆留著、回到清單', await waitFor(async () => readN(todoFile).split('\n').includes('週報 [待回覆]')
      && (await todoTitles()).includes('週報')), readN(todoFile));
    await cardOf('todo', '週報').locator('button.wait').click();
    ok('E22 還原', await waitFor(() => readN(todoFile).split('\n').includes('週報')), readN(todoFile));

    // E23：已處理、待處理都可以縮起來，輸入區變大（見 開發筆記 D027）
    await win.click(`#dayList button[data-date="${today}"]`);
    await waitFor(async () => (await headTitle()).includes(today));
    const nDone = (await doneTitles()).length;
    const nTodo = (await todoTitles()).length;
    ok('E23 標題列寫筆數', (await win.textContent('#doneHead')).includes(`已處理（${nDone}）`) && (await win.textContent('#todoHead')).includes(`待處理（${nTodo}）`),
      `${await win.textContent('#doneHead')} / ${await win.textContent('#todoHead')}（應為 ${nDone}、${nTodo}）`);
    const bodyH = async () => (await win.locator('#newBody').boundingBox()).height;
    const h0 = await bodyH();
    await win.click('#doneHead');
    ok('E23 點已處理的標題列：縮起來', await waitFor(async () => !(await win.isVisible('#cards'))));
    const h1 = await bodyH();
    await win.click('#todoHead');
    ok('E23 點待處理的標題列：縮起來', await waitFor(async () => !(await win.isVisible('#todoCards'))));
    const h2 = await bodyH();
    ok('E23 縮起來的空間給輸入區：每縮一塊都變大，兩塊都縮至少大 200px', h1 > h0 && h2 > h1 && h2 > h0 + 200, `內文欄高度 ${h0} → ${h1} → ${h2}`);
    ok('E23 縮起來時標題列還在、有 ▸', (await win.isVisible('#doneHead')) && (await win.textContent('#doneHead')).startsWith('▸'));
    await win.click('#doneHead');
    await win.click('#todoHead');
    ok('E23 再點一下展開、輸入區回到原本大小', await waitFor(async () => (await win.isVisible('#cards')) && (await win.isVisible('#todoCards')) && Math.abs((await bodyH()) - h0) < 2),
      `內文欄高度 ${await bodyH()}（原本 ${h0}）`);

    // E54：分隔線拉大小（見 開發筆記 D074）——量實際大小。上下的線高度是 0（只有前後 2px 抓得到），
    // Playwright 會當成看不到、不肯點，所以自己算座標用 mouse
    const sizesOf = () => win.evaluate(() => ({
      w: Math.round(document.getElementById('days').getBoundingClientRect().width),
      h: ['doneBox', 'todoBox', 'newForm'].map(id => Math.round(document.getElementById(id).getBoundingClientRect().height)),
      saved: JSON.parse(localStorage.getItem('daybook.sizes') || '{}'),
    }));
    const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
    const sashAt = sel => win.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
    const dragSash = async (sel, dx, dy) => {
      const [x, y] = await sashAt(sel);
      await win.mouse.move(x, y);
      await win.mouse.down();
      await win.mouse.move(x + dx, y + dy, { steps: 5 });
      await win.mouse.up();
    };
    const dblSash = async sel => { const [x, y] = await sashAt(sel); await win.mouse.dblclick(x, y); };
    const sashShown = () => win.evaluate(() => ['sashDone', 'sashTodo'].map(id => !document.getElementById(id).hidden));
    const paneGaps = () => win.evaluate(() => ['doneBox', 'todoBox'].map(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      const list = document.getElementById(id === 'doneBox' ? 'cards' : 'todoCards');
      return Math.round(box.bottom - list.lastElementChild.getBoundingClientRect().bottom);
    }));
    {   // 這段的變數名短，關在區塊裡，免得跟後面的案例撞名
    const s0 = await sizesOf();
    ok('E54 一開始：左欄 180px、沒記大小、兩條線都在', s0.w === 180 && Object.keys(s0.saved).length === 0 && same(await sashShown(), [true, true]), JSON.stringify(s0));
    await dragSash('#sashSide', 60, 0);
    const s1 = await sizesOf();
    ok('E54 拉左欄的線：寬度跟著變、記在這台電腦', near(s1.w, 240) && near(s1.saved.side, 240), JSON.stringify(s1));
    ok('E54 前提：待處理夠高，讓得出 70px 還在最小（60px）以上', s1.h[1] > 140, JSON.stringify(s1.h));
    await dragSash('#sashDone', 0, 40);
    const s2 = await sizesOf();
    ok('E54 已處理｜待處理往下拉：已處理變大、待處理讓出一樣多、輸入區不動', near(s2.h[0], s1.h[0] + 40) && near(s2.h[1], s1.h[1] - 40) && near(s2.h[2], s1.h[2]),
      `${s1.h} → ${s2.h}`);
    await dragSash('#sashTodo', 0, -30);
    const s3 = await sizesOf();
    ok('E54 待處理｜輸入區往上拉：待處理變小、輸入區變大、已處理不動', near(s3.h[0], s2.h[0]) && near(s3.h[1], s2.h[1] - 30) && near(s3.h[2], s2.h[2] + 30),
      `${s2.h} → ${s3.h}`);
    const [, yDone] = await sashAt('#sashDone');
    await dragSash('#sashDone', 0, (await win.evaluate(() => innerHeight)) - 5 - yDone);
    const s4 = await sizesOf();
    ok('E54 往下拉到底：待處理縮到最小（60px）就接著縮輸入區，輸入區最小 140px', near(s4.h[1], 60) && near(s4.h[2], 140) && s4.h[0] > s3.h[0], `${s3.h} → ${s4.h}`);
    // 今天的卡片多到放不下（兩塊都在捲動），換到卡片少的 09-11 才看得出「拉多大就多大」：跟著內容走的話不會留空白（D029）
    await win.click('#dayList button[data-date="2026-09-11"]');
    ok('E54 拉多大就多大：換到內容少的一天，高度照拉的、底下空著', await waitFor(async () => (await headTitle()).startsWith('2026-09-11')
      && near((await sizesOf()).h[0], s4.h[0]) && (await paneGaps())[0] > 100), `已處理高度 ${(await sizesOf()).h[0]}（拉的 ${s4.h[0]}），底下的空白 ${(await paneGaps())[0]}px`);
    await win.click(`#dayList button[data-date="${today}"]`);
    await waitFor(async () => (await headTitle()).includes(today));
    await win.reload();
    await win.waitForSelector('#dayList button');
    ok('E54 重新載入：左欄寬度、各塊高度都照上次', await waitFor(async () => { const s = await sizesOf(); return near(s.w, s4.w) && s.h.every((v, j) => near(v, s4.h[j])); }),
      `${JSON.stringify(await sizesOf())}（上次 ${s4.w}、${s4.h}）`);
    await win.click('#todoHead');
    const shownT = await sashShown();
    const c0 = await sizesOf();
    await dragSash('#sashDone', 0, -40);
    const c1 = await sizesOf();
    ok('E54 待處理縮起來：它底下的線不出現；拉已處理的線，已處理和輸入區互相讓', same(shownT, [true, false]) && near(c1.h[0], c0.h[0] - 40) && near(c1.h[2], c0.h[2] + 40),
      `${JSON.stringify(shownT)} ${c0.h} → ${c1.h}`);
    await win.click('#todoHead');
    await win.click('#doneHead');
    const shownD = await sashShown();
    await win.click('#doneHead');
    ok('E54 已處理縮起來：它底下的線不出現', same(shownD, [false, true]), JSON.stringify(shownD));
    await dblSash('#sashDone');
    const s5 = await sizesOf();
    ok('E54 點兩下已處理｜待處理的線：兩塊回到跟著內容走（D029），高度跟還沒拉的時候一樣', s5.saved.done == null && s5.saved.todo == null && s5.h.every((v, j) => near(v, s1.h[j])),
      `${s5.h}（還沒拉 ${s1.h}）`);
    // 跟著內容走、但放不下在捲動的那塊，高度是分剩的：只拉它底下的線時要照現在的高度定住，不然讓出來的會被它拿走、線不跟著游標
    await dragSash('#sashTodo', 0, -30);
    const s7 = await sizesOf();
    ok('E54 已處理在捲動時拉待處理｜輸入區的線：已處理不動、輸入區拿到讓出來的', near(s7.h[0], s5.h[0]) && near(s7.h[1], s5.h[1] - 30) && near(s7.h[2], s5.h[2] + 30),
      `${s5.h} → ${s7.h}`);
    await dblSash('#sashDone');
    // 拉過的在內容變多時不跟著縮：先縮跟著內容走的那塊。在 09-11（已處理放得下）拉待處理，回到今天（已處理放不下）
    await win.click('#dayList button[data-date="2026-09-11"]');
    await waitFor(async () => (await headTitle()).startsWith('2026-09-11'));
    await dragSash('#sashTodo', 0, -40);
    const s8 = await sizesOf();
    await win.click(`#dayList button[data-date="${today}"]`);
    ok('E54 拉過的不跟著縮：換到放不下的那天，待處理照拉的高度、已處理縮', await waitFor(async () => (await headTitle()).includes(today) && near((await sizesOf()).h[1], s8.h[1]))
      && (await sizesOf()).saved.done == null, `09-11 ${s8.h} → 今天 ${(await sizesOf()).h} ${JSON.stringify((await sizesOf()).saved)}`);
    await dblSash('#sashTodo');
    await dblSash('#sashSide');
    const s6 = await sizesOf();
    ok('E54 點兩下左欄的線：回到 180px', s6.w === 180 && s6.saved.side == null, JSON.stringify(s6));
    // 放大後拉過的放不下（D074〈後續〉）：記的是 CSS px，150% 時同一個數字更高。拉過的也要縮，
    // 不能把待處理壓到看不見、輸入區擠到狀態列底下、整頁撐出捲動（原本 0.001 的係數，150% 時已處理 450 一點都沒縮）
    await win.evaluate(() => localStorage.setItem('daybook.sizes', JSON.stringify({ done: 450 })));
    await win.reload();
    await win.waitForSelector('#dayList button');
    const z0 = await sizesOf();
    for (let i = 0; i < 3; i++) await win.keyboard.press('Control+=');
    const zoomed = await waitFor(async () => (await win.textContent('#zoomBtn')) === '150%');
    await sleep(300);
    const z1 = await win.evaluate(() => {
      const r = id => document.getElementById(id).getBoundingClientRect();
      return { h: ['doneBox', 'todoBox', 'newForm'].map(id => Math.round(r(id).height)), formBottom: Math.round(r('newForm').bottom),
        status: Math.round(r('statusBar').top), scroll: document.documentElement.scrollHeight, vh: innerHeight };
    });
    ok('E54 前提：100% 時拉過的已處理是 450px', near(z0.h[0], 450), JSON.stringify(z0.h));
    ok('E54 放大到 150%、已處理拉過 450px：拉過的也縮，待處理至少 60px、輸入區 140px 在狀態列上面、整頁沒撐出捲動',
      zoomed && z1.h[0] < 450 && z1.h[1] >= 59 && near(z1.h[2], 140) && z1.formBottom <= z1.status + 1 && z1.scroll <= z1.vh, JSON.stringify(z1));
    await win.keyboard.press('Control+0');
    await waitFor(async () => (await win.textContent('#zoomBtn')) === '100%');
    await dblSash('#sashDone');
    const z2 = await sizesOf();
    ok('E54 還原 100%、點兩下線：回到沒拉過（後面的案例照沒拉過的算）', z2.saved.done == null && z2.saved.todo == null, JSON.stringify(z2.saved));
    }

    // E55：外觀頁「還原預設大小」（見 開發筆記 D075）——卡片模式、文字模式都拉過，一次還原
    {
    await viaSettings(win, '#skinBtn');
    ok('E55 外觀頁最上面是「版面」；沒拉過時「還原預設大小」變灰', await waitFor(() => win.isVisible('#sizeReset'))
      && (await win.isDisabled('#sizeReset')) && (await win.textContent('#skin h3')) === '版面', await win.textContent('#skin h3'));
    await win.keyboard.press('Escape');
    const before = await sizesOf();
    await dragSash('#sashSide', 40, 0);
    await dragSash('#sashDone', 0, -30);
    await win.click('#modeBtn');
    await dragSash('#sashDone', 0, 40);
    await win.click('#modeBtn');
    const dragged = await sizesOf();
    await viaSettings(win, '#skinBtn');
    await waitFor(() => win.isVisible('#sizeReset'));
    const enabled = await win.isEnabled('#sizeReset');
    await win.click('#sizeReset');
    ok('E55 拉過之後按鈕可以按；按了左欄 180px、各塊高度回到沒拉過、文字模式的比例也清掉，按鈕變灰、跳提示', enabled
      && ['side', 'done', 'todo', 'text'].every(k => dragged.saved[k] != null)
      && await waitFor(async () => { const s = await sizesOf(); return s.w === 180 && s.h.every((v, j) => near(v, before.h[j])) && Object.values(s.saved).every(v => v == null); })
      && (await win.isDisabled('#sizeReset')) && ((await win.textContent('#toast')) || '').includes('已還原預設大小'),
      `拉過 ${JSON.stringify(dragged)} → ${JSON.stringify(await sizesOf())}（沒拉過 ${before.w}、${before.h}）`);
    await win.keyboard.press('Escape');
    }

    // E56：捲軸照 VS Code（見 開發筆記 D077）——中間那欄 14px、其他 10px；滑鼠移進那塊才出現，移走就不見。
    // 只截捲軸那一直條比：出現了就跟沒出現時不一樣，不見了就一模一樣
    {
    const sbOf = sel => win.evaluate(s => {
      const el = document.querySelector(s), r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const w = el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      return { w, scrolls: el.scrollHeight > el.clientHeight, clip: { x: r.right - parseFloat(cs.borderRightWidth) - w, y: r.top, width: w, height: r.height } };
    }, sel);
    const sb = await sbOf('#todoCards');
    ok('E56 前提：待處理在捲動', sb.scrolls, JSON.stringify(sb));
    ok('E56 中間那欄的捲軸 14px', sb.w === 14, JSON.stringify(sb));
    const strip = () => win.screenshot({ clip: sb.clip });
    await win.hover('#dayTitle');
    const out0 = await strip();
    await win.hover('#todoCards', { position: { x: 60, y: 20 } });
    const inside = await strip();
    await win.hover('#newBody');   // 移到同一欄的另一塊：#center 還是滑過的，待處理的捲軸也要不見
    const moved = await strip();
    ok('E56 滑鼠移進待處理：捲軸出現；移到輸入區：不見', !inside.equals(out0) && moved.equals(out0), `移進 ${inside.equals(out0) ? '沒出現' : '出現'}、移走 ${moved.equals(out0) ? '不見' : '還在'}`);
    // fixture 的日子少，日期清單不會捲：暫時讓它一定有捲軸再量
    await win.evaluate(() => { document.getElementById('dayList').style.overflowY = 'scroll'; });
    const dl = await sbOf('#dayList');
    await win.evaluate(() => { document.getElementById('dayList').style.overflowY = ''; });
    ok('E56 左欄的捲軸 10px', dl.w === 10, JSON.stringify(dl));
    }

    // E60：最左邊的頁籤列（見 開發筆記 D083）——寬 48px、左欄接在右邊；點「日記本」收起／打開左欄、記在這台電腦；
    // 收起來時 Ctrl+F 先打開左欄；顏色照 VS Code（淺色 Light Modern、暗色 Dark+）。最後左欄是打開的，後面的案例要點日期清單
    {
    const lay = () => win.evaluate(() => {
      const r = id => document.getElementById(id).getBoundingClientRect();
      const days = getComputedStyle(document.getElementById('days')).display === 'none' ? null : [r('days').left, r('days').width];
      return { act: [r('activity').left, r('activity').width], days, center: r('center').left,
        on: document.getElementById('actJournal').classList.contains('on'), saved: localStorage.getItem('daybook.sideOff') };
    });
    const opened = l => !!l.days && near(l.days[0], 48) && near(l.days[1], 180) && near(l.center, 228) && l.on;
    const closed = l => !l.days && near(l.center, 48) && !l.on;
    const l0 = await lay();
    ok('E60 頁籤列在最左邊、寬 48px；左欄（180px）接在右邊；「日記本」是選到的', near(l0.act[0], 0) && near(l0.act[1], 48) && opened(l0), JSON.stringify(l0));
    await win.click('#actJournal');
    const l1 = await lay();
    ok('E60 點「日記本」：左欄收起來、中間接在頁籤列右邊、不算選到、記在這台電腦', closed(l1) && l1.saved === '1', JSON.stringify(l1));
    await win.reload();
    await waitFor(async () => (await headTitle()).includes(today));
    const l2 = await lay();
    ok('E60 重新載入：一開起來就是收起來的', closed(l2), JSON.stringify(l2));
    await win.click('#actJournal');
    const l3 = await lay();
    ok('E60 再點一下：左欄打開、記在這台電腦', opened(l3) && l3.saved === '', JSON.stringify(l3));
    await win.click('#actJournal');
    await win.click('#dayTitle');
    await win.keyboard.press('Control+F');
    const l4 = await lay();
    ok('E60 收起來時按 Ctrl+F：左欄打開、游標在搜尋框', opened(l4) && l4.saved === '' && (await win.evaluate(() => document.activeElement.id)) === 'q', JSON.stringify(l4));
    const colors = () => win.evaluate(() => {
      const a = document.getElementById('activity'), b = document.getElementById('actJournal');
      return [getComputedStyle(a).backgroundColor, getComputedStyle(b).color, getComputedStyle(b, '::before').backgroundColor];
    });
    await win.hover('#dayTitle');   // 滑過的顏色跟選到的一樣，移開才量得到
    const light = await colors();
    await win.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    const dark = await colors();
    await win.evaluate(() => { delete document.documentElement.dataset.theme; });
    ok('E60 顏色：淺色底 #F8F8F8、圖示 #1F1F1F、左邊的線 #005FB8；暗色底 #333333、圖示和線白色',
      same(light, ['rgb(248, 248, 248)', 'rgb(31, 31, 31)', 'rgb(0, 95, 184)']) && same(dark, ['rgb(51, 51, 51)', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)']),
      JSON.stringify({ light, dark }));
    }

    // E64：設定齒輪（見 開發筆記 D092）——在頁籤列最底下；點了右邊彈出小選單，分「資料」「自訂」兩類（D098）；
    // Esc、點外面、再點齒輪都收起來；點一個打開那張、選單收起來。右上角沒有格式、外觀、匯出了，左下角沒有匯入
    {
    const menuOpen = () => win.evaluate(() => !document.getElementById('settingsMenu').hidden);
    const geo = () => win.evaluate(() => {
      const r = id => document.getElementById(id).getBoundingClientRect().toJSON();
      return { act: r('activity'), gear: r('actSettings'), menu: r('settingsMenu'), exp: document.getElementById('actSettings').getAttribute('aria-expanded') };
    });
    ok('E64 右上角沒有「格式」「外觀」、選單一開始收著', (await win.$$('#center .tools #fmtBtn, #center .tools #skinBtn')).length === 0 && !(await menuOpen()));
    await win.click('#actSettings');
    const g = await geo();
    ok('E64 齒輪在頁籤列最底下；點了彈出選單：貼在頁籤列右邊、底邊跟齒輪對齊、齒輪標開著',
      await menuOpen() && near(g.gear.bottom, g.act.bottom) && g.menu.left >= g.act.right && g.menu.left - g.act.right < 10 && near(g.menu.bottom, g.gear.bottom) && g.exp === 'true',
      JSON.stringify(g));
    // 分類（D098）：一類一個 group、小標題是它的名稱；匯入、匯出從左下角、右上角搬進「資料」
    const cats = () => win.$$eval('#settingsMenu > [role="group"]', gs => gs.map(g => [document.getElementById(g.getAttribute('aria-labelledby')).textContent,
      ...[...g.querySelectorAll('button')].map(b => b.textContent)]));
    ok('E64 選單分兩類：「資料」匯入…、匯出…、備份…；「自訂」格式…、外觀…、語言…（D131）、快捷鍵…（D169）', same(await cats(), [['資料', '匯入…', '匯出…', '備份…'], ['自訂', '格式…', '外觀…', '語言…', '快捷鍵…']]), JSON.stringify(await cats()));
    ok('E64 小標題是第一行、點不到（不是按鈕）', (await win.$$('#settingsMenu > [role="group"] > .menuCat:first-child:not(button)')).length === 2);
    ok('E64 左下角沒有「匯入…」、右上角沒有「匯出…」', (await win.$$('#dirBar #importBtn, #center .tools #exportBtn')).length === 0);
    await win.keyboard.press('Escape');
    ok('E64 Esc：選單收起來、齒輪不標開著', await waitFor(async () => !(await menuOpen()) && (await geo()).exp === 'false'));
    await win.click('#actSettings');
    await win.click('#dayTitle');
    ok('E64 點外面：收起來', await waitFor(async () => !(await menuOpen())));
    await win.click('#actSettings');
    await win.click('#actSettings');
    ok('E64 再點一下齒輪：收起來', await waitFor(async () => !(await menuOpen())));
    await viaSettings(win, '#skinBtn');
    ok('E64 點「外觀…」：打開外觀頁、選單收起來', await waitFor(async () => await win.isVisible('#skin') && !(await menuOpen())));
    await win.keyboard.press('Escape');
    await waitFor(async () => !(await win.isVisible('#skin')));
    }

    // E65：剪貼簿（見 開發筆記 D093，原本叫暫存、D096）——頁籤列第二格；點了左欄換成剪貼簿、再點收起來；新增（放最後面，D126）、點卡片複製（\r\n）、
    // Enter 複製、編輯、刪除＋Ctrl+Z、沒填不存、外面改檔、重新載入、Ctrl+F 換回日記本。最後左欄是打開的日記本，後面的案例要點日期清單
    {
    const snipFile = path.join(data, '剪貼簿.md');
    const toast = async () => (await win.textContent('#toast').catch(() => '')) || '';
    const side = () => win.evaluate(() => {
      const shown = id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0; };
      const r = id => document.getElementById(id).getBoundingClientRect();
      return { journal: document.getElementById('actJournal').classList.contains('on'), snip: document.getElementById('actSnip').classList.contains('on'),
        pane: shown('snipPane'), q: shown('q'), dayList: shown('dayList'), dirBar: shown('dirBar'), days: shown('days') ? r('days').width : null,
        view: localStorage.getItem('daybook.sideView'), off: localStorage.getItem('daybook.sideOff') };
    });
    const snipTitles = () => win.$$eval('#snipList .snip-title', els => els.map(e => e.textContent));
    const g = await win.evaluate(() => ['actJournal', 'actSnip', 'actSettings'].map(id => document.getElementById(id).getBoundingClientRect().top));
    const s0 = await side();
    ok('E65 「剪貼簿」在「日記本」底下、齒輪上面；一開始左欄是日記本、剪貼簿那塊藏著', g[0] < g[1] && g[1] < g[2] && s0.journal && !s0.snip && !s0.pane && s0.q && s0.dayList
      && (await win.getAttribute('#actSnip', 'aria-label')) === '剪貼簿', JSON.stringify({ g, s0 }));
    await win.click('#actSnip');
    const s1 = await side();
    ok('E65 點「剪貼簿」：左欄換成剪貼簿（標題寫「剪貼簿」；搜尋、日期、資料夾藏起來）、寬度照舊；「剪貼簿」選到；記在這台電腦；空的寫怎麼用',
      s1.snip && !s1.journal && s1.pane && !s1.q && !s1.dayList && !s1.dirBar && near(s1.days, 180) && s1.view === 'snip' && s1.off === ''
      && (await win.textContent('.snipHead h2')) === '剪貼簿' && ((await win.textContent('#snipList')) || '').includes('剪貼簿還是空的'), JSON.stringify(s1));

    await win.click('#snipAdd');
    ok('E65 「＋ 新增」：一張新的表單、游標在標題', await waitFor(async () => (await win.evaluate(() => document.activeElement.className)) === 'snip-title-in'));
    await win.keyboard.type('週報開頭');
    await win.keyboard.press('Enter');
    ok('E65 標題按 Enter：換到內文', (await win.evaluate(() => document.activeElement.className)) === 'snip-body-in');
    await win.fill('.snip-body-in', '各位好，\n\n本週進度如下：\n\t1. 程式');
    await win.keyboard.press('Control+Enter');
    ok('E65 Ctrl+Enter 存：剪貼簿.md 標題沒縮排、內文 Tab 縮排、中間空行寫成 Tab；清單有這張',
      await waitFor(async () => readN(snipFile) === '週報開頭\n\t各位好，\n\t\n\t本週進度如下：\n\t\t1. 程式\n' && same(await snipTitles(), ['週報開頭'])), readN(snipFile));
    await win.click('#snipAdd');
    ok('E65 再按「＋ 新增」：表單開在最下面（第一張卡片後面）', await win.evaluate(() => { const l = document.getElementById('snipList');
      return l.children.length === 2 && l.lastElementChild.classList.contains('editing') && !l.firstElementChild.classList.contains('editing'); }));
    await win.fill('.snip-title-in', '測試帳號');
    await win.fill('.snip-body-in', 'cm8 / 1234');
    await win.click('.snip.editing button.save');
    const added65 = '週報開頭\n\t各位好，\n\t\n\t本週進度如下：\n\t\t1. 程式\n測試帳號\n\tcm8 / 1234\n';
    ok('E65 新增的放最後面（檔案、清單都是）', await waitFor(async () => readN(snipFile) === added65 && same(await snipTitles(), ['週報開頭', '測試帳號'])), readN(snipFile));
    await win.click('#snipAdd');
    await win.fill('.snip-body-in', '沒有標題');
    await win.click('.snip.editing button.save');
    ok('E65 沒填標題：提示、不寫、表單還在', await waitFor(async () => (await toast()).includes('標題不能空白'))
      && (await win.$$('.snip.editing')).length === 1 && (await win.inputValue('.snip-body-in')) === '沒有標題' && readN(snipFile) === added65, await toast());
    await win.click('.snip.editing button.cancel');
    ok('E65 取消：表單收起來', await waitFor(async () => (await win.$$('.snip.editing')).length === 0 && same(await snipTitles(), ['週報開頭', '測試帳號'])));

    const card = t => win.locator('#snipList .snip', { hasText: t }).first();
    await card('週報開頭').locator('.snip-copy').click();
    ok('E65 點卡片：複製內文（不含標題），換行是 \\r\\n；提示寫複製了哪一張', await waitFor(async () => fs.existsSync(clipFile)
      && fs.readFileSync(clipFile, 'utf8') === '各位好，\r\n\r\n本週進度如下：\r\n\t1. 程式' && (await toast()).includes('已複製「週報開頭」')),
      fs.existsSync(clipFile) ? JSON.stringify(fs.readFileSync(clipFile, 'utf8')) : '沒有檔');
    // 先等剪貼簿清單 0.5 秒沒再重畫：存檔後資料夾監看約 0.2 秒會把 daybook 自己寫的檔通知回來、再重畫一次清單，
    // 落在 focus 和 Enter 中間的話焦點跟著舊的鈕被拿掉、Enter 沒作用（見 開發筆記 D145）
    await win.evaluate(() => new Promise(res => {
      let t = setTimeout(done, 500);
      const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 500); });
      const cap = setTimeout(done, 5000);
      function done() { clearTimeout(t); clearTimeout(cap); o.disconnect(); res(); }
      o.observe(document.getElementById('snipList'), { childList: true });
    }));
    await card('測試帳號').locator('.snip-copy').focus();
    await win.keyboard.press('Enter');
    ok('E65 用鍵盤選到卡片按 Enter：也是複製', await waitFor(() => fs.readFileSync(clipFile, 'utf8') === 'cm8 / 1234'));

    await card('測試帳號').hover();
    await card('測試帳號').locator('button.edit').click();
    ok('E65 編輯：標題、內文帶原本的，游標在內文', await waitFor(async () => (await win.inputValue('.snip-title-in')) === '測試帳號'
      && (await win.inputValue('.snip-body-in')) === 'cm8 / 1234' && (await win.evaluate(() => document.activeElement.className)) === 'snip-body-in'));
    await win.fill('.snip-body-in', 'cm8 / 5678');
    await win.keyboard.press('Control+Enter');
    ok('E65 編輯存：只換那一筆', await waitFor(() => readN(snipFile) === '週報開頭\n\t各位好，\n\t\n\t本週進度如下：\n\t\t1. 程式\n測試帳號\n\tcm8 / 5678\n'), readN(snipFile));
    const before65 = readN(snipFile);
    await card('週報開頭').hover();
    await card('週報開頭').locator('button.del').click();
    ok('E65 刪除：不跳詢問、拿掉那一筆', await waitFor(async () => readN(snipFile) === '測試帳號\n\tcm8 / 5678\n' && same(await snipTitles(), ['測試帳號'])), readN(snipFile));
    await win.click('#dayTitle');
    await win.keyboard.press('Control+Z');
    ok('E65 Ctrl+Z：刪掉的回來、提示寫「剪貼簿刪除」', await waitFor(async () => readN(snipFile) === before65 && same(await snipTitles(), ['週報開頭', '測試帳號'])
      && (await toast()).includes('已復原：剪貼簿刪除')), readN(snipFile));

    fs.writeFileSync(snipFile, before65 + '外面加的\n\tSELECT 1\n');
    ok('E65 外面改了剪貼簿.md：清單跟著變', await waitFor(async () => same(await snipTitles(), ['週報開頭', '測試帳號', '外面加的'])));
    await win.click('#actJournal');   // 搜尋框在日記本那邊：換過去搜，搜完再換回剪貼簿
    await win.fill('#q', '5678');
    await win.press('#q', 'Enter');
    ok('E65 搜尋不搜剪貼簿；日期清單不列剪貼簿.md', await waitFor(async () => (await headTitle()).startsWith('搜尋「5678」') && (await win.$$('#results .card')).length === 0)
      && !(await win.$$eval('#dayList button', bs => bs.map(b => b.textContent).join('|'))).includes('剪貼簿'));
    await win.press('#q', 'Escape');
    await win.click('#actSnip');
    await win.reload();
    await waitFor(async () => (await headTitle()).includes(today));
    const s2 = await side();
    ok('E65 重新載入：一開起來就是剪貼簿', s2.snip && s2.pane && !s2.q && await waitFor(async () => same(await snipTitles(), ['週報開頭', '測試帳號', '外面加的'])), JSON.stringify(s2));
    await win.click('#actSnip');
    const s3 = await side();
    ok('E65 再點「剪貼簿」：左欄收起來、兩個都不算選到', s3.days == null && !s3.snip && !s3.journal && s3.off === '1', JSON.stringify(s3));
    await win.click('#actSnip');
    await win.click('#dayTitle');
    await win.keyboard.press('Control+F');
    const s4 = await side();
    ok('E65 放剪貼簿時按 Ctrl+F：換回日記本、游標在搜尋框', s4.journal && !s4.snip && s4.q && !s4.pane && s4.view === '' && s4.off === ''
      && (await win.evaluate(() => document.activeElement.id)) === 'q', JSON.stringify(s4));
    await win.press('#q', 'Escape');
    }

    // E66：剪貼簿的日期符號（見 開發筆記 D094）——編輯時預覽；檔案存符號；卡片上照寫的顯示、只有符號那段標顏色；
    // 點了複製當下的日期時間（{0} 不動）。分鐘可能剛好跳過去：按之前、之後的時間都算對。最後換回日記本
    {
    const snipFile = path.join(data, '剪貼簿.md');
    const pad = n => String(n).padStart(2, '0');
    const stamp = d => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const preview = () => win.evaluate(() => { const p = document.querySelector('.snip-preview'); return p && p.getClientRects().length ? p.textContent : null; });
    await win.click('#actSnip');
    await win.click('#snipAdd');
    await win.fill('.snip-title-in', '紀錄開頭');
    await win.fill('.snip-body-in', '沒有符號 {0}');
    const pv0 = await preview();
    const t1 = new Date();
    await win.fill('.snip-body-in', '[{yyyy.MM.dd HH:mm} cm8]\nstring.Format("{0}", x)');
    const pv1 = await preview(), t2 = new Date();
    ok('E66 編輯時：沒有符號不預覽；有符號，內文底下預覽複製出去的樣子', pv0 === null && [t1, t2].some(t => pv1 === `複製時：[${stamp(t)} cm8]\nstring.Format("{0}", x)`), JSON.stringify({ pv0, pv1 }));
    await win.keyboard.press('Control+Enter');
    ok('E66 檔案裡存的是符號（照寫的）', await waitFor(() => (readN(snipFile) || '').endsWith('\n紀錄開頭\n\t[{yyyy.MM.dd HH:mm} cm8]\n\tstring.Format("{0}", x)\n')), readN(snipFile));
    const c66 = win.locator('#snipList .snip', { hasText: '紀錄開頭' }).first();
    const look = await c66.evaluate(b => ({ body: b.querySelector('.snip-body').textContent, dates: [...b.querySelectorAll('.snip-date')].map(e => e.textContent),
      colors: [getComputedStyle(b.querySelector('.snip-date')).color, getComputedStyle(b.querySelector('.snip-body')).color] }));
    ok('E66 卡片上照寫的顯示，只有 {yyyy.MM.dd HH:mm} 那段換顏色（{0} 不算）',
      look.body === '[{yyyy.MM.dd HH:mm} cm8]\nstring.Format("{0}", x)' && same(look.dates, ['{yyyy.MM.dd HH:mm}']) && look.colors[0] !== look.colors[1], JSON.stringify(look));
    const a = new Date();
    await c66.locator('.snip-copy').click();
    const want = t => `[${stamp(t)} cm8]\r\nstring.Format("{0}", x)`;
    ok('E66 點卡片：符號換成當下的日期時間、{0} 照原樣', await waitFor(() => [a, new Date()].some(t => fs.readFileSync(clipFile, 'utf8') === want(t))),
      JSON.stringify(fs.readFileSync(clipFile, 'utf8')));
    await win.click('#actJournal');
    }

    // E67：編輯表單的「日期符號 ▸」（見 開發筆記 D095）——一開始收著；點了展開符號表、例子；點例子插在內文游標的位置、游標留在內文、預覽跟著變；
    // 內文裡 Ctrl+Z 拿掉插的；再點收起來。不存，取消。最後換回日記本
    {
    const helpOpen = () => win.evaluate(() => { const h = document.querySelector('.snip-help'); return !!h && h.getClientRects().length > 0; });
    await win.click('#actSnip');
    await win.click('#snipAdd');
    ok('E67 新增表單有「日期符號 ▸」、說明收著', (await win.textContent('.snip-help-toggle')) === '日期符號 ▸' && !(await helpOpen()));
    await win.click('.snip-help-toggle');
    const h = await win.evaluate(() => ({ syms: [...document.querySelectorAll('.snip-syms code')].map(e => e.textContent),
      ex: [...document.querySelectorAll('.snip-ins button')].map(e => e.textContent), toggle: document.querySelector('.snip-help-toggle').textContent }));
    ok('E67 點了展開：六個符號、三個例子，變「日期符號 ▾」', await helpOpen() && h.toggle === '日期符號 ▾'
      && same(h.syms, ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss']) && same(h.ex, ['{yyyy.MM.dd HH:mm}', '{yyyy-MM-dd}', '{M/d}']), JSON.stringify(h));
    await win.fill('.snip-body-in', '到期 （）');
    await win.evaluate(() => { const b = document.querySelector('.snip-body-in'); b.focus(); b.setSelectionRange(4, 4); });   // 游標放在括號中間
    await win.click('.snip-ins button:has-text("{M/d}")');
    const now67 = new Date();
    ok('E67 點例子：插在游標的位置、游標還在內文（插的後面）、預覽跟著變',
      (await win.inputValue('.snip-body-in')) === '到期 （{M/d}）'
      && same(await win.evaluate(() => [document.activeElement.className, document.activeElement.selectionStart]), ['snip-body-in', 9])
      && ((await win.textContent('.snip-preview')) || '').startsWith(`複製時：到期 （${now67.getMonth() + 1}/`), await win.inputValue('.snip-body-in'));
    await win.keyboard.press('Control+Z');
    ok('E67 內文裡 Ctrl+Z：拿掉插的', await waitFor(async () => (await win.inputValue('.snip-body-in')) === '到期 （）'), await win.inputValue('.snip-body-in'));
    await win.click('.snip-help-toggle');
    ok('E67 再點：收起來', !(await helpOpen()) && (await win.textContent('.snip-help-toggle')) === '日期符號 ▸');
    await win.click('.snip.editing button.cancel');
    await waitFor(async () => (await win.$$('.snip.editing')).length === 0);
    await win.click('#actJournal');
    }

    // E68：舊檔名 暫存.md（見 開發筆記 D096）——兩個都有：用剪貼簿.md、舊的不動；只剩舊的：改名成剪貼簿.md、清單照讀。最後換回日記本
    {
    const snipFile = path.join(data, '剪貼簿.md'), oldFile = path.join(data, '暫存.md');
    const snipTitles = () => win.$$eval('#snipList .snip-title', els => els.map(e => e.textContent));
    const cur = readN(snipFile);
    fs.writeFileSync(oldFile, '舊的\n\t舊內容\n');
    await win.reload();
    await waitFor(async () => (await headTitle()).includes(today));
    await win.click('#actSnip');
    ok('E68 兩個都有：用剪貼簿.md、暫存.md 不動', await waitFor(async () => (await snipTitles()).length > 0 && !(await snipTitles()).includes('舊的'))
      && readN(snipFile) === cur && readN(oldFile) === '舊的\n\t舊內容\n', JSON.stringify(await snipTitles()));
    fs.rmSync(snipFile);
    ok('E68 只剩暫存.md：改名成剪貼簿.md、清單照讀', await waitFor(async () => same(await snipTitles(), ['舊的']) && !fs.existsSync(oldFile) && readN(snipFile) === '舊的\n\t舊內容\n'),
      JSON.stringify({ titles: await snipTitles(), old: fs.existsSync(oldFile), snip: readN(snipFile) }));
    await win.click('#actJournal');
    }

    // E86：剪貼簿調順序（見 開發筆記 D125）——拖到最後一張的下半（插在最後面）；拖的時候放開的位置畫線、拖到第一張的上半（插在最前面）；
    // Alt+↓ 搬一格、游標跟著那張；到底再 Alt+↓ 不動、Alt+↑；Ctrl+Z 復原；有一張在編輯時 Alt+↑ 不搬、提示。最後剪貼簿.md 放回原樣（E78 要用）、換回日記本
    {
    const snipFile = path.join(data, '剪貼簿.md');
    const toast = async () => (await win.textContent('#toast').catch(() => '')) || '';
    const snipTitles = () => win.$$eval('#snipList .snip-title', els => els.map(e => e.textContent));
    const card = t => win.locator('#snipList .snip', { hasText: t }).first();
    const focusText = () => win.evaluate(() => document.activeElement.textContent);
    const cur = readN(snipFile);
    const A = 'A 第一\n\t一\n', B = 'B 第二\n\t二\n', C = 'C 第三\n\t三\n';
    fs.writeFileSync(snipFile, A + B + C);
    await win.click('#actSnip');
    await waitFor(async () => same(await snipTitles(), ['A 第一', 'B 第二', 'C 第三']));
    const c1 = await card('C 第三').boundingBox();
    await card('A 第一').dragTo(card('C 第三'), { targetPosition: { x: 20, y: c1.height - 4 } });
    ok('E86 拖到最後一張的下半：插在最後面（檔案、清單都是）', await waitFor(async () => readN(snipFile) === B + C + A && same(await snipTitles(), ['B 第二', 'C 第三', 'A 第一'])), readN(snipFile));

    const b2 = await card('B 第二').boundingBox(), c2 = await card('C 第三').boundingBox();
    await win.mouse.move(c2.x + 20, c2.y + c2.height / 2);
    await win.mouse.down();
    await win.mouse.move(b2.x + 20, b2.y + 4, { steps: 5 });
    await win.mouse.move(b2.x + 21, b2.y + 4);   // 只移到那裡就看會沒線（滑進新元素那一下沒發 dragover），同一個位置再移 1px（見 開發筆記 D125）
    const mark = await win.$$eval('#snipList .snip', els => els.map(e => e.classList.contains('drop-before') ? 'before' : e.classList.contains('drop-after') ? 'after' : ''));
    await win.mouse.up();
    ok('E86 拖的時候：放開的位置畫線（第一張的上緣）', same(mark, ['before', '', '']), JSON.stringify(mark));
    ok('E86 拖到第一張的上半：插在最前面', await waitFor(async () => readN(snipFile) === C + B + A && same(await snipTitles(), ['C 第三', 'B 第二', 'A 第一'])), readN(snipFile));

    await card('C 第三').locator('.snip-copy').focus();
    await win.keyboard.press('Alt+ArrowDown');
    ok('E86 Alt+↓：往下搬一格、游標跟著那張', await waitFor(async () => readN(snipFile) === B + C + A && same(await snipTitles(), ['B 第二', 'C 第三', 'A 第一'])
      && (await focusText()).startsWith('C 第三')), readN(snipFile));
    await win.keyboard.press('Alt+ArrowDown');
    await waitFor(async () => readN(snipFile) === B + A + C && (await focusText()).startsWith('C 第三'));
    await win.keyboard.press('Alt+ArrowDown');
    await win.keyboard.press('Alt+ArrowUp');
    ok('E86 到底再 Alt+↓ 不動（不報錯）；Alt+↑ 往上一格', await waitFor(async () => readN(snipFile) === B + C + A && same(await snipTitles(), ['B 第二', 'C 第三', 'A 第一'])
      && (await focusText()).startsWith('C 第三')) && !(await toast()).includes('沒有那個位置'), JSON.stringify({ file: readN(snipFile), toast: await toast() }));
    await win.keyboard.press('Control+Z');
    ok('E86 Ctrl+Z：復原上一次搬、提示寫「剪貼簿搬移」', await waitFor(async () => readN(snipFile) === B + A + C && same(await snipTitles(), ['B 第二', 'A 第一', 'C 第三'])
      && (await toast()).includes('已復原：剪貼簿搬移')), readN(snipFile));

    await card('A 第一').hover();
    await card('A 第一').locator('button.edit').click();
    await waitFor(async () => (await win.$$('.snip.editing')).length === 1);
    await card('C 第三').locator('.snip-copy').focus();
    await win.keyboard.press('Alt+ArrowUp');
    ok('E86 有一張在編輯時 Alt+↑：不搬、提示、表單還在', await waitFor(async () => (await toast()).includes('先儲存或取消正在編輯的那張'))
      && readN(snipFile) === B + A + C && (await win.$$('.snip.editing')).length === 1, JSON.stringify({ file: readN(snipFile), toast: await toast() }));
    await win.click('.snip.editing button.cancel');
    fs.writeFileSync(snipFile, cur);
    await waitFor(async () => (await win.$$('.snip.editing')).length === 0 && same(await snipTitles(), ['舊的']));
    await win.click('#actJournal');
    }

    // E136：剪貼簿一張在編輯時，別張的「刪除」「編輯」、「＋ 新增」不做、提示（見 開發筆記 D174）——不然刪、存完整份重畫，打到一半的那張被洗掉。
    // 每一步重新放 A、B 兩張；最後剪貼簿.md 放回原樣（E78 要用）、換回日記本
    {
    const snipFile = path.join(data, '剪貼簿.md');
    const toast = async () => (await win.textContent('#toast').catch(() => '')) || '';
    const snipTitles = () => win.$$eval('#snipList .snip-title', els => els.map(e => e.textContent));
    const card = t => win.locator('#snipList .snip', { hasText: t }).first();
    const editingN = async () => (await win.$$('.snip.editing')).length;
    const cur = readN(snipFile);
    const A = 'A 第一\n\t一\n', B = 'B 第二\n\t二\n';
    await win.click('#actSnip');
    for (const [name, act] of [
      ['編輯', async () => { await card('B 第二').hover(); await card('B 第二').locator('button.edit').click(); }],
      ['＋ 新增', () => win.click('#snipAdd')],
      ['刪除', async () => { await card('B 第二').hover(); await card('B 第二').locator('button.del').click(); }],
    ]) {
      fs.writeFileSync(snipFile, A + B);
      await waitFor(async () => same(await snipTitles(), ['A 第一', 'B 第二']) && (await editingN()) === 0);
      await card('A 第一').hover();
      await card('A 第一').locator('button.edit').click();
      await win.fill('.snip.editing .snip-title-in', 'A 改到一半');
      await win.evaluate(() => { document.getElementById('toast').textContent = ''; });
      await act();
      ok(`E136 剪貼簿一張在編輯時按別張的「${name}」：不做、提示先儲存或取消，打到一半的還在`,
        await waitFor(async () => (await toast()).includes('先儲存或取消正在編輯的那張')) && readN(snipFile) === A + B && (await editingN()) === 1
        && (await win.inputValue('.snip.editing .snip-title-in').catch(() => '')) === 'A 改到一半',
        JSON.stringify({ file: readN(snipFile), toast: await toast(), editing: await editingN() }));
      for (let i = 0; i < 3 && await editingN(); i++) {
        await win.evaluate(() => document.querySelector('.snip.editing button.cancel')?.click());
        await sleep(200);
      }
    }
    fs.writeFileSync(snipFile, cur);
    await waitFor(async () => (await editingN()) === 0 && same(await snipTitles(), ['舊的']));
    await win.click('#actJournal');
    }

    // E87：卡片多到要捲時新增（見 開發筆記 D126）——表單開在最下面、捲到看得到整張；存了新的那張在最後、還看得到。
    // 最後剪貼簿.md 放回原樣（E78 要用）、換回日記本
    {
    const snipFile = path.join(data, '剪貼簿.md');
    const snipTitles = () => win.$$eval('#snipList .snip-title', els => els.map(e => e.textContent));
    const cur = readN(snipFile);
    const many = Array.from({ length: 30 }, (_, i) => `第${i + 1}張\n\t內文${i + 1}\n`).join('');
    fs.writeFileSync(snipFile, many);
    await win.click('#actSnip');
    await waitFor(async () => (await snipTitles()).length === 30);
    // 那一塊整個在清單看得到的範圍裡（上下緣都在裡面）
    const seen = sel => win.evaluate(sel => { const l = document.getElementById('snipList').getBoundingClientRect(), b = document.querySelector(sel).getBoundingClientRect();
      return b.top >= l.top - 1 && b.bottom <= l.bottom + 1; }, sel);
    // 清單限高 300px（像視窗很矮時）：游標進標題時 Chromium 只把標題捲到中間，表單（約 200px）下半會被切掉，沒捲到底就分得出來
    await win.evaluate(() => { document.getElementById('snipList').style.maxHeight = '300px'; });
    const pre = await win.evaluate(() => { const l = document.getElementById('snipList'); return { top: l.scrollTop, over: l.scrollHeight > l.clientHeight * 1.5 }; });
    await win.click('#snipAdd');
    ok('E87 卡片多到要捲時「＋ 新增」：表單開在最下面、捲到看得到整張、游標在標題（前提：要捲、原本捲在最上面；清單限高 300px）', pre.over && pre.top === 0
      && await win.evaluate(() => document.getElementById('snipList').lastElementChild.classList.contains('editing')) && await seen('.snip.editing')
      && (await win.evaluate(() => document.activeElement.className)) === 'snip-title-in', JSON.stringify(pre));
    await win.fill('.snip-title-in', '新的那張');
    await win.fill('.snip-body-in', '新內文');
    await win.keyboard.press('Control+Enter');
    ok('E87 存了：新的那張在最後（檔案、清單），還看得到', await waitFor(async () => readN(snipFile) === many + '新的那張\n\t新內文\n'
      && (await snipTitles()).length === 31 && (await snipTitles())[30] === '新的那張') && await seen('#snipList > .snip:last-child'), readN(snipFile));
    await win.evaluate(() => { document.getElementById('snipList').style.maxHeight = ''; });
    fs.writeFileSync(snipFile, cur);
    await waitFor(async () => same(await snipTitles(), ['舊的']));
    await win.click('#actJournal');
    }

    // E88：剪貼簿內文頭尾的空白、空行原封不動（見 開發筆記 D127）——新增時內文前面空行、前後空白、最後換行；存了檔案照寫（空行寫成只有 Tab）；
    // 點卡片複製出去一模一樣（\r\n）；編輯時內文帶原本的。最後剪貼簿.md 放回原樣（E78 要用）、換回日記本
    {
    const snipFile = path.join(data, '剪貼簿.md');
    const snipTitles = () => win.$$eval('#snipList .snip-title', els => els.map(e => e.textContent));
    const cur = readN(snipFile);
    const body = '\n  前後空白  \n';
    await win.click('#actSnip');
    await win.click('#snipAdd');
    await win.fill('.snip-title-in', '頭尾');
    await win.fill('.snip-body-in', body);
    await win.keyboard.press('Control+Enter');
    ok('E88 存了：頭尾的空行、空白照寫（空行寫成只有 Tab）', await waitFor(() => readN(snipFile) === cur + '頭尾\n\t\n\t  前後空白  \n\t\n'), JSON.stringify(readN(snipFile)));
    const c88 = win.locator('#snipList .snip', { hasText: '頭尾' }).first();
    fs.rmSync(clipFile, { force: true });
    await c88.locator('.snip-copy').click();
    ok('E88 點卡片：複製出去一模一樣（換行 \\r\\n）', await waitFor(() => fs.existsSync(clipFile) && fs.readFileSync(clipFile, 'utf8') === '\r\n  前後空白  \r\n'),
      fs.existsSync(clipFile) ? JSON.stringify(fs.readFileSync(clipFile, 'utf8')) : '沒有檔');
    await c88.hover();
    await c88.locator('button.edit').click();
    ok('E88 編輯：內文帶原本的（頭尾的空行、空白都在）', await waitFor(async () => (await win.inputValue('.snip-body-in')) === body), JSON.stringify(await win.inputValue('.snip-body-in')));
    await win.click('.snip.editing button.cancel');
    await waitFor(async () => (await win.$$('.snip.editing')).length === 0);
    fs.writeFileSync(snipFile, cur);
    await waitFor(async () => same(await snipTitles(), ['舊的']));
    await win.click('#actJournal');
    }

    // E150：剪貼簿分類（見 開發筆記 D195）——沒分類的在最上面、一個分類一段，分類裡的卡片點一下就複製；點分類那行收起來（寫幾張、記在這台電腦、重新載入還收著）；
    // Alt+↓ 越過收著的分類那行搬進去（放最後面、打開它）；Alt+↑ 越過分類那行換到上一段、Alt+↓ 回來；拖到別的分類兩張中間；有一張在編輯時點分類那行不收；
    // 分類的「＋」（表單開在那一段最後面）、「＋ 新增」（沒分類那段）；「＋ 分類」（Esc 取消、同名不給、Enter 加在最後面）；改名；刪分類（卡片搬到最上面）、Ctrl+Z。
    // 最後剪貼簿.md 放回原樣（E78 要用）、換回日記本
    {
    const snipFile = path.join(data, '剪貼簿.md');
    const toast = async () => (await win.textContent('#toast').catch(() => '')) || '';
    const clearToast = () => win.evaluate(() => { document.getElementById('toast').textContent = ''; });
    // 清單由上到下：卡片寫標題、分類那行寫「#名稱」（收著的多寫「 (幾張)」）
    const rows = () => win.$$eval('#snipList > *', els => els.map(e => e.classList.contains('snip-cat')
      ? '#' + e.querySelector('.snip-cat-text').textContent + (e.querySelector('.snip-cat-n') ? ' ' + e.querySelector('.snip-cat-n').textContent : '')
      : e.querySelector('.snip-title')?.textContent ?? (e.classList.contains('editing') ? '（表單）' : '')));
    const card = t => win.locator('#snipList .snip', { hasText: t }).first();
    const cat = t => win.locator('#snipList .snip-cat', { hasText: t }).first();
    const focusText = () => win.evaluate(() => document.activeElement.textContent);
    const editingN = async () => (await win.$$('#snipList .editing')).length;
    const cur = readN(snipFile);
    const A = 'A 沒分類\n\t一\n', B = 'B 工作一\n\t二\n', C = 'C 工作二\n\t三\n', D = 'D 私人\n\t四\n';
    fs.writeFileSync(snipFile, A + '# 工作\n' + B + C + '# 私人\n' + D);
    await win.click('#actSnip');
    ok('E150 沒分類的在最上面（沒有分類那行），底下一個分類一行＋它的卡片', await waitFor(async () => same(await rows(), ['A 沒分類', '#工作', 'B 工作一', 'C 工作二', '#私人', 'D 私人'])),
      JSON.stringify(await rows()));
    fs.rmSync(clipFile, { force: true });
    await card('C 工作二').locator('.snip-copy').click();
    ok('E150 分類裡的卡片點一下就複製（不用先點分類）', await waitFor(() => fs.existsSync(clipFile) && fs.readFileSync(clipFile, 'utf8') === '三'));

    await cat('工作').locator('.snip-cat-name').click();
    ok('E150 點分類那行：收起來（卡片不畫、寫幾張、▸）、記在這台電腦', await waitFor(async () => same(await rows(), ['A 沒分類', '#工作 (2)', '#私人', 'D 私人'])
      && (await cat('工作').locator('.snip-cat-arrow').textContent()) === '▸')
      && same(await win.evaluate(() => JSON.parse(localStorage.getItem('daybook.snipFold'))), ['工作']), JSON.stringify(await rows()));
    await win.reload();
    ok('E150 重新載入：還收著', await waitFor(async () => same(await rows(), ['A 沒分類', '#工作 (2)', '#私人', 'D 私人'])), JSON.stringify(await rows()));

    await card('A 沒分類').locator('.snip-copy').focus();
    await win.keyboard.press('Alt+ArrowDown');
    ok('E150 Alt+↓ 越過收著的分類那行：搬進那個分類（放最後面），那個分類打開、游標跟著', await waitFor(async () => readN(snipFile) === '# 工作\n' + B + C + A + '# 私人\n' + D
      && same(await rows(), ['#工作', 'B 工作一', 'C 工作二', 'A 沒分類', '#私人', 'D 私人']) && (await focusText()).startsWith('A 沒分類')), readN(snipFile));
    await card('B 工作一').locator('.snip-copy').focus();
    await win.keyboard.press('Alt+ArrowUp');
    ok('E150 分類第一張 Alt+↑ 越過分類那行：換到上一段（沒分類）的最後面、游標跟著', await waitFor(async () => readN(snipFile) === B + '# 工作\n' + C + A + '# 私人\n' + D
      && same(await rows(), ['B 工作一', '#工作', 'C 工作二', 'A 沒分類', '#私人', 'D 私人']) && (await focusText()).startsWith('B 工作一')), readN(snipFile));
    await win.keyboard.press('Alt+ArrowDown');
    ok('E150 再 Alt+↓：回到那個分類的第一張', await waitFor(async () => readN(snipFile) === '# 工作\n' + B + C + A + '# 私人\n' + D && (await focusText()).startsWith('B 工作一')), readN(snipFile));
    await card('D 私人').dragTo(card('A 沒分類'), { targetPosition: { x: 20, y: 4 } });
    ok('E150 拖到別的分類兩張中間：換到那個分類（檔案、清單）', await waitFor(async () => readN(snipFile) === '# 工作\n' + B + C + D + A + '# 私人\n'
      && same(await rows(), ['#工作', 'B 工作一', 'C 工作二', 'D 私人', 'A 沒分類', '#私人'])), readN(snipFile));

    await card('B 工作一').hover();
    await card('B 工作一').locator('button.edit').click();
    await waitFor(async () => (await editingN()) === 1);
    await clearToast();
    await cat('工作').locator('.snip-cat-name').click();
    ok('E150 有一張在編輯時點分類那行：不收、提示、表單還在', await waitFor(async () => (await toast()).includes('先儲存或取消正在編輯的那張'))
      && (await editingN()) === 1 && (await rows()).includes('#工作'), JSON.stringify(await rows()));
    await win.click('.snip.editing button.cancel');
    await waitFor(async () => (await editingN()) === 0);

    await cat('工作').hover();
    await cat('工作').locator('button.add').click();
    ok('E150 分類的「＋」：表單開在那一段最後面（下一個分類那行前面）、游標在標題', await waitFor(async () => same(await rows(), ['#工作', 'B 工作一', 'C 工作二', 'D 私人', 'A 沒分類', '（表單）', '#私人'])
      && (await win.evaluate(() => document.activeElement.className)) === 'snip-title-in'), JSON.stringify(await rows()));
    await win.fill('.snip-title-in', 'E 工作三');
    await win.fill('.snip-body-in', '五');
    await win.keyboard.press('Control+Enter');
    const E = 'E 工作三\n\t五\n';
    ok('E150 存了：放進那個分類的最後面', await waitFor(async () => readN(snipFile) === '# 工作\n' + B + C + D + A + E + '# 私人\n'), readN(snipFile));
    await win.click('#snipAdd');
    ok('E150 有分類時「＋ 新增」：表單開在沒分類那段（第一個分類那行前面）', await waitFor(async () => same((await rows()).slice(0, 2), ['（表單）', '#工作'])), JSON.stringify(await rows()));
    await win.fill('.snip-title-in', 'F 沒分類');
    await win.fill('.snip-body-in', '六');
    await win.keyboard.press('Control+Enter');
    const F = 'F 沒分類\n\t六\n';
    ok('E150 存了：放在第一個分類前面', await waitFor(async () => readN(snipFile) === F + '# 工作\n' + B + C + D + A + E + '# 私人\n'), readN(snipFile));

    const s0 = readN(snipFile);
    await waitFor(async () => (await editingN()) === 0);
    await win.click('#snipCatAdd');
    await waitFor(async () => (await win.evaluate(() => document.activeElement.className)) === 'snip-cat-in');
    await win.keyboard.type('不要的');
    await win.keyboard.press('Escape');
    ok('E150 「＋ 分類」按 Esc：不加、輸入框收掉', await waitFor(async () => (await editingN()) === 0 && same((await rows()).filter(r => r.startsWith('#')), ['#工作', '#私人'])) && readN(snipFile) === s0,
      JSON.stringify(await rows()));
    await win.click('#snipCatAdd');
    await waitFor(async () => (await win.evaluate(() => document.activeElement.className)) === 'snip-cat-in');
    await clearToast();
    await win.keyboard.type('工作');
    await win.keyboard.press('Enter');
    ok('E150 「＋ 分類」打已經有的名稱：提示、不加、框留著改', await waitFor(async () => (await toast()).includes('已經有「工作」這個分類')) && readN(snipFile) === s0
      && (await win.evaluate(() => document.activeElement.className)) === 'snip-cat-in', JSON.stringify(await toast()));
    await win.fill('.snip-cat-in', '其他');
    await win.keyboard.press('Enter');
    ok('E150 「＋ 分類」Enter：「# 名稱」加在檔案最後面、清單最下面多一行', await waitFor(async () => readN(snipFile) === s0 + '# 其他\n' && (await rows()).at(-1) === '#其他' && (await editingN()) === 0),
      readN(snipFile));
    await cat('私人').hover();
    await cat('私人').locator('button.edit').click();
    await waitFor(async () => (await win.inputValue('.snip-cat-in').catch(() => '')) === '私人');
    await win.fill('.snip-cat-in', '家裡');
    await win.keyboard.press('Enter');
    const s1 = F + '# 工作\n' + B + C + D + A + E + '# 家裡\n# 其他\n';
    ok('E150 分類改名：只換那一行', await waitFor(async () => readN(snipFile) === s1 && (await rows()).includes('#家裡')), readN(snipFile));
    await cat('工作').hover();
    await cat('工作').locator('button.del').click();
    ok('E150 刪分類：不跳詢問，卡片搬到最上面沒分類那段的最後面、分類那行拿掉，提示 Ctrl+Z', await waitFor(async () => readN(snipFile) === F + B + C + D + A + E + '# 家裡\n# 其他\n'
      && same(await rows(), ['F 沒分類', 'B 工作一', 'C 工作二', 'D 私人', 'A 沒分類', 'E 工作三', '#家裡', '#其他']) && (await toast()).includes('已刪除分類「工作」')), readN(snipFile));
    await win.keyboard.press('Control+Z');
    ok('E150 Ctrl+Z：分類和卡片都回來、提示寫「剪貼簿刪除分類」', await waitFor(async () => readN(snipFile) === s1 && (await rows()).includes('#工作')
      && (await toast()).includes('已復原：剪貼簿刪除分類')), readN(snipFile));

    fs.writeFileSync(snipFile, cur);
    await waitFor(async () => same(await rows(), ['舊的']));
    await win.click('#actJournal');
    }

    // E72：記事本（見 開發筆記 D102、D105、D116）——中間換成記事本、左欄換成記事清單；＋ 開新記事（先不建檔）、打字不寫檔（頁籤 ●、暫存到這台電腦）、
    // Ctrl+S 取名存檔（不行的名稱）、有名字的 Ctrl+S 才存、換一份、重新載入沒存的還在、改名（跟新記事同名、Esc）、
    // × 新記事（有字問存／不存／取消，沒字直接關）、× 有名字的改過沒存問了再存再關、清單上點開預覽、清單上的 × 丟資源回收筒（沒存的先寫進去）、
    // 外面改了檔（沒改過的跟著變、改過的留著、刪掉了照名稱再存）；再點「記事本」收起／打開清單（Ctrl+F 改成找字，見 E74；剪貼簿見 E78；清單、資料夾見 E80；找記事、F2、Delete、右鍵見 E81）。
    // 最後點日記本回到日記、左欄打開日記本，後面的案例要點日期清單
    {
    const noteDir = path.join(data, '記事本');
    // 沒存的暫存（D105）：Chromium 使用者資料那個資料夾的 note-backup\，檔名是紀錄資料夾路徑的雜湊（跟 main.js 同一個算法）
    const backupFile = path.join(devProfile(data), 'note-backup', crypto.createHash('md5').update(path.resolve(data).toLowerCase()).digest('hex').slice(0, 8) + '.json');
    const backup = () => { try { return JSON.parse(fs.readFileSync(backupFile, 'utf8')); } catch { return null; } };
    const toast = async () => (await win.textContent('#toast').catch(() => '')) || '';
    // 頁籤上的名稱（同名的後面那個「在哪個資料夾」不算，D116）
    const noteNames = () => win.$$eval('#noteTabs .noteName', els => els.map(e => e.firstChild?.textContent ?? ''));
    const curNote = () => win.$eval('#noteTabs .noteTab.on .noteName', e => e.firstChild?.textContent ?? '').catch(() => null);
    const dirtyNames = () => win.$$eval('#noteTabs .noteTab.dirty .noteName', els => els.map(e => e.firstChild?.textContent ?? ''));
    const previewName = () => win.$eval('#noteTabs .noteTab.preview .noteName', e => e.firstChild?.textContent ?? '').catch(() => null);
    // 記事清單（D116）：一行一個 key（f: 記事、d: 資料夾＋相對路徑）
    const listKeys = () => win.$$eval('#noteTree .nlRow', rs => rs.map(r => r.dataset.key));
    const rowSel = k => `#noteTree .nlRow[data-key="${k}"]`;
    const rowTool = async (k, i) => { await win.hover(rowSel(k)); await win.click(`${rowSel(k)} .nlTools button:nth-child(${i})`); };   // 1 改名、2 刪除
    const noteText = () => win.inputValue('#noteText');
    const saveState = () => win.textContent('#noteSave');
    const caretEnd = () => win.evaluate(() => { const a = document.getElementById('noteText'); a.focus(); a.setSelectionRange(a.value.length, a.value.length); });
    const shown = sel => win.isVisible(sel);
    const isOn = id => win.$eval(id, b => b.classList.contains('on'));
    await win.click('#actNote');
    ok('E72 點「記事本」：中間換成記事本、左欄換成記事清單（日記本的藏著）、頁籤選到；還沒有記事寫怎麼新增、不建資料夾',
      await waitFor(async () => await shown('#notePane') && !(await shown('#center')) && await shown('#noteList') && !(await shown('#q')) && !(await shown('#snipPane'))
        && await shown('#noteEmpty') && !(await shown('#noteText')))
      && await isOn('#actNote') && !(await isOn('#actJournal')) && !fs.existsSync(noteDir));
    await win.click('#noteAdd');
    ok('E72 ＋：開「新記事 1」、頁籤選到、游標在文字框；先不建檔',
      await waitFor(async () => same(await noteNames(), ['新記事 1']) && (await curNote()) === '新記事 1' && await win.evaluate(() => document.activeElement.id === 'noteText')) && !fs.existsSync(noteDir),
      JSON.stringify(await noteNames()));
    await win.keyboard.type('第一行\n');
    await win.keyboard.press('Tab');
    await win.keyboard.type('縮排');
    ok('E72 新記事打字：不寫檔、頁籤標 ●、寫「未存檔」；停手 0.6 秒暫存到這台電腦（Tab 是縮排）',
      await waitFor(() => same(backup()?.untitled, [{ name: '新記事 1', text: '第一行\n\t縮排', folder: '' }])) && !fs.existsSync(noteDir)
      && same(await dirtyNames(), ['新記事 1']) && (await saveState()) === '未存檔', JSON.stringify(backup()));
    await win.keyboard.press('Control+s');
    ok('E72 新記事 Ctrl+S：頁籤變成取名的框、預設是第一行', await waitFor(async () => await shown('.note-rename') && (await win.inputValue('.note-rename')) === '第一行'));
    await win.press('.note-rename', 'Escape');
    ok('E72 取名按 Esc：不存、還是新記事', await waitFor(async () => !(await shown('.note-rename')) && same(await noteNames(), ['新記事 1'])) && !fs.existsSync(noteDir));
    await win.keyboard.press('Control+s');
    await win.waitForSelector('.note-rename');
    await win.fill('.note-rename', 'a/b');
    await win.press('.note-rename', 'Enter');
    ok('E72 取名有 /：提示、框留著、沒建檔', await waitFor(async () => (await toast()).includes('名稱不能有')) && await shown('.note-rename') && !fs.existsSync(noteDir), await toast());
    await win.fill('.note-rename', '  備忘 ');
    await win.press('.note-rename', 'Enter');
    const fMemo = path.join(noteDir, '備忘.txt');
    ok('E72 取名存檔：頭尾空白去掉、建檔（內容是打的字）、頁籤換成名稱、● 拿掉、寫「已存檔」、暫存清掉',
      await waitFor(async () => readN(fMemo) === '第一行\n\t縮排' && same(await noteNames(), ['備忘']) && (await curNote()) === '備忘' && (await dirtyNames()).length === 0 && (await saveState()) === '已存檔')
      && await waitFor(() => !fs.existsSync(backupFile)), JSON.stringify({ names: await noteNames(), backup: backup() }));
    await caretEnd();
    await win.keyboard.type('X');
    ok('E72 有名字的打字：標 ●、暫存起來；停手也不寫檔',
      await waitFor(async () => same(await dirtyNames(), ['備忘']) && (await saveState()) === '未存檔' && same(backup()?.dirty, [{ name: '備忘', text: '第一行\n\t縮排X' }]))
      && await sleep(900).then(() => readN(fMemo) === '第一行\n\t縮排'), JSON.stringify(readN(fMemo)));
    await win.keyboard.press('Control+s');
    ok('E72 Ctrl+S：寫進檔案、● 拿掉', await waitFor(async () => readN(fMemo) === '第一行\n\t縮排X' && (await dirtyNames()).length === 0 && (await saveState()) === '已存檔'), JSON.stringify(readN(fMemo)));
    await win.keyboard.press('Backspace');
    await win.keyboard.type('X');
    ok('E72 改了又改回跟檔案一樣：不算改過', await waitFor(async () => (await dirtyNames()).length === 0 && (await saveState()) === '已存檔'));
    await win.click('#noteAdd');
    await waitFor(async () => (await curNote()) === '新記事 1');
    await win.keyboard.type('第二份');
    await win.click('#noteTabs .noteTab:nth-child(1) .noteName');   // 不等 0.6 秒就換
    ok('E72 換一份：新記事留著（不建檔、還是 ●）、新的接在最後面、文字框換成那份的內容',
      await waitFor(async () => (await noteText()) === '第一行\n\t縮排X' && (await curNote()) === '備忘') && same(await noteNames(), ['備忘', '新記事 1'])
      && same(await dirtyNames(), ['新記事 1']) && !fs.existsSync(path.join(noteDir, '新記事 1.txt')), JSON.stringify(await noteNames()));
    await win.keyboard.type('Y');   // 換過來游標在開頭
    await win.reload();   // 不等 0.6 秒：關掉前（beforeunload）要寫完
    ok('E72 重新載入：還是記事本、看的還是備忘；沒存的都還在（備忘改過的字、新記事）、檔案沒動',
      await waitFor(async () => await shown('#notePane') && !(await shown('#center')) && (await curNote()) === '備忘' && (await noteText()) === 'Y第一行\n\t縮排X'
        && same(await dirtyNames(), ['備忘', '新記事 1'])) && readN(fMemo) === '第一行\n\t縮排X', JSON.stringify({ text: await noteText(), dirty: await dirtyNames() }));
    await win.click('#noteTabs .noteTab:nth-child(2) .noteName');
    ok('E72 重新載入後新記事的字也還在', await waitFor(async () => (await noteText()) === '第二份' && (await curNote()) === '新記事 1'));
    await win.dblclick('#noteTabs .noteTab:nth-child(1) .noteName');
    await win.waitForSelector('.note-rename');
    await win.fill('.note-rename', '新記事 1');
    await win.press('.note-rename', 'Enter');
    ok('E72 改成新記事的名稱：提示已經有了、改名框留著', await waitFor(async () => (await toast()).includes('已經有一份叫「新記事 1」')) && await shown('.note-rename'), await toast());
    await win.fill('.note-rename', '週會');
    await win.press('.note-rename', 'Enter');
    const fWeek = path.join(noteDir, '週會.txt');
    ok('E72 改名：檔名跟著改（內容是檔案裡的）、位置不變、選到它；改過沒存的跟著換名稱、還是 ●',
      await waitFor(async () => fs.existsSync(fWeek) && !fs.existsSync(fMemo) && same(await noteNames(), ['週會', '新記事 1']) && (await curNote()) === '週會'
        && same(await dirtyNames(), ['週會', '新記事 1']) && (await noteText()) === 'Y第一行\n\t縮排X') && readN(fWeek) === '第一行\n\t縮排X',
      JSON.stringify({ names: await noteNames(), dirty: await dirtyNames(), text: await noteText() }));
    // E146：頁籤改名按 Enter、Esc 之後游標回文字框接著打（清單上的改名是回清單那行，兩個共用 noteInput，見 開發筆記 D188）
    const onText = () => win.evaluate(() => document.activeElement?.id === 'noteText');
    ok('E146 頁籤改名按 Enter：游標回文字框', await waitFor(onText), await win.evaluate(() => document.activeElement?.id || document.activeElement?.className));
    await win.dblclick('#noteTabs .noteTab:nth-child(1) .noteName');
    await win.waitForSelector('.note-rename');
    await win.fill('.note-rename', '不要這個名稱');
    await win.press('.note-rename', 'Escape');
    ok('E72 改名按 Esc：取消、檔名沒變', await waitFor(async () => !(await shown('.note-rename')) && same(await noteNames(), ['週會', '新記事 1'])) && fs.existsSync(fWeek));
    ok('E146 頁籤改名按 Esc：游標回文字框', await waitFor(onText), await win.evaluate(() => document.activeElement?.id || document.activeElement?.className));
    await win.dblclick('#noteTabs .noteTab:nth-child(1) .noteName');
    await win.waitForSelector('.note-rename');
    await win.focus('#actNote');   // 游標換到別的地方（只換焦點、不點下去）
    ok('E146 頁籤改名時游標換到別的地方：算改好（名稱沒改就不動）、框收起來、游標留在那裡不搶回文字框',
      await waitFor(async () => !(await shown('.note-rename')) && same(await noteNames(), ['週會', '新記事 1'])) && fs.existsSync(fWeek)
      && await sleep(300).then(() => win.evaluate(() => document.activeElement?.id === 'actNote')),
      await win.evaluate(() => document.activeElement?.id || document.activeElement?.className));
    await win.click('#noteTabs .noteTab:nth-child(2) .noteDel');
    ok('E72 × 有字的新記事：問要不要存', await waitFor(() => shown('#noteAsk')) && (await win.textContent('#noteAskMsg')).includes('「新記事 1」還沒存'));
    const askPos = await win.evaluate(() => {   // 框在灰的那層正中間（D109）
      const o = document.getElementById('noteAsk').getBoundingClientRect(), b = document.querySelector('.noteAskBox').getBoundingClientRect();
      return { dx: (b.left + b.right) / 2 - (o.left + o.right) / 2, dy: (b.top + b.bottom) / 2 - (o.top + o.bottom) / 2 };
    });
    ok('E72 問的框在畫面正中間', Math.abs(askPos.dx) < 1 && Math.abs(askPos.dy) < 1, JSON.stringify(askPos));
    await win.click('#noteAskCancel');
    ok('E72 取消：框收起來、新記事還在', await waitFor(async () => !(await shown('#noteAsk'))) && same(await noteNames(), ['週會', '新記事 1']));
    await win.click('#noteTabs .noteTab:nth-child(2) .noteDel');
    await waitFor(() => shown('#noteAsk'));
    await win.keyboard.press('Escape');
    ok('E72 Esc 也是取消', await waitFor(async () => !(await shown('#noteAsk'))) && same(await noteNames(), ['週會', '新記事 1']));
    await win.click('#noteTabs .noteTab:nth-child(2) .noteDel');
    await waitFor(() => shown('#noteAsk'));
    await win.click('#noteAskDrop');
    ok('E72 不存：頁籤拿掉、沒建檔、暫存裡也沒了；還是看週會',
      await waitFor(async () => same(await noteNames(), ['週會']) && (await curNote()) === '週會' && !(await shown('#noteAsk')))
      && !fs.existsSync(path.join(noteDir, '新記事 1.txt')) && await waitFor(() => same(backup()?.untitled, [])), JSON.stringify(backup()));
    await win.click('#noteAdd');
    await waitFor(async () => (await curNote()) === '新記事 1');
    await win.click('#noteTabs .noteTab.on .noteDel');
    ok('E72 × 沒字的新記事：不問、直接關、換到旁邊那份', await waitFor(async () => same(await noteNames(), ['週會']) && (await curNote()) === '週會' && (await noteText()) === 'Y第一行\n\t縮排X')
      && !(await shown('#noteAsk')), JSON.stringify(await noteNames()));
    await win.click('#noteAdd');
    await waitFor(async () => (await curNote()) === '新記事 1');
    await win.keyboard.type('\n\n第三份的標題\n內容');
    await win.click('#noteTabs .noteTab.on .noteDel');
    await waitFor(() => shown('#noteAsk'));
    await win.click('#noteAskSave');
    ok('E72 存：頁籤變成取名的框、預設是第一個有字的行', await waitFor(async () => !(await shown('#noteAsk')) && (await win.inputValue('.note-rename').catch(() => null)) === '第三份的標題'));
    await win.press('.note-rename', 'Enter');
    const fThird = path.join(noteDir, '第三份的標題.txt');
    ok('E72 取名存檔：建檔、頁籤留著、選到它', await waitFor(async () => readN(fThird) === '\n\n第三份的標題\n內容' && same(await noteNames(), ['週會', '第三份的標題']) && (await curNote()) === '第三份的標題'),
      JSON.stringify(await noteNames()));
    await win.click('#noteTabs .noteTab:nth-child(1) .noteDel');   // 週會改過沒存（Y）
    ok('E72 × 有名字的（改過沒存）：D116 起 × 是關掉，先問要不要存（不存的話檔案留著上次存的）',
      await waitFor(() => shown('#noteAsk')) && (await win.textContent('#noteAskMsg')).includes('「週會」還沒存') && (await win.textContent('#noteAskSub')).includes('檔案留著'));
    await win.click('#noteAskSave');
    ok('E72 存：寫進檔案再關掉頁籤；檔案還在、清單上還有、暫存清掉',
      await waitFor(async () => readN(fWeek) === 'Y第一行\n\t縮排X' && same(await noteNames(), ['第三份的標題']) && same((await listKeys()).sort(), ['f:第三份的標題', 'f:週會'].sort()))
      && await waitFor(() => !fs.existsSync(backupFile)), JSON.stringify({ tabs: await noteNames(), list: await listKeys() }));
    await win.click(`${rowSel('f:週會')} .nlName`);
    ok('E72 清單上點一下：開成預覽的頁籤（斜體）、接在後面、換成那份的內容、游標還在清單',
      await waitFor(async () => same(await noteNames(), ['第三份的標題', '週會']) && (await curNote()) === '週會' && (await noteText()) === 'Y第一行\n\t縮排X' && (await previewName()) === '週會')
      && !(await win.evaluate(() => document.activeElement.id === 'noteText')), JSON.stringify(await noteNames()));
    await caretEnd();
    await win.keyboard.type('Z');
    ok('E72 預覽的打字：留下來（不是斜體）、標 ●', await waitFor(async () => (await previewName()) === null && same(await dirtyNames(), ['週會'])));
    await rowTool('f:週會', 2);
    ok('E72 清單上的 ×：不問，沒存的先寫進去再丟資源回收筒（測試搬進 --trash-dir）、頁籤關掉、換到旁邊那份、清單上沒了、暫存清掉',
      await waitFor(async () => !fs.existsSync(fWeek) && readN(path.join(noteTrash, '週會.txt')) === 'Y第一行\n\t縮排XZ' && same(await noteNames(), ['第三份的標題'])
        && (await curNote()) === '第三份的標題' && same(await listKeys(), ['f:第三份的標題']))
      && (await toast()).includes('資源回收筒') && !(await shown('#noteAsk')) && await waitFor(() => !fs.existsSync(backupFile)), JSON.stringify({ tabs: await noteNames(), list: await listKeys() }));
    fs.writeFileSync(fThird, '外面改的\r\n第二行');
    ok('E72 外面改了檔（沒改過）：文字框跟著變（CRLF 變 \\n）', await waitFor(async () => (await noteText()) === '外面改的\n第二行'), JSON.stringify(await noteText()));
    await caretEnd();
    await win.keyboard.type('!');
    fs.writeFileSync(fThird, '外面又改');
    ok('E72 外面改了檔（改過沒存）：留著畫面上的、還是 ●', await sleep(600).then(async () => (await noteText()) === '外面改的\n第二行!' && same(await dirtyNames(), ['第三份的標題'])),
      JSON.stringify(await noteText()));
    fs.rmSync(fThird);
    ok('E72 外面刪掉了（改過沒存）：頁籤照原本的名稱留著、字還在', await sleep(600).then(async () => same(await noteNames(), ['第三份的標題']) && (await noteText()) === '外面改的\n第二行!'),
      JSON.stringify(await noteNames()));
    await win.keyboard.press('Control+s');
    ok('E72 再 Ctrl+S：照原本的名稱再存一份、● 拿掉', await waitFor(async () => readN(fThird) === '外面改的\n第二行!' && (await dirtyNames()).length === 0), JSON.stringify(readN(fThird)));

    // E73：行號（見 開發筆記 D103）——自動換行，行號照真的換行算、折下來的不標號；墊底那層跟文字框換行一樣（高度一樣）；捲動時行號跟著捲
    const gutter = () => win.evaluate(() => {
      const a = document.getElementById('noteText');
      const r = a.getBoundingClientRect();
      return {
        nums: [...document.querySelectorAll('#noteNums > div')].map(d => [d.textContent, d.getBoundingClientRect().top]),
        lh: parseFloat(getComputedStyle(a).lineHeight), top: r.top, bottom: r.bottom,
        mirrorH: document.getElementById('noteMirror').scrollHeight, areaH: a.scrollHeight,
        scroll: [a.scrollTop, document.getElementById('noteGutter').scrollTop],
      };
    });
    // 後面再接 60 行，內容比框高：兩邊的 scrollHeight 才是內容高度（沒超出時都等於框高，比不出來）
    await win.fill('#noteText', 'abc '.repeat(150) + '\n第二行\n\n第四行' + '\n更多'.repeat(60));
    await win.evaluate(() => { document.getElementById('noteText').scrollTop = 0; });   // 填完游標在最後、捲到底了，量之前捲回頂端
    await waitFor(async () => { const g = await gutter(); return g.nums.length === 64 && g.scroll[1] === 0; });
    const g73 = await gutter();
    const [n1, n2, n3, n4] = g73.nums.map(n => n[1]);
    ok('E73 行號照真的換行算（空行也算）；第一行貼著文字框上緣的內距；很長的第一行折成好幾行，2 往下推；其他一行一個',
      // 行號的位置是墊底那層的 offsetTop（整數），行高 22.4 時相鄰兩行差 22 或 23（D116 起旁邊開著記事清單，折的行數不同，會碰到 23）
      same(g73.nums.slice(0, 4).map(n => n[0]), ['1', '2', '3', '4']) && g73.nums.length === 64 && Math.abs(n1 - (g73.top + 12)) < 1 && n2 - n1 >= 2 * g73.lh - 1
      && Math.abs(n3 - n2 - g73.lh) < 1 && Math.abs(n4 - n3 - g73.lh) < 1, JSON.stringify(g73.nums.slice(0, 4)));
    ok('E73 墊底那層跟文字框換行一樣（內容高度一樣、比框高）', g73.mirrorH === g73.areaH && g73.areaH > g73.bottom - g73.top, JSON.stringify({ mirrorH: g73.mirrorH, areaH: g73.areaH }));
    await win.fill('#noteText', Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
    await win.evaluate(() => { const a = document.getElementById('noteText'); a.scrollTop = a.scrollHeight; });
    ok('E73 捲到最底：行號跟著捲，最後一個 200 在文字框最下面', await waitFor(async () => {
      const g = await gutter();
      const last = g.nums[g.nums.length - 1];
      return g.nums.length === 200 && g.scroll[0] > 0 && g.scroll[0] === g.scroll[1] && last[0] === '200' && last[1] + g.lh <= g.bottom + 0.5 && last[1] > g.bottom - 3 * g.lh;
    }), JSON.stringify((await gutter()).scroll));
    // E141：Enter、Tab 一下只重畫一次（見 開發筆記 D180）——改之前 input 排一次、noteApply 又直接畫一次，下一格畫面再畫一次。
    // 數 noteRender 跑幾次（全域的 function，包一層計數；裡面的人叫的也是 window 上這支），畫完行號要對。
    // 從 refreshNotes 來的不算：前面 E72 存檔，監看的通知可能剛好這時候到、記事本重讀一次（完整跑時碰到過，2026-11-09；同 D145 的時間差），那次不是按鍵排的
    await win.evaluate(() => {
      const a = document.getElementById('noteText'), at = a.value.indexOf('\n', a.value.indexOf('第 100 行'));
      a.focus();
      a.setSelectionRange(at, at);
      window.__e141 = { orig: window.noteRender, n: 0, other: 0 };
      window.noteRender = function () {
        if (new Error().stack.includes('refreshNotes')) window.__e141.other++; else window.__e141.n++;
        return window.__e141.orig.apply(this, arguments);
      };
    });
    const renders = async key => {
      await win.evaluate(() => { window.__e141.n = 0; });
      await win.keyboard.press(key);
      await win.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));   // 排在下一格畫面的那次也算進來
      return win.evaluate(() => window.__e141.n);
    };
    const r141 = [await renders('Enter'), await renders('Tab')];
    const g141 = await gutter();
    ok('E141 Enter、Tab 一下只重畫一次；畫完行號多一行（201），新的那行是 \\t',
      same(r141, [1, 1]) && g141.nums.length === 201 && g141.nums[200][0] === '201'
      && (await win.evaluate(() => document.getElementById('noteText').value.split('\n')[100])) === '\t',
      JSON.stringify(r141) + '，監看重讀 ' + (await win.evaluate(() => window.__e141.other)) + ' 次');
    await win.evaluate(() => { window.noteRender = window.__e141.orig; delete window.__e141; });

    // E74：記事本裡 Ctrl+F 找字（見 開發筆記 D104）——只找這份、不分大小寫、全部標顏色、目前那個深一點；Enter／Shift+Enter 換、到底繞回來；
    // Esc 關掉、選著目前那個；選著一段字按 Ctrl+F 拿來找；框開著時改內容跟著重找
    await win.fill('#noteText', 'Apple pie\napple tart\nbanana APPLE');
    await win.evaluate(() => document.getElementById('noteText').setSelectionRange(0, 0));
    const find = () => win.evaluate(() => {
      const marks = [...document.querySelectorAll('#noteMirror mark')];
      const a = document.getElementById('noteText');
      return { shown: !document.getElementById('noteFind').hidden, n: document.getElementById('noteFindN').textContent, marks: marks.map(m => m.textContent),
        on: marks.findIndex(m => m.classList.contains('on')), active: document.activeElement.id, sel: [a.selectionStart, a.selectionEnd] };
    });
    const findIs = fn => waitFor(async () => fn(await find()));
    await win.keyboard.press('Control+f');
    ok('E74 Ctrl+F：還在記事本、右上角跳出找字的框、游標在框裡', await findIs(f => f.shown && f.active === 'noteFindQ') && await shown('#notePane') && !(await shown('#center')), JSON.stringify(await find()));
    await win.keyboard.type('apple');
    ok('E74 打字就找：不分大小寫、三個都標顏色、第一個是目前那個、寫「1 / 3」', await findIs(f => f.n === '1 / 3' && same(f.marks, ['Apple', 'apple', 'APPLE']) && f.on === 0), JSON.stringify(await find()));
    await win.keyboard.press('Enter');
    ok('E74 Enter：下一個', await findIs(f => f.n === '2 / 3' && f.on === 1), JSON.stringify(await find()));
    await win.keyboard.press('Enter');
    await win.keyboard.press('Enter');
    ok('E74 到底了繞回第一個', await findIs(f => f.n === '1 / 3' && f.on === 0), JSON.stringify(await find()));
    await win.keyboard.press('Shift+Enter');
    ok('E74 Shift+Enter：上一個（繞到最後一個）', await findIs(f => f.n === '3 / 3' && f.on === 2), JSON.stringify(await find()));
    await win.fill('#noteFindQ', 'zzz');
    ok('E74 找不到：寫「沒有結果」、沒有標顏色', await findIs(f => f.n === '沒有結果' && f.marks.length === 0), JSON.stringify(await find()));
    await win.fill('#noteFindQ', 'TART');
    await win.press('#noteFindQ', 'Escape');
    ok('E74 Esc：框收起來、顏色拿掉、游標回文字框、選著找到的那個', await findIs(f => !f.shown && f.marks.length === 0 && f.active === 'noteText' && same(f.sel, [16, 20])), JSON.stringify(await find()));
    await win.evaluate(() => document.getElementById('noteText').setSelectionRange(21, 27));   // banana
    await win.keyboard.press('Control+f');
    ok('E74 選著一段字按 Ctrl+F：拿來找', await waitFor(async () => (await win.inputValue('#noteFindQ')) === 'banana') && await findIs(f => f.n === '1 / 1'), JSON.stringify(await find()));
    await win.evaluate(() => { const a = document.getElementById('noteText'); a.focus(); a.setSelectionRange(a.value.length, a.value.length); });
    await win.keyboard.type(' banana');
    ok('E74 框開著時改了內容：跟著重找', await findIs(f => f.shown && f.n === '1 / 2' && f.marks.length === 2), JSON.stringify(await find()));
    await win.keyboard.press('Escape');
    ok('E74 在文字框按 Esc 也關掉', await findIs(f => !f.shown && f.active === 'noteText'), JSON.stringify(await find()));

    // E117：記事本 F3／Shift+F3（見 開發筆記 D150，照 VS Code）——框關著：叫出框、游標留在文字框、用上次找的字、從游標往後；框開著：下一個／上一個（繞回來）；
    // 選著一個找到的按 F3 跳到它後面那個；有上次的字就用上次的（不拿選著的）；從沒找過才拿選著的字；都沒有就跟 Ctrl+F 一樣
    await win.fill('#noteText', 'Apple pie\napple tart\nbanana APPLE');   // apple 在 [0,5]、[10,15]、[28,33]
    await win.evaluate(() => { document.getElementById('noteFindQ').value = 'apple'; const a = document.getElementById('noteText'); a.focus(); a.setSelectionRange(0, 0); });
    await win.keyboard.press('F3');
    ok('E117 框關著按 F3：叫出框、游標還在文字框、用上次找的字、從游標往後（1 / 3，選著第一個）',
      await findIs(f => f.shown && f.active === 'noteText' && f.n === '1 / 3' && same(f.sel, [0, 5])), JSON.stringify(await find()));
    await win.keyboard.press('F3');
    ok('E117 框開著再按 F3：下一個（2 / 3），游標還在文字框', await findIs(f => f.n === '2 / 3' && f.active === 'noteText' && same(f.sel, [10, 15])), JSON.stringify(await find()));
    await win.keyboard.press('Shift+F3');
    await win.keyboard.press('Shift+F3');
    ok('E117 Shift+F3 兩下：上一個、到頭繞到最後一個（3 / 3）', await findIs(f => f.n === '3 / 3' && same(f.sel, [28, 33])), JSON.stringify(await find()));
    await win.keyboard.press('Shift+F3');
    await win.keyboard.press('Escape');
    ok('E117 前提：Esc 收起來、選著第二個', await findIs(f => !f.shown && same(f.sel, [10, 15])), JSON.stringify(await find()));
    await win.keyboard.press('F3');
    ok('E117 選著一個找到的、框關著按 F3：跳到它後面那個（3 / 3），不是同一個', await findIs(f => f.shown && f.n === '3 / 3' && same(f.sel, [28, 33]) && f.active === 'noteText'), JSON.stringify(await find()));
    await win.keyboard.press('Escape');
    await win.evaluate(() => document.getElementById('noteText').setSelectionRange(21, 27));   // banana
    await win.keyboard.press('F3');
    ok('E117 有上次找的字：選著別的字（banana）按 F3 照樣找 apple，從選的後面（3 / 3）',
      await findIs(f => f.shown && f.n === '3 / 3' && same(f.sel, [28, 33])) && (await win.inputValue('#noteFindQ')) === 'apple', JSON.stringify(await find()));
    await win.keyboard.press('Escape');
    await win.evaluate(() => { document.getElementById('noteFindQ').value = ''; document.getElementById('noteText').setSelectionRange(6, 9); });   // pie
    await win.keyboard.press('F3');
    ok('E117 從沒找過、選著 pie 按 F3：拿選的字來找（1 / 1），游標還在文字框',
      await findIs(f => f.shown && f.n === '1 / 1' && f.active === 'noteText') && (await win.inputValue('#noteFindQ')) === 'pie', JSON.stringify(await find()));
    await win.keyboard.press('Escape');
    await win.evaluate(() => { document.getElementById('noteFindQ').value = ''; document.getElementById('noteText').setSelectionRange(3, 3); });
    await win.keyboard.press('F3');
    ok('E117 從沒找過、也沒選字：跟 Ctrl+F 一樣（框打開、游標在框裡）', await findIs(f => f.shown && f.active === 'noteFindQ'), JSON.stringify(await find()));
    await win.press('#noteFindQ', 'Escape');

    // E75：多游標 Ctrl+D（見 開發筆記 D106）——沒選字選詞、再按選下一個一樣的（照整個詞、大小寫一樣、到底繞回、全選了就不動）；
    // 打字、Backspace、Shift+←、Enter、Tab、↑↓、Home/End、輸入法、複製、貼上、剪下每個一起；Esc、點一下、Ctrl+Z 回到一個；自己選的字不管整個詞；中文詞；捲到看得到
    const mc = () => win.evaluate(() => {
      const a = document.getElementById('noteText');
      return { v: a.value, sels: noteMulti ? noteMulti.sels.map(s => [Math.min(...s), Math.max(...s)]) : [[a.selectionStart, a.selectionEnd]],
        main: noteMulti ? noteMulti.main : 0, drawn: [...document.querySelectorAll('#noteMirror :is(.sel, .caret, .caret-end, .caret-empty)')].map(e => e.className + ':' + e.textContent) };
    });
    const mcIs = fn => waitFor(async () => fn(await mc()));
    const setSel = (s, e = s) => win.evaluate(([s, e]) => { const a = document.getElementById('noteText'); a.focus(); a.setSelectionRange(s, e); }, [s, e]);
    // 不碰系統剪貼簿：自己做 copy／paste 事件、帶一個 DataTransfer（見 開發筆記 D106）
    const clip = (type, text) => win.evaluate(([type, text]) => {
      const dt = new DataTransfer();
      if (text != null) dt.setData('text/plain', text);
      document.getElementById('noteText').dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData('text/plain');
    }, [type, text]);
    await win.fill('#noteText', 'apple pie\npineapple\napple tart\nAPPLE');
    await setSel(2);
    await win.keyboard.press('Control+d');
    ok('E75 沒選字按 Ctrl+D：選游標所在的詞、還是一個', await mcIs(m => same(m.sels, [[0, 5]]) && m.drawn.length === 0), JSON.stringify(await mc()));
    await win.keyboard.press('Control+d');
    ok('E75 再按：多選下一個一樣的（pineapple 裡的不算）、主要的是新的、另一個畫在墊底那層', await mcIs(m => same(m.sels, [[0, 5], [20, 25]]) && m.main === 1 && same(m.drawn, ['sel:apple', 'caret: '])),
      JSON.stringify(await mc()));
    await win.keyboard.press('Control+d');
    ok('E75 再按：大小寫不一樣的不算、繞回來都選了就不動', await mcIs(m => same(m.sels, [[0, 5], [20, 25]])), JSON.stringify(await mc()));
    await win.keyboard.type('XY');
    ok('E75 打字：兩個都換掉、游標在後面', await mcIs(m => m.v === 'XY pie\npineapple\nXY tart\nAPPLE' && same(m.sels, [[2, 2], [19, 19]]) && same(m.drawn, ['caret: '])), JSON.stringify(await mc()));
    await win.keyboard.press('Backspace');
    await win.keyboard.press('Shift+ArrowLeft');
    ok('E75 Backspace、Shift+←：兩個一起', await mcIs(m => m.v === 'X pie\npineapple\nX tart\nAPPLE' && same(m.sels, [[0, 1], [16, 17]])), JSON.stringify(await mc()));
    ok('E75 複製：每個選取一行', (await clip('copy')) === 'X\nX');
    await clip('paste', 'A\nB');
    ok('E75 貼上：行數跟游標一樣多，一個游標一行', await mcIs(m => m.v === 'A pie\npineapple\nB tart\nAPPLE' && same(m.sels, [[1, 1], [17, 17]])), JSON.stringify(await mc()));
    await clip('paste', '12');
    ok('E75 貼上：不一樣多就每個都貼整段', await mcIs(m => m.v === 'A12 pie\npineapple\nB12 tart\nAPPLE' && same(m.sels, [[3, 3], [21, 21]])), JSON.stringify(await mc()));
    const cdp = await win.context().newCDPSession(win);   // 輸入法：選字中、選好（CDP 的 imeSetComposition、insertText）
    await cdp.send('Input.imeSetComposition', { text: 'ㄓ', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '中' });
    ok('E75 輸入法：選好的字每個游標都有', await mcIs(m => m.v === 'A12中 pie\npineapple\nB12中 tart\nAPPLE' && same(m.sels, [[4, 4], [23, 23]])), JSON.stringify(await mc()));
    await cdp.detach();
    await win.keyboard.press('Home');
    await win.keyboard.press('Shift+End');
    ok('E75 Home、Shift+End：每一行都選到行尾', await mcIs(m => same(m.sels, [[0, 8], [19, 28]]) && same(m.drawn, ['sel:A12中 pi', 'sel caret-end:e'])), JSON.stringify(await mc()));
    ok('E75 剪下：每個一行、選的拿掉', (await clip('cut')) === 'A12中 pie\nB12中 tart' && await mcIs(m => m.v === '\npineapple\n\nAPPLE' && same(m.sels, [[0, 0], [11, 11]])
      && same(m.drawn, ['caret-empty:'])), JSON.stringify(await mc()));
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('End');
    await win.keyboard.press('Tab');
    await win.keyboard.press('Enter');
    ok('E75 ↓、End、Tab、Enter：每個一起', await mcIs(m => m.v === '\npineapple\t\n\n\nAPPLE\t\n' && same(m.sels, [[12, 12], [21, 21]])), JSON.stringify(await mc()));
    await win.keyboard.press('Control+z');
    ok('E75 Ctrl+Z：一次復原整個 Enter、回到一個游標', await mcIs(m => m.v === '\npineapple\t\n\nAPPLE\t' && m.sels.length === 1 && m.drawn.length === 0), JSON.stringify(await mc()));
    await win.fill('#noteText', 'apple pie\npineapple\napple tart');
    await setSel(14, 17);   // 自己選的 app（pineapple 裡的）
    await win.keyboard.press('Control+d');
    await win.keyboard.press('Control+d');
    ok('E75 自己選的字：不管是不是整個詞，往下找、到底繞回', await mcIs(m => same(m.sels, [[0, 3], [14, 17], [20, 23]]) && m.main === 0), JSON.stringify(await mc()));
    await win.keyboard.press('Escape');
    ok('E75 Esc：回到一個（最後選的那個）、墊底那層沒有畫', await mcIs(m => same(m.sels, [[0, 3]]) && m.drawn.length === 0), JSON.stringify(await mc()));
    await win.keyboard.press('Control+d');
    await win.click('#noteText');
    ok('E75 點一下：回到一個', await mcIs(m => m.sels.length === 1 && m.drawn.length === 0), JSON.stringify(await mc()));
    await win.fill('#noteText', '週會要講\n今天週會\n' + '\n'.repeat(80) + '週會結束');
    await win.evaluate(() => { document.getElementById('noteText').scrollTop = 0; });
    await setSel(1);
    await win.keyboard.press('Control+d');
    await win.keyboard.press('Control+d');
    ok('E75 中文：選游標所在的詞（週會）、下一個一樣的', await mcIs(m => same(m.sels, [[0, 2], [7, 9]])), JSON.stringify(await mc()));
    await win.keyboard.press('Control+d');
    ok('E75 下一個在畫面外：捲到看得到', await mcIs(m => m.sels.length === 3) && await waitFor(() => win.evaluate(() => {
      const a = document.getElementById('noteText'), r = document.querySelector('#noteMirror > div:last-child').getBoundingClientRect(), b = a.getBoundingClientRect();
      return a.scrollTop > 0 && r.top >= b.top && r.bottom <= b.bottom;
    })), JSON.stringify(await mc()));
    await win.keyboard.press('Escape');

    // E76：整行、縮排（見 開發筆記 D107）——Alt+↑↓ 搬、Shift+Alt+↑↓ 複製、Ctrl+Shift+K 刪（頂、底不動，Ctrl+Z 一次復原）；選好幾行一起搬；多游標一起刪；
    // Tab／Shift+Tab 選好幾行一起縮（空行不加、選到下一行行頭的那行不算）、沒選字 Shift+Tab 退這一行；Enter 帶縮排；沒選字的複製、剪下是整行，貼的時候插在那一行上面
    const vs = async () => { const m = await mc(); return [m.v, m.sels]; };
    const vsIs = (v, sels) => waitFor(async () => same(await vs(), [v, sels]));
    await win.fill('#noteText', 'one\ntwo\nthree');
    await setSel(5);
    await win.keyboard.press('Alt+ArrowUp');
    ok('E76 Alt+↑：這一行跟上一行換、游標跟著', await vsIs('two\none\nthree', [[1, 1]]), JSON.stringify(await vs()));
    await win.keyboard.press('Alt+ArrowUp');
    ok('E76 到頂了：不動', await vsIs('two\none\nthree', [[1, 1]]), JSON.stringify(await vs()));
    await win.keyboard.press('Alt+ArrowDown');
    await win.keyboard.press('Alt+ArrowDown');
    await win.keyboard.press('Alt+ArrowDown');
    ok('E76 Alt+↓：往下搬、到底了不動', await vsIs('one\nthree\ntwo', [[11, 11]]), JSON.stringify(await vs()));
    await win.keyboard.press('Shift+Alt+ArrowUp');
    ok('E76 Shift+Alt+↑：複製一份、游標留在上面那份', await vsIs('one\nthree\ntwo\ntwo', [[11, 11]]), JSON.stringify(await vs()));
    await win.keyboard.press('Shift+Alt+ArrowDown');
    ok('E76 Shift+Alt+↓：複製一份、游標到下面那份', await vsIs('one\nthree\ntwo\ntwo\ntwo', [[15, 15]]), JSON.stringify(await vs()));
    await win.keyboard.press('Control+Shift+K');
    ok('E76 Ctrl+Shift+K：刪掉這一行、游標到接上來那一行同一欄', await vsIs('one\nthree\ntwo\ntwo', [[15, 15]]), JSON.stringify(await vs()));
    await win.keyboard.press('Control+z');
    ok('E76 Ctrl+Z：一次復原', await waitFor(async () => (await mc()).v === 'one\nthree\ntwo\ntwo\ntwo'), JSON.stringify(await vs()));
    await win.fill('#noteText', 'a\nb\nc\nd');
    await setSel(0, 3);
    await win.keyboard.press('Alt+ArrowDown');
    ok('E76 選好幾行：一起搬、選取跟著', await vsIs('c\na\nb\nd', [[2, 5]]), JSON.stringify(await vs()));
    await win.fill('#noteText', 'foo\nbar\nfoo');
    await setSel(1);
    await win.keyboard.press('Control+d');
    await win.keyboard.press('Control+d');
    await win.keyboard.press('Control+Shift+K');
    ok('E76 多游標：碰到的行一起刪、剩一個游標（欄位一樣）', await vsIs('bar', [[3, 3]]), JSON.stringify(await vs()));
    await win.fill('#noteText', 'a\n\tb\n\nc');
    await setSel(0, 6);
    await win.keyboard.press('Tab');
    ok('E76 Tab（選好幾行）：每行加一個 Tab、空行不加、選到行頭的 c 不算；選取開頭留在行頭', await vsIs('\ta\n\t\tb\n\nc', [[0, 8]]), JSON.stringify(await vs()));
    await win.keyboard.press('Shift+Tab');
    ok('E76 Shift+Tab：每行拿掉一個 Tab', await vsIs('a\n\tb\n\nc', [[0, 6]]), JSON.stringify(await vs()));
    await win.fill('#noteText', 'x\n    y');
    await setSel(7);
    await win.keyboard.press('Shift+Tab');
    ok('E76 沒選字 Shift+Tab：退這一行（4 個空白也算一層）', await vsIs('x\ny', [[3, 3]]), JSON.stringify(await vs()));
    await win.fill('#noteText', '\t\tdeep');
    await setSel(6);
    await win.keyboard.press('Enter');
    await win.keyboard.type('next');
    ok('E76 Enter：新的一行帶上一行的縮排', await vsIs('\t\tdeep\n\t\tnext', [[13, 13]]), JSON.stringify(await vs()));
    await win.fill('#noteText', 'a\nb\nc');
    await setSel(3);
    ok('E76 沒選字複製：整行連換行', (await clip('copy')) === 'b\n');
    await setSel(5);
    await clip('paste', 'b\n');
    ok('E76 貼整行複製來的：插在游標那一行上面、游標跟著原本那一行', await vsIs('a\nb\nb\nc', [[7, 7]]), JSON.stringify(await vs()));
    await setSel(0);
    ok('E76 沒選字剪下：整行拿掉', (await clip('cut')) === 'a\n' && await vsIs('b\nb\nc', [[0, 0]]), JSON.stringify(await vs()));

    // E77：取代、跳到第幾行（見 開發筆記 D108）——Ctrl+H 多一列、選著的字拿來找、游標在取代的框；Enter 換目前這個、跳到下一個；Ctrl+Alt+Enter 全部換（不分大小寫）；
    // 文字框 Ctrl+Z 一次復原全部取代；▸ 收起來；關掉再 Ctrl+F 只有找字那列；Ctrl+G 跳行（超過到最後一行、不是數字不動、Esc 取消）
    const repl = () => win.evaluate(() => ({ shown: !document.getElementById('noteFind').hidden, repl: !document.getElementById('noteReplRow').hidden,
      more: document.getElementById('noteFindMore').textContent, q: document.getElementById('noteFindQ').value, n: document.getElementById('noteFindN').textContent,
      active: document.activeElement.id, v: document.getElementById('noteText').value }));
    const replIs = fn => waitFor(async () => fn(await repl()));
    await win.fill('#noteText', 'cat dog cat\nCat bird');
    await setSel(0, 3);
    await win.keyboard.press('Control+h');
    ok('E77 Ctrl+H：找字的框多一列取代、▾、選著的字拿來找、游標在取代的框、目前是第一個', await replIs(r => r.shown && r.repl && r.more === '▾' && r.q === 'cat' && r.n === '1 / 3' && r.active === 'noteReplQ'),
      JSON.stringify(await repl()));
    await win.keyboard.type('cow');
    await win.keyboard.press('Enter');
    ok('E77 Enter：換掉目前這個、跳到下一個、游標還在取代的框', await replIs(r => r.v === 'cow dog cat\nCat bird' && r.n === '1 / 2' && r.active === 'noteReplQ'), JSON.stringify(await repl()));
    await win.keyboard.press('Control+Alt+Enter');
    ok('E77 Ctrl+Alt+Enter：全部換掉（不分大小寫）、提示換了幾個、沒有結果', await replIs(r => r.v === 'cow dog cow\ncow bird' && r.n === '沒有結果')
      && (await win.textContent('#toast')).includes('已取代 2 個'), JSON.stringify(await repl()));
    await win.focus('#noteText');
    await win.keyboard.press('Control+z');
    ok('E77 文字框 Ctrl+Z：一次復原全部取代', await replIs(r => r.v === 'cow dog cat\nCat bird'), JSON.stringify(await repl()));
    await win.click('#noteFindMore');
    ok('E77 點 ▾：取代那列收起來', await replIs(r => r.shown && !r.repl && r.more === '▸'), JSON.stringify(await repl()));
    await win.click('#noteFindMore');
    await win.click('#noteReplAll');
    ok('E77 點「全部取代」也可以', await replIs(r => r.v === 'cow dog cow\ncow bird'), JSON.stringify(await repl()));
    await win.press('#noteReplQ', 'Escape');
    await win.keyboard.press('Control+f');
    ok('E77 Esc 關掉、再 Ctrl+F：只有找字那列', await replIs(r => r.shown && !r.repl && r.active === 'noteFindQ'), JSON.stringify(await repl()));
    await win.keyboard.press('Escape');
    await win.fill('#noteText', Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
    await win.evaluate(() => { document.getElementById('noteText').scrollTop = 0; });
    const gotoState = () => win.evaluate(() => {
      const a = document.getElementById('noteText'), v = a.value, line = v.slice(0, a.selectionStart).split('\n').length;
      const r = document.querySelector(`#noteMirror > div:nth-child(${line})`).getBoundingClientRect(), b = a.getBoundingClientRect();
      return { shown: !document.getElementById('noteGoto').hidden, ph: document.getElementById('noteGotoQ').placeholder, active: document.activeElement.id,
        line, atStart: a.selectionStart === a.selectionEnd && (a.selectionStart === 0 || v[a.selectionStart - 1] === '\n'), visible: r.top >= b.top && r.bottom <= b.bottom };
    });
    await win.keyboard.press('Control+g');
    ok('E77 Ctrl+G：上面跳出小框、寫有幾行、游標在框裡', await waitFor(async () => { const g = await gotoState(); return g.shown && g.ph.includes('1～200') && g.active === 'noteGotoQ'; }),
      JSON.stringify(await gotoState()));
    await win.keyboard.type('150');
    await win.keyboard.press('Enter');
    ok('E77 Enter：框收起來、游標在第 150 行行頭、捲到看得到', await waitFor(async () => { const g = await gotoState(); return !g.shown && g.active === 'noteText' && g.line === 150 && g.atStart && g.visible; }),
      JSON.stringify(await gotoState()));
    await win.keyboard.press('Control+g');
    await win.keyboard.type('999');
    await win.keyboard.press('Enter');
    ok('E77 超過最後一行：到最後一行', await waitFor(async () => { const g = await gotoState(); return !g.shown && g.line === 200 && g.atStart && g.visible; }), JSON.stringify(await gotoState()));
    await win.keyboard.press('Control+g');
    await win.keyboard.type('abc');
    await win.keyboard.press('Enter');
    ok('E77 不是數字：框留著', await waitFor(async () => (await gotoState()).shown), JSON.stringify(await gotoState()));
    await win.keyboard.press('Escape');
    ok('E77 Esc：框收起來、游標回文字框、位置沒變', await waitFor(async () => { const g = await gotoState(); return !g.shown && g.active === 'noteText' && g.line === 200; }), JSON.stringify(await gotoState()));

    const noteBox = () => win.evaluate(() => {
      const r = id => document.getElementById(id).getBoundingClientRect();
      return { days: [r('days').left, r('days').right], note: r('notePane').left, side: [localStorage.getItem('daybook.sideView'), localStorage.getItem('daybook.sideOff')] };
    });
    await win.click('#actNote');
    ok('E72 清單開著時再點「記事本」（D116）：收起左欄、還是記事本、接在頁籤列右邊；記事本還是選到',
      await waitFor(async () => await shown('#notePane') && !(await shown('#days')) && !(await shown('#center')))
      && await (async () => { const b = await noteBox(); return Math.abs(b.note - 48) < 1 && same(b.side, ['', '1']); })() && await isOn('#actNote'), JSON.stringify(await noteBox()));
    await win.click('#actNote');
    ok('E72 再點：打開左欄、是記事清單、記事本接在左欄右邊',
      await waitFor(async () => await shown('#notePane') && await shown('#noteList'))
      && await (async () => { const b = await noteBox(); return Math.abs(b.days[0] - 48) < 1 && Math.abs(b.note - b.days[1]) < 1 && same(b.side, ['', '']); })(), JSON.stringify(await noteBox()));

    // E78：記事本時點「剪貼簿」（見 開發筆記 D110、D112、D116）——不回日記：左欄換成剪貼簿、中間還是記事本；點卡片照樣複製；重新載入還開著；
    // 再點「記事本」左欄換回記事清單；剪貼簿開著再點收起左欄；點「日記本」回日記；日記左欄放剪貼簿時點「記事本」左欄是記事清單
    await win.click('#actSnip');
    ok('E78 記事本時點「剪貼簿」：還是記事本、左欄換成剪貼簿（記事清單、日記本的藏著）、記事本接在左欄右邊；記事本、剪貼簿都選到、記成跟日記同一份',
      await waitFor(async () => await shown('#notePane') && await shown('#snipPane') && !(await shown('#noteList')) && !(await shown('#center')) && !(await shown('#q')) && !(await shown('#dayList')))
      && await (async () => { const b = await noteBox(); return Math.abs(b.days[0] - 48) < 1 && Math.abs(b.note - b.days[1]) < 1 && same(b.side, ['snip', '']); })()
      && await isOn('#actNote') && await isOn('#actSnip') && !(await isOn('#actJournal')), JSON.stringify(await noteBox()));
    fs.rmSync(clipFile, { force: true });
    await win.click('#snipList .snip-copy');
    ok('E78 點剪貼簿的卡片：照樣複製內文、還是記事本', await waitFor(() => fs.existsSync(clipFile) && fs.readFileSync(clipFile, 'utf8') === '舊內容') && await shown('#notePane'),
      fs.existsSync(clipFile) ? JSON.stringify(fs.readFileSync(clipFile, 'utf8')) : '沒有檔');
    await win.reload();
    ok('E78 重新載入：一開起來還是記事本旁邊開著剪貼簿', await waitFor(async () => await shown('#notePane') && await shown('#snipPane') && !(await shown('#center'))) && await isOn('#actSnip'));
    await win.click('#actNote');
    ok('E78 再點「記事本」：不回日記，左欄換回記事清單、剪貼簿不算選到',
      await waitFor(async () => await shown('#notePane') && await shown('#noteList') && !(await shown('#snipPane')) && !(await shown('#center')))
      && !(await isOn('#actSnip')) && await isOn('#actNote') && same((await noteBox()).side, ['', '']));
    await win.click('#actSnip');
    await waitFor(() => shown('#snipPane'));
    await win.click('#actSnip');
    ok('E78 剪貼簿開著再點「剪貼簿」：收起左欄、還是記事本、接在頁籤列右邊；剪貼簿不算選到、記成收起來',
      await waitFor(async () => await shown('#notePane') && !(await shown('#days')))
      && await (async () => { const b = await noteBox(); return Math.abs(b.note - 48) < 1 && same(b.side, ['snip', '1']); })()
      && await isOn('#actNote') && !(await isOn('#actSnip')), JSON.stringify(await noteBox()));
    await win.click('#actJournal');
    ok('E78 記事本時點「日記本」：回到日記、左欄打開日記本', await waitFor(async () => await shown('#center') && await shown('#q') && !(await shown('#notePane'))) && await isOn('#actJournal'));
    await win.click('#actSnip');
    await waitFor(() => shown('#snipPane'));
    await win.click('#actNote');
    ok('E78 日記左欄放剪貼簿時點「記事本」：左欄換成記事清單', await waitFor(async () => await shown('#notePane') && await shown('#noteList') && !(await shown('#snipPane'))) && same((await noteBox()).side, ['', '']));

    // E80：記事清單、資料夾（見 開發筆記 D116）——照名稱排（數字照大小、不分大小寫、資料夾在前面）；外面加的清單跟著多、頁籤不會自己開；
    // 點一下預覽（點下一份換掉）、點兩下留著；× 關掉（沒改過不問、改過問、存了再關）；新增資料夾、在選到的資料夾裡新增記事、取名存在那裡；
    // 拖進資料夾（開著、改過沒存的跟著搬）、撞名不搬；同名的頁籤寫在哪個資料夾；資料夾改名（開著的跟著換）；重新載入記得開著的；
    // 沒記過開著哪些（更新後第一次）只開正在看的和改過沒存的；刪記事不問；刪有記事的資料夾先問（Esc 取消、確定，沒存的先寫進去）、刪空的不問；
    // 外面建的資料夾也出現、點了展開；全部收合。最後看的是第三份的標題（E79 要用）
    const activeId = () => win.evaluate(() => document.activeElement.id);
    const hints = () => win.$$eval('#noteTabs .noteDirHint', es => es.map(e => e.textContent));
    fs.writeFileSync(path.join(noteDir, 'b 10.txt'), 'B10');
    fs.writeFileSync(path.join(noteDir, 'b 9.txt'), 'B9');
    fs.writeFileSync(path.join(noteDir, 'A.txt'), 'aaa');
    ok('E80 外面加的記事：清單跟著多，照名稱排（A 不分大小寫排前面、b 9 在 b 10 前面）；頁籤不會自己開',
      await waitFor(async () => { const k = await listKeys(); return k.length === 4 && same(k.filter(x => /^f:[Ab]/.test(x)), ['f:A', 'f:b 9', 'f:b 10']); })
      && same(await noteNames(), ['第三份的標題']), JSON.stringify(await listKeys()));
    await win.click(`${rowSel('f:A')} .nlName`);
    ok('E80 點一下：開成預覽（斜體）、接在後面、游標還在清單',
      await waitFor(async () => same(await noteNames(), ['第三份的標題', 'A']) && (await curNote()) === 'A' && (await noteText()) === 'aaa' && (await previewName()) === 'A')
      && (await activeId()) !== 'noteText' && await win.$eval(rowSel('f:A'), r => r.classList.contains('on') && r.classList.contains('sel')), JSON.stringify(await noteNames()));
    await win.click(`${rowSel('f:b 9')} .nlName`);
    ok('E80 再點一份：換掉預覽的那個（同一個位置）', await waitFor(async () => same(await noteNames(), ['第三份的標題', 'b 9']) && (await previewName()) === 'b 9' && (await noteText()) === 'B9'),
      JSON.stringify(await noteNames()));
    await win.dblclick(`${rowSel('f:b 9')} .nlName`);
    ok('E80 點兩下：留下來（不是斜體）、游標進文字框', await waitFor(async () => (await previewName()) === null && (await activeId()) === 'noteText') && same(await noteNames(), ['第三份的標題', 'b 9']));
    await win.click(`${rowSel('f:b 10')} .nlName`);
    await waitFor(async () => (await previewName()) === 'b 10');
    await caretEnd();
    await win.keyboard.type('!');
    ok('E80 預覽的打字就留下來、標 ●', await waitFor(async () => (await previewName()) === null && same(await dirtyNames(), ['第三份的標題', 'b 10'])) && same(await noteNames(), ['第三份的標題', 'b 9', 'b 10']));
    await win.hover('#noteTabs .noteTab:nth-child(2)');
    await win.click('#noteTabs .noteTab:nth-child(2) .noteDel');
    ok('E80 × 沒改過的：不問、頁籤關掉、檔案還在、清單上還有；正在看的不變',
      await waitFor(async () => same(await noteNames(), ['第三份的標題', 'b 10'])) && (await curNote()) === 'b 10' && !(await shown('#noteAsk'))
      && fs.existsSync(path.join(noteDir, 'b 9.txt')) && (await listKeys()).includes('f:b 9'));
    await win.click('#noteTabs .noteTab.on .noteDel');
    ok('E80 × 改過沒存的：問要不要存', await waitFor(() => shown('#noteAsk')) && (await win.textContent('#noteAskMsg')).includes('「b 10」還沒存'));
    await win.click('#noteAskSave');
    ok('E80 存：寫進檔案再關、換到旁邊那份', await waitFor(async () => readN(path.join(noteDir, 'b 10.txt')) === 'B10!' && same(await noteNames(), ['第三份的標題']) && (await curNote()) === '第三份的標題'));
    await win.click('#nlAddDir');
    await win.waitForSelector('#noteTree .note-rename');
    await win.keyboard.type('工作');
    await win.keyboard.press('Enter');
    const dWork = path.join(noteDir, '工作');
    ok('E80 新增資料夾：清單多一行輸入框，Enter 建好；資料夾排在記事前面、選到它',
      await waitFor(async () => fs.existsSync(dWork) && (await listKeys())[0] === 'd:工作' && await win.$eval(rowSel('d:工作'), r => r.classList.contains('sel'))), JSON.stringify(await listKeys()));
    await win.click('#nlAddNote');
    ok('E80 選到資料夾時新增記事：新記事的頁籤寫會存在那裡',
      await waitFor(async () => (await curNote()) === '新記事 1' && (await win.getAttribute('#noteTabs .noteTab.on .noteName', 'title')).includes('存在「工作」')));
    await win.keyboard.type('工作的事');
    await win.keyboard.press('Control+s');
    await win.waitForSelector('#noteTabs .note-rename');
    await win.keyboard.press('Enter');
    const fJob = path.join(dWork, '工作的事.txt');
    const indent = k => win.$eval(rowSel(k), r => parseFloat(r.style.paddingLeft));
    ok('E80 取名存檔：存在那個資料夾；清單上資料夾打開、這份在它底下（多縮一層）、是正在看的那份',
      await waitFor(async () => readN(fJob) === '工作的事' && same((await listKeys()).slice(0, 2), ['d:工作', 'f:工作/工作的事'])
        && await win.$eval(rowSel('f:工作/工作的事'), r => r.classList.contains('on'))) && same(await noteNames(), ['第三份的標題', '工作的事'])
      && (await indent('f:工作/工作的事')) - (await indent('f:A')) === 12, JSON.stringify(await listKeys()));
    await win.dblclick(`${rowSel('f:A')} .nlName`);
    await waitFor(async () => (await curNote()) === 'A' && (await previewName()) === null);
    await caretEnd();
    await win.keyboard.type('+');
    await win.dragAndDrop(rowSel('f:A'), rowSel('d:工作'));
    ok('E80 拖進資料夾：檔案搬過去；開著、改過沒存的頁籤跟著搬（還是 ●、字還在）',
      await waitFor(async () => fs.existsSync(path.join(dWork, 'A.txt')) && !fs.existsSync(path.join(noteDir, 'A.txt')) && (await listKeys()).includes('f:工作/A')
        && same(await dirtyNames(), ['第三份的標題', 'A']) && (await noteText()) === 'aaa+' && (await curNote()) === 'A'), JSON.stringify(await listKeys()));
    await win.keyboard.press('Control+s');
    ok('E80 搬過去之後 Ctrl+S：寫進新的位置', await waitFor(() => readN(path.join(dWork, 'A.txt')) === 'aaa+'));
    fs.writeFileSync(path.join(noteDir, '工作的事.txt'), 'root');
    await waitFor(async () => (await listKeys()).includes('f:工作的事'));
    await win.dragAndDrop(rowSel('f:工作的事'), rowSel('d:工作'));
    ok('E80 拖到已經有同名的資料夾：不搬、提示', await waitFor(async () => (await toast()).includes('已經有「工作的事」')) && readN(path.join(noteDir, '工作的事.txt')) === 'root' && readN(fJob) === '工作的事',
      await toast());
    await win.dblclick(`${rowSel('f:工作的事')} .nlName`);
    ok('E80 開著兩份同名的（在不同資料夾）：頁籤後面淡淡寫在哪個資料夾', await waitFor(async () => same(await hints(), ['工作', '最上層'])), JSON.stringify(await hints()));
    await rowTool('d:工作', 1);
    await win.waitForSelector('#noteTree .note-rename');
    await win.fill('#noteTree .note-rename', '公司');
    await win.press('#noteTree .note-rename', 'Enter');
    const dCo = path.join(noteDir, '公司');
    ok('E80 資料夾改名：檔案跟著搬；開著的頁籤跟著換、還展開',
      await waitFor(async () => fs.existsSync(path.join(dCo, '工作的事.txt')) && !fs.existsSync(dWork) && (await listKeys())[0] === 'd:公司'
        && (await listKeys()).includes('f:公司/A') && same(await hints(), ['公司', '最上層'])), JSON.stringify({ list: await listKeys(), hints: await hints() }));
    await win.reload();
    ok('E80 重新載入：開著的頁籤、正在看的、展開的資料夾都照舊',
      await waitFor(async () => same(await noteNames(), ['第三份的標題', '工作的事', 'A', '工作的事']) && same(await hints(), ['公司', '最上層'])
        && (await win.getAttribute('#noteTabs .noteTab.on .noteName', 'title')).startsWith('工作的事（') && (await listKeys()).includes('f:公司/A')), JSON.stringify(await noteNames()));
    // 在 pagehide 才拿掉：舊的那頁在重新載入前可能還有一輪 refreshNotes 沒跑完、又把它寫回去（之後就不會再跑程式了）
    await win.evaluate(() => addEventListener('pagehide', () => localStorage.removeItem('daybook.noteTabs')));
    await win.reload();
    ok('E80 沒記過開著哪些（更新後第一次）：只開正在看的那份，改過沒存的也開著',
      await waitFor(async () => same(await noteNames(), ['工作的事', '第三份的標題']) && (await curNote()) === '工作的事'), JSON.stringify(await noteNames()));
    await rowTool('f:b 9', 2);
    ok('E80 清單上刪記事：不問、丟資源回收筒', await waitFor(() => !fs.existsSync(path.join(noteDir, 'b 9.txt')) && fs.existsSync(path.join(noteTrash, 'b 9.txt'))) && !(await shown('#noteAsk')));
    await win.dblclick(`${rowSel('f:公司/A')} .nlName`);
    await waitFor(async () => (await curNote()) === 'A');
    await caretEnd();
    await win.keyboard.type('Q');
    await rowTool('d:公司', 2);
    ok('E80 刪有記事的資料夾：先問（寫有幾份）、「存」換成「確定刪除」、沒有「不存」、游標在取消',
      await waitFor(() => shown('#noteAsk')) && (await win.textContent('#noteAskMsg')).includes('「公司」資料夾裡有 2 份記事') && (await win.textContent('#noteAskSave')) === '確定刪除'
      && !(await shown('#noteAskDrop')) && (await activeId()) === 'noteAskCancel', await win.textContent('#noteAskMsg'));
    await win.keyboard.press('Escape');
    ok('E80 Esc：不刪', await waitFor(async () => !(await shown('#noteAsk'))) && fs.existsSync(dCo));
    await rowTool('d:公司', 2);
    await waitFor(() => shown('#noteAsk'));
    await win.click('#noteAskSave');
    ok('E80 確定刪除：整個資料夾丟資源回收筒（改過沒存的先寫進去）、裡面開著的頁籤關掉、換到旁邊那份、清單上沒了',
      await waitFor(async () => !fs.existsSync(dCo) && readN(path.join(noteTrash, '公司', 'A.txt')) === 'aaa+Q' && same(await noteNames(), ['工作的事', '第三份的標題'])
        && (await curNote()) === '第三份的標題' && !(await listKeys()).some(k => k.includes('公司'))) && (await toast()).includes('資源回收筒'), JSON.stringify(await noteNames()));
    await win.click('#nlAddDir');
    await win.waitForSelector('#noteTree .note-rename');
    await win.keyboard.type('空的');
    await win.keyboard.press('Enter');
    await waitFor(async () => (await listKeys()).includes('d:空的'));
    await rowTool('d:空的', 2);
    ok('E80 刪空的資料夾：不問', await waitFor(() => !fs.existsSync(path.join(noteDir, '空的'))) && !(await shown('#noteAsk')));
    fs.mkdirSync(path.join(noteDir, '外面建的'));
    fs.writeFileSync(path.join(noteDir, '外面建的', 'in.txt'), 'i');
    ok('E80 外面建的資料夾：清單上也出現（收著）', await waitFor(async () => (await listKeys()).includes('d:外面建的')) && !(await listKeys()).includes('f:外面建的/in'));
    await win.click(`${rowSel('d:外面建的')} .nlName`);
    ok('E80 點資料夾：展開、選到它', await waitFor(async () => (await listKeys()).includes('f:外面建的/in')) && await win.$eval(rowSel('d:外面建的'), r => r.classList.contains('sel')));
    await win.click('#noteTree', { position: { x: 10, y: (await win.$eval('#noteTree', e => e.clientHeight)) - 5 } });
    ok('E80 點空白的地方：不選', await waitFor(async () => (await win.$$('#noteTree .nlRow.sel')).length === 0));
    await win.click('#nlCollapse');
    ok('E80 全部收合', await waitFor(async () => !(await listKeys()).includes('f:外面建的/in')) && (await curNote()) === '第三份的標題');

    // E81：找記事、F2、Delete、右鍵選單（見 開發筆記 D117）——只篩名稱（不分大小寫、每個詞都要有、資料夾跟著打開）、沒有符合的寫出來；
    // Ctrl+P（清單收著先打開）；Enter 開第一份；Esc 先清掉再回文字框；F2 改名（改完游標回清單）；游標在文字框時 F2 不理；
    // Delete 先問（游標在確定、Esc 取消回清單、Enter 刪）；右鍵：選到那行、複製路徑、在檔案總管中顯示、改名、在資料夾上新增記事、新增資料夾、
    // 空白的地方只有新增、Esc 收起來、刪除不問。最後回到第三份的標題（E79 要用）
    fs.writeFileSync(path.join(noteDir, '外面建的', 'report Q4.txt'), 'q4');
    fs.writeFileSync(path.join(noteDir, 'Report 2025.txt'), 'r');
    await waitFor(async () => (await listKeys()).includes('f:Report 2025'));
    await win.fill('#nlQ', 'REPORT');
    ok('E81 找記事：只留名稱符合的（不分大小寫）、它在的資料夾打開（收著的也打開）',
      await waitFor(async () => same(await listKeys(), ['d:外面建的', 'f:外面建的/report Q4', 'f:Report 2025'])), JSON.stringify(await listKeys()));
    await win.fill('#nlQ', 'report q4');
    ok('E81 空白隔開的每個詞都要有', await waitFor(async () => same(await listKeys(), ['d:外面建的', 'f:外面建的/report Q4'])), JSON.stringify(await listKeys()));
    await win.fill('#nlQ', '外面建的');
    ok('E81 只看記事的名稱：資料夾名稱不算、沒有符合的寫出來', await waitFor(async () => (await listKeys()).length === 0 && (await win.textContent('#noteTree')).includes('沒有符合的記事')));
    await win.fill('#nlQ', 'report');
    await caretEnd();
    await win.click('#actNote');
    await waitFor(async () => !(await shown('#days')));
    await win.keyboard.press('Control+p');
    ok('E81 Ctrl+P：清單收著先打開、游標跳進找記事、選著原本的字', await waitFor(async () => await shown('#noteList') && (await activeId()) === 'nlQ')
      && await win.evaluate(() => { const q = document.getElementById('nlQ'); return q.selectionStart === 0 && q.selectionEnd === q.value.length && q.value === 'report'; }));
    await win.keyboard.press('Enter');
    ok('E81 Enter：開第一份（留著，不是預覽）、游標進文字框', await waitFor(async () => (await curNote()) === 'report Q4' && (await previewName()) === null && (await activeId()) === 'noteText'));
    await win.focus('#nlQ');
    await win.keyboard.press('Escape');
    ok('E81 Esc：有字先清掉、清單回到原本的樣子', await waitFor(async () => (await win.inputValue('#nlQ')) === '' && (await listKeys()).includes('f:b 10') && (await activeId()) === 'nlQ'));
    await win.keyboard.press('Escape');
    ok('E81 再按 Esc：沒字就回文字框', await waitFor(async () => (await activeId()) === 'noteText'));
    await win.keyboard.press('F2');
    ok('E81 游標在文字框時 F2 不理', await sleep(300).then(async () => !(await win.$('#noteTree .note-rename'))));
    await win.click(`${rowSel('f:b 10')} .nlName`);
    await waitFor(async () => (await curNote()) === 'b 10');
    await win.keyboard.press('F2');
    ok('E81 點過清單那一行按 F2：那行變成改名框、帶原本的名稱', await waitFor(async () => (await win.inputValue('#noteTree .note-rename').catch(() => null)) === 'b 10'));
    await win.fill('#noteTree .note-rename', 'b 11');
    await win.keyboard.press('Enter');
    const inTree = () => win.evaluate(() => document.getElementById('noteTree').contains(document.activeElement));
    ok('E81 Enter：改好（開著的頁籤跟著換）、游標回清單上那一行',
      await waitFor(async () => fs.existsSync(path.join(noteDir, 'b 11.txt')) && !fs.existsSync(path.join(noteDir, 'b 10.txt')) && (await curNote()) === 'b 11'
        && await win.evaluate(() => document.activeElement.closest('.nlRow')?.dataset.key === 'f:b 11')), JSON.stringify(await noteNames()));
    await win.keyboard.press('Delete');
    ok('E81 Delete：先問「把「b 11」丟到資源回收筒？」、游標在確定刪除', await waitFor(() => shown('#noteAsk'))
      && (await win.textContent('#noteAskMsg')) === '把「b 11」丟到資源回收筒？' && (await activeId()) === 'noteAskSave' && !(await shown('#noteAskDrop')));
    await win.keyboard.press('Escape');
    ok('E81 Esc：不刪、游標回清單', await waitFor(async () => !(await shown('#noteAsk')) && await inTree()) && fs.existsSync(path.join(noteDir, 'b 11.txt')));
    await win.keyboard.press('Delete');
    await waitFor(() => shown('#noteAsk'));
    await win.keyboard.press('Enter');
    ok('E81 Enter：丟資源回收筒、頁籤關掉、游標還在清單', await waitFor(async () => !fs.existsSync(path.join(noteDir, 'b 11.txt')) && fs.existsSync(path.join(noteTrash, 'b 11.txt'))
      && !(await noteNames()).includes('b 11') && await inTree()));
    const menuItems = () => win.$$eval('#noteMenu button', bs => bs.filter(b => b.offsetParent).map(b => b.firstChild.textContent));
    const R = rowSel('f:Report 2025'), fR = path.join(noteDir, 'Report 2025.txt');
    const rc = await win.$eval(R, r => { const b = r.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });   // Playwright 點在正中間
    await win.click(R, { button: 'right' });
    const menuAt = await win.$eval('#noteMenu', m => { const b = m.getBoundingClientRect(); return [b.left, b.top]; }).catch(() => null);
    ok('E81 右鍵在記事上：選到那行、選單左上角在按的地方、六項',
      await waitFor(() => shown('#noteMenu')) && same(await menuItems(), ['新增記事', '新增資料夾', '改名', '刪除', '在檔案總管中顯示', '複製路徑'])
      && await win.$eval(R, r => r.classList.contains('sel')) && menuAt && Math.abs(menuAt[0] - rc[0]) < 2 && Math.abs(menuAt[1] - rc[1]) < 2,
      JSON.stringify({ items: await menuItems(), rc, menuAt }));
    fs.rmSync(clipFile, { force: true });
    await win.click('#noteMenu button[data-act="copy"]');
    ok('E81 複製路徑：完整路徑進剪貼簿、選單收起來', await waitFor(() => fs.existsSync(clipFile) && fs.readFileSync(clipFile, 'utf8') === fR) && !(await shown('#noteMenu')),
      fs.existsSync(clipFile) ? fs.readFileSync(clipFile, 'utf8') : '沒有檔');
    await win.click(R, { button: 'right' });
    await win.click('#noteMenu button[data-act="reveal"]');
    ok('E81 在檔案總管中顯示：用那份的完整路徑（測試寫進 --open-log）', await waitFor(() => fs.readFileSync(openLog, 'utf8').trim().split('\n').pop() === fR));
    await win.click(R, { button: 'right' });
    await win.click('#noteMenu button[data-act="rename"]');
    await win.waitForSelector('#noteTree .note-rename');
    await win.fill('#noteTree .note-rename', 'R2025');
    await win.keyboard.press('Enter');
    ok('E81 右鍵改名', await waitFor(() => fs.existsSync(path.join(noteDir, 'R2025.txt')) && !fs.existsSync(fR)));
    await win.click(rowSel('d:外面建的'), { button: 'right' });
    await win.click('#noteMenu button[data-act="note"]');
    ok('E81 在資料夾上右鍵「新增記事」：存在那個資料夾', await waitFor(async () => (await curNote()) === '新記事 1'
      && (await win.getAttribute('#noteTabs .noteTab.on .noteName', 'title')).includes('存在「外面建的」')));
    await win.click('#noteTabs .noteTab.on .noteDel');   // 沒字，直接關
    await win.click(rowSel('d:外面建的'), { button: 'right' });
    await win.click('#noteMenu button[data-act="dir"]');
    await win.waitForSelector('#noteTree .note-rename');
    await win.keyboard.type('子');
    await win.keyboard.press('Enter');
    ok('E81 在資料夾上右鍵「新增資料夾」：建在那個資料夾裡', await waitFor(() => fs.existsSync(path.join(noteDir, '外面建的', '子'))));
    await win.click('#noteTree', { button: 'right', position: { x: 10, y: (await win.$eval('#noteTree', e => e.clientHeight)) - 5 } });
    ok('E81 右鍵在空白的地方：只有新增記事、新增資料夾；不選', await waitFor(async () => same(await menuItems(), ['新增記事', '新增資料夾']))
      && (await win.$$('#noteTree .nlRow.sel')).length === 0, JSON.stringify(await menuItems()));
    await win.keyboard.press('Escape');
    ok('E81 Esc：選單收起來', await waitFor(async () => !(await shown('#noteMenu'))));
    // E142（記事清單）：選單共用的那套（見 開發筆記 D182）——鍵盤叫出來的放在那行底下、選到那行；Esc 游標回那一行；點外面收起來
    const kAt = await keyMenuAt(win.locator(rowSel('f:R2025')), 'noteMenu');
    ok('E142 記事清單：鍵盤叫出來的（沒有座標）放在那行底下、選到那行', await shown('#noteMenu') && same(kAt, [16, 0])
      && await win.$eval(rowSel('f:R2025'), r => r.classList.contains('sel')), JSON.stringify(kAt));
    await win.keyboard.press('Escape');
    ok('E142 記事清單 Esc：選單收起來、游標回那一行', await waitFor(async () => !(await shown('#noteMenu')))
      && await win.evaluate(() => document.activeElement.closest('.nlRow')?.dataset.key) === 'f:R2025');
    await win.click(rowSel('f:R2025'), { button: 'right' });
    await waitFor(() => shown('#noteMenu'));
    await outsideDown(win);
    ok('E142 記事清單：點外面收起來', await waitFor(async () => !(await shown('#noteMenu'))));
    await win.click(rowSel('f:R2025'), { button: 'right' });
    await win.click('#noteMenu button[data-act="delete"]');
    ok('E81 右鍵刪除記事：跟 × 一樣不問、丟資源回收筒', await waitFor(() => !fs.existsSync(path.join(noteDir, 'R2025.txt')) && fs.existsSync(path.join(noteTrash, 'R2025.txt'))) && !(await shown('#noteAsk')));
    await win.click('#noteTabs .noteTab[data-key="f:第三份的標題"] .noteName');
    await waitFor(async () => (await curNote()) === '第三份的標題');

    await win.click('#actJournal');
    ok('E72 記事本時點「日記本」：回到日記、左欄換回日記本', await waitFor(async () => await shown('#center') && await shown('#q') && !(await shown('#notePane'))) && await isOn('#actJournal'));
    }

    // E79：外觀頁「字型」（見 開發筆記 D113）——介面、內容的字型和內容字的大小，改了馬上套上（按鈕、說明的字不跟）、記在這台電腦；
    // 記事本的行號跟著重量；標題的灰字照新的字疊；超出 10～24 夾回來；重新載入一開起來就套上；選過、這台沒有的字型照樣列出來；還原預設
    {
    const fontsOf = () => win.evaluate(() => {
      const cs = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const size = sel => cs(sel)?.fontSize ?? null;
      const fam = sel => (cs(sel)?.fontFamily ?? '').split(',')[0].replace(/"/g, '').trim();
      return {
        ui: fam('body'), mono: fam('#newBody'),
        // 內容：文字模式、記事本（文字框、墊底那層、行號）、卡片標題、內文、新增表單、提示清單、外觀頁的預覽
        sizes: ['#editor', '#noteText', '#noteMirror', '#noteGutter', '.card .title', '.card .body', '#newTitle', '#newBody', '#suggest', '#fontSample .sample-title', '#fontSample .sample-body'].map(size),
        fixed: ['body', '#addDone', '#skin .filesLead', '.card .badge'].map(size),   // 介面：不跟著變
        formMin: cs('#newForm').minHeight,   // 輸入區最小的高度：標題、內文各多一行，按鈕列才不會被切掉
        saved: localStorage.getItem('daybook.font'),
      };
    });
    const px = (a, b) => [a, a, a, a, a, b, b, b, b, a, b].map(n => n + 'px');
    // 行號的位置＝墊底那層每一行的位置（D103）
    const rowsOk = () => win.evaluate(() => {
      const nums = [...document.querySelectorAll('#noteNums > div')], rows = [...document.getElementById('noteMirror').children];
      return nums.length >= 2 && nums.length === rows.length && nums.every((n, i) => Math.abs(parseFloat(n.style.top) - rows[i].offsetTop) < 0.5);
    });
    await win.click('#actNote');
    ok('E79 前提：記事本開著、有兩行以上，行號對得上', await waitFor(async () => await win.isVisible('#noteText') && await rowsOk()));
    const def = await fontsOf();
    await viaSettings(win, '#skinBtn');
    await waitFor(() => win.isVisible('#fontUi'));
    const opts = await win.$$eval('#fontUi option', os => os.map(o => ({ v: o.value, f: o.style.fontFamily.replace(/"/g, '') })));
    ok('E79 沒改過：微軟正黑體 UI、Consolas、14（小一號的 13），沒記；選單是預設、14、還原鈕變灰；字型清單是這台電腦裝的（有 Arial、Courier New）、每個用自己的字型顯示',
      def.ui === 'Microsoft JhengHei UI' && def.mono === 'Consolas' && same(def.sizes, px(14, 13)) && def.formMin === '140px' && def.saved === null
      && (await win.inputValue('#fontUi')) === '' && (await win.inputValue('#fontMono')) === '' && (await win.inputValue('#fontSize')) === '14' && await win.isDisabled('#fontReset')
      && opts[0].v === '' && opts.some(o => o.v === 'Arial' && o.f === 'Arial') && opts.some(o => o.v === 'Courier New'),
      JSON.stringify({ def, n: opts.length, first: opts.slice(0, 3) }));
    await win.selectOption('#fontUi', 'Arial');
    await win.selectOption('#fontMono', 'Courier New');
    await win.fill('#fontSize', '18');
    await win.press('#fontSize', 'Enter');
    const big = await fontsOf();
    ok('E79 選介面 Arial、內容 Courier New、打 18 按 Enter：馬上套上（內容 18、小一號的 17），按鈕、說明、標籤的字不變；輸入區最小高度 140 + 3.2 × 4；記在這台電腦；還原鈕能按',
      big.ui === 'Arial' && big.mono === 'Courier New' && same(big.sizes, px(18, 17)) && same(big.fixed, def.fixed) && big.formMin === '152.8px'
      && big.saved === JSON.stringify({ ui: 'Arial', mono: 'Courier New', size: 18 }) && await win.isEnabled('#fontReset'), JSON.stringify(big));
    ok('E79 記事本的行號跟著重量：還是對得上墊底那層每一行', await waitFor(rowsOk));
    const sizeAfter = async (typed, key) => {
      if (typed != null) await win.fill('#fontSize', typed);
      await win.press('#fontSize', key);
      return [await win.inputValue('#fontSize'), (await fontsOf()).sizes[0], JSON.parse((await fontsOf()).saved).size ?? null];
    };
    const clamp = [await sizeAfter('40', 'Enter'), await sizeAfter('3', 'Enter'), await sizeAfter('', 'Enter')];
    ok('E79 超出範圍夾回來：40 → 24、3 → 10；清空 → 14（不記大小）', same(clamp, [['24', '24px', 24], ['10', '10px', 10], ['14', '14px', null]]), JSON.stringify(clamp));
    for (let i = 0; i < 4; i++) await win.press('#fontSize', 'ArrowUp');
    ok('E79 方向鍵 ↑ 四下：馬上換成 18', same([await win.inputValue('#fontSize'), (await fontsOf()).sizes[0]], ['18', '18px']), JSON.stringify(await fontsOf()));
    await win.keyboard.press('Escape');
    await win.click('#actJournal');   // 回到日記（D116 起再點「記事本」是收起記事清單）
    await waitFor(() => win.isVisible('#newTitle'));
    await win.fill('#newTitle', 'cwmm');
    await waitFor(async () => (await ghostOf('#newTitle')) !== '');
    const gh = await win.evaluate(() => {
      const g = document.querySelector('#newTitle + .ghost'), cs = getComputedStyle(document.getElementById('newTitle'));
      return [g.style.fontSize, cs.fontSize, g.style.fontFamily === cs.fontFamily];
    });
    ok('E79 標題的灰字照新的字疊：大小、字型跟框一樣（17px）', same(gh, ['17px', '17px', true]), JSON.stringify(gh));
    await win.fill('#newTitle', '');
    await win.reload();
    await win.waitForSelector('#dayList button');
    const re = await fontsOf();
    ok('E79 重新載入：一開起來就是選的字型、大小', re.ui === 'Arial' && re.mono === 'Courier New' && same(re.sizes, px(18, 17)), JSON.stringify(re));
    await viaSettings(win, '#skinBtn');
    await waitFor(() => win.isVisible('#fontUi'));
    ok('E79 再打開外觀頁：選單照記的', same([await win.inputValue('#fontUi'), await win.inputValue('#fontMono'), await win.inputValue('#fontSize'), await win.isEnabled('#fontReset')],
      ['Arial', 'Courier New', '18', true]));
    await win.keyboard.press('Escape');
    // 選過、後來移除的字型：選單照樣列出來，標「這台電腦沒有」
    await win.evaluate(() => localStorage.setItem('daybook.font', JSON.stringify({ mono: 'daybook 沒有的字型' })));
    await win.reload();
    await win.waitForSelector('#dayList button');
    await viaSettings(win, '#skinBtn');
    await waitFor(() => win.isVisible('#fontUi'));
    const gone = await win.$eval('#fontMono', s => [s.value, s.selectedOptions[0].textContent, s.options[s.options.length - 1] === s.selectedOptions[0]]);
    ok('E79 選過、這台電腦沒有的字型：列在最後、選著、標「這台電腦沒有」', same(gone, ['daybook 沒有的字型', 'daybook 沒有的字型（這台電腦沒有）', true]), JSON.stringify(gone));
    await win.click('#fontReset');
    const back = await fontsOf();
    ok('E79 還原預設字型：回到微軟正黑體 UI、Consolas、14，記的清空、選單回預設、按鈕變灰、跳提示',
      back.ui === def.ui && back.mono === def.mono && same(back.sizes, def.sizes) && back.formMin === '140px' && back.saved === '{}'
      && same([await win.inputValue('#fontUi'), await win.inputValue('#fontMono'), await win.inputValue('#fontSize')], ['', '', '14']) && await win.isDisabled('#fontReset')
      && ((await win.textContent('#toast')) || '').includes('已還原預設字型'), JSON.stringify(back));
    await win.keyboard.press('Escape');
    }

    // E82：MD 檢視（見 開發筆記 D118）——頁籤列多一格：中間換成轉好的 .md、左欄換成釘住的資料夾；釘資料夾（--pick-md-dir）、只列有 .md 的資料夾、
    // node_modules／.git 不列；點一下預覽、再點一份換掉、點兩下留著、× 關掉；內容：標題、表格（<br> 換行）、核取清單、檔案裡的 HTML 照原字、圖片換成字；
    // 連結：網址寫進 --open-log（Ctrl、中鍵點也是，不開新視窗）、相對的 .md 在這裡開、開不了的提示；捲到哪留著（換頁籤、回日記再回來）；
    // 外面改了自動重畫、多了少了跟著變；同名的頁籤寫資料夾；重複釘提示；重新載入照舊；不釘了頁籤跟著關；
    // 再點「MD 檢視」收起清單、剪貼簿輪流、記事本來回、Ctrl+F 不理；最後回日記（E28 要用搜尋框）
    {
    const shown = sel => win.isVisible(sel);
    const isOn = id => win.$eval(id, b => b.classList.contains('on'));
    const esc = p => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const mdRowSel = p => `#mdTree .nlRow[data-key="${esc(p)}"]`;
    const mdTabSel = p => `#mdTabs .noteTab[data-key="${esc(p)}"] .noteName`;
    const mdKeys = () => win.$$eval('#mdTree .nlRow', rs => rs.map(r => r.dataset.key));
    const mdTabs = () => win.$$eval('#mdTabs .noteTab', ts => ts.map(t => t.dataset.key));
    const mdPreview = () => win.evaluate(() => document.querySelector('#mdTabs .noteTab.preview')?.dataset.key ?? null);
    const mdCur = () => win.evaluate(() => document.querySelector('#mdTabs .noteTab.on')?.dataset.key ?? null);
    const mdText = () => win.evaluate(() => document.getElementById('mdView').innerText);
    const mdTop = () => win.$eval('#mdView', v => v.scrollTop);
    const toastText = async () => (await win.textContent('#toast').catch(() => '')) || '';
    const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim().split('\n') : []);
    const pA = f => path.join(mdA, ...f.split('/')), pB = f => path.join(mdB, ...f.split('/'));

    await win.click('#actMd');
    // 中間、清單的字是點了之後重讀、重畫（refreshMd）才寫上的：一起放在等的裡面，重畫慢一點也不會先讀到舊的（同 E84 的修法，2026-11-03）
    ok('E82 點「MD 檢視」：中間換成它、左欄換成它的清單；還沒釘資料夾時寫怎麼釘',
      await waitFor(async () => await shown('#mdPane') && await shown('#mdList') && !(await shown('#center')) && !(await shown('#q'))
        && (await win.textContent('#mdEmpty')).includes('還沒有釘資料夾') && (await win.textContent('#mdTree')).includes('還沒有釘資料夾'))
      && await isOn('#actMd') && !(await isOn('#actJournal')) && (await win.textContent('#statusKeys')).includes('文件檢視：只看不改'));
    await win.click('#mdAddRoot');
    ok('E82 釘資料夾：最上面一層是它（打開）；只列有 .md 的資料夾，資料夾在前面、照名稱排；node_modules、.git、只有圖的不列',
      await waitFor(async () => same(await mdKeys(), [mdA, pA('子'), pA('long.md'), pA('report.md')])) && (await win.textContent('#mdEmpty')).includes('沒有開著的文件'),
      JSON.stringify(await mdKeys()));
    await win.click(`${mdRowSel(pA('report.md'))} .nlName`);
    ok('E82 點一下：開成預覽（斜體）', await waitFor(async () => same(await mdTabs(), [pA('report.md')]) && (await mdPreview()) === pA('report.md') && (await mdCur()) === pA('report.md')));
    const got = await waitFor(() => win.evaluate(() => {
      const v = document.getElementById('mdView');
      if (!v.querySelector('h1')) return null;
      return { h1: v.querySelector('h1').textContent, br: v.querySelectorAll('td br').length, script: v.querySelectorAll('script').length, cell: v.querySelectorAll('td')[1]?.textContent,
        bad: window.mdBad === undefined, boxes: [...v.querySelectorAll('input[type="checkbox"]')].map(b => [b.checked, b.disabled]), img: v.querySelectorAll('img').length,
        ph: v.querySelector('.mdImg')?.textContent, raw: v.querySelector('.mdRaw')?.textContent, code: v.querySelector('pre code')?.textContent };
    }));
    ok('E82 內容：標題、表格（<br> 換行）、核取清單（不能勾）、程式碼；檔案裡的 HTML 照原字（不跑）、圖片換成字',
      same(got, { h1: '週報 <b>粗</b>', br: 1, script: 0, cell: '<script>window.mdBad = 1</script>', bad: true, boxes: [[true, true], [false, true]], img: 0,
        ph: '〔圖：圖說〕', raw: '<div class="x">原字</div>', code: 'const a = "<b>";\n' }), JSON.stringify(got));
    const link = text => win.locator('#mdView a', { hasText: text });
    await link('網址').click();
    ok('E82 網址連結：用瀏覽器開（測試寫進 --open-log）', await waitFor(() => opened().pop() === 'https://example.com/x'));
    const n0 = opened().length, pages0 = win.context().pages().length;
    await link('網址').click({ modifiers: ['Control'] });
    await link('網址').click({ button: 'middle' });
    ok('E82 Ctrl＋點、中鍵點：一樣用瀏覽器開，不開新視窗',
      await waitFor(() => opened().length === n0 + 2) && await sleep(300).then(() => win.context().pages().length === pages0) && (await mdCur()) === pA('report.md'));
    await link('壞的').click();
    ok('E82 連到不存在的 .md：不開、提示', await waitFor(async () => (await toastText()).includes('開不了')) && (await mdCur()) === pA('report.md'));
    await win.click(`${mdRowSel(pA('子'))} .nlName`);
    await waitFor(async () => (await mdKeys()).includes(pA('子/說明.md')));
    await win.click(`${mdRowSel(pA('子'))} .nlName`);
    await waitFor(async () => !(await mdKeys()).includes(pA('子/說明.md')));
    await link('說明').click();
    ok('E82 相對路徑連到別份 .md：在這裡開（留著，不是預覽）、清單打開它在的資料夾',
      await waitFor(async () => (await mdCur()) === pA('子/說明.md') && (await mdText()).includes('說明的內文'))
      && same(await mdTabs(), [pA('report.md'), pA('子/說明.md')]) && (await mdPreview()) === pA('report.md') && (await mdKeys()).includes(pA('子/README.md')),
      JSON.stringify({ tabs: await mdTabs(), keys: await mdKeys() }));
    await win.click(`${mdRowSel(pA('long.md'))} .nlName`);
    ok('E82 清單上再點一份：換掉預覽的那個（同一個位置）',
      await waitFor(async () => same(await mdTabs(), [pA('long.md'), pA('子/說明.md')]) && (await mdPreview()) === pA('long.md') && (await mdText()).includes('第 200 段')));
    await win.dblclick(`${mdRowSel(pA('long.md'))} .nlName`);
    ok('E82 點兩下：留下來', await waitFor(async () => (await mdPreview()) === null) && same(await mdTabs(), [pA('long.md'), pA('子/說明.md')]));
    await win.$eval('#mdView', v => { v.scrollTop = 300; });
    await waitFor(async () => (await mdTop()) === 300);
    await win.click(mdTabSel(pA('子/說明.md')));
    await waitFor(async () => (await mdCur()) === pA('子/說明.md') && (await mdTop()) === 0);
    await win.click(mdTabSel(pA('long.md')));
    const back1 = await waitFor(async () => (await mdCur()) === pA('long.md') && (await mdTop()) === 300);
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    await win.click('#actMd');
    ok('E82 捲到哪留著：換頁籤再回來、回日記再回來都照舊', back1 && await waitFor(async () => await shown('#mdView') && (await mdTop()) === 300), String(await mdTop()));
    fs.writeFileSync(pA('long.md'), mdLong + '\n\n外面加的一段');
    ok('E82 外面改了正在看的：自動重畫、捲到哪留著', await waitFor(async () => (await mdText()).includes('外面加的一段')) && (await mdTop()) === 300);
    fs.writeFileSync(pA('子/新的.md'), '# 新');
    ok('E82 外面多一份：清單跟著多', await waitFor(async () => (await mdKeys()).includes(pA('子/新的.md'))));
    fs.rmSync(pA('子/說明.md'));
    ok('E82 外面刪掉開著的：頁籤拿掉、清單上也沒了', await waitFor(async () => same(await mdTabs(), [pA('long.md')]) && !(await mdKeys()).includes(pA('子/說明.md'))));
    await win.click('#mdAddRoot');
    ok('E82 再釘一個：接在後面', await waitFor(async () => { const k = await mdKeys(); return k.indexOf(mdB) > k.indexOf(mdA) && k.includes(pB('README.md')); }), JSON.stringify(await mdKeys()));
    await win.dblclick(`${mdRowSel(pB('README.md'))} .nlName`);
    await waitFor(async () => (await mdCur()) === pB('README.md') && (await mdPreview()) === null);
    await win.dblclick(`${mdRowSel(pA('子/README.md'))} .nlName`);
    await waitFor(async () => (await mdCur()) === pA('子/README.md') && (await mdPreview()) === null);
    const hints = () => win.$$eval('#mdTabs .noteDirHint', hs => hs.map(h => h.textContent));
    ok('E82 開著兩份同名的：頁籤後面寫在哪個資料夾', await waitFor(async () => same(await hints(), ['mdB', '子'])), JSON.stringify(await hints()));
    await win.click('#mdAddRoot');
    ok('E82 同一個資料夾再釘一次：提示已經釘了、清單不變', await waitFor(async () => (await toastText()).includes('已經釘了')) && (await mdKeys()).filter(k => k === mdB).length === 1);
    const tabs1 = await mdTabs();
    await win.reload();
    ok('E82 重新載入：還是 MD 檢視；開著的頁籤、正在看的、展開的資料夾、釘的資料夾照舊',
      await waitFor(async () => await shown('#mdPane') && same(await mdTabs(), tabs1) && (await mdCur()) === pA('子/README.md') && (await mdKeys()).includes(pA('子/新的.md')) && (await mdKeys()).includes(mdB)),
      JSON.stringify({ tabs: await mdTabs(), keys: await mdKeys() }));
    await win.click(`#mdTabs .noteTab.on .noteDel`);
    ok('E82 ×：關掉、換到旁邊那份；檔案還在', await waitFor(async () => same(await mdTabs(), [pA('long.md'), pB('README.md')]) && (await mdCur()) === pB('README.md')) && fs.existsSync(pA('子/README.md')));
    await win.hover(mdRowSel(mdB));
    await win.click(`${mdRowSel(mdB)} .nlTools button`);
    ok('E82 不釘：從清單拿掉、裡面開著的頁籤關掉、換到旁邊那份；檔案還在',
      await waitFor(async () => !(await mdKeys()).includes(mdB) && same(await mdTabs(), [pA('long.md')]) && (await mdCur()) === pA('long.md')) && fs.existsSync(pB('README.md')));
    await win.keyboard.press('Control+f');
    ok('E82 Ctrl+F：打開文件檢視自己的找字框（D147，細的在 E115），不跳去日記的搜尋框',
      await waitFor(async () => await shown('#mdFind') && (await win.evaluate(() => document.activeElement.id)) === 'mdFindQ'));
    await win.keyboard.press('Escape');
    await win.click('#actMd');
    ok('E82 清單開著再點「MD 檢視」：收起左欄', await waitFor(async () => !(await shown('#mdList')) && await shown('#mdPane')) && await isOn('#actMd'));
    await win.click('#actMd');
    ok('E82 再點：打開清單', await waitFor(() => shown('#mdList')));
    await win.click('#actSnip');
    ok('E82 點「剪貼簿」：左欄換成剪貼簿、中間還是 MD 檢視', await waitFor(async () => await shown('#snipPane') && !(await shown('#mdList')) && await shown('#mdPane')) && await isOn('#actSnip'));
    await win.click('#actMd');
    await waitFor(() => shown('#mdList'));
    await win.click('#actNote');
    ok('E82 換到記事本：記事本出來、MD 檢視藏起來', await waitFor(async () => await shown('#notePane') && await shown('#noteList') && !(await shown('#mdPane')) && !(await shown('#mdList'))) && !(await isOn('#actMd')));
    await win.click('#actMd');
    ok('E82 再換回來：開著的照舊', await waitFor(async () => await shown('#mdPane') && !(await shown('#notePane')) && same(await mdTabs(), [pA('long.md')]) && (await mdText()).includes('外面加的一段')));
    await win.click('#actJournal');
    ok('E82 點「日記本」：回到日記、狀態列換回日記的', await waitFor(async () => await shown('#center') && await shown('#q') && !(await shown('#mdPane'))) && await isOn('#actJournal')
      && (await win.textContent('#statusKeys')).includes('換日'));
    }

    // E83：頁籤的右鍵選單（見 開發筆記 D120）——記事本：先全部關閉（有沒存的就全部不存）；開 tm1～tm4，右鍵 tm2：六項、不換正在看的、選單在按的地方；
    // 複製路徑、在檔案總管中顯示；最右邊的「關閉右側」點不了；tm3 改過沒存時關閉右側：問一份（Esc 都不關；存＝寫進去再關、換到左邊那份）；
    // 新記事有字＋tm1 改過沒存時關閉其他：問兩份「全部存」（tm1 寫進去關掉、新記事留著）；全部關閉：新記事「不存」；關閉；新記事的選單沒有路徑那兩項。
    // MD 檢視：複製路徑、在檔案總管中顯示、關閉其他、關閉右側、全部關閉。最後回日記
    {
    const shown = sel => win.isVisible(sel);
    const noteDir = path.join(data, '記事本');
    const tabNames = box => win.$$eval(`${box} .noteName`, els => els.map(e => e.firstChild?.textContent ?? ''));
    const curTab = box => win.$eval(`${box} .noteTab.on .noteName`, e => e.firstChild?.textContent ?? '').catch(() => null);
    const tabOf = (box, name) => win.locator(`${box} .noteTab`).filter({ has: win.locator('.noteName', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }) }).first();
    const menuItems = () => win.$$eval('#tabMenu button', bs => bs.filter(b => b.offsetParent).map(b => (b.disabled ? '(' + b.textContent + ')' : b.textContent)));
    const menu = async (box, name, act) => { await tabOf(box, name).click({ button: 'right' }); await waitFor(() => shown('#tabMenu')); if (act) await win.click(`#tabMenu button[data-act="${act}"]`); };
    const askMsg = async () => (await shown('#noteAsk')) && [await win.textContent('#noteAskMsg'), await win.textContent('#noteAskSave'), await win.textContent('#noteAskDrop')];
    const toastText = async () => (await win.textContent('#toast').catch(() => '')) || '';
    const lastOpened = () => fs.readFileSync(openLog, 'utf8').trim().split('\n').pop();

    await win.click('#actNote');
    await waitFor(() => shown('#notePane'));
    if ((await tabNames('#noteTabs')).length) {
      await menu('#noteTabs', (await tabNames('#noteTabs'))[0], 'all');
      if (await waitFor(() => shown('#noteAsk'), 1000)) await win.click('#noteAskDrop');
    }
    ok('E83 前提：記事本的頁籤全部關閉（有沒存的全部不存）', await waitFor(async () => (await tabNames('#noteTabs')).length === 0 && await shown('#noteEmpty')), JSON.stringify(await tabNames('#noteTabs')));
    for (let n = 1; n <= 4; n++) fs.writeFileSync(path.join(noteDir, `tm${n}.txt`), `t${n}`);
    await waitFor(() => win.$('#noteTree .nlRow[data-key="f:tm4"]'));
    for (let n = 1; n <= 4; n++) {
      await win.dblclick(`#noteTree .nlRow[data-key="f:tm${n}"] .nlName`);
      await waitFor(async () => (await curTab('#noteTabs')) === `tm${n}` && !(await win.$('#noteTabs .noteTab.preview')));
    }
    const at = await tabOf('#noteTabs', 'tm2').boundingBox();
    await menu('#noteTabs', 'tm2');
    const mAt = await win.$eval('#tabMenu', m => { const b = m.getBoundingClientRect(); return [b.left, b.top]; });
    ok('E83 記事本頁籤按右鍵：六項（關閉、關閉其他、關閉右側、全部關閉、在檔案總管中顯示、複製路徑）、正在看的不換、選單在按的地方',
      same(await menuItems(), ['關閉', '關閉其他', '關閉右側', '全部關閉', '在檔案總管中顯示', '複製路徑']) && (await curTab('#noteTabs')) === 'tm4'
      && Math.abs(mAt[0] - (at.x + at.width / 2)) < 2 && Math.abs(mAt[1] - (at.y + at.height / 2)) < 2, JSON.stringify({ items: await menuItems(), mAt, at }));
    fs.rmSync(clipFile, { force: true });
    await win.click('#tabMenu button[data-act="copy"]');
    ok('E83 複製路徑：完整路徑進剪貼簿、選單收起來', await waitFor(() => fs.existsSync(clipFile) && fs.readFileSync(clipFile, 'utf8') === path.join(noteDir, 'tm2.txt')) && !(await shown('#tabMenu')));
    await menu('#noteTabs', 'tm2', 'reveal');
    ok('E83 在檔案總管中顯示：那份的完整路徑（測試寫進 --open-log）', await waitFor(() => lastOpened() === path.join(noteDir, 'tm2.txt')));
    await menu('#noteTabs', 'tm4');
    ok('E83 最右邊那個：「關閉右側」淡色點不了', same(await menuItems(), ['關閉', '關閉其他', '(關閉右側)', '全部關閉', '在檔案總管中顯示', '複製路徑']), JSON.stringify(await menuItems()));
    await win.keyboard.press('Escape');
    ok('E83 Esc：選單收起來', await waitFor(async () => !(await shown('#tabMenu'))));
    await tabOf('#noteTabs', 'tm3').locator('.noteName').click();
    await waitFor(async () => (await curTab('#noteTabs')) === 'tm3');
    await win.keyboard.type('X');
    await menu('#noteTabs', 'tm2', 'right');
    ok('E83 關閉右側碰到一份改過沒存的：問「「tm3」還沒存」，存／不存', same(await waitFor(askMsg), ['「tm3」還沒存，要存起來嗎？', '存', '不存']), JSON.stringify(await askMsg()));
    await win.keyboard.press('Escape');
    ok('E83 Esc：都不關', await waitFor(async () => !(await shown('#noteAsk'))) && same(await tabNames('#noteTabs'), ['tm1', 'tm2', 'tm3', 'tm4']));
    await menu('#noteTabs', 'tm2', 'right');
    await waitFor(() => shown('#noteAsk'));
    await win.click('#noteAskSave');
    ok('E83 存：寫進去、右邊的都關掉、正在看的換到左邊那份',
      await waitFor(async () => same(await tabNames('#noteTabs'), ['tm1', 'tm2']) && (await curTab('#noteTabs')) === 'tm2') && readN(path.join(noteDir, 'tm3.txt')) === 'Xt3', readN(path.join(noteDir, 'tm3.txt')));
    await win.click('#noteAdd');
    await waitFor(async () => (await tabNames('#noteTabs')).length === 3);
    const newName = (await tabNames('#noteTabs'))[2];
    await win.keyboard.type('abc');
    await tabOf('#noteTabs', 'tm1').locator('.noteName').click();
    await waitFor(async () => (await curTab('#noteTabs')) === 'tm1');
    await win.keyboard.type('Y');
    await menu('#noteTabs', 'tm2', 'others');
    ok('E83 關閉其他碰到兩份沒存的：一次問「有 2 份還沒存」、列出名稱、全部存／全部不存',
      same(await waitFor(askMsg), ['有 2 份還沒存，要存起來嗎？', '全部存', '全部不存']) && (await win.textContent('#noteAskSub')).startsWith(`tm1、${newName}。新記事沒有名字`),
      JSON.stringify([await askMsg(), await win.textContent('#noteAskSub')]));
    await win.click('#noteAskSave');
    ok('E83 全部存：有名字的寫進去關掉、新記事留著（提示還沒取名）',
      await waitFor(async () => same(await tabNames('#noteTabs'), ['tm2', newName])) && readN(path.join(noteDir, 'tm1.txt')) === 'Yt1' && (await toastText()).includes('1 份新記事還沒取名'),
      JSON.stringify(await tabNames('#noteTabs')));
    await menu('#noteTabs', 'tm2', 'all');
    ok('E83 全部關閉碰到新記事：問「「新記事」還沒存」', same(await waitFor(askMsg), [`「${newName}」還沒存，要存起來嗎？`, '存', '不存']), JSON.stringify(await askMsg()));
    await win.click('#noteAskDrop');
    ok('E83 不存：全部關掉、新記事沒建檔', await waitFor(async () => (await tabNames('#noteTabs')).length === 0 && await shown('#noteEmpty')) && !fs.existsSync(path.join(noteDir, newName + '.txt')));
    await win.dblclick('#noteTree .nlRow[data-key="f:tm1"] .nlName');
    await waitFor(async () => (await curTab('#noteTabs')) === 'tm1');
    await menu('#noteTabs', 'tm1', 'close');
    ok('E83 關閉：跟 × 一樣（沒改過直接關）', await waitFor(async () => (await tabNames('#noteTabs')).length === 0) && fs.existsSync(path.join(noteDir, 'tm1.txt')));
    await win.click('#noteAdd');
    await waitFor(async () => (await tabNames('#noteTabs')).length === 1);
    await menu('#noteTabs', (await tabNames('#noteTabs'))[0]);
    ok('E83 還沒存的新記事：沒有在檔案總管中顯示、複製路徑；只有一個時「關閉其他」「關閉右側」點不了',
      same(await menuItems(), ['關閉', '(關閉其他)', '(關閉右側)', '全部關閉']), JSON.stringify(await menuItems()));
    await win.click('#tabMenu button[data-act="close"]');
    await waitFor(async () => (await tabNames('#noteTabs')).length === 0);

    const pA = f => path.join(mdA, ...f.split('/'));
    await win.click('#actMd');
    await waitFor(() => shown('#mdPane'));
    for (const f of ['report.md', '子/README.md']) {
      await win.dblclick(`#mdTree .nlRow[data-key="${pA(f).replace(/\\/g, '\\\\')}"] .nlName`);
      await waitFor(async () => (await curTab('#mdTabs')) === path.basename(f, '.md') && !(await win.$('#mdTabs .noteTab.preview')));
    }
    ok('E83 MD 檢視前提：開著 long、report、README', same(await tabNames('#mdTabs'), ['long', 'report', 'README']), JSON.stringify(await tabNames('#mdTabs')));
    await menu('#mdTabs', 'report');
    ok('E83 MD 檢視頁籤按右鍵：一樣六項、正在看的不換', same(await menuItems(), ['關閉', '關閉其他', '關閉右側', '全部關閉', '在檔案總管中顯示', '複製路徑']) && (await curTab('#mdTabs')) === 'README');
    fs.rmSync(clipFile, { force: true });
    await win.click('#tabMenu button[data-act="copy"]');
    ok('E83 MD 檢視複製路徑：完整路徑', await waitFor(() => fs.existsSync(clipFile) && fs.readFileSync(clipFile, 'utf8') === pA('report.md')));
    await menu('#mdTabs', 'report', 'reveal');
    ok('E83 MD 檢視在檔案總管中顯示：完整路徑（--open-log）', await waitFor(() => lastOpened() === pA('report.md')));
    await menu('#mdTabs', 'report', 'others');
    ok('E83 MD 檢視關閉其他：只留它、換成看它', await waitFor(async () => same(await tabNames('#mdTabs'), ['report']) && (await curTab('#mdTabs')) === 'report' && (await win.innerText('#mdView')).includes('週報')));
    await win.dblclick(`#mdTree .nlRow[data-key="${pA('long.md').replace(/\\/g, '\\\\')}"] .nlName`);
    await waitFor(async () => same(await tabNames('#mdTabs'), ['report', 'long']));
    await menu('#mdTabs', 'report', 'right');
    ok('E83 MD 檢視關閉右側', await waitFor(async () => same(await tabNames('#mdTabs'), ['report']) && (await curTab('#mdTabs')) === 'report'));
    await menu('#mdTabs', 'report', 'all');
    ok('E83 MD 檢視全部關閉：中間寫沒有開著的', await waitFor(async () => (await tabNames('#mdTabs')).length === 0 && (await win.textContent('#mdEmpty')).includes('沒有開著的')));
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E84：MD 檢視清單的右鍵選單（見 開發筆記 D121）——.md：三項、按的那行框起來、選單在按的地方；複製相對路徑（/ 隔開，選單收起來框拿掉）、複製路徑；
    // 資料夾：一樣三項、在檔案總管中顯示；釘住的資料夾：沒有相對路徑、多不釘；Esc（游標回那一行）；空白的地方：只有釘資料夾…（上面不畫線），
    // 點了釘 mdB（--pick-md-dir 剩下的）；不釘。最後回日記
    {
    const shown = sel => win.isVisible(sel);
    const pA = f => path.join(mdA, ...f.split('/'));
    const row = p => `#mdTree .nlRow[data-key="${p.replace(/\\/g, '\\\\')}"]`;
    const items = () => win.$$eval('#mdMenu button', bs => bs.filter(b => b.offsetParent).map(b => b.textContent));
    const clip = () => (fs.existsSync(clipFile) ? fs.readFileSync(clipFile, 'utf8') : null);
    const sels = () => win.$$eval('#mdTree .nlRow.sel', rs => rs.map(r => r.dataset.key));
    const mdKeys = () => win.$$eval('#mdTree .nlRow', rs => rs.map(r => r.dataset.key));
    // E83 留下的舊清單還在 DOM 裡：先做記號，等點了之後重畫的清單（沒有記號）才往下。不等的話「出現 子/README.md」馬上就成立，
    // 重畫（refreshMd）晚幾 ms 才把整個清單換掉，量位置量到被拿掉的舊行（全是 0）——2026-11-03 量到重畫跟量位置同一毫秒、那行 isConnected false
    await win.$$eval('#mdTree .nlRow', rs => rs.forEach(r => { r.dataset.old = '1'; }));
    await win.click('#actMd');
    await waitFor(async () => (await mdKeys()).includes(pA('子/README.md')) && !(await win.$('#mdTree .nlRow[data-old]')));
    const rc = await win.$eval(row(pA('子/README.md')), r => { const b = r.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });   // Playwright 點在正中間
    await win.click(row(pA('子/README.md')), { button: 'right' });
    const mAt = await win.$eval('#mdMenu', m => { const b = m.getBoundingClientRect(); return [b.left, b.top]; }).catch(() => null);
    ok('E84 .md 上按右鍵：三項（在檔案總管中顯示、複製路徑、複製相對路徑）＋刪除（D192）、那行框起來、選單在按的地方',
      await waitFor(() => shown('#mdMenu')) && same(await items(), ['在檔案總管中顯示', '複製路徑', '複製相對路徑', '刪除']) && same(await sels(), [pA('子/README.md')])
      && mAt && Math.abs(mAt[0] - rc[0]) < 2 && Math.abs(mAt[1] - rc[1]) < 2, JSON.stringify({ items: await items(), sels: await sels(), rc, mAt }));
    fs.rmSync(clipFile, { force: true });
    await win.click('#mdMenu button[data-act="rel"]');
    ok('E84 複製相對路徑：從釘住的資料夾算起、/ 隔開；選單收起來、框拿掉', await waitFor(() => clip() === '子/README.md') && !(await shown('#mdMenu')) && (await sels()).length === 0, String(clip()));
    await win.click(row(pA('子/README.md')), { button: 'right' });
    await win.click('#mdMenu button[data-act="copy"]');
    ok('E84 複製路徑：完整路徑', await waitFor(() => clip() === pA('子/README.md')), String(clip()));
    await win.click(row(pA('子')), { button: 'right' });
    ok('E84 資料夾上按右鍵：一樣三項（沒有刪除，D192）',await waitFor(async () => same(await items(), ['在檔案總管中顯示', '複製路徑', '複製相對路徑'])), JSON.stringify(await items()));
    await win.click('#mdMenu button[data-act="reveal"]');
    ok('E84 資料夾的在檔案總管中顯示：資料夾的完整路徑（--open-log）', await waitFor(() => fs.readFileSync(openLog, 'utf8').trim().split('\n').pop() === pA('子')));
    await win.click(row(mdA), { button: 'right' });
    ok('E84 釘住的資料夾上按右鍵：在檔案總管中顯示、複製路徑、不釘這個資料夾（沒有相對路徑）',
      await waitFor(async () => same(await items(), ['在檔案總管中顯示', '複製路徑', '不釘這個資料夾'])), JSON.stringify(await items()));
    await win.keyboard.press('Escape');
    ok('E84 Esc：選單收起來、框拿掉、游標回那一行', await waitFor(async () => !(await shown('#mdMenu'))) && (await sels()).length === 0
      && await win.evaluate(k => document.activeElement.closest('.nlRow')?.dataset.key === k, mdA));
    const h = await win.$eval('#mdTree', e => e.clientHeight);
    await win.click('#mdTree', { button: 'right', position: { x: 10, y: h - 5 } });
    ok('E84 空白的地方：只有釘資料夾…、上面不畫線、沒框任何一行',
      await waitFor(async () => same(await items(), ['釘資料夾…'])) && (await win.$eval('#mdMenu .mmPin', g => getComputedStyle(g).borderTopWidth)) === '0px' && (await sels()).length === 0,
      JSON.stringify(await items()));
    await win.click('#mdMenu button[data-act="pin"]');
    ok('E84 釘資料夾…：跟上面的＋一樣（釘 mdB）', await waitFor(async () => (await mdKeys()).includes(mdB) && (await mdKeys()).includes(path.join(mdB, 'README.md'))));
    await win.click(row(mdB), { button: 'right' });
    await win.click('#mdMenu button[data-act="unpin"]');
    ok('E84 不釘這個資料夾：從清單拿掉、檔案還在', await waitFor(async () => !(await mdKeys()).includes(mdB)) && fs.existsSync(path.join(mdB, 'README.md')));
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E148：文件檢視清單右鍵「刪除」（見 開發筆記 D192）——只有 .md、.html 有（資料夾、釘住的資料夾、空白處沒有：E84 的項目）；先問一次：
    // 游標在「確定刪除」；Esc 不刪（游標回那一行）、點外面不刪；Enter 刪：丟資源回收筒（測試搬進 --trash-dir）、清單上沒了、開著的頁籤拿掉、提示；.html 點「確定刪除」也一樣。
    // 主程序只刪釘住的資料夾裡的 .md、.html 檔：外面的、.txt、叫 .md 的資料夾都不刪。最後回日記
    {
    const shown = sel => win.isVisible(sel);
    const row = p => `#mdTree .nlRow[data-key="${p.replace(/\\/g, '\\\\')}"]`;
    const mdKeys = () => win.$$eval('#mdTree .nlRow', rs => rs.map(r => r.dataset.key));
    const tabs = async () => (await win.$$('#mdTabs .noteTab')).length;
    const toastHas = async s => (await win.isVisible('#toast')) && (await win.textContent('#toast')).includes(s);
    const askDel = async p => { await win.click(row(p), { button: 'right' }); await win.click('#mdMenu button[data-act="del"]'); return waitFor(() => shown('#mdAsk')); };
    const doc = path.join(mdA, 'E148刪我.md'), page = path.join(mdA, 'E148刪我.html');
    fs.writeFileSync(doc, '# E148');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><p>E148</p>');
    await win.click('#actMd');
    await waitFor(async () => (await mdKeys()).includes(doc) && (await mdKeys()).includes(page));
    await win.dblclick(`${row(doc)} .nlName`);
    await waitFor(async () => (await tabs()) === 1 && (await win.innerText('#mdView')).includes('E148'));
    await askDel(doc);
    const msg = await win.textContent('#mdAskMsg'), f1 = await win.evaluate(() => document.activeElement.id);
    ok('E148 .md 右鍵「刪除」：先問「把「E148刪我.md」丟到資源回收筒？」、游標在「確定刪除」', msg === '把「E148刪我.md」丟到資源回收筒？' && f1 === 'mdAskDel', JSON.stringify([msg, f1]));
    await win.keyboard.press('Escape');
    ok('E148 Esc：框收起來、檔案還在、游標回那一行', await waitFor(async () => !(await shown('#mdAsk'))) && fs.existsSync(doc)
      && await win.evaluate(k => document.activeElement.closest('.nlRow')?.dataset.key === k, doc));
    await askDel(doc);
    await win.click('#mdAsk', { position: { x: 10, y: 10 } });
    ok('E148 點外面（灰的那層）：框收起來、檔案還在', await waitFor(async () => !(await shown('#mdAsk'))) && fs.existsSync(doc));
    await askDel(doc);
    await win.keyboard.press('Enter');
    ok('E148 Enter（確定刪除）：丟資源回收筒（--trash-dir）、清單上沒了、開著的頁籤拿掉、提示',
      await waitFor(async () => !fs.existsSync(doc) && fs.existsSync(path.join(noteTrash, 'E148刪我.md')) && !(await mdKeys()).includes(doc) && (await tabs()) === 0
        && await toastHas('已把「E148刪我.md」丟到資源回收筒')),
      JSON.stringify([fs.existsSync(doc), await tabs(), await win.textContent('#toast')]));
    await askDel(page);
    await win.click('#mdAskDel');
    ok('E148 .html 點「確定刪除」：一樣丟資源回收筒、清單上沒了',
      await waitFor(async () => !fs.existsSync(page) && fs.existsSync(path.join(noteTrash, 'E148刪我.html')) && !(await mdKeys()).includes(page)));
    const outside = path.join(tmpRoot, 'E148外面.md'), txt = path.join(mdA, 'E148.txt'), dir = path.join(mdA, 'E148資料夾.md');
    fs.writeFileSync(outside, 'x');
    fs.writeFileSync(txt, 'x');
    fs.mkdirSync(dir);
    const tries = await win.evaluate(ps => Promise.all(ps.map(p => window.daybook.mdTrash(p).then(() => 'ok', () => 'err'))), [outside, txt, dir]);
    ok('E148 主程序只刪釘住的資料夾裡的 .md、.html 檔：外面的、.txt、叫 .md 的資料夾都不刪',
      same(tries, ['err', 'err', 'err']) && fs.existsSync(outside) && fs.existsSync(txt) && fs.existsSync(dir), JSON.stringify(tries));
    for (const p of [outside, txt, dir]) fs.rmSync(p, { recursive: true, force: true });   // 上一條紅了（被搬進 --trash-dir）也不在這裡停下來
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E85：文件檢視看 .html（見 開發筆記 D122）——清單列 .html（名稱帶副檔名）；開了在沙盒的 iframe：自己的樣式、相對路徑的圖照樣出來、<script> 不跑；big5 照 meta 讀；
    // 連結：網址、target=_blank 用瀏覽器開（iframe 不換頁、不開新視窗）、#段落照跳、相對路徑的 .html 和跨資料夾的 .md 開成頁籤、不存在的不理；
    // 外面改了重新載入；捲軸照畫面的、選單開著時點網頁裡收起來（D164）；換成 .md 時 iframe 拿掉；右鍵（頁籤、清單）多「用瀏覽器開」；名稱叫「文件檢視」。最後不釘 mdB、回日記
    {
    const shown = sel => win.isVisible(sel);
    const pB = f => path.join(mdB, ...f.split('/'));
    const row = p => `#mdTree .nlRow[data-key="${p.replace(/\\/g, '\\\\')}"]`;
    const mdKeys = () => win.$$eval('#mdTree .nlRow', rs => rs.map(r => r.dataset.key));
    const curTab = () => win.evaluate(() => document.querySelector('#mdTabs .noteTab.on')?.dataset.key ?? null);
    const tabKeys = () => win.$$eval('#mdTabs .noteTab', ts => ts.map(t => t.dataset.key));
    const frame = () => win.frameLocator('#docFrame');
    const h1 = () => frame().locator('h1').textContent({ timeout: 2000 }).catch(() => '');   // iframe 換頁、還沒載好時不等 30 秒
    const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim().split('\n') : []);
    const items = sel => win.$$eval(`${sel} button`, bs => bs.filter(b => b.offsetParent).map(b => b.textContent));
    // 主程序放進網頁的監聽（D148）好了才點：使用者點的才開，監聽放好之前點的當作沒點過
    const hooked = () => waitFor(() => frame().locator('html').evaluate(() => !!window.__daybookHooks).catch(() => false));   // 看正在看的那份（iframe 可能留著好幾個，D155）
    await win.click('#actMd');
    ok('E85 名稱改叫「文件檢視」：清單標題、頁籤列的按鈕', await waitFor(async () => (await win.textContent('#mdList h2')) === '文件檢視') && (await win.getAttribute('#actMd', 'aria-label')) === '文件檢視');
    await win.click('#mdAddRoot');
    ok('E85 清單列 .html：名稱帶副檔名，跟 .md 排在一起；只有圖的資料夾不列',
      await waitFor(async () => (await mdKeys()).includes(pB('spec.html'))) && same((await win.$$eval(`${row(mdB)} ~ .nlRow .nlName`, ns => ns.map(n => n.textContent))).slice(0, 4), ['big5.html', 'other.html', 'README', 'spec.html'])
      && !(await mdKeys()).includes(pB('img')), JSON.stringify(await mdKeys()));
    await win.dblclick(`${row(pB('spec.html'))} .nlName`);
    await waitFor(async () => (await curTab()) === pB('spec.html'));
    const got = await waitFor(async () => {
      const h1 = frame().locator('h1');
      if (!(await h1.count()) || await shown('#mdView')) return null;   // .md 那塊網頁畫好了才收（D154），h1 先有

      return { h1: await h1.textContent(), color: await h1.evaluate(e => getComputedStyle(e).color), img: await frame().locator('#pic').evaluate(i => i.naturalWidth), ran: await frame().locator('#ran').count(),
        src: await win.getAttribute('#docFrame', 'src'), sandbox: await win.getAttribute('#docFrame', 'sandbox'), md: await shown('#mdView') };
    }, 6000);
    ok('E85 開 .html：在沙盒的 iframe（docview 網址），自己的樣式、相對路徑的圖出來，<script> 會跑（D148，原本不跑）；.md 那塊藏起來',
      !!got && got.h1 === '規格標題' && got.color === 'rgb(255, 0, 0)' && got.img === 8 && got.ran === 1 && got.src.startsWith('docview://local/')
      && got.sandbox === 'allow-popups allow-scripts allow-same-origin' && !got.md, JSON.stringify(got));
    await hooked();
    const n0 = opened().length, pages0 = win.context().pages().length, src0 = await win.getAttribute('#docFrame', 'src');
    await frame().locator('a', { hasText: '外面' }).click();
    ok('E85 點網址：用瀏覽器開（--open-log），iframe 不換頁', await waitFor(() => opened().length === n0 + 1 && opened().pop() === 'https://example.com/h')
      && await sleep(300).then(async () => (await h1()) === '規格標題'));
    await frame().locator('a', { hasText: '新視窗' }).click();
    ok('E85 target=_blank 的網址：一樣用瀏覽器開、不開新視窗', await waitFor(() => opened().pop() === 'https://example.com/blank') && await sleep(300).then(() => win.context().pages().length === pages0));
    await frame().locator('a', { hasText: '跳到第二段' }).click();
    ok('E85 #段落：iframe 裡照跳（捲下去），沒開別的', await waitFor(() => frame().locator('h2').evaluate(e => e.ownerDocument.defaultView.scrollY > 500)) && opened().length === n0 + 2
      && (await win.getAttribute('#docFrame', 'src')) === src0);
    await frame().locator('a', { hasText: '壞的' }).click();
    ok('E85 連到不存在的 .html：不理（還在這份）', await sleep(400).then(async () => (await curTab()) === pB('spec.html') && (await h1()) === '規格標題'));
    await frame().locator('a', { hasText: '其他頁' }).click();
    ok('E85 相對路徑的 .html：開成頁籤（留著）', await waitFor(async () => (await curTab()) === pB('other.html') && (await h1()) === '其他頁'));
    await win.click(`#mdTabs .noteTab[data-key="${pB('spec.html').replace(/\\/g, '\\\\')}"] .noteName`);
    await waitFor(async () => (await h1()) === '規格標題');
    await hooked();
    await frame().locator('a', { hasText: '跨資料夾' }).click();
    ok('E85 連到別個釘住資料夾的 .md：開成頁籤，iframe 藏起來（留著，D155）、.md 那塊出來',
      await waitFor(async () => (await curTab()) === path.join(mdA, 'report.md') && await shown('#mdView') && (await win.$$('#docFrame')).length === 0
        && (await win.$$('.docFrame.on')).length === 0 && (await win.innerText('#mdView')).includes('週報')),
      JSON.stringify({ cur: await curTab(), tabs: await tabKeys(), frame: (await win.$$('#docFrame')).length, opened: opened().slice(-2) }));
    await win.dblclick(`${row(pB('big5.html'))} .nlName`);
    ok('E85 big5 的 .html：照 meta 的編碼讀', await waitFor(async () => (await frame().locator('#t').textContent().catch(() => '')) === '中文'));
    await win.click(`#mdTabs .noteTab[data-key="${pB('spec.html').replace(/\\/g, '\\\\')}"] .noteName`);
    await waitFor(async () => (await h1()) === '規格標題');
    const src1 = await win.getAttribute('#docFrame', 'src');
    fs.writeFileSync(pB('spec.html'), fs.readFileSync(pB('spec.html'), 'utf8').replace('規格標題', '改過的標題'));
    ok('E85 外面改了：重新載入（網址換了）', await waitFor(async () => (await h1()) === '改過的標題') && (await win.getAttribute('#docFrame', 'src')) !== src1);
    // 捲軸照畫面的（D164）：10px（跟 .md 那塊一樣）；滑鼠沒移進過看不到，移進網頁才出現（照 E56 截捲軸那一直條比）。
    // 「移走就不見」測不到：Playwright 送的滑鼠（CDP）直接送給點到的那個 iframe，不經過 Chromium 送「離開」給 iframe 的那段，iframe 的 :hover 一直留著
    await hooked();
    const sbw = await frame().locator('html').evaluate(h => innerWidth - h.clientWidth);
    const sbClip = await win.$eval('#docFrame', f => { const r = f.getBoundingClientRect(); return { x: r.right - 10, y: r.top, width: 10, height: r.height }; });
    const strip = () => win.screenshot({ clip: sbClip });
    await win.hover('#mdList h2');
    const sbOut = await strip();   // 重新載入過，網頁還沒收過滑鼠
    await frame().locator('h1').hover();
    const sbIn = await strip();
    ok('E85 .html 的捲軸照畫面的：10px；滑鼠沒移進過看不到，移進網頁才出現', sbw === 10 && !sbIn.equals(sbOut), JSON.stringify({ sbw, 移進出現: !sbIn.equals(sbOut) }));
    // 選單開著時點網頁裡：收起來（D164）——畫面收不到 iframe 裡的點擊，網頁裡的監聽通知畫面
    const menuOff = async (open, sel) => {
      await open();
      if (!(await waitFor(() => shown(sel)))) return 'not shown';
      await frame().locator('body').click({ position: { x: 300, y: 300 } });   // 網頁中間空白的地方（選單蓋不到）
      return waitFor(async () => !(await shown(sel)));
    };
    const offs = [
      await menuOff(() => win.click(`#mdTabs .noteTab[data-key="${pB('spec.html').replace(/\\/g, '\\\\')}"]`, { button: 'right' }), '#tabMenu'),
      await menuOff(() => win.click(row(pB('other.html')), { button: 'right' }), '#mdMenu'),
      await menuOff(() => win.click('#actSettings'), '#settingsMenu'),
    ];
    ok('E85 選單開著時點網頁裡：收起來（頁籤、清單的右鍵選單，齒輪「設定」）', offs.every(v => v === true), JSON.stringify(offs));
    // E139：.html 的頁籤按右鍵、Esc 收起來：游標回網頁（正在看的 iframe），不是藏起來的 .md 那塊（見 開發筆記 D120〈後續〉）
    await win.click('#mdList h2');   // 先讓游標離開網頁
    await win.click(`#mdTabs .noteTab[data-key="${pB('spec.html').replace(/\\/g, '\\\\')}"]`, { button: 'right' });
    await waitFor(() => shown('#tabMenu'));
    await win.keyboard.press('Escape');
    ok('E139 .html 的頁籤右鍵選單按 Esc：選單收起來、游標回網頁', await waitFor(async () => !(await shown('#tabMenu'))
      && (await win.evaluate(() => document.activeElement?.id)) === 'docFrame'), await win.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
    await win.click(`#mdTabs .noteTab[data-key="${pB('spec.html').replace(/\\/g, '\\\\')}"]`, { button: 'right' });
    ok('E85 .html 的頁籤右鍵：多「用瀏覽器開」', await waitFor(async () => same(await items('#tabMenu'), ['關閉', '關閉其他', '關閉右側', '全部關閉', '用瀏覽器開', '在檔案總管中顯示', '複製路徑'])), JSON.stringify(await items('#tabMenu')));
    await win.click('#tabMenu button[data-act="browser"]');
    ok('E85 用瀏覽器開：那個檔（--open-log 寫路徑）', await waitFor(() => opened().pop() === pB('spec.html')));
    await win.click(row(pB('other.html')), { button: 'right' });
    ok('E85 清單上 .html 右鍵：多「用瀏覽器開」（刪除是 D192）', await waitFor(async () => same(await items('#mdMenu'), ['用瀏覽器開', '在檔案總管中顯示', '複製路徑', '複製相對路徑', '刪除'])), JSON.stringify(await items('#mdMenu')));
    await win.click('#mdMenu button[data-act="browser"]');
    ok('E85 清單上用瀏覽器開', await waitFor(() => opened().pop() === pB('other.html')));
    await win.click(row(mdB), { button: 'right' });
    await win.click('#mdMenu button[data-act="unpin"]');
    ok('E85 不釘 mdB：它的頁籤都關掉、iframe（留著的也是）都拿掉', await waitFor(async () => (await tabKeys()).every(k => !k.startsWith(mdB + '\\')) && (await win.$$('#mdWrap iframe')).length === 0));
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E120：從 .md 換到 .html 不先白一下（見 開發筆記 D154）——新建的 iframe 墊在底下，網頁載好、畫好（網頁裡的監聽送 painted）才把原本的 .md 收掉；
    // 等的時候換回 .md 不會被收掉；等的時候切到日記本，回來已經換上。慢的那份（程式卡 0.8 秒）最後刪掉、回日記
    {
    const shown = sel => win.isVisible(sel);
    const tabSel = p => `#mdTabs .noteTab[data-key="${p.replace(/\\/g, '\\\\')}"] .noteName`;
    const slow = path.join(mdA, 'slow.html'), late = path.join(mdA, 'late.html'), report = path.join(mdA, 'report.md');
    const st120 = () => win.evaluate(() => { const f = document.getElementById('docFrame'), v = document.getElementById('mdView');
      return { frame: f ? (f.classList.contains('wait') ? 'wait' : 'on') : null, md: !v.hidden, mdText: v.textContent.includes('週報') }; });
    const h1 = () => win.frameLocator('#docFrame').locator('h1').textContent({ timeout: 2000 }).catch(() => '');
    fs.writeFileSync(slow, '<!doctype html><meta charset="utf-8"><body style="background:#22aa66"><h1>慢的</h1><script>const t = Date.now(); while (Date.now() - t < 800);</script></body>');
    await win.click('#actMd');
    await waitFor(() => win.$(`#mdTree .nlRow[data-key="${slow.replace(/\\/g, '\\\\')}"]`));
    await win.click(tabSel(report));
    await waitFor(async () => (await st120()).mdText);
    // 量 iframe 的 load 到換上隔多久：painted 是載完畫完一格就送，保險是 load 後 0.5 秒
    await win.evaluate(() => {
      window.__e120 = {};
      new MutationObserver(() => {
        const f = document.getElementById('docFrame');
        if (f && !f.__e120) { f.__e120 = 1; f.addEventListener('load', () => { window.__e120.load = performance.now(); }); }
        if (f && window.__e120.load && !f.classList.contains('wait') && !window.__e120.show) window.__e120.show = performance.now();
      }).observe(document.getElementById('mdWrap'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    });
    await win.dblclick(`#mdTree .nlRow[data-key="${slow.replace(/\\/g, '\\\\')}"] .nlName`);
    const during = await waitFor(async () => { const s = await st120(); return s.frame === 'wait' ? s : null; });
    ok('E120 .md 換到 .html：網頁載好之前，原本的 .md 留著（iframe 墊在底下）', !!during && during.md && during.mdText, JSON.stringify(during || await st120()));
    const after = await waitFor(async () => { const s = await st120(); return s.frame === 'on' && (await h1()) === '慢的' ? s : null; }, 6000);
    const gap = await win.evaluate(() => window.__e120.show - window.__e120.load);
    ok('E120 網頁畫好了才換上：.md 收起來、清掉；換上的時間跟著網頁送的 painted（離 load 不到 300ms，保險是 500ms）',
      !!after && !after.md && !after.mdText && gap >= 0 && gap < 300, JSON.stringify([after || await st120(), gap]));
    // iframe 一直墊在 z-index -1：換上之後點得到（中間那點是 iframe），找字的框照樣蓋在它上面
    const hitMid = await win.evaluate(() => { const r = document.getElementById('mdWrap').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id; });
    await win.evaluate(() => document.activeElement?.blur());
    await win.keyboard.press('Control+F');
    await waitFor(() => shown('#mdFind'));
    const hitFind = await win.evaluate(() => { const r = document.getElementById('mdFindQ').getBoundingClientRect(); return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#mdFind'); });
    await win.click('#mdFindClose');
    ok('E120 換上之後：中間點得到網頁（iframe 在最上面那層看得到的），找字的框蓋在網頁上面', hitMid === 'docFrame' && hitFind, JSON.stringify([hitMid, hitFind]));
    await win.click(tabSel(report));
    await waitFor(async () => (await st120()).mdText);
    await win.click(tabSel(slow));
    await waitFor(async () => (await st120()).frame === 'wait');
    await win.click(tabSel(report));
    ok('E120 等的時候換回 .md：.md 照常出來，那份載好了也不會把它收掉', await sleep(1500).then(async () => same(await st120(), { frame: null, md: true, mdText: true })), JSON.stringify(await st120()));
    // 載完了、還沒畫好（網頁載完之後卡 1 秒）時換回 .md：保險的計時（load 後 0.5 秒）已經在跑，到了也不能把 .md 收掉
    fs.writeFileSync(late, '<!doctype html><meta charset="utf-8"><h1>晚畫</h1><script>addEventListener("load", () => setTimeout(() => { const t = Date.now(); while (Date.now() - t < 1000); }));</script>');
    await waitFor(() => win.$(`#mdTree .nlRow[data-key="${late.replace(/\\/g, '\\\\')}"]`));
    await win.evaluate(() => { window.__e120 = {}; });
    await win.dblclick(`#mdTree .nlRow[data-key="${late.replace(/\\/g, '\\\\')}"] .nlName`);
    const loaded = await waitFor(() => win.evaluate(() => !!window.__e120.load && !!document.getElementById('docFrame')?.classList.contains('wait')));
    await win.click(tabSel(report));
    ok('E120 載完、還沒畫好時換回 .md：保險的計時到了也不會把 .md 收掉', loaded && await sleep(1500).then(async () => same(await st120(), { frame: null, md: true, mdText: true })),
      JSON.stringify([loaded, await st120()]));
    await win.click(tabSel(slow));
    await waitFor(async () => (await st120()).frame === 'wait');
    await win.click('#actJournal');
    await sleep(1500);
    await win.click('#actMd');
    ok('E120 等的時候切到日記本：回來時已經換上（不會被原本的 .md 蓋著）', await waitFor(async () => { const s = await st120(); return s.frame === 'on' && !s.md && (await h1()) === '慢的'; }),
      JSON.stringify(await st120()));
    fs.unlinkSync(slow);
    fs.unlinkSync(late);
    await waitFor(async () => !(await win.$(`#mdTree .nlRow[data-key="${slow.replace(/\\/g, '\\\\')}"]`)) && !(await win.$(`#mdTree .nlRow[data-key="${late.replace(/\\/g, '\\\\')}"]`))
      && (await st120()).frame === null);
    await win.click(tabSel(report));
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E121：開過的 .html 每份留一個 iframe（見 開發筆記 D155）——換走藏起來（visibility:hidden），換回來不重新載入、捲到哪照舊；
    // 點得到的、找字、連結都是正在看的那份；藏著的外面改了切回來才載入；頁籤關掉拿掉；最多留 8 份，超過拿掉最久沒看的。最後刪掉、回日記
    {
    const esc = p => p.replace(/\\/g, '\\\\');
    const tabSel = p => `#mdTabs .noteTab[data-key="${esc(p)}"]`;
    const rowSel = p => `#mdTree .nlRow[data-key="${esc(p)}"] .nlName`;
    const k1 = path.join(mdA, 'k1.html'), k2 = path.join(mdA, 'k2.html'), k3 = path.join(mdA, 'k3.html'), report = path.join(mdA, 'report.md');
    const ns = Array.from({ length: 9 }, (_, i) => path.join(mdA, `n${i + 1}.html`));
    const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim().split('\n') : []);
    const page121 = (title, apples, link) => `<!doctype html><meta charset="utf-8"><h1>${title}</h1><p id="rnd"></p><p><a id="out" href="${link}">外面</a></p>`
      + Array.from({ length: apples }, () => '<p>蘋果</p>').join('') + Array.from({ length: 120 }, (_, i) => `<p>墊高 ${i + 1}</p>`).join('')
      + '<script>document.getElementById("rnd").textContent = String(Math.random());</script>';
    fs.writeFileSync(k1, page121('第一份', 3, 'https://example.com/k1'));
    fs.writeFileSync(k2, page121('第二份', 5, 'https://example.com/k2'));
    ns.forEach((f, i) => fs.writeFileSync(f, page121(`n${i + 1}`, 1, 'https://example.com/n')));
    const fr = async () => (await win.$('#docFrame'))?.contentFrame() ?? null;
    const cur121 = async () => { const f = await fr(); return f ? await f.evaluate(() => ({ h1: document.querySelector('h1')?.textContent, rnd: document.getElementById('rnd')?.textContent, y: scrollY })).catch(() => null) : null; };
    const frames121 = () => win.$$eval('#mdWrap iframe', fs => fs.map(f => ({ key: f.dataset.key, cur: f.id === 'docFrame', wait: f.classList.contains('wait'), vis: getComputedStyle(f).visibility })));
    const hooked = () => waitFor(async () => { const f = await fr(); return !!f && await f.evaluate(() => !!window.__daybookHooks).catch(() => false); });
    const showDoc = async (p, how, title) => {   // 點兩下清單／點頁籤，等那份換上來
      await (how === 'row' ? win.dblclick(rowSel(p)) : win.click(`${tabSel(p)} .noteName`));
      return waitFor(async () => { const c = await cur121(); const f = (await frames121()).find(x => x.cur); return !!c && c.h1 === title && !!f && f.key === p && !f.wait; }, 6000);
    };
    await win.click('#actMd');
    await waitFor(() => win.$(rowSel(ns[8])));
    await win.click(`${tabSel(report)} .noteName`);
    await showDoc(k1, 'row', '第一份');
    await (await fr()).evaluate(() => scrollTo(0, 800));
    const a = await cur121();
    await win.click(`${tabSel(report)} .noteName`);
    await waitFor(async () => (await win.innerText('#mdView').catch(() => '')).includes('週報'));
    const away = await frames121();
    ok('E121 換到 .md：那份 .html 的 iframe 留著、藏起來（visibility:hidden），沒有正在看的 iframe',
      same(away, [{ key: k1, cur: false, wait: false, vis: 'hidden' }]), JSON.stringify(away));
    await win.click(`${tabSel(k1)} .noteName`);
    const back = await waitFor(async () => { const f = (await frames121()).find(x => x.cur); return f && f.key === k1 ? f : null; });
    const b = await cur121();
    ok('E121 換回來：馬上換上（不用等畫好）、不重新載入（網頁裡的亂數一樣）、捲到哪照舊',
      !!back && !back.wait && back.vis === 'visible' && !!b && b.rnd === a.rnd && b.y === 800 && a.y === 800 && !(await win.isVisible('#mdView')), JSON.stringify([back, a, b]));
    await showDoc(k2, 'row', '第二份');
    const hitKey = () => win.evaluate(() => { const r = document.getElementById('mdWrap').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.dataset.key; });
    const both = await frames121();
    ok('E121 再開一份：兩份都留著，第一份藏起來；點中間點到的是正在看的那份（藏著的在上面一層也點不到）',
      same(both.map(x => [x.key, x.cur, x.vis]).sort(), [[k1, false, 'hidden'], [k2, true, 'visible']].sort()) && (await hitKey()) === k2, JSON.stringify([both, await hitKey()]));
    // 找字找正在看的那份：第二份 5 個蘋果、第一份 3 個
    await win.evaluate(() => document.activeElement?.blur());
    await win.keyboard.press('Control+F');
    await win.fill('#mdFindQ', '蘋果');
    const n2 = await waitFor(async () => { const t = await win.textContent('#mdFindN'); return /\/ \d/.test(t) ? t : null; });
    await win.click(`${tabSel(k1)} .noteName`);
    const n1 = await waitFor(async () => { const t = await win.textContent('#mdFindN'); return t.endsWith('/ 3') ? t : null; });
    ok('E121 找字找正在看的那份：第二份 x / 5，換回第一份重找 x / 3', !!n2 && n2.endsWith('/ 5') && !!n1, JSON.stringify([n2, n1 || await win.textContent('#mdFindN')]));
    await win.click('#mdFindClose');
    // 兩份裡的連結：使用者點的都開（監聽放進每一個 iframe；問的是換頁的那個 frame）
    const o0 = opened().length;
    await hooked();
    await (await fr()).click('#out');
    await waitFor(() => opened().length === o0 + 1);
    await showDoc(k2, 'tab', '第二份');
    await hooked();
    await (await fr()).click('#out');
    ok('E121 兩份裡的連結（第一份換回來的、第二份新開的）：點了都用瀏覽器開', await waitFor(() => opened().length === o0 + 2)
      && same(opened().slice(o0), ['https://example.com/k1', 'https://example.com/k2']), JSON.stringify(opened().slice(o0)));
    // 藏著的第一份外面改了：藏著時不重新載入，切回來才載入新的
    const src1 = await win.getAttribute(`#mdWrap iframe[data-key="${esc(k1)}"]`, 'src');
    fs.writeFileSync(k1, page121('第一份改過', 3, 'https://example.com/k1'));
    await sleep(1200);
    const srcHidden = await win.getAttribute(`#mdWrap iframe[data-key="${esc(k1)}"]`, 'src');
    const changed = await showDoc(k1, 'tab', '第一份改過');
    ok('E121 藏著的那份外面改了：藏著時不重新載入（網址沒換），切回來才載入新的', srcHidden === src1 && changed
      && (await win.getAttribute(`#mdWrap iframe[data-key="${esc(k1)}"]`, 'src')) !== src1, JSON.stringify([src1 === srcHidden, await cur121()]));
    // 關掉第二份的頁籤：它的 iframe 拿掉
    await win.hover(tabSel(k2));
    await win.click(`${tabSel(k2)} .noteDel`);
    ok('E121 關掉頁籤：它的 iframe 拿掉，別份的留著', await waitFor(async () => same((await frames121()).map(x => x.key), [k1])), JSON.stringify(await frames121()));
    // .html 換到新開的（點兩下，會畫兩次）：新的還沒畫好時，原本那份一直蓋著（看得到、點得到），畫好了才換
    fs.writeFileSync(k3, '<!doctype html><meta charset="utf-8"><h1>慢的第三份</h1><script>const t = Date.now(); while (Date.now() - t < 800);</script>');
    await waitFor(() => win.$(rowSel(k3)));
    await win.dblclick(rowSel(k3));
    await sleep(300);
    const mid = await frames121(), midHit = await hitKey();
    const done3 = await waitFor(async () => { const f = (await frames121()).find(x => x.cur); return !!f && f.key === k3 && !f.wait && (await cur121())?.h1 === '慢的第三份'; }, 6000);
    ok('E121 .html 換到新開的：還沒畫好時原本那份照樣看得到、點得到（.md 那塊不出來），畫好了才換、原本那份藏起來',
      same(mid.map(x => [x.key, x.cur, x.wait, x.vis]).sort(), [[k1, false, false, 'visible'], [k3, true, true, 'visible']].sort()) && midHit === k1 && done3
      && same((await frames121()).map(x => [x.key, x.vis]).sort(), [[k1, 'hidden'], [k3, 'visible']].sort()) && !(await win.isVisible('#mdView')), JSON.stringify([mid, midHit, await frames121()]));
    // 最多留 8 份：再開 n1～n9，第一份、n1 最久沒看，拿掉（頁籤還在）；切回 n1 重新載入，換 n2 被拿掉
    for (let i = 0; i < 9; i++) await showDoc(ns[i], 'row', `n${i + 1}`);
    const keys9 = (await frames121()).map(x => x.key).sort();
    const tabs9 = await win.$$eval('#mdTabs .noteTab', ts => ts.map(t => t.dataset.key));
    await showDoc(ns[0], 'tab', 'n1');
    const keys10 = (await frames121()).map(x => x.key).sort();
    ok('E121 最多留 8 份：超過拿掉最久沒看的（頁籤還在）；切回被拿掉的重新開一個，下一個最久沒看的拿掉',
      same(keys9, ns.slice(1).sort()) && tabs9.includes(k1) && tabs9.includes(ns[0]) && same(keys10, [ns[0], ...ns.slice(2)].sort()), JSON.stringify([keys9, keys10]));
    for (const f of [k1, k2, k3, ...ns]) fs.unlinkSync(f);
    ok('E121 檔案刪掉：頁籤關掉、iframe 全部拿掉', await waitFor(async () => (await win.$$('#mdWrap iframe')).length === 0 && !(await win.$(rowSel(k1)))), JSON.stringify(await frames121()));
    await win.click(`${tabSel(report)} .noteName`);
    await win.click('#actJournal');
    await waitFor(() => win.isVisible('#q'));
    }

    // E101：清單排序（見 開發筆記 D132）——記事清單、文件檢視清單上面的排序鈕：名稱／修改時間／建立日期，時間的可以換新的在上面、舊的在上面；
    // 資料夾一律照名稱在前面；照名稱時新舊淡色點不了；Esc、再點鈕收起來；存記事建立時間留著（存了照建立日期排不跳）；重新載入照記的；
    // 兩個清單各記各的；文件檢視外面改了照新的修改時間排。最後兩個都換回名稱、回日記
    {
    const shown = sel => win.isVisible(sel);
    const sDir = path.join(data, '記事本', '排序'), mS = path.join(mdA, '排序');
    // 建的順序 b → c → a（建立日期新的在上面：a c b），修改時間 c 最新、a、b 最舊（新的在上面：c a b），名稱 a b c：五種排法都不一樣。
    // 資料夾 y 比 z 早建（照時間排的話 z 會跑前面）
    fs.mkdirSync(path.join(sDir, 'y'), { recursive: true });
    await sleep(50);
    fs.mkdirSync(path.join(sDir, 'z'));
    fs.mkdirSync(mS);
    for (const n of ['b', 'c', 'a']) {
      fs.writeFileSync(path.join(sDir, n + '.txt'), n);
      fs.writeFileSync(path.join(mS, n + '.md'), '# ' + n);
      await sleep(50);
    }
    for (const [n, d] of [['a', '2026-02-01'], ['b', '2026-01-01'], ['c', '2026-03-01']]) {
      fs.utimesSync(path.join(sDir, n + '.txt'), new Date(d), new Date(d));
      fs.utimesSync(path.join(mS, n + '.md'), new Date(d), new Date(d));
    }
    const nKeys = async () => (await win.$$eval('#noteTree .nlRow', rs => rs.map(r => r.dataset.key))).filter(k => /^[fd]:排序\//.test(k)).map(k => k.replace(/^[fd]:排序\//, ''));
    const mKeys = async () => (await win.$$eval('#mdTree .nlRow', rs => rs.map(r => r.dataset.key))).filter(k => k.startsWith(mS + '\\')).map(k => path.basename(k, '.md'));
    const items = () => win.$$eval('#sortMenu button', bs => bs.map(b => (b.disabled ? '(' : '') + (b.getAttribute('aria-checked') === 'true' ? '✓' : '') + b.textContent + (b.disabled ? ')' : '')));
    const focused = () => win.evaluate(() => document.activeElement.id);
    const pick = async (btn, what) => { await win.click(btn); await waitFor(() => shown('#sortMenu')); await win.click(`#sortMenu button[${what}]`); };
    const store = () => win.evaluate(() => [localStorage.getItem('daybook.noteSort'), localStorage.getItem('daybook.mdSort')]);

    await win.click('#actNote');
    await waitFor(() => win.$('#noteTree .nlRow[data-key="d:排序"]'));
    await win.click('#noteTree .nlRow[data-key="d:排序"] .nlName');
    ok('E101 前提：記事清單照名稱、資料夾在前面', await waitFor(async () => same(await nKeys(), ['y', 'z', 'a', 'b', 'c'])), JSON.stringify(await nKeys()));
    await win.click('#nlSort');
    const bAt = await win.$eval('#nlSort', b => { const r = b.getBoundingClientRect(); return [r.left, r.bottom]; });
    const mAt = await win.$eval('#sortMenu', m => { const r = m.getBoundingClientRect(); return [r.left, r.top]; }).catch(() => null);
    ok('E101 排序鈕：選單在鈕底下；照名稱打勾，新的在上面／舊的在上面淡色點不了',
      await waitFor(() => shown('#sortMenu')) && same(await items(), ['✓名稱', '修改時間', '建立日期', '(✓新的在上面)', '(舊的在上面)'])
      && !!mAt && Math.abs(mAt[0] - bAt[0]) < 2 && mAt[1] >= bAt[1] && mAt[1] - bAt[1] < 6, JSON.stringify({ items: await items(), bAt, mAt }));
    await win.click('#sortMenu button[data-by="mtime"]');
    ok('E101 修改時間：記事新的在上面（c a b）、資料夾照名稱在前面；選單收起來、游標回排序鈕、記在這台電腦',
      await waitFor(async () => same(await nKeys(), ['y', 'z', 'c', 'a', 'b'])) && !(await shown('#sortMenu')) && (await focused()) === 'nlSort'
      && (await store())[0] === '{"by":"mtime","desc":true}', JSON.stringify({ keys: await nKeys(), store: await store() }));
    await pick('#nlSort', 'data-desc=""');
    ok('E101 舊的在上面（b a c）', await waitFor(async () => same(await nKeys(), ['y', 'z', 'b', 'a', 'c'])), JSON.stringify(await nKeys()));
    await pick('#nlSort', 'data-by="birth"');
    ok('E101 建立日期：照上次選的舊的在上面（b c a）', await waitFor(async () => same(await nKeys(), ['y', 'z', 'b', 'c', 'a'])), JSON.stringify(await nKeys()));
    await win.click('#nlSort');
    ok('E101 打勾跟著換：建立日期、舊的在上面，新舊點得了', await waitFor(async () => same(await items(), ['名稱', '修改時間', '✓建立日期', '新的在上面', '✓舊的在上面'])), JSON.stringify(await items()));
    await win.keyboard.press('Escape');
    ok('E101 Esc：選單收起來、游標回排序鈕', await waitFor(async () => !(await shown('#sortMenu'))) && (await focused()) === 'nlSort');
    await win.click('#nlSort');
    await waitFor(() => shown('#sortMenu'));
    await win.click('#nlSort');
    ok('E101 開著再點排序鈕：收起來', await waitFor(async () => !(await shown('#sortMenu'))));
    // E142（排序）：點外面收起來、排序鈕的 aria-expanded 換回 false（見 開發筆記 D182）
    await win.click('#nlSort');
    await waitFor(() => shown('#sortMenu'));
    await outsideDown(win);
    ok('E142 排序選單：點外面收起來、排序鈕的 aria-expanded 換回 false', await waitFor(async () => !(await shown('#sortMenu')))
      && (await win.getAttribute('#nlSort', 'aria-expanded')) === 'false');
    await pick('#nlSort', 'data-desc="1"');
    ok('E101 建立日期新的在上面（a c b）', await waitFor(async () => same(await nKeys(), ['y', 'z', 'a', 'c', 'b'])), JSON.stringify(await nKeys()));
    // 存記事：建立時間要留著（原本寫 .tmp 再改名蓋過去，建立時間會變成存檔那一刻，b 會跳到最上面）
    const bFile = path.join(sDir, 'b.txt'), b0 = fs.statSync(bFile);
    await win.dblclick('#noteTree .nlRow[data-key="f:排序/b"] .nlName');
    await waitFor(async () => (await win.inputValue('#noteText')) === 'b' && (await focused()) === 'noteText');
    await win.keyboard.press('Control+End');
    await win.keyboard.type('X');
    await win.keyboard.press('Control+s');
    const b1 = await waitFor(() => readN(bFile) === 'bX' && fs.statSync(bFile));
    ok('E101 存記事：建立時間留著、修改時間換新的、沒留下 .tmp', !!b1 && b1.birthtimeMs === b0.birthtimeMs && b1.mtimeMs > b0.mtimeMs && !fs.existsSync(bFile + '.tmp'),
      JSON.stringify({ b0: [b0.birthtimeMs, b0.mtimeMs], b1: b1 && [b1.birthtimeMs, b1.mtimeMs] }));
    ok('E101 存了之後清單重讀時間（修改時間是新的），照建立日期排順序不變（a c b）',
      await waitFor(() => win.evaluate(m => notePad.times['排序/b']?.[0] > m, b0.mtimeMs)) && same(await nKeys(), ['y', 'z', 'a', 'c', 'b']), JSON.stringify(await nKeys()));
    await pick('#nlSort', 'data-by="mtime"');
    ok('E101 換修改時間：剛存的 b 在最上面（b c a）', await waitFor(async () => same(await nKeys(), ['y', 'z', 'b', 'c', 'a'])), JSON.stringify(await nKeys()));
    await win.reload();
    ok('E101 重新載入：照記的排（修改時間新的在上面）', await waitFor(async () => same(await nKeys(), ['y', 'z', 'b', 'c', 'a'])), JSON.stringify(await nKeys()));

    await win.click('#actMd');
    const rowOf = p => `#mdTree .nlRow[data-key="${p.replace(/\\/g, '\\\\')}"] .nlName`;
    await win.waitForSelector(rowOf(mdA));
    if ((await win.getAttribute(rowOf(mdA), 'aria-expanded')) !== 'true') await win.click(rowOf(mdA));
    await win.waitForSelector(rowOf(mS));
    await win.click(rowOf(mS));
    ok('E101 文件檢視各記各的：還是照名稱（a b c）', await waitFor(async () => same(await mKeys(), ['a', 'b', 'c'])), JSON.stringify(await mKeys()));
    await pick('#mdSort', 'data-by="mtime"');
    ok('E101 文件檢視照修改時間（c a b）；記事本記的不變', await waitFor(async () => same(await mKeys(), ['c', 'a', 'b']))
      && same(await store(), ['{"by":"mtime","desc":true}', '{"by":"mtime","desc":true}']), JSON.stringify({ keys: await mKeys(), store: await store() }));
    fs.writeFileSync(path.join(mS, 'b.md'), '# b2');
    ok('E101 外面改了：照新的修改時間排（b c a）', await waitFor(async () => same(await mKeys(), ['b', 'c', 'a'])), JSON.stringify(await mKeys()));
    await pick('#mdSort', 'data-by="birth"');
    ok('E101 文件檢視照建立日期（a c b）', await waitFor(async () => same(await mKeys(), ['a', 'c', 'b'])), JSON.stringify(await mKeys()));
    await pick('#mdSort', 'data-by="name"');
    ok('E101 文件檢視換回名稱（a b c）', await waitFor(async () => same(await mKeys(), ['a', 'b', 'c'])), JSON.stringify(await mKeys()));
    await win.click('#actNote');
    await waitFor(() => shown('#notePane'));
    await pick('#nlSort', 'data-by="name"');
    ok('E101 記事清單換回名稱（a b c）', await waitFor(async () => same(await nKeys(), ['y', 'z', 'a', 'b', 'c'])), JSON.stringify(await nKeys()));
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E115：文件檢視找字（見 開發筆記 D147）——選著一段字按 Ctrl+F：拿來找、從它開始；不分大小寫、跨粗體也找得到、<br> 兩邊不算連在一起；
    // 全部標顏色（CSS Custom Highlight）、目前那個另外標；Enter 下一個（在畫面外捲到看得到，寬的程式碼左右也捲）、到底繞回、Shift+Enter 上一個；
    // 外面改了重找、順序不變；找不到寫沒有結果、顏色拿掉；段落中間換行的空白找得到（D149）；Esc 關掉：顏色拿掉、選著目前那個；找的字留著；
    // 換成 .html 框留著、在網頁裡重找（D149；網頁裡的找字細的在 E116）
    {
    const shown = sel => win.isVisible(sel);
    const fMd = path.join(mdA, '找字.md'), fHtml = path.join(mdA, '頁.html');
    const rowOf = p => `#mdTree .nlRow[data-key="${p.replace(/\\/g, '\\\\')}"] .nlName`;
    // apple 照順序：Apple、apple、**APP**le（跨粗體）、程式碼最右邊（要左右捲）、最後一段，共 5 個；「a<br>b」那格不能找到 ab；中間墊 60 段，要上下捲。
    // foo bar（D149）：段落中間換行的找得到（1 個），隔著段落的（end foo／bar start）不算
    const src = ['# 找字', '第一段有 Apple 和 apple，還有 **APP**le 跨粗體。', '| 欄 | 說明 |\n|---|---|\n| a<br>b | 換行的格 |', 'soft foo\nbar here', 'end foo', 'bar start',
      ...Array.from({ length: 60 }, (_, i) => `墊高 ${i + 1}`), '```\n' + 'x'.repeat(400) + ' apple\n```', '最後一個 apple'].join('\n\n');
    fs.writeFileSync(fMd, src);
    fs.writeFileSync(fHtml, '<!doctype html><meta charset="utf-8"><h1>頁</h1><p>apple</p>');
    const st115 = () => win.evaluate(() => {
      const v = document.getElementById('mdView'), vb = v.getBoundingClientRect();
      const on = [...(CSS.highlights.get('md-find-on') || [])][0];
      const b = on && on.getBoundingClientRect(), pre = v.querySelector('pre'), pb = pre && pre.getBoundingClientRect();   // 換成 .html 時內容是空的
      return { box: !document.getElementById('mdFind').hidden, q: document.getElementById('mdFindQ').value, n: document.getElementById('mdFindN').textContent,
        all: CSS.highlights.get('md-find')?.size ?? 0, on: on ? on.toString() : null, inView: !!b && b.top >= vb.top && b.bottom <= vb.bottom,
        inPre: !!b && !!pb && b.left >= pb.left && b.right <= pb.right, preX: pre ? pre.scrollLeft : null, focus: document.activeElement.id, sel: getSelection().toString() };
    });
    await win.click('#actMd');
    await win.waitForSelector(rowOf(fMd));
    await win.dblclick(rowOf(fMd));
    await waitFor(async () => (await win.innerText('#mdView').catch(() => '')).includes('第一段有'));
    await win.evaluate(() => {   // 選第一段裡小寫的 apple（第 2 個）
      const t = document.querySelector('#mdView p').firstChild, i = t.data.indexOf('apple'), r = new Range();
      r.setStart(t, i); r.setEnd(t, i + 5);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await win.keyboard.press('Control+f');
    let s = await waitFor(async () => { const x = await st115(); return x.box && x.n ? x : null; });
    ok('E115 選著 apple 按 Ctrl+F：框打開、游標在框裡、拿選的字來找；不分大小寫共 5 個全標上；從選的那個開始（2 / 5）',
      !!s && s.focus === 'mdFindQ' && s.q === 'apple' && s.n === '2 / 5' && s.all === 5 && s.on === 'apple', JSON.stringify(s));
    await win.keyboard.press('Enter');
    s = await st115();
    ok('E115 Enter：下一個是跨粗體的 APPle（3 / 5）', s.n === '3 / 5' && s.on === 'APPle', JSON.stringify(s));
    await win.keyboard.press('Enter');
    s = await st115();
    ok('E115 Enter：程式碼最右邊那個（4 / 5）——上下捲到看得到、程式碼也左右捲到看得到', s.n === '4 / 5' && s.inView && s.inPre && s.preX > 0, JSON.stringify(s));
    await win.keyboard.press('Enter');
    await win.keyboard.press('Enter');
    s = await st115();
    ok('E115 到底再 Enter：繞回第一個（1 / 5，Apple），捲回看得到', s.n === '1 / 5' && s.on === 'Apple' && s.inView, JSON.stringify(s));
    await win.keyboard.press('Shift+Enter');
    s = await st115();
    ok('E115 Shift+Enter：上一個（繞到 5 / 5）', s.n === '5 / 5' && s.on === 'apple' && s.inView, JSON.stringify(s));
    fs.writeFileSync(fMd, src + '\n\n外面加的 apple');
    s = await waitFor(async () => { const x = await st115(); return x.all === 6 ? x : null; });
    ok('E115 框開著時外面改了：重找（6 個），目前那個的順序不變（5 / 6）', !!s && s.n === '5 / 6', JSON.stringify(s || await st115()));
    await win.fill('#mdFindQ', 'ab');
    s = await st115();
    ok('E115 找「ab」：「a<br>b」那格不算（沒有結果）、顏色拿掉', s.n === '沒有結果' && s.all === 0 && s.on === null, JSON.stringify(s));
    await win.fill('#mdFindQ', 'foo bar');
    s = await st115();
    ok('E115 找「foo bar」：段落中間換行的找得到（D149），隔著段落的不算（1 / 1）', s.n === '1 / 1' && s.all === 1 && s.on === 'foo\nbar', JSON.stringify(s));
    await win.fill('#mdFindQ', 'apple');
    await win.keyboard.press('Escape');
    s = await st115();
    ok('E115 Esc：框收起來、顏色拿掉、游標回內容、選著目前那個', !s.box && s.all === 0 && s.focus === 'mdView' && s.sel.toLowerCase() === 'apple', JSON.stringify(s));
    await win.keyboard.press('F3');
    s = await waitFor(async () => { const x = await st115(); return x.box ? x : null; });
    ok('E115 框關著按 F3（D150）：叫出框、游標還在內容、用上次的字，從選著的那個後面（程式碼那個 → 5 / 6）',
      !!s && s.focus === 'mdView' && s.q === 'apple' && s.n === '5 / 6' && s.on === 'apple', JSON.stringify(s));
    await win.keyboard.press('Shift+F3');
    s = await st115();
    ok('E115 框開著按 Shift+F3：上一個（4 / 6），游標還在內容', s.n === '4 / 6' && s.focus === 'mdView', JSON.stringify(s));
    await win.keyboard.press('Escape');
    await waitFor(async () => !(await st115()).box);
    await win.evaluate(() => getSelection().removeAllRanges());
    await win.keyboard.press('Control+f');
    s = await waitFor(async () => { const x = await st115(); return x.box ? x : null; });
    ok('E115 沒選字再按 Ctrl+F：上次找的字留著', !!s && s.q === 'apple' && s.all === 6, JSON.stringify(s));
    await win.waitForSelector(rowOf(fHtml));
    await win.dblclick(rowOf(fHtml));
    ok('E115 框開著時換成 .html：框留著、.md 的顏色拿掉，iframe 載好了在網頁裡重找（D149，頁.html 有 1 個）',
      await waitFor(async () => { const x = await st115(); return (await win.$$('#docFrame')).length === 1 && x.box && x.all === 0 && x.n === '1 / 1'; }), JSON.stringify(await st115()));
    await win.click('#mdFindClose');
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E116：.html 的程式會跑（見 開發筆記 D148）——localStorage 用得了、碰不到 daybook 的畫面、連不了網；網頁自己要開網址（一載入就開、過一下自己換頁）不開，
    // 使用者點的才開。.html 找字（D149）：焦點在網頁裡選著字按 Ctrl+F（網頁裡的監聽通知畫面）、跨粗體、收起來的 <details> 找到就打開、藏起來的不找、
    // 寬的程式碼左右捲、句子中間換行的空白、隔著區塊不算；Esc 收起來選著目前那個；外面改了（重新載入）重找；網頁裡按 Esc 也收起來
    {
    const shown = sel => win.isVisible(sel);
    const fJs = path.join(mdA, '程式.html'), fFind = path.join(mdA, '找字.html');
    const rowOf = p => `#mdTree .nlRow[data-key="${p.replace(/\\/g, '\\\\')}"] .nlName`;
    const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim().split('\n') : []);
    const fr = async () => (await win.$('#docFrame'))?.contentFrame() ?? null;   // 正在看的那份（開過的 iframe 會留著好幾個，D155）
    const hooked = () => waitFor(async () => { const f = await fr(); return !!f && await f.evaluate(() => !!window.__daybookHooks).catch(() => false); });
    fs.writeFileSync(fJs, '<!doctype html><meta charset="utf-8"><p id="out">沒跑</p><p><a id="go" href="https://example.com/clicked">點了才開</a></p><script>'
      + 'const out = ["跑了"];'
      + 'try { localStorage.setItem("daybook-e2e", "1"); out.push("localStorage " + localStorage.getItem("daybook-e2e")); } catch (e) { out.push("localStorage " + e.name); }'
      + 'try { parent.document.title; out.push("碰得到畫面"); } catch (e) { out.push("碰畫面 " + e.name); }'
      + 'fetch("https://example.com/").then(() => out.push("連網可以"), e => out.push("連網 " + e.name)).then(() => { document.getElementById("out").textContent = out.join("|"); });'
      + 'window.open("https://example.com/自己開"); setTimeout(() => { location.href = "https://example.com/自己換頁"; }, 1500);</script>');
    // apple 看得到的照順序：標題 Apple、第一段 apple、<b>APP</b>le、收起來的 <details> 裡、程式碼最右邊、最後一段，共 6 個；display:none 的不算。
    // 「foo bar」在原始碼裡隔著換行和縮排（Word 轉的那樣）；<div>ab</div><div>cd</div> 不能找到 bc
    fs.writeFileSync(fFind, '<!doctype html><meta charset="utf-8"><style>pre { width: 300px; overflow-x: auto; } .no { display: none; }</style>'
      + '<h1>找字 Apple</h1><p id="first">第一段 apple 和 <b>APP</b>le</p><p>句子中間\n    換行的 foo\n    bar 一段</p><div>ab</div><div>cd</div>'
      + '<p class="no">藏起來的 apple</p><details><summary>更多</summary><p>收起來的 apple</p></details>'
      + Array.from({ length: 60 }, (_, i) => `<p>墊高 ${i + 1}</p>`).join('') + '<pre>' + 'x'.repeat(400) + ' apple</pre><p>最後 apple</p>');
    const st116 = async () => {
      const f = await fr();
      const inner = f ? await f.evaluate(() => {
        const on = [...(CSS.highlights.get('daybook-find-on') || [])][0], b = on && on.getBoundingClientRect(), pre = document.querySelector('pre');
        const pb = pre && pre.getBoundingClientRect();
        return { all: CSS.highlights.get('daybook-find')?.size ?? 0, on: on ? on.toString() : null, inView: !!b && b.top >= 0 && b.bottom <= innerHeight,
          inPre: !!b && !!pb && b.left >= pb.left && b.right <= pb.right, preX: pre ? pre.scrollLeft : null, details: document.querySelector('details')?.open ?? null, sel: getSelection().toString() };
      }).catch(() => null) : null;
      return { box: await shown('#mdFind'), q: await win.inputValue('#mdFindQ'), n: await win.textContent('#mdFindN'), focus: await win.evaluate(() => document.activeElement.id), ...inner };
    };
    await win.click('#actMd');
    await win.waitForSelector(rowOf(fJs));
    const n0 = opened().length;
    await win.dblclick(rowOf(fJs));
    const out = await waitFor(async () => { const t = await win.frameLocator('#docFrame').locator('#out').textContent({ timeout: 1000 }).catch(() => ''); return t.includes('連網') ? t : null; }, 6000);
    ok('E116 .html 的程式會跑：localStorage 用得了、碰不到 daybook 的畫面、連不了網', out === '跑了|localStorage 1|碰畫面 SecurityError|連網 TypeError', out);
    await sleep(2000);
    ok('E116 網頁自己要開網址（一載入就 window.open、1.5 秒後自己換頁）：都不開', opened().length === n0, JSON.stringify(opened().slice(n0)));
    await hooked();
    await win.frameLocator('#docFrame').locator('#go').click();
    ok('E116 使用者點的連結：用瀏覽器開', await waitFor(() => opened().length === n0 + 1 && opened().pop() === 'https://example.com/clicked'), JSON.stringify(opened().slice(n0)));

    await win.dblclick(rowOf(fFind));
    await waitFor(async () => (await win.frameLocator('#docFrame').locator('h1').textContent({ timeout: 1000 }).catch(() => '')) === '找字 Apple');
    await hooked();
    await win.frameLocator('#docFrame').locator('h1').click();   // 焦點進網頁
    await (await fr()).evaluate(() => {   // 選第一段的 apple（第 2 個）
      const t = document.getElementById('first').firstChild, i = t.data.indexOf('apple'), r = new Range();
      r.setStart(t, i); r.setEnd(t, i + 5);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await win.keyboard.press('Control+f');
    let s = await waitFor(async () => { const x = await st116(); return x.box && x.n ? x : null; });
    ok('E116 焦點在網頁裡、選著 apple 按 Ctrl+F：框打開、游標在框裡、拿選的字來找；看得到的 6 個全標上（藏起來的不算）、從選的那個開始（2 / 6）',
      !!s && s.focus === 'mdFindQ' && s.q === 'apple' && s.n === '2 / 6' && s.all === 6 && s.on === 'apple', JSON.stringify(s));
    await win.keyboard.press('Enter');
    s = await waitFor(async () => { const x = await st116(); return x.n === '3 / 6' ? x : null; });
    ok('E116 Enter：跨粗體的 APPle（3 / 6）', !!s && s.on === 'APPle', JSON.stringify(s || await st116()));
    ok('E116 前提：<details> 一開始收著', s && s.details === false);
    await win.keyboard.press('Enter');
    s = await waitFor(async () => { const x = await st116(); return x.n === '4 / 6' ? x : null; });
    ok('E116 Enter：收起來的 <details> 裡那個（4 / 6）——打開、捲到看得到', !!s && s.details === true && s.on === 'apple' && s.inView, JSON.stringify(s || await st116()));
    await win.keyboard.press('Enter');
    s = await waitFor(async () => { const x = await st116(); return x.n === '5 / 6' ? x : null; });
    ok('E116 Enter：程式碼最右邊那個（5 / 6）——上下、左右都捲到看得到', !!s && s.inView && s.inPre && s.preX > 0, JSON.stringify(s || await st116()));
    await win.fill('#mdFindQ', 'foo bar');
    s = await waitFor(async () => { const x = await st116(); return x.n === '1 / 1' ? x : null; });
    ok('E116 找「foo bar」：原始碼裡隔著換行和縮排的也找得到（1 / 1）', !!s && s.all === 1 && /^foo\s+bar$/.test(s.on), JSON.stringify(s || await st116()));
    await win.fill('#mdFindQ', 'bc');
    s = await waitFor(async () => { const x = await st116(); return x.n === '沒有結果' ? x : null; });
    ok('E116 找「bc」：兩個 <div> 之間不算（沒有結果）、顏色拿掉', !!s && s.all === 0, JSON.stringify(s || await st116()));
    await win.fill('#mdFindQ', 'apple');
    await waitFor(async () => (await st116()).all === 6);
    await win.keyboard.press('Escape');
    s = await waitFor(async () => { const x = await st116(); return !x.box && x.all === 0 ? x : null; });
    ok('E116 Esc：框收起來、網頁裡的顏色拿掉、選著目前那個、游標回網頁', !!s && s.sel.toLowerCase() === 'apple' && s.focus === 'docFrame', JSON.stringify(s || await st116()));
    await win.keyboard.press('Control+f');
    s = await waitFor(async () => { const x = await st116(); return x.box && x.all === 6 ? x : null; });
    ok('E116 Esc 之後再按 Ctrl+F：框打開、拿選著的（目前那個）來找', !!s && s.q === s.sel && s.q.toLowerCase() === 'apple', JSON.stringify(s || await st116()));
    fs.writeFileSync(fFind, fs.readFileSync(fFind, 'utf8') + '<p>外面加的 apple</p>');
    s = await waitFor(async () => { const x = await st116(); return x.all === 7 ? x : null; }, 6000);
    ok('E116 框開著時外面改了（重新載入）：在新的網頁裡重找（7 個）', !!s && s.box && / \/ 7$/.test(s.n), JSON.stringify(s || await st116()));
    await hooked();
    await win.frameLocator('#docFrame').locator('h1').click();
    await win.keyboard.press('Escape');
    ok('E116 游標在網頁裡按 Esc：框收起來', await waitFor(async () => !(await shown('#mdFind'))));
    // F3（D150）：焦點在網頁裡、框關著——網頁裡的監聽通知畫面；從選著的那個後面找，游標留在網頁裡
    await (await fr()).evaluate(() => {   // 選第一段的 apple（第 2 個）
      const t = document.getElementById('first').firstChild, i = t.data.indexOf('apple'), r = new Range();
      r.setStart(t, i); r.setEnd(t, i + 5);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await win.keyboard.press('F3');
    s = await waitFor(async () => { const x = await st116(); return x.box && x.n ? x : null; });
    ok('E116 游標在網頁裡、框關著按 F3（D150）：叫出框、游標還在網頁、用上次的字，從選著的後面（APPle，3 / 7）',
      !!s && s.focus === 'docFrame' && s.q.toLowerCase() === 'apple' && s.n === '3 / 7' && s.on === 'APPle', JSON.stringify(s || await st116()));
    await win.keyboard.press('F3');
    s = await waitFor(async () => { const x = await st116(); return x.n === '4 / 7' ? x : null; });
    ok('E116 網頁裡再按 F3：下一個（4 / 7），游標還在網頁', !!s && s.focus === 'docFrame', JSON.stringify(s || await st116()));
    await win.keyboard.press('Shift+F3');
    ok('E116 網頁裡按 Shift+F3：上一個（3 / 7）', await waitFor(async () => (await st116()).n === '3 / 7'), JSON.stringify(await st116()));
    // 焦點在 iframe 上、按鍵卻送到畫面（剛點進網頁、網頁還沒拿到焦點的那一下；D150 實測連做 80 次碰到 3 次）：Esc 照樣收起框。
    // 自動測試碰不太到那一下，直接把 Esc 送到畫面
    await win.evaluate(() => { document.getElementById('docFrame').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    ok('E116 焦點在 iframe 上、Esc 卻送到畫面：框照樣收起來（D150）', await waitFor(async () => !(await shown('#mdFind'))));
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E124：找文件（見 開發筆記 D158）——文件檢視清單上面那格，比「釘住的資料夾的名稱/相對路徑」（名稱和所在的資料夾），不分大小寫、每個詞都要有；
    // 收著的資料夾打開、清掉後照原本收著；沒有符合的寫一行；Esc 先清字再回內容；Ctrl+P（清單收起來時先打開）、Enter 開第一份（留著、游標進內容）；
    // 游標在 .html 裡按 Ctrl+P 也跳進來。最後刪掉建的、回日記
    {
    const shown = sel => win.isVisible(sel);
    const fd = path.join(mdA, '找檔');
    for (const [f, text] of [['daybook/README.md', '# daybook 的說明'], ['other/README.md', '# other 的說明'], ['daybook/notes.html', '<!doctype html><meta charset="utf-8"><h1>筆記頁</h1>']]) {
      fs.mkdirSync(path.dirname(path.join(fd, f)), { recursive: true });
      fs.writeFileSync(path.join(fd, f), text);
    }
    const esc = p => p.replace(/\\/g, '\\\\');
    const rowSel = p => `#mdTree .nlRow[data-key="${esc(p)}"] .nlName`;
    const keys124 = () => win.$$eval('#mdTree .nlRow', rs => rs.map(r => r.dataset.key));
    const files124 = () => win.$$eval('#mdTree .nlRow[data-kind="file"]', rs => rs.map(r => r.dataset.key));
    const focused = () => win.evaluate(() => document.activeElement.id);
    // 期望值從硬碟上算：mdA 底下（node_modules、.git 不算）的 .md、.html，「mdA/相對路徑」含每個詞的
    const walk124 = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory()
      ? (['node_modules', '.git'].includes(e.name) ? [] : walk124(path.join(dir, e.name), rel + e.name + '/')) : /\.(md|html?)$/i.test(e.name) ? [rel + e.name] : []));
    const want124 = q => walk124(mdA).filter(f => q.toLowerCase().split(' ').every(w => (path.basename(mdA) + '/' + f).toLowerCase().includes(w))).map(f => path.join(mdA, ...f.split('/'))).sort();
    const report = path.join(mdA, 'report.md'), readme = path.join(fd, 'daybook', 'README.md'), page = path.join(fd, 'daybook', 'notes.html');
    await win.click('#actMd');
    await waitFor(() => win.$(rowSel(mdA)));
    if (!(await win.$(rowSel(report)))) await win.click(rowSel(mdA));
    await win.dblclick(rowSel(report));
    await waitFor(async () => (await win.innerText('#mdView').catch(() => '')).includes('週報'));
    await win.click('#mdCollapse');
    await waitFor(async () => same(await keys124(), [mdA]));
    await win.fill('#mdQ', 'README');
    const wantReadme = want124('readme');
    ok('E124 打 README：只留路徑符合的（不分大小寫）、收著的資料夾打開，不符合的不列',
      await waitFor(async () => same((await files124()).sort(), wantReadme)) && wantReadme.includes(readme) && wantReadme.includes(path.join(fd, 'other', 'README.md'))
      && (await keys124()).includes(path.join(fd, 'daybook')) && !(await keys124()).includes(report), JSON.stringify(await files124()));
    await win.fill('#mdQ', 'daybook readme');
    ok('E124 打「daybook readme」：所在資料夾也算（只比名稱的話一份都沒有），每個詞都要有（other 的 README 不算）',
      await waitFor(async () => same(await files124(), [readme])), JSON.stringify(await files124()));
    await win.fill('#mdQ', 'MDA 找檔 notes');
    ok('E124 釘住的資料夾的名稱也算：「MDA 找檔 notes」找到那份 .html', await waitFor(async () => same(await files124(), [page])), JSON.stringify(await files124()));
    await win.fill('#mdQ', 'zzz 沒有');
    ok('E124 一份都沒有：寫「沒有符合的文件」，釘住的資料夾也不列', await waitFor(async () => (await keys124()).length === 0 && (await win.textContent('#mdTree')).includes('沒有符合的文件')));
    await win.fill('#mdQ', 'daybook readme');
    await waitFor(async () => (await files124()).length === 1);
    ok('E124 游標在找文件那格：狀態列寫 Enter 開第一份、Esc 清掉', (await win.textContent('#statusKeys')).includes('開第一份'), await win.textContent('#statusKeys'));
    await win.press('#mdQ', 'Escape');
    ok('E124 Esc：清掉字，清單回到原本收著的（篩的時候打開的不記）、游標還在那格',
      await waitFor(async () => (await win.inputValue('#mdQ')) === '' && same(await keys124(), [mdA])) && (await focused()) === 'mdQ', JSON.stringify(await keys124()));
    await win.press('#mdQ', 'Escape');
    ok('E124 沒字再按 Esc：游標回內容', await waitFor(async () => (await focused()) === 'mdView'));
    await win.click('#actMd');
    await waitFor(async () => !(await shown('#mdList')));
    await win.keyboard.press('Control+p');
    ok('E124 清單收著按 Ctrl+P：打開清單、游標進找文件那格', await waitFor(async () => await shown('#mdList') && (await focused()) === 'mdQ'));
    await win.keyboard.type('daybook readme');
    await waitFor(async () => same(await files124(), [readme]));
    await win.keyboard.press('Enter');
    ok('E124 Enter：開第一份（留著，不是預覽）、游標進內容',
      await waitFor(async () => (await win.evaluate(() => document.querySelector('#mdTabs .noteTab.on')?.dataset.key)) === readme && (await win.innerText('#mdView')).includes('daybook 的說明')
        && (await focused()) === 'mdView') && !(await win.$('#mdTabs .noteTab.on.preview')));
    await win.fill('#mdQ', 'notes.html');
    await win.dblclick(rowSel(page));
    const fr = async () => (await win.$('#docFrame'))?.contentFrame() ?? null;
    await waitFor(async () => { const f = await fr(); return !!f && !(await win.$eval('#docFrame', x => x.classList.contains('wait')))
      && await f.evaluate(() => !!window.__daybookHooks && document.querySelector('h1')?.textContent === '筆記頁').catch(() => false); }, 6000);
    await win.fill('#mdQ', '');
    await win.frameLocator('#docFrame').locator('h1').click();
    await win.keyboard.press('Control+p');
    ok('E124 游標在 .html 裡按 Ctrl+P：網頁裡的監聽通知畫面，游標跳進找文件那格', await waitFor(async () => (await focused()) === 'mdQ'));
    fs.rmSync(fd, { recursive: true });
    await waitFor(async () => !(await keys124()).some(k => k.startsWith(fd)));
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E125：.md 的大綱、標題連結（見 開發筆記 D159）——左欄清單底下的大綱列正在看的 .md 的標題（照層級縮排），點一下捲到內容最上面；
    // 捲的時候標出現在那段（最上面是第一個、捲到底是最後一個）；#段落照 GitHub 的錨點跳（重複的 -1、大小寫不同也找得到）、沒有的提示；
    // 別份.md#段落開好了捲過去（.html 裡點的也是）；標題不放 id（畫面的 #help 不會被搶走）；.html、沒有標題、沒開著的寫一行；
    // 標題列收起來、重新載入照舊。最後刪掉建的、回日記
    {
    const shown = sel => win.isVisible(sel);
    const esc = p => p.replace(/\\/g, '\\\\');
    const rowSel = p => `#mdTree .nlRow[data-key="${esc(p)}"] .nlName`;
    const dir = path.join(mdA, '大綱');
    const pad = n => Array.from({ length: n }, (_, i) => `墊高 ${i + 1}。`).join('\n\n');
    const f1 = path.join(dir, '大綱.md'), f2 = path.join(dir, '第二份.md'), f3 = path.join(dir, '連結.html'), f4 = path.join(dir, '沒標題.md');
    fs.mkdirSync(dir);
    fs.writeFileSync(f1, '# 總覽\n\n[跳到細項](#細項-a) [第二個第一節](#第一節-1) [大寫的](#HELP) [沒有的](#沒有這段) [別份的段](第二份.md#第二份-b段)\n\n'
      + `## 第一節\n\n${pad(40)}\n\n### 細項 A\n\n${pad(40)}\n\n## 第一節\n\n${pad(40)}\n\n## Hello, World! 2.0\n\n${pad(40)}\n\n## Help\n\n短的最後一段`);
    fs.writeFileSync(f2, `# 第二份\n\n${pad(60)}\n\n## 第二份 B段\n\n${pad(60)}`);
    fs.writeFileSync(f3, '<!doctype html><meta charset="utf-8"><h1>連結頁</h1><p><a id="go" href="第二份.md#第二份-b段">到第二份的 B 段</a></p>');
    fs.writeFileSync(f4, '沒有標題的一份');
    const outline = () => win.$$eval('#mdOutlineList .nlRow', rs => rs.map(r => [r.textContent, parseInt(r.style.paddingLeft, 10), r.classList.contains('on')]));
    const onAt = async () => (await outline()).findIndex(r => r[2]);
    const olText = () => win.textContent('#mdOutlineList');
    // 標題離內容最上面多遠（同名的好幾個都列）
    const headTop = t => win.evaluate(t => { const v = document.getElementById('mdView'), y = v.getBoundingClientRect().top;
      return [...v.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(h => h.textContent === t).map(h => Math.round(h.getBoundingClientRect().top - y)); }, t);
    const atTop = async (t, i = 0) => Math.abs((await headTop(t))[i]) <= 1;
    const toTop = async () => { await win.$eval('#mdView', v => { v.scrollTop = 0; }); await waitFor(async () => (await onAt()) === 0); };
    const link = text => win.locator('#mdView a', { hasText: text });
    const curKey = () => win.evaluate(() => document.querySelector('#mdTabs .noteTab.on')?.dataset.key ?? null);
    await win.click('#actMd');
    await win.fill('#mdQ', 'mda 大綱');
    await waitFor(() => win.$(rowSel(f1)));
    await win.dblclick(rowSel(f1));
    await waitFor(async () => (await outline()).length === 6);
    ok('E125 大綱：正在看的 .md 的標題照順序、照層級縮排（h1 12px、h2 24px、h3 36px）；還沒捲時標第一個',
      same(await outline(), [['總覽', 12, true], ['第一節', 24, false], ['細項 A', 36, false], ['第一節', 24, false], ['Hello, World! 2.0', 24, false], ['Help', 24, false]]), JSON.stringify(await outline()));
    const anchors = await win.$$eval('#mdView [data-anchor]', hs => hs.map(h => h.dataset.anchor));
    ok('E125 標題的錨點照 GitHub 算（重複的 -1）、不放 id：畫面的 #help 還是 F1 那張',
      same(anchors, ['總覽', '第一節', '細項-a', '第一節-1', 'hello-world-20', 'help']) && (await win.$$('#mdView [id]')).length === 0
      && (await win.evaluate(() => !document.getElementById('help').closest('#mdView'))), JSON.stringify(anchors));
    await win.click('#mdOutlineList .nlRow:nth-child(3) .nlName');
    ok('E125 點大綱的「細項 A」：捲到內容最上面、大綱標它', await waitFor(async () => await atTop('細項 A') && (await onAt()) === 2), JSON.stringify([await headTop('細項 A'), await onAt()]));
    await win.click('#mdOutlineList .nlRow:nth-child(4) .nlName');
    ok('E125 點第二個「第一節」：捲到第二個（不是第一個）、大綱標第四行', await waitFor(async () => await atTop('第一節', 1) && (await onAt()) === 3), JSON.stringify([await headTop('第一節'), await onAt()]));
    await win.$eval('#mdView', v => { v.scrollTop = v.scrollHeight; });
    ok('E125 捲到底：標最後一個（太短捲不到最上面）', await waitFor(async () => (await onAt()) === 5), String(await onAt()));
    await win.$eval('#mdView', v => { v.scrollTop = 0; });
    ok('E125 捲回最上面：標第一個', await waitFor(async () => (await onAt()) === 0), String(await onAt()));
    await link('跳到細項').click();
    ok('E125 #細項-a 的連結：捲到那段', await waitFor(() => atTop('細項 A')), JSON.stringify(await headTop('細項 A')));
    await toTop();
    await link('第二個第一節').click();
    ok('E125 #第一節-1：重複的標題跳到第二個', await waitFor(() => atTop('第一節', 1)), JSON.stringify(await headTop('第一節')));
    await toTop();
    await link('大寫的').click();
    ok('E125 #HELP（大小寫跟錨點不一樣）：照樣找得到，捲到底、標 Help', await waitFor(async () => (await onAt()) === 5)
      && (await win.$eval('#mdView', v => v.scrollTop + v.clientHeight >= v.scrollHeight - 2)), String(await onAt()));
    await toTop();
    await link('沒有的').click();
    ok('E125 這份沒有的段落：提示、不捲', await waitFor(async () => ((await win.textContent('#toast')) || '').includes('這份裡沒有「#沒有這段」這一段'))
      && (await win.$eval('#mdView', v => v.scrollTop)) === 0, await win.textContent('#toast'));
    await link('別份的段').click();
    ok('E125 別份.md#段落：開那份、捲到那段；大綱換成那份的、標那段',
      await waitFor(async () => (await curKey()) === f2 && await atTop('第二份 B段') && same((await outline()).map(r => [r[0], r[2]]), [['第二份', false], ['第二份 B段', true]])),
      JSON.stringify([await curKey(), await headTop('第二份 B段'), await outline()]));
    await win.$eval('#mdView', v => { v.scrollTop = 0; });   // 記成捲在最上面：等一下從 .html 點過來，要靠 #段落才捲得到 B 段
    await waitFor(async () => (await onAt()) === 0);
    await win.dblclick(rowSel(f3));
    const fr = async () => (await win.$('#docFrame'))?.contentFrame() ?? null;
    await waitFor(async () => { const f = await fr(); return !!f && !(await win.$eval('#docFrame', x => x.classList.contains('wait')))
      && await f.evaluate(() => !!window.__daybookHooks && !!document.getElementById('go')).catch(() => false); }, 6000);
    ok('E125 .html：大綱寫「.html 沒有大綱」', (await olText()) === '.html 沒有大綱', await olText());
    await (await fr()).click('#go');
    ok('E125 .html 裡點 別份.md#段落：開那份、捲到那段（主程序把 # 後面的一起送過來）', await waitFor(async () => (await curKey()) === f2 && await atTop('第二份 B段')),
      JSON.stringify([await curKey(), await headTop('第二份 B段')]));
    await win.dblclick(rowSel(f4));
    ok('E125 沒有標題的 .md：寫「這份沒有標題」', await waitFor(async () => (await olText()) === '這份沒有標題'), await olText());
    await win.locator('#mdTabs .noteTab .noteName').first().click({ button: 'right' });
    await win.click('#tabMenu [data-act="all"]');
    ok('E125 沒開著的：寫「沒有開著的文件」', await waitFor(async () => (await olText()) === '沒有開著的文件'), await olText());
    await win.click('#mdOutlineHead');
    ok('E125 點「大綱」：收起來只剩標題列、記在這台電腦', await waitFor(async () => !(await shown('#mdOutlineList')) && await shown('#mdOutlineHead'))
      && (await win.getAttribute('#mdOutlineHead', 'aria-expanded')) === 'false' && (await win.evaluate(() => localStorage.getItem('daybook.mdOutline'))) === 'off');
    await win.reload();
    await win.waitForSelector('#mdOutlineHead');
    ok('E125 重新載入：照樣收著', await waitFor(async () => await shown('#mdOutlineHead') && !(await shown('#mdOutlineList'))));
    await win.click('#mdOutlineHead');
    ok('E125 再點：打開', await waitFor(() => shown('#mdOutlineList')) && (await win.evaluate(() => localStorage.getItem('daybook.mdOutline'))) === '');
    await win.fill('#mdQ', '');
    fs.rmSync(dir, { recursive: true });
    await waitFor(async () => !(await win.$(rowSel(f1))));
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E126：頁籤的按鍵、拖拉（見 開發筆記 D160）——記事本：Ctrl+PageDown／PageUp 照頁籤順序（到頭繞回來）；Ctrl+Tab 照最近看過的（按住 Ctrl 跳出清單、
    // 一按選到第二個、Tab／Shift+Tab 選、放開換、Esc 不換，Ctrl+Shift+Tab 一按選到最後一個）；Ctrl+W 關掉正在看的（改過沒存的先問，問的時候再按不做事）；
    // Ctrl+Shift+T 重開、放回原本的位置；中鍵關；拖頁籤調順序（記在這台電腦、重新載入照舊）。
    // 文件檢視：同一套，游標在 .html 裡按的由網頁裡的監聽轉過來。最後刪掉建的、回日記。
    // CDP 送的 Ctrl+W 不會觸發 Electron 預設選單的「關閉視窗」（2026-11-04 量的），「daybook 沒關」這點在這裡驗不到
    {
    const shown = sel => win.isVisible(sel);
    const noteDir = path.join(data, '記事本');
    const names = box => win.$$eval(`${box} .noteTab .noteName`, els => els.map(e => e.firstChild?.textContent ?? ''));
    const cur = box => win.$eval(`${box} .noteTab.on .noteName`, e => e.firstChild?.textContent ?? '').catch(() => null);
    const tabSel = (box, key) => `${box} .noteTab[data-key="${key.replace(/\\/g, '\\\\')}"]`;
    const focused = () => win.evaluate(() => document.activeElement.id);
    const sw = () => win.evaluate(() => { const m = document.getElementById('tabSwitch');
      return m.hidden ? null : { items: [...m.children].map(c => c.firstChild.textContent), on: [...m.children].findIndex(c => c.classList.contains('on')), focus: document.activeElement === m,
        hints: [...m.children].map(c => c.querySelector('.noteDirHint')?.textContent ?? '') }; });   // hints：E143
    const ctrlTab = async (...keys) => { await win.keyboard.down('Control'); for (const k of keys) await win.keyboard.press(k); };   // 按住 Ctrl 按幾下，還沒放開
    const P = ['分頁1', '分頁2', '分頁3', '分頁4'], body = n => n + ' 的內容';
    await win.click('#actNote');
    await waitFor(() => shown('#notePane'));
    if ((await names('#noteTabs')).length) {
      await win.locator('#noteTabs .noteTab .noteName').first().click({ button: 'right' });
      await win.click('#tabMenu button[data-act="all"]');
      if (await waitFor(() => shown('#noteAsk'), 1000)) await win.click('#noteAskDrop');
    }
    await waitFor(async () => (await names('#noteTabs')).length === 0);
    for (const n of P) fs.writeFileSync(path.join(noteDir, n + '.txt'), body(n));
    await waitFor(() => win.$(`#noteTree .nlRow[data-key="f:${P[3]}"]`));
    for (const n of P) {
      await win.dblclick(`#noteTree .nlRow[data-key="f:${n}"] .nlName`);
      await waitFor(async () => (await cur('#noteTabs')) === n && !(await win.$('#noteTabs .noteTab.preview')));
    }
    await win.focus('#noteText');
    await win.keyboard.press('Control+PageDown');
    ok('E126 Ctrl+PageDown 在最右邊：繞回最左邊（分頁1）、游標在文字框',
      await waitFor(async () => (await cur('#noteTabs')) === P[0] && (await win.inputValue('#noteText')) === body(P[0])) && (await focused()) === 'noteText');
    await win.keyboard.press('Control+PageUp');
    ok('E126 Ctrl+PageUp 在最左邊：繞回最右邊（分頁4）', await waitFor(async () => (await cur('#noteTabs')) === P[3]));
    await win.click(`${tabSel('#noteTabs', 'f:' + P[1])} .noteName`);
    await waitFor(async () => (await cur('#noteTabs')) === P[1]);
    // 最近看過的：分頁2、4、1、3（分頁3 只在一開始點兩下時看過）
    await ctrlTab('Tab');
    const s1 = await sw();
    ok('E126 Ctrl+Tab：跳出清單，照最近看過的（分頁2、4、1、3）、選到第二個、焦點在清單上', !!s1 && same(s1.items, [P[1], P[3], P[0], P[2]]) && s1.on === 1 && s1.focus, JSON.stringify(s1));
    // E143：兩邊各自給的部分（tabs.js 的 setupTabs，見 開發筆記 D184）——清單後面淡淡寫在哪個資料夾
    ok('E143 Ctrl+Tab 清單：每一份後面淡淡寫在哪個資料夾（都在最上層）', !!s1 && same(s1.hints, ['最上層', '最上層', '最上層', '最上層']), JSON.stringify(s1 && s1.hints));
    ok('E126 清單開著：狀態列寫放開 Ctrl 換過去', (await win.textContent('#statusKeys')).includes('換過去'), await win.textContent('#statusKeys'));
    await win.keyboard.up('Control');
    ok('E126 放開 Ctrl：換到選到的（分頁4）、清單收起來、游標在文字框',
      await waitFor(async () => (await cur('#noteTabs')) === P[3] && !(await sw())) && (await focused()) === 'noteText');
    await ctrlTab('Tab', 'Tab', 'Shift+Tab', 'Tab', 'Tab');
    const s2 = await sw();
    await win.keyboard.up('Control');
    ok('E126 按住 Ctrl：Tab 往下、Shift+Tab 往上；清單是分頁4、2、1、3，放開換到第四個（分頁3）',
      !!s2 && s2.on === 3 && same(s2.items, [P[3], P[1], P[0], P[2]]) && await waitFor(async () => (await cur('#noteTabs')) === P[2]), JSON.stringify(s2));
    await ctrlTab('Shift+Tab');
    const s3 = await sw();
    await win.keyboard.press('Escape');
    await win.keyboard.up('Control');
    ok('E126 Ctrl+Shift+Tab：一按選到最後一個；Esc 不換、清單收起來', !!s3 && s3.on === 3 && await waitFor(async () => !(await sw())) && (await cur('#noteTabs')) === P[2], JSON.stringify(s3));
    await win.focus('#noteText');
    await win.keyboard.press('Control+w');
    ok('E126 Ctrl+W：關掉正在看的（分頁3）、換到右邊那份、檔案還在',
      await waitFor(async () => same(await names('#noteTabs'), [P[0], P[1], P[3]]) && (await cur('#noteTabs')) === P[3]) && fs.existsSync(path.join(noteDir, P[2] + '.txt')) && !win.isClosed());
    await win.keyboard.type('改');
    await win.keyboard.press('Control+w');
    ok('E126 改過沒存按 Ctrl+W：先問存不存', await waitFor(() => shown('#noteAsk')) && (await win.textContent('#noteAskMsg')).includes(P[3]));
    await win.keyboard.press('Control+w');
    ok('E126 問的時候再按 Ctrl+W：不做事（還在問、頁籤沒少）', await sleep(300).then(async () => await shown('#noteAsk') && same(await names('#noteTabs'), [P[0], P[1], P[3]])));
    await win.click('#noteAskDrop');
    ok('E126 不存：關掉、檔案沒變', await waitFor(async () => same(await names('#noteTabs'), [P[0], P[1]])) && fs.readFileSync(path.join(noteDir, P[3] + '.txt'), 'utf8') === body(P[3]));
    await win.keyboard.press('Control+Shift+T');
    ok('E126 Ctrl+Shift+T：重開最後關掉的（分頁4）、放回原本的位置、換過去（檔案的內容）',
      await waitFor(async () => same(await names('#noteTabs'), [P[0], P[1], P[3]]) && (await cur('#noteTabs')) === P[3] && (await win.inputValue('#noteText')) === body(P[3])));
    await win.keyboard.press('Control+Shift+T');
    ok('E126 再按：重開分頁3、放回第三個', await waitFor(async () => same(await names('#noteTabs'), P) && (await cur('#noteTabs')) === P[2]), JSON.stringify(await names('#noteTabs')));
    await win.click(`${tabSel('#noteTabs', 'f:' + P[0])} .noteName`, { button: 'middle' });
    ok('E126 中鍵點頁籤：關掉那個（不是正在看的也行），正在看的不換', await waitFor(async () => same(await names('#noteTabs'), [P[1], P[2], P[3]])) && (await cur('#noteTabs')) === P[2],
      JSON.stringify([await names('#noteTabs'), await cur('#noteTabs')]));
    await win.keyboard.press('Control+Shift+T');
    await waitFor(async () => same(await names('#noteTabs'), P));
    const b1 = await win.locator(tabSel('#noteTabs', 'f:' + P[3])).boundingBox();
    await win.dragAndDrop(tabSel('#noteTabs', 'f:' + P[0]), tabSel('#noteTabs', 'f:' + P[3]), { targetPosition: { x: b1.width - 4, y: b1.height / 2 } });
    const dragged = [P[1], P[2], P[3], P[0]];
    ok('E126 拖分頁1 到分頁4 的右半邊：插在它後面；記在這台電腦',
      await waitFor(async () => same(await names('#noteTabs'), dragged)) && same(JSON.parse(await win.evaluate(() => localStorage.getItem('daybook.noteTabs'))).open, dragged.map(n => 'f:' + n)),
      JSON.stringify(await names('#noteTabs')));
    const b2 = await win.locator(tabSel('#noteTabs', 'f:' + P[1])).boundingBox();
    await win.dragAndDrop(tabSel('#noteTabs', 'f:' + P[3]), tabSel('#noteTabs', 'f:' + P[1]), { targetPosition: { x: 4, y: b2.height / 2 } });
    ok('E126 拖分頁4 到分頁2 的左半邊：插在它前面', await waitFor(async () => same(await names('#noteTabs'), [P[3], P[1], P[2], P[0]])), JSON.stringify(await names('#noteTabs')));
    await win.reload();
    await win.waitForSelector('#noteTabs .noteTab');
    ok('E126 重新載入：頁籤照拖過的順序', await waitFor(async () => same(await names('#noteTabs'), [P[3], P[1], P[2], P[0]])), JSON.stringify(await names('#noteTabs')));
    await win.locator(`${tabSel('#noteTabs', 'f:' + P[1])} .noteName`).click({ button: 'right' });
    await win.click('#tabMenu button[data-act="others"]');
    await waitFor(async () => same(await names('#noteTabs'), [P[1]]));
    for (let n = 2; n <= 4; n++) {
      await win.keyboard.press('Control+Shift+T');
      await waitFor(async () => (await names('#noteTabs')).length === n);
    }
    ok('E126 右鍵「關閉其他」關掉三個，Ctrl+Shift+T 三下：一個一個放回原本的位置', await waitFor(async () => same(await names('#noteTabs'), [P[3], P[1], P[2], P[0]])), JSON.stringify(await names('#noteTabs')));
    // 文件檢視：同一套；游標在 .html 裡按的由網頁裡的監聽轉過來
    const dd = path.join(mdA, '分頁'), D = [path.join(dd, '甲.md'), path.join(dd, '乙.md'), path.join(dd, '丙.html')];
    fs.mkdirSync(dd);
    fs.writeFileSync(D[0], '# 甲');
    fs.writeFileSync(D[1], '# 乙');
    fs.writeFileSync(D[2], '<!doctype html><meta charset="utf-8"><h1 id="t">丙</h1>');
    const mdCur = () => win.evaluate(() => document.querySelector('#mdTabs .noteTab.on')?.dataset.key ?? null);
    const mdKeys = () => win.$$eval('#mdTabs .noteTab', ts => ts.map(t => t.dataset.key));
    const fr = async () => (await win.$('#docFrame'))?.contentFrame() ?? null;
    const inPage = async () => {   // 游標點進 .html 裡（網頁畫好、監聽放好了才點）
      await waitFor(async () => { const f = await fr(); return !!f && !(await win.$eval('#docFrame', x => x.classList.contains('wait'))) && await f.evaluate(() => !!window.__daybookHooks).catch(() => false); }, 6000);
      await win.frameLocator('#docFrame').locator('#t').click();
    };
    await win.click('#actMd');
    await win.fill('#mdQ', 'mda 分頁');
    await waitFor(() => win.$(`#mdTree .nlRow[data-key="${D[2].replace(/\\/g, '\\\\')}"]`));
    for (const f of D) {
      await win.dblclick(`#mdTree .nlRow[data-key="${f.replace(/\\/g, '\\\\')}"] .nlName`);
      await waitFor(async () => (await mdCur()) === f && !(await win.$('#mdTabs .noteTab.preview')));
    }
    await inPage();
    await win.keyboard.press('Control+PageDown');
    ok('E126 文件檢視、游標在 .html 裡按 Ctrl+PageDown：繞回第一個（甲）、游標進內容', await waitFor(async () => (await mdCur()) === D[0] && (await focused()) === 'mdView'));
    await ctrlTab('Tab');
    await win.keyboard.up('Control');
    ok('E126 文件檢視 Ctrl+Tab：換回上一個看的（丙.html）', await waitFor(async () => (await mdCur()) === D[2]));
    await inPage();
    await ctrlTab('Tab');
    const s5 = await waitFor(sw);
    await win.keyboard.up('Control');
    ok('E126 游標在 .html 裡按 Ctrl+Tab：清單跳出來（丙.html、甲、乙）、放開換到甲',
      !!s5 && same(s5.items, ['丙.html', '甲', '乙']) && s5.on === 1 && await waitFor(async () => (await mdCur()) === D[0]), JSON.stringify(s5));
    ok('E143 文件檢視的 Ctrl+Tab 清單：後面淡淡寫資料夾（分頁）', !!s5 && same(s5.hints, ['分頁', '分頁', '分頁']), JSON.stringify(s5 && s5.hints));
    await win.click(`${tabSel('#mdTabs', D[2])} .noteName`);
    await inPage();
    await win.keyboard.press('Control+w');
    ok('E126 游標在 .html 裡按 Ctrl+W：關掉那份（網頁裡的監聽攔下來、轉過來）', await waitFor(async () => same(await mdKeys(), [D[0], D[1]])) && !win.isClosed());
    ok('E143 游標在 .html 裡按 Ctrl+W：關完游標回內容（換到的乙.md，#mdView）', await waitFor(async () => (await focused()) === 'mdView'), await focused());
    await win.keyboard.press('Control+Shift+T');
    ok('E126 文件檢視 Ctrl+Shift+T：重開、放回原本的位置', await waitFor(async () => same(await mdKeys(), D) && (await mdCur()) === D[2]));
    await win.click(`${tabSel('#mdTabs', D[0])} .noteName`, { button: 'middle' });
    ok('E126 文件檢視中鍵點頁籤：關掉', await waitFor(async () => same(await mdKeys(), [D[1], D[2]])));
    const b3 = await win.locator(tabSel('#mdTabs', D[1])).boundingBox();
    await win.dragAndDrop(tabSel('#mdTabs', D[2]), tabSel('#mdTabs', D[1]), { targetPosition: { x: 4, y: b3.height / 2 } });
    ok('E126 文件檢視拖頁籤：丙插到乙前面、記在這台電腦',
      await waitFor(async () => same(await mdKeys(), [D[2], D[1]])) && same(JSON.parse(await win.evaluate(() => localStorage.getItem('daybook.mdTabs'))).open, [D[2], D[1]]), JSON.stringify(await mdKeys()));
    await win.fill('#mdQ', '');
    fs.rmSync(dd, { recursive: true });
    for (const n of P) fs.rmSync(path.join(noteDir, n + '.txt'));
    await waitFor(async () => (await mdKeys()).length === 0);
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E127：Ctrl+W 不關掉 daybook（見 開發筆記 D161）——Electron 預設選單的「Window → Close」是 Ctrl+W。CDP 送的鍵不會觸發選單（D160 量的），
    // 所以驗的是 Ctrl+W 的預設動作有沒有被攔下來（攔下來選單就不跑，D042 用真的鍵盤驗過）：日記本的搜尋框、日期清單、剪貼簿、F1 快捷鍵表開著時
    {
    const shown = sel => win.isVisible(sel);
    // 畫面的監聽之後才掛的 capture：看得到畫面攔了沒；裡面的元素擋住往下傳也看得到
    await win.evaluate(() => { window.__cw = []; addEventListener('keydown', e => { if (e.ctrlKey && e.key.toLowerCase() === 'w') window.__cw.push(e.defaultPrevented); }, true); });
    const cw = () => win.evaluate(() => window.__cw);
    await win.focus('#q');
    await win.keyboard.press('Control+w');
    await win.focus('#dayList button');
    await win.keyboard.press('Control+w');
    await win.click('#actSnip');
    await waitFor(() => shown('#snipPane'));
    await win.keyboard.press('Control+w');
    await win.click('#actJournal');   // 左欄換回日記本
    await waitFor(() => shown('#q'));
    await win.keyboard.press('F1');
    await waitFor(() => shown('#help'));
    await win.keyboard.press('Control+w');
    await win.keyboard.press('Escape');
    ok('E127 日記本（搜尋框、日期清單）、剪貼簿、快捷鍵表開著時按 Ctrl+W：預設動作都攔下來（選單的關閉視窗不會跑）、畫面照舊',
      same(await cw(), [true, true, true, true]) && !win.isClosed() && await shown('#q'), JSON.stringify(await cw()));
    await waitFor(async () => !(await shown('#help')));
    }

    // E128：大綱的高度可以拉（見 開發筆記 D162）——清單和大綱中間的線：往上拉大綱變高（拉多大就多大，可以超過四成）、記在 daybook.sizes 的 outline；
    // 往上拉到底清單留 60px、往下拉到底大綱 48px；重新載入照舊；收起來時線不出現、打開照拉過的；點兩下還原；外觀頁「還原預設大小」也還原。
    // 還原預設大小會把別的大小一起清掉：先記下來、最後放回去重新載入
    {
    const shown = sel => win.isVisible(sel);
    const f = path.join(mdA, '拉大綱.md');
    fs.writeFileSync(f, Array.from({ length: 30 }, (_, i) => `## 第 ${i + 1} 節\n\n內容`).join('\n\n'));
    const sizesBefore = await win.evaluate(() => localStorage.getItem('daybook.sizes'));
    const sashOn = () => win.$eval('#sashOutline', s => !s.hidden);   // 線本身高 0（抓的是 ::before，同 D074），isVisible 一律是 false，看 hidden
    const at = () => win.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect().height;
      return { ol: Math.round(r('mdOutline')), tree: Math.round(r('mdTree')), list: Math.round(r('mdList')), saved: (JSON.parse(localStorage.getItem('daybook.sizes') || '{}')).outline ?? null }; });
    const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
    const sashAt = () => win.evaluate(() => { const r = document.getElementById('sashOutline').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    const drag = async dy => { const [x, y] = await sashAt(); await win.mouse.move(x, y); await win.mouse.down(); await win.mouse.move(x, y + dy, { steps: 5 }); await win.mouse.up(); };
    await win.click('#actMd');
    await win.fill('#mdQ', '拉大綱');
    await waitFor(() => win.$('#mdTree .nlRow[data-kind="file"]'));
    await win.dblclick('#mdTree .nlRow[data-kind="file"] .nlName');
    await waitFor(async () => (await win.$$('#mdOutlineList .nlRow')).length === 30);
    await win.fill('#mdQ', '');
    const a0 = await at();
    ok('E128 沒拉過：大綱最多四成（30 個標題放不下）、線在、沒記', near(a0.ol, a0.list * 0.4, 3) && await sashOn() && a0.saved === null, JSON.stringify(a0));
    await drag(-80);
    const a1 = await at();
    ok('E128 往上拉 80：大綱高 80（超過四成）、記在 daybook.sizes 的 outline', near(a1.ol, a0.ol + 80) && near(a1.saved, a1.ol, 1), JSON.stringify([a0, a1]));
    await drag(2 - (await sashAt())[1]);   // 拉到視窗最上面（不拉出視窗外：送出去的滑鼠事件不一定收得到，同 E54）
    const a2 = await at();
    ok('E128 往上拉到底：清單留 60px', near(a2.tree, 60), JSON.stringify(a2));
    await drag((await win.evaluate(() => innerHeight)) - 2 - (await sashAt())[1]);
    const a3 = await at();
    ok('E128 往下拉到底：大綱留 48px（標題列＋一行）', near(a3.ol, 48), JSON.stringify(a3));
    await drag(-100);
    const a4 = await at();
    await win.reload();
    await waitFor(async () => (await win.$$('#mdOutlineList .nlRow')).length === 30);
    ok('E128 重新載入：照拉過的高度', near((await at()).ol, a4.ol), JSON.stringify([a4, await at()]));
    await win.click('#mdOutlineHead');
    ok('E128 大綱收起來：線不出現、只剩標題列', await waitFor(async () => !(await sashOn()) && (await at()).ol < 40), JSON.stringify(await at()));
    await win.click('#mdOutlineHead');
    ok('E128 再打開：照拉過的高度、線出來', await waitFor(async () => await sashOn() && near((await at()).ol, a4.ol)), JSON.stringify(await at()));
    const [sx, sy] = await sashAt();
    await win.mouse.dblclick(sx, sy);
    ok('E128 點兩下線：回到沒拉過（最多四成）、記的清掉', await waitFor(async () => { const a = await at(); return near(a.ol, a0.ol) && a.saved === null; }), JSON.stringify(await at()));
    await drag(-60);
    await viaSettings(win, '#skinBtn');
    await waitFor(() => shown('#sizeReset'));
    ok('E128 拉過大綱：外觀頁的「還原預設大小」可以按', !(await win.isDisabled('#sizeReset')));
    await win.click('#sizeReset');
    await win.keyboard.press('Escape');
    ok('E128 還原預設大小：大綱也回到沒拉過', await waitFor(async () => { const a = await at(); return near(a.ol, a0.ol) && a.saved === null; }), JSON.stringify(await at()));
    fs.rmSync(f);
    await win.evaluate(s => { if (s == null) localStorage.removeItem('daybook.sizes'); else localStorage.setItem('daybook.sizes', s); }, sizesBefore);
    await win.click('#actJournal');
    await win.reload();
    await win.waitForSelector('#dayList button');
    await waitFor(() => shown('#q'));
    }

    // E129：記事清單、文件檢視清單的字和資料夾箭頭（見 開發筆記 D163）——字跟日期清單一樣大（14px，原本 13px）；資料夾前面是線條箭頭（svg，原本是 ▸ 字）、
    // 顏色跟字一樣（原本淡灰），收著不轉、打開轉 90 度；大綱的標題列也是。最後刪掉建的、回日記
    {
    const shown = sel => win.isVisible(sel);
    const noteDir = path.join(data, '記事本', '箭頭');
    fs.mkdirSync(noteDir);
    fs.writeFileSync(path.join(noteDir, 'a.txt'), 'a');
    const look = sel => win.$eval(sel, n => {
      const a = n.querySelector('.nlArrow'), s = a?.querySelector('svg'), t = s ? getComputedStyle(s).transform : 'none';
      return { font: getComputedStyle(n).fontSize, svg: !!s, text: a ? a.textContent : null, sameColor: !!a && getComputedStyle(a).color === getComputedStyle(n).color,
        exp: n.getAttribute('aria-expanded'), angle: t === 'none' ? 0 : Math.round(Math.atan2(new DOMMatrix(t).b, new DOMMatrix(t).a) * 180 / Math.PI) };
    });
    const dayFont = await win.$eval('#dayList button', b => getComputedStyle(b).fontSize);
    await win.click('#actNote');
    const row = '#noteTree .nlRow[data-key="d:箭頭"] .nlName';
    await waitFor(() => win.$(row));
    const closed = await look(row);
    await win.click(row);
    await waitFor(async () => (await win.getAttribute(row, 'aria-expanded')) === 'true');
    const opened = await look(row);
    const fileFont = await win.$eval('#noteTree .nlRow[data-key="f:箭頭/a"] .nlName', n => getComputedStyle(n).fontSize);
    ok('E129 記事清單：字跟日期清單一樣大（14px）；資料夾前面是線條箭頭（不是 ▸ 字）、顏色跟字一樣；收著不轉、打開轉 90 度',
      dayFont === '14px' && closed.font === dayFont && fileFont === dayFont && closed.svg && closed.text === '' && closed.sameColor && closed.exp === 'false' && closed.angle === 0 && opened.angle === 90,
      JSON.stringify({ dayFont, closed, opened, fileFont }));
    await win.click('#actMd');
    const root = `#mdTree .nlRow[data-key="${mdA.replace(/\\/g, '\\\\')}"] .nlName`;
    await waitFor(() => win.$(root));
    const r1 = await look(root);
    await win.click(root);
    await waitFor(async () => (await win.getAttribute(root, 'aria-expanded')) !== r1.exp);
    const r2 = await look(root);
    const h1 = await look('#mdOutlineHead');
    await win.click('#mdOutlineHead');
    const h2 = await look('#mdOutlineHead');
    await win.click('#mdOutlineHead');
    ok('E129 文件檢視清單：字 14px、釘住的資料夾的箭頭跟著打開／收著轉；大綱標題列也是線條箭頭，打開 90 度、收起來 0 度',
      r1.font === dayFont && r1.svg && r1.sameColor && r1.angle === (r1.exp === 'true' ? 90 : 0) && r2.angle === (r2.exp === 'true' ? 90 : 0) && r1.angle !== r2.angle
      && h1.svg && h1.exp === 'true' && h1.angle === 90 && h2.exp === 'false' && h2.angle === 0, JSON.stringify({ r1, r2, h1, h2 }));
    if (r2.exp === 'false') await win.click(root);   // 照原本展開
    fs.rmSync(noteDir, { recursive: true });
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E130：Ctrl+1～9 換到頁籤列的第幾個（見 開發筆記 D168）——照畫面上的順序、藏起來的不算；跟點一下一樣（按到正在看的收起左欄、再按打開）；
    // 游標在搜尋框、記事本的文字框、.html 裡（網頁裡的監聽轉過來）都能按；開著的設定選單收起來；快捷鍵表蓋住時不換；超過頁籤的數字不做事。
    // 順序、藏哪些直接改 html（不記進 localStorage），最後改回預設；建的記事、.html 刪掉，回日記
    {
    const shown = sel => win.isVisible(sel);
    // 現在看哪一頁／左欄放什麼：view 沒設是日記；左欄收起來寫 off
    const at = () => win.evaluate(() => { const h = document.documentElement.dataset; return `${h.view || 'journal'}/${h.side === 'off' ? 'off' : h.sideView || 'journal'}`; });
    const atBe = async want => (await waitFor(async () => (await at()) === want, 2000)) ? want : await at();
    const s0 = await at();
    await win.focus('#q');
    await win.keyboard.press('Control+3');
    const s1 = await atBe('note/journal');
    ok('E130 游標在搜尋框按 Ctrl+3：換到第三個（記事本，清單打開）', s0 === 'journal/journal' && s1 === 'note/journal', JSON.stringify([s0, s1]));
    const noteFile = path.join(data, '記事本', 'E130.txt');
    fs.writeFileSync(noteFile, 'E130');
    await waitFor(() => win.$('#noteTree .nlRow[data-key="f:E130"]'));
    await win.dblclick('#noteTree .nlRow[data-key="f:E130"] .nlName');
    await waitFor(async () => (await win.inputValue('#noteText')) === 'E130');
    await win.focus('#noteText');
    await win.keyboard.press('Control+1');
    const s2 = await atBe('journal/journal');
    const f2 = await win.evaluate(() => document.activeElement.id);
    ok('E130 游標在記事本的文字框按 Ctrl+1：回到日記（左欄日記本）、焦點跟滑鼠點一樣到「日記本」那顆上', s2 === 'journal/journal' && f2 === 'actJournal', JSON.stringify([s2, f2]));
    await win.keyboard.press('Control+1');
    const s3 = await atBe('journal/off');
    await win.keyboard.press('Control+1');
    const s4 = await atBe('journal/journal');
    ok('E130 按到正在看的（日記本）：跟點一下一樣收起左欄，再按打開', s3 === 'journal/off' && s4 === 'journal/journal', JSON.stringify([s3, s4]));
    await win.click('#actSettings');
    await waitFor(() => shown('#settingsMenu'));
    await win.keyboard.press('Control+2');
    const s5 = await atBe('journal/snip');
    ok('E130 設定選單開著按 Ctrl+2：換到剪貼簿、選單收起來（跟點外面一樣）', s5 === 'journal/snip' && await waitFor(async () => !(await shown('#settingsMenu')), 1000), s5);
    await win.keyboard.press('F1');
    await waitFor(() => shown('#help'));
    await win.keyboard.press('Control+3');
    await sleep(300);
    const s6 = await at();
    ok('E130 快捷鍵表蓋住頁籤列時按 Ctrl+3：不換（滑鼠也點不到）', s6 === 'journal/snip' && await shown('#help'), s6);
    await win.keyboard.press('Escape');
    await waitFor(async () => !(await shown('#help')));
    // 常用排第一、剪貼簿藏起來：畫面上是 常用、日記本、記事本、文件檢視、截圖
    await win.evaluate(() => { document.documentElement.dataset.hideTabs = 'snip'; applyTabOrder(['launch', 'journal', 'snip', 'note', 'md', 'shot']); });
    await win.keyboard.press('Control+1');
    const s7 = await atBe('journal/launch');
    await win.keyboard.press('Control+5');
    const s8 = await atBe('shot/launch');
    await win.keyboard.press('Control+6');
    await sleep(300);
    const s9 = await at();
    await win.keyboard.press('Control+2');
    const s10 = await atBe('journal/journal');
    ok('E130 調過順序、藏了剪貼簿：Ctrl+1 是常用、Ctrl+5 是截圖、Ctrl+6 超過頁籤數不做事、Ctrl+2 是日記本',
      s7 === 'journal/launch' && s8 === 'shot/launch' && s9 === 'shot/launch' && s10 === 'journal/journal', JSON.stringify([s7, s8, s9, s10]));
    await win.evaluate(() => { delete document.documentElement.dataset.hideTabs; applyTabOrder(TABS); });
    const dd = path.join(mdA, 'E130'), page = path.join(dd, '甲.html');
    fs.mkdirSync(dd);
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><h1 id="t">甲</h1>');
    await win.keyboard.press('Control+4');
    const s11 = await atBe('md/journal');
    await win.fill('#mdQ', 'E130');
    const pageRow = `#mdTree .nlRow[data-key="${page.replace(/\\/g, '\\\\')}"] .nlName`;
    await waitFor(() => win.$(pageRow));
    await win.dblclick(pageRow);
    await waitFor(async () => { const f = await (await win.$('#docFrame'))?.contentFrame(); return !!f && !(await win.$eval('#docFrame', x => x.classList.contains('wait'))) && await f.evaluate(() => !!window.__daybookHooks).catch(() => false); }, 6000);
    await win.frameLocator('#docFrame').locator('#t').click();
    await win.keyboard.press('Control+1');
    const s12 = await atBe('journal/journal');
    ok('E130 Ctrl+4 是文件檢視；游標在 .html 裡按 Ctrl+1：網頁裡的監聽轉過來、回到日記', s11 === 'md/journal' && s12 === 'journal/journal', JSON.stringify([s11, s12]));
    if (!(await shown('#mdQ'))) await win.click('#actMd');   // 回文件檢視、清單打開（上一條紅了的話已經在文件檢視，再點會收起清單）
    await win.fill('#mdQ', '');
    fs.rmSync(dd, { recursive: true });
    await waitFor(async () => (await win.$$('#mdTabs .noteTab')).length === 0);
    await win.click('#actNote');
    await waitFor(() => shown('#notePane'));
    await win.keyboard.press('Control+w');   // 關掉正在看的 E130（D160）
    await waitFor(async () => !(await win.$$eval('#noteTabs .noteTab .noteName', els => els.some(e => e.firstChild?.textContent === 'E130'))));
    fs.rmSync(noteFile);
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E147：Alt+1～9 也能換到頁籤列的第幾個（見 開發筆記 D191）——做的事跟 Ctrl+1～9（E130）同一支；只認上排的數字鍵：
    // Alt＋數字鍵盤（Windows 的 Alt 碼）、Ctrl+Alt＋數字（AltGr）不換；.html 裡按的一樣轉過來。建的 .html 刪掉，回日記
    {
    const shown = sel => win.isVisible(sel);
    const at = () => win.evaluate(() => { const h = document.documentElement.dataset; return `${h.view || 'journal'}/${h.side === 'off' ? 'off' : h.sideView || 'journal'}`; });
    const atBe = async want => (await waitFor(async () => (await at()) === want, 2000)) ? want : await at();
    // Alt＋數字鍵盤的 1（NumLock 開著，key 是 1）：Playwright 的 Numpad1 是 NumLock 關著的 End（照樣綠、沒鑑別力），自己用 CDP 送
    const cdp = await win.context().newCDPSession(win);
    const altPad1 = async () => {
      const k = { modifiers: 1, key: '1', code: 'Numpad1', windowsVirtualKeyCode: 97, location: 3 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    };
    const s0 = await at();
    await win.focus('#q');
    await win.keyboard.press('Alt+3');
    const s1 = await atBe('note/journal');
    ok('E147 游標在搜尋框按 Alt+3：換到第三個（記事本）', s0 === 'journal/journal' && s1 === 'note/journal', JSON.stringify([s0, s1]));
    await altPad1();
    await win.keyboard.press('Control+Alt+1');
    await sleep(300);
    const s2 = await at();
    ok('E147 Alt＋數字鍵盤的 1、Ctrl+Alt+1（AltGr）：不換', s2 === 'note/journal', s2);
    await win.keyboard.press('Alt+1');
    const s3 = await atBe('journal/journal');
    const f3 = await win.evaluate(() => document.activeElement.id);
    await win.keyboard.press('Alt+1');
    const s4 = await atBe('journal/off');
    await win.keyboard.press('Alt+1');
    const s5 = await atBe('journal/journal');
    ok('E147 Alt+1 回日記、焦點到「日記本」那顆；按到正在看的跟點一下一樣收起左欄，再按打開',
      s3 === 'journal/journal' && f3 === 'actJournal' && s4 === 'journal/off' && s5 === 'journal/journal', JSON.stringify([s3, f3, s4, s5]));
    const dd = path.join(mdA, 'E147'), page = path.join(dd, '甲.html');
    fs.mkdirSync(dd);
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><h1 id="t">甲</h1>');
    await win.keyboard.press('Alt+4');
    const s6 = await atBe('md/journal');
    await win.fill('#mdQ', 'E147');
    const pageRow = `#mdTree .nlRow[data-key="${page.replace(/\\/g, '\\\\')}"] .nlName`;
    await waitFor(() => win.$(pageRow));
    await win.dblclick(pageRow);
    await waitFor(async () => { const f = await (await win.$('#docFrame'))?.contentFrame(); return !!f && !(await win.$eval('#docFrame', x => x.classList.contains('wait'))) && await f.evaluate(() => !!window.__daybookHooks).catch(() => false); }, 6000);
    await win.frameLocator('#docFrame').locator('#t').click();
    await altPad1();
    await sleep(300);
    const s7 = await at();
    await win.keyboard.press('Alt+1');
    const s8 = await atBe('journal/journal');
    ok('E147 Alt+4 是文件檢視；游標在 .html 裡按 Alt＋數字鍵盤的 1 不換、Alt+1 轉過來回到日記',
      s6 === 'md/journal' && s7 === 'md/journal' && s8 === 'journal/journal', JSON.stringify([s6, s7, s8]));
    if (!(await shown('#mdQ'))) await win.click('#actMd');   // 回文件檢視、清單打開（上一條紅了的話已經在文件檢視，再點會收起清單）
    await win.fill('#mdQ', '');
    fs.rmSync(dd, { recursive: true });
    await waitFor(async () => (await win.$$('#mdTabs .noteTab')).length === 0);
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    await cdp.detach();
    }

    // E149：記事本、文件檢視、常用清單上面那排按鈕（見 開發筆記 D193）——圖示 20px、按鈕 24px；
    // 左欄拉到最窄（150px）時記事本（四顆）的標題不換行（一行，放不下寫「…」）、按鈕不超出。最後左欄寬度照原本、回日記
    {
    const shown = sel => win.isVisible(sel);
    const head = sel => win.$eval(sel, p => {
      const h = p.querySelector('.snipHead'), t = h.querySelector('h2'), b = h.querySelector('.nlHeadBtns'), r = e => e.getBoundingClientRect();
      return { icons: [...b.querySelectorAll('svg')].map(s => `${r(s).width}x${r(s).height}`), btns: [...b.querySelectorAll('button')].map(x => `${r(x).width}x${r(x).height}`),
        titleH: r(t).height, inside: r(b).right <= r(h).right + 0.5 };
    });
    const got = {};
    for (const [btn, sel] of [['#actNote', '#noteList'], ['#actMd', '#mdList'], ['#actLaunch', '#launchPane']]) {
      await win.click(btn);
      await waitFor(() => shown(sel));
      got[sel] = await head(sel);
    }
    ok('E149 記事本、文件檢視、常用上面那排：圖示 20px、按鈕 24px', Object.values(got).every(g => g.icons.every(s => s === '20x20') && g.btns.every(s => s === '24x24')), JSON.stringify(got));
    await win.click('#actNote');
    await waitFor(() => shown('#noteList'));
    await win.evaluate(() => document.documentElement.style.setProperty('--side-w', '150px'));
    const narrow = await head('#noteList');
    ok('E149 左欄最窄（150px）：記事本的標題一行（不換行）、按鈕不超出', narrow.titleH < 20 && narrow.inside, JSON.stringify(narrow));
    await win.evaluate(() => applySide());   // 照記的寬度（沒拉過就拿掉）
    await win.click('#actJournal');
    await waitFor(() => shown('#q'));
    }

    // E134：點「日記本」時看有沒有跨天（見 開發筆記 D172、D173）——改不了主程序的時鐘，直接把畫面記的今天（st.info.today）改成昨天＝開過夜，
    // 主程序照樣回真的今天。沒跨天點了不換日；停在舊的今天點了換到今天；補記別天、看搜尋結果時不換，只改今天的標記和 Alt+Home；
    // 有卡片在編輯：取消就不換、下次點再問，放棄才換。每次點都照原本收起／打開左欄；最後左欄打開、停在今天
    {
    const ymd = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return localIso(d); })();
    const at = () => win.evaluate(() => { const h = document.documentElement.dataset; return `${h.view || 'journal'}/${h.side === 'off' ? 'off' : h.sideView || 'journal'}`; });
    const atBe = async want => (await waitFor(async () => (await at()) === want, 2000)) ? want : await at();
    const stale = () => win.evaluate(y => { st.info.today = y; }, ymd);
    const clearToast = () => win.evaluate(() => { const t = document.getElementById('toast'); t.hidden = true; t.textContent = ''; });
    const toastNow = async () => ((await win.isVisible('#toast')) && (await win.textContent('#toast'))) || '';
    const newDayMsg = `已經跨天，換到今天（${today}）`;
    const stayMsg = `已經跨天，今天是 ${today}（Alt+Home 回今天）`;   // 不換的時候（D173）
    // 今天：標題是今天、寫「今天」，日期清單選到今天，日曆框起來的是今天
    const onToday = async () => (await headTitle()).startsWith(today) && (await headTitle()).endsWith('今天')
      && (await win.$eval('#dayList button.on', b => b.dataset.date).catch(() => null)) === today
      && (await win.$eval('#calGrid button.today', b => b.dataset.date).catch(() => null)) === today;
    const where = async () => JSON.stringify({ title: await headTitle(), at: await at(), toast: await toastNow() });

    await win.click('#dayList button[data-date="2026-01-22"]');
    await waitFor(async () => (await headTitle()).startsWith('2026-01-22'));
    await clearToast();
    await win.click('#actJournal');
    const n1 = await atBe('journal/off');
    await sleep(300);
    ok('E134 沒跨天：點「日記本」照原本收起左欄，停在 01-22、不跳提示', n1 === 'journal/off' && (await headTitle()).startsWith('2026-01-22') && !(await toastNow()), await where());
    await win.click('#actJournal');
    await atBe('journal/journal');

    await stale();
    await win.keyboard.press('Alt+Home');
    ok('E134 前提：畫面的今天改成昨天，Alt+Home 到昨天、標題寫「今天」', await waitFor(async () => (await headTitle()).startsWith(ymd) && (await headTitle()).endsWith('今天')), await headTitle());
    await clearToast();
    await win.click('#actJournal');
    const n2 = await atBe('journal/off');
    ok('E134 停在舊的今天點「日記本」：收起左欄（照原本）、換到今天（標題、日期清單、日曆）、提示換到哪天',
      n2 === 'journal/off' && await waitFor(onToday) && await waitFor(async () => (await toastNow()) === newDayMsg), await where());
    await win.click('#actJournal');
    await atBe('journal/journal');

    await stale();
    await win.click('#dayList button[data-date="2026-01-22"]');
    await waitFor(async () => (await headTitle()).startsWith('2026-01-22'));
    await win.fill('#newTitle', '補記到一半');
    await clearToast();
    await win.click('#actJournal');
    const n3 = await atBe('journal/off');
    ok('E134 補記別天（01-22）時點「日記本」：收起左欄（照原本）、不換日、打到一半的字還在、提示今天是哪天',
      n3 === 'journal/off' && await waitFor(async () => (await toastNow()) === stayMsg) && (await headTitle()) === '2026-01-22（四）'
      && (await win.$eval('#dayList button.on', b => b.dataset.date).catch(() => null)) === '2026-01-22' && (await win.inputValue('#newTitle')) === '補記到一半', await where());
    await win.fill('#newTitle', '');
    await win.keyboard.press('Alt+Home');
    ok('E134 接著 Alt+Home：到新的今天', await waitFor(onToday), await where());
    await win.click('#actJournal');
    await atBe('journal/journal');

    await stale();
    await win.fill('#q', '週報');
    await win.press('#q', 'Enter');
    await waitFor(async () => (await headTitle()).startsWith('搜尋「週報」'));
    const calBefore = await win.$eval('#calGrid button.today', b => b.dataset.date).catch(() => null);
    await clearToast();
    await win.click('#actJournal');
    ok('E134 看搜尋結果時點「日記本」：不換（還是搜尋結果）、日曆的今天換成新的、提示今天是哪天',
      await waitFor(async () => (await toastNow()) === stayMsg) && (await headTitle()).startsWith('搜尋「週報」')
      && calBefore !== today && (await win.$eval('#calGrid button.today', b => b.dataset.date).catch(() => null)) === today, await where() + ' cal=' + calBefore);
    await win.click('#actJournal');
    await atBe('journal/journal');

    await stale();
    await win.keyboard.press('Alt+Home');
    await waitFor(async () => (await headTitle()).startsWith(ymd));
    await win.locator('#todoCards .card:not(.is-hidden) button.edit').first().click();
    await waitFor(async () => (await win.$$('.card.editing')).length === 1);
    await clearToast();
    await win.click('#actJournal');
    ok('E134 有卡片在編輯時點「日記本」：先問要不要放棄（D140）', await waitFor(() => win.isVisible('#editAsk')), await where());
    await win.click('#editAskCancel');
    await sleep(300);
    const kept = await win.evaluate(() => st.info.today);
    ok('E134 按取消：留在昨天、編輯框還在、不跳提示，畫面的今天還是昨天（下次點再看）',
      (await headTitle()).startsWith(ymd) && (await win.$$('.card.editing')).length === 1 && !(await toastNow()) && kept === ymd, await where() + ' today=' + kept);
    await win.click('#actJournal');   // 剛才收起左欄，這下打開
    ok('E134 再點：又問', await waitFor(() => win.isVisible('#editAsk')), await where());
    await win.click('#editAskDrop');
    ok('E134 按放棄：換到今天、編輯框收掉、提示，左欄打開', await waitFor(onToday) && (await win.$$('.card.editing')).length === 0
      && await waitFor(async () => (await toastNow()) === newDayMsg) && (await at()) === 'journal/journal', await where());
    }

    // E28：搜尋自動補完（見 開發筆記 D032）
    const qGhost = () => ghostOf('#q');
    const searchFor = async q => { await win.fill('#q', q); await win.press('#q', 'Enter'); await waitFor(async () => (await headTitle()).startsWith(`搜尋「${q}」`)); };
    await win.fill('#q', 'cwmm');
    ok('E28 打代號開頭：補成內容裡的代號', await waitFor(async () => (await qGhost()) === '3030'), JSON.stringify(await qGhost()));
    await win.press('#q', 'Tab');
    ok('E28 Tab 收下', await waitFor(async () => (await win.inputValue('#q')) === 'CWMM3030'), await win.inputValue('#q'));
    await win.fill('#q', '雅');
    ok('E28 人名也補', await waitFor(async () => (await qGhost()) === '琦'), JSON.stringify(await qGhost()));
    await win.fill('#q', '雅琦 銷');
    ok('E28 補的是最後一個詞：程式名稱', await waitFor(async () => (await qGhost()) === '退單'), JSON.stringify(await qGhost()));
    await win.press('#q', 'Tab');
    ok('E28 Tab 只換掉最後一個詞', await waitFor(async () => (await win.inputValue('#q')) === '雅琦 銷退單'), await win.inputValue('#q'));
    // 輸入法選字中：框裡已經有字，但還沒送出，不補
    const cdp = await win.context().newCDPSession(win);
    // 這兩條 2026-10-22 整輪跑偶爾紅過一次（單獨重複 40 次都綠），記下事件順序，再紅時看得出是不是選字被中斷（例如視窗失去焦點）
    await win.evaluate(() => {
      window.__imeLog = [];
      const q = document.getElementById('q');
      for (const ev of ['compositionstart', 'compositionend', 'blur', 'focus']) q.addEventListener(ev, () => window.__imeLog.push(`${ev}:${q.value}`), true);
      window.addEventListener('blur', () => window.__imeLog.push('window.blur'));
    });
    const imeLog = () => win.evaluate(() => window.__imeLog.join(' → '));
    await win.fill('#q', '雅琦 ');
    await cdp.send('Input.imeSetComposition', { text: '銷', selectionStart: 1, selectionEnd: 1 });
    await sleep(200);
    ok('E28 輸入法選字中不顯示灰字', (await win.inputValue('#q')) === '雅琦 銷' && (await qGhost()) === '',
      `${await win.inputValue('#q')} / ${JSON.stringify(await qGhost())}；事件：${await imeLog()}`);
    await cdp.send('Input.insertText', { text: '銷' });
    ok('E28 選好字才補', await waitFor(async () => (await qGhost()) === '退單'), `${JSON.stringify(await qGhost())}；值：${await win.inputValue('#q')}；事件：${await imeLog()}`);
    await cdp.detach();
    await win.fill('#q', 'CWIN301021 CWIN301021 銷');
    await sleep(200);
    ok('E28 框裡放不下就不顯示灰字', (await qGhost()) === '', JSON.stringify(await qGhost()));
    await searchFor('CWIN301021');
    await searchFor('CWIN301021');
    await searchFor('CWMM3030 結案');
    await win.fill('#q', 'cwmm');
    ok('E28 搜過的優先：整串補出來（不是只補代號）', await waitFor(async () => (await qGhost()) === '3030 結案'), JSON.stringify(await qGhost()));
    await win.fill('#q', 'cw');
    ok('E28 搜過好幾次的排前面（不是最近搜的那個）', await waitFor(async () => (await qGhost()) === 'IN301021'), JSON.stringify(await qGhost()));
    const qo = await opts();
    await win.press('#q', 'ArrowDown');
    await win.press('#q', 'Enter');
    ok('E28 按過 ↓ 之後 Enter：帶入選中的再搜', await waitFor(async () => (await headTitle()).startsWith(`搜尋「${qo[1]}」`)) && (await win.inputValue('#q')) === qo[1],
      `${JSON.stringify(qo)} / ${await headTitle()}`);
    await win.fill('#q', 'cw');
    await waitFor(listShown);
    await win.press('#q', 'Escape');
    ok('E28 有提示時 Esc 先關提示，字還在', !(await listShown()) && (await win.inputValue('#q')) === 'cw', await win.inputValue('#q'));
    await win.press('#q', 'Escape');
    ok('E28 再按 Esc 清掉搜尋字、灰字也清掉', await waitFor(async () => (await win.inputValue('#q')) === '' && (await qGhost()) === ''), JSON.stringify(await qGhost()));

    // E29：換日快捷鍵（見 開發筆記 D033）——有紀錄的日子：01-15、01-22、09-11、今天
    const dayIs = d => waitFor(async () => (await headTitle()).startsWith(d) && (await win.getAttribute('#dayList button.on', 'data-date').catch(() => null)) === d);
    await win.click(`#dayList button[data-date="2026-09-11"]`);
    await dayIs('2026-09-11');
    await win.click('#dayTitle');
    await win.keyboard.press('Alt+ArrowLeft');
    ok('E29 Alt+←：前一個有紀錄的日子，左邊清單跟著亮', await dayIs('2026-01-22'), await headTitle());
    await win.keyboard.press('Alt+ArrowLeft');
    ok('E29 再按一次', await dayIs('2026-01-15'), await headTitle());
    await win.keyboard.press('Alt+ArrowLeft');
    await sleep(300);
    ok('E29 最前面那天再按：不動', (await headTitle()).startsWith('2026-01-15'), await headTitle());
    await win.keyboard.press('Alt+ArrowRight');
    ok('E29 Alt+→：後一個有紀錄的日子', await dayIs('2026-01-22'), await headTitle());
    await win.fill('#newTitle', '還沒打完的標題');
    await win.press('#newTitle', 'Alt+Home');
    ok('E29 Alt+Home：回今天（游標在標題欄也行）', await dayIs(today), await headTitle());
    ok('E29 換日不會清掉打到一半的標題', (await win.inputValue('#newTitle')) === '還沒打完的標題', await win.inputValue('#newTitle'));
    await win.press('#newTitle', 'Alt+ArrowRight');
    await sleep(300);
    ok('E29 今天之後沒有紀錄：不動', (await headTitle()).includes(today), await headTitle());
    await win.fill('#newTitle', '');
    await searchFor('週報');
    await win.keyboard.press('Alt+ArrowLeft');
    ok('E29 在搜尋結果按 Alt+←：回到日子畫面、看的那天的前一天', await dayIs('2026-09-11') && (await win.isVisible('#todoBox')), await headTitle());

    // E50：日期清單 ↑↓ 換日（見 開發筆記 D070）——點過日期之後游標留在清單上；有紀錄的日子跟 E29 一樣：01-15、01-22、09-11、今天
    const focusedDate = () => win.evaluate(() => (document.getElementById('dayList').contains(document.activeElement) ? document.activeElement.dataset.date : null));
    const focusIs = d => waitFor(async () => (await focusedDate()) === d);
    await win.click(`#dayList button[data-date="${today}"]`);
    ok('E50 點日期：清單重畫之後游標還在清單上、在那一天', await dayIs(today) && await focusIs(today), String(await focusedDate()));
    ok('E50 游標在清單上：狀態列寫 ↑↓ 換日', await waitFor(async () => (await win.textContent('#statusKeys')).startsWith('↑↓ 換日')), await win.textContent('#statusKeys'));
    await win.keyboard.press('ArrowDown');
    ok('E50 ↓：比較舊的那天（清單的下一個），游標跟著過去', await dayIs('2026-09-11') && await focusIs('2026-09-11'), `${await headTitle()} / ${await focusedDate()}`);
    await win.keyboard.press('ArrowDown');
    ok('E50 再按 ↓：跨月份也接得上', await dayIs('2026-01-22') && await focusIs('2026-01-22'), `${await headTitle()} / ${await focusedDate()}`);
    await win.keyboard.press('ArrowUp');
    ok('E50 ↑：比較新的那天', await dayIs('2026-09-11') && await focusIs('2026-09-11'), `${await headTitle()} / ${await focusedDate()}`);
    await win.keyboard.press('ArrowUp');
    await dayIs(today);
    await win.keyboard.press('ArrowUp');
    await sleep(300);
    ok('E50 最上面（今天）再按 ↑：不動', (await headTitle()).includes(today) && (await focusedDate()) === today, `${await headTitle()} / ${await focusedDate()}`);

    // E140：換日不重建日期清單（見 開發筆記 D177）——清單上的按鈕做記號，點別天、Alt+←、點回今天：記號都還在（按鈕沒換掉）、亮的只有正在看的那顆；
    // 外面加一天（接著的 E51）才整份重建，記號就沒了
    const kept140 = () => win.evaluate(() => { const bs = [...document.querySelectorAll('#dayList button')]; return { all: bs.length, kept: bs.filter(b => b.dataset.keep).length, on: bs.filter(b => b.classList.contains('on')).map(b => b.dataset.date) }; });
    await win.evaluate(() => document.querySelectorAll('#dayList button').forEach(b => { b.dataset.keep = '1'; }));
    await win.click('#dayList button[data-date="2026-01-22"]');
    await dayIs('2026-01-22');
    await win.keyboard.press('Alt+ArrowLeft');
    await dayIs('2026-01-15');
    await win.click(`#dayList button[data-date="${today}"]`);
    await dayIs(today);
    const k140 = await kept140();
    ok('E140 換日（點日期、Alt+←）：日期清單沒重建（記號都在）、亮的只有今天', k140.all > 0 && k140.kept === k140.all && same(k140.on, [today]), JSON.stringify(k140));

    // E51：日期清單一週一段底色（見 開發筆記 D071）——外面加 01-16（跟 01-15 同一週，週四、週五），看完刪掉
    const f0116 = path.join(data, dayPath('2026-01-16'));
    fs.writeFileSync(f0116, '同一週的另一天\n');
    await waitFor(async () => (await win.$$('#dayList button[data-date="2026-01-16"]')).length === 1);
    const k140b = await kept140();
    ok('E140 外面加一天：日期清單整份重建（記號沒了），亮的還是今天', k140b.kept === 0 && same(k140b.on, [today]), JSON.stringify(k140b));
    await win.hover('#dayTitle');   // 滑鼠不要停在清單上：滑過的底色會蓋掉
    const bands = await win.$$eval('#dayList button', bs => Object.fromEntries(bs.map(b => [b.dataset.date, [b.classList.contains('wk-alt'), getComputedStyle(b).backgroundColor]])));
    const band = d => bands[d][0];
    ok('E51 同一週的同一段底色、隔壁週換一段（照清單上的順序換）',
      band('2026-01-16') === band('2026-01-15') && band('2026-01-22') !== band('2026-01-16') && band('2026-09-11') !== band('2026-01-22'), JSON.stringify(bands));
    ok('E51 兩段底色看得出來不一樣', bands['2026-01-16'][1] === bands['2026-01-15'][1] && bands['2026-01-22'][1] !== bands['2026-01-16'][1], JSON.stringify(bands));
    fs.rmSync(f0116);
    await waitFor(async () => (await win.$$('#dayList button[data-date="2026-01-16"]')).length === 0);

    // E52：已處理的「標記」、左邊「標記」列出全部（見 開發筆記 D072）——這時看的是今天。標記留著，E39 匯出再匯回要一樣
    const cm = 'CWMM3030 備料調撥 BUG';
    const cw = 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期';
    const res = (src, text) => win.locator(`#results .card[data-src="${src}"]`, { hasText: text }).first();
    // 按「標記」冒出分類鈕，再點一個才標上（見 開發筆記 D076）
    const pickOf = c => c.locator('.flag-pick');
    const pickTexts = c => pickOf(c).locator('button').allTextContents();
    const flagAs = async (c, name) => {
      await c.locator('button.flag').click();
      await pickOf(c).getByRole('button', { name, exact: true }).click();
    };
    ok('E52 已處理的卡片：「標記」在「+ 更新」前面；待處理的沒有', (await cardOf(today, cm).locator('.actions button.flag + button.upd').count()) === 1
      && (await win.$$('#todoCards button.flag')).length === 0);
    const before52 = readN(todayFile);
    await flagAs(cardOf(today, cm), '未分類');
    ok('E52 點一下標記：行尾加 [標記]、其他行都沒變', await waitFor(() => readN(todayFile) === before52.replace(cm + '\n', cm + ' [標記]\n')), JSON.stringify(readN(todayFile)));
    ok('E52 按鈕亮起來', await waitFor(async () => /\bon\b/.test(await cardOf(today, cm).locator('button.flag').getAttribute('class'))));
    // 過去的、還沒有事件編號的那筆：標記後按 + 更新 → 原本那筆加編號、標記拿掉；今天新記的那筆帶標記
    const f0115 = path.join(data, dayPath('2026-01-15'));
    await win.click('#dayList button[data-date="2026-01-15"]');
    await dayIs('2026-01-15');
    await flagAs(cardOf('2026-01-15', '折讓證明日期'), '未分類');
    ok('E52 過去的日子也能標記', await waitFor(() => readN(f0115).split('\n').includes(cw + ' [標記]')), readN(f0115));
    const id52 = srch.maxEvent(srch.buildIndex(readSources(data))) + 1;
    await addUpdate(cardOf('2026-01-15', '折讓證明日期'), '等雅琦確認');
    ok('E52 標記過的過去那筆按 + 更新：原本那筆加編號、標記拿掉', await waitFor(() => readN(f0115).split('\n').includes(`${cw} ^${id52}`)), readN(f0115));
    ok('E52 標記搬到今天新記的那筆', await waitFor(() => readN(todayFile).endsWith(`${cw} ^${id52} [標記]\n\t->等雅琦確認\n`)), JSON.stringify(readN(todayFile)));
    const yq52 = '雅琦問題：發票作廢後又產生一次作廢的XML';
    await win.click('#dayList button[data-date="2026-01-22"]');
    await dayIs('2026-01-22');
    await flagAs(cardOf('2026-01-22', yq52), '未分類');
    ok('E52 有事件編號的也能標記：標記在編號後面', await waitFor(() => readN(f0122).split('\n').includes(yq52 + ' ^1 [標記]')), readN(f0122));
    // 標記清單
    await win.click('#flagList');
    ok('E52 左邊「標記」：列出全部標記的、舊的在前、標題寫筆數', await waitFor(async () => (await headTitle()) === '標記：3 筆' && same(await resultSrcs(), ['2026-01-22', today, today])),
      `${await headTitle()} ${JSON.stringify(await resultSrcs())}`);
    ok('E52 清單畫面：「標記」亮著、不顯示已處理／待處理、有「回到那天」', /\bon\b/.test(await win.getAttribute('#flagList', 'class'))
      && !(await win.isVisible('#doneBox')) && (await win.isVisible('#backBtn')));
    // E133：標記清單也帶前情（見 開發筆記 D171）——今天的 cw（^id52）帶 01-15 那筆：那筆沒有內容、標題一樣，只標日期；01-22 那筆是第一筆、cm 沒編號，都不帶
    ok('E133 標記清單：今天那筆帶 01-15（只有日期）、第一筆和沒編號的不帶', await waitFor(async () => same(await priorOf(res(today, cw)), { dates: ['01-15（四）'], titles: 0, lines: [], beforeBody: true, muted: true })
      && (await priorOf(res('2026-01-22', yq52))) === null && (await priorOf(res(today, cm))) === null),
      JSON.stringify([await priorOf(res(today, cw)).catch(e => e.message), await priorOf(res('2026-01-22', yq52)).catch(e => e.message), await priorOf(res(today, cm)).catch(e => e.message)]));
    const beforeUnflag = readN(todayFile);
    await res(today, cm).locator('button.unflag').click();
    ok('E52 清單上直接取消標記：行尾拿掉、從清單消失', await waitFor(() => readN(todayFile) === beforeUnflag.replace(cm + ' [標記]\n', cm + '\n')) && await waitFor(async () => (await headTitle()) === '標記：2 筆'
      && same(await resultSrcs(), ['2026-01-22', today])), `${await headTitle()} ${JSON.stringify(await resultSrcs())}`);
    await undoKey();
    ok('E52 Ctrl+Z 復原取消標記，清單跟著回來', await waitFor(() => readN(todayFile).split('\n').includes(cm + ' [標記]')) && await waitFor(async () => (await headTitle()) === '標記：3 筆'),
      `${await headTitle()} ${JSON.stringify(readN(todayFile))}`);
    await win.click('#backBtn');
    await searchFor(cm);
    ok('E52 搜尋結果上標「標記」', await waitFor(async () => (await res(today, cm).locator('.badge', { hasText: '標記' }).count()) === 1));
    ok('E52 不在標記清單時「標記」不亮', !/\bon\b/.test(await win.getAttribute('#flagList', 'class')));
    // 編輯卡片：標記不在編輯框裡改，存檔要留著
    await win.click(`#dayList button[data-date="${today}"]`);
    await dayIs(today);
    const beforeEdit = readN(todayFile);
    await cardOf(today, cm).locator('button.edit').click();
    await win.locator('.card.editing button.save').click();
    ok('E52 編輯卡片存檔：標記留著', await waitFor(async () => (await win.$$('.card.editing')).length === 0) && readN(todayFile) === beforeEdit, JSON.stringify(readN(todayFile)));

    // E53：標記的分類（見 開發筆記 D076）——接著 E52：今天的 cm、cw（^id52）、01-22 的 yq52 都標著未分類；分類檔還沒有。
    // 分類留著，E39 匯出再匯回要一樣
    const catsFile = path.join(data, '標記分類.json');
    const catsIn = () => JSON.parse(readN(catsFile) || 'null');
    await cardOf(today, cm).locator('button.flag').click();
    // 內建的「未完」一直都在、排第一個（D089、D091）
    ok('E53 標過的按「標記」：冒出分類鈕、現在的（未分類）亮著、最後是「取消標記」；還沒有分類檔', await waitFor(async () => same(await pickTexts(cardOf(today, cm)), ['未分類', '未完', '＋ 新分類', '取消標記']))
      && /\bon\b/.test(await pickOf(cardOf(today, cm)).getByRole('button', { name: '未分類', exact: true }).getAttribute('class')) && !fs.existsSync(catsFile),
      JSON.stringify(await pickTexts(cardOf(today, cm))));
    await pickOf(cardOf(today, cm)).getByRole('button', { name: '＋ 新分類' }).click();
    const catNew = c => c.locator('input.cat-new');
    await catNew(cardOf(today, cm)).fill('  ');
    await catNew(cardOf(today, cm)).press('Enter');
    ok('E53 新分類空白：提示、不寫、框還在', await waitFor(async () => ((await win.textContent('#toast')) || '').includes('分類名稱不能空白'))
      && !fs.existsSync(catsFile) && (await catNew(cardOf(today, cm)).isVisible()));
    const before53 = readN(todayFile);
    const withCat53 = before53.replace(cm + ' [標記]\n', cm + ' [標記:等客戶]\n');
    await catNew(cardOf(today, cm)).fill('等客戶');
    await catNew(cardOf(today, cm)).press('Enter');
    ok('E53 ＋ 新分類 Enter：行尾換成 [標記:等客戶]、其他行都沒變', await waitFor(() => readN(todayFile) === withCat53), JSON.stringify(readN(todayFile)));
    ok('E53 分類存進資料夾的 標記分類.json', same(catsIn(), { categories: ['等客戶'] }), readN(catsFile));
    ok('E53 按鈕寫出分類', await waitFor(async () => (await cardOf(today, cm).locator('button.flag').textContent()) === '標記·等客戶'));
    await undoKey();
    ok('E53 Ctrl+Z 復原標記，分類清單留著', await waitFor(() => readN(todayFile) === before53) && same(catsIn(), { categories: ['等客戶'] }), JSON.stringify(readN(todayFile)));
    await cardOf(today, cm).locator('button.flag').click();
    await waitFor(async () => (await pickTexts(cardOf(today, cm))).includes('等客戶'));
    await pickOf(cardOf(today, cm)).getByRole('button', { name: '等客戶', exact: true }).click();
    ok('E53 點已經有的分類就標上', await waitFor(() => readN(todayFile) === withCat53), JSON.stringify(readN(todayFile)));
    // 沒標記的（01-15 那筆，E52 更新後標記搬走了）：最後是「取消」，按了收起來、不寫
    await win.click('#dayList button[data-date="2026-01-15"]');
    await dayIs('2026-01-15');
    const cw53 = cardOf('2026-01-15', '折讓證明日期');
    const before0115 = readN(f0115);
    await cw53.locator('button.flag').click();
    ok('E53 沒標記的按「標記」：分類照清單順序、沒有亮的、最後是「取消」', await waitFor(async () => same(await pickTexts(cw53), ['未分類', '未完', '等客戶', '＋ 新分類', '取消']))
      && (await pickOf(cw53).locator('button.on').count()) === 0, JSON.stringify(await pickTexts(cw53)));
    // 分類鈕開著時外面改了檔：左邊清單照樣更新，卡片先不重畫、分類鈕還開著。
    // 改的是 01-16（外面打的分類，全形冒號；分類清單沒有也要列），跟 E51 一樣，後面看完刪掉
    fs.writeFileSync(f0116, '外面改的一筆 [標記：外面打的]\n');
    await waitFor(async () => (await win.$$('#dayList button[data-date="2026-01-16"]')).length === 1);
    await sleep(300);
    ok('E53 分類鈕開著時外面改檔：左邊清單更新了、分類鈕還開著', await pickOf(cw53).isVisible());
    await pickOf(cw53).getByRole('button', { name: '取消', exact: true }).click();
    ok('E53 按「取消」收起來、不寫', await waitFor(async () => !(await pickOf(cw53).isVisible())) && readN(f0115) === before0115);
    // 過去的、有事件編號的：加第二個分類
    await win.click('#dayList button[data-date="2026-01-22"]');
    await dayIs('2026-01-22');
    const yq53 = cardOf('2026-01-22', yq52);
    await yq53.locator('button.flag').click();
    await waitFor(async () => (await pickTexts(yq53)).includes('等客戶'));
    await pickOf(yq53).getByRole('button', { name: '＋ 新分類' }).click();
    await catNew(yq53).fill('要測');
    await catNew(yq53).press('Enter');
    ok('E53 過去的、有事件編號的：分類寫在編號後面', await waitFor(() => readN(f0122).split('\n').includes(yq52 + ' ^1 [標記:要測]')), readN(f0122));
    ok('E53 新分類接在清單最後面', same(catsIn(), { categories: ['等客戶', '要測'] }), readN(catsFile));
    // 標記清單：上面一排篩選鈕（01-16 外面打的分類接在最後）
    const filterTexts = () => win.$$eval('#results .flag-filter button', bs => bs.map(b => b.textContent));
    const filterBtn = k => `#results .flag-filter button[data-cat="${k}"]`;
    await win.click('#flagList');
    ok('E53 標記清單上面一排篩選鈕：全部、未分類、清單裡的照順序、紀錄裡才有的接後面，後面寫筆數；預設「全部」', await waitFor(async () => (await headTitle()) === '標記：4 筆'
      && same(await filterTexts(), ['全部 4', '未分類 1', '未完 0', '等客戶 1', '要測 1', '外面打的 1'])) && /\bon\b/.test(await win.getAttribute(filterBtn('全部'), 'class')),
      `${await headTitle()} ${JSON.stringify(await filterTexts())}`);
    ok('E53 清單上的卡片標分類；未分類的不標', same(await res(today, cm).locator('.badge').allTextContents(), ['等客戶'])
      && (await res(today, '折讓證明日期').locator('.badge').count()) === 0);
    await win.click(filterBtn('等客戶'));
    ok('E53 點分類：只列那一類、標題寫分類和筆數、那顆亮著', await waitFor(async () => (await headTitle()) === '標記（等客戶）：1 筆' && same(await resultSrcs(), [today])
      && /\bon\b/.test(await win.getAttribute(filterBtn('等客戶'), 'class')) && !/\bon\b/.test(await win.getAttribute(filterBtn('全部'), 'class'))),
      `${await headTitle()} ${JSON.stringify(await resultSrcs())}`);
    await res(today, cm).locator('button.unflag').click();
    ok('E53 篩著分類取消標記：[標記:等客戶] 整個拿掉；篩選留著、清單空了、分類鈕還在（0 筆）', await waitFor(() => readN(todayFile) === before53.replace(cm + ' [標記]\n', cm + '\n'))
      && await waitFor(async () => (await headTitle()) === '標記（等客戶）：0 筆' && ((await win.textContent('#results .empty').catch(() => '')) || '') === '這個分類沒有標記的事'
      && (await filterTexts()).includes('等客戶 0')), `${await headTitle()} ${JSON.stringify(await filterTexts())}`);
    await undoKey();
    ok('E53 Ctrl+Z 復原，清單跟著回來', await waitFor(() => readN(todayFile) === withCat53) && await waitFor(async () => (await headTitle()) === '標記（等客戶）：1 筆'));
    await win.click(filterBtn('全部'));
    ok('E53 點「全部」回到全部', await waitFor(async () => (await headTitle()) === '標記：4 筆'));
    fs.rmSync(f0116);
    await waitFor(async () => (await win.$$('#dayList button[data-date="2026-01-16"]')).length === 0);
    // + 更新：過去那筆的分類跟著標記搬到今天那筆
    await win.click('#dayList button[data-date="2026-01-22"]');
    await dayIs('2026-01-22');
    await addUpdate(cardOf('2026-01-22', yq52), '要測的後續');
    ok('E53 標了分類的過去那筆按 + 更新：原本那筆拿掉，今天那筆帶同一個分類', await waitFor(() => readN(f0122).split('\n').includes(yq52 + ' ^1')
      && readN(todayFile).endsWith(`${yq52} ^1 [標記:要測]\n\t->要測的後續\n`)), `${readN(f0122)}\n---\n${readN(todayFile)}`);
    await searchFor('要測的後續');
    ok('E53 搜尋結果標「標記·分類」', await waitFor(async () => same(await res(today, yq52).locator('.badge').allTextContents(), ['標記·要測'])),
      JSON.stringify(await res(today, yq52).locator('.badge').allTextContents()));
    // 編輯卡片：分類不在編輯框裡改，存檔要留著
    await win.click(`#dayList button[data-date="${today}"]`);
    await dayIs(today);
    const beforeEdit53 = readN(todayFile);
    await cardOf(today, cm).locator('button.edit').click();
    await win.locator('.card.editing button.save').click();
    ok('E53 編輯卡片存檔：分類留著', await waitFor(async () => (await win.$$('.card.editing')).length === 0) && readN(todayFile) === beforeEdit53, JSON.stringify(readN(todayFile)));

    // E63：待處理卡片「已處理+未完標籤」（見 開發筆記 D091）——接著 E53：看的是今天，分類檔是等客戶、要測。
    // 先加一筆待處理、+ 更新、標待回覆，再按：整筆（含進展）搬進今天的已處理，待回覆換成 [標記:未完]；內建分類不寫進分類檔。
    // 最後留著這筆，E39 匯出再匯回也帶到
    const before63 = readN(todayFile);
    const todo63 = readN(todoFile);
    await addNew('問雅琦報表欄位', '先改了查詢條件', '#addTodo');
    const yq63 = cardOf('todo', '問雅琦報表欄位');
    await addUpdate(yq63, '改了一半');
    await yq63.locator('button.wait').click();
    await waitFor(() => readN(todoFile).split('\n').includes('問雅琦報表欄位 [待回覆]'));
    const todoWith63 = readN(todoFile);
    ok('E63 待處理卡片：「已處理+未完標籤」接在「處理完 ↑」後面', same(await yq63.locator('.actions button').allTextContents(), ['+ 更新', '處理完 ↑', '已處理+未完標籤', '隱藏', '編輯', '刪除']),
      JSON.stringify(await yq63.locator('.actions button').allTextContents()));
    const want63 = before63 + `問雅琦報表欄位 [標記:未完]\n\t先改了查詢條件\n\t->${mmdd} 改了一半\n`;
    await yq63.locator('button.unfinished').click();
    ok('E63 按了：整筆（含進展）接在今天的檔最後、待回覆換成 [標記:未完]；待處理拿掉那筆',
      await waitFor(() => readN(todayFile) === want63 && readN(todoFile) === todo63), `${JSON.stringify(readN(todayFile))}\n---\n${JSON.stringify(readN(todoFile))}`);
    ok('E63 卡片從下面移到上面、按鈕寫「標記·未完」、提示寫標上「未完」', await waitFor(async () => !(await todoTitles()).includes('問雅琦報表欄位')
      && (await cardOf(today, '問雅琦報表欄位').locator('button.flag').textContent()) === '標記·未完' && ((await win.textContent('#toast')) || '').includes('標上「未完」')));
    ok('E63 內建分類不寫進分類檔', same(catsIn(), { categories: ['等客戶', '要測'] }), readN(catsFile));
    await undoKey();
    ok('E63 Ctrl+Z：兩個檔都回到按之前', await waitFor(() => readN(todayFile) === before63 && readN(todoFile) === todoWith63),
      `${JSON.stringify(readN(todayFile))}\n---\n${JSON.stringify(readN(todoFile))}`);
    await cardOf('todo', '問雅琦報表欄位').locator('button.unfinished').click();
    await waitFor(() => readN(todayFile) === want63);
    await win.click('#flagList');
    await win.click(filterBtn('未完'));
    ok('E63 標記清單篩「未完」：列這一筆', await waitFor(async () => (await headTitle()) === '標記（未完）：1 筆' && same(await resultSrcs(), [today])),
      `${await headTitle()} ${JSON.stringify(await filterTexts())}`);
    await win.click(filterBtn('全部'));
    await win.click('#backBtn');
    await dayIs(today);

    // E123：標記清單分批畫（見 開發筆記 D157）——接著 E63（看今天）。外面寫一天 320 筆標記的（2026-01-02，最舊、排在清單最前面）：
    // 先畫 300 張、捲到底接上其他的；捲在下面取消一筆，重畫不縮回 300 張、捲動位置留著；換篩選、換回全部都從 300 張畫起；最後 Ctrl+Z、刪掉那天
    await win.click('#flagList');
    await waitFor(async () => /^標記：\d+ 筆$/.test(await headTitle()));
    const n123 = Number((await headTitle()).match(/\d+/)[0]);
    const f123 = path.join(data, dayPath('2026-01-02'));
    const text123 = Array.from({ length: 320 }, (_, i) => `分批測試第 ${i + 1} 件 [標記]\n\t內容 ${i + 1}\n`).join('');
    fs.writeFileSync(f123, text123);
    const cards123 = () => win.$$eval('#results .card', els => els.length);
    const scroll123 = () => win.$eval('#results', b => b.scrollTop);
    ok('E123 標記超過 300 筆：標題寫全部的筆數，先畫 300 張', await waitFor(async () => (await headTitle()) === `標記：${n123 + 320} 筆` && (await cards123()) === 300),
      `${await headTitle()} ${await cards123()}`);
    await win.$eval('#results', b => { b.scrollTop = b.scrollHeight; });
    ok('E123 捲到底：接上其他的', await waitFor(async () => (await cards123()) === n123 + 320), String(await cards123()));
    const c123 = win.locator('#results .card', { hasText: '分批測試第 310 件' });
    await c123.scrollIntoViewIfNeeded();
    const s123 = await scroll123();
    await c123.locator('button.unflag').click();
    ok('E123 捲在下面取消一筆：那筆行尾拿掉；重畫還是全部都畫、捲動位置不動', await waitFor(() => readN(f123) === text123.replace('分批測試第 310 件 [標記]\n', '分批測試第 310 件\n'))
      && await waitFor(async () => (await headTitle()) === `標記：${n123 + 319} 筆`) && (await sleep(500), (await cards123()) === n123 + 319 && Math.abs((await scroll123()) - s123) < 2),
      `${await headTitle()} ${await cards123()} ${s123}→${await scroll123()}`);
    await win.click(filterBtn('未分類'));
    ok('E123 換篩選：從 300 張畫起', await waitFor(async () => (await headTitle()).startsWith('標記（未分類）') && (await cards123()) === 300), `${await headTitle()} ${await cards123()}`);
    await win.click(filterBtn('全部'));
    ok('E123 換回全部：也從 300 張畫起', await waitFor(async () => (await headTitle()) === `標記：${n123 + 319} 筆` && (await cards123()) === 300), `${await headTitle()} ${await cards123()}`);
    await undoKey();
    ok('E123 Ctrl+Z 復原取消的那筆', await waitFor(() => readN(f123) === text123) && await waitFor(async () => (await headTitle()) === `標記：${n123 + 320} 筆`));
    fs.rmSync(f123);
    await waitFor(async () => (await headTitle()) === `標記：${n123} 筆`);
    await win.click('#backBtn');
    await dayIs(today);

    // E151：標記清單的分類改名、合併、刪除、多選（見 開發筆記 D197）——接著 E123（看今天）：今天有 cm [標記:等客戶]、cw [標記]、yq52 [標記:要測]、
    // 問雅琦報表欄位 [標記:未完]，分類檔是等客戶、要測。外面寫 2026-01-04（最舊、排在清單最前面）三筆：甲的標題中間、內文也寫著 [標記:等客戶]（不能被改到）。
    // 每一步都 Ctrl+Z 回來，最後刪掉那天，後面的（E39 匯出再匯回）照舊
    const f151 = path.join(data, dayPath('2026-01-04'));
    const text151 = '外面的甲 先[標記:等客戶]再說 [標記:等客戶]\n\t內文寫著 [標記:等客戶]\n外面的乙 [標記:要測]\n外面的丙 [標記]\n';
    fs.writeFileSync(f151, text151);
    const today151 = readN(todayFile);
    const cats151 = catsIn();
    const same151 = () => readN(todayFile) === today151 && readN(f151) === text151 && same(catsIn(), cats151);
    const toastHas = async s => ((await win.textContent('#toast')) || '').includes(s);
    const catMenuOn = () => win.isVisible('#flagCatMenu');
    const renameTo = async (cat, name) => {
      await win.click(filterBtn(cat), { button: 'right' });
      await win.click('#flagCatMenu [data-act="rename"]');
      await win.fill('#results input.cat-rename', name);
      await win.press('#results input.cat-rename', 'Enter');
    };
    await win.click('#flagList');
    ok('E151 前提：標記清單列出外面那天的三筆、篩選鈕底下一行說明', await waitFor(async () => (await headTitle()) === `標記：${n123 + 3} 筆`
      && same(await filterTexts(), ['全部 7', '未分類 2', '未完 1', '等客戶 2', '要測 2'])
      && ((await win.textContent('#results .flag-sel').catch(() => '')) || '').includes('Ctrl＋點卡片選好幾筆')), `${await headTitle()} ${JSON.stringify(await filterTexts())}`);
    // 右鍵：「全部」「未分類」、內建的「未完」沒有選單；自己的分類有「改名…」「刪除分類」
    let menu151 = [];
    for (const k of ['全部', '未分類', '未完']) {
      await win.click(filterBtn(k), { button: 'right' });
      menu151.push(await catMenuOn());
    }
    await win.click(filterBtn('等客戶'), { button: 'right' });
    ok('E151 分類按右鍵：全部、未分類、未完沒有選單；自己的分類有改名、刪除', same(menu151, [false, false, false]) && await catMenuOn()
      && same(await win.$$eval('#flagCatMenu button', bs => bs.map(b => b.textContent)), ['改名…', '刪除分類']), JSON.stringify(menu151));
    await win.keyboard.press('Escape');
    // 篩著「等客戶」改名：改名框開著時外面改檔不洗掉框；Esc 收起來不改
    await win.click(filterBtn('全部'));
    await win.click(filterBtn('等客戶'));
    await win.click(filterBtn('等客戶'), { button: 'right' });
    await win.click('#flagCatMenu [data-act="rename"]');
    ok('E151 改名…：那顆鈕換成輸入框，帶原本的名稱', await waitFor(async () => (await win.inputValue('#results input.cat-rename').catch(() => null)) === '等客戶'));
    fs.writeFileSync(f151, text151);   // 外面存了一次（內容一樣，監看照樣通知）
    await sleep(500);
    ok('E151 改名框開著時外面改檔：框還在', await win.isVisible('#results input.cat-rename'));
    await win.press('#results input.cat-rename', 'Escape');
    ok('E151 Esc：框收起來、鈕回來，檔都沒動', await waitFor(async () => !(await win.isVisible('#results input.cat-rename').catch(() => false)) && (await win.isVisible(filterBtn('等客戶')))) && same151());
    await renameTo('等客戶', '全部');
    ok('E151 名稱不行：提示、不問、框留著', await waitFor(() => toastHas('是標記清單上用的字')) && !(await win.isVisible('#flagAsk')) && (await win.isVisible('#results input.cat-rename')) && same151());
    await win.fill('#results input.cat-rename', '等廠商');
    await win.press('#results input.cat-rename', 'Enter');
    ok('E151 改名先問一次：寫幾筆幾天、游標在「改名」', await waitFor(async () => (await win.isVisible('#flagAsk'))
      && (await win.textContent('#flagAskMsg')) === '把分類「等客戶」改名成「等廠商」？2 筆（2 天）會一起改。' && (await win.evaluate(() => document.activeElement.id)) === 'flagAskOk'
      && (await win.textContent('#flagAskOk')) === '改名'), await win.textContent('#flagAskMsg'));
    await win.keyboard.press('Escape');
    ok('E151 問的時候 Esc：不改、框留著', await waitFor(async () => !(await win.isVisible('#flagAsk'))) && (await win.isVisible('#results input.cat-rename')) && same151());
    await win.press('#results input.cat-rename', 'Enter');
    await waitFor(() => win.isVisible('#flagAsk'));
    await win.keyboard.press('Enter');
    ok('E151 改名：兩天的行尾都換、標題中間和內文不動；分類檔原位換掉；篩選跟著新名稱；提示筆數',
      await waitFor(() => readN(todayFile) === today151.replace(cm + ' [標記:等客戶]\n', cm + ' [標記:等廠商]\n')
        && readN(f151) === text151.replace('再說 [標記:等客戶]\n', '再說 [標記:等廠商]\n') && same(catsIn(), { categories: ['等廠商', '要測'] }))
      && await waitFor(async () => (await headTitle()) === '標記（等廠商）：2 筆' && same(await filterTexts(), ['全部 7', '未分類 2', '未完 1', '等廠商 2', '要測 2']))
      && await toastHas('已把分類「等客戶」改名成「等廠商」：2 筆'),
      `${JSON.stringify(readN(f151))} ${JSON.stringify(catsIn())} ${await headTitle()} ${JSON.stringify(await filterTexts())}`);
    await undoKey();
    ok('E151 Ctrl+Z 一次：兩天和分類檔都回來', await waitFor(same151) && await toastHas('已復原：分類改名'), `${JSON.stringify(readN(f151))} ${JSON.stringify(catsIn())}`);
    // 合併：改成已經有的「要測」
    await win.click(filterBtn('全部'));
    await renameTo('等客戶', '要測');
    ok('E151 改成已經有的：問要不要併進去', await waitFor(async () => (await win.textContent('#flagAskMsg').catch(() => '')) === '「要測」已經有了：把「等客戶」的 2 筆（2 天）併進「要測」？「等客戶」會從分類拿掉。'
      && (await win.textContent('#flagAskOk')) === '合併'), await win.textContent('#flagAskMsg'));
    await win.click('#flagAskOk');
    ok('E151 合併：兩天的 [標記:等客戶] 換成 [標記:要測]、分類檔拿掉等客戶、篩選鈕少一顆',
      await waitFor(() => readN(todayFile) === today151.replace(cm + ' [標記:等客戶]\n', cm + ' [標記:要測]\n')
        && readN(f151) === text151.replace('再說 [標記:等客戶]\n', '再說 [標記:要測]\n') && same(catsIn(), { categories: ['要測'] }))
      && await waitFor(async () => same(await filterTexts(), ['全部 7', '未分類 2', '未完 1', '要測 4'])) && await toastHas('已把「等客戶」的 2 筆併進「要測」'),
      `${JSON.stringify(catsIn())} ${JSON.stringify(await filterTexts())}`);
    await undoKey();
    ok('E151 Ctrl+Z：合併前的樣子', await waitFor(same151) && await waitFor(async () => (await filterTexts()).includes('等客戶 2')));
    // 刪除：用到的取消標記
    await win.click(filterBtn('要測'), { button: 'right' });
    await win.click('#flagCatMenu [data-act="delete"]');
    ok('E151 刪除分類先問：寫幾筆幾天會取消標記', await waitFor(async () => (await win.textContent('#flagAskMsg').catch(() => '')) === '刪除分類「要測」？2 筆（2 天）會取消標記。'
      && (await win.textContent('#flagAskOk')) === '刪除'), await win.textContent('#flagAskMsg'));
    await win.click('#flagAskCancel');
    ok('E151 取消：不刪', await waitFor(async () => !(await win.isVisible('#flagAsk'))) && same151());
    await win.click(filterBtn('要測'), { button: 'right' });
    await win.click('#flagCatMenu [data-act="delete"]');
    await waitFor(() => win.isVisible('#flagAsk'));
    await win.keyboard.press('Enter');
    ok('E151 刪除：兩天的 [標記:要測] 整個拿掉（事件編號留著）、分類檔拿掉；提示筆數',
      await waitFor(() => readN(todayFile) === today151.replace(`${yq52} ^1 [標記:要測]\n`, `${yq52} ^1\n`)
        && readN(f151) === text151.replace('外面的乙 [標記:要測]\n', '外面的乙\n') && same(catsIn(), { categories: ['等客戶'] }))
      && await waitFor(async () => same(await filterTexts(), ['全部 5', '未分類 2', '未完 1', '等客戶 2'])) && await toastHas('已刪除分類「要測」，2 筆取消標記'),
      `${JSON.stringify(readN(f151))} ${JSON.stringify(catsIn())} ${JSON.stringify(await filterTexts())}`);
    await undoKey();
    ok('E151 Ctrl+Z：刪除前的樣子', await waitFor(same151) && await waitFor(async () => (await filterTexts()).includes('要測 2')));
    // 多選：Ctrl＋點、Shift＋點一段、再 Ctrl＋點取消一張；換分類冒出跟卡片上一樣的分類鈕
    const res151 = t => win.locator('#results .card[data-src="2026-01-04"]', { hasText: t }).first();
    const selN = () => win.$$eval('#results .card.sel', els => els.length);
    await res151('外面的甲').locator('.title').click({ modifiers: ['Control'] });
    ok('E151 Ctrl＋點：那張框起來、上面寫已選 1 筆', await waitFor(async () => (await selN()) === 1 && (await win.textContent('#results .flag-sel .sel-n').catch(() => '')) === '已選 1 筆'));
    await res151('外面的丙').locator('.title').click({ modifiers: ['Shift'] });
    ok('E151 Shift＋點：從甲到丙一段都選', await waitFor(async () => (await selN()) === 3));
    await res151('外面的乙').locator('.title').click({ modifiers: ['Control'] });
    ok('E151 再 Ctrl＋點：取消那一張', await waitFor(async () => (await selN()) === 2 && (await win.textContent('#results .flag-sel .sel-n')) === '已選 2 筆'));
    await win.click('#results .flag-sel button.sel-move');
    const selPick = () => win.$$eval('#results .flag-sel .flag-pick button', bs => bs.map(b => b.textContent));
    ok('E151 換分類…：冒出分類鈕（沒有亮的）', await waitFor(async () => same(await selPick(), ['未分類', '未完', '等客戶', '要測', '＋ 新分類']))
      && (await win.$$('#results .flag-sel .flag-pick button.on')).length === 0, JSON.stringify(await selPick()));
    await win.locator('#results .flag-sel .flag-pick').getByRole('button', { name: '未完', exact: true }).click();
    ok('E151 點「未完」：選到的兩筆換過去、沒選的不動；做完不選了；提示筆數',
      await waitFor(() => readN(f151) === text151.replace('再說 [標記:等客戶]\n', '再說 [標記:未完]\n').replace('外面的丙 [標記]\n', '外面的丙 [標記:未完]\n') && readN(todayFile) === today151)
      && await waitFor(async () => (await selN()) === 0 && ((await win.textContent('#results .flag-sel')) || '').includes('Ctrl＋點卡片選好幾筆')) && await toastHas('已把 2 筆換到「未完」'),
      JSON.stringify(readN(f151)));
    await undoKey();
    ok('E151 Ctrl+Z：換分類前的樣子', await waitFor(same151) && await toastHas('已復原：換分類'));
    // 跨兩天一起取消標記，Ctrl+Z 一次兩天都回來
    await waitFor(async () => (await res151('外面的丙').count()) === 1);
    await res151('外面的丙').locator('.title').click({ modifiers: ['Control'] });
    await res(today, cm).locator('.title').click({ modifiers: ['Control'] });
    await waitFor(async () => (await selN()) === 2);
    await win.click('#results .flag-sel button.sel-unflag');
    ok('E151 跨兩天一起取消標記', await waitFor(() => readN(f151) === text151.replace('外面的丙 [標記]\n', '外面的丙\n')
      && readN(todayFile) === today151.replace(cm + ' [標記:等客戶]\n', cm + '\n')) && await toastHas('已取消標記 2 筆'));
    await undoKey();
    ok('E151 Ctrl+Z 一次：兩天都回來', await waitFor(same151));
    // Esc 取消選取；換篩選也不選了
    await waitFor(async () => (await res151('外面的甲').count()) === 1);
    await res151('外面的甲').locator('.title').click({ modifiers: ['Control'] });
    await waitFor(async () => (await selN()) === 1);
    await win.keyboard.press('Escape');
    ok('E151 Esc：取消選取', await waitFor(async () => (await selN()) === 0 && !(await win.isVisible('#results .flag-sel .sel-n').catch(() => false))));
    await res151('外面的甲').locator('.title').click({ modifiers: ['Control'] });
    await waitFor(async () => (await selN()) === 1);
    await win.click(filterBtn('等客戶'));
    ok('E151 換篩選：不選了', await waitFor(async () => (await selN()) === 0 && (await headTitle()) === '標記（等客戶）：2 筆'));
    await win.click(filterBtn('全部'));
    fs.rmSync(f151);
    await waitFor(async () => (await headTitle()) === `標記：${n123} 筆`);
    await win.click('#backBtn');
    await dayIs(today);

    // E30：黑暗模式（見 開發筆記 D034）
    // Playwright 連進來會把 prefers-color-scheme 固定成 light，蓋掉主程序 nativeTheme 的效果；先關掉，才驗得到主程序有沒有跟著切
    await win.emulateMedia({ colorScheme: null });
    const themeOf = () => win.evaluate(() => ({
      attr: document.documentElement.dataset.theme || null,
      bg: getComputedStyle(document.body).backgroundColor,
      sysDark: matchMedia('(prefers-color-scheme: dark)').matches,   // 主程序 nativeTheme 切了，這個才會跟著變
      saved: localStorage.getItem('daybook.theme'),
      btn: document.getElementById('themeBtn').textContent,
    }));
    const t0th = await themeOf();
    ok('E30 沒切過：不設 data-theme、跟系統；按鈕寫要切去的那個', t0th.attr === null && t0th.saved === null && t0th.btn === (t0th.sysDark ? '淺色模式' : '黑暗模式'), JSON.stringify(t0th));
    await win.click('#themeBtn');
    if ((await themeOf()).attr === 'light') await win.click('#themeBtn');   // 系統本來就是暗的：先切到亮，再切回暗
    const dark = await themeOf();
    ok('E30 切成暗：VS Code Dark+ 的底色、按鈕改寫「淺色模式」、記在這台電腦', dark.attr === 'dark' && dark.bg === 'rgb(30, 30, 30)' && dark.btn === '淺色模式' && dark.saved === 'dark',
      JSON.stringify(dark));
    ok('E30 主程序也切成暗（標題列跟著變）', await waitFor(async () => (await themeOf()).sysDark), JSON.stringify(await themeOf()));
    await win.reload();
    await win.waitForSelector('#dayList button');
    const reloaded = await themeOf();
    ok('E30 重新載入：一開始就是暗的', reloaded.attr === 'dark' && reloaded.bg === 'rgb(30, 30, 30)', JSON.stringify(reloaded));
    await win.click('#themeBtn');
    ok('E30 切回亮：原本的淺色底、主程序也切回亮', await waitFor(async () => { const t = await themeOf(); return t.attr === 'light' && t.bg === 'rgb(250, 250, 248)' && !t.sysDark && t.btn === '黑暗模式'; }),
      JSON.stringify(await themeOf()));

    // E31：匯出 Markdown（見 開發筆記 D035）——測試用 --export-dir，不跳存檔視窗
    const toast = () => win.textContent('#toast').catch(() => '');
    const dataBefore = snapshot(data);
    await viaSettings(win, '#exportBtn');
    const [ty, tm, td] = today.split('-').map(Number);
    const monday = localIso(new Date(ty, tm - 1, td - ((new Date(ty, tm - 1, td).getDay() + 6) % 7)));
    ok('E31 按「匯出…」出現起訖兩格，預設這週一到今天', (await win.isVisible('#exportBar')) && (await win.inputValue('#expFrom')) === monday && (await win.inputValue('#expTo')) === today,
      `${await win.inputValue('#expFrom')} ～ ${await win.inputValue('#expTo')}（應為 ${monday} ～ ${today}）`);
    // ‹ ›（D088）：起日那週的上一週／下一週，星期一～星期日，這週的話到今天；自己填的照起日那週換（跨年也是）
    const shift = (date, n) => { const [y, m, d] = date.split('-').map(Number); return localIso(new Date(y, m - 1, d + n)); };
    await win.click('#expPrev');
    ok('E31 ‹：上一週，星期一～星期日', await waitFor(async () => same(await expDates(), [shift(monday, -7), shift(monday, -1)])), JSON.stringify(await expDates()));
    await win.click('#expNext');
    ok('E31 ›：回到這週，到今天', await waitFor(async () => same(await expDates(), [monday, today])), JSON.stringify(await expDates()));
    await win.click('#expNext');
    ok('E31 再 ›：下一週，星期一～星期日', await waitFor(async () => same(await expDates(), [shift(monday, 7), shift(monday, 13)])), JSON.stringify(await expDates()));
    await win.fill('#expFrom', '2026-01-01');
    await win.click('#expPrev');
    ok('E31 自己填的起日（2026-01-01 星期四）按 ‹：那週的上一週 2025-12-22～12-28', await waitFor(async () => same(await expDates(), ['2025-12-22', '2025-12-28'])), JSON.stringify(await expDates()));
    // 格式的下拉選單（D078）：內建兩種，沒選過是第一個 daybook Markdown
    const fmtOpts = () => win.$$eval('#expFmt option', os => os.map(o => [o.value, o.textContent]));
    ok('E31 格式下拉選單：daybook Markdown、Excel，沒選過是 daybook Markdown', await waitFor(async () => (await fmtOpts()).length === 2)
      && same(await fmtOpts(), [['daybook-md', 'daybook Markdown（.md）'], ['xlsx', 'Excel（.xlsx）']]) && (await win.inputValue('#expFmt')) === 'daybook-md', JSON.stringify(await fmtOpts()));
    const expect = (title, from, to, withTodo) => {
      const src = readSources(data);
      return exp.toMarkdown({
        title,
        days: src.filter(s => s.src !== 'todo' && s.src >= from && s.src <= to).sort((a, b) => (a.src < b.src ? -1 : 1)).map(s => ({ date: s.src, text: s.text })),
        todo: withTodo ? src.find(s => s.src === 'todo').text : null,
      });
    };
    await win.fill('#expFrom', '2026-01-01');
    await win.fill('#expTo', '2026-01-31');
    await win.click('#expRange');
    const fRange = path.join(exportDir, '工作紀錄_2026-01-01_2026-01-31.md');
    ok('E31 匯出這段：寫出一份 Markdown，內容＝那段日子照 daybook-md.js 排出來的', await waitFor(() => readN(fRange) === expect('工作紀錄 2026-01-01 ～ 2026-01-31', '2026-01-01', '2026-01-31')),
      JSON.stringify(readN(fRange)));
    ok('E31 只有區間裡的日子', (readN(fRange) || '').includes('## 2026-01-22（四）') && !(readN(fRange) || '').includes('2026-09-11'), readN(fRange));
    ok('E31 跳提示寫存到哪', (await waitFor(async () => (await toast()).includes('已匯出'))) && (await toast()).includes(fRange), await toast());
    await win.fill('#expFrom', '2026-02-01');
    await win.fill('#expTo', '2026-01-01');
    await win.click('#expRange');
    ok('E31 起日晚於訖日：提示、不寫檔', await waitFor(async () => (await toast()).includes('起日不能晚於訖日')) && !fs.existsSync(path.join(exportDir, '工作紀錄_2026-02-01_2026-01-01.md')), await toast());
    await win.fill('#expFrom', '2026-03-01');
    await win.fill('#expTo', '2026-03-31');
    await win.click('#expRange');
    ok('E31 那段沒有紀錄：提示、不寫檔', await waitFor(async () => (await toast()).includes('沒有紀錄')) && !fs.existsSync(path.join(exportDir, '工作紀錄_2026-03-01_2026-03-31.md')), await toast());
    await win.click('#expAll');
    const fAll = path.join(exportDir, `工作紀錄_全部_${today}.md`);
    const days0 = readSources(data).filter(s => s.src !== 'todo').map(s => s.src).sort();
    ok('E31 匯出全部：從第一天到最後一天，最後接待處理', await waitFor(() => readN(fAll) === expect(`工作紀錄（全部） ${days0[0]} ～ ${days0[days0.length - 1]}`, '0000', '9999', true)),
      JSON.stringify(readN(fAll)));
    ok('E31 匯出全部有待處理', (readN(fAll) || '').includes('\n## 待處理\n'), readN(fAll));
    // 選 Excel 匯出 1 月：檔案＝xlsx.js 對磁碟上那幾天排出來的（同樣的紀錄一個 byte 都不差）；選過的記在這台電腦
    await win.selectOption('#expFmt', 'xlsx');
    await win.fill('#expFrom', '2026-01-01');
    await win.fill('#expTo', '2026-01-31');
    await win.click('#expRange');
    const fXl = path.join(exportDir, '工作紀錄_2026-01-01_2026-01-31.xlsx');
    const janDays = readSources(data).filter(s => s.src !== 'todo' && s.src >= '2026-01-01' && s.src <= '2026-01-31').sort((a, b) => (a.src < b.src ? -1 : 1)).map(s => ({ date: s.src, text: s.text }));
    const wantXl = Buffer.from(fmts.EXPORT_FORMATS.find(f => f.id === 'xlsx').write(fmts.exportData({ title: '工作紀錄 2026-01-01 ～ 2026-01-31',
      from: janDays[0].date, to: janDays[janDays.length - 1].date, all: false, days: janDays, todo: null })));
    ok('E31 選 Excel 匯出這段：寫出 .xlsx，內容＝xlsx.js 對那段日子排出來的', await waitFor(() => fs.existsSync(fXl) && fs.readFileSync(fXl).equals(wantXl)),
      fs.existsSync(fXl) ? `${fs.statSync(fXl).size} bytes，應為 ${wantXl.length}` : '沒有檔');
    ok('E31 Excel 跳提示寫存到哪', await waitFor(async () => (await toast()).includes(fXl)), await toast());
    await win.click('#expClose');
    await viaSettings(win, '#exportBtn');
    ok('E31 選過的格式記在這台電腦：收起來再打開還是 Excel', (await waitFor(async () => (await win.inputValue('#expFmt')) === 'xlsx'))
      && (await win.evaluate(() => localStorage.getItem('daybook.exportFormat'))) === 'xlsx', await win.inputValue('#expFmt'));
    await win.selectOption('#expFmt', 'daybook-md');
    ok('E31 匯出不動資料資料夾', same(snapshot(data), dataBefore));
    exported = { file: fAll, sources: readSources(data) };
    // 「匯出…」搬進齒輪「設定」（D098）：開著再按不會收起來、填的起訖照舊；收起來用匯出列最後的 ✕
    const open31 = await expDates();
    await viaSettings(win, '#exportBtn');
    ok('E31 開著再按選單的「匯出…」：還是開著、起訖照舊', await win.isVisible('#exportBar') && same(await expDates(), open31), JSON.stringify(await expDates()));
    await win.click('#expClose');
    ok('E31 按匯出列的 ✕ 收起來', await waitFor(async () => !(await win.isVisible('#exportBar'))));

    // E69：備份（見 開發筆記 D097）——齒輪「設定」的「備份…」：整個資料夾壓成一個 zip，測試用 --export-dir 不跳存檔視窗。
    // 拿 Windows 自己的解壓來解（.NET 的 Expand-Archive、檔案總管的 Shell.Application），不是拿 backup.js 自己解
    {
    const before69 = snapshot(data);
    const had = new Set(fs.readdirSync(exportDir));
    await viaSettings(win, '#backupBtn');
    const zipName = await waitFor(() => fs.readdirSync(exportDir).find(f => !had.has(f)));
    ok('E69 寫出 daybook備份_今天_時分.zip', /^daybook備份_\d{4}-\d{2}-\d{2}_\d{4}\.zip$/.test(zipName || '') && zipName.startsWith(`daybook備份_${today}_`), JSON.stringify(zipName));
    if (zipName) {
      const zf = path.join(exportDir, zipName);
      ok('E69 跳提示寫存到哪、選單收起來', await waitFor(async () => (await toast()).includes('已備份：' + zf)) && await win.evaluate(() => document.getElementById('settingsMenu').hidden), await toast());
      const files = Object.keys(before69).sort();
      // 每一個本地檔頭的壓縮方法：8＝deflate
      const buf = fs.readFileSync(zf), methods = [];
      for (let at = 0; buf.readUInt32LE(at) === 0x04034b50; at += 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28) + buf.readUInt32LE(at + 18)) methods.push(buf.readUInt16LE(at + 8));
      ok('E69 每個檔都有壓縮（deflate）', methods.length === files.length && methods.every(m => m === 8), JSON.stringify(methods));
      const un = path.join(tmpRoot, 'backup-unzip');
      const ps = cmd => powershell('[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + cmd, { ZF: zf, UN: un }).toString('utf8');
      ps('Expand-Archive -LiteralPath $env:ZF -DestinationPath $env:UN');
      const got = Object.keys(snapshot(un) || {}).sort();
      ok('E69 Expand-Archive 解開來：檔名（中文、子資料夾）跟資料夾裡的一樣、內容一個 byte 都不差',
        same(got, files) && files.every(f => fs.readFileSync(path.join(un, f)).equals(fs.readFileSync(path.join(data, f)))), JSON.stringify({ got, files }));
      ok('E69 解開來的修改時間跟原檔差不到 2 秒', got.length && got.every(f => Math.abs(fs.statSync(path.join(un, f)).mtimeMs - fs.statSync(path.join(data, f)).mtimeMs) < 2000),
        JSON.stringify(got.map(f => [f, fs.statSync(path.join(un, f)).mtime, fs.statSync(path.join(data, f)).mtime])));
      const shown = ps('$z = (New-Object -ComObject Shell.Application).NameSpace($env:ZF); '
        + 'function walk($ns) { foreach ($i in $ns.Items()) { if ($i.IsFolder) { walk $i.GetFolder } else { $i.Path.Substring($env:ZF.Length + 1) } } }; walk $z')
        .split(/\r?\n/).filter(Boolean).sort();
      ok('E69 檔案總管看到的檔名跟資料夾裡的一樣', same(shown, files), JSON.stringify({ shown, files }));
    }
    ok('E69 備份不動資料資料夾', same(snapshot(data), before69));
    }

    // E32：日期區的日曆模式（見 開發筆記 D036）——這時看的是今天（E30 重新載入過）
    const cal = () => win.evaluate(() => ({
      title: document.getElementById('calTitle').textContent,
      wd: [...document.querySelectorAll('#calGrid .wd')].map(e => e.textContent).join(''),
      lead: [...document.getElementById('calGrid').children].filter(e => !e.classList.contains('wd')).findIndex(e => e.tagName === 'BUTTON'),
      has: [...document.querySelectorAll('#calGrid button.has')].map(e => e.dataset.date),
      on: [...document.querySelectorAll('#calGrid button.on')].map(e => e.dataset.date),
      today: [...document.querySelectorAll('#calGrid button.today')].map(e => e.dataset.date),
    }));
    const calDay = d => `#calGrid button[data-date="${d}"]`;
    await win.click('#viewCal');
    const c0 = await cal();
    const lead0 = (new Date(ty, tm - 1, 1).getDay() + 6) % 7;
    ok('E32 切成日曆：清單收起來、日曆出現、記在這台電腦', (await win.isVisible('#calendar')) && !(await win.isVisible('#dayList'))
      && (await win.evaluate(() => localStorage.getItem('daybook.dayView'))) === 'cal');
    ok('E32 打開是正在看的那天的月份，一週從星期一開始、1 號放對格', c0.title === today.slice(0, 7) && c0.wd === '一二三四五六日' && c0.lead === lead0,
      JSON.stringify(c0) + `（1 號前應空 ${lead0} 格）`);
    ok('E32 今天：框起來、正在看、有紀錄', same(c0.today, [today]) && same(c0.on, [today]) && c0.has.includes(today), JSON.stringify(c0));
    // 翻到 2026-09：fixture 只有 9/11 有紀錄
    const back = (ty - 2026) * 12 + tm - 9;
    for (let i = 0; i < back; i++) await win.click('#calPrev');
    ok('E32 ‹ 翻到上個月；有紀錄的才有點', await waitFor(async () => { const c = await cal(); return c.title === '2026-09' && same(c.has, ['2026-09-11']); }), JSON.stringify(await cal()));
    ok('E32 翻月份不換正在看的那天', (await headTitle()).includes(today), await headTitle());
    await win.click(calDay('2026-09-11'));
    ok('E32 點有紀錄的日子：打開那天、日曆上亮起來', await waitFor(async () => (await headTitle()).startsWith('2026-09-11') && same((await cal()).on, ['2026-09-11'])), await headTitle());
    const f0910 = path.join(data, dayPath('2026-09-10'));
    await win.click(calDay('2026-09-10'));
    ok('E32 點沒紀錄的日子：也能打開（空的，可以補記）', await waitFor(async () => (await headTitle()).startsWith('2026-09-10') && same(await doneTitles(), [])), await headTitle());
    ok('E32 只是打開不會產生檔案', !fs.existsSync(f0910));
    await win.click('#dayTitle');
    await win.keyboard.press('Alt+ArrowLeft');
    ok('E32 Alt+← 換到 1 月的日子，日曆跟著翻過去', await waitFor(async () => (await headTitle()).startsWith('2026-01-22') && (await cal()).title === '2026-01'), JSON.stringify(await cal()));
    await win.click('#calNext');
    await win.click(calDay('2026-02-03'));
    await win.fill('#newTitle', '日曆補記的');
    await win.press('#newTitle', 'Control+Shift+Enter');
    const f0203 = path.join(data, dayPath('2026-02-03'));
    ok('E32 在沒紀錄的日子補記：寫進那天的檔、日曆上出現點', await waitFor(() => readN(f0203) === '日曆補記的\n') && await waitFor(async () => (await cal()).has.includes('2026-02-03')),
      JSON.stringify(readN(f0203)));
    await win.reload();
    await win.waitForSelector('#dayList button', { state: 'attached' });
    ok('E32 重新載入還是日曆', await waitFor(async () => (await win.isVisible('#calendar')) && !(await win.isVisible('#dayList'))));
    await win.click('#viewList');
    ok('E32 切回清單', await waitFor(async () => (await win.isVisible('#dayList')) && !(await win.isVisible('#calendar'))) && (await win.evaluate(() => localStorage.getItem('daybook.dayView'))) === 'list');

    // E33：底部狀態列跟著游標換快捷鍵說明、F1 全部快捷鍵（見 開發筆記 D037）
    const status = () => win.textContent('#statusKeys');
    const statusHas = (...ws) => waitFor(async () => { const s = await status(); return ws.every(w => s.includes(w)); });
    ok('E33 表單底下那行提示拿掉了', (await win.$$('#newForm .hint')).length === 0);
    ok('E33 狀態列 VS Code 的藍底', (await win.evaluate(() => getComputedStyle(document.getElementById('statusBar')).backgroundColor)) === 'rgb(0, 122, 204)');
    await win.click('#dayTitle');
    ok('E33 游標不在輸入框：寫到處都能按的', await statusHas('Ctrl+F', 'Alt+Home', 'Ctrl+Z'), await status());
    await win.focus('#newTitle');
    ok('E33 游標在標題：寫新增表單的', await statusHas('帶入提示', '換到內文', 'Ctrl+Shift+Enter'), await status());
    await win.focus('#newBody');
    ok('E33 游標在內文：寫縮排', await statusHas('縮排', 'Ctrl+Enter'), await status());
    await win.focus('#q');
    ok('E33 游標在搜尋框：寫 Enter、Esc', await statusHas('搜尋', 'Esc'), await status());
    await cardOf('todo', '週報').locator('button.upd').click();
    ok('E33 游標在 + 更新的框：寫存、取消', await statusHas('存', '取消'), await status());
    await cardOf('todo', '週報').locator('.upd-text').press('Escape');
    await cardOf('todo', '週報').locator('button.edit').click();
    ok('E33 編輯卡片：寫 Ctrl+Enter 儲存', await statusHas('Ctrl+Enter', '儲存'), await status());
    await win.locator('.card.editing button.cancel').click();
    await win.click('#dayTitle');
    ok('E33 離開輸入框：換回到處都能按的', await statusHas('Ctrl+F', 'Alt+Home'), await status());

    // E111：卡片編輯中（見 開發筆記 D140）——存不進去時編輯框留著、打的字還在；要換日、按別張卡片的動作先問，取消就留在原地、放棄才做
    {
      const todoBefore = readN(todoFile);
      const editing = async () => (await win.$$('.card.editing')).length === 1;
      await cardOf('todo', '週報').locator('button.edit').click();
      await win.locator('.card.editing .edit-title').fill('1. 準備簡報');
      await win.locator('.card.editing .edit-body').fill('改了一大段');
      await win.locator('.card.editing button.save').click();
      ok('E111 存不進去（標題「數字＋.」開頭）：提示、編輯框留著、打的字還在、檔案沒動',
        await waitFor(async () => ((await win.textContent('#toast')) || '').includes('標題不能用'))
        && await editing() && (await win.inputValue('.card.editing .edit-title')) === '1. 準備簡報'
        && (await win.inputValue('.card.editing .edit-body')) === '改了一大段' && readN(todoFile) === todoBefore, await win.textContent('#toast'));
      const cur = (await headTitle()).slice(0, 10);
      const other = (await win.$$eval('#dayList button[data-date]', bs => bs.map(b => b.dataset.date))).find(d => d !== cur);
      const asking = () => win.isVisible('#editAsk');
      await win.click(`#dayList button[data-date="${other}"]`);
      ok('E111 編輯中點別天：畫面上跳框問要不要放棄（不是原生的詢問視窗）、游標在「取消」',
        await waitFor(asking) && (await win.textContent('#editAskMsg')).includes('有卡片在編輯') && (await win.evaluate(() => document.activeElement.id)) === 'editAskCancel' && dialogs === 0);
      await win.click('#editAskCancel');
      await sleep(300);
      ok('E111 按取消：框收掉、留在原地、編輯框和打的字都還在', !(await asking()) && (await headTitle()).startsWith(cur) && await editing()
        && (await win.inputValue('.card.editing .edit-body')) === '改了一大段', await headTitle());
      await win.locator('#todoCards .card:not(.editing):not(.is-hidden) button.wait').first().click();
      await waitFor(asking);
      await win.keyboard.press('Escape');
      await sleep(300);
      ok('E111 編輯中按別張卡片的「待回覆」：也先問；Esc＝取消，不寫檔、編輯框還在', !(await asking()) && readN(todoFile) === todoBefore && await editing(),
        JSON.stringify(readN(todoFile)));
      await win.click(`#dayList button[data-date="${other}"]`);
      await waitFor(asking);
      await win.click('#editAskDrop');
      ok('E111 按放棄：換到那天、編輯框收掉、檔案沒動', await waitFor(async () => (await headTitle()).startsWith(other) && (await win.$$('.card.editing')).length === 0)
        && readN(todoFile) === todoBefore, await headTitle());
      await win.click(`#dayList button[data-date="${cur}"]`);
      await waitFor(async () => (await headTitle()).startsWith(cur));
    }
    // E135：卡片編輯中，別的入口也不洗掉打到一半的字（見 開發筆記 D140、D174）——別的區塊出錯（剪貼簿存空的）不重畫正在編輯的卡片；
    // 點「標記」「回顧」先問；搜尋時按放棄、回到那天不再問一次；編輯中按別張的「編輯」先問，放棄就換成編輯那張。每一步自己收尾，前一步沒過不連累下一步
    {
      const asking = () => win.isVisible('#editAsk');
      const editingN = async () => (await win.$$('.card.editing')).length;
      const bodyNow = () => win.inputValue('.card.editing .edit-body').catch(() => null);
      const cur = (await headTitle()).slice(0, 10);
      const startEdit = async text => {
        await cardOf('todo', '週報').locator('button.edit').click();
        await win.locator('.card.editing .edit-body').fill(text);
      };
      const reset = async () => {
        if (await asking()) await win.click('#editAskDrop');
        await win.evaluate(() => document.querySelector('.card.editing button.cancel')?.click());
        await sleep(300);
        if (await asking()) await win.click('#editAskDrop');
        await win.click(`#dayList button[data-date="${cur}"]`);
        if (await waitFor(asking, 500)) await win.click('#editAskDrop');
        await waitFor(async () => (await headTitle()).startsWith(cur) && (await editingN()) === 0);
      };
      await startEdit('打到一半 E135');
      await win.click('#actSnip');
      await win.click('#snipAdd');
      await win.evaluate(() => { document.getElementById('toast').textContent = ''; });
      await win.click('.snip.editing button.save');   // 兩格都空的：存不進去（剪貼簿那邊出錯）
      await waitFor(async () => ((await toast()) || '').length > 0);
      await sleep(400);
      ok('E135 卡片編輯中，剪貼簿存空的出錯：提示錯誤，正在編輯的卡片和打的字還在', (await editingN()) === 1 && (await bodyNow()) === '打到一半 E135',
        JSON.stringify({ toast: await toast(), editing: await editingN(), body: await bodyNow() }));
      await win.evaluate(() => document.querySelector('.snip.editing button.cancel')?.click());
      await win.click('#actJournal');
      await reset();
      for (const [btn, name] of [['#flagList', '標記'], ['#rangeBtn', '回顧']]) {
        await startEdit('打到一半 ' + name);
        await win.click(btn);
        const asked = await waitFor(asking, 1500);
        ok(`E135 卡片編輯中點「${name}」：先問要不要放棄`, !!asked, await headTitle());
        if (asked) {
          await win.click('#editAskCancel');
          await sleep(300);
          ok(`E135 「${name}」按取消：留在那天、編輯框和打的字都還在`, (await headTitle()).startsWith(cur) && (await editingN()) === 1 && (await bodyNow()) === '打到一半 ' + name,
            await headTitle());
        }
        await reset();
      }
      await startEdit('打到一半 搜尋');
      await win.evaluate(() => { showSearch('週報'); });   // 直接叫：從搜尋框按 Enter 會記進搜過的（之後的自動補完案例要用）
      await waitFor(asking);
      await win.click('#editAskDrop');
      await waitFor(async () => (await headTitle()).startsWith('搜尋'));
      await win.click('#backBtn');
      const again = await waitFor(asking, 800);
      ok('E135 搜尋時按放棄、再回到那天：不再問一次（放棄的那張不算在編輯）', !again && await waitFor(async () => (await headTitle()).startsWith(cur) && (await editingN()) === 0),
        JSON.stringify({ again, title: await headTitle() }));
      await reset();
      await startEdit('打到一半 A');
      const other = win.locator('#todoCards .card:not(.editing):not(.is-hidden)', { has: win.locator('button.edit') }).first();
      const otherTitle = await other.locator('.title').textContent();
      await other.locator('button.edit').click();
      const asked = await waitFor(asking, 1500);
      ok('E135 編輯中按別張的「編輯」：先問要不要放棄，不會同時開兩張', !!asked && (await editingN()) === 1, String(await editingN()));
      if (asked) {
        await win.click('#editAskDrop');
        ok('E135 按放棄：原本那張收掉，換成編輯按的那張', await waitFor(async () => (await editingN()) === 1 && (await win.inputValue('.card.editing .edit-title').catch(() => '')) === otherTitle),
          JSON.stringify({ editing: await editingN(), want: otherTitle }));
      }
      await reset();
      // 編輯中在別張已處理的「標記」→「＋ 新分類」打名稱按 Enter：先問；取消就不寫進 標記分類.json（D174〈後續〉）
      const catsFile = path.join(data, FLAG_CATS_FILE), catsBefore = readN(catsFile);
      await startEdit('打到一半 新分類');
      const done = win.locator('#cards .card:not(.editing)', { has: win.locator('button.flag') }).first();
      await done.locator('button.flag').click();
      await done.locator('.flag-pick button.cat-add').click();
      await done.locator('.flag-pick input.cat-new').fill('E135新分類');
      await done.locator('.flag-pick input.cat-new').press('Enter');
      const askedCat = await waitFor(asking, 1500);
      if (askedCat) await win.click('#editAskCancel');
      await sleep(400);
      ok('E135 編輯中加新分類：先問，取消就不寫進 標記分類.json、打的字還在', !!askedCat && readN(catsFile) === catsBefore && (await bodyNow()) === '打到一半 新分類',
        JSON.stringify({ asked: askedCat, cats: readN(catsFile) }));
      if (readN(catsFile) !== catsBefore) { if (catsBefore == null) fs.rmSync(catsFile, { force: true }); else fs.writeFileSync(catsFile, catsBefore); }   // 沒擋住：放回去，不連累後面
      await reset();
    }
    await win.keyboard.press('F1');
    ok('E33 F1 打開全部快捷鍵', await waitFor(async () => win.isVisible('#help')) && (await win.textContent('#help')).includes('Ctrl+='));
    await win.keyboard.press('F1');
    ok('E33 再按 F1 關掉', await waitFor(async () => !(await win.isVisible('#help'))));
    await win.fill('#q', '還在');
    await win.press('#q', 'F1');
    await waitFor(async () => win.isVisible('#help'));
    await win.press('#q', 'Escape');
    ok('E33 Esc 關掉；搜尋框的字不會被一起清掉', await waitFor(async () => !(await win.isVisible('#help'))) && (await win.inputValue('#q')) === '還在', await win.inputValue('#q'));
    await win.fill('#q', '');
    await win.click('#helpBtn');
    ok('E33 點狀態列的「F1 全部快捷鍵」也能打開', await waitFor(async () => win.isVisible('#help')));
    await win.mouse.click(5, 60);   // 標題列（35px，D100）底下的背景
    ok('E33 點外面關掉', await waitFor(async () => !(await win.isVisible('#help'))));

    // E122：F1 的分頁（見 開發筆記 D156）——通用＋照頁籤列一頁一個；先停在正在用的那頁（游標在日記的搜尋框：日記本）、一次只看得到一頁；
    // ←→ 換頁（到頭接另一頭）、框的高度每頁一樣、不用捲；游標在後面的搜尋框時 ←→ 不會動到那裡的游標；點分頁也能換
    {
      const helpOf = () => win.evaluate(() => {
        const box = document.querySelector('#help .helpBox');
        return {
          tabs: [...document.querySelectorAll('#helpTabs button')].filter(b => b.offsetParent).map(b => b.dataset.page),
          on: [...document.querySelectorAll('#helpTabs button[aria-selected="true"]')].map(b => b.dataset.page).join(),
          shown: [...document.querySelectorAll('#helpPages .helpPage')].filter(p => p.getClientRects().length && getComputedStyle(p).visibility === 'visible').map(p => p.dataset.page).join(),
          h: Math.round(box.getBoundingClientRect().height), scroll: box.scrollHeight > box.clientHeight + 1,
        };
      });
      await win.fill('#q', '還在');
      await win.evaluate(() => document.getElementById('q').setSelectionRange(0, 0));   // 從 0 開始：→ 六下、← 一下沒攔的話停在 1（從 1 開始會剛好回到 1）
      await win.press('#q', 'F1');
      await waitFor(async () => win.isVisible('#help'));
      const first = await helpOf();
      ok('E122 F1 打開：分頁照預設的順序（通用在最前面）、停在日記本、只看得到日記本那頁',
        same(first.tabs, ['common', 'journal', 'snip', 'note', 'md', 'shot', 'launch']) && first.on === 'journal' && first.shown === 'journal', JSON.stringify(first));
      const seq = [];
      for (let i = 0; i < 6; i++) { await win.keyboard.press('ArrowRight'); seq.push(await helpOf()); }
      await win.keyboard.press('ArrowLeft');
      seq.push(await helpOf());
      ok('E122 → 一頁一頁往右、最後一頁再按回到通用；在通用按 ← 到最後一頁；每次都只看得到選到的那頁',
        same(seq.map(s => s.on), ['snip', 'note', 'md', 'shot', 'launch', 'common', 'launch']) && seq.every(s => s.shown === s.on), JSON.stringify(seq.map(s => [s.on, s.shown])));
      ok('E122 換頁時框的高度都一樣、不用捲', [first, ...seq].every(s => s.h === first.h && !s.scroll), JSON.stringify([first, ...seq].map(s => [s.on, s.h, s.scroll])));
      ok('E122 ←→ 沒動到後面搜尋框的游標', (await win.evaluate(() => document.getElementById('q').selectionStart)) === 0 && (await win.inputValue('#q')) === '還在',
        await win.evaluate(() => document.getElementById('q').selectionStart));
      await win.click('#helpTabs [data-page="note"]');
      const clicked = await helpOf();
      ok('E122 點「記事本」分頁：換到記事本那頁', clicked.on === 'note' && clicked.shown === 'note', JSON.stringify(clicked));
      await win.keyboard.press('ArrowRight');
      ok('E122 點過分頁再按 →：換到下一頁，游標跟著到那顆分頁鈕', (await helpOf()).on === 'md'
        && (await win.evaluate(() => document.activeElement.dataset.page)) === 'md', await win.evaluate(() => document.activeElement.outerHTML.slice(0, 80)));
      await win.keyboard.press('Escape');
      await waitFor(async () => !(await win.isVisible('#help')));
      await win.fill('#q', '');
    }

    // E36：整個畫面縮放（見 開發筆記 D042）——比 devicePixelRatio（螢幕本身的縮放先除掉）
    const zoomOf = () => win.evaluate(() => ({ dpr: devicePixelRatio, btn: document.getElementById('zoomBtn').textContent, saved: localStorage.getItem('daybook.zoom') }));
    const base = (await zoomOf()).dpr;
    const zoomIs = (f, label) => waitFor(async () => { const z = await zoomOf(); return Math.abs(z.dpr / base - f) < 0.01 && z.btn === label; });
    ok('E36 一開始 100%', (await zoomOf()).btn === '100%', JSON.stringify(await zoomOf()));
    await win.click('#dayTitle');
    await win.keyboard.press('Control+Equal');
    ok('E36 Ctrl+=（不用按 Shift）放大一級、記在這台電腦', await zoomIs(1.1, '110%') && (await zoomOf()).saved === '1.1', JSON.stringify(await zoomOf()));
    await win.keyboard.press('Control+Minus');
    await win.keyboard.press('Control+Minus');
    ok('E36 Ctrl+- 兩次：90%', await zoomIs(0.9, '90%'), JSON.stringify(await zoomOf()));
    await win.keyboard.press('Control+0');
    ok('E36 Ctrl+0 還原', await zoomIs(1, '100%'), JSON.stringify(await zoomOf()));
    await win.mouse.move(700, 300);
    await win.keyboard.down('Control');
    await win.mouse.wheel(0, -100);
    await win.keyboard.up('Control');
    ok('E36 Ctrl＋滾輪往上一格：放大一級', await zoomIs(1.1, '110%'), JSON.stringify(await zoomOf()));
    await win.keyboard.down('Control');
    await win.mouse.wheel(0, 40);
    await win.mouse.wheel(0, 40);
    await sleep(200);
    const mid = await zoomOf();
    await win.mouse.wheel(0, 40);
    await win.keyboard.up('Control');
    ok('E36 觸控板那種小幅度：累積到一格才跳一級', Math.abs(mid.dpr / base - 1.1) < 0.01 && await zoomIs(1, '100%'), `${JSON.stringify(mid)} → ${JSON.stringify(await zoomOf())}`);
    await win.mouse.wheel(0, 100);
    await sleep(200);
    ok('E36 沒按 Ctrl 的滾輪不縮放', Math.abs((await zoomOf()).dpr / base - 1) < 0.01);
    // E71：標題列自己畫（見 開發筆記 D100）——貼頂、35px（CSS px × 縮放比例），縮放時不跟著變；說明頁的背景接在標題列底下
    const titleBarOf = () => win.evaluate(() => {
      const t = document.getElementById('titleBar').getBoundingClientRect();
      const h = document.getElementById('help');
      h.hidden = false;
      const helpTop = h.getBoundingClientRect().top;
      h.hidden = true;
      return { top: t.top, h: t.height, bottom: t.bottom, helpTop };
    });
    const titleBarIs = f => waitFor(async () => { const t = await titleBarOf(); return t.top === 0 && Math.abs(t.h * f - 35) < 0.5 && Math.abs(t.helpTop - t.bottom) < 0.5; });
    await win.keyboard.press('Control+Equal');
    await win.keyboard.press('Control+Equal');
    await zoomIs(1.25, '125%');
    ok('E71 縮放 125%：標題列還是 35px', await titleBarIs(1.25), JSON.stringify(await titleBarOf()));
    await win.reload();
    await win.waitForSelector('#dayList button');
    ok('E36 重新載入記得上次的大小', await zoomIs(1.25, '125%'), JSON.stringify(await zoomOf()));
    ok('E71 重新載入（theme.js 套上縮放）：標題列還是 35px', await titleBarIs(1.25), JSON.stringify(await titleBarOf()));
    await win.click('#zoomBtn');
    ok('E36 點狀態列的比例：還原 100%', await zoomIs(1, '100%'), JSON.stringify(await zoomOf()));
    const tb = await win.evaluate(() => {
      const t = document.getElementById('titleBar');
      const row = document.querySelector('#newForm .row').getBoundingClientRect();
      const r = document.documentElement, t0 = r.dataset.theme, bg = () => getComputedStyle(t).backgroundColor;
      r.dataset.theme = 'light';
      const light = bg();
      r.dataset.theme = 'dark';
      const dark = bg();
      if (t0) r.dataset.theme = t0; else delete r.dataset.theme;
      return { text: t.textContent, drag: getComputedStyle(t).getPropertyValue('app-region'), light, dark, rowL: row.left, rowW: row.width, todoL: document.getElementById('addTodo').getBoundingClientRect().left };
    });
    ok('E71 100%：標題列 35px、寫「daybook 版本號」、拖得動', await titleBarIs(1) && tb.text === `daybook ${version}` && tb.drag === 'drag', JSON.stringify({ ...tb, ...(await titleBarOf()) }));
    ok('E71 標題列淺色 #f8f8f8、暗色 #3c3c3c（VS Code 的 titleBar）', tb.light === 'rgb(248, 248, 248)' && tb.dark === 'rgb(60, 60, 60)', JSON.stringify(tb));
    ok('E71 輸入區的兩顆按鈕靠左', tb.rowW > 0 && tb.todoL === tb.rowL, JSON.stringify(tb));

    // E40：右上角「說明」的「檔案放在哪」（見 開發筆記 D048、D049）——路徑是這台電腦實際的；
    // 給拿到 exe 的人看：可攜版、安裝版兩格都列，npm start 開時兩格都不標「你現在用的」、照一般位置寫，沒有開發用的字
    const fText = id => win.textContent('#' + id).catch(() => '');
    const shown = sel => win.isVisible(sel).catch(() => false);
    const missing = id => win.$eval('#' + id, e => e.hasAttribute('data-missing')).catch(() => null);
    ok('E40 右上角有「說明」', (await fText('infoBtn')) === '說明', await fText('infoBtn'));
    await win.click('#infoBtn');
    ok('E40 按「說明」打開，有「檔案放在哪」', await waitFor(() => shown('#info')) && (await win.textContent('#info h3')) === '檔案放在哪');
    ok('E40 紀錄＝資料資料夾、設定與快取＝這次的 Chromium 使用者資料，都沒標「目前沒有」',
      (await fText('fData')) === data && (await fText('fUserData')) === devProfile(data) && !(await missing('fData')) && !(await missing('fUserData')),
      JSON.stringify([await fText('fData'), await fText('fUserData')]));
    ok('E40 不列匯出的檔（位置是存檔視窗自己選的）', !(await win.textContent('#info')).includes('匯出'));
    ok('E40 「匯入格式」那段搬到右上角「匯入格式」頁了，說明頁沒有（D056）', (await win.$$('#info #extTable, #info #aiReply')).length === 0
      && !(await win.$$eval('#info h3', hs => hs.map(h => h.textContent))).includes('匯入格式'), JSON.stringify(await win.$$eval('#info h3', hs => hs.map(h => h.textContent))));
    ok('E40 可攜版、安裝版兩格都列，都沒標「你現在用的」', (await shown('#fPortable')) && (await shown('#fInstalled')) && !(await shown('#fPortableNow')) && !(await shown('#fInstalledNow')));
    ok('E40 可攜版不是正在用的：exe 寫說明、解壓的位置寫暫存區＋說明', (await fText('fPortable')) === 'exe 放在哪就在哪' && (await fText('fUnpack')).endsWith('\\<每一版不同的名稱>'),
      JSON.stringify([await fText('fPortable'), await fText('fUnpack')]));
    const local = process.env.LOCALAPPDATA || '';
    const installDir = path.join(local, 'Programs', 'daybook'), updaterDir = path.join(local, 'daybook-updater');
    ok('E40 安裝版寫預設位置、安裝程式的備份寫實際位置；沒有的標「目前沒有」（跟這台電腦一致）',
      (await fText('fInstalled')) === installDir && (await missing('fInstalled')) === !fs.existsSync(installDir)
      && (await fText('fUpdater')) === updaterDir && (await missing('fUpdater')) === !fs.existsSync(updaterDir),
      JSON.stringify([await fText('fInstalled'), await fText('fUpdater')]));
    ok('E40 完全移除的步驟寫出解除安裝留下的暫存複本（暫存區實際的位置）', (await fText('fNsu')).endsWith('\\~nsu.tmp\\Un_A.exe') && (await fText('fNsu')).includes(':\\'), await fText('fNsu'));
    // 開啟位置（見 開發筆記 D051）：--open-log 下不真的開檔案總管，把路徑寫進 openLog
    const openBtn = k => `#info .openBtn[data-open="${k}"]`;
    const lastOpened = () => (readN(openLog) || '').trim().split('\n').pop();
    const clickOpen = async k => { await win.click(openBtn(k)); return waitFor(() => fs.existsSync(openLog) && lastOpened()); };
    await clickOpen('data');
    ok('E40 紀錄的「開啟位置」打開資料資料夾', lastOpened() === data, lastOpened());
    await clickOpen('userData');
    ok('E40 設定與快取的「開啟位置」打開 Chromium 使用者資料', lastOpened() === devProfile(data), lastOpened());
    await clickOpen('unpack');
    ok('E40 不是可攜版時，解壓那格的「開啟位置」打開暫存區', lastOpened() === (await fText('fUnpack')).replace('\\<每一版不同的名稱>', ''), lastOpened());
    ok('E40 不是可攜版時，可攜版 exe 沒有「開啟位置」', !(await shown(openBtn('portableExe'))));
    const disabled = k => win.$eval(openBtn(k), b => b.disabled);
    const nsuFile = await fText('fNsu');
    ok('E40 位置目前沒有的「開啟位置」變灰（安裝版、備份、Un_A.exe 跟這台電腦一致）',
      (await disabled('installed')) === !fs.existsSync(installDir) && (await disabled('updater')) === !fs.existsSync(updaterDir) && (await disabled('nsu')) === !fs.existsSync(nsuFile)
      && !(await disabled('data')) && !(await disabled('userData')) && !(await disabled('unpack')));
    const infoText = await win.textContent('#info');
    ok('E40 頁面上沒有開發用的字', !/npm start|--data-dir|win-unpacked|開發/.test(infoText), (infoText.match(/npm start|--data-dir|win-unpacked|開發/) || [])[0]);
    await win.keyboard.press('Escape');
    ok('E40 Esc 關掉', await waitFor(async () => !(await shown('#info'))));
    await win.click('#infoBtn');
    await waitFor(() => shown('#info'));
    await win.mouse.click(5, 60);   // 標題列（35px，D100）底下的背景
    ok('E40 點外面關掉', await waitFor(async () => !(await shown('#info'))));
    await win.click('#infoBtn');
    await waitFor(() => shown('#info'));
    await win.click('#infoClose');
    ok('E40 按 ✕ 關掉', await waitFor(async () => !(await shown('#info'))));

    // E37：齒輪「設定」的「匯入…」（見 開發筆記 D044；原本在左下角，D098 搬進設定）——sample.md 有 6 天，其中 1/15、1/22、9/11 資料夾裡已經有了；啟動帶了 --existing 略過（D063）
    const sampleDays = exp.parse(readN(SAMPLE)).days;
    const newDays = ['2025-12-29', '2025-12-31', '2026-08-04'];
    const oldDays = ['2026-01-15', '2026-01-22', '2026-09-11'];
    const oldText = Object.fromEntries(oldDays.map(d => [d, readN(path.join(data, dayPath(d)))]));
    ok('E37 前提：那 3 天原本沒有、另 3 天原本有', newDays.every(d => !fs.existsSync(path.join(data, dayPath(d)))) && oldDays.every(d => oldText[d]));
    await viaSettings(win, '#importBtn');
    ok('E37 沒有的日子寫進來，內容＝拆出來的那天', await waitFor(() => newDays.every(d => readN(path.join(data, dayPath(d))) === sampleDays.find(x => x.date === d).text)),
      newDays.map(d => JSON.stringify(readN(path.join(data, dayPath(d))))).join('\n'));
    ok('E37 已經有的日子不動', oldDays.every(d => readN(path.join(data, dayPath(d))) === oldText[d]));
    ok('E37 提示寫匯了幾天、認成哪種格式、跳過哪幾天', await waitFor(async () => { const t = await toast(); return t.includes('匯入 3 天（daybook Markdown）') && t.includes('跳過 3 天') && t.includes('01-15'); }), await toast());
    ok('E37 左邊日期清單出現匯進來的日子', await waitFor(async () => (await win.$$(`#dayList button[data-date="2025-12-29"]`)).length === 1));
    await win.click('#dayTitle');
    await win.keyboard.press('Control+Z');
    ok('E37 Ctrl+Z 整批復原：匯進來的 3 天都拿掉、原本的不動', await waitFor(() => newDays.every(d => !fs.existsSync(path.join(data, dayPath(d)))))
      && oldDays.every(d => readN(path.join(data, dayPath(d))) === oldText[d]), await toast());
    // E135（匯入）：卡片編輯中點「匯入…」先問（見 開發筆記 D140、D174）；取消就不匯、編輯框和打的字還在
    {
      const asking = () => win.isVisible('#editAsk');
      const imported = () => newDays.some(d => fs.existsSync(path.join(data, dayPath(d))));
      await cardOf('todo', '週報').locator('button.edit').click();
      await win.locator('.card.editing .edit-body').fill('打到一半 匯入');
      await viaSettings(win, '#importBtn');
      const asked = await waitFor(asking, 1500);
      ok('E135 卡片編輯中點「匯入…」：先問要不要放棄', !!asked);
      if (asked) await win.click('#editAskCancel');
      await sleep(500);
      ok('E135 「匯入…」按取消：沒匯進來、編輯框和打的字還在', !imported() && (await win.$$('.card.editing')).length === 1
        && (await win.inputValue('.card.editing .edit-body').catch(() => '')) === '打到一半 匯入', JSON.stringify({ imported: imported(), editing: (await win.$$('.card.editing')).length }));
      if (imported()) {   // 沒問就匯進來了：整批復原，不連累後面的案例
        await win.click('#dayTitle');
        await win.keyboard.press('Control+Z');
        await waitFor(() => !imported());
      }
      await win.evaluate(() => document.querySelector('.card.editing button.cancel')?.click());
      await waitFor(async () => (await win.$$('.card.editing')).length === 0);
    }

    // E26：只能開一個視窗（見 開發筆記 D030）——同一個資料資料夾再開一次，第二個要自己結束，第一個照常
    const t0 = Date.now();
    const second = spawn(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, '--data-dir', data], { stdio: 'ignore' });
    const exited = await Promise.race([new Promise(r => second.once('exit', c => r({ code: c }))), sleep(10000).then(() => null)]);
    if (!exited) second.kill();
    ok('E26 再開一次：第二個自己結束', !!exited, exited ? '' : '10 秒內沒結束（被強制關掉）');
    ok('E26 第二個沒報錯（exit 0）', exited && exited.code === 0, JSON.stringify(exited));
    console.log(`E26 第二個 ${Date.now() - t0}ms 結束`);
    ok('E26 第一個照常能用', await waitFor(async () => (await headTitle()).length > 0) && (await todoTitles()).length > 0);

    // E41：安靜跑（見 開發筆記 D052）——視窗在螢幕外；跑完 E26（開起來、再開一次都不該搶焦點），最前面的不是 daybook
    if (!FULL) {
      const pos = await win.evaluate(() => ({ x: screenX, y: screenY }));
      ok('E41 安靜跑：視窗在螢幕外', pos.x <= -10000 && pos.y <= -10000, JSON.stringify(pos));
      const fg = foregroundPid();
      ok('E41 安靜跑：跑完 E26，最前面的視窗不是 daybook', fg !== app.pid, `最前面的程序 ${fg}，daybook ${app.pid}`);
    }

    // E16、E10：文字模式（唯讀，見 開發筆記 D141）——上下兩塊是原文、打字打不進去、檔案不動；標題旁寫唯讀；外面改了照樣跟著換
    await win.click(`#dayList button[data-date="${today}"]`);
    await win.click('#modeBtn');
    ok('E16 文字模式：上面是今天的原文', await editorIs('#editor', readN(todayFile)));
    ok('E10 文字模式：下面是 待辦.md 的原文', await editorIs('#todo', readN(todoFile)));
    ok('E16 文字模式唯讀：兩塊都是 readonly、標題旁寫「唯讀」', await win.$eval('#editor', a => a.readOnly) && await win.$eval('#todo', a => a.readOnly)
      && ((await win.textContent('#saveState')) || '').includes('唯讀'), await win.textContent('#saveState'));
    const dayBefore = readN(todayFile), todoBefore16 = readN(todoFile);
    for (const sel of ['#editor', '#todo']) {
      await win.click(sel);
      await win.keyboard.press('Control+End');
      await win.keyboard.type('打不進去');
      await win.keyboard.press('Tab');
    }
    await sleep(900);   // 原本停手 600ms 自動存檔：等過那段，確定沒寫
    ok('E16 文字模式打字：畫面、檔案都沒變（Tab 也沒插字）', (await win.inputValue('#editor')) === dayBefore && (await win.inputValue('#todo')) === todoBefore16
      && readN(todayFile) === dayBefore && readN(todoFile) === todoBefore16, JSON.stringify([await win.inputValue('#editor'), readN(todayFile)]));
    fs.writeFileSync(todoFile, todoBefore16 + '外面加的待處理\n');
    ok('E10 文字模式時外面改了待辦.md：下面換成新的內容', await editorIs('#todo', todoBefore16 + '外面加的待處理\n'));
    // E54（文字模式）：兩塊中間的線拉比例，跟卡片模式分開記（見 開發筆記 D074）
    {
    const t0 = await sizesOf();
    ok('E54 文字模式：只有兩塊中間一條線、一開始各一半', same(await sashShown(), [true, false]) && near(t0.h[0], t0.h[1], 3), JSON.stringify(t0));
    await dragSash('#sashDone', 0, 50);
    const t1 = await sizesOf();
    ok('E54 文字模式往下拉：已處理變大、待處理讓出一樣多；記成比例，卡片模式的不動', near(t1.h[0], t0.h[0] + 50) && near(t1.h[1], t0.h[1] - 50)
      && t1.saved.text > 0.5 && t1.saved.done == null && t1.saved.todo == null, `${t0.h} → ${JSON.stringify(t1)}`);
    await dblSash('#sashDone');
    ok('E54 文字模式點兩下：回到各一半', await waitFor(async () => { const s = await sizesOf(); return near(s.h[0], s.h[1], 3) && s.saved.text == null; }), JSON.stringify(await sizesOf()));
    }
    await win.click('#modeBtn');
    ok('E16 切回卡片模式：外面加的那行變成卡片、標題旁的「唯讀」拿掉', await waitFor(async () => (await todoTitles()).includes('外面加的待處理'))
      && ((await win.textContent('#saveState')) || '') === '', JSON.stringify([await todoTitles(), await win.textContent('#saveState')]));
  } finally {
    await app.close();
  }

  // E119：文件檢視的 .html 存的東西不留（見 開發筆記 D152）——daybook 開著照留（換一份再回來讀得到上次的）；被砍掉（沒清到）的，下次開起來就清；
  // 正常關掉時清；daybook 自己的 localStorage 不動。--user-data 開（不帶 --data-dir），使用者資料在這一輪的暫存資料夾。
  // docview 存的從畫面看不到（別的來源），CDP 的 DOMStorage、IndexedDB 也要開著那個來源的網頁才問得到，所以放一份只讀不存的 probe.html 回報：[localStorage 幾筆, IndexedDB 有哪些]。
  // 被砍掉時 localStorage 可能還沒寫進磁碟（Chromium 隔幾秒才寫），有沒有清靠 IndexedDB 判斷（開了就寫進去）
  {
  const ud119 = path.join(tmpRoot, 'profile119'), data119 = path.join(tmpRoot, 'data119'), docs119 = path.join(tmpRoot, 'docs119');
  for (const d of [ud119, data119, docs119]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(ud119, 'settings.json'), JSON.stringify({ dataDir: data119 }));
  fs.writeFileSync(path.join(docs119, 'keep.html'), '<!doctype html><meta charset="utf-8"><p id="r"></p><script>'
    + 'const n = (Number(localStorage.getItem("zzN")) || 0) + 1; localStorage.setItem("zzN", String(n));'
    + 'indexedDB.open("zzDb", 1).onsuccess = () => { document.getElementById("r").textContent = String(n); };</script>');   // IndexedDB 開好了才寫第幾次
  fs.writeFileSync(path.join(docs119, 'probe.html'), '<!doctype html><meta charset="utf-8"><p id="r"></p><script>'
    + 'indexedDB.databases().then(d => { document.getElementById("r").textContent = JSON.stringify([localStorage.length, d.map(x => x.name)]); });</script>');
  const args119 = ['--user-data', ud119, '--pick-md-dir', docs119];
  const rowOf = f => `#mdTree .nlRow[data-key="${path.join(docs119, f).replace(/\\/g, '\\\\')}"] .nlName`;
  const shows = w => w.frameLocator('#docFrame').locator('#r').textContent({ timeout: 2000 }).catch(() => '');
  const openDoc = async (w, f, want) => {   // 打開 f，等網頁寫出 want（換頁時 iframe 可能還是上一份的字）
    if (!(await w.isVisible('#mdPane'))) await w.click('#actMd');
    // 第一次要釘（釘的記在設定檔，之後開起來就在）；重開時資料夾可能是收起來的（展開的記在 localStorage，砍掉時可能還沒寫進去），點一下展開。
    // 先等釘住的資料夾那行畫出來再看收著沒：原本先查檔案那行、再查資料夾那行，清單剛好在兩次中間畫出來（展開的）就把它點成收起來（2026-11-04 抓到，D159）
    const root = `#mdTree .nlRow[data-key="${docs119.replace(/\\/g, '\\\\')}"] .nlName`;
    if (!(await w.$(root))) await w.click('#mdAddRoot');   // 還沒釘，或清單還沒畫出來（已經釘了的再釘一次只提示）
    await waitFor(async () => !!(await w.$(root)));
    if (!(await w.$(rowOf(f)))) await w.click(root);
    await waitFor(async () => !!(await w.$(rowOf(f))));
    await w.dblclick(rowOf(f));
    return waitFor(async () => (await shows(w)) === want, 6000);
  };
  const appA = await launch(pw, args119);
  try {
    const w = appA.page;
    ok('E119 開會存東西的 .html：第 1 次', await openDoc(w, 'keep.html', '1'), await shows(w));
    ok('E119 換一份只讀的：看得到存的 localStorage、IndexedDB', await openDoc(w, 'probe.html', '[1,["zzDb"]]'), await shows(w));
    // 換回來不會重新載入（iframe 留著，D155）：先關掉它的頁籤（iframe 跟著拿掉）再開，才是重新載入
    const keepTab = `#mdTabs .noteTab[data-key="${path.join(docs119, 'keep.html').replace(/\\/g, '\\\\')}"]`;
    await w.hover(keepTab);   // × 在不是正在看的頁籤上，滑鼠移上去才出來
    await w.click(`${keepTab} .noteDel`);
    await waitFor(async () => !(await w.$(`#mdWrap iframe[data-key="${path.join(docs119, 'keep.html').replace(/\\/g, '\\\\')}"]`)));
    ok('E119 daybook 開著：關掉頁籤再開（重新載入），存的照留（第 2 次）', await openDoc(w, 'keep.html', '2'), await shows(w));
    await openDoc(w, 'probe.html', '[1,["zzDb"]]');   // 停在只讀的：下次開起來照記的打開這份，不會先存東西
  } finally {
    await appA.close();   // 直接砍掉：關掉時的清沒跑到
  }
  const appB = await launch(pw, args119);
  try {
    const w = appB.page;
    ok('E119 被砍掉後再開：上次存的清掉了（先開只讀的看）', await openDoc(w, 'probe.html', '[0,[]]'), await shows(w));
    ok('E119 再開會存的：全新的（第 1 次）', await openDoc(w, 'keep.html', '1'), await shows(w));
    await openDoc(w, 'probe.html', '[1,["zzDb"]]');
    await w.evaluate(() => localStorage.setItem('daybook.zzMine', '1'));
    await w.evaluate(() => window.close());   // 正常關掉：關掉時清
    await waitFor(() => { try { process.kill(appB.pid, 0); return false; } catch { return true; } }, 8000);
  } finally {
    await appB.close();
  }
  // 關掉時就清了（不是下次開起來才清）：磁碟上沒有 IndexedDB 的資料（daybook 自己沒用 IndexedDB，有就是 .html 存的）。
  // 不分區時放 IndexedDB\docview_local_0.indexeddb.leveldb，分區時放 WebStorage\編號\IndexedDB（2026-11-03 量的），兩處都看
  const idbLeft = fs.readdirSync(ud119, { recursive: true }).map(String).filter(f => /^(IndexedDB\\.|WebStorage\\\d+\\IndexedDB)/.test(f));
  ok('E119 正常關掉：關掉時就清了（磁碟上 .html 的 IndexedDB 不見了）', idbLeft.length === 0, JSON.stringify(idbLeft));
  const appC = await launch(pw, args119);
  try {
    const w = appC.page;
    ok('E119 正常關掉再開：存的清掉了；daybook 自己的 localStorage 還在', await openDoc(w, 'probe.html', '[0,[]]') && (await w.evaluate(() => localStorage.getItem('daybook.zzMine'))) === '1',
      JSON.stringify([await shows(w), await w.evaluate(() => localStorage.getItem('daybook.zzMine'))]));
  } finally {
    await appC.close();
  }
  }

  // E35：還沒選資料夾——不在啟動時跳視窗，進畫面後讓使用者自己選（見 開發筆記 D041）
  // --user-data 指到暫存的設定資料夾（設定檔裡的資料夾故意是不存在的），--pick-dir 代替原生的選資料夾視窗
  const ud = path.join(tmpRoot, 'profile');
  const picked = path.join(tmpRoot, 'picked');
  const lost = path.join(tmpRoot, '不見的資料夾');
  fs.mkdirSync(ud);
  // 開頭故意帶 BOM（記事本存成「UTF-8 with BOM」那種）：照樣讀得懂（見 開發筆記 D137）
  fs.writeFileSync(path.join(ud, 'settings.json'), '﻿' + JSON.stringify({ dataDir: lost }));
  fs.cpSync(path.join(__dirname, 'fixtures', 'data'), picked, { recursive: true });
  const app2 = await launch(pw, ['--user-data', ud, '--pick-dir', picked]);
  try {
    const w2 = app2.page;
    let errors = 0;
    w2.on('pageerror', () => { errors++; });
    ok('E35 開起來是畫面上的「選擇資料夾」卡片（不是啟動時跳視窗）', await waitFor(async () => w2.isVisible('#setup').catch(() => false), 8000));
    ok('E35 原本的資料夾不見了：寫出是哪個', ((await w2.textContent('#setupLost')) || '').includes(lost), await w2.textContent('#setupLost'));
    ok('E35 狀態列寫要先選資料夾', ((await w2.textContent('#statusKeys')) || '').includes('先選一個資料夾'), await w2.textContent('#statusKeys'));
    await w2.keyboard.press('Alt+ArrowLeft');
    await w2.keyboard.press('Control+Z');
    await sleep(300);
    ok('E35 還沒選時按會動到資料的快捷鍵：不理、不出錯', errors === 0, `畫面錯誤 ${errors} 次`);
    await w2.click('#setupPick');
    ok('E35 選好：設定檔記下那個資料夾', await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).dataDir === picked; } catch { return false; } }));
    ok('E35 選好：卡片收起來，畫面換成那個資料夾的紀錄', await waitFor(async () => !(await w2.isVisible('#setup').catch(() => true))
      && (await w2.$$eval('#todoCards .card .title', els => els.map(e => e.textContent)).catch(() => [])).includes('週報'), 8000));
    ok('E35 左下角寫資料夾路徑', (await w2.textContent('#dirPath')) === picked, await w2.textContent('#dirPath'));
  } finally {
    await app2.close();
  }

  // E38：選資料夾卡片上的「匯入…」（見 開發筆記 D044）——空的設定、空的資料夾，先選資料夾再選舊檔
  const ud3 = path.join(tmpRoot, 'profile3');
  const picked3 = path.join(tmpRoot, 'picked3');
  fs.mkdirSync(ud3);
  fs.mkdirSync(picked3);
  // E109：設定檔讀不懂（手改壞了，見 開發筆記 D137）——壞檔改名留著、提示一次，這次當作沒設定（接著 E38 照常選資料夾）
  const badSettings = '{ "dataDir": "C:\\\\x", 壞掉 }';
  fs.writeFileSync(path.join(ud3, 'settings.json'), badSettings);
  const app3 = await launch(pw, ['--user-data', ud3, '--pick-dir', picked3, '--pick-file', SAMPLE]);
  try {
    const w3 = app3.page;
    await waitFor(async () => w3.isVisible('#setup').catch(() => false), 8000);
    const bads = fs.readdirSync(ud3).filter(f => /^settings\.json\.bad-\d{8}-\d{6}$/.test(f));
    ok('E109 設定檔讀不懂：壞檔改名成 settings.json.bad-日期時間、內容原封不動；原本的名稱不在了', bads.length === 1
      && fs.readFileSync(path.join(ud3, bads[0]), 'utf8') === badSettings && !fs.existsSync(path.join(ud3, 'settings.json')), JSON.stringify(fs.readdirSync(ud3)));
    ok('E109 提示讀不懂、另存成哪個檔；當作沒設定（出現選擇資料夾）', ((await w3.textContent('#toast').catch(() => '')) || '').includes(bads[0] || '?')
      && await w3.isVisible('#setup'), await w3.textContent('#toast').catch(() => ''));
    await w3.click('#setupImport');
    const want = exp.parse(readN(SAMPLE)).days;
    ok('E38 先選資料夾：設定檔記下', await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(ud3, 'settings.json'), 'utf8')).dataDir === picked3; } catch { return false; } }));
    ok('E38 再匯入：6 天全寫進那個資料夾', await waitFor(() => want.every(d => readN(path.join(picked3, dayPath(d.date))) === d.text)),
      want.map(d => d.date + ' ' + fs.existsSync(path.join(picked3, dayPath(d.date)))).join('、'));
    ok('E38 重新載入後卡片收起來、提示匯了幾天', await waitFor(async () => !(await w3.isVisible('#setup').catch(() => true))
      && ((await w3.textContent('#toast').catch(() => '')) || '').includes('匯入 6 天'), 8000), await w3.textContent('#toast').catch(() => ''));
    // E110：外面的編輯器把 待辦.md 存成「UTF-8 with BOM」（見 開發筆記 D136）——第一行還是標題、狀態認得到，不會變成沒標題的內容
    fs.writeFileSync(path.join(picked3, TODO_FILE), '﻿CWIN301020 銷貨單 [待回覆]\n\t改權限\n');
    const bomCards = () => w3.$$eval('#todoCards .card', els => els.map(e => [e.querySelector('.title')?.textContent, !!e.querySelector('button.wait.on')]));
    ok('E110 待辦.md 開頭有 BOM：第一筆的標題、狀態照樣認得', await waitFor(async () => same(await bomCards(), [['CWIN301020 銷貨單', true]])), JSON.stringify(await bomCards()));
    // E112：不是 UTF-8 的記事（Big5 存的「中文」，見 開發筆記 D139）——點了打不開：提示、頁籤不留、看的還是原本那份（文字框沒換成亂碼）、檔案一個位元組都沒動
    {
      const noteDir3 = path.join(picked3, '記事本');
      fs.mkdirSync(noteDir3, { recursive: true });
      const big5File = path.join(noteDir3, '舊筆記.txt');
      const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0x0d, 0x0a]);
      fs.writeFileSync(big5File, big5);
      fs.writeFileSync(path.join(noteDir3, '新筆記.txt'), '新的');
      const row3 = k => `#noteTree .nlRow[data-key="${k}"] .nlName`;
      const tabs3 = () => w3.$$eval('#noteTabs .noteName', els => els.map(e => e.firstChild?.textContent ?? ''));
      await w3.click('#actNote');
      await waitFor(async () => (await w3.isVisible(row3('f:舊筆記'))) && (await w3.isVisible(row3('f:新筆記'))), 8000);
      await w3.dblclick(row3('f:新筆記'));
      await waitFor(async () => (await w3.inputValue('#noteText')) === '新的');
      await w3.click(row3('f:舊筆記'));
      ok('E112 不是 UTF-8 的記事：提示打不開、頁籤不留、還是看原本那份、檔案沒動',
        await waitFor(async () => ((await w3.textContent('#toast')) || '').includes('不是 UTF-8')) && await waitFor(async () => same(await tabs3(), ['新筆記']))
        && (await w3.inputValue('#noteText')) === '新的' && fs.readFileSync(big5File).equals(big5),
        `${await w3.textContent('#toast')} ${JSON.stringify(await tabs3())}`);
    }
  } finally {
    await app3.close();
  }

  // E39：E31 匯出全部的檔，從選資料夾卡片匯進一個空的資料夾（見 開發筆記 D046）——每一天、待處理的卡片都跟匯出當時一樣
  if (!exported) throw new Error('E31 沒跑到匯出全部，E39 沒有檔可以匯');
  const ud4 = path.join(tmpRoot, 'profile4');
  const picked4 = path.join(tmpRoot, 'picked4');
  fs.mkdirSync(ud4);
  fs.mkdirSync(picked4);
  const app4 = await launch(pw, ['--user-data', ud4, '--pick-dir', picked4, '--pick-file', exported.file]);
  try {
    const w4 = app4.page;
    await waitFor(async () => w4.isVisible('#setup').catch(() => false), 8000);
    await w4.click('#setupImport');
    const days = exported.sources.filter(s => s.src !== 'todo' && parseDay(s.text).length);
    const todoSrc = exported.sources.find(s => s.src === 'todo');
    // 匯出當時沒有隱藏的卡（E31 之前沒留下）；隱藏的匯出再匯回由 parser 的 X2 驗
    const has = k => exported.sources.some(s => cardsOf(s.text).some(c => c[k] != null && c[k] !== false));
    ok('E39 前提：匯出當時有 ^編號、待回覆、標記（E52 留下的）、標記分類（E53 留下的）的卡片', ['event', 'status', 'flagged', 'flagCat'].every(has), '缺：' + ['event', 'status', 'flagged', 'flagCat'].filter(k => !has(k)).join('、'));
    ok('E39 每一天都匯進來、卡片跟匯出當時一樣', await waitFor(() => days.every(s => same(cardsOf(readN(path.join(picked4, dayPath(s.src)))), cardsOf(s.text)))),
      days.filter(s => !same(cardsOf(readN(path.join(picked4, dayPath(s.src)))), cardsOf(s.text))).map(s => s.src).join('、'));
    ok('E39 待處理的卡片跟匯出當時一樣', same(cardsOf(readN(path.join(picked4, TODO_FILE))), cardsOf(todoSrc.text)));
    ok('E39 提示寫匯了幾天、認成 daybook Markdown', await waitFor(async () => ((await w4.textContent('#toast').catch(() => '')) || '').includes(`匯入 ${days.length} 天（daybook Markdown）`), 8000),
      await w4.textContent('#toast').catch(() => ''));
  } finally {
    await app4.close();
  }

  // E43：匯入格式的擴充（見 開發筆記 D055；清單在右上角「匯入格式」頁，D056）——設定資料夾的 extensions\ 放四個：
  // 範例、版本不合、壞掉（沒有 package.json）、detect 會丟錯；設定檔先指好一個空的資料夾，不出現選資料夾的卡片
  const ud5 = path.join(tmpRoot, 'profile5');
  const picked5 = path.join(tmpRoot, 'picked5');
  const extRoot = path.join(ud5, 'extensions');
  fs.mkdirSync(picked5);
  fs.mkdirSync(extRoot, { recursive: true });
  fs.writeFileSync(path.join(ud5, 'settings.json'), JSON.stringify({ dataDir: picked5 }));
  fs.cpSync(EXAMPLE, path.join(extRoot, 'a-example'), { recursive: true });
  const appV = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const exV = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'package.json'), 'utf8')).version;   // 範例的版本：啟用時設定檔記這個
  const fakeExt = (folder, engines, code) => {
    fs.mkdirSync(path.join(extRoot, folder));
    fs.writeFileSync(path.join(extRoot, folder, 'package.json'), JSON.stringify({ name: folder, version: '1.0.0', engines: { daybook: engines },
      contributes: { importFormats: [{ id: 'f', label: folder, hint: '測試用', extensions: ['txt'] }] } }));
    fs.writeFileSync(path.join(extRoot, folder, 'index.js'), code);
  };
  fakeExt('b-new', '^99.0.0', '');
  fs.mkdirSync(path.join(extRoot, 'c-broken'));
  fakeExt('d-throws', '^' + appV, "module.exports = { formats: { f: { detect: () => { throw new Error('e2e 故意的'); }, parse: () => null } } };");
  const sample5 = path.join(EXAMPLE, 'sample.txt');
  const open5 = path.join(tmpRoot, 'open5.log');
  const clip5 = path.join(tmpRoot, 'clip5.txt');   // E44：複製 prompt 寫到這裡，不碰使用者的剪貼簿（見 開發筆記 D056）
  const export5 = path.join(tmpRoot, 'export5');   // E57：匯出、試跑的「存一份看看」寫到這裡，不跳存檔視窗（見 開發筆記 D078、D079）
  fs.mkdirSync(export5);
  const trash5 = path.join(tmpRoot, 'trash5');   // E58：刪擴充搬到這裡，不碰使用者的資源回收筒（見 開發筆記 D081）
  fs.mkdirSync(trash5);
  // --pick-format：E45 兩種都認得時不跳視窗，當作選了 AI 寫的那個（見 開發筆記 D058）
  // --existing 加進去：E45 日子都已經有，當作按了「加進去」；內容一模一樣，一筆都不會加（見 開發筆記 D063）
  const app5 = await launch(pw, ['--user-data', ud5, '--pick-file', sample5, '--open-log', open5, '--clipboard-file', clip5, '--pick-format', 'AI 日期分隔', '--existing', '加進去',
    '--export-dir', export5, '--trash-dir', trash5]);
  try {
    const w5 = app5.page;
    const toast5 = () => w5.textContent('#toast').catch(() => '');
    const settings5 = () => { try { return JSON.parse(fs.readFileSync(path.join(ud5, 'settings.json'), 'utf8')); } catch { return null; } };
    const row = name => `#extTable tr[data-ext="${name}"]`;
    const stateOf = name => w5.$eval(row(name) + ' .extState', e => [e.dataset.state, e.textContent]).catch(() => null);
    const visible = sel => w5.isVisible(sel).catch(() => false);
    // 擴充清單另開一張（見 開發筆記 D085）：格式頁開著時按「管理擴充…」
    const openExts = async () => { await w5.click('#extManage'); await waitFor(() => visible('#extList')); };
    const shownExts = () => w5.$$eval('#extTable tr', trs => trs.filter(t => !t.hidden).map(t => t.dataset.ext));
    await waitFor(async () => (await w5.$$('#dayList button')).length > 0, 8000);
    const journal5 = path.join(picked5, 'journal');

    await viaSettings(w5, '#importBtn');
    ok('E43 還沒啟用：認不出格式，提示有 2 個擴充還沒啟用、什麼都沒寫',
      await waitFor(async () => { const t = await toast5(); return t.includes('認不出') && t.includes('有 2 個擴充還沒啟用'); }) && !fs.existsSync(journal5), await toast5());

    await viaSettings(w5, '#fmtBtn');
    await waitFor(() => visible('#fmt'));
    const builtin5 = await w5.textContent('#fmtBuiltin');
    ok('E43 格式頁列出內建的匯入格式：只有 daybook Markdown（舊記事本是擴充，D084）', builtin5.includes('daybook Markdown') && !builtin5.includes('舊記事本'), builtin5);
    const builtinOut5 = await w5.textContent('#fmtBuiltinOut');
    ok('E43 格式頁列出內建的匯出格式（D078）', builtinOut5.includes('daybook Markdown（.md，') && builtinOut5.includes('Excel（.xlsx，'), builtinOut5);
    ok('E43 頁面標題是「格式」（D078 改名）', (await w5.textContent('#fmt h2')) === '格式', await w5.textContent('#fmt h2'));
    ok('E61 格式頁上只有摘要：已裝 4 個、啟用 0 個；清單那張還沒開', (await w5.textContent('#extSum')) === '已裝 4 個、啟用 0 個'
      && !(await visible('#extList')) && !(await visible('#extTable')), await w5.textContent('#extSum'));
    await openExts();
    ok('E61 按「管理擴充…」：清單那張蓋上來、游標在搜尋框，格式頁還在底下', await visible('#fmt')
      && (await w5.evaluate(() => document.activeElement.id)) === 'extFind' && (await w5.textContent('#extList h2')) === '擴充');
    ok('E43 擴充資料夾＝設定資料夾的 extensions', (await w5.textContent('#fExt')) === extRoot, await w5.textContent('#fExt'));
    ok('E43 四個擴充照資料夾名稱排，壞掉的用資料夾名稱', same(await w5.$$eval('#extTable tr', trs => trs.map(t => t.dataset.ext)), ['daybook-example-dated', 'b-new', 'c-broken', 'd-throws'])
      && !(await visible('#extNone')), JSON.stringify(await w5.$$eval('#extTable tr', trs => trs.map(t => t.dataset.ext))));
    const sa = await stateOf('daybook-example-dated'), sb = await stateOf('b-new'), sc = await stateOf('c-broken');
    ok('E43 狀態：範例未啟用、版本不合寫要哪一版、壞掉寫原因',
      sa[0] === 'disabled' && sa[1] === '未啟用' && sb[0] === 'incompatible' && sb[1].includes('^99.0.0') && sb[1].includes(appV) && sc[0] === 'broken' && sc[1].includes('沒有 package.json'),
      JSON.stringify([sa, sb, sc]));
    ok('E43 範例列出名稱、版本、匯入和匯出格式', (await w5.textContent(row('daybook-example-dated'))).includes(`範例：日期分隔純文字 ${exV}`)
      && (await w5.textContent(row('daybook-example-dated'))).includes('匯入：日期分隔純文字（一行 === 2026-10-27 === 隔開每一天）')
      && (await w5.textContent(row('daybook-example-dated'))).includes('匯出：日期分隔純文字（.txt，'), await w5.textContent(row('daybook-example-dated')));
    // 列上看得到的鈕（「確定…」那塊裡的不算）：每一列都有「刪除」（D081，同外觀包 D073）
    const rowBtns = name => w5.$$eval(row(name) + ' .extBtn', bs => bs.filter(b => !b.closest('.extConfirm')).map(b => b.dataset.act));
    ok('E43 只有未啟用的有「啟用」，版本不合、壞掉的只有「刪除」', same(await rowBtns('daybook-example-dated'), ['ask', 'delAsk'])
      && same(await rowBtns('b-new'), ['delAsk']) && same(await rowBtns('c-broken'), ['delAsk']),
      JSON.stringify([await rowBtns('daybook-example-dated'), await rowBtns('b-new'), await rowBtns('c-broken')]));
    await w5.click('#extList .openBtn[data-open="extensions"]');
    ok('E43 擴充資料夾的「開啟位置」', await waitFor(() => (readN(open5) || '').trim() === extRoot), readN(open5));

    // 搜尋框（D085）：空白隔開的每個詞都要有、不分大小寫；都不符合寫「沒有符合的擴充」
    await w5.fill('#extFind', 'B-NEW');
    ok('E61 搜尋：不分大小寫，只列符合的', await waitFor(async () => same(await shownExts(), ['b-new'])) && !(await visible('#extNoHit')), JSON.stringify(await shownExts()));
    await w5.fill('#extFind', '範例 b-new');
    ok('E61 搜尋：每個詞都要有，都不符合寫「沒有符合的擴充」', await waitFor(async () => same(await shownExts(), [])) && await visible('#extNoHit') && !(await visible('#extNone')),
      JSON.stringify(await shownExts()));
    await w5.fill('#extFind', '');
    ok('E61 清掉搜尋：四個都列回來', await waitFor(async () => (await shownExts()).length === 4) && !(await visible('#extNoHit')));
    await w5.fill('#extFind', '日期 範例');   // 底下啟用時清單會重畫，搜的字要留著

    // 啟用要兩步：先展開提醒，按「確定啟用」才記下
    await w5.click(row('daybook-example-dated') + ' [data-act="ask"]');
    ok('E43 按「啟用」先展開提醒（能匯入也能匯出的寫兩種時候都會跑），還沒啟用', await visible(row('daybook-example-dated') + ' .extConfirm[data-kind="on"]')
      && (await w5.textContent(row('daybook-example-dated') + ' .extConfirm[data-kind="on"]')).includes('可以讀寫你電腦上所有你能碰的檔案')
      && (await w5.textContent(row('daybook-example-dated') + ' .extConfirm[data-kind="on"]')).includes('會在你按「匯入…」或匯出時執行')
      && (await stateOf('daybook-example-dated'))[0] === 'disabled' && !settings5().extensions);
    await w5.click(row('daybook-example-dated') + ' [data-act="cancel"]');
    ok('E43 取消：提醒收起來、「啟用」回來', !(await visible(row('daybook-example-dated') + ' .extConfirm[data-kind="on"]')) && await visible(row('daybook-example-dated') + ' [data-act="ask"]'));
    await w5.click(row('daybook-example-dated') + ' [data-act="ask"]');
    await w5.click(row('daybook-example-dated') + ' [data-act="on"]');
    ok('E43 確定啟用：變成已啟用、有「停用」，設定檔記下名稱＋版本',
      await waitFor(async () => (await stateOf('daybook-example-dated') || [])[0] === 'enabled') && await visible(row('daybook-example-dated') + ' [data-act="off"]')
      && same(settings5().extensions, { 'daybook-example-dated': exV }) && settings5().dataDir === picked5, JSON.stringify(settings5()));
    ok('E61 啟用後清單重畫：搜的字留著、還是只列範例', same(await shownExts(), ['daybook-example-dated']) && (await w5.inputValue('#extFind')) === '日期 範例', JSON.stringify(await shownExts()));
    await w5.keyboard.press('Escape');
    ok('E61 Esc 先只關清單那張、回到格式頁；摘要跟著變（啟用 1 個）', await waitFor(async () => !(await visible('#extList'))) && await visible('#fmt')
      && (await w5.textContent('#extSum')) === '已裝 4 個、啟用 1 個', await w5.textContent('#extSum'));
    await w5.keyboard.press('Escape');

    // 用範例擴充匯入：期望值＝範例自己的 parse 拆出來、再經 daybook 檢查的
    const want5 = checkParsed(require(path.join(EXAMPLE, 'index.js')).formats['dated-txt'].parse(readN(sample5)));
    await viaSettings(w5, '#importBtn');
    ok('E43 啟用後匯入：每一天照範例拆的寫進來、待處理寫進 待辦.md',
      await waitFor(() => want5.days.every(d => readN(path.join(picked5, dayPath(d.date))) === d.text) && readN(path.join(picked5, TODO_FILE)) === want5.todo),
      want5.days.map(d => d.date + ' ' + JSON.stringify(readN(path.join(picked5, dayPath(d.date))))).join('\n'));
    ok('E43 提示寫認成擴充的格式', await waitFor(async () => (await toast5()).includes(`匯入 ${want5.days.length} 天（日期分隔純文字，擴充「範例：日期分隔純文字」）`)), await toast5());

    // detect 會丟錯的擴充：啟用後匯入報錯寫是哪個擴充，daybook 照常能用；停用後設定檔拿掉它
    await viaSettings(w5, '#fmtBtn');
    await waitFor(() => visible('#fmt'));
    await openExts();
    ok('E61 再打開清單：搜尋框清空、四個都列', (await w5.inputValue('#extFind')) === '' && (await shownExts()).length === 4, JSON.stringify(await shownExts()));
    await w5.click(row('d-throws') + ' [data-act="ask"]');
    await w5.click(row('d-throws') + ' [data-act="on"]');
    await waitFor(async () => (await stateOf('d-throws') || [])[0] === 'enabled');
    await w5.keyboard.press('Escape');
    await w5.keyboard.press('Escape');
    const before5 = fs.readdirSync(journal5, { recursive: true }).length;
    await viaSettings(w5, '#importBtn');
    ok('E43 擴充丟錯：報錯寫是哪個擴充、錯誤訊息，什麼都沒寫', await waitFor(async () => (await toast5()).includes('擴充「d-throws」出錯：e2e 故意的'))
      && fs.readdirSync(journal5, { recursive: true }).length === before5, await toast5());
    await viaSettings(w5, '#fmtBtn');
    ok('E43 擴充丟錯之後 daybook 照常能用', await waitFor(() => visible('#fmt')));
    await openExts();
    await w5.click(row('d-throws') + ' [data-act="off"]');
    ok('E43 停用：變回未啟用，設定檔只剩範例', await waitFor(async () => (await stateOf('d-throws') || [])[0] === 'disabled')
      && same(settings5().extensions, { 'daybook-example-dated': exV }), JSON.stringify(settings5()));
    await w5.mouse.click(5, 60);   // 標題列（35px，D100）底下的背景
    ok('E61 點外面只關清單那張、格式頁還開著', await waitFor(async () => !(await visible('#extList'))) && await visible('#fmt'));

    // E44：請 AI 寫一個新的格式（見 開發筆記 D056）——接著 E43：範例還啟用著、資料夾已經匯過 sample.txt、匯入格式頁開著。
    // 拿範例改個名字當成 AI 回的
    const ai = require(path.join(ROOT, 'src/main/ai-ext.js'));
    const aiText = () => w5.textContent('#aiResult').catch(() => '');
    ok('E44 「格式…」在齒輪「設定」選單「自訂」那類的第一個（D078 改名、D092 搬進設定、D098 分類）', (await w5.$$('#settingsMenu #setCatCustom + #fmtBtn')).length === 1 && (await w5.textContent('#fmtBtn')) === '格式…');
    ok('E44 頁面上的 prompt＝這一版的 prompt', (await w5.textContent('#aiPromptText')) === ai.buildPrompt(appV));
    await w5.click('#aiCopy');
    ok('E44 複製 prompt：複製的就是 prompt（測試寫到檔，不碰剪貼簿）', await waitFor(() => readN(clip5) === ai.buildPrompt(appV)));
    await w5.click('#aiGemini');
    await w5.click('#aiChatgpt');
    ok('E44 開 Gemini、開 ChatGPT：開固定的網址（測試寫到檔，不開瀏覽器）',
      await waitFor(() => same((readN(open5) || '').trim().split('\n').slice(-2), ['https://gemini.google.com/app', 'https://chatgpt.com/'])), readN(open5));
    const exPkg = JSON.parse(readN(path.join(EXAMPLE, 'package.json')));
    const exCode = readN(path.join(EXAMPLE, 'index.js'));
    const aiPkg = { ...exPkg, name: 'ai-dated', displayName: 'AI：日期分隔',
      contributes: { importFormats: [{ ...exPkg.contributes.importFormats[0], label: 'AI 日期分隔' }] } };
    const reply = code => `${ai.PKG_MARK}\n${JSON.stringify(aiPkg, null, 2)}\n${ai.CODE_MARK}\n${code}`;
    const aiDir = path.join(extRoot, 'ai-dated');
    const data5Before = snapshot(picked5);

    await w5.fill('#aiReply', reply(exCode + 'const env = process.env;\n'));
    await w5.click('#aiTry');
    ok('E44 有禁用的字：檢查沒通過（程式沒執行）、寫第幾行，沒有「安裝並啟用」、沒裝',
      await waitFor(async () => (await aiText()).includes('檢查沒通過') && (await aiText()).includes(`第 ${exCode.split('\n').length} 行有「process」`))
      && !(await visible('#aiInstall')) && !fs.existsSync(aiDir), await aiText());
    // 「複製給 AI」（見 開發筆記 D061）：複製的就是 buildFeedback 組的那段（測試寫到檔，不碰剪貼簿）
    const fb1 = ai.buildFeedback({ stage: 'check', errors: ai.checkReply(reply(exCode + 'const env = process.env;\n'), appV).errors });
    await w5.click('#aiFeedback');
    ok('E44 檢查沒通過按「複製給 AI」：複製檢查沒過、每一條問題、要回完整的兩個檔', await waitFor(() => readN(clip5) === fb1), readN(clip5));
    // detect 不認得：試跑沒通過，畫面上、複製給 AI 的都附檔案開頭
    await w5.fill('#aiReply', reply("module.exports = { formats: { 'dated-txt': { detect: () => false, parse: () => null } } };\n"));
    await w5.click('#aiTry');
    const ex44 = ai.excerpt(readN(sample5));
    ok('E44 detect 不認得：試跑沒通過、寫被認成哪一種，附你的檔案開頭', await waitFor(async () => (await aiText()).includes('試跑沒通過') && (await aiText()).includes('被認成'))
      && (await w5.textContent('#aiResult > pre', { timeout: 2000 }).catch(() => '')) === ex44.join('\n') && !(await visible('#aiInstall')), await aiText());
    await w5.click('#aiFeedback');
    ok('E44 試跑沒通過按「複製給 AI」：寫試跑沒過、附檔案開頭', await waitFor(() => (readN(clip5) || '').startsWith('我把你寫的擴充貼進 daybook，拿我的整份檔試跑沒通過')
      && readN(clip5).includes('被認成') && readN(clip5).includes(ex44.join('\n'))), readN(clip5));
    await w5.fill('#aiReply', reply(exCode));
    await w5.click('#aiTry');
    ok('E44 已啟用的範例也認得 sample.txt：試跑用 AI 寫的、照樣過，預覽寫範例也認得、匯入時會問；還沒裝（D058）',
      await waitFor(async () => (await visible('#aiInstall')) && (await aiText()).includes('「日期分隔純文字」（擴充「範例：日期分隔純文字」）也認得這個檔，匯入時會問你'))
      && !fs.existsSync(aiDir), await aiText());
    await openExts();
    await w5.click(row('daybook-example-dated') + ' [data-act="off"]');
    await waitFor(async () => (await stateOf('daybook-example-dated') || [])[0] === 'disabled');
    await w5.click('#extListClose');
    ok('E61 ✕ 只關清單那張、回到格式頁（貼的字、試跑結果還在）', await waitFor(async () => !(await visible('#extList'))) && await visible('#fmt')
      && (await w5.inputValue('#aiReply')) === reply(exCode) && await visible('#aiInstall'));
    await w5.click('#aiTry');
    // 上一次的預覽會留到新結果出來：等到「也認得」那行不見，才是停用範例後的這一次
    await waitFor(async () => (await visible('#aiInstall')) && !(await aiText()).includes('也認得'));
    const pv = await aiText();
    ok('E44 停用範例後試跑通過：預覽寫天數、已經有的天數、待處理已經有、前幾天的內容，不寫誰也認得；還沒裝',
      pv.includes(`拆出 ${want5.days.length} 天`) && pv.includes(`其中 ${want5.days.length} 天資料夾裡已經有`) && pv.includes('資料夾裡的待處理已經有內容')
      && want5.days.slice(0, 3).every(d => pv.includes(d.date) && pv.includes(d.text.split('\n')[0])) && !pv.includes('也認得')
      && !fs.existsSync(aiDir) && !settings5().extensions['ai-dated'], pv);
    await w5.$eval('#aiReply', e => { e.value += '\n'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('E44 框裡的字一改，預覽就收起來，要重新試跑', !(await visible('#aiResult')) && !(await visible('#aiInstall')));
    await w5.click('#aiTry');
    await waitFor(() => visible('#aiInstall'));
    await w5.click('#aiInstall');
    ok('E44 安裝並啟用：擴充資料夾多一個 ai-dated（就是貼的那份）、設定檔記下、清單上已啟用',
      await waitFor(async () => (await stateOf('ai-dated') || [])[0] === 'enabled')
      && same(JSON.parse(readN(path.join(aiDir, 'package.json'))), aiPkg) && readN(path.join(aiDir, 'index.js')) === exCode.replace(/\s+$/, '') + '\n'
      && settings5().extensions['ai-dated'] === aiPkg.version, JSON.stringify(settings5()));
    ok('E44 提示寫已安裝並啟用', (await aiText()).includes('已安裝並啟用「AI：日期分隔」'), await aiText());
    ok('E61 裝好之後格式頁的摘要跟著變（範例剛停用，啟用的只有 ai-dated）', (await w5.textContent('#extSum')) === '已裝 5 個、啟用 1 個', await w5.textContent('#extSum'));
    ok('E44 安裝不匯入：資料資料夾一個檔都沒變', same(snapshot(picked5), data5Before));
    await w5.keyboard.press('Escape');
    ok('E44 Esc 關掉格式頁', await waitFor(async () => !(await visible('#fmt'))));

    // E45：兩種以上格式都認得要匯入的檔（見 開發筆記 D058）——接著 E44：ai-dated 裝好啟用了，再啟用範例，兩個都認得 sample.txt。
    // 啟動帶了 --pick-format「AI 日期分隔」：不跳視窗、當作選了它；它排在範例後面，選第一個的話會是範例
    await viaSettings(w5, '#fmtBtn');
    await waitFor(() => visible('#fmt'));
    await openExts();
    await w5.click(row('daybook-example-dated') + ' [data-act="ask"]');
    await w5.click(row('daybook-example-dated') + ' [data-act="on"]');
    await waitFor(async () => (await stateOf('daybook-example-dated') || [])[0] === 'enabled');
    await w5.keyboard.press('Escape');
    await w5.keyboard.press('Escape');
    await viaSettings(w5, '#importBtn');
    ok('E45 範例和 AI 寫的都認得：用選的那一種匯入、提示寫它；日子都已經有，什麼都沒寫',
      await waitFor(async () => (await toast5()).includes('（AI 日期分隔，擴充「AI：日期分隔」）')) && same(snapshot(picked5), data5Before), await toast5());
    ok('E45 加進去：每一筆都一模一樣，提示寫加進 0 筆、待處理也一起比', (await toast5()).includes(`資料夾裡已經有的 ${want5.days.length} 天和待處理：加進 0 筆`), await toast5());

    // E57：匯出格式的擴充（見 開發筆記 D078、D079）——接著 E45：範例（能匯入也能匯出）、ai-dated（只能匯入）都啟用著。
    // 啟動帶了 --export-dir：匯出、試跑的「存一份看看」不跳存檔視窗。期望值＝範例自己的 write 對資料夾裡的紀錄寫出來的
    const data57 = snapshot(picked5);
    const src5 = readSources(picked5);
    const days5 = src5.filter(s => s.src !== 'todo').sort((a, b) => (a.src < b.src ? -1 : 1)).map(s => ({ date: s.src, text: s.text }));
    const all5 = fmts.exportData({ title: 'T', from: days5[0].date, to: days5[days5.length - 1].date, all: true, days: days5, todo: src5.find(s => s.src === 'todo').text });
    const want57 = require(path.join(EXAMPLE, 'index.js')).formats['dated-txt'].write(all5);
    ok('E57 前提：資料夾裡有好幾天、有待處理', all5.days.length >= 2 && !!all5.todo && all5.todo.entries.length > 0, JSON.stringify(all5.days.map(d => d.date)));
    const opts5 = () => w5.$$eval('#expFmt option', os => os.map(o => [o.value, o.textContent]));
    await viaSettings(w5, '#exportBtn');
    ok('E57 匯出的下拉選單：內建兩種＋已啟用擴充的匯出格式（只能匯入的 ai-dated 不列）', await waitFor(async () => (await opts5()).length === 3)
      && same(await opts5(), [['daybook-md', 'daybook Markdown（.md）'], ['xlsx', 'Excel（.xlsx）'], ['daybook-example-dated/dated-txt', '日期分隔純文字（.txt，擴充「範例：日期分隔純文字」）']]),
      JSON.stringify(await opts5()));
    await w5.selectOption('#expFmt', 'daybook-example-dated/dated-txt');
    await w5.click('#expAll');
    const f57 = path.join(export5, `工作紀錄_全部_${localToday()}.txt`);
    ok('E57 用範例擴充匯出全部：寫出 .txt，內容＝範例的 write 寫出來的（在擴充程序跑）', await waitFor(() => readN(f57) === want57, 8000), JSON.stringify(readN(f57)));
    await w5.click('#expClose');

    // 請 AI 寫匯出格式（D079）：選「匯出格式」，prompt、說明的字跟著換
    await viaSettings(w5, '#fmtBtn');
    await waitFor(() => visible('#fmt'));
    await w5.check('#fmt input[name="aiKind"][value="export"]');
    ok('E57 選「匯出格式」：頁面上的 prompt 換成匯出的、說明的字換成匯出的', await waitFor(async () => (await w5.textContent('#aiPromptText')) === ai.buildExportPrompt(appV))
      && await visible('#fmt .filesSteps [data-kind="export"]') && !(await visible('#fmt .filesSteps [data-kind="import"]')));
    await w5.click('#aiCopy');
    ok('E57 複製 prompt：複製的是匯出的 prompt', await waitFor(() => readN(clip5) === ai.buildExportPrompt(appV)));
    await w5.fill('#aiReply', reply(exCode));   // 匯入格式的那份
    await w5.click('#aiTry');
    ok('E57 選匯出卻貼匯入格式的：檢查沒通過、寫要有 exportFormats', await waitFor(async () => (await aiText()).includes('這次要寫的是匯出格式：package.json 的 contributes 要有 exportFormats'))
      && !(await visible('#aiInstall')), await aiText());
    // 範例改名、只列 exportFormats 當成 AI 回的
    const outPkg = { ...exPkg, name: 'ai-out', displayName: 'AI：匯出', contributes: { exportFormats: [{ ...exPkg.contributes.exportFormats[0], label: 'AI 匯出' }] } };
    await w5.fill('#aiReply', `${ai.PKG_MARK}\n${JSON.stringify(outPkg, null, 2)}\n${ai.CODE_MARK}\n${exCode}`);
    await w5.click('#aiTry');
    const wl = want57.replace(/\n$/, '').split('\n');
    ok('E57 匯出格式試跑通過：預覽寫格式、拿全部的紀錄（天數＋待處理）、文字幾行、匯出的開頭；還沒裝',
      await waitFor(async () => (await visible('#aiInstall')) && (await aiText()).includes(`試跑：拿資料夾裡全部的紀錄（${all5.days.length} 天＋待處理）匯出`))
      && (await aiText()).includes('匯出格式：AI 匯出（.txt，') && (await aiText()).includes(`文字 ${wl.length} 行`)
      && (await w5.textContent('#aiResult .aiDay pre')) === wl.slice(0, 30).join('\n') + (wl.length > 30 ? `\n…（還有 ${wl.length - 30} 行）` : '')
      && !fs.existsSync(path.join(extRoot, 'ai-out')), await aiText());
    await w5.click('#aiResult .aiSave');
    const fTry = path.join(export5, '工作紀錄_試跑.txt');
    ok('E57 「存一份看看…」：存的是試跑匯出的那一份、提示寫存到哪', await waitFor(() => readN(fTry) === want57) && await waitFor(async () => (await toast5()).includes(fTry)),
      JSON.stringify(readN(fTry)));
    await w5.click('#aiInstall');
    ok('E57 安裝並啟用：清單上已啟用、設定檔記下、提示寫在「匯出…」選', await waitFor(async () => (await stateOf('ai-out') || [])[0] === 'enabled')
      && settings5().extensions['ai-out'] === outPkg.version && (await aiText()).includes('已安裝並啟用「AI：匯出」：之後在齒輪「設定」的「匯出…」選這個格式'), await aiText());
    await w5.check('#fmt input[name="aiKind"][value="import"]');
    ok('E57 換回「匯入格式」：prompt 換回匯入的、結果收起來', await waitFor(async () => (await w5.textContent('#aiPromptText')) === ai.buildPrompt(appV)) && !(await visible('#aiResult')));
    await w5.keyboard.press('Escape');
    await viaSettings(w5, '#exportBtn');
    ok('E57 裝好的匯出格式出現在下拉選單', await waitFor(async () => (await opts5()).some(([k, t]) => k === 'ai-out/dated-txt' && t === 'AI 匯出（.txt，擴充「AI：匯出」）')),
      JSON.stringify(await opts5()));
    ok('E57 匯出、試跑、安裝都不動資料資料夾', same(snapshot(picked5), data57));

    // E58：刪擴充（見 開發筆記 D081，照外觀包的 D073）——接著 E57：範例、ai-dated、ai-out 啟用著，d-throws 未啟用，b-new 版本不合，c-broken 壞掉。
    // 啟動帶了 --trash-dir：刪除改成搬進那個資料夾
    await w5.click('#expClose');   // 收起 E57 打開的匯出列
    await viaSettings(w5, '#fmtBtn');
    await waitFor(() => visible('#fmt'));
    await openExts();
    const delBox = name => row(name) + ' .extConfirm[data-kind="del"]';
    await w5.click(row('c-broken') + ' [data-act="delAsk"]');
    ok('E58 壞掉的按「刪除」：先展開提醒（寫資源回收筒、資料夾名稱），「刪除」收起來，資料夾還在',
      await visible(delBox('c-broken')) && (await w5.textContent(delBox('c-broken'))).includes('丟到資源回收筒') && (await w5.textContent(delBox('c-broken'))).includes('（c-broken）')
      && !(await visible(row('c-broken') + ' [data-act="delAsk"]')) && fs.existsSync(path.join(extRoot, 'c-broken')));
    await w5.click(delBox('c-broken') + ' [data-act="delCancel"]');
    ok('E58 取消：收起來、「刪除」回來、資料夾還在', !(await visible(delBox('c-broken'))) && await visible(row('c-broken') + ' [data-act="delAsk"]')
      && fs.existsSync(path.join(extRoot, 'c-broken')));
    // 一次只開一塊：開著「確定啟用」時按「刪除」，換成「確定刪除」
    await w5.click(row('d-throws') + ' [data-act="ask"]');
    await w5.click(row('d-throws') + ' [data-act="delAsk"]');
    ok('E58 開著「確定啟用」再按「刪除」：換成「確定刪除」，「啟用」回來', await visible(delBox('d-throws'))
      && !(await visible(row('d-throws') + ' .extConfirm[data-kind="on"]')) && await visible(row('d-throws') + ' [data-act="ask"]'));
    await w5.click(delBox('d-throws') + ' [data-act="delCancel"]');
    await w5.click(row('c-broken') + ' [data-act="delAsk"]');
    await w5.click(delBox('c-broken') + ' [data-act="del"]');
    ok('E58 確定刪除：整個資料夾搬走、清單上沒了、提示已丟到資源回收筒', await waitFor(async () => (await w5.$$(row('c-broken'))).length === 0)
      && !fs.existsSync(path.join(extRoot, 'c-broken')) && fs.existsSync(path.join(trash5, 'c-broken'))
      && await waitFor(async () => (await toast5()).includes('已丟到資源回收筒：c-broken')), await toast5());
    // 刪啟用中的：設定檔一起拿掉（不然之後放進同名的會自己變成已啟用），其他啟用的不動
    const enabled58 = settings5().extensions;
    await w5.click(row('ai-out') + ' [data-act="delAsk"]');
    await w5.click(delBox('ai-out') + ' [data-act="del"]');
    ok('E58 刪啟用中的 ai-out：資料夾整個搬走（救得回來）、設定檔拿掉它、其他啟用的不動',
      await waitFor(async () => (await w5.$$(row('ai-out'))).length === 0) && fs.existsSync(path.join(trash5, 'ai-out', 'index.js')) && fs.existsSync(path.join(trash5, 'ai-out', 'package.json'))
      && !!enabled58['ai-out'] && same(settings5().extensions, Object.fromEntries(Object.entries(enabled58).filter(([k]) => k !== 'ai-out'))), JSON.stringify(settings5().extensions));
    await w5.keyboard.press('Escape');
    await w5.keyboard.press('Escape');
    await viaSettings(w5, '#exportBtn');
    ok('E58 刪掉的匯出格式從下拉選單拿掉', await waitFor(async () => (await opts5()).length === 3 && !(await opts5()).some(([k]) => k.startsWith('ai-out/'))), JSON.stringify(await opts5()));
    ok('E58 刪擴充不動資料資料夾', same(snapshot(picked5), data57));
  } finally {
    await app5.close();
  }

  // E46：外觀包（見 開發筆記 D062）——設定資料夾的 skins\ 放一個兩種圖都有的、一個壞掉的（沒有 package.json）；
  // 資料夾是空的：已處理、待處理都是空白的那一行，才看得到插圖
  const ud6 = path.join(tmpRoot, 'profile6');
  const picked6 = path.join(tmpRoot, 'picked6');
  const skinRoot = path.join(ud6, 'skins');
  const sloth = path.join(skinRoot, 'a-sloth');
  fs.mkdirSync(picked6);
  fs.mkdirSync(sloth, { recursive: true });
  fs.mkdirSync(path.join(skinRoot, 'b-broken'));
  fs.writeFileSync(path.join(ud6, 'settings.json'), JSON.stringify({ dataDir: picked6 }));
  const png6 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');   // 1×1 的 png
  fs.writeFileSync(path.join(sloth, 'bg.png'), png6);
  fs.writeFileSync(path.join(sloth, 'empty.png'), png6);
  const appV6 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(sloth, 'package.json'), JSON.stringify({ name: 'a-sloth', displayName: '樹懶', version: '1.0.0', engines: { daybook: '^' + appV6 },
    contributes: { skin: { background: { image: 'bg.png', opacity: 0.3 }, empty: { image: 'empty.png' } } } }));
  const url6 = 'data:image/png;base64,' + png6.toString('base64');
  const open6 = path.join(tmpRoot, 'open6.log');
  const trash6 = path.join(tmpRoot, 'trash6');   // E53：刪除的外觀包搬到這裡，不丟使用者的資源回收筒（見 開發筆記 D073）
  fs.mkdirSync(trash6);
  const app6 = await launch(pw, ['--user-data', ud6, '--open-log', open6, '--trash-dir', trash6]);
  try {
    const w6 = app6.page;
    const settings6 = () => { try { return JSON.parse(fs.readFileSync(path.join(ud6, 'settings.json'), 'utf8')); } catch { return null; } };
    const visible = sel => w6.isVisible(sel).catch(() => false);
    const srow = name => `#skinTable tr[data-skin="${name}"]`;
    const sstate = name => w6.$eval(srow(name) + ' .extState', e => [e.dataset.state, e.textContent]).catch(() => null);
    // 外觀包清單另開一張（見 開發筆記 D085）：外觀頁開著時按「管理外觀包…」
    const openSkins = async () => { await w6.click('#skinManage'); await waitFor(() => visible('#skinList')); };
    const shownSkins = () => w6.$$eval('#skinTable tr', trs => trs.filter(t => !t.hidden).map(t => t.dataset.skin));
    // 背景圖：有沒有顯示、放的圖、多濃、亮暗的 filter；空白時的插圖：放的圖、真的載得出來（CSP 擋 data: 的話 naturalWidth 是 0）
    // 一張背景圖一層（D067）：這個外觀包只有一張，看第一層
    const bg6 = () => w6.$eval('#skinBg', e => {
      const l = e.firstElementChild;
      return { shown: !e.hidden, layers: e.children.length, image: l ? l.style.backgroundImage : '', opacity: l ? l.style.opacity : '', filter: getComputedStyle(e).filter, pe: getComputedStyle(l || e).pointerEvents };
    });
    const empties6 = () => w6.$$eval('.empty .skinEmpty', imgs => imgs.map(i => ({ src: i.src, loaded: i.complete && i.naturalWidth > 0, pane: i.closest('.cardList').id })));
    await waitFor(async () => (await w6.$$('#cards .empty')).length > 0, 8000);

    ok('E46 還沒啟用：沒有背景圖、空白的那一行沒有插圖', !(await bg6()).shown && (await empties6()).length === 0);
    ok('E46 「外觀…」在齒輪「設定」選單裡「格式…」後面；右上角「說明」還是最後一顆、緊接在黑暗模式後面（D092）', (await w6.$$('#settingsMenu #fmtBtn + #skinBtn')).length === 1
      && (await w6.textContent('#skinBtn')) === '外觀…' && (await w6.$$('#themeBtn + #infoBtn')).length === 1 && (await w6.$$('#infoBtn + *')).length === 0);
    await viaSettings(w6, '#skinBtn');
    await waitFor(() => visible('#skin'));
    ok('E61 外觀頁上只有摘要：已裝 2 個、沒有啟用；清單那張還沒開', (await w6.textContent('#skinSum')) === '已裝 2 個、沒有啟用' && !(await visible('#skinList')),
      await w6.textContent('#skinSum'));
    await openSkins();
    ok('E61 按「管理外觀包…」：清單那張蓋上來、游標在搜尋框，外觀頁還在底下', await visible('#skin')
      && (await w6.evaluate(() => document.activeElement.id)) === 'skinFind' && (await w6.textContent('#skinList h2')) === '外觀包');
    ok('E46 外觀包資料夾＝設定資料夾的 skins', (await w6.textContent('#fSkins')) === skinRoot, await w6.textContent('#fSkins'));
    ok('E46 兩個照資料夾名稱排，壞掉的用資料夾名稱', same(await w6.$$eval('#skinTable tr', trs => trs.map(t => t.dataset.skin)), ['a-sloth', 'b-broken'])
      && !(await visible('#skinNone')));
    const ss = await sstate('a-sloth'), sb6 = await sstate('b-broken');
    ok('E46 狀態：未啟用、列名稱版本和有哪些圖；壞掉的寫原因、沒有啟用／停用（只有刪除，D073）',
      ss[0] === 'disabled' && ss[1] === '未啟用' && (await w6.textContent(srow('a-sloth'))).includes('樹懶 1.0.0') && (await w6.textContent(srow('a-sloth'))).includes('有：背景圖、空白時的插圖')
      && sb6[0] === 'broken' && sb6[1].includes('沒有 package.json')
      && same(await w6.$$eval(srow('b-broken') + ' .extBtn', bs => bs.filter(b => !b.closest('.extConfirm')).map(b => b.dataset.act)), ['ask']), JSON.stringify([ss, sb6]));
    ok('E46 手寫 package.json 的說明拿掉了（D068）', (await w6.$$('#skinSample')).length === 0 && !(await w6.textContent('#skin')).includes('自己寫 package.json'));
    await w6.click('#skinList .openBtn[data-open="skins"]');
    ok('E46 外觀包資料夾的「開啟位置」', await waitFor(() => (readN(open6) || '').trim() === skinRoot), readN(open6));
    await w6.fill('#skinFind', '樹懶');
    ok('E61 外觀包搜尋：名稱（displayName）對得上的才列', await waitFor(async () => same(await shownSkins(), ['a-sloth'])) && !(await visible('#skinNoHit')), JSON.stringify(await shownSkins()));
    await w6.fill('#skinFind', '沒有這個');
    ok('E61 外觀包搜尋：都不符合寫「沒有符合的外觀包」', await waitFor(async () => same(await shownSkins(), [])) && await visible('#skinNoHit'));
    await w6.fill('#skinFind', '');

    // 啟用：按一下就換上（只有圖，不用再確定）
    await w6.click(srow('a-sloth') + ' [data-act="on"]');
    ok('E46 啟用：變成已啟用、有「停用」，設定檔記下名稱、資料夾沒動',
      await waitFor(async () => (await sstate('a-sloth') || [])[0] === 'enabled') && await visible(srow('a-sloth') + ' [data-act="off"]')
      && settings6().skin === 'a-sloth' && settings6().dataDir === picked6, JSON.stringify(settings6()));
    const b1 = await bg6();
    ok('E46 背景圖蓋上來：放的是外觀包的圖、照 opacity、點得穿過去', b1.shown && b1.image === `url("${url6}")` && b1.opacity === '0.3' && b1.pe === 'none', JSON.stringify({ ...b1, image: b1.image.slice(0, 40) }));
    ok('E46 空白時的插圖：已處理、待處理都有，載得出來', await waitFor(async () => same((await empties6()).map(i => [i.pane, i.src, i.loaded]), [['cards', url6, true], ['todoCards', url6, true]])),
      JSON.stringify((await empties6()).map(i => [i.pane, i.loaded])));
    await w6.keyboard.press('Escape');
    ok('E61 Esc 先只關清單那張、回到外觀頁；摘要寫用的是哪一個', await waitFor(async () => !(await visible('#skinList'))) && await visible('#skin')
      && (await w6.textContent('#skinSum')) === '已裝 2 個、用的是「樹懶」', await w6.textContent('#skinSum'));
    await w6.keyboard.press('Escape');
    ok('E46 Esc 關掉外觀頁', await waitFor(async () => !(await visible('#skin'))));
    ok('E46 背景圖底下的輸入框點得到', await w6.evaluate(() => { const r = document.getElementById('newTitle').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).id; }) === 'newTitle');

    // 亮暗共用一張：黑暗模式下暗一點。用右上角的鈕切到指定的那個（沒切過時跟系統，按一下不一定是哪個）
    const setTheme6 = async t => {
      for (let i = 0; i < 2 && (await w6.evaluate(() => document.documentElement.dataset.theme)) !== t; i++) await w6.click('#themeBtn');
    };
    await setTheme6('light');
    ok('E46 淺色模式背景圖不調暗', (await bg6()).filter === 'none', (await bg6()).filter);
    await setTheme6('dark');
    ok('E46 黑暗模式背景圖暗一點、還是同一張', (await bg6()).filter === 'brightness(0.6)' && (await bg6()).image === `url("${url6}")`, (await bg6()).filter);
    await setTheme6('light');

    // 重新載入：一開就換好
    await w6.reload();
    await waitFor(async () => (await w6.$$('#cards .empty')).length > 0, 8000);
    ok('E46 重新載入：背景圖、插圖一開就在', (await bg6()).shown && await waitFor(async () => (await empties6()).length === 2));

    // 停用：回到原本的樣子
    await viaSettings(w6, '#skinBtn');
    await waitFor(() => visible('#skin'));
    await openSkins();
    await w6.click(srow('a-sloth') + ' [data-act="off"]');
    ok('E46 停用：變回未啟用、設定檔拿掉、背景圖和插圖都不見', await waitFor(async () => (await sstate('a-sloth') || [])[0] === 'disabled')
      && settings6().skin === null && !(await bg6()).shown && await waitFor(async () => (await empties6()).length === 0), JSON.stringify(settings6()));

    // 啟用中的外觀包壞掉（圖被刪了）：照原本的樣子開、不報錯，頁面上寫原因
    await w6.click(srow('a-sloth') + ' [data-act="on"]');
    await waitFor(async () => (await sstate('a-sloth') || [])[0] === 'enabled');
    fs.unlinkSync(path.join(sloth, 'bg.png'));
    await w6.reload();
    await waitFor(async () => (await w6.$$('#cards .empty')).length > 0, 8000);
    ok('E46 啟用的外觀包壞掉：沒有背景圖、沒有插圖、沒跳錯誤', !(await bg6()).shown && (await empties6()).length === 0 && !(await visible('#toast')));
    await viaSettings(w6, '#skinBtn');
    await waitFor(() => visible('#skin'));
    await openSkins();
    ok('E46 壞掉的寫原因', ((await sstate('a-sloth')) || [])[0] === 'broken' && (await sstate('a-sloth'))[1].includes('找不到圖檔 bg.png'), JSON.stringify(await sstate('a-sloth')));

    // E53：刪除外觀包（見 開發筆記 D073）——先問一次再丟資源回收筒；啟動帶 --trash-dir，搬進暫存資料夾，不碰使用者的資源回收筒。
    // 把圖放回去、重新載入：a-sloth 是啟用中、好的；b-broken 壞掉的
    fs.writeFileSync(path.join(sloth, 'bg.png'), png6);
    await w6.reload();
    await waitFor(async () => (await bg6()).shown, 8000);
    await viaSettings(w6, '#skinBtn');
    await waitFor(() => visible('#skin'));
    await openSkins();
    const frow = f => `#skinTable tr[data-folder="${f}"]`;
    await w6.click(frow('b-broken') + ' [data-act="ask"]');
    ok('E53 按「刪除」：先問（寫丟到資源回收筒）、「刪除」收起來、資料夾還在',
      await visible(frow('b-broken') + ' .extConfirm') && (await w6.textContent(frow('b-broken') + ' .extConfirm')).includes('資源回收筒')
      && !(await visible(frow('b-broken') + ' [data-act="ask"]')) && fs.existsSync(path.join(skinRoot, 'b-broken')));
    await w6.click(frow('b-broken') + ' [data-act="cancel"]');
    ok('E53 取消：收起來、「刪除」回來、資料夾還在', !(await visible(frow('b-broken') + ' .extConfirm')) && await visible(frow('b-broken') + ' [data-act="ask"]')
      && fs.existsSync(path.join(skinRoot, 'b-broken')));
    await w6.click(frow('b-broken') + ' [data-act="ask"]');
    await w6.click(frow('b-broken') + ' [data-act="del"]');
    ok('E53 確定刪除（壞掉的也能刪）：資料夾整個搬走、清單上沒了、啟用中的不受影響',
      await waitFor(async () => (await w6.$$(frow('b-broken'))).length === 0) && !fs.existsSync(path.join(skinRoot, 'b-broken')) && fs.existsSync(path.join(trash6, 'b-broken'))
      && settings6().skin === 'a-sloth' && (await bg6()).shown, JSON.stringify(settings6()));
    ok('E53 提示寫丟到資源回收筒', await waitFor(async () => ((await w6.textContent('#toast').catch(() => '')) || '').includes('已丟到資源回收筒')));
    await w6.click(frow('a-sloth') + ' [data-act="ask"]');
    await w6.click(frow('a-sloth') + ' [data-act="del"]');
    ok('E53 刪掉啟用中的：一起停用（設定檔拿掉）、背景圖和插圖不見、清單空了',
      await waitFor(async () => !(await bg6()).shown) && settings6().skin === null && await waitFor(async () => (await empties6()).length === 0)
      && await visible('#skinNone') && (await w6.$$('#skinTable tr')).length === 0, JSON.stringify(settings6()));
    ok('E53 搬走的是整個資料夾、檔案都在（救得回來）', ['package.json', 'bg.png', 'empty.png'].every(f => fs.existsSync(path.join(trash6, 'a-sloth', f))));
  } finally {
    await app6.close();
  }

  // E49：用圖檔做一個外觀包（見 開發筆記 D066、D067）——白底中間一塊紅的 png，--pick-image 選圖不跳視窗；
  // 第一張背景圖去背、放右下角、40%、濃淡 50%；第二張不去背、左上、20%、80%；插圖用原檔，建立並啟用。資料夾是空的：才看得到插圖
  const ud9 = path.join(tmpRoot, 'profile9');
  const picked9 = path.join(tmpRoot, 'picked9');
  fs.mkdirSync(picked9);
  fs.mkdirSync(ud9);
  fs.writeFileSync(path.join(ud9, 'settings.json'), JSON.stringify({ dataDir: picked9 }));
  const img9 = path.join(tmpRoot, 'pick9.png');
  const png9 = makePng(40, 30, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 20 ? [200, 0, 0, 255] : [255, 255, 255, 255]));
  fs.writeFileSync(img9, png9);
  const url9 = 'data:image/png;base64,' + png9.toString('base64');
  const app9 = await launch(pw, ['--user-data', ud9, '--pick-image', img9]);
  try {
    const w9 = app9.page;
    const visible = sel => w9.isVisible(sel).catch(() => false);
    const bg = i => `#mkBgList > .mkPart:nth-child(${i})`;   // 第 i 張背景圖那格
    const em = '#mk .mkPart[data-part="empty"]';
    const thumb = sel => w9.getAttribute(sel + ' .mkThumb', 'src');
    const bgCount = async () => (await w9.$$('#mkBgList > .mkPart')).length;
    // 縮圖某幾點的透明度：畫回 canvas 讀
    const alphas = (sel, pts) => w9.$eval(sel + ' .mkThumb', async (img, pts) => {
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return pts.map(([x, y]) => g.getImageData(x, y, 1, 1).data[3]);
    }, pts);
    const slide = (sel, v) => w9.$eval(sel, (e, v) => { e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    // 背景圖一張一層（D067）：每一層的圖、位置、大小、濃淡
    const layersOf = sel => w9.$eval(sel, e => [...e.children].map(l => ({ image: l.style.backgroundImage, pos: l.style.backgroundPosition, size: l.style.backgroundSize, opacity: l.style.opacity })));
    await waitFor(async () => (await w9.$$('#cards .empty')).length > 0, 8000);
    await viaSettings(w9, '#skinBtn');
    await waitFor(() => visible('#skin'));
    ok('E49 還沒選圖：「建立並啟用」按不了、沒有背景圖的格子、沒有小畫面、插圖那段收著',
      await w9.isDisabled('#mkCreate') && (await bgCount()) === 0 && !(await visible('#mkScreenRow')) && !(await visible(em + ' .mkBody')) && (await w9.textContent('#mkBgAdd')) === '選圖…');

    await w9.click('#mkBgAdd');
    ok('E49 選了背景圖：多一格「第 1 張」、寫檔名、縮圖是原檔、可以建立；按鈕變「再加一張」',
      await waitFor(async () => (await bgCount()) === 1 && (await thumb(bg(1))) === url9)
      && (await w9.textContent(bg(1) + ' .mkNo')) === '第 1 張' && (await w9.textContent(bg(1) + ' .mkFile')) === 'pick9.png' && !(await w9.isDisabled('#mkCreate'))
      && (await w9.textContent('#mkBgAdd')) === '＋ 再加一張…', await w9.textContent(bg(1) + ' .mkFile'));
    await w9.check(bg(1) + ' .mkCut');
    ok('E49 去背：縮圖換成 png，邊緣的白變透明、中間的紅留著', await waitFor(async () => (await thumb(bg(1))) !== url9)
      && same(await alphas(bg(1), [[0, 0], [39, 29], [5, 15], [20, 15], [10, 10]]), [0, 0, 0, 255, 255]), JSON.stringify(await alphas(bg(1), [[0, 0], [39, 29], [5, 15], [20, 15], [10, 10]])));
    const cut9 = await thumb(bg(1));
    ok('E49 鋪滿時大小不用調', await w9.isDisabled(bg(1) + ' .mkSize') && (await w9.textContent(bg(1) + ' .mkSizeV')).includes('鋪滿'));
    await w9.click(bg(1) + ' .mkPos [data-pos="bottom-right"]');
    await slide(bg(1) + ' .mkSize', 40);
    await slide(bg(1) + ' .mkOpacity', 50);
    const L1 = { image: `url("${cut9}")`, pos: 'right bottom', size: '40% auto', opacity: '0.5' };
    ok('E49 小畫面預覽：右下角、40%、50%、放的是去背的圖', await waitFor(async () => same(await layersOf('#mkScreenBg'), [L1]))
      && !(await w9.isDisabled(bg(1) + ' .mkSize')) && (await w9.textContent(bg(1) + ' .mkSizeV')) === '畫面寬的 40%' && (await w9.textContent(bg(1) + ' .mkOpacityV')) === '50%'
      && (await w9.getAttribute(bg(1) + ' .mkPos [data-pos="bottom-right"]', 'class')) === 'on', JSON.stringify((await layersOf('#mkScreenBg')).map(l => ({ ...l, image: '' }))));

    // 第二張：各自的設定，不動到第一張；疊在第一張上面
    await w9.click('#mkBgAdd');
    await waitFor(async () => (await bgCount()) === 2 && (await thumb(bg(2))) === url9);
    await w9.click(bg(2) + ' .mkPos [data-pos="top-left"]');
    await slide(bg(2) + ' .mkSize', 20);
    await slide(bg(2) + ' .mkOpacity', 80);
    const L2 = { image: `url("${url9}")`, pos: 'left top', size: '20% auto', opacity: '0.8' };
    ok('E49 第二張：「第 2 張」、沒勾去背、自己的位置大小濃淡，第一張不變，小畫面兩層照順序',
      await waitFor(async () => same(await layersOf('#mkScreenBg'), [L1, L2])) && (await w9.textContent(bg(2) + ' .mkNo')) === '第 2 張'
      && !(await w9.isChecked(bg(2) + ' .mkCut')) && (await w9.getAttribute(bg(1) + ' .mkPos [data-pos="bottom-right"]', 'class')) === 'on'
      && (await w9.textContent(bg(1) + ' .mkOpacityV')) === '50%', JSON.stringify((await layersOf('#mkScreenBg')).map(l => ({ ...l, image: l.image.slice(0, 30) }))));

    await w9.click(em + ' .mkPick');
    ok('E49 插圖：沒勾去背就是原檔', await waitFor(async () => (await thumb(em)) === url9));
    await w9.fill('#mkName', '測試外觀');
    await w9.click('#mkCreate');
    const dir9 = path.join(ud9, 'skins', '測試外觀');
    ok('E49 建立並啟用：清單上是已啟用、寫兩張、設定檔記下、提示寫做好了', await waitFor(async () => (await w9.$eval('#skinTable tr[data-skin="測試外觀"] .extState', e => e.dataset.state).catch(() => null)) === 'enabled'
      && ((await w9.textContent('#toast')) || '').includes('做好「測試外觀」並啟用了'))
      && (await w9.textContent('#skinTable tr[data-skin="測試外觀"]')).includes('有：背景圖 2 張、空白時的插圖')
      && JSON.parse(fs.readFileSync(path.join(ud9, 'settings.json'), 'utf8')).skin === '測試外觀', await w9.textContent('#toast'));
    ok('E61 建好之後外觀頁的摘要跟著變', (await w9.textContent('#skinSum')) === '已裝 1 個、用的是「測試外觀」', await w9.textContent('#skinSum'));
    const pkg9 = JSON.parse(readN(path.join(dir9, 'package.json')) || 'null');
    ok('E49 資料夾裡：package.json 照設定寫（背景圖是兩張的陣列）、第一張是去背的、第二張和插圖是原檔',
      pkg9 && pkg9.name === '測試外觀' && pkg9.displayName === '測試外觀'
      && same(pkg9.contributes.skin, { background: [{ image: 'background.png', opacity: 0.5, position: 'bottom-right', size: 40 },
        { image: 'background-2.png', opacity: 0.8, position: 'top-left', size: 20 }], empty: { image: 'empty.png' } })
      && 'data:image/png;base64,' + fs.readFileSync(path.join(dir9, 'background.png')).toString('base64') === cut9
      && fs.readFileSync(path.join(dir9, 'background-2.png')).equals(png9) && fs.readFileSync(path.join(dir9, 'empty.png')).equals(png9), JSON.stringify(pkg9));
    ok('E49 背景圖換上：兩層照順序、各自的位置大小濃淡', await waitFor(async () => !(await w9.$eval('#skinBg', e => e.hidden)) && same(await layersOf('#skinBg'), [L1, L2])),
      JSON.stringify((await layersOf('#skinBg')).map(l => ({ ...l, image: l.image.slice(0, 30) }))));
    ok('E49 空白時的插圖換上', await waitFor(async () => same(await w9.$$eval('.empty .skinEmpty', imgs => imgs.map(i => i.src)), [url9, url9])));
    ok('E49 建好之後表單清空', (await bgCount()) === 0 && !(await visible('#mkScreenRow')) && !(await visible(em + ' .mkBody')) && await w9.isDisabled('#mkCreate')
      && (await w9.inputValue('#mkName')) === '我的外觀' && (await w9.textContent('#mkBgAdd')) === '選圖…');

    // 好幾張裡拿掉一張：只拿掉那一格，後面的變「第 1 張」、設定跟著它；全拿掉就不能建立
    await w9.click('#mkBgAdd');
    await waitFor(async () => (await bgCount()) === 1);
    await w9.click(bg(1) + ' .mkPos [data-pos="top"]');
    await w9.click('#mkBgAdd');
    await waitFor(async () => (await bgCount()) === 2);
    await w9.click(bg(1) + ' .mkDrop');
    ok('E49 「不用了」拿掉第一張：剩一格、變「第 1 張」、是原本第二張的設定（鋪滿）、小畫面一層',
      await waitFor(async () => (await bgCount()) === 1) && (await w9.textContent(bg(1) + ' .mkNo')) === '第 1 張'
      && (await w9.getAttribute(bg(1) + ' .mkPos [data-pos="cover"]', 'class')) === 'on' && (await layersOf('#mkScreenBg')).length === 1);
    await w9.click(bg(1) + ' .mkDrop');
    ok('E49 全拿掉：沒有格子、沒有小畫面、不能建立', (await bgCount()) === 0 && !(await visible('#mkScreenRow')) && await w9.isDisabled('#mkCreate'));
  } finally {
    await app9.close();
  }

  // E47：已經有的日子「加進去」（見 開發筆記 D063）——fixture 複本、sample.md 跟 E37 一樣（6 天，其中 1/15、1/22、9/11 已經有）；
  // 啟動帶 --existing 加進去：不跳視窗，當作按了「加進去」
  const ud7 = path.join(tmpRoot, 'profile7');
  const data7 = path.join(tmpRoot, 'data7');
  fs.cpSync(path.join(__dirname, 'fixtures', 'data'), data7, { recursive: true });
  fs.mkdirSync(ud7);
  fs.writeFileSync(path.join(ud7, 'settings.json'), JSON.stringify({ dataDir: data7 }));
  const app7 = await launch(pw, ['--user-data', ud7, '--pick-file', SAMPLE, '--existing', '加進去']);
  try {
    const w7 = app7.page;
    const toast7 = () => w7.textContent('#toast').catch(() => '');
    const day7 = d => readN(path.join(data7, dayPath(d)));
    await waitFor(async () => (await w7.$$('#dayList button')).length > 0, 8000);
    const sampleDays = exp.parse(readN(SAMPLE)).days;
    const sampleText = d => sampleDays.find(x => x.date === d).text;
    const newDays = ['2025-12-29', '2025-12-31', '2026-08-04'];
    const old7 = Object.fromEntries(['2026-01-15', '2026-01-22', '2026-09-11'].map(d => [d, day7(d)]));
    // 每一筆的原文（parseDay 拆的標題＋內容）：daybook Markdown 拆出來的筆跟筆之間空一行，加進去時不一定照抄空行，所以一筆一筆比
    const pieces = t => { const ls = t.split('\n'); return parseDay(t).map(e => ls.slice(e.start, e.end + 1).join('\n')); };
    // sample 那 3 天的每一筆跟 fixture 都不一樣（fixture 1/15 的 TX_Cancel… 跟上一行共用內容，算不同的一筆，D009），全部接在後面
    await viaSettings(w7, '#importBtn');
    ok('E47 加進去：已經有的 3 天，sample 那天的每一筆接在最後面；沒有的 3 天照寫',
      await waitFor(() => Object.keys(old7).every(d => day7(d) != null && same(pieces(day7(d)), [...pieces(old7[d]), ...pieces(sampleText(d))]))
        && newDays.every(d => day7(d) === sampleText(d))),
      Object.keys(old7).map(d => d + ' ' + JSON.stringify(day7(d))).join('\n'));
    ok('E47 提示寫加進幾筆', await waitFor(async () => (await toast7()).includes('匯入 3 天（daybook Markdown）；資料夾裡已經有的 3 天：加進 8 筆（Ctrl+Z')), await toast7());
    // 同一份再匯一次：6 天都已經有、每一筆都一模一樣 → 一個檔都沒變
    const snap7 = snapshot(data7);
    await viaSettings(w7, '#importBtn');
    ok('E47 同一份再匯一次：一筆都不加、一個檔都沒變',
      await waitFor(async () => (await toast7()).includes('匯入 0 天（daybook Markdown）；資料夾裡已經有的 6 天：加進 0 筆，12 筆一模一樣的沒加')) && same(snapshot(data7), snap7), await toast7());
    // 第二次什麼都沒寫，不算一個動作：Ctrl+Z 復原的是第一次
    await w7.click('#dayTitle');
    await w7.keyboard.press('Control+Z');
    ok('E47 Ctrl+Z 整批復原：加進去的拿掉、新的 3 天拿掉', await waitFor(() => Object.keys(old7).every(d => day7(d) === old7[d]) && newDays.every(d => day7(d) == null)), await toast7());
  } finally {
    await app7.close();
  }

  // E70：已處理多一筆就捲到那一筆的頂端（見 開發筆記 D099）——今天先放 30 筆，已處理那塊一定要捲；
  // 新加的每一筆內文 40 行（比那塊高），對齊頂端時捲不到底，分得出「捲到頂端」和「捲到最底」「只捲到看得到（nearest）」。
  // 每次先捲回最上面（新的那筆在看不到的底下），再按：處理完 ↑、已處理+未完標籤、＋ 已處理
  const ud12 = path.join(tmpRoot, 'profile12');
  const data12 = path.join(tmpRoot, 'data12');
  const today12 = localToday();
  const long12 = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`);
  fs.mkdirSync(path.dirname(path.join(data12, dayPath(today12))), { recursive: true });
  fs.writeFileSync(path.join(data12, dayPath(today12)), Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 件事\n\t內容 ${i + 1}\n`).join(''));
  fs.writeFileSync(path.join(data12, TODO_FILE), ['待辦 A', '待辦 B'].map(t => `${t}\n${long12.map(l => '\t' + l).join('\n')}\n`).join(''));
  fs.mkdirSync(ud12);
  fs.writeFileSync(path.join(ud12, 'settings.json'), JSON.stringify({ dataDir: data12 }));
  const app12 = await launch(pw, ['--user-data', ud12]);
  try {
    const w12 = app12.page;
    await waitFor(async () => (await w12.$$('#cards .card')).length === 30, 8000);
    // 最後一張卡片的頂端離清單上緣（扣掉 padding）多遠、捲到哪、最多能捲到哪
    const pos = () => w12.evaluate(() => {
      const list = document.getElementById('cards'), c = list.lastElementChild;
      return { title: c.querySelector('.title').textContent, top: Math.round(c.getBoundingClientRect().top - list.getBoundingClientRect().top - parseFloat(getComputedStyle(list).paddingTop)),
        scroll: Math.round(list.scrollTop), max: list.scrollHeight - list.clientHeight, height: list.clientHeight };
    });
    const toTop = () => w12.evaluate(() => { document.getElementById('cards').scrollTop = 0; });
    const atTop = (p, title) => p.title === title && Math.abs(p.top) <= 1 && p.scroll < p.max - 1;
    const p0 = await pos();
    ok('E70 前提：已處理那塊要捲、捲在最上面時最後一筆看不到', p0.max > 100 && p0.scroll === 0 && p0.top > p0.height, JSON.stringify(p0));
    await w12.locator('.card[data-src="todo"]', { hasText: '待辦 A' }).first().locator('button.done').click();
    ok('E70 處理完 ↑：捲到新的那筆（待辦 A）的頂端', await waitFor(async () => atTop(await pos(), '待辦 A')), JSON.stringify(await pos()));
    await toTop();
    await w12.locator('.card[data-src="todo"]', { hasText: '待辦 B' }).first().locator('button.unfinished').click();
    ok('E70 已處理+未完標籤：捲到新的那筆（待辦 B）的頂端', await waitFor(async () => atTop(await pos(), '待辦 B')), JSON.stringify(await pos()));
    await toTop();
    await w12.fill('#newTitle', '新的一件');
    await w12.fill('#newBody', long12.join('\n'));
    await w12.click('#addDone');
    ok('E70 ＋ 已處理：捲到新的那筆的頂端', await waitFor(async () => atTop(await pos(), '新的一件')), JSON.stringify(await pos()));
    await sleep(500);   // 自己寫檔，150ms 後檔案監看會再重畫一輪（D020、D045）
    ok('E70 檔案監看再重畫一輪：還停在那筆的頂端', atTop(await pos(), '新的一件'), JSON.stringify(await pos()));
  } finally {
    await app12.close();
  }

  // E59：記住視窗大小、位置、最大化（見 開發筆記 D082）——沒記過照預設開，關掉時記下來；改成記 1000×700 再開，照記的開。
  // 用 Windows 的關視窗（WM_CLOSE，跟按 ✕、Alt+F4 一樣）關，才走得到關掉時記；安靜跑時視窗在螢幕外、不能放大（D052），只比大小
  const ud10 = path.join(tmpRoot, 'profile10');
  fs.mkdirSync(ud10);
  const settings10 = path.join(ud10, 'settings.json');
  fs.writeFileSync(settings10, '{}');
  const saved10 = () => { try { return JSON.parse(fs.readFileSync(settings10, 'utf8')).window; } catch { return undefined; } };
  const app10 = await launch(pw, ['--user-data', ud10]);
  try {
    await waitFor(async () => app10.page.isVisible('#setup').catch(() => false), 8000);   // 設定檔沒有資料夾：等畫面載好、出現選資料夾卡片
    // 標題列自己畫（D100）之後沒有原生外框，內容區就是整個視窗；outerWidth/outerHeight 反而比視窗大小多 16×8（量到的）
    const size = await app10.page.evaluate(() => [innerWidth, innerHeight]);
    ok('E59 沒記過：照預設 1400×860', same(size, [1400, 860]), JSON.stringify(size));
    powershell(`[void](Get-Process -Id ${app10.pid}).CloseMainWindow()`);
    ok('E59 關掉時設定檔記下大小、沒放大', await waitFor(() => { const w = saved10(); return !!w && w.width === 1400 && w.height === 860 && w.maximized === false; }), JSON.stringify(saved10()));
  } finally {
    await app10.close();
  }
  fs.writeFileSync(settings10, JSON.stringify({ window: { x: 120, y: 90, width: 1000, height: 700, maximized: false } }));
  const app11 = await launch(pw, ['--user-data', ud10]);
  try {
    await waitFor(async () => app11.page.isVisible('#setup').catch(() => false), 8000);
    const size = await app11.page.evaluate(() => [innerWidth, innerHeight]);
    ok('E59 記了 1000×700：照記的大小開', same(size, [1000, 700]), JSON.stringify(size));
  } finally {
    await app11.close();
  }

  // E131：全域快捷鍵叫出 daybook（見 開發筆記 D169）——--user-data 開（設定檔寫得進去）；測試用 Ctrl+Alt+Shift+F9，不跟使用者自己 daybook 預設的 Alt+` 撞（D170）。
  // 「被佔用」靠另一個 daybook（--data-dir，設定只記在記憶體）登記同一組：OS 真的登記了才撞得到，順便驗關掉、等按鍵時真的放掉了。
  // 真的按下去（叫到前面、再按縮小）要送真的按鍵、會搶焦點，完整跑才測
  {
  const udH = path.join(tmpRoot, 'profileH'), dataH = path.join(tmpRoot, 'dataH'), dataH2 = path.join(tmpRoot, 'dataH2');
  for (const d of [udH, dataH, dataH2]) fs.mkdirSync(d);
  const settingsH = path.join(udH, 'settings.json');
  fs.writeFileSync(settingsH, JSON.stringify({ dataDir: dataH }));
  const savedH = () => { try { return JSON.parse(fs.readFileSync(settingsH, 'utf8')).hotkey; } catch { return undefined; } };
  const KEY = 'Ctrl+Alt+Shift+F9';
  const hk = async w => ({ on: await w.isChecked('#hkOn'), key: await w.textContent('#hkKey'), state: await w.getAttribute('#hkState', 'data-state'), say: await w.textContent('#hkState') });
  const hkIs = (w, want) => waitFor(async () => { const h = await hk(w); return Object.entries(want).every(([k, v]) => h[k] === v); });
  const openHk = async w => {
    await waitFor(() => w.isVisible('#actSettings'), 8000);
    await viaSettings(w, '#hotkeyBtn');
    await waitFor(() => w.isVisible('#hotkey'));
  };
  const setOn = async (w, on) => { if ((await w.isChecked('#hkOn')) !== on) await w.click('#hkOn'); };
  const record = async (w, keys) => { await w.click('#hkRec'); await waitFor(async () => (await w.textContent('#hkRec')) === '取消'); for (const k of keys) await w.keyboard.press(k); };
  const appH = await launch(pw, ['--user-data', udH]);
  let appH2 = null;
  try {
    const w = appH.page;
    await openHk(w);
    ok('E131 「快捷鍵…」在齒輪「設定」的「自訂」最後（語言…後面）', same(await w.$$eval('#settingsMenu [role="group"]:last-child button', bs => bs.map(b => b.id)), ['fmtBtn', 'skinBtn', 'langBtn', 'hotkeyBtn']));
    ok('E131 還沒設過：沒開、鍵是 Alt+`（D170）、寫沒開，設定檔沒寫', await hkIs(w, { on: false, key: 'Alt+`', state: 'off' }) && savedH() === undefined, JSON.stringify([await hk(w), savedH()]));
    await record(w, []);
    ok('E131 按「更改…」：等按鍵（鈕變「取消」、寫要按什麼）', (await w.textContent('#hkKey')) === '按下想用的組合鍵…' && (await hk(w)).say.includes('Alt＋一顆鍵'), JSON.stringify(await hk(w)));
    await w.keyboard.press('Control+KeyQ');
    ok('E131 只按 Ctrl（Ctrl+Q）：不收、寫要 Alt＋一顆或兩個以上，還在等', await hkIs(w, { state: 'why' }) && (await hk(w)).say.startsWith('Ctrl+Q：') && (await w.textContent('#hkRec')) === '取消', JSON.stringify(await hk(w)));
    await w.keyboard.press('Shift+KeyQ');
    ok('E131 只按 Shift（Shift+Q）：也不收', (await hk(w)).say.startsWith('Shift+Q：') && (await w.textContent('#hkRec')) === '取消', JSON.stringify(await hk(w)));
    await w.keyboard.press('Control+Alt+Enter');
    ok('E131 不能用的鍵（Ctrl+Alt+Enter）：不收、寫能用哪些，還在等', (await hk(w)).say.startsWith('這個鍵不能用') && (await w.textContent('#hkRec')) === '取消', JSON.stringify(await hk(w)));
    await w.keyboard.press('Escape');
    ok('E131 等按鍵時 Esc：只取消換鍵（頁還開著），鍵照舊、設定檔沒寫', await hkIs(w, { key: 'Alt+`', state: 'off' }) && await w.isVisible('#hotkey') && savedH() === undefined, JSON.stringify([await hk(w), savedH()]));
    await record(w, ['Alt+KeyJ']);
    ok('E131 Alt＋一顆（Alt+J）：收（D170），設定檔記下', await hkIs(w, { on: false, key: 'Alt+J', state: 'off' }) && same(savedH(), { on: false, key: 'Alt+J' }), JSON.stringify([await hk(w), savedH()]));
    await record(w, ['Alt+Backquote']);
    ok('E131 Alt＋`：收成 Alt+`（跟預設一樣的寫法）', await hkIs(w, { key: 'Alt+`', state: 'off' }) && same(savedH(), { on: false, key: 'Alt+`' }), JSON.stringify([await hk(w), savedH()]));
    await record(w, ['Control+Alt+Shift+F9']);
    ok('E131 按 Ctrl+Alt+Shift+F9：換成它、還是沒開，設定檔記下', await hkIs(w, { on: false, key: KEY, state: 'off' }) && same(savedH(), { on: false, key: KEY }), JSON.stringify([await hk(w), savedH()]));
    await setOn(w, true);
    ok('E131 勾「開啟」：登記好了（寫在別的程式按 Ctrl+Alt+Shift+F9 試試）、設定檔 on', await hkIs(w, { on: true, state: 'ok' }) && (await hk(w)).say.includes(KEY) && same(savedH(), { on: true, key: KEY }), JSON.stringify([await hk(w), savedH()]));

    // 另一個 daybook 登記同一組：被佔用
    appH2 = await launch(pw, ['--data-dir', dataH2]);
    const w2 = appH2.page;
    await openHk(w2);
    await record(w2, ['Control+Alt+Shift+F9']);
    await setOn(w2, true);
    ok('E131 另一個 daybook 也登記 Ctrl+Alt+Shift+F9：寫被別的程式佔用了', await hkIs(w2, { on: true, key: KEY, state: 'taken' }) && (await hk(w2)).say.includes('被別的程式佔用'), JSON.stringify(await hk(w2)));
    await setOn(w, false);
    ok('E131 第一個取消勾選：寫沒開、設定檔 on 是 false', await hkIs(w, { on: false, state: 'off' }) && same(savedH(), { on: false, key: KEY }), JSON.stringify([await hk(w), savedH()]));
    await setOn(w2, false);
    await setOn(w2, true);
    ok('E131 第一個關掉後：另一個重新勾就登記得到（第一個真的放掉了）', await hkIs(w2, { on: true, state: 'ok' }), JSON.stringify(await hk(w2)));
    await setOn(w, true);
    ok('E131 換第一個勾：被另一個佔用', await hkIs(w, { on: true, state: 'taken' }), JSON.stringify(await hk(w)));
    await record(w2, []);
    await setOn(w, false);
    await setOn(w, true);
    ok('E131 另一個在等按鍵時：登記的那組先放掉（第一個登記得到）', await hkIs(w, { on: true, state: 'ok' }), JSON.stringify(await hk(w)));
    await w2.keyboard.press('Escape');
    ok('E131 另一個取消換鍵：登記回去，這時被第一個佔用', await hkIs(w2, { on: true, key: KEY, state: 'taken' }), JSON.stringify(await hk(w2)));
    await w.keyboard.press('Escape');
    ok('E131 Esc 關掉快捷鍵頁', await waitFor(async () => !(await w.isVisible('#hotkey'))));
  } finally {
    if (appH2) await appH2.close();
    await appH.close();
  }
  const appH3 = await launch(pw, ['--user-data', udH]);
  try {
    const w = appH3.page;
    await openHk(w);
    ok('E131 再開一次：照設定檔開著 Ctrl+Alt+Shift+F9、一開起來就登記好', await hkIs(w, { on: true, key: KEY, state: 'ok' }), JSON.stringify(await hk(w)));
    await w.keyboard.press('Escape');
    if (FULL) {
      // 真的按：送 Ctrl+Alt+Shift+F9（keybd_event）。先把 daybook 縮小 → 按了要還原、到最前面；再按 → 縮小、最前面換成別的
      const user32 = 'Add-Type -Name K -Namespace U -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e); '
        + '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);\'; ';
      const hwnd = `(Get-Process -Id ${appH3.pid}).MainWindowHandle`;
      const press = () => powershell(user32 + '$k = 0x11, 0x12, 0x10, 0x78; foreach ($v in $k) { [U.K]::keybd_event($v, 0, 0, [UIntPtr]::Zero) }; [array]::Reverse($k); foreach ($v in $k) { [U.K]::keybd_event($v, 0, 2, [UIntPtr]::Zero) }');
      const iconic = () => powershell(user32 + `[U.K]::IsIconic(${hwnd})`).toString().trim() === 'True';
      powershell(user32 + `[void][U.K]::ShowWindow(${hwnd}, 6)`);   // SW_MINIMIZE
      ok('E131 完整跑：前提，daybook 縮小了', await waitFor(() => iconic()));
      press();
      ok('E131 完整跑：真的按 Ctrl+Alt+Shift+F9，縮小的 daybook 還原、到最前面', await waitFor(() => !iconic() && foregroundPid() === appH3.pid), `最前面的程序 ${foregroundPid()}，daybook ${appH3.pid}`);
      press();
      ok('E131 完整跑：在最前面再按，縮小、最前面換成別的', await waitFor(() => iconic() && foregroundPid() !== appH3.pid), `最前面的程序 ${foregroundPid()}，daybook ${appH3.pid}`);
    }
  } finally {
    await appH3.close();
  }
  }

  // E89～E94：截圖（見 開發筆記 D129）——設定檔指定截圖資料夾（暫存的），--shot-image 用一張假的「螢幕」代替抓真的螢幕（不截到使用者的畫面）；
  // 複製寫進 --clipboard-file、清掉 N 天前的搬進 --trash-dir、開啟資料夾寫進 --open-log、變更資料夾用 --pick-shot-dir、列印印成 PDF 寫進 --print-pdf（D142）
  const ud13 = path.join(tmpRoot, 'profile13'), data13 = path.join(tmpRoot, 'data13');
  const shots13 = path.join(tmpRoot, 'shots13'), shots13b = path.join(tmpRoot, 'shots13b');
  const clip13 = path.join(tmpRoot, 'clip13.bin'), trash13 = path.join(tmpRoot, 'trash13'), open13 = path.join(tmpRoot, 'open13.log');
  const pdf13 = path.join(tmpRoot, 'print13.pdf');
  // 印出來的 PDF：幾頁、裡面的圖幾 × 幾（Chromium 存的 PDF 字典沒壓縮，直接找 /Type /Page、/Subtype /Image 那段的 /Width /Height）
  const pdfInfo = f => {
    const s = fs.readFileSync(f).toString('latin1');
    const imgs = [...s.matchAll(/\/Subtype\s*\/Image/g)].map(m => {
      const near = s.slice(Math.max(0, s.lastIndexOf('<<', m.index)), s.indexOf('>>', m.index) + 2);
      return `${(near.match(/\/Width\s+(\d+)/) || [])[1]}x${(near.match(/\/Height\s+(\d+)/) || [])[1]}`;
    });
    return { pages: (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length, imgs };
  };
  const screen13 = path.join(tmpRoot, 'screen13.png');
  // 假的螢幕 400×300：左半紅、右半藍，(100,100) 起 40×40 綠——驗切的位置對、顏色沒有 R/B 對調（主程序給的是 BGRA）
  fs.writeFileSync(screen13, makePng(400, 300, (x, y) => (x >= 100 && x < 140 && y >= 100 && y < 140 ? [0, 255, 0, 255] : x < 200 ? [255, 0, 0, 255] : [0, 0, 255, 255])));
  const tiny = makePng(8, 6, () => [200, 200, 200, 255]);
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  // 原本就有的：編號的（30、10 天前、今天）、不是編號的、保留的（40 天前）
  for (const [f, ago] of [['400.png', 30], ['401.png', 10], ['638.png', 0], ['說明.png', 30], ['保留/舊的.png', 40]]) {
    const p = path.join(shots13, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, tiny);
    fs.utimesSync(p, daysAgo(ago), daysAgo(ago));
  }
  for (const d of [data13, ud13, trash13]) fs.mkdirSync(d);
  const settings13 = path.join(ud13, 'settings.json');
  fs.writeFileSync(settings13, JSON.stringify({ dataDir: data13, shotDir: shots13 }));
  const set13 = () => JSON.parse(fs.readFileSync(settings13, 'utf8'));
  const app13 = await launch(pw, ['--user-data', ud13, '--shot-image', screen13, '--clipboard-file', clip13, '--trash-dir', trash13, '--open-log', open13, '--pick-shot-dir', shots13b, '--print-pdf', pdf13]);
  try {
    const w = app13.page;
    const names = () => w.$$eval('#shotView .shot', els => els.map(e => e.querySelector('.shot-name').textContent));
    const heads = () => w.$$eval('#shotView h3', els => els.map(e => e.textContent));
    const toast13 = () => w.textContent('#toast');
    const shotCard = rel => w.locator(`#shotView .shot[data-rel="${rel}"]`);
    const shotBtn = async (rel, cls) => { await shotCard(rel).hover(); await shotCard(rel).locator(cls).click(); };   // 滑過才出現的鈕
    await w.click('#actShot');
    ok('E89 頁籤列「截圖」：中間換成截圖頁、日記和左欄藏起來、頁籤亮起來', await waitFor(async () => await w.isVisible('#shotPane') && !(await w.isVisible('#center'))
      && !(await w.isVisible('#days')) && (await w.getAttribute('#actShot', 'class') || '').includes('on')));
    ok('E89 保留在最上面，編號的照日期分段、新的在前；不是編號的 .png 不列', await waitFor(async () => same(await names(), ['舊的', '638', '401', '400'])), JSON.stringify(await names()));
    const h13 = await heads();
    ok('E89 每段的小標：保留、日期（星期）· 幾張', h13.length === 4 && h13[0] === '保留 · 1 張' && h13[1].startsWith(localToday() + '（') && h13[1].endsWith(' · 1 張')
      && h13[3].startsWith(localIso(daysAgo(30)) + '（'), JSON.stringify(h13));
    // 保留那段可以收起來（D142）：預設收起來，點小標打開，開著記在這台電腦（重畫之後還開著見 E91）
    const kept13 = () => w.evaluate(() => { const d = document.querySelector('#shotView details'); return d && { open: d.open, head: d.querySelector('summary h3')?.textContent }; });
    ok('E89 保留那段預設收起來：小標還在、卡片看不到，編號的看得到', same(await kept13(), { open: false, head: '保留 · 1 張' })
      && await shotCard('保留/舊的.png').isHidden() && await shotCard('638.png').isVisible(), JSON.stringify(await kept13()));
    await w.click('#shotView summary');
    const keptOpenMem = () => w.evaluate(() => localStorage.getItem('daybook.shotKeptOpen'));
    ok('E89 點「保留」小標：打開、記在這台電腦', await waitFor(async () => (await kept13()).open && await shotCard('保留/舊的.png').isVisible() && (await keptOpenMem()) === '1'),
      JSON.stringify([await kept13(), await shotCard('保留/舊的.png').isVisible(), await keptOpenMem()]));
    ok('E89 上面寫截圖資料夾在哪', (await w.textContent('#shotDir')) === shots13);
    const cleanAt = await w.evaluate(() => ({ days: document.getElementById('shotDays').value,
      right: document.getElementById('shotClean').getBoundingClientRect().left >= document.getElementById('shotPick').getBoundingClientRect().right }));
    ok('E89 清掉 N 天前的：預設 30 天、在「變更資料夾…」右邊（不常用，放最右邊）', cleanAt.days === '30' && cleanAt.right, JSON.stringify(cleanAt));
    const newH = await w.evaluate(() => ['shotNew', 'shotOpen'].map(id => Math.round(document.getElementById(id).getBoundingClientRect().height)));
    ok('E89 「＋ 截圖」做大（最常按）：高至少 32px、比「開啟資料夾」高一半以上', newH[0] >= 32 && newH[0] >= newH[1] * 1.5, JSON.stringify(newH));
    ok('E89 縮圖讀得到（shot:// 網址、CSP 放行）', await waitFor(() => w.evaluate(() => [...document.querySelectorAll('#shotView img')].every(i => i.complete && i.naturalWidth === 8))));

    // E90：截圖——主視窗先放大到 125%（D042），蓋的那層要照 100%（不然框的位置、大小跟畫面對不上）；
    // 只點一下不算框；拉框；畫框（藍色那塊）、箭頭（紅畫到藍）、再一個框，Ctrl+Z 拿掉最後那個；Enter 存。再來一次 Esc 不截；再一次框外重新框、按「完成」
    for (let i = 0; i < 2; i++) await w.keyboard.press('Control+=');
    ok('E90 前提：主視窗放大到 125%', await waitFor(() => w.evaluate(() => Math.abs(devicePixelRatio - 1.25) < 0.01)));
    const openCap = async () => {
      const p = app13.ctx.waitForEvent('page', { timeout: 8000 });
      await w.click('#shotNew');
      const c = await p;
      await c.waitForFunction(() => typeof frame !== 'undefined' && !!frame, null, { timeout: 8000 });
      return c;
    };
    let cap = await openCap();
    const drag = async (x1, y1, x2, y2) => { await cap.mouse.move(x1, y1); await cap.mouse.down(); await cap.mouse.move(x2, y2, { steps: 4 }); await cap.mouse.up(); };
    // 按了那層就關掉：按鍵、點擊的後半（放開）送不到已經關掉的視窗會丟錯，不算失敗；有沒有關掉看 close
    const finished = async press => { const c = cap.waitForEvent('close', { timeout: 8000 }); await press().catch(() => {}); await c; };
    ok('E90 按「＋ 截圖」：蓋一層，大小是那張圖（400×300），不跟主視窗的縮放', same(await cap.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]), [400, 300, 1]),
      JSON.stringify(await cap.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])));
    const toolNow = () => cap.evaluate(() => [tool, ...['tRect', 'tArrow', 'tLine'].filter(id => document.getElementById(id).classList.contains('on'))].join());
    ok('E90 沒用過：工具是框（按鈕亮的也是框）', (await toolNow()) === 'rect,tRect', await toolNow());
    await cap.mouse.click(30, 30);
    ok('E90 只點一下：不算框，工具列沒出來', await cap.evaluate(() => state === 'idle' && document.getElementById('tools').hidden));
    await drag(50, 50, 250, 200);
    ok('E90 拉框：工具列出來、寫存出去的大小', await cap.evaluate(() => state === 'edit' && !document.getElementById('tools').hidden) && (await cap.textContent('#size')) === '200 × 150',
      await cap.textContent('#size'));
    await drag(210, 60, 240, 90);
    await cap.click('#tArrow');
    await drag(150, 180, 240, 180);
    await cap.click('#tRect');
    await drag(205, 150, 235, 170);
    ok('E90 畫了框、箭頭、框', (await cap.evaluate(() => shapes.map(s => s.type).join())) === 'rect,arrow,rect');
    await cap.keyboard.press('Control+z');
    ok('E90 Ctrl+Z：拿掉最後畫的', (await cap.evaluate(() => shapes.map(s => s.type).join())) === 'rect,arrow');
    await cap.click('#tLine');
    await drag(205, 100, 245, 100);   // 直線（D130）：藍色那塊上一條橫的
    ok('E90 直線：多畫一條', (await cap.evaluate(() => shapes.map(s => s.type).join())) === 'rect,arrow,line');
    await finished(() => cap.keyboard.press('Enter'));
    const f639 = path.join(shots13, '639.png');
    ok('E90 Enter：存成下一號 639.png（資料夾裡最大的 638 +1）、設定檔記下 639', await waitFor(() => fs.existsSync(f639)) && set13().shotNo === 639, JSON.stringify(set13()));
    ok('E90 也複製到剪貼簿（--clipboard-file）：跟存的一模一樣', await waitFor(() => fs.existsSync(clip13) && fs.readFileSync(clip13).equals(fs.readFileSync(f639))));
    const clipUri = () => (fs.existsSync(clip13 + '.uri') ? fs.readFileSync(clip13 + '.uri', 'utf8') : null);
    ok('E90 剪貼簿也放檔案（跟檔案總管 Ctrl+C 一樣，寫進 <檔>.uri）：那個檔的網址', await waitFor(() => clipUri() === require('url').pathToFileURL(f639).href), clipUri());
    const png = readPng(fs.readFileSync(f639));
    const inkAt = (x, y) => { const c = png.at(x, y); return c[0] > 180 && c[1] < 120 && c[2] < 120; };   // 畫的紅（#e53935）
    ok('E90 存的是框的那塊：200×150', png.w === 200 && png.h === 150, `${png.w}×${png.h}`);
    ok('E90 位置、顏色對（R/B 沒對調）：左上紅、右上藍、綠色方塊在 (50,50) 起', same(png.at(5, 5), [255, 0, 0]) && same(png.at(195, 5), [0, 0, 255])
      && same(png.at(70, 70), [0, 255, 0]) && same(png.at(45, 70), [255, 0, 0]), JSON.stringify([png.at(5, 5), png.at(195, 5), png.at(70, 70), png.at(45, 70)]));
    ok('E90 畫的有畫進去：框的邊、箭頭的線和尖端是紅的，框裡面還是藍的；Ctrl+Z 拿掉的那個框沒有',
      inkAt(160, 25) && same(png.at(175, 25), [0, 0, 255]) && inkAt(170, 130) && inkAt(185, 130) && same(png.at(155, 110), [0, 0, 255]),
      JSON.stringify([png.at(160, 25), png.at(175, 25), png.at(170, 130), png.at(185, 130), png.at(155, 110)]));
    ok('E90 直線畫進去了、沒有箭頭（尾端旁邊箭頭會蓋到的地方還是藍的）', inkAt(175, 50) && same(png.at(183, 54), [0, 0, 255]), JSON.stringify([png.at(175, 50), png.at(183, 54)]));
    ok('E90 回到主視窗：提示存成幾號、清單多一張（今天那段最前面）', await waitFor(async () => (await toast13()).includes('639.png') && (await names())[1] === '639'), JSON.stringify(await names()));
    cap = await openCap();
    ok('E90 再打開：工具照上次用的（直線）', (await toolNow()) === 'line,tLine', await toolNow());
    await drag(10, 10, 100, 100);
    await finished(() => cap.keyboard.press('Escape'));
    await sleep(300);
    ok('E90 Esc：不截了——沒有多存、編號不跳、剪貼簿不動', !fs.existsSync(path.join(shots13, '640.png')) && set13().shotNo === 639 && fs.readFileSync(clip13).equals(fs.readFileSync(f639)));
    cap = await openCap();
    await drag(10, 10, 60, 60);
    await drag(300, 200, 380, 280);
    ok('E90 框好之後在框外拉：重新框', (await cap.textContent('#size')) === '80 × 80', await cap.textContent('#size'));
    await finished(() => cap.click('#tDone'));
    const f640 = path.join(shots13, '640.png');
    ok('E90 按「完成」也一樣：存成 640.png（80×80，整塊藍）', await waitFor(() => fs.existsSync(f640))
      && (p => p.w === 80 && p.h === 80 && same(p.at(40, 40), [0, 0, 255]))(readPng(fs.readFileSync(f640))));

    // E91：留下來——不能用的字、跟保留裡的同名：提示、框還在；打了 .png 不再多加；Esc 取消
    await shotBtn('639.png', '.shot-keep');
    await w.fill('.shot-name-in', 'a:b');
    await w.press('.shot-name-in', 'Enter');
    ok('E91 不能用的字：提示、框還在、檔案沒動', await waitFor(async () => (await toast13()).includes('不能有這些字')) && await w.isVisible('.shot-name-in') && fs.existsSync(f639));
    await w.fill('.shot-name-in', '舊的');
    await w.press('.shot-name-in', 'Enter');
    ok('E91 跟保留裡的同名：提示、框還在', await waitFor(async () => (await toast13()).includes('已經有')) && await w.isVisible('.shot-name-in'));
    await w.fill('.shot-name-in', '撥入單 錯誤.png');
    await w.press('.shot-name-in', 'Enter');
    ok('E91 Enter：搬進 保留\\（打了 .png 不再多加一個），清單上換到保留那段', await waitFor(async () => fs.existsSync(path.join(shots13, '保留', '撥入單 錯誤.png')) && !fs.existsSync(f639)
      && (await heads())[0] === '保留 · 2 張' && (await names()).slice(0, 2).includes('撥入單 錯誤') && !(await names()).includes('639')), JSON.stringify(await names()));
    ok('E91 重畫之後保留那段還是開著（D142）', (await kept13()).open && await shotCard('保留/撥入單 錯誤.png').isVisible());
    await shotBtn('640.png', '.shot-keep');
    await w.press('.shot-name-in', 'Escape');
    ok('E91 Esc：不留了，框收起來、檔案沒動', await waitFor(async () => !(await w.$('.shot-name-in'))) && fs.existsSync(f640));

    // E92：複製、點縮圖放大看；單張沒有刪除（D142）；縮圖、放大看按右鍵「列印…」（--print-pdf 印成 PDF：印的是那張、縮到一頁裡）
    await shotBtn('保留/舊的.png', '.shot-copy');
    ok('E92 複製：剪貼簿是那張圖、也放那個檔（路徑有中文）', await waitFor(() => fs.readFileSync(clip13).equals(tiny)
      && clipUri() === require('url').pathToFileURL(path.join(shots13, '保留', '舊的.png')).href), clipUri());
    const toolNames = await w.$$eval('#shotView .shot-tools button', bs => [...new Set(bs.map(b => b.textContent))].sort());
    ok('E92 單張沒有刪除（編號的、保留的都沒有；要刪靠清掉 N 天前的）：滑過只有複製、留下來', same(toolNames, ['留下來', '複製'].sort()), JSON.stringify(toolNames));
    fs.writeFileSync(path.join(shots13, '保留', '長.png'), makePng(60, 3000, () => [0, 0, 255, 255]));   // 很長的圖：不縮的話要印三頁以上
    await waitFor(async () => (await names()).includes('長'));
    await shotCard('保留/長.png').click({ button: 'right' });
    ok('E92 縮圖按右鍵：出選單（列印…）、那張框起來', await waitFor(() => w.isVisible('#shotMenu')) && (await w.textContent('#shotMenu')).includes('列印')
      && (await shotCard('保留/長.png').getAttribute('class')).split(' ').includes('sel'));
    const fill13 = await w.evaluate(() => { const m = document.getElementById('shotMenu'); return [Math.round(m.querySelector('button').getBoundingClientRect().width), m.clientWidth]; });
    ok('E92 選單的項目撐滿整列（滑過的底色跟其他右鍵選單一樣滿）', fill13[0] === fill13[1], JSON.stringify(fill13));
    await w.click('#shotMenu [data-act="print"]');
    ok('E92 列印：印的是那張（60×3000）、縮到一頁裡', await waitFor(() => fs.existsSync(pdf13)) && (p => p.pages === 1 && p.imgs.includes('60x3000'))(pdfInfo(pdf13)),
      fs.existsSync(pdf13) && JSON.stringify(pdfInfo(pdf13)));
    ok('E92 點了選單收起來、框拿掉', await w.isHidden('#shotMenu') && !(await shotCard('保留/長.png').getAttribute('class')).split(' ').includes('sel'));
    fs.unlinkSync(pdf13);
    await shotCard('保留/舊的.png').locator('.shot-open').click();
    ok('E92 點縮圖：放大看那張', await waitFor(() => w.evaluate(() => !document.getElementById('shotBig').hidden && document.getElementById('shotBigImg').naturalWidth === 8))
      && (await w.textContent('#shotBigName')) === '舊的');
    await w.click('#shotBigImg', { button: 'right' });
    ok('E92 放大看按右鍵：選單疊在放大看上面', await waitFor(() => w.isVisible('#shotMenu')) && await w.isVisible('#shotBig')
      && await w.evaluate(() => document.elementFromPoint(...(r => [r.left + 5, r.top + 5])(document.getElementById('shotMenu').getBoundingClientRect()))?.closest('#shotMenu') != null));
    await w.keyboard.press('Escape');
    ok('E92 Esc：先只收選單，放大看留著', await waitFor(() => w.isHidden('#shotMenu')) && await w.isVisible('#shotBig'));
    await w.click('#shotBigImg', { button: 'right' });
    await w.click('#shotMenu [data-act="print"]');
    ok('E92 放大看的列印：印的是放大的那張（8×6），放大看留著', await waitFor(() => fs.existsSync(pdf13)) && (p => p.pages === 1 && p.imgs.includes('8x6'))(pdfInfo(pdf13))
      && await w.isVisible('#shotBig'), fs.existsSync(pdf13) && JSON.stringify(pdfInfo(pdf13)));
    await w.keyboard.press('Escape');
    ok('E92 Esc：關掉放大看', await waitFor(() => w.isHidden('#shotBig')));
    // E142（截圖）：選單共用的那套（見 開發筆記 D182）——鍵盤叫出來的放在那張底下、那張框起來；Esc 游標回那一張、框拿掉；點外面收起來
    const kAt13 = await keyMenuAt(shotCard('保留/舊的.png'), 'shotMenu');
    ok('E142 截圖：鍵盤叫出來的（沒有座標）放在那張底下、那張框起來', await w.isVisible('#shotMenu') && same(kAt13, [16, 0])
      && (await shotCard('保留/舊的.png').getAttribute('class')).split(' ').includes('sel'), JSON.stringify(kAt13));
    await w.keyboard.press('Escape');
    ok('E142 截圖 Esc：選單收起來、框拿掉、游標回那一張', await waitFor(() => w.isHidden('#shotMenu'))
      && !(await shotCard('保留/舊的.png').getAttribute('class')).split(' ').includes('sel')
      && await w.evaluate(() => document.activeElement.closest('.shot')?.dataset.rel) === '保留/舊的.png');
    await shotCard('保留/舊的.png').click({ button: 'right' });
    await waitFor(() => w.isVisible('#shotMenu'));
    await outsideDown(w);
    ok('E142 截圖：點外面收起來、框拿掉', await waitFor(() => w.isHidden('#shotMenu')) && !(await shotCard('保留/舊的.png').getAttribute('class')).split(' ').includes('sel'));

    // E113：拖框選好幾張（D143）——在同一張縮圖裡拖：只選那張、不打開放大看；從 640 左上外面拖到 638 中間：選兩張；
    // 在選到的上面按右鍵「複製 2 張」（只放檔案：--clipboard-file 是空的、.uri 兩行）；點空白處、Esc 取消；在沒選到的上面按右鍵：取消選取、只對那張
    const picked = () => w.$$eval('#shotView .shot.picked', cs => cs.map(c => c.dataset.rel));
    const fileUrl = f => require('url').pathToFileURL(path.join(shots13, f)).href;
    const mdrag = async (x1, y1, x2, y2) => { await w.mouse.move(x1, y1); await w.mouse.down(); await w.mouse.move(x2, y2, { steps: 5 }); await w.mouse.up(); };
    await shotCard('640.png').scrollIntoViewIfNeeded();
    const b640 = await shotCard('640.png').boundingBox(), b638 = await shotCard('638.png').boundingBox();
    const in638 = [b638.x + b638.width / 2, b638.y + 40];
    const pickTwo = () => mdrag(b640.x - 6, b640.y - 6, ...in638);
    await mdrag(...in638, in638[0] + 20, in638[1] + 10);
    ok('E113 在同一張縮圖裡拖：只選那張、不打開放大看、框拿掉', same(await picked(), ['638.png']) && await w.isHidden('#shotBig') && !(await w.$('#shotBand')),
      JSON.stringify(await picked()));
    await pickTwo();
    ok('E113 從 640 左上外面拖到 638 中間：兩張都選起來', same(await picked(), ['640.png', '638.png']), JSON.stringify(await picked()));
    await shotCard('638.png').click({ button: 'right' });
    ok('E113 在選到的上面按右鍵：「複製 2 張」、沒有列印', await waitFor(() => w.isVisible('#shotMenu'))
      && (await w.textContent('#shotMenu [data-act="copy"]')) === '複製 2 張' && await w.isHidden('#shotMenu [data-act="print"]'));
    await w.click('#shotMenu [data-act="copy"]');
    ok('E113 複製 2 張：只放檔案（沒有圖）、兩個檔照畫面上的順序、提示幾張', await waitFor(async () => clipUri() === [fileUrl('640.png'), fileUrl('638.png')].join('\r\n')
      && fs.readFileSync(clip13).length === 0 && (await toast13()).includes('已複製 2 張')), clipUri());
    ok('E113 複製完還是選著', same(await picked(), ['640.png', '638.png']));
    await w.click('#shotView section h3');
    ok('E113 點空白處（日期小標）：取消選取', same(await picked(), []), JSON.stringify(await picked()));
    await pickTwo();
    await w.keyboard.press('Escape');
    ok('E113 Esc：取消選取', (await picked()).length === 0 && await w.isHidden('#shotBig'), JSON.stringify(await picked()));
    await pickTwo();
    await shotCard('401.png').click({ button: 'right' });
    ok('E113 在沒選到的上面按右鍵：取消選取，選單是一張的（複製、列印…）', await waitFor(() => w.isVisible('#shotMenu')) && (await picked()).length === 0
      && (await w.textContent('#shotMenu [data-act="copy"]')) === '複製' && await w.isVisible('#shotMenu [data-act="print"]'));
    await w.click('#shotMenu [data-act="copy"]');
    ok('E113 右鍵的複製（一張）：圖＋檔案，跟滑過的複製一樣', await waitFor(() => fs.readFileSync(clip13).equals(tiny) && clipUri() === fileUrl('401.png')), clipUri());
    // 保留那段收起來時（D143〈後續〉）：收起來就取消選取裡面的；收著時拖，框不到裡面的（看不到的卡片位置不是 0，疊在底下的縮圖那裡）
    const keptCards = w.locator('#shotView details .shot');
    await keptCards.first().scrollIntoViewIfNeeded();
    const k0 = await keptCards.nth(0).boundingBox(), k1 = await keptCards.nth(1).boundingBox();
    await mdrag(k0.x - 6, k0.y - 6, k1.x + k1.width / 2, k1.y + 40);
    const keptPicked = await picked();
    ok('E113 前提：保留那段開著時框得到保留的', keptPicked.length === 2 && keptPicked.every(r => r.startsWith('保留/')), JSON.stringify(keptPicked));
    await w.click('#shotView summary');
    ok('E113 收起保留那段：裡面選到的取消選取', await waitFor(async () => !(await kept13()).open && (await picked()).length === 0), JSON.stringify(await picked()));
    await shotCard('640.png').scrollIntoViewIfNeeded();
    const c640 = await shotCard('640.png').boundingBox(), c638 = await shotCard('638.png').boundingBox();
    await mdrag(c640.x - 6, c640.y - 6, c638.x + c638.width / 2, c638.y + 40);
    ok('E113 保留收起來時拖：框不到保留的（只有 640、638）', same(await picked(), ['640.png', '638.png']), JSON.stringify(await picked()));
    await w.keyboard.press('Escape');
    await w.click('#shotView summary');   // 打開回去，後面照舊
    await waitFor(async () => (await kept13()).open);

    // E93：外面放進來的跟著出現；清掉 7 天前的——先問（取消不動）、確定才丟：7 天前（含）以前的編號截圖，6 天前的、今天的、保留的不動；沒有可清的提示
    for (const [f, ago] of [['402.png', 8], ['403.png', 6]]) { const p = path.join(shots13, f); fs.writeFileSync(p, tiny); fs.utimesSync(p, daysAgo(ago), daysAgo(ago)); }
    ok('E93 外面放進來的：清單跟著變（監看截圖資料夾）', await waitFor(async () => (await names()).includes('402') && (await names()).includes('403')), JSON.stringify(await names()));
    await w.fill('#shotDays', '7');
    await w.click('#shotCleanBtn');
    ok('E93 清掉 7 天前的：先問，寫幾日以前、幾張（400、401、402 三張）', await waitFor(async () => (await w.isVisible('#shotCleanAsk'))
      && (await w.textContent('#shotCleanMsg')).includes(`${localIso(daysAgo(7))}（含）以前的編號截圖 3 張`)), await w.textContent('#shotCleanMsg'));
    await w.click('#shotCleanNo');
    ok('E93 取消：什麼都沒丟、問的那列收起來', await waitFor(() => w.isHidden('#shotCleanAsk')) && fs.existsSync(path.join(shots13, '400.png')) && fs.existsSync(path.join(shots13, '402.png')));
    await w.click('#shotCleanBtn');
    await w.click('#shotCleanOk');
    ok('E93 確定：7 天前（含）以前的編號截圖丟資源回收筒；6 天前的、今天的、保留的（40 天前）不動', await waitFor(async () =>
      ['400.png', '401.png', '402.png'].every(f => fs.existsSync(path.join(trash13, f)) && !fs.existsSync(path.join(shots13, f)))
      && ['403.png', '640.png', '638.png'].every(f => fs.existsSync(path.join(shots13, f))) && fs.existsSync(path.join(shots13, '保留', '舊的.png'))
      && same((await names()).filter(n => /^\d+$/.test(n)), ['640', '638', '403'])), JSON.stringify(await names()));
    await w.fill('#shotDays', '20');
    await w.click('#shotCleanBtn');
    ok('E93 沒有可清的：提示、不問', await waitFor(async () => (await toast13()).includes('沒有')) && await w.isHidden('#shotCleanAsk'));

    // E94：開啟資料夾；變更資料夾——設定檔記新的、清單空的；新資料夾的第一張照用過的最大號接下去；說明頁寫新的
    await w.click('#shotOpen');
    ok('E94 開啟資料夾：用檔案總管打開截圖資料夾（--open-log）', await waitFor(() => fs.existsSync(open13) && fs.readFileSync(open13, 'utf8').trim().split('\n').pop() === shots13));
    await w.click('#shotPick');
    ok('E94 變更資料夾：設定檔記新的、上面寫新的、清單是空的', await waitFor(async () => set13().shotDir === shots13b && (await w.textContent('#shotDir')) === shots13b
      && await w.isVisible('#shotView .empty')));
    cap = await openCap();
    await drag(0, 0, 20, 20);
    await finished(() => cap.keyboard.press('Enter'));
    ok('E94 新資料夾的第一張：照用過的最大號接下去（641，不從 1 開始）', await waitFor(() => fs.existsSync(path.join(shots13b, '641.png'))) && set13().shotNo === 641
      && !fs.existsSync(path.join(shots13b, '1.png')) && fs.existsSync(f640));
    await w.click('#actJournal');
    ok('E89 點「日記本」：回到日記', await waitFor(async () => await w.isVisible('#center') && await w.isHidden('#shotPane')));
    await w.click('#infoBtn');   // 說明在日記的標題列（記事本、文件檢視、截圖頁看不到）
    ok('E94 說明頁「檔案放在哪」：截圖寫新的資料夾', await waitFor(async () => (await w.textContent('#fShots')) === shots13b));
    await w.keyboard.press('Escape');
  } finally {
    await app13.close();
  }

  // E95～E100：介面語言（見 開發筆記 D131）——--user-data 另開一個（設定檔指 fixture 複本；語言檔在 <user-data>\locales）：
  // HTML 的切法跟收字工具一樣；語言頁複製 prompt、檢查 AI 回的、安裝並換成它、補翻、換回繁體中文、刪掉用著的
  const ktL = require(path.join(ROOT, 'tools/i18n-keys.cjs'));
  const locL = require(path.join(ROOT, 'src/main/locales.js'));
  const udL = path.join(tmpRoot, 'profileLang');
  const dataL = path.join(tmpRoot, 'dataLang');
  fs.cpSync(path.join(__dirname, 'fixtures', 'data'), dataL, { recursive: true });
  fs.mkdirSync(udL);
  fs.writeFileSync(path.join(udL, 'settings.json'), JSON.stringify({ dataDir: dataL }));
  const langDirL = path.join(udL, 'locales');
  const clipL = path.join(tmpRoot, 'clipLang.txt'), openL = path.join(tmpRoot, 'openLang.log'), trashL = path.join(tmpRoot, 'trashLang');
  fs.mkdirSync(trashL);
  const appL = await launch(pw, ['--user-data', udL, '--clipboard-file', clipL, '--open-log', openL, '--trash-dir', trashL]);
  try {
    const wL = appL.page;
    const visible = sel => wL.isVisible(sel).catch(() => false);
    const text = sel => wL.textContent(sel).catch(() => null);
    const htmlLang = () => wL.evaluate(() => document.documentElement.lang).catch(() => null);
    const settingsL = () => { try { return JSON.parse(fs.readFileSync(path.join(udL, 'settings.json'), 'utf8')); } catch { return {}; } };
    const optionsL = () => wL.$$eval('#langSel option', os => os.map(o => [o.value, o.textContent, o.selected])).catch(() => null);
    await waitFor(async () => (await wL.$$('#cards .card, #cards .empty')).length > 0, 8000);

    for (const f of ['index.html', 'capture.html']) {
      const file = path.join(ROOT, 'src/renderer', f);
      const dom = await wL.evaluate(html => window.i18n.domKeys(new DOMParser().parseFromString(html, 'text/html').documentElement), fs.readFileSync(file, 'utf8'));
      const tool = [...new Set(ktL.scanHtml(file).keys)];
      ok(`E95 ${f}：收字工具切出來的字跟 DOM（translateDom 的規則）一模一樣`, same([...dom].sort(), tool.sort()),
        JSON.stringify({ 只有DOM: dom.filter(k => !tool.includes(k)), 只有工具: tool.filter(k => !dom.includes(k)) }));
    }

    await viaSettings(wL, '#langBtn');
    await waitFor(() => visible('#lang'));
    ok('E96 「語言…」在齒輪「設定」選單「外觀…」後面', (await wL.$$('#settingsMenu #skinBtn + #langBtn')).length === 1 && (await text('#langBtn')) === '語言…');
    ok('E96 介面的語言只有「繁體中文（內建）」、選著；還沒有語言檔；語言檔資料夾是 <user-data>\\locales',
      same(await optionsL(), [['', '繁體中文（內建）', true]]) && await visible('#langNone') && (await text('#fLang')) === langDirL, JSON.stringify([await optionsL(), await text('#fLang')]));
    await wL.click('#lang .openBtn[data-open="locales"]');
    ok('E96 「開啟位置」：沒有就先建，用檔案總管打開（--open-log）', await waitFor(() => (readN(openL) || '').trim() === langDirL) && fs.existsSync(langDirL), readN(openL));

    // E97：複製 prompt
    await wL.click('#langCopy');
    ok('E97 沒填要翻成什麼就按「複製 prompt」：提示、不複製', await waitFor(async () => (await text('#toast')) === '先填要翻成哪個語言') && !fs.existsSync(clipL));
    // E144：沒填要翻成什麼、框裡有貼字就按「檢查」：提示、游標搬到「要翻成」、沒有檢查結果（packs.js 的 aiFlow 先問 ready，見 開發筆記 D185）。
    // 提示的字先清掉，才分得出是這次跳的；主程序沒填也會丟同一句（locales.js），分得出是畫面先擋的只有游標
    await wL.fill('#langReply', 'x');
    await wL.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await wL.click('#langTry');
    ok('E144 沒填要翻成什麼就按「檢查」：提示、游標在「要翻成」、沒有檢查結果', await waitFor(async () => (await text('#toast')) === '先填要翻成哪個語言')
      && await sleep(300).then(async () => !(await visible('#langResult')) && await wL.evaluate(() => document.activeElement.id) === 'langTarget'),
      JSON.stringify([await text('#toast'), await wL.evaluate(() => document.activeElement.id)]));
    await wL.fill('#langReply', '');
    await wL.fill('#langTarget', 'Testish');
    await wL.click('#langCopy');
    const keysL = locL.allKeys();
    ok('E97 複製 prompt：翻成「Testish」，「代號 原文」列全部的字',
      await waitFor(() => /翻成「Testish」/.test(readN(clipL) || '')) && readN(clipL).includes(`共 ${keysL.length} 條`) && readN(clipL).includes(`${locL.idOf('格式…')} 格式…`));
    await wL.click('#langPromptBox summary');
    ok('E97 「看 prompt 內容」就是複製的那份', await waitFor(async () => (await text('#langPromptText')) === readN(clipL)));
    await wL.click('#langGemini');
    ok('E97 開 Gemini', await waitFor(() => (readN(openL) || '').includes('https://gemini.google.com/app')));

    // E98：AI 回的貼回來：認得的、回錯的（多了大括號、代號對不上），安裝並換成它
    const TL = {
      '格式…': 'Formats…', '資料': 'DATA', '{name}（內建）': '{name} (built-in)', '介面換成「{name}」': 'Now in {name}', '使用中': 'In use',
      '這個語言檔現在讀不到，關掉「語言」再打開看看': 'Language file missing',
      [await wL.getAttribute('#actSettings', 'title')]: 'Settings tip',
    };
    let bogusL = 'ffffff';
    while (keysL.some(k => locL.idOf(k) === bogusL)) bogusL = (parseInt(bogusL, 16) - 1).toString(16);
    const replyL = ['好的：', '```', '@lang en', ...Object.entries(TL).map(([k, v]) => `${locL.idOf(k)} ${v}`), `${locL.idOf('外觀…')} Looks {x}`, `${bogusL} nope`, '```'].join('\n');
    const nL = Object.keys(TL).length;
    ok('E98 （前提）翻的字都是這版有的', Object.keys(TL).every(k => keysL.includes(k)), JSON.stringify(Object.keys(TL).filter(k => !keysL.includes(k))));
    await wL.fill('#langReply', replyL);
    await wL.click('#langTry');
    const resL = () => text('#langResult');
    ok('E98 檢查：認得幾條、2 條回錯沒收、裝了還缺幾條、語言代碼', await waitFor(() => visible('#langResult'))
      && (await resL()).includes(`認得 ${nL} 條翻譯`) && (await resL()).includes('有 2 條回錯了') && (await resL()).includes(`還缺 ${keysL.length - nL} 條`)
      && (await resL()).includes('語言代碼：en') && (await wL.$$('#langInstall')).length === 1, await resL());
    await wL.click('#langFeedback');
    ok('E98 「複製有問題的給 AI」：那兩條、原因', await waitFor(() => (readN(clipL) || '').startsWith('你上次回的這幾條有問題'))
      && readN(clipL).includes('你回的：Looks {x}') && readN(clipL).includes(`${bogusL} nope`), readN(clipL));
    await wL.type('#langReply', ' ');
    ok('E98 框裡的字一改，結果收起來（要重新檢查）', await waitFor(async () => !(await visible('#langResult'))));
    await wL.click('#langTry');
    await waitFor(() => visible('#langInstall'));
    await wL.click('#langInstall');
    ok('E98 安裝並換成它：畫面重新載入，html 的 lang 換成 en、語言頁開回來、提示換成什麼',
      await waitFor(async () => (await htmlLang()) === 'en' && await visible('#lang') && (await text('#toast')) === 'Now in Testish', 10000), JSON.stringify([await htmlLang(), await text('#toast')]));
    const packL = JSON.parse(fs.readFileSync(path.join(langDirL, 'Testish.json'), 'utf8'));
    ok('E98 語言檔 locales\\Testish.json：名稱、lang、認得的那幾條；設定檔記 lang', packL.name === 'Testish' && packL.lang === 'en'
      && same(Object.keys(packL.strings).sort(), Object.keys(TL).sort()) && settingsL().lang === 'Testish', JSON.stringify([packL, settingsL()]));
    ok('E98 固定文字（文字、title）換成翻譯，沒翻的照中文', (await text('#fmtBtn')) === 'Formats…' && (await text('#setCatData')) === 'DATA'
      && (await wL.getAttribute('#actSettings', 'title')) === 'Settings tip' && (await text('#importBtn')) === '匯入…', JSON.stringify([await text('#fmtBtn'), await text('#setCatData'), await text('#importBtn')]));
    ok('E98 app.js 組的字也換了：選單第一項（內建）、清單上「使用中」；Testish 選著',
      same(await optionsL(), [['', '繁體中文 (built-in)', false], ['Testish', 'Testish', true]]) && (await text('#langTable tr[data-lang="Testish"] .extState')) === 'In use',
      JSON.stringify([await optionsL(), await text('#langTable tr[data-lang="Testish"] .extState')]));
    const errL = await wL.evaluate(() => window.daybook.setLang('nope').then(() => null, e => e.message));
    ok('E98 主程序丟的訊息也換了', /Language file missing/.test(errL || ''), errL);

    // E99：補翻缺的：prompt 只列缺的，裝的時候補進同一個檔
    await wL.click('#langTable tr[data-lang="Testish"] .extBtn[data-act="more"]');
    ok('E99 「補翻缺的」：要翻成填好 Testish', (await wL.inputValue('#langTarget')) === 'Testish');
    await wL.click('#langCopy');
    ok('E99 prompt 只列還缺的', await waitFor(() => (readN(clipL) || '').includes(`共 ${keysL.length - nL} 條`)) && readN(clipL).includes('之前已經翻了一部分')
      && !readN(clipL).includes(`${locL.idOf('格式…')} `) && readN(clipL).includes(`${locL.idOf('匯入…')} `));
    await wL.fill('#langReply', ['```', `${locL.idOf('匯入…')} Import…`, '```'].join('\n'));
    await wL.click('#langTry');
    ok('E99 檢查：寫會補進 Testish', await waitFor(async () => ((await resL()) || '').includes('會補進已經裝的「Testish」')), await resL());
    await wL.click('#langInstall');
    ok('E99 裝好：新補的換了、原本的還在、同一個檔', await waitFor(async () => (await text('#importBtn')) === 'Import…' && (await text('#fmtBtn')) === 'Formats…', 10000)
      && same(fs.readdirSync(langDirL), ['Testish.json']));

    // E100：換回繁體中文、再換回來；刪掉用著的那個
    await wL.selectOption('#langSel', '');
    ok('E100 選「繁體中文（內建）」：重新載入、字換回中文、html 的 lang 換回 zh-Hant、設定檔的 lang 拿掉',
      await waitFor(async () => (await text('#fmtBtn')) === '格式…' && (await htmlLang()) === 'zh-Hant' && await visible('#lang'), 10000) && settingsL().lang == null);
    await wL.selectOption('#langSel', 'Testish');
    ok('E100 再選 Testish：換回去', await waitFor(async () => (await text('#fmtBtn')) === 'Formats…', 10000));
    await wL.click('#langTable tr[data-lang="Testish"] .extBtn[data-act="delAsk"]');
    await wL.click('#langTable tr[data-lang="Testish"] .extBtn[data-act="del"]');
    ok('E100 刪掉用著的那個：丟到資源回收筒（--trash-dir）、換回中文、清單空的',
      await waitFor(async () => (await text('#fmtBtn')) === '格式…' && await visible('#langNone'), 10000)
      && fs.existsSync(path.join(trashL, 'Testish.json')) && !fs.existsSync(path.join(langDirL, 'Testish.json')) && settingsL().lang == null);
  } finally {
    await appL.close();
  }

  // E102～E108：常用（見 開發筆記 D134）——--user-data 另開一個（設定檔指一個空的紀錄資料夾），看清單寫進設定檔的 launch；
  // 加程式或檔案、加資料夾用 --pick-launch（照順序，用到最後一個就一直是它）；開、在檔案總管中顯示寫進 --open-log；複製寫進 --clipboard-file
  const udK = path.join(tmpRoot, 'profileLaunch'), dataK = path.join(tmpRoot, 'dataLaunch'), lpK = path.join(tmpRoot, 'lp');
  const fileK = path.join(lpK, '工具.exe'), dirK = path.join(lpK, '專案'), dropK = path.join(lpK, '拖進來.txt');
  const openK = path.join(tmpRoot, 'openLaunch.log'), clipK = path.join(tmpRoot, 'clipLaunch.txt');
  for (const d of [udK, dataK, dirK]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(fileK, '');   // 假的程式：--open-log 下不會真的開
  fs.writeFileSync(dropK, '拖進來的');
  const settingsK = path.join(udK, 'settings.json');
  fs.writeFileSync(settingsK, JSON.stringify({ dataDir: dataK }));
  const launchSet = () => { try { return JSON.parse(fs.readFileSync(settingsK, 'utf8')).launch || null; } catch { return null; } };
  const appK = await launch(pw, ['--user-data', udK, '--open-log', openK, '--clipboard-file', clipK, '--pick-launch', fileK, '--pick-launch', dirK]);
  try {
    const w = appK.page;
    const visible = sel => w.isVisible(sel).catch(() => false);
    const names = () => w.$$eval('#launchList .lp .lp-name', els => els.map(e => e.textContent)).catch(() => null);
    const toastK = () => w.textContent('#toast').catch(() => '');
    const card = name => w.locator('#launchList .lp', { has: w.locator('.lp-name', { hasText: new RegExp(`^${name}$`) }) });
    const lastOpen = () => (readN(openK) || '').trim().split('\n').pop();
    const isOn = sel => w.$eval(sel, e => e.classList.contains('on')).catch(() => false);
    await waitFor(async () => (await w.$$('#cards .card, #cards .empty')).length > 0, 8000);

    // E102：點「常用」：左欄換成常用、中間（日記）不換、頁籤亮；還沒有的寫怎麼加。加程式或檔案、加資料夾、再加一次同一個
    await w.click('#actLaunch');
    ok('E102 點「常用」：左欄換成常用、日記本的東西藏起來、中間還是日記、頁籤亮起來', await waitFor(async () => await visible('#launchPane') && !(await visible('#q'))
      && await visible('#center') && await isOn('#actLaunch') && !(await isOn('#actJournal'))));
    ok('E102 還沒有的：寫怎麼加', (await w.textContent('#launchList .empty').catch(() => '')).includes('從檔案總管拖進來'));
    await w.click('#lpAddFile');
    ok('E102 加程式或檔案：名稱是檔名（不含 .exe）、提示、設定檔記下完整路徑', await waitFor(async () => same(await names(), ['工具']))
      && (await toastK()).includes('已加到常用：工具') && same(launchSet(), [{ name: '工具', target: fileK }]), JSON.stringify([await names(), launchSet()]));
    ok('E102 圖示是 Windows 給的（img，讀得出來）', await waitFor(() => w.$eval('#launchList .lp .lp-icon', e => e.tagName === 'IMG' && e.complete && e.naturalWidth > 0).catch(() => false)));
    await w.click('#lpAddDir');
    ok('E102 加資料夾：名稱是資料夾名稱、接在最後面；圖示是自己畫的資料夾（svg，不跟 Windows 拿）', await waitFor(async () => same(await names(), ['工具', '專案']))
      && launchSet().length === 2 && await card('專案').locator('svg.lp-icon').count() === 1);
    await w.click('#lpAddDir');
    ok('E102 再加同一個：不加、提示已經有了', await waitFor(async () => (await toastK()).includes('「專案」已經在常用裡了')) && same(await names(), ['工具', '專案']) && launchSet().length === 2);

    // E103：加網址——不是 http、https 的不收（表單留著）；名稱空的照主機名稱
    await w.click('#lpAddUrl');
    ok('E103 加網址：最後面開一張表單、游標在網址那格', await waitFor(() => w.evaluate(() => document.activeElement?.classList.contains('lp-url-in'))));
    await w.fill('.lp-url-in', 'ftp://x');
    await w.press('.lp-url-in', 'Enter');
    ok('E103 不是 http、https：提示、表單留著、沒加', await waitFor(async () => (await toastK()).includes('http:// 或 https://')) && await visible('.lp.editing') && launchSet().length === 2);
    await w.fill('.lp-url-in', 'https://example.com/a');
    await w.press('.lp-url-in', 'Enter');
    ok('E103 名稱空的：照主機名稱；圖示是自己畫的（svg）', await waitFor(async () => same(await names(), ['工具', '專案', 'example.com']))
      && same(launchSet()[2], { name: 'example.com', target: 'https://example.com/a' }) && await card('example.com').locator('svg.lp-icon').count() === 1);

    // E104：點一下就開：程式、資料夾是完整路徑，網址照樣（--open-log）；提示寫開了哪個
    for (const [n, t] of [['工具', fileK], ['專案', dirK], ['example.com', 'https://example.com/a']]) {
      await card(n).locator('.lp-open').click();
      ok(`E104 點「${n}」：開 ${t}`, await waitFor(async () => lastOpen() === t && (await toastK()).includes(`已開啟「${n}」`)), lastOpen());
    }

    // E105：編輯——名稱改掉；路徑不能改（淡淡寫出來）；網址的那筆可以改網址；Esc 不改
    await card('工具').hover();
    await card('工具').locator('.edit').click();
    ok('E105 編輯程式：名稱那格是原本的、底下寫路徑、沒有網址那格', await waitFor(async () => (await w.inputValue('.lp-name-in')) === '工具'
      && (await w.textContent('.lp.editing .lp-path')) === fileK && await w.locator('.lp-url-in').count() === 0));
    await w.fill('.lp-name-in', '我的工具');
    await w.press('.lp-name-in', 'Enter');
    ok('E105 Enter：名稱換了、路徑不變', await waitFor(async () => same(await names(), ['我的工具', '專案', 'example.com'])) && same(launchSet()[0], { name: '我的工具', target: fileK }));
    await card('example.com').hover();
    await card('example.com').locator('.edit').click();
    await w.fill('.lp-url-in', 'https://example.com/b');
    await w.fill('.lp-name-in', 'EX');
    await w.click('.lp.editing .save');
    ok('E105 網址的那筆：網址、名稱都改得了', await waitFor(async () => same(await names(), ['我的工具', '專案', 'EX'])) && same(launchSet()[2], { name: 'EX', target: 'https://example.com/b' }));
    await card('專案').hover();
    await card('專案').locator('.edit').click();
    await w.fill('.lp-name-in', '不要');
    await w.press('.lp-name-in', 'Escape');
    ok('E105 Esc：不改、表單收起來', await waitFor(async () => same(await names(), ['我的工具', '專案', 'EX']) && !(await visible('.lp.editing'))) && launchSet()[1].name === '專案');

    // E106：調順序——選到那張按 Alt+↑；設定檔照新的順序、游標跟著那張
    await card('專案').locator('.lp-open').focus();
    await w.keyboard.press('Alt+ArrowUp');
    ok('E106 Alt+↑：往上一格、設定檔照新的順序、游標還在那張', await waitFor(async () => same(await names(), ['專案', '我的工具', 'EX']))
      && same(launchSet().map(x => x.name), ['專案', '我的工具', 'EX'])
      && await w.evaluate(() => document.activeElement?.closest('.lp')?.querySelector('.lp-name')?.textContent) === '專案');
    await w.keyboard.press('Alt+ArrowUp');
    ok('E106 已經在最上面：不動', same(await names(), ['專案', '我的工具', 'EX']));

    // E107：右鍵選單——資料夾、程式有「在檔案總管中顯示」「複製路徑」；網址只有「複製網址」；Esc 收起來
    const menuItems = () => w.$$eval('#launchMenu button', bs => bs.filter(b => b.offsetParent).map(b => b.textContent));
    await card('專案').click({ button: 'right' });
    ok('E107 資料夾按右鍵：開啟、編輯、在檔案總管中顯示、複製路徑、從常用拿掉', await waitFor(async () => same(await menuItems(), ['開啟', '編輯', '在檔案總管中顯示', '複製路徑', '從常用拿掉'])), JSON.stringify(await menuItems()));
    await w.click('#launchMenu [data-act="copy"]');
    ok('E107 複製路徑：完整路徑（--clipboard-file）、選單收起來', await waitFor(async () => readN(clipK) === dirK && !(await visible('#launchMenu'))));
    await card('EX').click({ button: 'right' });
    ok('E107 網址按右鍵：沒有在檔案總管中顯示，複製網址', await waitFor(async () => same(await menuItems(), ['開啟', '編輯', '複製網址', '從常用拿掉'])), JSON.stringify(await menuItems()));
    await w.click('#launchMenu [data-act="copyUrl"]');
    ok('E107 複製網址', await waitFor(() => readN(clipK) === 'https://example.com/b'));
    await card('我的工具').click({ button: 'right' });
    await w.click('#launchMenu [data-act="reveal"]');
    ok('E107 在檔案總管中顯示：那個檔的完整路徑（--open-log）', await waitFor(() => lastOpen() === fileK));
    await card('我的工具').click({ button: 'right' });
    await w.keyboard.press('Escape');
    ok('E107 Esc：選單收起來', await waitFor(async () => !(await visible('#launchMenu'))));
    // E142（常用）：選單共用的那套（見 開發筆記 D182）——鍵盤叫出來的放在那張底下、那張框起來；Esc 游標回那一張、框拿掉；點外面收起來
    const kAtL = await keyMenuAt(card('專案'), 'launchMenu');
    const lpSel = async () => (await card('專案').getAttribute('class')).split(' ').includes('sel');
    ok('E142 常用：鍵盤叫出來的（沒有座標）放在那張底下、那張框起來', await visible('#launchMenu') && same(kAtL, [16, 0]) && await lpSel(), JSON.stringify(kAtL));
    await w.keyboard.press('Escape');
    ok('E142 常用 Esc：選單收起來、框拿掉、游標回那一張', await waitFor(async () => !(await visible('#launchMenu'))) && !(await lpSel())
      && await w.evaluate(() => document.activeElement?.closest('.lp')?.querySelector('.lp-name')?.textContent) === '專案');
    await card('專案').click({ button: 'right' });
    await waitFor(() => visible('#launchMenu'));
    await outsideDown(w);
    ok('E142 常用：點外面收起來、框拿掉', await waitFor(async () => !(await visible('#launchMenu'))) && !(await lpSel()));

    // E108：找不到了（外面刪掉）——重新載入還是開著常用；那張淡、寫找不到；點了提示、沒開。從檔案總管拖一個檔進來是加。拿掉：只從清單拿掉
    fs.rmSync(fileK);
    const n0 = (readN(openK) || '').split('\n').length;
    await w.reload();
    ok('E108 重新載入：左欄還是常用', await waitFor(async () => await visible('#launchPane') && await isOn('#actLaunch'), 8000));
    ok('E108 找不到的：那張淡、寫「找不到：路徑」', await waitFor(async () => await card('我的工具').evaluate(e => e.classList.contains('missing')).catch(() => false)
      && (await card('我的工具').locator('.lp-target').textContent()) === `找不到：${fileK}`));
    await card('我的工具').locator('.lp-open').click();
    ok('E108 點找不到的：提示找不到、沒開', await waitFor(async () => (await toastK()).includes('找不到')) && (readN(openK) || '').split('\n').length === n0);
    const box = await w.locator('#launchList').boundingBox();
    const cdp = await appK.ctx.newCDPSession(w);
    const dragData = { items: [], files: [dropK], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height - 20, data: dragData });
    ok('E108 從檔案總管拖一個檔進來：加在最後面、名稱是檔名', await waitFor(async () => same(await names(), ['專案', '我的工具', 'EX', '拖進來']))
      && same(launchSet()[3], { name: '拖進來', target: dropK }), JSON.stringify([await names(), await toastK()]));
    await card('專案').hover();
    await card('專案').locator('.del').click();
    ok('E108 拿掉：清單、設定檔都沒了，資料夾還在', await waitFor(async () => same(await names(), ['我的工具', 'EX', '拖進來']))
      && same(launchSet().map(x => x.name), ['我的工具', 'EX', '拖進來']) && fs.existsSync(dirK));

    // E136（常用）：一張在編輯時，別張的編輯（✎、右鍵）、加網址、拿掉（×、右鍵）不做、提示（見 開發筆記 D174）；會拿掉的放最後，沒擋住也不連累前面
    for (const [what, act] of [
      ['✎', async () => { await card('拖進來').hover(); await card('拖進來').locator('.edit').click(); }],
      ['右鍵的編輯', async () => { await card('拖進來').click({ button: 'right' }); await w.click('#launchMenu [data-act="edit"]'); }],
      ['加網址', () => w.click('#lpAddUrl')],
      ['×', async () => { await card('拖進來').hover(); await card('拖進來').locator('.del').click(); }],
      ['右鍵的從常用拿掉', async () => { await card('我的工具').click({ button: 'right' }); await w.click('#launchMenu [data-act="remove"]'); }],
    ]) {
      const before = JSON.stringify(launchSet());
      await card('EX').hover();
      await card('EX').locator('.edit').click();
      await w.fill('.lp.editing .lp-name-in', 'EX 改到一半');
      await w.evaluate(() => { document.getElementById('toast').textContent = ''; });
      await act();
      ok(`E136 常用一張在編輯時按別張的「${what}」：不做、提示先儲存或取消，打到一半的還在`,
        await waitFor(async () => ((await toastK()) || '').includes('先儲存或取消正在編輯的那張')) && JSON.stringify(launchSet()) === before
        && (await w.$$('.lp.editing')).length === 1 && (await w.inputValue('.lp.editing .lp-name-in').catch(() => '')) === 'EX 改到一半',
        JSON.stringify({ toast: await toastK(), set: launchSet(), editing: (await w.$$('.lp.editing')).length }));
      for (let i = 0; i < 3 && (await w.$$('.lp.editing')).length; i++) {
        await w.evaluate(() => document.querySelector('.lp.editing button.cancel')?.click());
        await sleep(200);
      }
      await waitFor(async () => (await w.$$('.lp.editing')).length === 0 && (await names()).includes('EX'));
    }

    // E102：記事本開著時點「常用」：左欄換成常用、中間還是記事本；再點收起左欄；點「日記本」回到日記
    await w.click('#actNote');
    await waitFor(() => visible('#noteList'));
    await w.click('#actLaunch');
    ok('E102 記事本時點「常用」：左欄換成常用、中間還是記事本', await waitFor(async () => await visible('#launchPane') && await visible('#notePane') && !(await visible('#noteList')))
      && await isOn('#actLaunch') && await isOn('#actNote'));
    await w.click('#actLaunch');
    ok('E102 再點「常用」：收起左欄', await waitFor(async () => !(await visible('#launchPane')) && await visible('#notePane') && !(await isOn('#actLaunch'))));
    await w.click('#actJournal');
    ok('E102 點「日記本」：回到日記、左欄是日記本', await waitFor(async () => await visible('#center') && await visible('#q') && !(await visible('#launchPane'))));

    // E114：外觀頁「頁籤列」（見 開發筆記 D146）——勾掉的頁籤馬上藏起來、日記本不能藏、記在這台電腦；藏了正在看的記事本：中間回日記；
    // 左欄放的是藏掉的常用：換回日記本那格；重新載入一開起來就藏著（只有 theme.js 套，app.js 開起來不套）；勾回來全部出現
    const shownTabs = () => w.$$eval('#activity > button', bs => bs.filter(b => b.offsetParent).map(b => b.id));
    const boxes = () => w.$$eval('#tabBox label', ls => ls.map(l => [l.textContent.trim(), l.querySelector('input').checked, l.querySelector('input').disabled]));
    const hideSaved = () => w.evaluate(() => [localStorage.getItem('daybook.hideTabs'), document.documentElement.dataset.hideTabs ?? null]);
    const allTabs = ['actJournal', 'actSnip', 'actNote', 'actMd', 'actShot', 'actLaunch', 'actSettings'];
    await viaSettings(w, '#skinBtn');
    await waitFor(() => visible('#tabBox'));
    ok('E114 外觀頁「頁籤列」：日記本、剪貼簿、記事本、文件檢視、截圖、常用都勾著，日記本不能改；頁籤列全部都在',
      same(await boxes(), [['日記本', true, true], ['剪貼簿', true, false], ['記事本', true, false], ['文件檢視', true, false], ['截圖', true, false], ['常用', true, false]])
      && same(await shownTabs(), allTabs), JSON.stringify([await boxes(), await shownTabs()]));
    await w.uncheck('#tabBox [data-tab="snip"]');
    await w.uncheck('#tabBox [data-tab="shot"]');
    ok('E114 勾掉剪貼簿、截圖：馬上藏起來，記在這台電腦', await waitFor(async () => same(await shownTabs(), ['actJournal', 'actNote', 'actMd', 'actLaunch', 'actSettings']))
      && same(await hideSaved(), ['snip shot', 'snip shot']), JSON.stringify([await shownTabs(), await hideSaved()]));
    await w.keyboard.press('Escape');
    await w.click('#actNote');
    await waitFor(() => visible('#notePane'));
    await w.click('#actLaunch');
    ok('E114 前提：記事本開著、左欄放常用', await waitFor(async () => await visible('#notePane') && await visible('#launchPane')));
    await viaSettings(w, '#skinBtn');
    await waitFor(() => visible('#tabBox'));
    await w.uncheck('#tabBox [data-tab="note"]');
    ok('E114 藏起正在看的記事本：中間回日記；左欄的常用沒藏，照舊', await waitFor(async () => !(await visible('#notePane')) && await visible('#center')
      && await visible('#launchPane') && !(await visible('#actNote'))));
    await w.uncheck('#tabBox [data-tab="launch"]');
    ok('E114 藏起左欄放的常用：左欄換回日記本（搜尋、日期）', await waitFor(async () => !(await visible('#launchPane')) && await visible('#q'))
      && same(await hideSaved(), ['snip note shot launch', 'snip note shot launch']) && (await w.evaluate(() => localStorage.getItem('daybook.view'))) === '',
      JSON.stringify(await hideSaved()));
    await w.keyboard.press('Escape');
    await w.reload();
    await waitFor(async () => (await w.$$('#cards .card, #cards .empty')).length > 0, 8000);
    ok('E114 重新載入：一開起來就藏著，中間是日記、左欄是日記本', same(await shownTabs(), ['actJournal', 'actMd', 'actSettings']) && await visible('#center') && await visible('#q'),
      JSON.stringify(await shownTabs()));
    await viaSettings(w, '#skinBtn');
    await waitFor(() => visible('#tabBox'));
    ok('E114 再打開外觀頁：照記的勾（只有日記本、文件檢視勾著）', same((await boxes()).map(b => b[1]), [true, false, false, true, false, false]), JSON.stringify(await boxes()));
    for (const k of ['snip', 'note', 'shot', 'launch']) await w.check(`#tabBox [data-tab="${k}"]`);
    ok('E114 全部勾回來：頁籤列全部出現、記的清空', await waitFor(async () => same(await shownTabs(), allTabs)) && same(await hideSaved(), ['', null]), JSON.stringify(await hideSaved()));
    await w.keyboard.press('Escape');

    // E118：外觀頁「頁籤列」調順序（見 開發筆記 D151）——每列 ↑↓ 搬一格、日記本也能搬；頁籤列照畫面上的位置排（CSS order，DOM 不動）、齒輪還在最底下；
    // 焦點留在按的那顆（搬到頂換另一顆）、連按搬得動；藏起來的照排；記在這台電腦，重新載入一開起來就照排（只有 theme.js 套）；排回預設記空字串
    const seenTabs = () => w.$$eval('#activity > button', bs => bs.filter(b => b.offsetParent).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map(b => b.id));
    const rowsNow = () => w.$$eval('#tabBox .tabRow', rs => rs.map(r => [r.dataset.ord, r.querySelector('.tabUp').disabled, r.querySelector('.tabDown').disabled]));
    const orderSaved = () => w.evaluate(() => localStorage.getItem('daybook.tabOrder'));
    const focused = () => w.evaluate(() => `${document.activeElement.closest('.tabRow')?.dataset.ord} ${document.activeElement.classList.contains('tabUp') ? 'up' : 'down'}`);
    const gearAtBottom = () => w.evaluate(() => Math.abs(document.getElementById('actSettings').getBoundingClientRect().bottom - document.getElementById('activity').getBoundingClientRect().bottom) <= 1);
    const rowOf = (k, b) => `#tabBox .tabRow[data-ord="${k}"] .${b}`;
    await viaSettings(w, '#skinBtn');
    await waitFor(() => visible('#tabBox'));
    ok('E118 外觀頁「頁籤列」一列一個、照預設的順序；最上面的 ↑、最下面的 ↓ 變灰', same(await rowsNow(), [['journal', true, false], ['snip', false, false], ['note', false, false],
      ['md', false, false], ['shot', false, false], ['launch', false, true]]) && same(await seenTabs(), allTabs), JSON.stringify([await rowsNow(), await seenTabs()]));
    await w.click(rowOf('note', 'tabUp'));
    ok('E118 記事本按 ↑：跟剪貼簿換位置，頁籤列馬上跟著排、齒輪還在最底下；記在這台電腦；焦點還在記事本的 ↑',
      await waitFor(async () => same(await seenTabs(), ['actJournal', 'actNote', 'actSnip', 'actMd', 'actShot', 'actLaunch', 'actSettings']))
      && same((await rowsNow()).map(r => r[0]), ['journal', 'note', 'snip', 'md', 'shot', 'launch']) && await gearAtBottom()
      && (await orderSaved()) === 'journal note snip md shot launch' && (await focused()) === 'note up', JSON.stringify([await seenTabs(), await orderSaved(), await focused()]));
    await w.keyboard.press('Enter');
    ok('E118 再按一次（Enter）：記事本搬到最上面、日記本第二；記事本的 ↑ 變灰，焦點換到它的 ↓',
      await waitFor(async () => same(await seenTabs(), ['actNote', 'actJournal', 'actSnip', 'actMd', 'actShot', 'actLaunch', 'actSettings']))
      && same((await rowsNow()).slice(0, 2), [['note', true, false], ['journal', false, false]]) && (await focused()) === 'note down', JSON.stringify([await rowsNow(), await focused()]));
    await w.click(rowOf('launch', 'tabUp'));
    await w.uncheck('#tabBox [data-tab="md"]');
    ok('E118 常用按 ↑、勾掉文件檢視：常用排到截圖前面、文件檢視藏起來（列還在、照排）；齒輪還在最底下',
      await waitFor(async () => same(await seenTabs(), ['actNote', 'actJournal', 'actSnip', 'actLaunch', 'actShot', 'actSettings']))
      && same((await rowsNow()).map(r => r[0]), ['note', 'journal', 'snip', 'md', 'launch', 'shot']) && await gearAtBottom() && (await orderSaved()) === 'note journal snip md launch shot',
      JSON.stringify([await seenTabs(), await orderSaved()]));
    await w.keyboard.press('Escape');
    await w.reload();
    await waitFor(async () => (await w.$$('#cards .card, #cards .empty')).length > 0, 8000);
    ok('E118 重新載入：一開起來就照記的順序排、文件檢視藏著、齒輪在最底下', same(await seenTabs(), ['actNote', 'actJournal', 'actSnip', 'actLaunch', 'actShot', 'actSettings']) && await gearAtBottom(),
      JSON.stringify(await seenTabs()));
    // E122（續）：F1 的分頁跟著頁籤列（見 開發筆記 D156）——照外觀頁調的順序（通用在最前面）、藏起來的文件檢視不列，→ 跳過它；
    // 先停在正在用的那頁：剪貼簿（剛點了頁籤列）、游標在中間就是日記本、記事本、截圖
    {
      const helpOf = () => w.evaluate(() => ({
        tabs: [...document.querySelectorAll('#helpTabs button')].filter(b => b.offsetParent).map(b => b.dataset.page),
        on: document.querySelector('#helpTabs button.on')?.dataset.page,
        shown: [...document.querySelectorAll('#helpPages .helpPage')].filter(p => p.getClientRects().length && getComputedStyle(p).visibility === 'visible').map(p => p.dataset.page).join(),
      }));
      const openHelp = async () => { await w.keyboard.press('F1'); await waitFor(() => visible('#help')); return helpOf(); };
      const closeHelp = async () => { await w.keyboard.press('Escape'); await waitFor(async () => !(await visible('#help'))); };
      const h0 = await openHelp();
      const seq = [];
      for (let i = 0; i < 5; i++) { await w.keyboard.press('ArrowRight'); seq.push((await helpOf()).on); }
      ok('E122 調過順序、藏了文件檢視：分頁照頁籤列排（通用在最前面）、文件檢視不列；→ 跳過它',
        same(h0.tabs, ['common', 'note', 'journal', 'snip', 'launch', 'shot']) && h0.on === 'journal' && same(seq, ['snip', 'launch', 'shot', 'common', 'note']), JSON.stringify([h0, seq]));
      await closeHelp();
      const nows = [];
      await w.click('#actSnip');
      nows.push((await openHelp()).on);
      await closeHelp();
      await w.focus('#newTitle');
      nows.push((await openHelp()).on);
      await closeHelp();
      await w.click('#actJournal');
      await w.click('#actNote');
      await waitFor(() => visible('#notePane'));
      nows.push((await openHelp()).on);
      await closeHelp();
      await w.click('#actJournal');
      await w.click('#actShot');
      await waitFor(() => visible('#shotPane'));
      const shot = await openHelp();
      nows.push(shot.on, shot.shown);
      await closeHelp();
      await w.click('#actJournal');
      ok('E122 先停在正在用的那頁：點了剪貼簿→剪貼簿、游標在中間的標題（左欄還是剪貼簿）→日記本、記事本→記事本、截圖→截圖（只看得到那頁）',
        same(nows, ['snip', 'journal', 'note', 'shot', 'shot']), JSON.stringify(nows));
    }
    await viaSettings(w, '#skinBtn');
    await waitFor(() => visible('#tabBox'));
    ok('E118 再打開外觀頁：列照記的順序、灰的 ↑↓ 對', same(await rowsNow(), [['note', true, false], ['journal', false, false], ['snip', false, false],
      ['md', false, false], ['launch', false, false], ['shot', false, true]]), JSON.stringify(await rowsNow()));
    for (const [k, b] of [['note', 'tabDown'], ['note', 'tabDown'], ['shot', 'tabUp']]) await w.click(rowOf(k, b));   // → journal note… → journal snip note… → 預設
    await w.check('#tabBox [data-tab="md"]');
    ok('E118 排回預設的順序、勾回文件檢視：頁籤列照預設、記的是空字串', await waitFor(async () => same(await seenTabs(), allTabs)) && (await orderSaved()) === '',
      JSON.stringify([await seenTabs(), await orderSaved()]));
    // 「還原預設頁籤」（見 開發筆記 D153）：順序、勾選一起回預設；已經是預設就變灰（只藏一個、只換順序都算不是預設）
    const grays = [await w.isDisabled('#tabReset')];
    await w.uncheck('#tabBox [data-tab="shot"]');
    grays.push(await w.isDisabled('#tabReset'));
    await w.check('#tabBox [data-tab="shot"]');
    grays.push(await w.isDisabled('#tabReset'));
    await w.click(rowOf('launch', 'tabUp'));
    grays.push(await w.isDisabled('#tabReset'));
    ok('E118 「還原預設頁籤」：預設時灰；只藏一個、只換順序就能按，勾回來又灰', same(grays, [true, false, true, false]), JSON.stringify(grays));
    await w.click(rowOf('note', 'tabUp'));
    await w.uncheck('#tabBox [data-tab="snip"]');
    await w.uncheck('#tabBox [data-tab="md"]');
    await w.click('#tabReset');
    ok('E118 按「還原預設頁籤」：頁籤列照預設、外觀頁的列全勾、照預設排；記的都是空字串；鈕變灰、跳提示',
      await waitFor(async () => same(await seenTabs(), allTabs)) && same(await rowsNow(), [['journal', true, false], ['snip', false, false], ['note', false, false],
        ['md', false, false], ['shot', false, false], ['launch', false, true]])
      && (await w.$$eval('#tabBox input', bs => bs.every(b => b.checked))) && (await orderSaved()) === '' && same(await hideSaved(), ['', null])
      && await w.isDisabled('#tabReset') && ((await w.textContent('#toast')) || '').includes('已還原預設頁籤'),
      JSON.stringify([await seenTabs(), await rowsNow(), await orderSaved(), await hideSaved()]));
    await w.keyboard.press('Escape');
    await w.reload();
    await waitFor(async () => (await w.$$('#cards .card, #cards .empty')).length > 0, 8000);
    ok('E118 還原後重新載入：頁籤列照預設、全部都在', same(await seenTabs(), allTabs), JSON.stringify(await seenTabs()));
  } finally {
    await appK.close();
  }

  // E138、E137：另開一個（--user-data，設定檔指 dataR-A；--pick-dir 是「變更資料夾…」要換過去的 dataR-B）
  {
  const udR = path.join(tmpRoot, 'profileR'), dataRA = path.join(tmpRoot, 'dataR-A'), dataRB = path.join(tmpRoot, 'dataR-B');
  for (const d of [udR, dataRA, dataRB]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(udR, 'settings.json'), JSON.stringify({ dataDir: dataRA }));
  const appR = await launch(pw, ['--user-data', udR, '--pick-dir', dataRB]);
  try {
    const w = appR.page;
    const toastR = async () => (await w.textContent('#toast').catch(() => '')) || '';
    const loaded = () => waitFor(async () => (await w.$$('#cards .card, #cards .empty').catch(() => [])).length > 0, 8000);
    await loaded();

    // E138：記事本沒存的暫存檔讀不懂（見 開發筆記 D175）——打開記事本：壞檔改名成 .bad-日期時間留著（內容原封不動）、提示一次；
    // 離開記事本（照常寫一份空的暫存）也不會把它刪掉
    const dirR = await w.evaluate(() => st.info.dataDir);
    const bakDir = path.join(udR, 'note-backup');
    const bakFile = path.join(bakDir, crypto.createHash('md5').update(String(dirR).toLowerCase()).digest('hex').slice(0, 8) + '.json');
    const badText = '{"untitled":[{"name":"救得回的","text":"寫到一半';   // 斷掉的 JSON
    fs.mkdirSync(bakDir, { recursive: true });
    fs.writeFileSync(bakFile, badText);
    const bads = () => fs.readdirSync(bakDir).filter(f => f.startsWith(path.basename(bakFile) + '.bad-'));
    await w.click('#actNote');
    await waitFor(() => w.isVisible('#notePane'));
    ok('E138 記事本暫存檔讀不懂：改名成 .bad-日期時間留著、內容原封不動；提示寫另存成哪個檔', await waitFor(() => bads().length === 1)
      && fs.readFileSync(path.join(bakDir, bads()[0]), 'utf8') === badText && !!(await waitFor(async () => (await toastR()).includes(bads()[0]))),
      JSON.stringify({ files: fs.readdirSync(bakDir), toast: await toastR() }));
    await w.click('#actJournal');
    await sleep(500);
    ok('E138 離開記事本（寫一份空的暫存）：改名留著的那份還在', bads().length === 1 && fs.readFileSync(path.join(bakDir, bads()[0]), 'utf8') === badText,
      JSON.stringify(fs.readdirSync(bakDir)));

    // E137：換資料夾後 Ctrl+Z（見 開發筆記 D028〈後續〉）——在 dataR-A 新增一筆（新檔），「變更資料夾…」換到 dataR-B，Ctrl+Z：
    // 不去動 dataR-A 的檔（原本會把那天的檔刪掉），寫沒有可以復原的動作
    const fileRA = path.join(dataRA, dayPath(localToday()));
    await w.fill('#newTitle', 'E137 換資料夾前加的');
    await w.click('#addDone');
    await waitFor(() => (readN(fileRA) || '').includes('E137 換資料夾前加的'));
    const textRA = readN(fileRA);
    await w.click('#dirBtn');
    await waitFor(async () => (await w.evaluate(() => st.info && st.info.dataDir).catch(() => null)) === dataRB, 8000);
    await loaded();
    await w.click('#dayTitle');
    await w.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await w.keyboard.press('Control+Z');
    await sleep(600);
    ok('E137 換資料夾後 Ctrl+Z：舊資料夾那天的檔不動（不會被刪掉）、寫沒有可以復原的動作', !!textRA && readN(fileRA) === textRA && (await toastR()).includes('沒有可以復原的動作'),
      JSON.stringify({ a: readN(fileRA), toast: await toastR() }));
  } finally {
    await appR.close();
  }
  }

  // E9：測試開的每一個 daybook，設定與快取在系統暫存區、紀錄資料夾在這一輪的暫存資料夾（見 開發筆記 D111；原本是比使用者真的資料夾前後有沒有變，D016）
  const under = (p, dir) => { const r = p ? path.relative(dir, p) : ''; return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
  ok('E9 每個開起來的 daybook，設定與快取都在系統暫存區（不是 %APPDATA%\\daybook）', launched.length > 0 && launched.every(l => under(l.userData, os.tmpdir())),
    JSON.stringify(launched));
  ok('E9 每個開起來的 daybook，紀錄資料夾都在這一輪的暫存資料夾（還沒選的不算）', launched.every(l => !l.data || under(l.data, tmpRoot)), JSON.stringify(launched));
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-e2e-'));
  let code = 0;
  try {
    await run(tmpRoot);
    console.log(`\n${pass} 條通過、${fail} 條失敗`);
    code = fail ? 1 : 0;
  } catch (e) {
    console.error('測試自己壞掉：' + (e.stack || e));
    code = 2;
  } finally {
    // Electron 剛結束時子程序可能還鎖著檔，重試幾次；真的刪不掉就印出來，不讓測試因為清理掛掉
    for (const d of [tmpRoot, devProfile(path.join(tmpRoot, 'data'))]) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.log('清不掉暫存資料夾：' + d + '（' + e.code + '）'); }
    }
  }
  process.exitCode = code;
})();
