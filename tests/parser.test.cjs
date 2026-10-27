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
const { headMeta, isBareHead, leadCodeName, parseDay, lineKind, formatEntry } = require(path.join(ROOT, 'src/shared/parser.js'));
const ent = require(path.join(ROOT, 'src/shared/entries.js'));
const srch = require(path.join(ROOT, 'src/shared/search.js'));
const exp = require(path.join(ROOT, 'src/shared/formats/daybook-md.js'));
const fmts = require(path.join(ROOT, 'src/shared/formats/index.js'));
const imp = require(path.join(ROOT, 'scripts/import-txt.js'));
const impUI = require(path.join(ROOT, 'src/shared/import.js'));
/* 卡片上看得到的東西（見 開發筆記 D046）：匯出再匯回，這些要一模一樣 */
const cardsOf = text => parseDay(text).map(e => ({
  heads: e.heads.map(h => h.text), body: e.body.map(b => b.text.replace(/^(\t| {1,4})/, '')), status: e.status, hidden: e.hidden, event: e.event,
}));
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
const children = [];   // 擴充程序（K4、M2）：測試中途壞掉也要關掉，不然 node 結束不了
const throws = fn => { try { fn(); return false; } catch { return true; } };
const rejects = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };   // 丟錯回訊息，沒丟回 null

