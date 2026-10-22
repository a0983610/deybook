/* ============================================================
   解析層＋匯入層測試（案例表見 e2e測試.md〈解析層〉〈匯入層〉）
   跑法：node tests/parser.test.cjs [--report <檔>]
     --report：R1 把真檔裡「連續好幾行標題」的分組結果寫到那個檔，人工核對 開發筆記 D009 用
   全部通過 exit 0，有失敗 exit 1，測試自己壞掉 exit 2。
   純 node，不開視窗；寫檔只寫系統暫存區，跑完刪掉。
   ============================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const { headMeta, isBareHead, parseDay, lineKind } = require(path.join(ROOT, 'src/shared/parser.js'));
const imp = require(path.join(ROOT, 'scripts/import-txt.js'));
const SAMPLE = path.join(__dirname, 'fixtures', 'sample.txt');
const REAL = 'C:\\Users\\cm8\\Downloads\\每日工作紀錄2026.txt';   // 使用者的舊檔，只讀；不在就跳過 R1

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('✗ ' + name + (detail ? '\n    ' + detail : ''));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, got, want) => ok(name, same(got, want), '得到 ' + JSON.stringify(got) + '，應為 ' + JSON.stringify(want));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tmps = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-test-')); tmps.push(d); return d; };
const throws = fn => { try { fn(); return false; } catch { return true; } };

function run() {
  /* ---------- 解析層 ---------- */
  {
    const es = parseDay('CWIN301000 撥入單 BUG\n\tQ1.備料單產生的單據\n    Q2.查詢\\來源單別');
    check('P1 筆數', es.length, 1);
    check('P1 Tab 與空白縮排都算內容', es[0].body.length, 2);
  }
  {
    const es = parseDay('CWIN301020 銷貨單\nCWIN301021 銷退單\nCWIN301022 銷折單\n\t若登入者所屬群組…\n\t則隱藏…');
    check('P2 三行光頭共用一段內容：筆數', es.length, 1);
    check('P2 代號三個', es[0].codes, ['CWIN301020', 'CWIN301021', 'CWIN301022']);
    check('P2 內容兩行', es[0].body.length, 2);
  }
  {
    const es = parseDay('eWCH3050 其他費用申請 BUG\nCWIN301021 銷退單 BUG\n\t參數未勾開立作廢發送通知…');
    check('P3 有類型字的各自一筆：筆數', es.length, 2);
    check('P3 內容只歸第二筆', es.map(e => e.body.length), [0, 1]);
    check('P3 第二筆代號', es[1].codes, ['CWIN301021']);
  }
  {
    const es = parseDay('WBW6121 進項發票建立作業 進貨單彙總頁面，當進貨單是現金進貨…灰階。\n更新26.02.SP2的WebPosBridge\nTX_CancelEInvMailNotice TX_CancelSalesR_AMailNotice\n\t給中繼的參數調整 測試應該正常');
    check('P4 三行各自一筆', es.length, 3);
    check('P4 內容只歸最後一筆', es.map(e => e.body.length), [0, 0, 1]);
  }
  {
    const es = parseDay('CWIN301011 進退單\n1.主檔新增[轉出註記]\n2.明細新增顯示[機號狀態]\n心蘭問題\n\t報表 預覽 列印PDF 會跳回登入頁');
    check('P5 沒縮排的「數字＋.」算內容：筆數', es.length, 2);
    check('P5 內容行數', es.map(e => e.body.length), [2, 1]);
  }
  {
    const m = headMeta('看CWIN301010 進貨單 侑萱BUG');
    check('P6 代號不在開頭也抓得到', m.codes, ['CWIN301010']);
    check('P6 BUG 是類型不是代號', m.types, ['BUG']);
  }
  check('P7 人名：秀屏問題', headMeta('秀屏問題').people, ['秀屏']);
  check('P7 人名：看雅琦問題', headMeta('看雅琦問題').people, ['雅琦']);
  check('P7 人名：雅琦 問題：…', headMeta('雅琦 問題：發票號碼XA34259000已於1/21作廢').people, ['雅琦']);
  check('P7 「稅額修改問題」不是人名', headMeta('秀屏 關於進貨單 (Cwin301010)的稅額修改問題').people, []);
  for (const s of ['待處理', '待回覆', '完成']) {
    const m = headMeta('雅琦問題：發票作廢又產生一次 [' + s + ']');
    check('P8 行尾狀態 ' + s, m.status, s);
    ok('P8 標題不含狀態 ' + s, !m.title.includes('[' + s + ']'), m.title);
  }
  {
    const m = headMeta('CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期');
    check('P9 標題中間的方括號不是狀態', m.status, null);
    check('P9 方括號裡的欄位不是代號', m.codes, ['CWIN301021']);
    check('P9 行尾不是那三個詞', headMeta('秀屏問題 配方點選 [替代料]').status, null);
    check('P9 狀態詞不在行尾', headMeta('雅琦問題 [待回覆] 後面還有字').status, null);
    check('P9 內容行的方括號', parseDay('WBW6123 銷項發票開立作業(CERP)\n\t[MVAT020]營業人代號 [完成]')[0].status, null);
  }
  {
    const m = headMeta('看馨儀問題 賀眾Wc3620251231005');
    check('P10 工單號', m.tickets, ['Wc3620251231005']);
    check('P10 工單號不算代號', m.codes, []);
    check('P10 帶 -N 的工單號', headMeta('CWIN301055 借出單 疑似Wca120251113002-01相關改壞的').tickets, ['Wca120251113002-01']);
  }
  check('P11 -> 開頭的內容', parseDay('CWIN301020 銷貨單 BUG\n\t異動送貨地址\n\t->修正')[0].results, ['->修正']);
  check('P12 主題', headMeta('WBW6123 銷項發票開立作業(CERP) #多統編發票').topics, ['多統編發票']);

  /* P13：代號規則照舊檔量到的例子（見 開發筆記 D017） */
  const codeCases = [
    ['EMERP EMERP登錄、主框架、Menu(17.40)', ['EMERP']],
    ['Selector CERP開窗元件', ['Selector']],
    ['WPPLogin CPAAPP_登入', ['WPPLogin']],
    ['TX_CancelEInvMailNotice TX_CancelSalesR_AMailNotice', ['TX_CancelEInvMailNotice', 'TX_CancelSalesR_AMailNotice']],
    ['WBW6123 銷項發票開立作業(CERP) WBW6120 銷項發票開立作業', ['WBW6123', 'WBW6120']],
    ['修正cwin3010系列強制結案api錯誤', ['cwin3010']],
    ['查新人CWIN9210問題', ['CWIN9210']],
    ['mail問題', []],
    ['update WebPosBridge', []],
    ['雅琦 問題：發票號碼XA34259000已於1/21作廢', []],
    ['-查 0402918日晟成本不正確的原因 ->先問單位Pfi5202501240001品管測不出來', []],
    ['0512645台灣納普司_CERP銷貨單  點進去要20秒才出現畫面', []],
    ['Q1研發設計師職能測驗', []],
  ];
  for (const [h, want] of codeCases) check('P13 代號：' + h, headMeta(h).codes, want);

  /* P14：光頭的判定（見 開發筆記 D009） */
  const bareCases = [
    ['CWIN301020 銷貨單', true],
    ['CWBS3080 Packing List', true],
    ['WBW6123 銷項發票開立作業(CERP)', true],
    ['TX_CancelEInvMailNotice TX_CancelSalesR_AMailNotice', true],
    ['eWCH3050 其他費用申請 BUG', false],
    ['TX_CancelEInvMailNotice 郵件通知發票作廢函式 新程式撰寫', false],
    ['EMERP EMERP登錄、主框架、Menu(17.40)', false],
    ['API_eLoginToken 記錄Token資訊 檢核APIKEYID為必填參數', false],
    ['看CWIN301010 進貨單', false],
    ['更新26.02.SP2的WebPosBridge', false],
    ['EMERP雅琦問題 作業逾時', false],
  ];
  for (const [h, want] of bareCases) check('P14 光頭：' + h, isBareHead(headMeta(h)), want);
  {
    // 舊檔 L665～L667（4/1）：內容在查作業逾時的 log，只屬於雅琦問題那一行
    const es = parseDay('EMERP 更新winton.core 改2520版\nEMERP雅琦問題 作業逾時\n\t看LOG是ewch3050 Resource在MerpApiService.GetNeedToVerify出錯');
    check('P14 有人名的標題不跟上面共用內容', es.map(e => e.body.length), [0, 1]);
  }

  /* ---------- 匯入層 ---------- */
  const sampleText = fs.readFileSync(SAMPLE, 'utf8');
  {
    const days = imp.splitDays(sampleText);
    check('I1 年份：---2026--- 之前算 2025', days.map(d => d.date), ['2025-12-29', '2025-12-31', '2026-01-15', '2026-01-22', '2026-08-04', '2026-09-11']);
    ok('I2 每日檔裡沒有 --- 分隔', days.every(d => d.lines.every(l => !/^---/.test(l))));
    ok('I2 每日檔頭尾沒有空行', days.every(d => d.lines[0].trim() !== '' && d.lines[d.lines.length - 1].trim() !== ''));
    check('I4 CRLF 跟 LF 結果一樣', imp.splitDays(sampleText.replace(/\n/g, '\r\n')).map(d => d.lines), days.map(d => d.lines));
  }
  {
    const before = sha(SAMPLE);
    const out = tmpDir();
    const log = console.log; console.log = () => {};
    const code = imp.main(['node', 'import-txt.js', SAMPLE, '--out', out]);
    console.log = log;
    check('I3 CLI 匯入成功', code, 0);
    check('I3 原檔位元組不變', sha(SAMPLE), before);
    const f = path.join(out, 'journal', '2026', '01', '2026-01-22.md');
    ok('I3 每日檔寫到 journal/YYYY/MM/', fs.existsSync(f), f);
    if (fs.existsSync(f)) ok('I3 每日檔用 \\n 換行、結尾有換行', !fs.readFileSync(f, 'utf8').includes('\r') && fs.readFileSync(f, 'utf8').endsWith('\n'));
  }
  ok('I5 日期倒退又沒有年份標記 → 報錯', throws(() => imp.splitDays('12/30\nA\n1/2\nB', { year: 2025 })));
  ok('I5 沒有年份標記也沒給 --year → 報錯', throws(() => imp.splitDays('1/2\nA')));
  ok('I5 同一天出現兩次 → 報錯', throws(() => imp.splitDays('1/2\nA\n1/2\nB', { year: 2026 })));
  ok('I5 不存在的日期 → 報錯', throws(() => imp.splitDays('2/30\nA', { year: 2026 })));
  {
    const out = tmpDir();
    const days = imp.splitDays(sampleText);
    imp.writeDays(days, out);
    const f = path.join(out, imp.dayPath(days[0].date));
    fs.writeFileSync(f, '使用者改過的內容\n');
    ok('I6 目標檔已存在 → 整批不寫', throws(() => imp.writeDays(days, out)));
    check('I6 已存在的檔沒被蓋掉', fs.readFileSync(f, 'utf8'), '使用者改過的內容\n');
    const err = console.error; console.error = () => {};
    const code = imp.main(['node', 'import-txt.js', SAMPLE]);
    console.error = err;
    check('I6 沒給 --out → 不寫、exit 2', code, 2);
  }
  {
    // 舊檔尾巴的常駐待辦區（見 開發筆記 D019）
    const t = '12/30\nCWIN301020 銷貨單\n\n週報\n\n\n-MAIL 趙縈問題 閃退->請單位交資料\n暉閎:改放大鏡核准按鈕\n\n';
    const { rest, todo } = imp.splitTodo(t, '週報');
    check('I7 待辦區從「週報」那行起原樣搬走', todo, ['週報', '', '', '-MAIL 趙縈問題 閃退->請單位交資料', '暉閎:改放大鏡核准按鈕']);
    check('I7 最後一天不含待辦區', imp.splitDays(rest, { year: 2025 }).map(d => d.lines), [['CWIN301020 銷貨單']]);
    ok('I7 找不到標示行 → 報錯', throws(() => imp.splitTodo(t, '月報')));
    ok('I7 標示行後面還有日期 → 報錯', throws(() => imp.splitTodo('週報\nA\n1/2\nB', '週報')));
    const src = path.join(tmpDir(), 'old.txt');
    fs.writeFileSync(src, '---2026---\n' + t.replace('12/30', '1/2'));
    const out = tmpDir();
    const log = console.log; console.log = () => {};
    const code = imp.main(['node', 'import-txt.js', src, '--out', out, '--todo-from', '週報']);
    console.log = log;
    check('I7 CLI --todo-from 成功', code, 0);
    const todoFile = path.join(out, imp.TODO_FILE);
    check('I7 待辦.md 內容', fs.existsSync(todoFile) && fs.readFileSync(todoFile, 'utf8'), todo.join('\n') + '\n');
    const dayFile = path.join(out, imp.dayPath('2026-01-02'));
    check('I7 那一天的檔不含待辦區', fs.existsSync(dayFile) && fs.readFileSync(dayFile, 'utf8'), 'CWIN301020 銷貨單\n');
  }

  /* ---------- R1：匯入真的舊檔（只讀）到暫存區 ---------- */
  if (!fs.existsSync(REAL)) { console.log('R1 跳過：找不到 ' + REAL); return; }
  const before = sha(REAL);
  const text = fs.readFileSync(REAL, 'utf8');
  const srcLines = text.split(/\r?\n/);
  // 檔尾有「週報」那行就照真的匯入方式切出待辦區（見 開發筆記 D019）
  const hasTodo = srcLines.some(l => l.trim() === '週報');
  const { rest, todo } = hasTodo ? imp.splitTodo(text, '週報') : { rest: text, todo: [] };
  const days = imp.splitDays(rest);
  if (hasTodo) console.log(`R1 待辦區 ${todo.length} 行（從「週報」那行起）`);
  const dateLines = srcLines.filter(l => /^\d{1,2}\/\d{1,2}\s*$/.test(l)).length;
  check('R1 每日檔數＝原檔日期行數', days.length, dateLines);
  const out = tmpDir();
  const files = imp.writeDays(days, out);
  const keep = l => l.trim() !== '' && !/^\d{1,2}\/\d{1,2}\s*$/.test(l) && !/^-{3,}(\s*\d{4}\s*-{3,})?\s*$/.test(l);
  const want = srcLines.filter(keep);
  const got = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\n')).concat(todo).filter(keep);
  const firstDiff = want.findIndex((l, i) => l !== got[i]);
  ok('R1 原檔每一行有字的內容都在、順序不變', want.length === got.length && firstDiff < 0,
    `原檔 ${want.length} 行、輸出 ${got.length} 行` + (firstDiff >= 0 ? `，第 ${firstDiff + 1} 行起不同：${want[firstDiff]}` : ''));
  check('R1 原檔位元組不變', sha(REAL), before);

  /* 連續好幾行標題、後面接內容的分組（見 開發筆記 D009） */
  const report = [];
  let shared = 0, lastOnly = 0;
  for (const d of days) {
    const entries = parseDay(d.lines.join('\n'));
    const kinds = d.lines.map(lineKind);
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] !== 'head') continue;
      let j = i;
      while (j + 1 < kinds.length && kinds[j + 1] === 'head') j++;
      if (j > i && kinds[j + 1] === 'body') {
        const owner = entries.find(e => e.heads.some(h => h.line === j));
        const n = owner.heads.length;
        if (n > 1) shared++; else lastOnly++;
        report.push(`L${d.lineNos[i]}  ${d.date}  ${j - i + 1} 行，${n > 1 ? '後 ' + n + ' 行共用內容' : '只有最後一行拿內容'}`);
        for (let k = i; k <= j; k++) report.push(`    ${k > j - n ? '拿' : '　'}  ${d.lines[k].trim()}`);
      }
      i = j;
    }
  }
  console.log(`R1 連續標題 ${shared + lastOnly} 組：共用內容 ${shared} 組、只有最後一行拿內容 ${lastOnly} 組`);
  const ri = process.argv.indexOf('--report');
  if (ri >= 0) {
    fs.writeFileSync(process.argv[ri + 1], `連續標題分組（${new Date().toISOString().slice(0, 10)}，${shared + lastOnly} 組）\n「拿」＝拿到底下那段內容（好幾行都標「拿」就是共用）\n\n` + report.join('\n') + '\n');
    console.log('R1 分組明細寫到 ' + process.argv[ri + 1]);
  }
}

let code = 0;
try {
  run();
  console.log(`\n${pass} 條通過、${fail} 條失敗`);
  code = fail ? 1 : 0;
} catch (e) {
  console.error('測試自己壞掉：' + (e.stack || e));
  code = 2;
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
process.exitCode = code;
