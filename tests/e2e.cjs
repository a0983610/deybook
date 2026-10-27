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
const notepad = require(path.join(ROOT, 'src/shared/formats/notepad-txt.js'));
const { parseDay } = require(path.join(ROOT, 'src/shared/parser.js'));
const SAMPLE = path.join(__dirname, 'fixtures', 'sample.txt');   // E37、E38 匯入用
/* 卡片上看得到的東西（見 開發筆記 D046）：E39 匯出再匯回，這些要一模一樣 */
const cardsOf = text => parseDay(text || '').map(e => ({
  heads: e.heads.map(h => h.text), body: e.body.map(b => b.text.replace(/^(\t| {1,4})/, '')), status: e.status, hidden: e.hidden, event: e.event,
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
  const app = await launch(pw, ['--data-dir', data, '--export-dir', exportDir, '--pick-file', SAMPLE, '--open-log', openLog]);
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
    ok('E1 畫面上沒有下拉選單（見 開發筆記 D025）', await waitFor(async () => (await win.$$('#todoCards .card')).length > 0) && (await win.$$('select')).length === 0);
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
    await win.press('#q', 'Escape');
    ok('E28 Esc 清掉搜尋字、灰字也清掉', await waitFor(async () => (await win.inputValue('#q')) === '' && (await qGhost()) === ''), JSON.stringify(await qGhost()));

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
    ok('E33 游標在標題：寫新增表單的', await statusHas('帶入灰字', '換到內文', 'Ctrl+Shift+Enter'), await status());
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

    // E37：左下角「匯入…」（見 開發筆記 D044）——sample.txt 有 6 天，其中 1/15、1/22、9/11 資料夾裡已經有了
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
    const has = k => exported.sources.some(s => cardsOf(s.text).some(c => c[k] != null));
    ok('E39 前提：匯出當時有 ^編號、待回覆的卡片', ['event', 'status'].every(has), '缺：' + ['event', 'status'].filter(k => !has(k)).join('、'));
    ok('E39 每一天都匯進來、卡片跟匯出當時一樣', await waitFor(() => days.every(s => same(cardsOf(readN(path.join(picked4, dayPath(s.src)))), cardsOf(s.text)))),
      days.filter(s => !same(cardsOf(readN(path.join(picked4, dayPath(s.src)))), cardsOf(s.text))).map(s => s.src).join('、'));
    ok('E39 待處理的卡片跟匯出當時一樣', same(cardsOf(readN(path.join(picked4, TODO_FILE))), cardsOf(todoSrc.text)));
    ok('E39 提示寫匯了幾天、認成 daybook Markdown', await waitFor(async () => ((await w4.textContent('#toast').catch(() => '')) || '').includes(`匯入 ${days.length} 天（daybook Markdown）`), 8000),
      await w4.textContent('#toast').catch(() => ''));
  } finally {
    await app4.close();
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