async function run() {
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

  /* ---------- 卡片編輯（見 開發筆記 D021、D022） ---------- */
  {
    const card = { title: 'CWMM3030 備料調撥 BUG', body: '材料彙總，請將欄位拿掉\n\n->先不改', status: '待處理', event: 12 };
    check('C1 卡片 → 行', formatEntry(card), ['CWMM3030 備料調撥 BUG ^12 [待處理]', '\t材料彙總，請將欄位拿掉', '\t->先不改']);
    const e = parseDay(formatEntry(card).join('\n'))[0];
    check('C2 寫出去再讀回來一樣', [e.title, e.status, e.event, e.body.length, e.results], ['CWMM3030 備料調撥 BUG', '待處理', 12, 2, ['->先不改']]);
    const m = headMeta('CWMM3030 備料調撥 BUG ^12 [待處理]');
    check('C3 ^編號不算在標題、不算代號', [m.title, m.event, m.status, m.codes], ['CWMM3030 備料調撥 BUG', 12, '待處理', ['CWMM3030']]);
    check('C3 沒有編號', headMeta('CWMM3030 備料調撥').event, null);
    ok('C4 標題空白 → 報錯', throws(() => formatEntry({ title: '  ', body: 'x' })));
    ok('C4 標題「數字＋.」開頭 → 報錯', throws(() => formatEntry({ title: '1.主檔新增' })));
    ok('C4 不認得的狀態 → 報錯', throws(() => formatEntry({ title: 'A', status: '進行中' })));
  }
  {
    const card = { title: 'CWIN5890 寄庫批次開帳作業', body: '如果提供 Excel 轉入' };
    check('C5 加在最後面、收掉結尾空行', ent.addEntry('A\n\tb\n\n\n', card), 'A\n\tb\nCWIN5890 寄庫批次開帳作業\n\t如果提供 Excel 轉入\n');
    check('C5 空的一天', ent.addEntry('', card), 'CWIN5890 寄庫批次開帳作業\n\t如果提供 Excel 轉入\n');
  }
  {
    const day = 'CWIN301020 銷貨單\nCWIN301021 銷退單\n\t共用的說明\n\n雅琦問題：發票作廢\n\t->問台應\nCWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期\n';
    const list = ent.listEntries(day);
    check('C11 每一筆的原文', list.map(x => x.raw), ['CWIN301020 銷貨單\nCWIN301021 銷退單\n\t共用的說明', '雅琦問題：發票作廢\n\t->問台應', 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期']);
    check('C11 內容去掉一層縮排', list[1].body, ['->問台應']);

    const edited = ent.editEntry(day, 1, list[1].raw, { title: '雅琦問題：發票作廢又產生 XML', body: '->問台應\n->台應說是排程', status: '待回覆' });
    check('C6 改一筆：只換那幾行', edited, 'CWIN301020 銷貨單\nCWIN301021 銷退單\n\t共用的說明\n\n雅琦問題：發票作廢又產生 XML [待回覆]\n\t->問台應\n\t->台應說是排程\nCWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期\n');
    ok('C6 原文對不上 → Conflict', (() => { try { ent.editEntry(day, 1, '別的內容', { title: 'x' }); } catch (e) { return e instanceof ent.Conflict; } return false; })());
    check('C7 刪一筆', ent.deleteEntry(day, 1, list[1].raw), 'CWIN301020 銷貨單\nCWIN301021 銷退單\n\t共用的說明\n\nCWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期\n');

    const s1 = ent.setStatus(day, 2, list[2].raw, '待回覆');
    check('C8 加狀態：標題中間的方括號不動', s1.split('\n')[6], 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期 [待回覆]');
    check('C8 其他行一個字都沒變', s1.split('\n').filter((_, i) => i !== 6), day.split('\n').filter((_, i) => i !== 6));
    const s2 = ent.setStatus(s1, 2, ent.listEntries(s1)[2].raw, '完成');
    check('C8 換狀態', s2.split('\n')[6], 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期 [完成]');
    check('C8 拿掉狀態', ent.setStatus(s2, 2, ent.listEntries(s2)[2].raw, null), day);
    check('C12 好幾行標題共用內容：狀態加在最後一行標題', ent.setStatus(day, 0, list[0].raw, '待處理').split('\n').slice(0, 2), ['CWIN301020 銷貨單', 'CWIN301021 銷退單 [待處理]']);

    const v = ent.setStatus(day, 1, list[1].raw, '待回覆');
    const ev = ent.setEvent(v, 1, ent.listEntries(v)[1].raw, 5);
    check('C9 事件編號插在狀態前面', ev.split('\n')[4], '雅琦問題：發票作廢 ^5 [待回覆]');
    ok('C9 已經有編號 → 報錯', throws(() => ent.setEvent(ev, 1, ent.listEntries(ev)[1].raw, 6)));

    const tk = ent.takeEntry(v, 1, ent.listEntries(v)[1].raw);
    check('C13 整筆拿出來：狀態拿掉、其他行照舊', tk.taken, ['雅琦問題：發票作廢', '\t->問台應']);
    check('C13 拿掉之後剩下的', tk.rest, day.replace('雅琦問題：發票作廢\n\t->問台應\n', ''));
    ok('C13 原文對不上 → Conflict', (() => { try { ent.takeEntry(v, 1, 'x'); } catch (e) { return e instanceof ent.Conflict; } return false; })());
    check('C14 幾行接在最後面', ent.appendLines('A\n\n', tk.taken), 'A\n雅琦問題：發票作廢\n\t->問台應\n');

    // 隱藏（見 開發筆記 D026）：行尾 [隱藏] 跟狀態可以都有、順序不拘，寫回去一律「[隱藏] [狀態]」
    const hm = headMeta('週報 ^3 [待回覆] [隱藏]');
    check('C15 行尾兩個標記、順序不拘', [hm.title, hm.status, hm.hidden, hm.event], ['週報', '待回覆', true, 3]);
    check('C15 只有隱藏', [headMeta('週報 [隱藏]').title, headMeta('週報 [隱藏]').status, headMeta('週報 [隱藏]').hidden], ['週報', null, true]);
    check('C15 沒有隱藏', headMeta('週報').hidden, false);
    check('C15 卡片 → 行：[隱藏] 在狀態前面', formatEntry({ title: '週報', hidden: true, status: '待回覆', event: 3 }), ['週報 ^3 [隱藏] [待回覆]']);
    const h1 = ent.setHidden(v, 1, ent.listEntries(v)[1].raw, true);
    check('C16 隱藏：只加 [隱藏]、狀態照舊', h1.split('\n')[4], '雅琦問題：發票作廢 [隱藏] [待回覆]');
    check('C16 其他行一個字都沒變', h1.split('\n').filter((_, i) => i !== 4), v.split('\n').filter((_, i) => i !== 4));
    const h2 = ent.setStatus(h1, 1, ent.listEntries(h1)[1].raw, null);
    check('C16 隱藏的改狀態：[隱藏] 留著', h2.split('\n')[4], '雅琦問題：發票作廢 [隱藏]');
    const h3 = ent.setEvent(h1, 1, ent.listEntries(h1)[1].raw, 7);
    check('C16 隱藏的加事件編號：插在標記前面', h3.split('\n')[4], '雅琦問題：發票作廢 ^7 [隱藏] [待回覆]');
    check('C16 取消隱藏', ent.setHidden(h1, 1, ent.listEntries(h1)[1].raw, false), v);
    check('C16 處理完搬走時 [隱藏] 和狀態都拿掉', ent.takeEntry(h1, 1, ent.listEntries(h1)[1].raw).taken[0], '雅琦問題：發票作廢');

    const up = ent.appendUpdate(day, 1, list[1].raw, '->台應說是排程');
    check('C10 同一天的更新接在那一筆最後面', up.split('\n').slice(4, 8), ['雅琦問題：發票作廢', '\t->問台應', '\t->台應說是排程', 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期']);
    ok('C10 更新空白 → 報錯', throws(() => ent.appendUpdate(day, 1, list[1].raw, ' -> ')));
  }

  /* ---------- 搜尋、時間軸、未結（見 開發筆記 D022、D023） ---------- */
  {
    const idx = srch.buildIndex([
      { src: '2026-01-10', text: 'CWMM3030 備料調撥 BUG ^7 [待回覆]\n\t撥出庫別要檢查\n雅琦問題：發票作廢 ^8 [完成]\nCWIN301020 銷貨單 [待處理]\n' },
      { src: '2026-01-12', text: 'Cwmm3030 備料調撥 ^7 [完成]\n\t->改好了\n雅琦問題：發票作廢 ^8 [待處理]\n\t->又出現\n' },
      { src: 'todo', text: '週報\n-MAIL 趙縈問題 閃退 ^9\n' },
    ]);
    const key = x => x.src + '#' + x.index;
    check('S1 搜尋：每個詞都要有、不分大小寫、新的在前', srch.search(idx, 'cwmm3030 庫別').map(key), ['2026-01-10#0']);
    check('S1 搜尋：內容也算', srch.search(idx, '又出現').map(key), ['2026-01-12#1']);
    check('S1 搜尋：待辦區也找得到、排最前面', srch.search(idx, '問題').map(key), ['todo#1', '2026-01-12#1', '2026-01-10#1']);
    check('S1 空字串不搜', srch.search(idx, '   '), []);
    check('S2 代號時間軸：大小寫算同一支、舊的在前', srch.timelineByCode(idx, 'cwmm3030').map(key), ['2026-01-10#0', '2026-01-12#0']);
    check('S3 事件時間軸', srch.timelineByEvent(idx, 8).map(key), ['2026-01-10#1', '2026-01-12#1']);
    check('S5 最大事件編號（含待辦區）', srch.maxEvent(idx), 9);
  }

  /* ---------- 自動補完的候選（見 開發筆記 D031、D032、D054） ---------- */
  {
    const lc = t => leadCodeName(headMeta(t));
    check('A1 代號＋程式名稱', lc('CWIN301020 銷貨單 BUG 異動送貨地址'), { code: 'CWIN301020', name: '銷貨單', text: 'CWIN301020 銷貨單' });
    check('A1 括號算名稱、黏在後面的 BUG 去掉', lc('CWCS6123 銷項發票開立作業(賀眾)BUG').text, 'CWCS6123 銷項發票開立作業(賀眾)');
    check('A1 代號和名稱中間的空白（兩個空白、Tab）變一個空白', [lc('TX_SalesR_AMailNotice  郵件通知折讓證明單開立函式 新程式撰寫').text, lc('CWIN3010Posting\t進銷庫存單據過帳函式').text],
      ['TX_SalesR_AMailNotice 郵件通知折讓證明單開立函式', 'CWIN3010Posting 進銷庫存單據過帳函式']);
    check('A1 代號和名稱原本黏著的照黏', lc('EHRS手機版 畫面').text, 'EHRS手機版');
    check('A1 後面接類型字：只有代號', lc('CWIN3010Import BB'), { code: 'CWIN3010Import', name: '', text: 'CWIN3010Import' });
    check('A1 後面接「XX問題」：只有代號', lc('EMERP 雅琦問題 作業逾時').name, '');
    check('A1 後面有句讀：只有代號', lc('EMERP EMERP登錄、主框架').name, '');
    check('A1 後面是另一支代號：只有代號', lc('CWIN301021 CWIN301022 銷退單').name, '');
    check('A1 行尾標記、事件編號不算名稱', lc('CWMM3030 ^3 [待回覆]').name, '');
    check('A1 行首不是代號：null', lc('看CWIN301010 進貨單'), null);
    check('A1 沒有代號：null', lc('週報'), null);

    const sg = srch.suggestions(srch.buildIndex([
      { src: '2026-01-10', text: 'CWMM3030 備料維護 BUG\n\t欄位 MF10159 要拿掉\nCWIN301020 銷貨單\n秀屏問題 進貨單\n' },
      { src: '2026-01-12', text: 'CWMM3030 備料調撥 BUG\n\t->改好了 MF10159\nCWIN3010Import BB\n' },
      { src: 'todo', text: 'CWIN301021 銷退單 先[MF10159]折讓\nWaacCpaApp2026\n' },
    ]));
    const ts = x => x.map(y => y.t);
    check('A2 標題候選：「代號＋程式名稱」和整行標題；一樣多次的新的在前（同一天後面的較新）、待辦區排最後', ts(sg.titles),
      ['CWIN3010Import', 'CWIN3010Import BB', 'CWMM3030 備料調撥', 'CWMM3030 備料調撥 BUG', '秀屏問題 進貨單', 'CWIN301020 銷貨單',
        'CWMM3030 備料維護', 'CWMM3030 備料維護 BUG', 'WaacCpaApp2026', 'CWIN301021 銷退單', 'CWIN301021 銷退單 先[MF10159]折讓']);
    const sg2 = srch.suggestions(srch.buildIndex([{ src: '2026-01-10', text: 'CWMM3030 BUG\nCWMM3030 備料維護\nCWIN9011\n' }]));
    check('A2 同一支代號有帶名稱的寫法，就不列光代號（整行標題不只代號的照列）', ts(sg2.titles), ['CWIN9011', 'CWMM3030 備料維護', 'CWMM3030 BUG']);
    const sg3 = srch.suggestions(srch.buildIndex([
      { src: '2026-01-10', text: 'CWMM3030 備料維護 BUG\n週報\n' },
      { src: '2026-01-11', text: 'CWMM3030 備料維護 施工中\n週報 [待回覆]\n' },
      { src: '2026-01-12', text: 'CWMM3030 備料調撥 BUG ^3\n' },
    ]));
    check('A2 用過越多次越前面；行尾標記、事件編號拿掉才算；「代號＋程式名稱」算幾行標題這樣開頭', sg3.titles.map(x => `${x.t}:${x.n}`),
      ['週報:2', 'CWMM3030 備料維護:2', 'CWMM3030 備料調撥:1', 'CWMM3030 備料調撥 BUG:1', 'CWMM3030 備料維護 施工中:1', 'CWMM3030 備料維護 BUG:1']);
    check('A3 搜尋字：代號（含內容）、程式名稱、人名；出現在越多筆越前面，一樣多的新的在前；方括號裡的標題字不算', ts(sg.words),
      ['CWMM3030', 'MF10159', 'CWIN3010Import', '備料調撥', '秀屏', '銷貨單', 'CWIN301020', '備料維護', 'WaacCpaApp2026', '銷退單', 'CWIN301021']);
    const sg4 = srch.suggestions(srch.buildIndex([
      { src: '2026-01-10', text: 'CWMM3030 備料維護\n\t1.新程式\n\t->已上版\n' },
      { src: '2026-01-11', text: 'CWIN301020 銷貨單\n\t->已上版\n\t1.新程式\n' },
      { src: '2026-01-12', text: 'CWIN301020  銷貨單\n\t->已上版\n\tWD2MVAT\t發票資料檔\n' },
    ]));
    check('A4 內文候選：一行一行、用過越多次越前面；記下寫在哪些標題底下；空白變一個空白', sg4.lines,
      [{ t: '->已上版', n: 3, heads: ['CWIN301020 銷貨單', 'CWMM3030 備料維護'] },
        { t: '1.新程式', n: 2, heads: ['CWIN301020 銷貨單', 'CWMM3030 備料維護'] },
        { t: 'WD2MVAT 發票資料檔', n: 1, heads: ['CWIN301020 銷貨單'] }]);
  }

  /* ---------- 版本號（見 開發筆記 D039）：x.y.z，package.json 跟 package-lock.json 兩處一致 ---------- */
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    ok('V1 版本號是 x.y.z', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
    check('V1 package-lock.json 兩處跟 package.json 一樣', [lock.version, lock.packages[''].version], [pkg.version, pkg.version]);
  }

  /* ---------- 匯出 Markdown（見 開發筆記 D035） ---------- */
  {
    const md = exp.toMarkdown({
      title: '工作紀錄 T',
      days: [
        { date: '2026-01-21', text: 'CWIN301021 銷退單 BUG ^3\n\t參數未勾\n\t\t子項目\n雅琦問題：發票作廢 [待回覆]\n\t->雅琪問台應看看\n' },
        { date: '2026-01-22', text: '\n' },
        { date: '2026-01-23', text: 'TX_A\nTX_B\n\t共用內容\n\t1. 第一點\n\t1.控管\n\t- 不是清單\n' },
      ],
      todo: '週報 [隱藏] [待回覆]\n-MAIL 趙縈問題\n',
    });
    check('X1 日期標題帶星期、每行標題是一個小標題（原文，^編號、狀態照寫）、內容是清單；多的 Tab 變下一層、其他字原樣（-> 不改、不跳脫）；' +
      '沒寫東西的日子不列；共用內容的標題連著寫；全部的最後接待處理（含隱藏）', md.split('\n'), [
      '# 工作紀錄 T', '',
      '## 2026-01-21（三）', '',
      '### CWIN301021 銷退單 BUG ^3', '', '- 參數未勾', '  - 子項目', '',
      '### 雅琦問題：發票作廢 [待回覆]', '', '- ->雅琪問台應看看', '',
      '## 2026-01-23（五）', '',
      '### TX_A', '### TX_B', '', '- 共用內容', '- 1. 第一點', '- 1.控管', '- - 不是清單', '',
      '## 待處理', '',
      '### 週報 [隱藏] [待回覆]', '',
      '### -MAIL 趙縈問題', '',
    ]);
    check('X1 沒給待辦區就不接', exp.toMarkdown({ title: 'T', days: [{ date: '2026-01-21', text: 'A程式\n' }] }), '# T\n\n## 2026-01-21（三）\n\n### A程式\n');
    check('X1 前面沒有標題的內容：直接列在日期底下', exp.toMarkdown({ title: 'T', days: [{ date: '2026-01-21', text: '\t沒有標題的內容\n' }] }),
      '# T\n\n## 2026-01-21（三）\n\n- 沒有標題的內容\n');
    check('X1 待處理是空的', exp.toMarkdown({ title: 'T', days: [], todo: '' }), '# T\n\n## 待處理\n\n（沒有）\n');
  }
  /* 匯出再匯回（見 開發筆記 D046）：卡片一模一樣；空白縮排變 Tab、內容中間的空行拿掉 */
  {
    const days = [
      // 前面沒有標題的內容、^編號、隱藏＋狀態、-> 前後的空白、多層 Tab、Tab 後面接空白、空白縮排（D008）、沒縮排的「1.」內容（D008）
      { date: '2026-01-21', text: '\t沒有標題的內容\n\nCWIN301021 銷退單 BUG ^3 [待回覆]\n\t->改好了\n\t -> 施工中\n\t\t子項目\n\t\t\t孫項目\n\t  兩個空白\n    空白縮排\n1. 沒縮排的內容\n\n\t中間空一行\n' },
      // 共用內容（光頭連著）、不共用（不是光頭）、空行隔開的光頭、內容開頭像 Markdown 語法或反斜線、標題裡有 / 和 #
      { date: '2026-01-23', text: 'TX_A\nTX_B\n\t共用內容\neWCH3050 其他費用申請 BUG\nCWIN301021 銷退單 BUG\n\t只屬於最後一行\nTX_C\n\nTX_D\n\t只屬於 TX_D\n#主題 A / B ### C\n\t- 不是清單\n\t# 不是標題\n\t\\\\server\\share\n\t1\\. 原本就有反斜線\n\t→ 原本就是箭頭\n' },
      { date: '2026-01-24', text: 'A沒內容\nB也沒內容\n' },
    ];
    const todo = '週報 [隱藏] [待回覆]\n-MAIL 趙縈問題\n\t->問過了\n';
    const md = exp.toMarkdown({ title: 'T', days, todo });
    const back = exp.parse(md);
    check('X2 匯回的日子跟匯出的一樣', back.days.map(d => d.date), days.map(d => d.date));
    for (const d of days) check(`X2 ${d.date} 匯回後卡片一模一樣`, cardsOf(back.days.find(x => x.date === d.date).text), cardsOf(d.text));
    check('X2 待處理匯回後卡片一模一樣', cardsOf(back.todo), cardsOf(todo));
    check('X2 匯回的檔再匯出一次，跟第一次匯出的一字不差', exp.toMarkdown({ title: 'T', days: back.days, todo: back.todo }), md);
    check('X2 待處理是空的：匯回沒有待處理', exp.parse(exp.toMarkdown({ title: 'T', days, todo: '' })).todo, null);
    check('X2 CRLF 也認得', exp.parse(md.replace(/\n/g, '\r\n')), back);
  }
  /* daybook Markdown 匯入：認不得就報錯，寫第幾行（不猜，見 開發筆記 D046） */
  {
    const err = fn => { try { fn(); return null; } catch (e) { return e.message; } };
    ok('X3 認不得的行 → 報錯、寫第幾行', /^第 4 行/.test(err(() => exp.parse('# T\n\n## 2026-01-21（三）\n亂寫的一行\n')) || ''));
    ok('X3 第一個日期之前就有內容 → 報錯', !!err(() => exp.parse('# T\n### A\n## 2026-01-21\n')));
    ok('X3 同一天出現兩次 → 報錯', !!err(() => exp.parse('# T\n## 2026-01-21\n### A\n## 2026-01-21\n### B\n')));
    ok('X3 不存在的日期 → 報錯', !!err(() => exp.parse('# T\n## 2026-02-30\n### A\n')));
    ok('X3 「## 待處理」兩次 → 報錯', !!err(() => exp.parse('# T\n## 待處理\n### A\n## 待處理\n')));
    ok('X3 標題是「數字＋.」開頭（會被當成內容）→ 報錯', !!err(() => exp.parse('# T\n## 2026-01-21\n### 1. A\n')));
    ok('X3 清單沒有字 → 報錯', !!err(() => exp.parse('# T\n## 2026-01-21\n### A\n-  \n')));
    check('X3 星期寫錯不管（只看日期）', exp.parse('# T\n## 2026-01-21（日）\n### A\n').days, [{ date: '2026-01-21', text: 'A\n' }]);
  }
  /* 匯入時認格式（見 開發筆記 D047）：只有一種認得才用它 */
  {
    const md = exp.toMarkdown({ title: 'T', days: [{ date: '2026-01-21', text: 'A\n\tx\n' }], todo: '週報\n' });
    check('F1 匯出檔認成 daybook Markdown', fmts.pickFormat(md).label, 'daybook Markdown');
    check('F1 舊記事本認成舊記事本', fmts.pickFormat('---2026---\n1/5\nA\n').label, '舊記事本');
    check('F1 只有「週報」待辦區的舊記事本也認得', fmts.pickFormat('週報\nA\n').label, '舊記事本');
    ok('F1 兩種都不像 → 報錯、列出能匯入的格式', (() => { try { fmts.pickFormat('隨便寫的\n'); return false; } catch (e) { return e.message.includes('daybook Markdown') && e.message.includes('舊記事本'); } })());
    ok('F1 兩種都像 → 報錯、不猜', (() => { try { fmts.pickFormat('# T\n## 2026-01-05\n1/5\n'); return false; } catch (e) { return e.message.includes('分不出'); } })());
    ok('F1 每個格式都有名稱、說明、副檔名、detect、parse', fmts.FORMATS.every(f => f.label && f.hint && f.extensions.length && typeof f.detect === 'function' && typeof f.parse === 'function'));
  }

  /* ---------- 可攜版留下的解壓資料夾（見 開發筆記 D050）：只清認得出來、沒在用的 ---------- */
  {
    const { cleanPortableLeftovers } = require(path.join(ROOT, 'src/main/cleanup.js'));
    const temp = tmpDir();
    const ksuid = c => c.repeat(27);
    const make = (name, files) => {
      const d = path.join(temp, name);
      for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); }
      return d;
    };
    const app = ['daybook.exe', 'resources/app.asar', 'locales/zh-TW.pak', 'LICENSE.electron.txt'];
    const left1 = make(ksuid('A'), app), left2 = make(ksuid('B'), app);
    const own = make(ksuid('C'), app);
    const busy = make(ksuid('D'), ['resources/app.asar', 'locales/zh-TW.pak']);
    const named = make('daybook-自己放的', app);
    const other = make(ksuid('E'), ['someapp.exe', 'resources/app.asar']);
    const noAsar = make(ksuid('F'), ['daybook.exe']);
    // 正在跑的：拿 Windows 的 PING.EXE 改名成 daybook.exe 跑起來（跑著的 exe 用寫入模式打不開）
    const busyExe = path.join(busy, 'daybook.exe');
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE'), busyExe);
    const proc = require('child_process').spawn(busyExe, ['-n', '30', '127.0.0.1'], { stdio: 'ignore' });
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) { try { fs.closeSync(fs.openSync(busyExe, 'r+')); } catch { break; } }   // 等它真的跑起來
    try {
      const removed = cleanPortableLeftovers(temp, own, fs);
      check('C1 刪掉的是那兩個殘留', removed.sort(), [ksuid('A'), ksuid('B')]);
      ok('C1 殘留整個資料夾都不見了', !fs.existsSync(left1) && !fs.existsSync(left2));
      ok('C1 正在跑的這一份（ownDir）不動', app.every(f => fs.existsSync(path.join(own, f))));
      ok('C1 有 daybook 正從那裡跑著的不動（一個檔都沒少）', ['daybook.exe', 'resources/app.asar', 'locales/zh-TW.pak'].every(f => fs.existsSync(path.join(busy, f))));
      ok('C1 名稱不是 27 碼英數的不動', app.every(f => fs.existsSync(path.join(named, f))));
      ok('C1 別的程式的解壓資料夾（沒有 daybook.exe）不動', fs.existsSync(path.join(other, 'someapp.exe')) && fs.existsSync(path.join(other, 'resources/app.asar')));
      ok('C1 沒有 resources\\app.asar 的不動', fs.existsSync(path.join(noAsar, 'daybook.exe')));
      check('C1 暫存區不存在：不出錯、什麼都不刪', cleanPortableLeftovers(path.join(temp, '沒有這個'), null, fs), []);
    } finally {
      proc.kill();
      const t1 = Date.now();
      while (Date.now() - t1 < 5000) { try { fs.closeSync(fs.openSync(busyExe, 'r+')); break; } catch { /* 等它結束 */ } }
    }
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
  /* 畫面上的匯入要寫哪些（見 開發筆記 D044） */
  {
    const txt = '﻿---2026---\n1/5\nA程式 BUG\n\tx\n1/6\nB\n\n週報\n-MAIL 趙縈問題\n';
    const none = () => false;
    const p0 = await impUI.planImport(txt, none);
    check('M1 有「週報」那行：從那行起是待辦區；開頭的 BOM 不算內容', [p0.format, p0.write.map(d => d.date), p0.todo], ['舊記事本', ['2026-01-05', '2026-01-06'], '週報\n-MAIL 趙縈問題\n']);
    check('M1 每天的內容去掉頭尾空行、\\n 換行', p0.write.map(d => d.text), ['A程式 BUG\n\tx\n', 'B\n']);
    const p1 = await impUI.planImport(txt, rel => rel === imp.dayPath('2026-01-05'));
    check('M1 資料夾裡已經有的日子分出來（加進去還是略過由畫面問，D063）、其他照寫', [p1.write.map(d => d.date), p1.existing.map(d => d.date)], [['2026-01-06'], ['2026-01-05']]);
    const p2 = await impUI.planImport(txt, rel => rel === imp.TODO_FILE);
    check('M1 待辦.md 已經有內容：標出來，待處理照樣拆出來（加進去要用）', [p2.todo, p2.todoExisting, p2.write.length], ['週報\n-MAIL 趙縈問題\n', true, 2]);
    const p3 = await impUI.planImport('---2026---\n1/5\nA\n', none);
    check('M1 沒有「週報」那行：沒有待辦區', [p3.todo, p3.todoExisting], [null, false]);
    ok('M1 沒有日期行 → 報錯', !!(await rejects(() => impUI.planImport('\n\n', none))));
    ok('M1 沒有年份標記 → 報錯（不猜年份）', !!(await rejects(() => impUI.planImport('1/5\nA\n', none))));
    // daybook Markdown 也走同一套：已經有的日子、待辦.md 有內容都分出來（D044、D063）
    const md = exp.toMarkdown({ title: 'T', days: [{ date: '2026-01-05', text: 'A ^2\n\tx\n' }, { date: '2026-01-06', text: 'B\n' }], todo: '週報\n' });
    const p4 = await impUI.planImport('﻿' + md, rel => rel === imp.dayPath('2026-01-05') || rel === imp.TODO_FILE);
    check('M1 匯出檔：認成 daybook Markdown、已經有的日子分出來、待處理有內容標出來',
      [p4.format, p4.write, p4.existing.map(d => d.date), p4.todo, p4.todoExisting],
      ['daybook Markdown', [{ date: '2026-01-06', text: 'B\n' }], ['2026-01-05'], '週報\n', true]);
  }
  /* 「加進去」：一筆一筆比，一模一樣的不再加（見 開發筆記 D063） */
  {
    const merge = impUI.mergeEntries;
    // sample 的 1/15 拆成 4 筆，第 3 筆是 TX_Cancel… 標題＋內容（第 3、4 行）；資料夾裡那天也有一模一樣的這筆
    const s15 = imp.splitDays(fs.readFileSync(SAMPLE, 'utf8')).find(d => d.date === '2026-01-15').lines;
    const have15 = 'CWIN301021 銷退單 BUG\n\t參數未勾開立作廢發送通知\n' + s15.slice(2, 4).join('\n') + '\n';
    check('M4 前提：兩邊各自拆出來的筆', [parseDay(s15.join('\n')).length, parseDay(have15).length], [4, 2]);
    const r1 = merge(have15, s15.join('\n') + '\n', '2026-01-15');
    check('M4 一模一樣的那筆不加，其他照順序接在最後面', r1, { text: have15 + [s15[0], s15[1], s15[4]].join('\n') + '\n', added: 3, dup: 1 });
    check('M4 再加一次：一筆都不加、文字不變', merge(r1.text, s15.join('\n') + '\n', '2026-01-15'), { text: r1.text, added: 0, dup: 4 });
    const spaced = 'CWIN301021 銷退單 BUG  \n\tx \n';
    check('M4 行尾的空白不算', merge(spaced, 'CWIN301021 銷退單 BUG\n\tx\n', 'd'), { text: spaced, added: 0, dup: 1 });
    check('M4 同樣的兩筆、資料夾裡只有一筆：加一筆', merge('Q1研發設計師職能測驗\n', 'Q1研發設計師職能測驗\nQ1研發設計師職能測驗\n', 'd'),
      { text: 'Q1研發設計師職能測驗\nQ1研發設計師職能測驗\n', added: 1, dup: 1 });
    // 前一筆只有光頭標題、要加的是光頭標題＋內容：直接接會變成共用內容（D009），要隔一行空行
    ok('M4 前提：光頭標題直接接光頭標題＋內容，會拆成一筆', parseDay('CWIN301020 銷貨單\nCWIN301021 銷退單\n\t權限說明\n').length === 1);
    check('M4 前一筆只有光頭標題：隔一行空行，還是各自一筆', merge('CWIN301020 銷貨單\n', 'CWIN301021 銷退單\n\t權限說明\n', 'd').text, 'CWIN301020 銷貨單\n\nCWIN301021 銷退單\n\t權限說明\n');
    check('M4 前一筆不是光頭（有 BUG 類型字）：不隔空行', merge('eWCH3050 其他費用申請 BUG\n', 'CWIN301021 銷退單\n\t權限說明\n', 'd').text, 'eWCH3050 其他費用申請 BUG\nCWIN301021 銷退單\n\t權限說明\n');
    let nh = null;
    try { merge('A程式 BUG\n\tx\n', '\t沒有標題的內容\nB\n', '2026-01-05'); } catch (e) { nh = e.message; }
    ok('M4 開頭的內容沒有標題：接在後面會變成上一筆的內容 → 報錯，寫是哪一天', (nh || '').includes('2026-01-05 加不進去') && nh.includes('沒有標題的內容'), nh);
    check('M4 資料夾裡是空的：照原樣寫', merge('', 'A\n\tx\n', 'd'), { text: 'A\n\tx\n', added: 1, dup: 0 });
  }
  /* 匯入格式的外部擴充（見 開發筆記 D055） */
  {
    const extMod = require(path.join(ROOT, 'src/main/extensions.js'));
    const EXAMPLE = path.join(ROOT, 'examples', 'extensions', 'daybook-example-dated');
    const appV = require(path.join(ROOT, 'package.json')).version;
    const none = () => false;
    // 擴充程序：正式是 Electron 的 utilityProcess，這裡用 child_process.fork 開同一支 ext-host.js，包成 utilityProcess 的樣子
    const forkHost = () => {
      const c = require('child_process').fork(path.join(ROOT, 'src/main/ext-host.js'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(c);
      return { postMessage: m => c.send(m), on: (e, fn) => c.on(e, fn), kill: () => c.kill() };
    };

    check('K1 engines ^X.Y.Z：第一碼一樣、不比它舊才相容',
      [['^1.10.0', '1.10.0'], ['^1.10.0', '1.12.3'], ['^1.10.0', '2.0.0'], ['^1.10.0', '1.9.9'], ['^1.10.2', '1.10.1'], ['^2.0.0', '1.10.0']].map(([r, v]) => extMod.compatible(r, v)),
      [true, true, false, false, false, false]);

    // K2：讀擴充資料夾——每種壞法都造一個
    const root = tmpDir();
    const mkExt = (folder, pkg, code = '') => {
      const d = path.join(root, folder);
      fs.mkdirSync(d);
      const p = { name: folder, version: '1.0.0', main: 'index.js', engines: { daybook: '^' + appV },
        contributes: { importFormats: [{ id: 'f', label: folder, hint: '說明', extensions: ['txt'] }] }, ...pkg };
      for (const k of Object.keys(p)) if (p[k] === null) delete p[k];
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(p));
      if (code != null) fs.writeFileSync(path.join(d, 'index.js'), code);
    };
    fs.cpSync(EXAMPLE, path.join(root, 'a-example'), { recursive: true });
    mkExt('b-new', { engines: { daybook: `^${Number(appV.split('.')[0]) + 1}.0.0` } });
    fs.mkdirSync(path.join(root, 'c-badjson'));
    fs.writeFileSync(path.join(root, 'c-badjson', 'package.json'), '{ name: ');
    fs.mkdirSync(path.join(root, 'd-nopkg'));
    mkExt('e-nofile', {}, null);
    mkExt('f-dup', { name: 'daybook-example-dated' });
    mkExt('g-noformats', { contributes: null });
    mkExt('h-range', { engines: { daybook: '>=1.0.0' } });
    mkExt('i-bom', {});
    fs.writeFileSync(path.join(root, 'i-bom', 'package.json'), '﻿' + fs.readFileSync(path.join(root, 'i-bom', 'package.json'), 'utf8'));
    mkExt('j-badfmt', { contributes: { importFormats: [{ id: 'f', label: 'x', extensions: ['txt'] }] } });
    fs.writeFileSync(path.join(root, '不是資料夾.txt'), 'x');
    const s0 = extMod.scan(root, appV, {});
    const st = (list, folder) => { const x = list.find(e => e.folder === folder); return x ? [x.state, x.reason] : null; };
    check('K2 照資料夾名稱排，檔案不算', s0.map(x => x.folder), ['a-example', 'b-new', 'c-badjson', 'd-nopkg', 'e-nofile', 'f-dup', 'g-noformats', 'h-range', 'i-bom', 'j-badfmt']);
    const ex = s0[0];
    check('K2 範例：未啟用；名稱、版本、格式、程式檔照 package.json',
      [ex.state, ex.reason, ex.name, ex.displayName, ex.version, ex.formats, ex.file],
      ['disabled', '', 'daybook-example-dated', '範例：日期分隔純文字', '1.0.0', [{ id: 'dated-txt', label: '日期分隔純文字', hint: '一行 === 2026-10-27 === 隔開每一天', extensions: ['txt'] }], path.join(root, 'a-example', 'index.js')]);
    ok('K2 版本不合：寫要哪一版、現在哪一版', st(s0, 'b-new')[0] === 'incompatible' && st(s0, 'b-new')[1].includes(appV), JSON.stringify(st(s0, 'b-new')));
    check('K2 壞掉的：每一種寫原因',
      ['c-badjson', 'd-nopkg', 'e-nofile', 'f-dup', 'g-noformats', 'h-range', 'j-badfmt'].map(f => st(s0, f)),
      [['broken', 'package.json 不是正確的 JSON'], ['broken', '沒有 package.json'], ['broken', '找不到程式檔 index.js'],
        ['broken', 'name 跟資料夾「a-example」的擴充重複'], ['broken', 'package.json 的 contributes.importFormats 沒有列格式'],
        ['broken', 'package.json 的 engines.daybook 要寫成 ^版本號，例如 ^1.10.0'], ['broken', 'contributes.importFormats 每一種格式都要有 id、label、hint、extensions']]);
    check('K2 package.json 開頭有 BOM 也讀得到', st(s0, 'i-bom'), ['disabled', '']);
    const s1 = extMod.scan(root, appV, { 'daybook-example-dated': '1.0.0' });
    check('K2 啟用過、版本一樣：已啟用', st(s1, 'a-example'), ['enabled', '']);
    const s2 = extMod.scan(root, appV, { 'daybook-example-dated': '0.9.0' });
    check('K2 改版了：變回未啟用、寫要再啟用一次', st(s2, 'a-example'), ['disabled', '改版了（啟用的是 0.9.0），要再啟用一次']);
    check('K2 資料夾還沒有：空的', extMod.scan(path.join(root, '沒有'), appV, {}), []);
    check('K2 enabledFormats：只列已啟用的，帶擴充名稱、程式檔', extMod.enabledFormats(s1).map(f => [f.id, f.label, f.ext, f.file]),
      [['dated-txt', '日期分隔純文字', '範例：日期分隔純文字', path.join(root, 'a-example', 'index.js')]]);

    // K3：擴充拆出來的結果要先檢查
    const cp = impUI.checkParsed;
    const msg = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
    check('K3 換行一律 \\n、有字的結尾補 \\n、空的不補',
      cp({ days: [{ date: '2026-01-05', text: 'A\r\n\tx' }, { date: '2026-01-06', text: '' }], todo: 'T\rU' }),
      { days: [{ date: '2026-01-05', text: 'A\n\tx\n' }, { date: '2026-01-06', text: '' }], todo: 'T\nU\n' });
    check('K3 todo 沒給、空字串都是 null', [cp({ days: [] }).todo, cp({ days: [], todo: '' }).todo], [null, null]);
    for (const [name, r, want] of [
      ['不是物件', null, '{ days'], ['days 不是陣列', { days: 'x' }, '{ days'],
      ['日期格式不對', { days: [{ date: '2026-1-5', text: '' }] }, '第 1 天的日期 "2026-1-5"'],
      ['不存在的日期', { days: [{ date: '2026-02-30', text: '' }] }, '"2026-02-30"'],
      ['日期不是字串', { days: [{ date: 20260105, text: '' }] }, '20260105'],
      ['同一天兩次', { days: [{ date: '2026-01-05', text: '' }, { date: '2026-01-05', text: '' }] }, '2026-01-05 出現兩次'],
      ['內容不是文字', { days: [{ date: '2026-01-05', text: 1 }] }, '2026-01-05 的內容不是文字'],
      ['todo 不是文字', { days: [], todo: 1 }, 'todo 要是文字'],
    ]) ok('K3 ' + name + ' → 報錯', msg(() => cp(r)).includes(want), msg(() => cp(r)));

    // F2：認格式加上擴充的格式（detect 已經在獨立程序跑過，結果放 hit）
    const e1 = { label: '日期分隔純文字', hint: 'H', extensions: ['txt'], ext: '範例' };
    check('F2 只有擴充認得：用擴充的格式', fmts.pickFormat('隨便\n', [{ ...e1, hit: true }]).ext, '範例');
    const unk = (() => { try { fmts.pickFormat('隨便\n', [{ ...e1, hit: false }]); return null; } catch (e) { return e; } })();
    ok('F2 都不認得：列出的格式有擴充的（寫是哪個擴充），錯誤帶 unknownFormat',
      unk && unk.unknownFormat === true && unk.message.includes('日期分隔純文字（擴充「範例」，H）') && unk.message.includes('舊記事本'), unk && unk.message);
    const both = msg(() => fmts.pickFormat('---2026---\n1/5\nA\n', [{ ...e1, hit: true }]));
    ok('F2 內建和擴充都認得：報錯不猜，寫是哪個擴充、可以到「匯入格式」頁停用', both.includes('分不出') && both.includes('「日期分隔純文字」（擴充「範例」）')
      && both.includes('右上角「匯入格式」停用擴充') && !both.includes('說明'), both);
    const bothE = (() => { try { fmts.pickFormat('---2026---\n1/5\nA\n', [{ ...e1, hit: true }]); return null; } catch (e) { return e; } })();
    check('F2 兩種以上都認得：錯誤帶認得的那幾種（畫面上的匯入拿來問用哪一種，D058）', bothE && bothE.candidates.map(f => f.label), ['舊記事本', '日期分隔純文字']);
    ok('F2 只有內建的兩種都像：不提擴充', !msg(() => fmts.pickFormat('# T\n## 2026-01-05\n1/5\n')).includes('擴充'));

    // K4：擴充程序（ext-host.js）——真的開一個子程序跑
    const hostRoot = tmpDir();
    const fmt = (ext, code) => {
      const file = path.join(hostRoot, ext + '.js');
      fs.writeFileSync(file, code);
      return { id: 'f', label: ext, hint: 'h', extensions: ['txt'], ext, file };
    };
    const good = fmt('好的', "module.exports = { formats: { f: { detect: t => t.includes('好'), parse: t => ({ days: [{ date: '2026-01-05', text: t }], todo: null }) } } };");
    const zero = fmt('回傳零', 'module.exports = { formats: { f: { detect: () => 0, parse: () => null } } };');
    let h = extMod.startHost(forkHost, [good, zero], 5000);
    check('K4 detect：每一種認不認得（回傳不是 true/false 也轉成 true/false）', await h.detect('好'), [true, false]);
    check('K4 parse：同一個程序接著拆', await h.parse(good, '好'), { days: [{ date: '2026-01-05', text: '好' }], todo: null });
    h.kill();
    const fails = [
      ['detect 丟錯', fmt('會丟錯', "module.exports = { formats: { f: { detect: () => { throw new Error('壞了'); }, parse: () => null } } };"), ['擴充「會丟錯」出錯：壞了']],
      ['程式檔語法錯', fmt('語法錯', 'module.exports = {'), ['擴充「語法錯」出錯']],
      ['程式檔沒給 detect / parse', fmt('沒給函式', 'module.exports = { formats: {} };'), ['擴充「沒給函式」出錯：程式檔沒有給格式「f」的 detect 和 parse']],
      ['自己結束程序', fmt('自己結束', 'module.exports = { formats: { f: { detect: () => process.exit(3), parse: () => null } } };'), ['擴充「自己結束」讓擴充程序結束了（exit 3）']],
    ];
    for (const [name, f, wants] of fails) {
      h = extMod.startHost(forkHost, [good, f], 5000);
      const m = await rejects(() => h.detect('x'));
      h.kill();
      ok('K4 ' + name + '：報錯、寫是哪個擴充', !!m && wants.every(w => m.includes(w)), m);
    }
    const slow = fmt('卡住', 'module.exports = { formats: { f: { detect: () => { for (;;) {} }, parse: () => null } } };');
    h = extMod.startHost(forkHost, [good, slow], 800);
    const t0 = Date.now();
    const ms = await rejects(() => h.detect('x'));
    ok('K4 卡住：超過時間就停掉，寫是哪個擴充', ms === '擴充「卡住」跑太久（超過 0.8 秒），已經停掉' && Date.now() - t0 < 3000, `${ms}（${Date.now() - t0}ms）`);
    const stuck = children[children.length - 1];
    ok('K4 卡住：子程序真的被關掉', await new Promise(r => {
      if (stuck.exitCode != null || stuck.signalCode != null) return r(true);
      stuck.once('exit', () => r(true));
      setTimeout(() => r(false), 2000);
    }));

    // M2：畫面上的匯入加上擴充——真的開擴充程序跑範例
    const exFormats = extMod.enabledFormats(s1);
    const sampleTxt = fs.readFileSync(path.join(EXAMPLE, 'sample.txt'), 'utf8');
    const want = require(path.join(EXAMPLE, 'index.js')).formats['dated-txt'].parse(sampleTxt);
    ok('M2 前提：範例拆出來至少兩天、有待處理', want.days.length >= 2 && !!want.todo, JSON.stringify(want));
    h = extMod.startHost(forkHost, exFormats, 5000);
    const pe = await impUI.planImport(sampleTxt, rel => rel === imp.dayPath(want.days[1].date), h);
    h.kill();
    check('M2 範例擴充：認成它的格式，名稱帶擴充', pe.format, '日期分隔純文字，擴充「範例：日期分隔純文字」');
    check('M2 範例擴充：照它拆的寫、已經有的日子分出來', [pe.write, pe.existing.map(d => d.date), pe.todo],
      [want.days.filter((_, i) => i !== 1), [want.days[1].date], want.todo]);
    h = extMod.startHost(forkHost, exFormats, 5000);
    check('M2 有啟用擴充時，內建格式照樣認得', (await impUI.planImport('---2026---\n1/5\nA\n', none, h)).format, '舊記事本');
    h.kill();
    const badOut = fmt('亂回', "module.exports = { formats: { f: { detect: () => true, parse: () => ({ days: [{ date: '2026-13-01', text: 'x' }] }) } } };");
    h = extMod.startHost(forkHost, [badOut], 5000);
    const mb = await rejects(() => impUI.planImport('x', none, h));
    h.kill();
    ok('M2 擴充回傳的日期不對 → 報錯（整批不寫）', (mb || '').includes('擴充拆出來的資料不對') && mb.includes('2026-13-01'), mb);

    // M3：兩種以上格式都認得 → 問 choose 用哪一種（見 開發筆記 D058）。「雙胞胎」跟範例一樣認 === 那一行
    const twin = fmt('雙胞胎', "module.exports = { formats: { f: { detect: t => t.includes('==='), parse: () => ({ days: [{ date: '2026-02-01', text: '雙胞胎\\n' }], todo: null }) } } };");
    let asked = null;
    h = extMod.startHost(forkHost, [...exFormats, twin], 5000);
    const pc = await impUI.planImport(sampleTxt, none, h, async c => { asked = c.map(f => f.ext); return c.find(f => f.ext === '雙胞胎'); }).catch(e => ({ error: e.message }));
    const pn = await impUI.planImport(sampleTxt, none, h, async () => null).catch(e => ({ error: e.message }));
    const pr = await rejects(() => impUI.planImport(sampleTxt, none, h));
    h.kill();
    check('M3 兩種以上都認得：問用哪一種（列出認得的那幾種），照選的拆', [asked, pc && pc.format, pc && pc.days],
      [['範例：日期分隔純文字', '雙胞胎'], '雙胞胎，擴充「雙胞胎」', [{ date: '2026-02-01', text: '雙胞胎\n' }]]);
    check('M3 選格式時取消 → 回 null', pn, null);
    ok('M3 沒給 choose → 照舊報錯', (pr || '').includes('分不出'), pr);

    /* 請 AI 寫的擴充（見 開發筆記 D056）：拿範例改個名字當成 AI 回的 */
    const ai = require(path.join(ROOT, 'src/main/ai-ext.js'));
    const prompt = ai.buildPrompt(appV);
    const mustSay = [ai.PKG_MARK, ai.CODE_MARK, `"daybook": "^${appV}"`, '「# 」', '「1/5」', '「---2026---」', '「週報」', ...ai.BANNED,
      '可以改結構，不能改內容', '先問我、我同意了才做', '「數字.」開頭的行', '問我從哪一年開始', '「12 月之後接 1 月」算跨年', '第 N 行：那行原文', '會問我這次要用哪一種'];
    ok('AI1 prompt：寫了兩行分隔線、engines 是現在的版本、兩種內建格式怎麼分、每個禁用的字；轉換、年份、認不得的行、撞格式會問（D059）', mustSay.every(s => prompt.includes(s)),
      '少了：' + mustSay.filter(s => !prompt.includes(s)).join('、'));
    const exPkg = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'package.json'), 'utf8'));
    const exCode = fs.readFileSync(path.join(EXAMPLE, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    const aiPkg = { ...exPkg, name: 'ai-dated', displayName: 'AI：日期分隔',
      contributes: { importFormats: [{ ...exPkg.contributes.importFormats[0], label: 'AI 日期分隔' }] } };
    const reply = (pkg = aiPkg, code = exCode) => `${ai.PKG_MARK}\n${JSON.stringify(pkg, null, 2)}\n${ai.CODE_MARK}\n${code}`;

    const sp = ai.splitReply(reply());
    check('AI2 照格式貼：拆出 package.json、index.js', [JSON.parse(sp.pkgText), sp.code], [aiPkg, exCode.replace(/\s+$/, '') + '\n']);
    check('AI2 整則回覆照貼（前後有說明、包在 ``` 裡）：一樣', ai.splitReply('好的，以下是擴充：\n```\n' + reply() + '```\n有問題再跟我說。\n'), sp);
    const twoBlocks = ai.splitReply(`說明\n${ai.PKG_MARK}\n\`\`\`json\n${JSON.stringify(aiPkg)}\n\`\`\`\n${ai.CODE_MARK}\n\`\`\`javascript\n${exCode}\`\`\`\n`);
    check('AI2 分成兩個程式碼區塊：一樣', [JSON.parse(twoBlocks.pkgText), twoBlocks.code], [aiPkg, sp.code]);
    ok('AI2 沒有分隔線、順序反了 → 報錯', !!msg(() => ai.splitReply(exCode)) && !!msg(() => ai.splitReply(`${ai.CODE_MARK}\nx\n${ai.PKG_MARK}\n{}`)));

    const aiGood = ai.checkReply(reply(), appV);
    check('AI3 範例改名：沒有錯；要寫的 package.json main 是 index.js、程式照原樣（function 可以用）',
      [aiGood.errors, aiGood.pkg && aiGood.pkg.name, aiGood.pkg && aiGood.pkg.main, aiGood.code], [[], 'ai-dated', 'index.js', sp.code]);
    for (const [name, r, want3] of [
      ['package.json 不是 JSON', `${ai.PKG_MARK}\n{ name: x\n${ai.CODE_MARK}\n${exCode}`, 'package.json 不是正確的 JSON'],
      ['少欄位', reply({ ...aiPkg, contributes: null }), 'contributes.importFormats 沒有列格式'],
      ['name 有大寫、空白', reply({ ...aiPkg, name: 'My Ext' }), 'name 只能用英文小寫'],
      ['main 不是 index.js', reply({ ...aiPkg, main: 'lib.js' }), 'main 要是 index.js'],
      ['engines 跟現在的版本不相容', reply({ ...aiPkg, engines: { daybook: '^99.0.0' } }), `要寫 ^${appV}`],
      ['語法錯：寫第幾行', reply(aiPkg, 'const a = 1;\nconst b = ;\n'), 'index.js 第 2 行語法錯誤'],
      ['用了 process：寫第幾行', reply(aiPkg, exCode + 'const env = process.env;\n'), `index.js 第 ${exCode.split('\n').length} 行有「process」`],
      ['註解裡有 require 也不行', reply(aiPkg, '// 不用 require\n' + exCode), 'index.js 第 1 行有「require」'],
    ]) {
      const c = ai.checkReply(r, appV);
      ok('AI3 ' + name + ' → 不收', c.errors.some(m => m.includes(want3)) && c.pkg === null, JSON.stringify(c.errors));
    }
    const many = ai.checkReply(reply(aiPkg, 'const g = globalThis;\nconst f = fetch;\n'), appV).errors;
    ok('AI3 好幾個問題一次列完', many.some(m => m.includes('第 1 行有「globalThis」')) && many.some(m => m.includes('第 2 行有「fetch」')), JSON.stringify(many));

    // AI4：試跑——真的開擴充程序，跟匯入同一條路
    const aiRoot = tmpDir();
    const tmpAi = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('daybook-ai-')).sort();
    const tmpBefore = tmpAi();
    const run4 = over => ai.tryRun({ check: aiGood, text: sampleTxt, list: [], extRoot: aiRoot, exists: none, fork: forkHost, timeoutMs: 5000, ...over });
    const t1 = await run4({ exists: rel => rel === imp.dayPath(want.days[0].date) });
    const dates = want.days.map(d => d.date).sort();
    check('AI4 試跑範例的 sample.txt：裝到 name 的資料夾；天數、起訖、已經有幾天、待處理幾行、前幾天跟範例拆的一樣',
      t1.errors || [t1.folder, t1.preview.days, t1.preview.first, t1.preview.last, t1.preview.existing, t1.preview.todoLines, t1.preview.replaces, t1.preview.samples.map(s => s.date + '\n' + s.text + '\n')],
      ['ai-dated', want.days.length, dates[0], dates[dates.length - 1], 1, want.todo.replace(/\n$/, '').split('\n').length, null, want.days.slice(0, 3).map(d => d.date + '\n' + d.text)]);
    check('AI4 沒有別的格式認得：預覽不寫誰也認得', t1.preview && t1.preview.also, []);
    const t2 = await run4({ list: s1 });
    check('AI4 已啟用的範例也認得這個檔：試跑用 AI 寫的、照樣過，預覽寫範例也認得（匯入時會問，D058）',
      t2.errors || [t2.preview.days, t2.preview.also], [want.days.length, ['「日期分隔純文字」（擴充「範例：日期分隔純文字」）']]);
    const t3 = await run4({ check: ai.checkReply(reply({ ...aiPkg, name: 'daybook-example-dated' }), appV), list: s1 });
    check('AI4 跟已裝的同名：舊的不參加認格式、取代它、裝回它的資料夾', t3.errors || [t3.folder, t3.preview.replaces], ['a-example', { displayName: '範例：日期分隔純文字', version: '1.0.0' }]);
    fs.mkdirSync(path.join(aiRoot, 'ai-dated'));
    const t4 = await run4({});
    fs.rmSync(path.join(aiRoot, 'ai-dated'), { recursive: true });
    ok('AI4 擴充資料夾已經有同名的資料夾（不是擴充）→ 不收', !!t4.errors && t4.errors[0].includes('「ai-dated」這個資料夾'), JSON.stringify(t4));
    const t5 = await run4({ text: '---2026---\n1/5\nA\n' });
    ok('AI4 這個檔被認成舊記事本 → 不收', !!t5.errors && t5.errors[0].includes('被認成「舊記事本」'), JSON.stringify(t5));
    check('AI4 detect 不認得：附檔案開頭有字的行（行號＋原文）給 AI 看（D061）', t5.excerpt, ['第 1 行："---2026---"', '第 2 行："1/5"', '第 3 行："A"']);
    const t5c = await run4({ text: '隨便寫的\n' });
    check('AI4 沒有一種格式認得 → 不收，直接說 AI 的 detect 要認得，附檔案開頭（D061）', [t5c.errors, t5c.excerpt],
      [['AI 寫的 detect 不認得這個檔（別的格式也都不認得）：要認得這個檔'], ['第 1 行："隨便寫的"']]);
    const t5d = await run4({ text: '1/5\nA\n' });
    ok('AI4 AI 寫的不認得、舊記事本認得但拆不了（沒有年份）→ 報 AI 的 detect 不認得，不拿舊記事本去拆（D061）',
      !!t5d.errors && t5d.errors[0].includes('被認成「舊記事本」') && !t5d.errors[0].includes('年份') && !!t5d.excerpt, JSON.stringify(t5d));
    const t5b = await run4({ text: '# T\n## 2026-01-05\n1/5\n' });
    ok('AI4 別的兩種都認得、AI 寫的不認得 → 不收，寫被認成哪兩種', !!t5b.errors && t5b.errors[0].includes('被認成「daybook Markdown」和「舊記事本」'), JSON.stringify(t5b));
    const fake = body => ai.checkReply(reply(aiPkg, `module.exports = { formats: { 'dated-txt': { detect: () => true, parse: ${body} } } };\n`), appV);
    const t6 = await run4({ check: fake('() => ({ days: [], todo: null })') });
    ok('AI4 什麼都沒拆出來 → 不收', !!t6.errors && t6.errors[0].includes('沒有拆出任何一天'), JSON.stringify(t6));
    check('AI4 什麼都沒拆出來：也附檔案開頭', t6.excerpt, ai.excerpt(sampleTxt));
    const t7 = await run4({ check: fake("() => { throw new Error('第 3 行看不懂'); }") });
    ok('AI4 parse 丟錯 → 不收，寫是哪個擴充、訊息', !!t7.errors && t7.errors[0].includes('擴充「AI：日期分隔」出錯：第 3 行看不懂'), JSON.stringify(t7));
    check('AI4 parse 自己丟錯：訊息就是線索，不附檔案開頭', t7.excerpt, undefined);
    const t8 = await run4({ check: fake("() => ({ days: [{ date: '2026-02-30', text: 'x' }] })") });
    ok('AI4 拆出來的日期不對 → 不收', !!t8.errors && t8.errors[0].includes('2026-02-30'), JSON.stringify(t8));
    check('AI4 試跑用的暫存程式跑完就刪', tmpAi(), tmpBefore);

    // AI5：沒通過時「複製給 AI」的那段（見 開發筆記 D061）
    // BOM 緊接在第一行前面（trim 會把 BOM 當空白，單獨一行的話有沒有拿掉分不出來）；第 3 行是空行
    const long = String.fromCharCode(0xFEFF) + Array.from({ length: 25 }, (_, i) => (i === 1 ? '\t->內容' : i === 2 ? '' : `第${i}`)).join('\n');
    const ex5 = ai.excerpt(long);
    check('AI5 檔案開頭：BOM 不算、Tab 看得出來、跳過空行（行號照原檔）、最多 20 行', [ex5.length, ex5[0], ex5[1], ex5[2], ex5[19]],
      [20, '第 1 行："第0"', '第 2 行："\\t->內容"', '第 4 行："第3"', '第 21 行："第20"']);
    const fbCheck = ai.buildFeedback({ stage: 'check', errors: ['index.js 第 3 行有「require」：…', 'package.json 的 main 要是 index.js'] });
    ok('AI5 檢查沒通過：寫是檢查沒過、每一條問題、要回完整的兩個檔（兩行分隔線）、例外先問，沒有檔案開頭',
      fbCheck.startsWith('我把你寫的擴充貼進 daybook，檢查沒通過') && fbCheck.includes('\n- index.js 第 3 行有「require」：…\n- package.json 的 main 要是 index.js\n')
      && fbCheck.includes(ai.PKG_MARK) && fbCheck.includes(ai.CODE_MARK) && fbCheck.includes('不要只回改的地方') && fbCheck.includes('先問我，不要猜') && !fbCheck.includes('檔案開頭'), fbCheck);
    const fbRun = ai.buildFeedback({ stage: 'run', errors: ['擴充「X」出錯：第 9 行：…\n第 12 行：…'], excerpt: ex5.slice(0, 2) });
    ok('AI5 試跑沒通過：寫是試跑沒過；一條裡有好幾行的縮排接著；附檔案開頭',
      fbRun.startsWith('我把你寫的擴充貼進 daybook，拿我的整份檔試跑沒通過') && fbRun.includes('\n- 擴充「X」出錯：第 9 行：…\n  第 12 行：…\n')
      && fbRun.includes('我的檔案開頭') && fbRun.includes(ex5[0] + '\n' + ex5[1]), fbRun);
  }
  /* 外觀包（見 開發筆記 D062）：只有圖、一次啟用一個 */
  {
    const skins = require(path.join(ROOT, 'src/main/skins.js'));
    const appV = require(path.join(ROOT, 'package.json')).version;
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');   // 1×1 的 png
    const root = tmpDir();
    const mkSkin = (folder, skin, pkg = {}, files = ['bg.png', 'e.png']) => {
      const d = path.join(root, folder);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: folder, version: '1.0.0', engines: { daybook: '^' + appV }, contributes: { skin }, ...pkg }));
      for (const f of files) fs.writeFileSync(path.join(d, f), PNG);
    };
    mkSkin('a-both', { background: { image: 'bg.png', opacity: 0.3 }, empty: { image: 'e.png' } }, { displayName: '兩種都有' });
    mkSkin('b-bg', { background: { image: 'bg.png' } });
    mkSkin('c-empty', { empty: { image: 'e.png' } });
    mkSkin('d-new', { empty: { image: 'e.png' } }, { engines: { daybook: `^${Number(appV.split('.')[0]) + 1}.0.0` } });
    fs.mkdirSync(path.join(root, 'e-nopkg'));
    mkSkin('f-none', {});
    mkSkin('g-missing', { background: { image: 'nothere.png' } });
    mkSkin('h-outside', { empty: { image: '../a-both/e.png' } });
    mkSkin('i-type', { empty: { image: 'e.bmp' } }, {}, ['e.bmp']);
    mkSkin('j-opacity', { background: { image: 'bg.png', opacity: 2 } });
    mkSkin('k-dup', { empty: { image: 'e.png' } }, { name: 'a-both' });
    mkSkin('l-noimage', { empty: {} });
    mkSkin('m-dir', { empty: { image: 'sub.png' } });
    fs.mkdirSync(path.join(root, 'm-dir', 'sub.png'));
    mkSkin('n-mime', { background: { image: 'B.JPG' }, empty: { image: 'e.svg' } }, {}, ['B.JPG', 'e.svg']);
    fs.writeFileSync(path.join(root, '不是資料夾.txt'), 'x');
    const s0 = skins.scan(root, appV, null);
    const st = (list, folder) => { const x = list.find(e => e.folder === folder); return x ? [x.state, x.reason] : null; };
    check('S1 照資料夾名稱排，檔案不算', s0.map(x => x.folder),
      ['a-both', 'b-bg', 'c-empty', 'd-new', 'e-nopkg', 'f-none', 'g-missing', 'h-outside', 'i-type', 'j-opacity', 'k-dup', 'l-noimage', 'm-dir', 'n-mime']);
    const a = s0[0];
    check('S1 兩種都有：未啟用；名稱、版本、有哪些、圖檔、opacity 照 package.json',
      [a.state, a.reason, a.name, a.displayName, a.version, a.parts, a.background, a.empty],
      ['disabled', '', 'a-both', '兩種都有', '1.0.0', ['背景圖', '空白時的插圖'], { file: path.join(root, 'a-both', 'bg.png'), opacity: 0.3 }, { file: path.join(root, 'a-both', 'e.png') }]);
    check('S1 只有背景圖：opacity 沒寫用預設；只有插圖：沒有背景圖',
      [s0[1].state, s0[1].parts, s0[1].background.opacity, s0[1].empty, s0[2].state, s0[2].parts, s0[2].background],
      ['disabled', ['背景圖'], 0.12, null, 'disabled', ['空白時的插圖'], null]);
    ok('S1 版本不合：寫要哪一版、現在哪一版', st(s0, 'd-new')[0] === 'incompatible' && st(s0, 'd-new')[1].includes(appV), JSON.stringify(st(s0, 'd-new')));
    check('S1 壞掉的：每一種寫原因',
      ['e-nopkg', 'f-none', 'g-missing', 'h-outside', 'i-type', 'j-opacity', 'k-dup', 'l-noimage', 'm-dir'].map(f => st(s0, f)),
      [['broken', '沒有 package.json'], ['broken', 'package.json 的 contributes.skin 沒有 background 也沒有 empty'], ['broken', '找不到圖檔 nothere.png'],
        ['broken', '圖檔要放在外觀包的資料夾裡：../a-both/e.png'], ['broken', '圖檔要是 png、jpg、gif、webp、svg：e.bmp'],
        ['broken', 'contributes.skin.background.opacity 要是 0～1 之間的數字，例如 0.12'], ['broken', 'name 跟資料夾「a-both」的外觀包重複'],
        ['broken', 'contributes.skin.empty.image 要寫圖檔名稱'], ['broken', '找不到圖檔 sub.png']]);
    const s1 = skins.scan(root, appV, 'c-empty');
    check('S1 啟用的那個：只有它是已啟用', s1.filter(x => x.state === 'enabled').map(x => x.folder), ['c-empty']);
    check('S1 啟用的那個壞掉了：照樣是壞掉、沒有已啟用的', skins.scan(root, appV, 'g-missing').filter(x => x.state === 'enabled').length, 0);
    check('S1 資料夾還沒有：空的', skins.scan(path.join(root, '沒有'), appV, null), []);
    const b64 = 'base64,' + PNG.toString('base64');
    check('S2 讀圖：data: 網址、opacity；沒有的那種是 null', [skins.load(a), skins.load(s0[2])],
      [{ background: { url: 'data:image/png;' + b64, opacity: 0.3 }, empty: { url: 'data:image/png;' + b64 } }, { background: null, empty: { url: 'data:image/png;' + b64 } }]);
    const n = skins.load(s0[s0.length - 1]);
    check('S2 照副檔名給類型（大寫也認得）', [n.background.url.slice(0, 22), n.empty.url.slice(0, 26)], ['data:image/jpeg;base64', 'data:image/svg+xml;base64,']);
    // 「外觀」頁上給的範例，照著放圖就是能用的外觀包
    const sp = JSON.parse(skins.sample(appV));
    mkSkin('o-sample', sp.contributes.skin, { name: sp.name, displayName: sp.displayName, engines: sp.engines }, ['background.jpg', 'empty.png']);
    check('S3 頁面上的範例 package.json：engines 是現在的版本、照著放圖就能啟用', [sp.engines.daybook, st(skins.scan(root, appV, null), 'o-sample')], ['^' + appV, ['disabled', '']]);
  }
  ok('I5 日期倒退又沒有年份標記 → 報錯',throws(() => imp.splitDays('12/30\nA\n1/2\nB', { year: 2025 })));
  ok('I5 沒有年份標記也沒給 --year → 報錯', throws(() => imp.splitDays('1/2\nA')));
  ok('I5 同一天出現兩次 → 報錯', throws(() => imp.splitDays('1/2\nA\n1/2\nB', { year: 2026 })));
  ok('I5 不存在的日期 → 報錯', throws(() => imp.splitDays('2/30\nA', { year: 2026 })));
  const leadErr = t => { try { imp.splitDays(t, { year: 2025 }); return null; } catch (e) { return e.message; } };
  ok('I5 日期後面還有字（2/22 (六)、8/5請假）→ 報錯寫第幾行，不併進前一天（D060）',
    ['2/21\nA\n2/22 (六)\nB', '2/21\nA\n8/5請假'].every(t => (leadErr(t) || '').startsWith('第 3 行')), ['2/21\nA\n2/22 (六)\nB', '2/21\nA\n8/5請假'].map(leadErr).join(' | '));
  check('I5 縮排的「11/10借出」是內容，照樣收', imp.splitDays('11/19\n秀屏\n\t11/10借出', { year: 2025 }).map(d => d.lines), [['秀屏', '\t11/10借出']]);
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
  {
    const plan = await impUI.planImport(text, () => false);
    check('R5 畫面上的匯入：真檔拆出來的天數、待辦區行數跟命令列一樣', [plan.write.length, plan.todo ? plan.todo.replace(/\n$/, '').split('\n').length : 0], [days.length, todo.length]);
  }
  {
    /* R7：真檔每一天「加進去」只有一筆光頭標題的日子（見 開發筆記 D063）——拆出來要是那筆＋那天原本的每一筆；再加一次一筆都不加 */
    const head = 'CWIN301020 銷貨單\n';
    const raws = t => { const ls = t.split('\n'); return parseDay(t).map(e => ls.slice(e.start, e.end + 1).join('\n')); };
    const bad = [], again = [];
    let blanks = 0;
    for (const d of days) {
      const t = d.lines.join('\n') + '\n';
      const r = impUI.mergeEntries(head, t, d.date);
      if (!same(raws(r.text), [head.trim(), ...raws(t)])) bad.push(d.date);
      if (r.text.startsWith(head + '\n')) blanks++;
      const r2 = impUI.mergeEntries(r.text, t, d.date);
      if (r2.added || r2.text !== r.text) again.push(d.date);
    }
    ok('R7 真檔每一天加進只有光頭標題的日子：每一筆都跟原本一樣', !bad.length, bad.slice(0, 5).join('、'));
    ok('R7 再加一次一筆都不加', !again.length, again.slice(0, 5).join('、'));
    console.log(`R7 ${days.length} 天加進去，要隔空行的 ${blanks} 天`);
  }

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

  /* R2：真資料的搜尋、時間軸量級（見 開發筆記 D023）——只印時間，筆數跟直接 parse 的算法對 */
  {
    const sources = days.map(d => ({ src: d.date, text: imp.dayText(d) })).concat([{ src: 'todo', text: todo.join('\n') + '\n' }]);
    let t0 = process.hrtime.bigint();
    const idx = srch.buildIndex(sources);
    const msBuild = Number(process.hrtime.bigint() - t0) / 1e6;
    t0 = process.hrtime.bigint();
    const hits = srch.search(idx, '備料');
    const msSearch = Number(process.hrtime.bigint() - t0) / 1e6;
    const tl = srch.timelineByCode(idx, 'CWMM3030');
    const want = sources.reduce((n, s) => n + parseDay(s.text).filter(e => e.codes.some(c => c.toUpperCase() === 'CWMM3030')).length, 0);
    check('R2 CWMM3030 時間軸筆數＝直接 parse 數出來的', tl.length, want);
    ok('R2 搜尋「備料」有結果', hits.length > 0);
    console.log(`R2 ${sources.length} 份建索引 ${msBuild.toFixed(1)}ms；搜尋「備料」${hits.length} 筆 ${msSearch.toFixed(1)}ms；CWMM3030 時間軸 ${tl.length} 筆`);

    /* R3：真資料的自動補完候選（見 開發筆記 D031、D032、D054）——只印數量與時間 */
    t0 = process.hrtime.bigint();
    const sg = srch.suggestions(idx);
    const msSugg = Number(process.hrtime.bigint() - t0) / 1e6;
    ok('R3 CWMM3030 補得出程式名稱', sg.titles.some(x => x.t.startsWith('CWMM3030 ')), JSON.stringify(sg.titles.filter(x => x.t.startsWith('CWMM'))));
    console.log(`R3 自動補完候選：標題 ${sg.titles.length} 個、搜尋字 ${sg.words.length} 個、內文 ${sg.lines.length} 行，${msSugg.toFixed(1)}ms`);

    /* R4：真資料匯出全部（見 開發筆記 D035）——日期、每筆、每行內容都在，沒有多也沒有少 */
    t0 = process.hrtime.bigint();
    const md = exp.toMarkdown({ title: 'T', days: days.map(d => ({ date: d.date, text: imp.dayText(d) })), todo: todo.join('\n') + '\n' });
    const msExp = Number(process.hrtime.bigint() - t0) / 1e6;
    const lines = md.split('\n');
    const all = sources.map(s => parseDay(s.text));
    check('R4 日期標題數＝有內容的日子數', lines.filter(l => l.startsWith('## ') && l !== '## 待處理').length, all.slice(0, -1).filter(es => es.length).length);
    check('R4 小標題數＝標題行數', lines.filter(l => l.startsWith('### ')).length, all.flat().reduce((n, e) => n + e.heads.length, 0));
    check('R4 清單項數＝內容行數', lines.filter(l => /^\s*- /.test(l)).length, all.flat().reduce((n, e) => n + e.body.length, 0));
    console.log(`R4 匯出全部 ${lines.length} 行、${(Buffer.byteLength(md) / 1024).toFixed(0)}KB，${msExp.toFixed(1)}ms`);

    /* R6：真資料匯出全部再匯回（見 開發筆記 D046）——每一天、待處理的卡片都一模一樣 */
    const back = exp.parse(md);
    const withEntries = sources.filter(s => s.src !== 'todo' && parseDay(s.text).length);
    check('R6 匯回的天數＝有內容的日子數', back.days.length, withEntries.length);
    const bad = withEntries.filter(s => { const b = back.days.find(d => d.date === s.src); return !b || !same(cardsOf(b.text), cardsOf(s.text)); });
    ok('R6 每一天匯回後卡片一模一樣', !bad.length, `${bad.length} 天不一樣，第一個：${bad[0] && bad[0].src}`);
    check('R6 待處理匯回後卡片一模一樣', cardsOf(back.todo || ''), cardsOf(sources[sources.length - 1].text));
    console.log(`R6 匯回 ${back.days.length} 天，卡片 ${back.days.reduce((n, d) => n + parseDay(d.text).length, 0)} 張`);
  }
  const ri = process.argv.indexOf('--report');
  if (ri >= 0) {
    fs.writeFileSync(process.argv[ri + 1], `連續標題分組（${new Date().toISOString().slice(0, 10)}，${shared + lastOnly} 組）\n「拿」＝拿到底下那段內容（好幾行都標「拿」就是共用）\n\n` + report.join('\n') + '\n');
    console.log('R1 分組明細寫到 ' + process.argv[ri + 1]);
  }
}

(async () => {
  let code = 0;
  try {
    await run();
    console.log(`\n${pass} 條通過、${fail} 條失敗`);
    code = fail ? 1 : 0;
  } catch (e) {
    console.error('測試自己壞掉：' + (e.stack || e));
    code = 2;
  } finally {
    for (const c of children) c.kill();
    for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  }
  process.exitCode = code;
})();
