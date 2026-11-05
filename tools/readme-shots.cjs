/* ============================================================
   README 的截圖：用編的示範資料開 daybook，照順序點到每個畫面拍下來，存成 docs/images/*.png（見 開發筆記 D165）。
   跑法：node tools/readme-shots.cjs              介面改了就跑一次，全部重拍（只拍淺色）
         node tools/readme-shots.cjs --out <資料夾>  拍到別的地方（試拍、比對用）
   不碰使用者的紀錄資料夾、設定檔：示範資料和設定檔（--user-data）都放系統暫存區，跑完刪掉；
   視窗開在螢幕外、不搶焦點（--quiet-window）。用 --user-data 不用 --data-dir：釘的資料夾、常用、截圖資料夾
   預先寫進設定檔就好，不用一個一個點選檔視窗。
   開 Electron、連進去的做法照 tests/e2e.cjs（Playwright 的 _electron.launch 對 Electron 45 會卡住，見 開發筆記 D011）。
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'docs', 'images');
const VIEW = { width: 1200, height: 820 };   // 拍的畫面大小（CSS px）：GitHub 縮到 README 的寬度時字還看得清楚

/* 找 playwright：跟 tests/e2e.cjs 一樣找全域 @playwright/mcp、@playwright/cli 附的（見 開發筆記 D011） */
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(100);
  }
}

/* ---------- 示範資料：全部是編的，日期照跑的那天往回算 ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const md = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
/* 今天、往回的工作天（跳過六日）：wd[0] 是今天 */
function workdays(n) {
  const r = [], d = new Date();
  d.setHours(12, 0, 0, 0);
  r.push(new Date(d));
  while (r.length < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) r.push(new Date(d));
  }
  return r;
}

