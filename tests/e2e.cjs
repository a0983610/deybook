/* ============================================================
   e2e：開真的 Electron app 操作，再回頭讀磁碟驗（案例表見 e2e測試.md〈e2e 層〉）
   跑法：node tests/e2e.cjs
   Playwright 不另外裝，找全域 @playwright/mcp、@playwright/cli 附的（見 開發筆記 D011）。
   自己開 Electron（--remote-debugging-port=0），再用 chromium.connectOverCDP 連進去——
   Playwright 的 _electron.launch 對 Electron 45 會卡住（見 開發筆記 D011〈後續〉）。
   每輪把 tests/fixtures/data 複製到系統暫存區，用 --data-dir 指過去；跑完刪掉。
   全部通過 exit 0，有失敗 exit 1，測試自己壞掉 exit 2。
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { dayPath, TODO_FILE } = require(path.join(ROOT, 'src/shared/paths.js'));

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(50);
  }
}
const readOr = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
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
    await win.waitForSelector('#dayList button');
    // textarea 的值一律是 \n 換行；fixture 被 git 換成 CRLF 時也要比得起來
    const editorIs = want => waitFor(async () => (await win.inputValue('#editor')) === want.replace(/\r\n/g, '\n'));

    // E1
    const today = localToday();
    ok('E1 開起來停在今天', await waitFor(async () => (await win.textContent('#dayTitle')).includes(today)),
      '標題：' + (await win.textContent('#dayTitle')));

    // E2
    const typed = 'CWMM3030 備料調撥 BUG\n\t材料彙總，請將「備料散裝數量」欄位拿掉';
    const todayFile = path.join(data, dayPath(today));
    ok('E2 前提：今天原本沒有檔', !fs.existsSync(todayFile));
    await win.fill('#editor', typed);
    ok('E2 自動存檔：磁碟上今天的檔＝打的字', await waitFor(() => readOr(todayFile) === typed),
      '磁碟：' + JSON.stringify(readOr(todayFile)));

    // E4
    const f0122 = path.join(data, dayPath('2026-01-22'));
    const want0122 = fs.readFileSync(f0122, 'utf8');
    await win.click('#dayList button[data-date="2026-01-22"]');
    ok('E4 點日期清單的某一天，編輯區顯示那天內容', await editorIs(want0122),
      '編輯區：' + JSON.stringify(await win.inputValue('#editor')));

    // E3（接在 E4 後面：畫面上已經確定是舊內容）
    const changed = want0122 + '外部加的一行\n';
    fs.writeFileSync(f0122, changed);
    ok('E3 外部改檔，畫面不用重開就更新', await editorIs(changed),
      '編輯區：' + JSON.stringify(await win.inputValue('#editor')));

    // E10
    const todoTyped = '週報\n-MAIL 測試待辦->等回覆';
    await win.fill('#todo', todoTyped);
    ok('E10 待辦區自動存檔：磁碟上的 待辦.md＝打的字', await waitFor(() => readOr(path.join(data, TODO_FILE)) === todoTyped),
      '磁碟：' + JSON.stringify(readOr(path.join(data, TODO_FILE))));

    // E11
    const items = await win.$$eval('#openList li', els => els.map(e => e.textContent));
    ok('E11 未結列出 [待回覆]、[待處理]', items.some(t => t.includes('[待回覆]') && t.includes('雅琦問題'))
      && items.some(t => t.includes('[待處理]') && t.includes('CWMM3030')), JSON.stringify(items));
    ok('E11 [完成] 的不列', !items.some(t => t.includes('WBW6121')), JSON.stringify(items));
    await win.click('#dayList button[data-date="2026-01-15"]');
    await editorIs(fs.readFileSync(path.join(data, dayPath('2026-01-15')), 'utf8'));
    await win.click('#openList li:has-text("雅琦問題")');
    ok('E11 點未結那一筆，跳到那天', await editorIs(fs.readFileSync(f0122, 'utf8')),
      '標題：' + (await win.textContent('#dayTitle')));
  } finally {
    await app.close();
  }

  // E9
  const after = { profile: snapshot(realProfile), data: snapshot(realData) };
  ok('E9 沒動到 %APPDATA%\\daybook', JSON.stringify(after.profile) === JSON.stringify(before.profile),
    `前：${JSON.stringify(before.profile)}\n    後：${JSON.stringify(after.profile)}`);
  ok('E9 沒動到使用者的資料資料夾', JSON.stringify(after.data) === JSON.stringify(before.data), realData || '（沒設定過）');
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
