/* ============================================================
   e2e：開真的 Electron app 操作，再回頭讀磁碟驗（案例表見 e2e測試.md〈e2e 層〉）
   跑法：node tests/e2e.cjs
   Playwright 不另外裝，找全域 @playwright/mcp、@playwright/cli 附的（見 開發筆記 D011）。
   自己開 Electron（--remote-debugging-port=0），再用 chromium.connectOverCDP 連進去——
   Playwright 的 _electron.launch 對 Electron 45 會卡住（見 開發筆記 D011〈後續〉）。
   每輪把 tests/fixtures/data 複製到系統暫存區，用 --data-dir 指過去；跑完刪掉。
   案例照順序跑、會沿用前一條留下的資料（例如 E18 搬進 E2 建的今天那個檔）。
   全部通過 exit 0，有失敗 exit 1，測試自己壞掉 exit 2。
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { dayPath, TODO_FILE } = require(path.join(ROOT, 'src/shared/paths.js'));
const srch = require(path.join(ROOT, 'src/shared/search.js'));

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
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const proc = spawn(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, ...args, '--remote-debugging-port=0'],
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
  return { page, close };
}

async function run(tmpRoot) {
  const pw = loadPlaywright();
  const data = path.join(tmpRoot, 'data');
  fs.cpSync(path.join(__dirname, 'fixtures', 'data'), data, { recursive: true });

  // E9 的基準：使用者真的設定與資料資料夾（見 開發筆記 D016）
  const realProfile = path.join(process.env.APPDATA || '', 'daybook');
  let realData = null;
  try { realData = JSON.parse(fs.readFileSync(path.join(realProfile, 'settings.json'), 'utf8')).dataDir; } catch { /* 沒設定過 */ }
  const before = { profile: snapshot(realProfile), data: snapshot(realData) };

  const app = await launch(pw, ['--data-dir', data]);
  try {
    const win = app.page;
    win.on('dialog', d => d.accept());   // 刪除前的確認視窗
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

    // E1
    ok('E1 開起來停在今天', await waitFor(async () => (await headTitle()).includes(today)), '標題：' + (await headTitle()));
    ok('E1 上已處理、下待處理都在', (await win.isVisible('#doneBox')) && (await win.isVisible('#todoBox')) && (await win.isVisible('#newForm')));
    ok('E1 畫面上沒有下拉選單（見 開發筆記 D025）', await waitFor(async () => (await win.$$('#todoCards .card')).length > 0) && (await win.$$('select')).length === 0);
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

    // E14：刪除待處理
    await cardOf('todo', '折讓證明日期').locator('button.del').click();
    ok('E14 刪除待處理：待辦.md 沒有那筆', await waitFor(() => !readN(todoFile).includes('折讓證明日期')), readN(todoFile));

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