function seed(tmp) {
  const wd = workdays(16);
  const data = path.join(tmp, 'data');
  const ticket = 'Wa12' + ymd(wd[3]).replace(/-/g, '') + '002';
  const write = (rel, lines) => {
    const f = path.join(data, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, (Array.isArray(lines) ? lines.join('\n') : lines) + '\n');
  };
  const day = (i, lines) => {
    const d = ymd(wd[i]);
    write(`journal/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}.md`, lines);
  };
  day(0, [
    'ORD1020 訂單維護 BUG ^12',
    '\t複製訂單時，交貨日期沒有跟著帶過來',
    '\t->複製時漏帶明細的交貨日期，補上後請美玲再測一次',
    `INV3050 發票開立 規格調整 ${ticket}`,
    '\t開立前檢查統編，格式不對直接擋下來',
    '\t->加上統編檢查碼驗證，錯誤訊息照規格寫',
    '美玲問題：月結報表的金額跟明細對不起來 [標記:等客戶]',
    '\t->明細多算了一筆作廢單，等客戶確認作廢的要不要列',
    '週會',
    '\t下週上線的 3 支程式排測試時間',
  ]);
  day(1, [
    'ORD1020 訂單維護 BUG ^12',
    '\t複製訂單時，交貨日期沒有跟著帶過來',
    '\t->找到是複製明細那段沒帶，明天改',
    'PUR2010 採購單 新程式',
    '\t請購單轉採購單，數量可以分好幾次轉',
    '\t->轉單畫面做好了，剩分批的數量檢查',
    'TX_SendInvoiceMail',
    '\t寄發票通知信時附上 PDF',
    '\t->超過 10MB 改成給下載連結',
  ]);
  day(2, [
    `INV3050 發票開立 規格調整 ${ticket}`,
    '\t跟志明確認統編不對時要擋還是只提醒',
    '\t->要擋',
    'PUR2010 採購單 新程式',
    '\t開規格會議，畫面照請購單的排法',
    '志明問題：匯出 Excel 欄寬跑掉',
    '\t->欄寬原本寫死，改成照內容調',
  ]);
  day(3, [
    'ORD1020 訂單維護 規格調整',
    '\t訂單明細加「預計交貨日」欄位',
    '\t->欄位加好，訂單報表一起改',
    'RPT5010 月結報表 BUG',
    '\t跨月的折讓沒有算進去',
    '\t->條件改成照折讓日期',
  ]);
  day(5, [
    'ORD1020 訂單維護 BUG',
    '\t訂單數量改成 0 也存得進去',
    '\t->存檔前檢查數量要大於 0',
    'INV3050 發票開立 新程式',
    '\t發票開立作業第一版上線',
  ]);
  day(6, [
    'RPT5010 月結報表 新程式',
    '\t月結報表第一版：照客戶、照月份',
    '\t->交給志明測',
  ]);
  day(8, [
    'ORD1020 訂單維護 新程式',
    '\t訂單維護第一版：新增、修改、刪除、複製',
    '\t->交給美玲測試',
    'PUR2010 採購單 新程式',
    '\t先看舊系統的採購單怎麼做',
  ]);
  day(10, ['INV3050 發票開立 新程式', '\t開立、作廢、折讓三個畫面的規格討論']);
  day(12, ['週會', '\t這個月要上線的程式：訂單、發票、月結報表']);
  day(15, ['ORD1020 訂單維護 新程式', '\t跟業務確認訂單要有哪些欄位', '\t->欄位清單寄給美玲確認']);
  write('待辦.md', [
    'INV3050 發票開立 規格調整',
    '\t作廢重開時要保留原本的發票號碼',
    `\t->${md(wd[1])} 跟志明確認備註要放哪個欄位`,
    '秀英問題：APP 登入後閃退 [待回覆]',
    `\t->${md(wd[0])} 請她給手機型號和版本`,
    '上線前檢查',
    '\t參數、權限、選單都要開',
    '季報 [隱藏]',
  ]);
  write('剪貼簿.md', [
    '簽名',
    '\t[{yyyy.MM.dd HH:mm} 小明]',
    '查今天的訂單',
    '\tSELECT * FROM Orders',
    "\tWHERE OrderDate >= '{yyyy-MM-dd}'",
    '回覆客戶',
    '\t您好，您反映的問題處理結果如下：',
    '\t如有其他問題，歡迎再與我們聯絡。',
    '週報開頭',
    '\t{M}/{d} 這週完成：',
  ]);
  write('記事本/週會.txt', [
    `${md(wd[0])} 週會`,
    '',
    '1. 下週上線',
    '\tORD1020 訂單維護：複製訂單修正',
    '\tINV3050 發票開立：統編檢查',
    '\tPUR2010 採購單：第一版',
    '2. 測試排程',
    '\t週一、週二 美玲測訂單',
    '\t週三 志明測發票',
    '3. 上線前檢查',
    '\t參數、權限、選單',
    '\t上線公告寄給全公司',
    '4. 其他',
    '\t月結報表的作廢單等客戶回覆',
  ]);
  write('記事本/點子.txt', ['訂單複製時讓使用者選要帶哪些欄位']);
  write('記事本/工作/上線檢查.txt', ['參數', '權限', '選單', '上線公告']);
  write('記事本/工作/2026/規劃.txt', ['Q4：發票、採購']);
  write('記事本/會議紀錄/客戶拜訪.txt', ['帶訂單、發票的操作說明']);

  /* 文件檢視釘的資料夾：AI 產出的報告 */
  const docs = path.join(tmp, 'AI 報告');
  const doc = (rel, text) => {
    const f = path.join(docs, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  doc('訂單複製修正報告.md', [
    '# 訂單複製後交貨日期沒帶過來',
    '',
    `> 工單 ${ticket}　程式 ORD1020 訂單維護`,
    '',
    '## 問題',
    '',
    '複製訂單時，新訂單明細的「交貨日期」是空的，使用者要一筆一筆補。',
    '',
    '## 原因',
    '',
    '複製只帶了表頭的欄位，交貨日期在明細那層，沒有跟著帶。',
    '',
    '```js',
    '// 複製明細時把交貨日期一起帶過去',
    'copy.lines = src.lines.map(l => ({ ...l, deliveryDate: l.deliveryDate }));',
    '```',
    '',
    '## 修改',
    '',
    '| 檔案 | 改了什麼 |',
    '|---|---|',
    '| `OrderCopy.js` | 明細一起帶交貨日期 |',
    '| `OrderCopy.test.js` | 加一個案例：有三筆明細的訂單 |',
    '',
    '## 測試',
    '',
    '- [x] 複製一般訂單',
    '- [x] 複製有多筆明細的訂單',
    '- [ ] 複製已作廢的訂單',
    '',
    '## 後續',
    '',
    '請美玲在測試機再測一次，沒問題就排下週上線。',
    '',
  ].join('\n'));
  doc('發票統編檢查規格.md', '# 發票統編檢查規格\n\n## 檢查碼\n\n照財政部的規則算。\n');
  doc('月結報表/作廢單分析.md', '# 月結報表的作廢單\n\n## 現況\n\n明細有列作廢單。\n');
  doc('月結報表/效能分析.html', '<!doctype html><meta charset="utf-8"><title>效能分析</title><h1>月結報表效能分析</h1><p>查詢 1.2 秒。</p>\n');

  /* 截圖資料夾：縮圖之後拿拍好的畫面放進去（shots()） */
  const shotDir = path.join(tmp, 'shots');
  fs.mkdirSync(path.join(shotDir, '保留'), { recursive: true });

  /* 設定檔：資料夾、釘的資料夾、常用、截圖資料夾（鍵名照 src/main/main.js 的 readSettings 用法） */
  const user = path.join(tmp, 'user');
  fs.mkdirSync(user);
  const launch = [
    { name: '記事本', target: 'C:\\Windows\\System32\\notepad.exe' },
    { name: '小算盤', target: 'C:\\Windows\\System32\\calc.exe' },
    { name: '公用文件', target: 'C:\\Users\\Public\\Documents' },
    { name: 'daybook GitHub', target: 'https://github.com/a0983610/deybook' },
    { name: '工單系統', target: 'https://example.com/tickets' },
  ];
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ dataDir: data, mdRoots: [docs], launch, shotDir }, null, 2));
  return { user, shotDir, wd };
}

