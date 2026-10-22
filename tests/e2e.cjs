/* ============================================================
   e2e：開真的 Electron app 操作，再回頭讀磁碟驗（案例表見 e2e測試.md〈e2e 層〉）
   跑法：node tests/e2e.cjs
   Playwright 不另外裝，找全域 @playwright/mcp、@playwright/cli 附的（見 開發筆記 D011）。
   自己開 Electron（--remote-debugging-port=0），再用 chromium.connectOverCDP 連進去——
   Playwright 的 _electron.launch 對 Electron 45 會卡住（見 開發筆記 D011〈後續〉）。
   每輪把 tests/fixtures/data 複製到系統暫存區，用 --data-dir 指過去；跑完刪掉。
   案例照順序跑、會沿用前一條留下的資料（例如 E12 用到 E2 新增的今天那個檔）。
   全部通過 exit 0，有失敗 exit 1，測試自己壞掉 exit 2。
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
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
    const todayFile = path.join(data, dayPath(today));
    const f0122 = path.join(data, dayPath('2026-01-22'));
    const f0115 = path.join(data, dayPath('2026-01-15'));
    const todoFile = path.join(data, TODO_FILE);
    const titles = () => win.$$eval('#cards .card .title', els => els.map(e => e.textContent));
    const resultSrcs = () => win.$$eval('#results .card', els => els.map(e => e.dataset.src));
    const openTexts = () => win.$$eval('#openList li', els => els.map(e => e.textContent));
    const cardOf = (src, text) => win.locator(`.card[data-src="${src}"]`, { hasText: text }).first();
    const headTitle = () => win.textContent('#dayTitle');
    const editorIs = want => waitFor(async () => (await win.inputValue('#editor')) === want);
    const addUpdate = async (c, text) => {
      await c.locator('button.upd').click();
      await c.locator('.upd-text').fill(text);
      await c.locator('.upd-text').press('Enter');
    };

    // E1
    ok('E1 開起來停在今天', await waitFor(async () => (await headTitle()).includes(today)), '標題：' + (await headTitle()));
    ok('E1 預設是卡片模式', await win.isVisible('#newForm'));

    // E2：用表單新增一筆
    ok('E2 前提：今天原本沒有檔', !fs.existsSync(todayFile));
    await win.fill('#newTitle', 'CWMM3030 備料調撥 BUG');
    await win.press('#newTitle', 'Enter');
    await win.fill('#newBody', '材料彙總，請將「備料散裝數量」欄位拿掉');
    await win.selectOption('#newStatus', '待處理');
    await win.click('#addBtn');
    const want2 = 'CWMM3030 備料調撥 BUG [待處理]\n\t材料彙總，請將「備料散裝數量」欄位拿掉\n';
    ok('E2 新增一筆：磁碟上今天的檔', await waitFor(() => readN(todayFile) === want2), JSON.stringify(readN(todayFile)));
    ok('E2 卡片出現、表單清空', await waitFor(async () => (await titles()).includes('CWMM3030 備料調撥 BUG') && (await win.inputValue('#newTitle')) === ''));

    // E13：今天的卡片 + 更新 → 接在同一筆底下
    await addUpdate(cardOf(today, 'CWMM3030 備料調撥 BUG'), '小童說先不改');
    ok('E13 今天的卡片加更新：接在同一筆底下', await waitFor(() => readN(todayFile) === want2 + '\t->小童說先不改\n'), JSON.stringify(readN(todayFile)));

    // E4：點日期
    await win.click('#dayList button[data-date="2026-01-22"]');
    ok('E4 點日期清單的某一天，顯示那天的卡片', await waitFor(async () => same(await titles(), ['CWIN301021 銷退單 BUG', '雅琦問題：發票作廢後又產生一次作廢的XML'])),
      JSON.stringify(await titles()));

    // E3：外部改檔（接在 E4 後面：畫面上已經確定是舊內容）
    fs.appendFileSync(f0122, 'CWIN5890 寄庫批次開帳作業\n\t外部加的\n');
    ok('E3 外部改檔，卡片不用重開就更新', await waitFor(async () => (await titles()).includes('CWIN5890 寄庫批次開帳作業')), JSON.stringify(await titles()));

    // E7：改狀態
    await cardOf('2026-01-22', 'CWIN301021 銷退單 BUG').locator('select.status').selectOption('待回覆');
    ok('E7 改狀態：磁碟上那行的行尾跟著變', await waitFor(() => readN(f0122).split('\n')[0] === 'CWIN301021 銷退單 BUG [待回覆]'), readN(f0122).split('\n')[0]);
    ok('E7 待回覆 → 出現在未結', await waitFor(async () => (await openTexts()).some(t => t.includes('CWIN301021 銷退單 BUG'))), JSON.stringify(await openTexts()));
    await cardOf('2026-01-22', 'CWIN301021 銷退單 BUG').locator('select.status').selectOption('完成');
    ok('E7 改成完成：行尾跟著變', await waitFor(() => readN(f0122).split('\n')[0] === 'CWIN301021 銷退單 BUG [完成]'), readN(f0122).split('\n')[0]);
    ok('E7 完成 → 從未結消失', await waitFor(async () => !(await openTexts()).some(t => t.includes('CWIN301021 銷退單 BUG'))), JSON.stringify(await openTexts()));

    // E8：標題中間有方括號
    const br = 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期';
    const orig0115 = readN(f0115);
    await win.click('#dayList button[data-date="2026-01-15"]');
    await waitFor(async () => (await titles()).includes(br));
    await cardOf('2026-01-15', '折讓證明日期').locator('select.status').selectOption('待回覆');
    ok('E8 只動行尾', await waitFor(() => (readN(f0115) || '').split('\n').includes(br + ' [待回覆]')), readN(f0115));
    ok('E8 標題中間的方括號、其他行都沒變', readN(f0115).replace(br + ' [待回覆]', br) === orig0115, readN(f0115));

    // E12：過去的卡片 + 更新 → 今天另記一筆、用 ^1 串起來
    const yq = '雅琦問題：發票作廢後又產生一次作廢的XML';
    await win.click('#dayList button[data-date="2026-01-22"]');
    await waitFor(async () => (await titles()).includes(yq));
    await addUpdate(cardOf('2026-01-22', yq), '台應說是排程重送');
    ok('E12 原本那筆加上 ^1', await waitFor(() => readN(f0122).split('\n').includes(yq + ' ^1 [待回覆]')), readN(f0122));
    ok('E12 今天另記一筆同編號、狀態沿用', await waitFor(() => readN(todayFile).endsWith(yq + ' ^1 [待回覆]\n\t->台應說是排程重送\n')), readN(todayFile));
    ok('E12 未結只列這件事最新的一筆（今天的）', await waitFor(async () => {
      const t = (await openTexts()).filter(x => x.includes('雅琦問題'));
      return t.length === 1 && t[0].includes(today.slice(5));
    }), JSON.stringify(await openTexts()));

    // E15：事件時間軸
    await cardOf('2026-01-22', yq).locator('button.chip.event').click();
    ok('E15 點 ^1 看到這件事每一天的紀錄', await waitFor(async () => same(await resultSrcs(), ['2026-01-22', today])), JSON.stringify(await resultSrcs()));
    ok('E15 標題寫幾筆', (await headTitle()).includes('事件 ^1：2 筆'), await headTitle());

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

    // E11：未結
    ok('E11 [完成] 的不列', !(await openTexts()).some(t => t.includes('WBW6121')), JSON.stringify(await openTexts()));
    await win.click('#openList li:has-text("CWMM3030 備料維護")');
    ok('E11 點未結那一筆，跳到那天', await waitFor(async () => (await headTitle()).startsWith('2026-09-11')), await headTitle());

    // E14：待辦區卡片
    const todoBefore = readN(todoFile);
    await win.fill('#todoTitle', '問小童備料排序');
    await win.press('#todoTitle', 'Enter');
    await win.fill('#todoBody', '要不要加明細 grid 排序');
    await win.press('#todoBody', 'Control+Enter');
    ok('E14 新增待辦：寫進 待辦.md', await waitFor(() => readN(todoFile) === todoBefore + '問小童備料排序\n\t要不要加明細 grid 排序\n'), JSON.stringify(readN(todoFile)));
    const mail = '-MAIL 趙縈問題 APP閃退->請單位交資料';
    await addUpdate(cardOf('todo', '趙縈問題'), '單位交了手機資訊');
    ok('E14 待辦 + 更新：待辦那筆加 ^2', await waitFor(() => readN(todoFile).split('\n').includes(mail + ' ^2')), readN(todoFile));
    ok('E14 今天另記一筆 ^2', await waitFor(() => readN(todayFile).endsWith(mail + ' ^2\n\t->單位交了手機資訊\n')), readN(todayFile));
    ok('E14 待辦卡片顯示最近進展', await waitFor(async () => ((await cardOf('todo', '趙縈問題').locator('.latest').textContent().catch(() => '')) || '').includes('單位交了手機資訊')));
    await cardOf('todo', '問小童備料排序').locator('button.del').click();
    ok('E14 刪除待辦', await waitFor(() => !readN(todoFile).includes('問小童備料排序')), readN(todoFile));

    // E16、E10：文字模式
    await win.click(`#dayList button[data-date="${today}"]`);
    await win.click('#modeBtn');
    ok('E16 切到文字模式：編輯區是今天的原文', await editorIs(readN(todayFile)));
    const typed = readN(todayFile) + '文字模式打的\n';
    await win.fill('#editor', typed);
    ok('E16 文字模式自動存檔', await waitFor(() => readN(todayFile) === typed), JSON.stringify(readN(todayFile)));
    const todoTyped = readN(todoFile) + '文字模式的待辦\n';
    await win.fill('#todo', todoTyped);
    ok('E10 待辦區文字模式自動存檔', await waitFor(() => readN(todoFile) === todoTyped), JSON.stringify(readN(todoFile)));
    await win.click('#modeBtn');
    ok('E16 切回卡片模式：剛打的字變成一張卡片', await waitFor(async () => (await titles()).includes('文字模式打的')), JSON.stringify(await titles()));
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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'daybook-dev-profile'), { recursive: true, force: true });
  }
  process.exitCode = code;
})();
