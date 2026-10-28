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
const FULL = process.argv.includes('--full');   // 沒帶就安靜跑：app 都帶 --quiet-window（見 開發筆記 D052）
const { dayPath, TODO_FILE } = require(path.join(ROOT, 'src/shared/paths.js'));
const srch = require(path.join(ROOT, 'src/shared/search.js'));
const exp = require(path.join(ROOT, 'src/shared/formats/daybook-md.js'));
const fmts = require(path.join(ROOT, 'src/shared/formats/index.js'));   // E31、E57：匯出格式的期望值（見 開發筆記 D078）
const notepad = require(path.join(ROOT, 'src/shared/formats/notepad-txt.js'));
const { parseDay } = require(path.join(ROOT, 'src/shared/parser.js'));
const { checkParsed } = require(path.join(ROOT, 'src/shared/import.js'));
const EXAMPLE = path.join(ROOT, 'examples', 'extensions', 'daybook-example-dated');   // E43：範例擴充（見 開發筆記 D055）
const SAMPLE = path.join(__dirname, 'fixtures', 'sample.txt');   // E37、E38 匯入用
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

/* 開 Electron，從 stderr 抓 DevTools 位址連進去，拿到主視窗那一頁 */
async function launch(pw, args) {
  const proc = spawn(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, ...args, ...(FULL ? [] : ['--quiet-window']), '--remote-debugging-port=0'],
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
  return { page, close, pid: proc.pid };
}