/* ---------- 開 daybook ---------- */
async function launch(pw, user) {
  const proc = spawn(require(path.join(ROOT, 'node_modules', 'electron')), [ROOT, '--user-data', user, '--quiet-window', '--remote-debugging-port=0'],
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

/* 畫面上會寫出暫存資料夾的路徑（帶使用者名稱），拍之前換成示範用的字 */
const maskPaths = page => page.evaluate(() => {
  const set = (sel, text) => { const el = document.querySelector(sel); if (el) { el.textContent = text; el.title = text; } };
  set('#dirPath', 'D:\\工作紀錄');
  set('#shotDir', 'D:\\截圖');
});

async function main() {
  const pw = loadPlaywright();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-shots-'));
  let app = null;
  try {
    const demo = seed(tmp);
    app = await launch(pw, demo.user);
    const { page } = app;
    await page.setViewportSize(VIEW);
    // 只拍淺色：記在這台電腦的那格（theme.js 讀的）設成 light，重新載入
    await waitFor(() => page.evaluate(() => !!document.querySelector('#cards')).catch(() => false), 10000);
    await page.evaluate(() => { localStorage.setItem('daybook.theme', 'light'); location.reload(); });
    await sleep(500);
    await waitFor(() => page.evaluate(() => document.querySelectorAll('#cards > *').length > 0).catch(() => false), 10000);
    await sleep(500);
    fs.mkdirSync(OUT, { recursive: true });
    const shots = [];   // 拍好的畫面，最後放進截圖頁當縮圖
    const snap = async name => {
      await maskPaths(page);
      await sleep(300);
      const png = await page.screenshot({ path: path.join(OUT, name + '.png'), scale: 'css' });
      shots.push(png);
      console.log('拍好 ' + name + '.png');
    };

    // 1. 日記本：今天
    await snap('overview');

    // 2. 時間軸：點卡片上的代號
    await page.locator('#cards .chip.code', { hasText: 'ORD1020' }).first().click();
    await sleep(600);
    await snap('timeline');
    await page.click('#backBtn');
    await sleep(400);

    // 3. 回顧＋匯出這段
    await page.click('#rangeBtn');
    await sleep(400);
    await page.click('#rangeExport');
    await page.evaluate(() => document.activeElement.blur());   // 匯出列一打開游標在起日那格，字會被選起來
    await sleep(400);
    await snap('review');
    await page.click('#expClose');
    await page.click('#backBtn');
    await sleep(400);

    // 4. 快捷鍵說明（F1）
    await page.keyboard.press('F1');
    await sleep(400);
    await snap('keys');
    await page.keyboard.press('Escape');
    await sleep(300);

    // 5. 格式（請 AI 寫）
    await page.click('#actSettings');
    await page.click('#fmtBtn');
    await sleep(600);
    await snap('format');
    await page.keyboard.press('Escape');
    await sleep(300);

    // 6. 常用
    await page.click('#actLaunch');
    await sleep(800);
    await snap('launch');

    // 7. 記事本：開兩份、Ctrl+F 找字
    await page.click('#actNote');
    await sleep(600);
    const noteTree = page.locator('#noteTree');
    await noteTree.getByText('工作', { exact: true }).click();   // 展開一個資料夾，看得出可以分層
    await sleep(300);
    await noteTree.getByText('點子', { exact: true }).dblclick();
    await sleep(300);
    await noteTree.getByText('週會', { exact: true }).dblclick();
    await sleep(500);
    await page.click('#noteText');
    await page.keyboard.press('Control+F');
    await page.keyboard.type('上線');
    await sleep(400);
    await snap('note');
    await page.keyboard.press('Escape');

    // 8. 剪貼簿（中間照樣是記事本）
    await page.click('#actSnip');
    await sleep(600);
    await snap('snip');

    // 9. 文件檢視：開兩份
    await page.click('#actMd');
    await sleep(800);
    const mdTree = page.locator('#mdTree');
    await mdTree.getByText('AI 報告', { exact: true }).click();   // 釘的資料夾一開始收著
    await sleep(400);
    await mdTree.getByText('月結報表', { exact: true }).click();
    await sleep(400);
    await mdTree.getByText('發票統編檢查規格', { exact: true }).dblclick();
    await sleep(500);
    await mdTree.getByText('訂單複製修正報告', { exact: true }).dblclick();
    await sleep(800);
    await snap('docview');

    // 10. 截圖：前面拍的畫面放進截圖資料夾，照修改時間分天
    const when = [0, 0, 0, 1, 1, 1, 2, 2];
    shots.slice(0, when.length).forEach((png, i) => {
      const f = path.join(demo.shotDir, `${631 + i}.png`);
      fs.writeFileSync(f, png);
      const t = new Date(demo.wd[when[i]]);
      t.setHours(9 + i, 10 * i % 60);
      fs.utimesSync(f, t, t);
    });
    fs.writeFileSync(path.join(demo.shotDir, '保留', '日記本.png'), shots[0]);
    await page.click('#actShot');
    await sleep(1500);
    await snap('shot');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exit(2); });