/* 視窗標題（原生的，CDP 讀到的是網頁 <title>，不一樣）：問 Windows */
const windowTitle = pid => execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).MainWindowTitle`]).toString().trim();
/* 最前面那個視窗是哪個程序的（E41）：問 Windows */
const foregroundPid = () => Number(execFileSync('powershell', ['-NoProfile', '-Command',
  'Add-Type -Name W -Namespace U -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); '
  + '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);\'; '
  + '$p = 0; [void][U.W]::GetWindowThreadProcessId([U.W]::GetForegroundWindow(), [ref]$p); $p']).toString().trim());

async function run(tmpRoot) {
  const pw = loadPlaywright();
  const data = path.join(tmpRoot, 'data');
  fs.cpSync(path.join(__dirname, 'fixtures', 'data'), data, { recursive: true });
  const exportDir = path.join(tmpRoot, 'export');   // E31：匯出寫到這裡，不跳存檔視窗（見 開發筆記 D035）
  fs.mkdirSync(exportDir);

  // E9 的基準：使用者真的設定與資料資料夾（見 開發筆記 D016）
  const realProfile = path.join(process.env.APPDATA || '', 'daybook');
  let realData = null;
  try { realData = JSON.parse(fs.readFileSync(path.join(realProfile, 'settings.json'), 'utf8')).dataDir; } catch { /* 沒設定過 */ }
  const before = { profile: snapshot(realProfile), data: snapshot(realData) };

  let exported = null;   // E31 匯出全部的檔、當時資料夾裡的內容，E39 拿來匯回
  const openLog = path.join(tmpRoot, 'open.log');   // E40：「開啟位置」不真的開檔案總管，路徑寫進這裡（見 開發筆記 D051）
  // --existing 略過：E37 匯入時已經有的日子不跳視窗，當作按了「略過」（見 開發筆記 D063）
  const app = await launch(pw, ['--data-dir', data, '--export-dir', exportDir, '--pick-file', SAMPLE, '--open-log', openLog, '--existing', '略過']);
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
    // 匯出列的格式下拉選單是使用者選的（D078），不算
    ok('E1 畫面上沒有下拉選單（見 開發筆記 D025）', await waitFor(async () => (await win.$$('#todoCards .card')).length > 0) && (await win.$$('select:not(#expFmt)')).length === 0);
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

    // E7：待回覆一鍵切換（不用下拉，見 開發筆記 D025）
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

    // E15：事件時間軸
    await cardOf('2026-01-22', yq).locator('button.chip.event').click();
    ok('E15 點 ^1 看到這件事每一天的紀錄', await waitFor(async () => same(await resultSrcs(), ['2026-01-22', today])), JSON.stringify(await resultSrcs()));
    ok('E15 標題寫幾筆', (await headTitle()).includes('事件 ^1：2 筆'), await headTitle());
    ok('E15 結果畫面不顯示已處理／待處理', !(await win.isVisible('#doneBox')) && !(await win.isVisible('#todoBox')));

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
    }

    // E55：外觀頁「還原預設大小」（見 開發筆記 D075）——卡片模式、文字模式都拉過，一次還原
    {
    await win.click('#skinBtn');
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
    await win.click('#skinBtn');
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

    // E51：日期清單一週一段底色（見 開發筆記 D071）——外面加 01-16（跟 01-15 同一週，週四、週五），看完刪掉
    const f0116 = path.join(data, dayPath('2026-01-16'));
    fs.writeFileSync(f0116, '同一週的另一天\n');
    await waitFor(async () => (await win.$$('#dayList button[data-date="2026-01-16"]')).length === 1);
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
    ok('E53 標過的按「標記」：冒出分類鈕、現在的（未分類）亮著、最後是「取消標記」；還沒有分類檔', await waitFor(async () => same(await pickTexts(cardOf(today, cm)), ['未分類', '＋ 新分類', '取消標記']))
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
    ok('E53 沒標記的按「標記」：分類照清單順序、沒有亮的、最後是「取消」', await waitFor(async () => same(await pickTexts(cw53), ['未分類', '等客戶', '＋ 新分類', '取消']))
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
      && same(await filterTexts(), ['全部 4', '未分類 1', '等客戶 1', '要測 1', '外面打的 1'])) && /\bon\b/.test(await win.getAttribute(filterBtn('全部'), 'class')),
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
    await win.click('#exportBtn');
    const [ty, tm, td] = today.split('-').map(Number);
    const monday = localIso(new Date(ty, tm - 1, td - ((new Date(ty, tm - 1, td).getDay() + 6) % 7)));
    ok('E31 按「匯出…」出現起訖兩格，預設這週一到今天', (await win.isVisible('#exportBar')) && (await win.inputValue('#expFrom')) === monday && (await win.inputValue('#expTo')) === today,
      `${await win.inputValue('#expFrom')} ～ ${await win.inputValue('#expTo')}（應為 ${monday} ～ ${today}）`);
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
    await win.click('#exportBtn');
    await win.click('#exportBtn');
    ok('E31 選過的格式記在這台電腦：收起來再打開還是 Excel', (await waitFor(async () => (await win.inputValue('#expFmt')) === 'xlsx'))
      && (await win.evaluate(() => localStorage.getItem('daybook.exportFormat'))) === 'xlsx', await win.inputValue('#expFmt'));
    await win.selectOption('#expFmt', 'daybook-md');
    ok('E31 匯出不動資料資料夾', same(snapshot(data), dataBefore));
    exported = { file: fAll, sources: readSources(data) };
    await win.click('#exportBtn');
    ok('E31 再按一次「匯出…」收起來', await waitFor(async () => !(await win.isVisible('#exportBar'))));

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
    await win.mouse.click(5, 5);
    ok('E33 點外面關掉', await waitFor(async () => !(await win.isVisible('#help'))));

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
    await win.keyboard.press('Control+Equal');
    await win.keyboard.press('Control+Equal');
    await zoomIs(1.25, '125%');
    await win.reload();
    await win.waitForSelector('#dayList button');
    ok('E36 重新載入記得上次的大小', await zoomIs(1.25, '125%'), JSON.stringify(await zoomOf()));
    await win.click('#zoomBtn');
    ok('E36 點狀態列的比例：還原 100%', await zoomIs(1, '100%'), JSON.stringify(await zoomOf()));

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
    await win.mouse.click(5, 5);
    ok('E40 點外面關掉', await waitFor(async () => !(await shown('#info'))));
    await win.click('#infoBtn');
    await waitFor(() => shown('#info'));
    await win.click('#infoClose');
    ok('E40 按 ✕ 關掉', await waitFor(async () => !(await shown('#info'))));

    // E37：左下角「匯入…」（見 開發筆記 D044）——sample.txt 有 6 天，其中 1/15、1/22、9/11 資料夾裡已經有了；啟動帶了 --existing 略過（D063）
    const sampleDays = notepad.splitDays(readN(SAMPLE));
    const newDays = ['2025-12-29', '2025-12-31', '2026-08-04'];
    const oldDays = ['2026-01-15', '2026-01-22', '2026-09-11'];
    const oldText = Object.fromEntries(oldDays.map(d => [d, readN(path.join(data, dayPath(d)))]));
    ok('E37 前提：那 3 天原本沒有、另 3 天原本有', newDays.every(d => !fs.existsSync(path.join(data, dayPath(d)))) && oldDays.every(d => oldText[d]));
    await win.click('#importBtn');
    ok('E37 沒有的日子寫進來，內容＝拆出來的那天', await waitFor(() => newDays.every(d => readN(path.join(data, dayPath(d))) === notepad.dayText(sampleDays.find(x => x.date === d)))),
      newDays.map(d => JSON.stringify(readN(path.join(data, dayPath(d))))).join('\n'));
    ok('E37 已經有的日子不動', oldDays.every(d => readN(path.join(data, dayPath(d))) === oldText[d]));
    ok('E37 提示寫匯了幾天、認成哪種格式、跳過哪幾天', await waitFor(async () => { const t = await toast(); return t.includes('匯入 3 天（舊記事本）') && t.includes('跳過 3 天') && t.includes('01-15'); }), await toast());
    ok('E37 左邊日期清單出現匯進來的日子', await waitFor(async () => (await win.$$(`#dayList button[data-date="2025-12-29"]`)).length === 1));
    await win.click('#dayTitle');
    await win.keyboard.press('Control+Z');
    ok('E37 Ctrl+Z 整批復原：匯進來的 3 天都拿掉、原本的不動', await waitFor(() => newDays.every(d => !fs.existsSync(path.join(data, dayPath(d)))))
      && oldDays.every(d => readN(path.join(data, dayPath(d))) === oldText[d]), await toast());

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

    // E16、E10：文字模式
    await win.click(`#dayList button[data-date="${today}"]`);
    await win.click('#modeBtn');
    ok('E16 文字模式：上面是今天的原文', await editorIs('#editor', readN(todayFile)));
    ok('E10 文字模式：下面是 待辦.md 的原文', await editorIs('#todo', readN(todoFile)));
    const typed = readN(todayFile) + '文字模式打的\n';
    await win.fill('#editor', typed);
    ok('E16 文字模式自動存檔', await waitFor(() => readN(todayFile) === typed), JSON.stringify(readN(todayFile)));
    const todoTyped = readN(todoFile) + '文字模式的待處理\n';
    await win.fill('#todo', todoTyped);
    ok('E10 待處理文字模式自動存檔', await waitFor(() => readN(todoFile) === todoTyped), JSON.stringify(readN(todoFile)));
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
    ok('E16 切回卡片模式：剛打的字變成卡片', await waitFor(async () => (await doneTitles()).includes('文字模式打的') && (await todoTitles()).includes('文字模式的待處理')),
      JSON.stringify([await doneTitles(), await todoTitles()]));
  } finally {
    await app.close();
  }

  // E35：還沒選資料夾——不在啟動時跳視窗，進畫面後讓使用者自己選（見 開發筆記 D041）
  // --user-data 指到暫存的設定資料夾（設定檔裡的資料夾故意是不存在的），--pick-dir 代替原生的選資料夾視窗
  const ud = path.join(tmpRoot, 'profile');
  const picked = path.join(tmpRoot, 'picked');
  const lost = path.join(tmpRoot, '不見的資料夾');
  fs.mkdirSync(ud);
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ dataDir: lost }));
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
  const app3 = await launch(pw, ['--user-data', ud3, '--pick-dir', picked3, '--pick-file', SAMPLE]);
  try {
    const w3 = app3.page;
    await waitFor(async () => w3.isVisible('#setup').catch(() => false), 8000);
    await w3.click('#setupImport');
    const want = notepad.splitDays(readN(SAMPLE));
    ok('E38 先選資料夾：設定檔記下', await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(ud3, 'settings.json'), 'utf8')).dataDir === picked3; } catch { return false; } }));
    ok('E38 再匯入：6 天全寫進那個資料夾', await waitFor(() => want.every(d => readN(path.join(picked3, dayPath(d.date))) === notepad.dayText(d))),
      want.map(d => d.date + ' ' + fs.existsSync(path.join(picked3, dayPath(d.date)))).join('、'));
    ok('E38 重新載入後卡片收起來、提示匯了幾天', await waitFor(async () => !(await w3.isVisible('#setup').catch(() => true))
      && ((await w3.textContent('#toast').catch(() => '')) || '').includes('匯入 6 天'), 8000), await w3.textContent('#toast').catch(() => ''));
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
  // --pick-format：E45 兩種都認得時不跳視窗，當作選了 AI 寫的那個（見 開發筆記 D058）
  // --existing 加進去：E45 日子都已經有，當作按了「加進去」；內容一模一樣，一筆都不會加（見 開發筆記 D063）
  const app5 = await launch(pw, ['--user-data', ud5, '--pick-file', sample5, '--open-log', open5, '--clipboard-file', clip5, '--pick-format', 'AI 日期分隔', '--existing', '加進去',
    '--export-dir', export5]);
  try {
    const w5 = app5.page;
    const toast5 = () => w5.textContent('#toast').catch(() => '');
    const settings5 = () => { try { return JSON.parse(fs.readFileSync(path.join(ud5, 'settings.json'), 'utf8')); } catch { return null; } };
    const row = name => `#extTable tr[data-ext="${name}"]`;
    const stateOf = name => w5.$eval(row(name) + ' .extState', e => [e.dataset.state, e.textContent]).catch(() => null);
    const visible = sel => w5.isVisible(sel).catch(() => false);
    await waitFor(async () => (await w5.$$('#dayList button')).length > 0, 8000);
    const journal5 = path.join(picked5, 'journal');

    await w5.click('#importBtn');
    ok('E43 還沒啟用：認不出格式，提示有 2 個擴充還沒啟用、什麼都沒寫',
      await waitFor(async () => { const t = await toast5(); return t.includes('認不出') && t.includes('有 2 個擴充還沒啟用'); }) && !fs.existsSync(journal5), await toast5());

    await w5.click('#fmtBtn');
    await waitFor(() => visible('#fmt'));
    const builtin5 = await w5.textContent('#fmtBuiltin');
    ok('E43 格式頁列出內建的兩種匯入格式', builtin5.includes('daybook Markdown') && builtin5.includes('舊記事本'), builtin5);
    const builtinOut5 = await w5.textContent('#fmtBuiltinOut');
    ok('E43 格式頁列出內建的匯出格式（D078）', builtinOut5.includes('daybook Markdown（.md，') && builtinOut5.includes('Excel（.xlsx，'), builtinOut5);
    ok('E43 頁面標題是「格式」（D078 改名）', (await w5.textContent('#fmt h2')) === '格式', await w5.textContent('#fmt h2'));
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
    ok('E43 只有未啟用的有「啟用」，版本不合、壞掉的沒有按鈕', (await w5.$$(row('daybook-example-dated') + ' [data-act="ask"]')).length === 1
      && (await w5.$$(row('b-new') + ' .extBtn')).length === 0 && (await w5.$$(row('c-broken') + ' .extBtn')).length === 0);
    await w5.click('#fmt .openBtn[data-open="extensions"]');
    ok('E43 擴充資料夾的「開啟位置」', await waitFor(() => (readN(open5) || '').trim() === extRoot), readN(open5));

    // 啟用要兩步：先展開提醒，按「確定啟用」才記下
    await w5.click(row('daybook-example-dated') + ' [data-act="ask"]');
    ok('E43 按「啟用」先展開提醒（能匯入也能匯出的寫兩種時候都會跑），還沒啟用', await visible(row('daybook-example-dated') + ' .extConfirm')
      && (await w5.textContent(row('daybook-example-dated') + ' .extConfirm')).includes('可以讀寫你電腦上所有你能碰的檔案')
      && (await w5.textContent(row('daybook-example-dated') + ' .extConfirm')).includes('會在你按「匯入…」或匯出時執行')
      && (await stateOf('daybook-example-dated'))[0] === 'disabled' && !settings5().extensions);
    await w5.click(row('daybook-example-dated') + ' [data-act="cancel"]');
    ok('E43 取消：提醒收起來、「啟用」回來', !(await visible(row('daybook-example-dated') + ' .extConfirm')) && await visible(row('daybook-example-dated') + ' [data-act="ask"]'));
    await w5.click(row('daybook-example-dated') + ' [data-act="ask"]');
    await w5.click(row('daybook-example-dated') + ' [data-act="on"]');
    ok('E43 確定啟用：變成已啟用、有「停用」，設定檔記下名稱＋版本',
      await waitFor(async () => (await stateOf('daybook-example-dated') || [])[0] === 'enabled') && await visible(row('daybook-example-dated') + ' [data-act="off"]')
      && same(settings5().extensions, { 'daybook-example-dated': exV }) && settings5().dataDir === picked5, JSON.stringify(settings5()));
    await w5.keyboard.press('Escape');

    // 用範例擴充匯入：期望值＝範例自己的 parse 拆出來、再經 daybook 檢查的
    const want5 = checkParsed(require(path.join(EXAMPLE, 'index.js')).formats['dated-txt'].parse(readN(sample5)));
    await w5.click('#importBtn');
    ok('E43 啟用後匯入：每一天照範例拆的寫進來、待處理寫進 待辦.md',
      await waitFor(() => want5.days.every(d => readN(path.join(picked5, dayPath(d.date))) === d.text) && readN(path.join(picked5, TODO_FILE)) === want5.todo),
      want5.days.map(d => d.date + ' ' + JSON.stringify(readN(path.join(picked5, dayPath(d.date))))).join('\n'));
    ok('E43 提示寫認成擴充的格式', await waitFor(async () => (await toast5()).includes(`匯入 ${want5.days.length} 天（日期分隔純文字，擴充「範例：日期分隔純文字」）`)), await toast5());

    // detect 會丟錯的擴充：啟用後匯入報錯寫是哪個擴充，daybook 照常能用；停用後設定檔拿掉它
    await w5.click('#fmtBtn');
    await waitFor(() => visible('#fmt'));
    await w5.click(row('d-throws') + ' [data-act="ask"]');
    await w5.click(row('d-throws') + ' [data-act="on"]');
    await waitFor(async () => (await stateOf('d-throws') || [])[0] === 'enabled');
    await w5.keyboard.press('Escape');
    const before5 = fs.readdirSync(journal5, { recursive: true }).length;
    await w5.click('#importBtn');
    ok('E43 擴充丟錯：報錯寫是哪個擴充、錯誤訊息，什麼都沒寫', await waitFor(async () => (await toast5()).includes('擴充「d-throws」出錯：e2e 故意的'))
      && fs.readdirSync(journal5, { recursive: true }).length === before5, await toast5());
    await w5.click('#fmtBtn');
    ok('E43 擴充丟錯之後 daybook 照常能用', await waitFor(() => visible('#fmt')));
    await w5.click(row('d-throws') + ' [data-act="off"]');
    ok('E43 停用：變回未啟用，設定檔只剩範例', await waitFor(async () => (await stateOf('d-throws') || [])[0] === 'disabled')
      && same(settings5().extensions, { 'daybook-example-dated': exV }), JSON.stringify(settings5()));

    // E44：請 AI 寫一個新的格式（見 開發筆記 D056）——接著 E43：範例還啟用著、資料夾已經匯過 sample.txt、匯入格式頁開著。
    // 拿範例改個名字當成 AI 回的
    const ai = require(path.join(ROOT, 'src/main/ai-ext.js'));
    const aiText = () => w5.textContent('#aiResult').catch(() => '');
    ok('E44 「格式」在「匯出…」旁邊（D078 改名）', (await w5.$$('#exportBtn + #fmtBtn')).length === 1 && (await w5.textContent('#fmtBtn')) === '格式');
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
    await w5.click(row('daybook-example-dated') + ' [data-act="off"]');
    await waitFor(async () => (await stateOf('daybook-example-dated') || [])[0] === 'disabled');
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
    ok('E44 安裝不匯入：資料資料夾一個檔都沒變', same(snapshot(picked5), data5Before));
    await w5.keyboard.press('Escape');
    ok('E44 Esc 關掉格式頁', await waitFor(async () => !(await visible('#fmt'))));

    // E45：兩種以上格式都認得要匯入的檔（見 開發筆記 D058）——接著 E44：ai-dated 裝好啟用了，再啟用範例，兩個都認得 sample.txt。
    // 啟動帶了 --pick-format「AI 日期分隔」：不跳視窗、當作選了它；它排在範例後面，選第一個的話會是範例
    await w5.click('#fmtBtn');
    await waitFor(() => visible('#fmt'));
    await w5.click(row('daybook-example-dated') + ' [data-act="ask"]');
    await w5.click(row('daybook-example-dated') + ' [data-act="on"]');
    await waitFor(async () => (await stateOf('daybook-example-dated') || [])[0] === 'enabled');
    await w5.keyboard.press('Escape');
    await w5.click('#importBtn');
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
    await w5.click('#exportBtn');
    ok('E57 匯出的下拉選單：內建兩種＋已啟用擴充的匯出格式（只能匯入的 ai-dated 不列）', await waitFor(async () => (await opts5()).length === 3)
      && same(await opts5(), [['daybook-md', 'daybook Markdown（.md）'], ['xlsx', 'Excel（.xlsx）'], ['daybook-example-dated/dated-txt', '日期分隔純文字（.txt，擴充「範例：日期分隔純文字」）']]),
      JSON.stringify(await opts5()));
    await w5.selectOption('#expFmt', 'daybook-example-dated/dated-txt');
    await w5.click('#expAll');
    const f57 = path.join(export5, `工作紀錄_全部_${localToday()}.txt`);
    ok('E57 用範例擴充匯出全部：寫出 .txt，內容＝範例的 write 寫出來的（在擴充程序跑）', await waitFor(() => readN(f57) === want57, 8000), JSON.stringify(readN(f57)));
    await w5.click('#exportBtn');

    // 請 AI 寫匯出格式（D079）：選「匯出格式」，prompt、說明的字跟著換
    await w5.click('#fmtBtn');
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
      && settings5().extensions['ai-out'] === outPkg.version && (await aiText()).includes('已安裝並啟用「AI：匯出」：之後在「匯出…」選這個格式'), await aiText());
    await w5.check('#fmt input[name="aiKind"][value="import"]');
    ok('E57 換回「匯入格式」：prompt 換回匯入的、結果收起來', await waitFor(async () => (await w5.textContent('#aiPromptText')) === ai.buildPrompt(appV)) && !(await visible('#aiResult')));
    await w5.keyboard.press('Escape');
    await w5.click('#exportBtn');
    ok('E57 裝好的匯出格式出現在下拉選單', await waitFor(async () => (await opts5()).some(([k, t]) => k === 'ai-out/dated-txt' && t === 'AI 匯出（.txt，擴充「AI：匯出」）')),
      JSON.stringify(await opts5()));
    ok('E57 匯出、試跑、安裝都不動資料資料夾', same(snapshot(picked5), data57));
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
    // 背景圖：有沒有顯示、放的圖、多濃、亮暗的 filter；空白時的插圖：放的圖、真的載得出來（CSP 擋 data: 的話 naturalWidth 是 0）
    // 一張背景圖一層（D067）：這個外觀包只有一張，看第一層
    const bg6 = () => w6.$eval('#skinBg', e => {
      const l = e.firstElementChild;
      return { shown: !e.hidden, layers: e.children.length, image: l ? l.style.backgroundImage : '', opacity: l ? l.style.opacity : '', filter: getComputedStyle(e).filter, pe: getComputedStyle(l || e).pointerEvents };
    });
    const empties6 = () => w6.$$eval('.empty .skinEmpty', imgs => imgs.map(i => ({ src: i.src, loaded: i.complete && i.naturalWidth > 0, pane: i.closest('.cardList').id })));
    await waitFor(async () => (await w6.$$('#cards .empty')).length > 0, 8000);

    ok('E46 還沒啟用：沒有背景圖、空白的那一行沒有插圖', !(await bg6()).shown && (await empties6()).length === 0);
    ok('E46 「外觀」在「黑暗模式」後面、「說明」還是最後一顆', (await w6.$$('#themeBtn + #skinBtn + #infoBtn')).length === 1
      && (await w6.textContent('#skinBtn')) === '外觀' && (await w6.$$('#infoBtn + *')).length === 0);
    await w6.click('#skinBtn');
    await waitFor(() => visible('#skin'));
    ok('E46 外觀包資料夾＝設定資料夾的 skins', (await w6.textContent('#fSkins')) === skinRoot, await w6.textContent('#fSkins'));
    ok('E46 兩個照資料夾名稱排，壞掉的用資料夾名稱', same(await w6.$$eval('#skinTable tr', trs => trs.map(t => t.dataset.skin)), ['a-sloth', 'b-broken'])
      && !(await visible('#skinNone')));
    const ss = await sstate('a-sloth'), sb6 = await sstate('b-broken');
    ok('E46 狀態：未啟用、列名稱版本和有哪些圖；壞掉的寫原因、沒有啟用／停用（只有刪除，D073）',
      ss[0] === 'disabled' && ss[1] === '未啟用' && (await w6.textContent(srow('a-sloth'))).includes('樹懶 1.0.0') && (await w6.textContent(srow('a-sloth'))).includes('有：背景圖、空白時的插圖')
      && sb6[0] === 'broken' && sb6[1].includes('沒有 package.json')
      && same(await w6.$$eval(srow('b-broken') + ' .extBtn', bs => bs.filter(b => !b.closest('.extConfirm')).map(b => b.dataset.act)), ['ask']), JSON.stringify([ss, sb6]));
    ok('E46 手寫 package.json 的說明拿掉了（D068）', (await w6.$$('#skinSample')).length === 0 && !(await w6.textContent('#skin')).includes('自己寫 package.json'));
    await w6.click('#skin .openBtn[data-open="skins"]');
    ok('E46 外觀包資料夾的「開啟位置」', await waitFor(() => (readN(open6) || '').trim() === skinRoot), readN(open6));

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
    await w6.click('#skinBtn');
    await waitFor(() => visible('#skin'));
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
    await w6.click('#skinBtn');
    await waitFor(() => visible('#skin'));
    ok('E46 壞掉的寫原因', ((await sstate('a-sloth')) || [])[0] === 'broken' && (await sstate('a-sloth'))[1].includes('找不到圖檔 bg.png'), JSON.stringify(await sstate('a-sloth')));

    // E53：刪除外觀包（見 開發筆記 D073）——先問一次再丟資源回收筒；啟動帶 --trash-dir，搬進暫存資料夾，不碰使用者的資源回收筒。
    // 把圖放回去、重新載入：a-sloth 是啟用中、好的；b-broken 壞掉的
    fs.writeFileSync(path.join(sloth, 'bg.png'), png6);
    await w6.reload();
    await waitFor(async () => (await bg6()).shown, 8000);
    await w6.click('#skinBtn');
    await waitFor(() => visible('#skin'));
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
    await w9.click('#skinBtn');
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

  // E47：已經有的日子「加進去」（見 開發筆記 D063）——fixture 複本、sample.txt 跟 E37 一樣（6 天，其中 1/15、1/22、9/11 已經有）；
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
    const sampleDays = notepad.splitDays(readN(SAMPLE));
    const sampleText = d => notepad.dayText(sampleDays.find(x => x.date === d));
    const newDays = ['2025-12-29', '2025-12-31', '2026-08-04'];
    const old7 = Object.fromEntries(['2026-01-15', '2026-01-22', '2026-09-11'].map(d => [d, day7(d)]));
    // sample 那 3 天的每一筆跟 fixture 都不一樣（fixture 1/15 的 TX_Cancel… 跟上一行共用內容，算不同的一筆，D009），全部接在後面；
    // fixture 那 3 天的最後一筆接 sample 的第一筆都不會黏在一起，不用隔空行
    await w7.click('#importBtn');
    ok('E47 加進去：已經有的 3 天，sample 那天的每一筆接在最後面；沒有的 3 天照寫',
      await waitFor(() => Object.keys(old7).every(d => day7(d) === old7[d] + sampleText(d)) && newDays.every(d => day7(d) === sampleText(d))),
      Object.keys(old7).map(d => d + ' ' + JSON.stringify(day7(d))).join('\n'));
    ok('E47 提示寫加進幾筆', await waitFor(async () => (await toast7()).includes('匯入 3 天（舊記事本）；資料夾裡已經有的 3 天：加進 8 筆（Ctrl+Z')), await toast7());
    // 同一份再匯一次：6 天都已經有、每一筆都一模一樣 → 一個檔都沒變
    const snap7 = snapshot(data7);
    await w7.click('#importBtn');
    ok('E47 同一份再匯一次：一筆都不加、一個檔都沒變',
      await waitFor(async () => (await toast7()).includes('匯入 0 天（舊記事本）；資料夾裡已經有的 6 天：加進 0 筆，12 筆一模一樣的沒加')) && same(snapshot(data7), snap7), await toast7());
    // 第二次什麼都沒寫，不算一個動作：Ctrl+Z 復原的是第一次
    await w7.click('#dayTitle');
    await w7.keyboard.press('Control+Z');
    ok('E47 Ctrl+Z 整批復原：加進去的拿掉、新的 3 天拿掉', await waitFor(() => Object.keys(old7).every(d => day7(d) === old7[d]) && newDays.every(d => day7(d) == null)), await toast7());
  } finally {
    await app7.close();
  }

  // E9
  const after = { profile: snapshot(realProfile), data: snapshot(realData) };
  ok('E9 沒動到 %APPDATA%\\daybook', same(after.profile, before.profile),
    `前：${JSON.stringify(before.profile)}\n    後：${JSON.stringify(after.profile)}`);
  ok('E9 沒動到使用者的資料資料夾', same(after.data, before.data), realData || '（沒設定過）');
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
