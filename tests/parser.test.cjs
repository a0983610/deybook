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

const ROOT = path.resolve(__dirname, '..');
const { headMeta, isBareHead, leadCodeName, parseDay, lineKind, formatEntry, checkCat } = require(path.join(ROOT, 'src/shared/parser.js'));
const ent = require(path.join(ROOT, 'src/shared/entries.js'));
const snip = require(path.join(ROOT, 'src/shared/snippets.js'));
const { dateSegments, fillDates } = require(path.join(ROOT, 'src/renderer/datefill.js'));
const srch = require(path.join(ROOT, 'src/shared/search.js'));
const exp = require(path.join(ROOT, 'src/shared/formats/daybook-md.js'));
const fmts = require(path.join(ROOT, 'src/shared/formats/index.js'));
const { dayPath, TODO_FILE } = require(path.join(ROOT, 'src/shared/paths.js'));
const impUI = require(path.join(ROOT, 'src/shared/import.js'));
/* 卡片上看得到的東西（見 開發筆記 D046）：匯出再匯回，這些要一模一樣 */
const cardsOf = text => parseDay(text).map(e => ({
  heads: e.heads.map(h => h.text), body: e.body.map(b => b.text.replace(/^(\t| {1,4})/, '')), status: e.status, hidden: e.hidden, event: e.event,
}));
const REAL = 'C:\\Users\\cm8\\Downloads\\每日工作紀錄2026.txt';   // 使用者的舊檔，只讀；不在就跳過 R1
// 舊記事本擴充（貼進「格式」頁用的那份，見 開發筆記 D084）：專案裡不留，拿它拆 REAL；不在就跳過 R1
const REAL_EXT = 'C:\\Users\\cm8\\Downloads\\AgentData\\test\\daybook擴充_每日工作紀錄2026.txt';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('✗ ' + name + (detail ? '\n    ' + detail : ''));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, got, want) => ok(name, same(got, want), '得到 ' + JSON.stringify(got) + '，應為 ' + JSON.stringify(want));
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
    // 已處理+未完標籤（見 開發筆記 D091）：一樣拿掉 [隱藏] 和狀態，換成那個分類的標記
    check('C16 給分類：[隱藏] 和狀態換成 [標記:分類]', ent.takeEntry(h1, 1, ent.listEntries(h1)[1].raw, '未完').taken[0], '雅琦問題：發票作廢 [標記:未完]');
    check('C16 給分類：事件編號留著、標記接在後面', ent.takeEntry(h3, 1, ent.listEntries(h3)[1].raw, '未完').taken[0], '雅琦問題：發票作廢 ^7 [標記:未完]');

    // 標記（見 開發筆記 D072）：行尾 [標記]，跟其他標記可以都有、順序不拘，寫回去一律「[隱藏] [標記] [狀態]」
    const fm = headMeta('週報 ^3 [待回覆] [標記] [隱藏]');
    check('C17 行尾三個標記、順序不拘', [fm.title, fm.status, fm.hidden, fm.flagged, fm.event], ['週報', '待回覆', true, true, 3]);
    check('C17 只有標記；沒有標記', [headMeta('週報 [標記]').title, headMeta('週報 [標記]').flagged, headMeta('週報').flagged], ['週報', true, false]);
    check('C17 標題中間的 [標記] 不算', [headMeta('先[標記]再說').flagged, headMeta('先[標記]再說').title], [false, '先[標記]再說']);
    check('C17 卡片 → 行：[標記] 在 [隱藏] 後面、狀態前面', formatEntry({ title: '週報', hidden: true, flagged: true, status: '待回覆', event: 3 }), ['週報 ^3 [隱藏] [標記] [待回覆]']);
    const f1 = ent.setFlagged(day, 1, list[1].raw, true);
    check('C17 標記：只加 [標記]', f1.split('\n')[4], '雅琦問題：發票作廢 [標記]');
    check('C17 其他行一個字都沒變', f1.split('\n').filter((_, i) => i !== 4), day.split('\n').filter((_, i) => i !== 4));
    check('C17 讀得出來', ent.listEntries(f1)[1].flagged, true);
    const f2 = ent.setStatus(f1, 1, ent.listEntries(f1)[1].raw, '待回覆');
    check('C17 標記的改狀態：[標記] 留著、狀態在最後', f2.split('\n')[4], '雅琦問題：發票作廢 [標記] [待回覆]');
    const f3 = ent.setHidden(f2, 1, ent.listEntries(f2)[1].raw, true);
    check('C17 標記的隱藏：[標記] 留著', f3.split('\n')[4], '雅琦問題：發票作廢 [隱藏] [標記] [待回覆]');
    check('C17 隱藏的標記：[隱藏] 留著', ent.setFlagged(h1, 1, ent.listEntries(h1)[1].raw, true).split('\n')[4], '雅琦問題：發票作廢 [隱藏] [標記] [待回覆]');
    check('C17 標記的加事件編號：插在標記前面', ent.setEvent(f1, 1, ent.listEntries(f1)[1].raw, 8).split('\n')[4], '雅琦問題：發票作廢 ^8 [標記]');
    check('C17 編輯卡片帶著標記', ent.editEntry(f1, 1, ent.listEntries(f1)[1].raw, { title: '雅琦問題：發票作廢', body: '->問台應', flagged: true }), f1);
    check('C17 取消標記', ent.setFlagged(f1, 1, ent.listEntries(f1)[1].raw, false), day);
    ok('C17 原文對不上 → Conflict', (() => { try { ent.setFlagged(day, 1, 'x', true); } catch (e) { return e instanceof ent.Conflict; } return false; })());

    // 標記的分類（見 開發筆記 D076）：[標記:分類]，冒號全形半形都認、寫回去半形；沒帶分類的 [標記] 是未分類
    check('C18 讀分類；沒帶是未分類（null）', [headMeta('週報 [標記:等客戶]').flagCat, headMeta('週報 [標記:等客戶]').flagged, headMeta('週報 [標記:等客戶]').title, headMeta('週報 [標記]').flagCat, headMeta('週報').flagCat],
      ['等客戶', true, '週報', null, null]);
    check('C18 全形冒號、頭尾空白也認；冒號後面空的是未分類', [headMeta('週報 [標記：要 測 ]').flagCat, headMeta('週報 [標記:]').flagged, headMeta('週報 [標記:]').flagCat], ['要 測', true, null]);
    const fc = headMeta('週報 ^3 [待回覆] [標記:要測] [隱藏]');
    check('C18 跟其他行尾標記一起、順序不拘', [fc.title, fc.status, fc.hidden, fc.flagCat, fc.event], ['週報', '待回覆', true, '要測', 3]);
    check('C18 標題中間的 [標記:x] 不算', [headMeta('先[標記:等客戶]再說').flagged, headMeta('先[標記:等客戶]再說').title], [false, '先[標記:等客戶]再說']);
    check('C18 卡片 → 行：分類寫在 [標記:…] 裡、位置不變', formatEntry({ title: '週報', hidden: true, flagged: true, flagCat: '等客戶', status: '待回覆', event: 3 }), ['週報 ^3 [隱藏] [標記:等客戶] [待回覆]']);
    check('C18 卡片 → 行：沒標記時分類不寫', formatEntry({ title: '週報', flagged: false, flagCat: '等客戶' }), ['週報']);
    const c1 = ent.setFlagged(day, 1, list[1].raw, true, '等客戶');
    check('C18 標記時選分類：只加 [標記:分類]', c1.split('\n')[4], '雅琦問題：發票作廢 [標記:等客戶]');
    check('C18 其他行一個字都沒變', c1.split('\n').filter((_, i) => i !== 4), day.split('\n').filter((_, i) => i !== 4));
    check('C18 讀得出來', [ent.listEntries(c1)[1].flagged, ent.listEntries(c1)[1].flagCat], [true, '等客戶']);
    check('C18 換分類', ent.setFlagged(c1, 1, ent.listEntries(c1)[1].raw, true, ' 要測 ').split('\n')[4], '雅琦問題：發票作廢 [標記:要測]');
    check('C18 換成未分類', ent.setFlagged(c1, 1, ent.listEntries(c1)[1].raw, true, null).split('\n')[4], '雅琦問題：發票作廢 [標記]');
    check('C18 取消標記：分類一起拿掉', ent.setFlagged(c1, 1, ent.listEntries(c1)[1].raw, false, '等客戶'), day);
    const c2 = ent.setHidden(ent.setStatus(c1, 1, ent.listEntries(c1)[1].raw, '待回覆'), 1, ent.listEntries(ent.setStatus(c1, 1, ent.listEntries(c1)[1].raw, '待回覆'))[1].raw, true);
    check('C18 改狀態、隱藏：分類留著', c2.split('\n')[4], '雅琦問題：發票作廢 [隱藏] [標記:等客戶] [待回覆]');
    check('C18 加事件編號：分類留著', ent.setEvent(c1, 1, ent.listEntries(c1)[1].raw, 8).split('\n')[4], '雅琦問題：發票作廢 ^8 [標記:等客戶]');
    check('C18 編輯卡片帶著分類', ent.editEntry(c1, 1, ent.listEntries(c1)[1].raw, { title: '雅琦問題：發票作廢', body: '->問台應', flagged: true, flagCat: '等客戶' }), c1);
    check('C18 文字模式打的全形冒號：改別的標記時寫回半形', ent.setStatus(day.replace('雅琦問題：發票作廢\n', '雅琦問題：發票作廢 [標記：等客戶]\n'), 1,
      ent.listEntries(day.replace('雅琦問題：發票作廢\n', '雅琦問題：發票作廢 [標記：等客戶]\n'))[1].raw, '待回覆').split('\n')[4], '雅琦問題：發票作廢 [標記:等客戶] [待回覆]');
    check('C18 分類名稱：去掉頭尾空白', checkCat('  等客戶 '), '等客戶');
    ok('C18 分類名稱不行的 → 報錯：空白、方括號、換行、「未分類」「全部」',
      ['', '  ', 'a]b', '[x', 'a\nb', '未分類', '全部', null].every(n => throws(() => checkCat(n))));
    ok('C18 標記時分類名稱不行 → 報錯、不寫', throws(() => ent.setFlagged(day, 1, list[1].raw, true, 'a]b')));
    ok('C18 編輯卡片分類名稱不行 → 報錯', throws(() => formatEntry({ title: '週報', flagged: true, flagCat: '未分類' })));

    const up = ent.appendUpdate(day, 1, list[1].raw, '->台應說是排程');
    check('C10 同一天的更新接在那一筆最後面', up.split('\n').slice(4, 8), ['雅琦問題：發票作廢', '\t->問台應', '\t->台應說是排程', 'CWIN301021 銷退單 先[MF10159]折讓證明日期後[DT10024]單據日期']);
    ok('C10 更新空白 → 報錯', throws(() => ent.appendUpdate(day, 1, list[1].raw, ' -> ')));
  }

  /* ---------- 剪貼簿（見 開發筆記 D093；原本叫暫存，D096） ---------- */
  {
    const text = '週報開頭\n\t各位好，\n\t\n\t本週進度如下：\n\t\t1. 程式\n\n測試帳號 [待回覆] ^3\n\tcm8 / 1234\nCWIN301020 銷貨單\nCWIN301021 銷退單\n\t若登入者…\n';
    const l = snip.listSnips(text);
    check('SN1 標題、內文：內文中間的空行（只有 Tab）留著、更深的縮排留 Tab；行尾 [待回覆] ^3 不拆；連續兩行標題各一筆',
      l.map(s => [s.index, s.title, s.body]),
      [[0, '週報開頭', ['各位好，', '', '本週進度如下：', '\t1. 程式']], [1, '測試帳號 [待回覆] ^3', ['cm8 / 1234']], [2, 'CWIN301020 銷貨單', []], [3, 'CWIN301021 銷退單', ['若登入者…']]]);
    check('SN1 原文：那一筆的行，後面隔開的空行不算', l[0].raw, '週報開頭\n\t各位好，\n\t\n\t本週進度如下：\n\t\t1. 程式');
    check('SN1 外面改的：空白縮排、真的空行夾在內文中間、CRLF、第一個標題前面的內文、行尾空白',
      snip.listSnips('\t沒有標題的\r\nSQL  \r\n    SELECT *\r\n\r\n\r\n\t    WHERE 1=1\r\n\r\n下一筆\r\n\t嗨').map(s => [s.title, s.body]),
      [['', ['沒有標題的']], ['SQL', ['SELECT *', '', '', '    WHERE 1=1']], ['下一筆', ['嗨']]]);
    check('SN1 空的檔、只有空行', [snip.listSnips(''), snip.listSnips('\n\n')], [[], []]);

    check('SN2 一筆 → 行：標題去頭尾空白、換行變空白；內文 CRLF、頭尾空行、結尾空白拿掉，中間的空行寫成 Tab',
      snip.formatSnip({ title: '  週報\r\n開頭 ', body: '\r\n  \n各位好，\r\n\r\n    本週\t\n\n  ' }), ['週報 開頭', '\t各位好，', '\t', '\t    本週']);
    ok('SN2 標題空白、內文空白（只有空白、換行）→ 報錯', [{ title: ' ', body: 'x' }, { title: 'a', body: ' \n\t\n' }, { title: 'a' }, {}].every(s => throws(() => snip.formatSnip(s))));

    check('SN3 新增到空的檔', snip.addSnip('', { title: 'A', body: 'x' }), 'A\n\tx\n');
    check('SN3 新增放最前面，原本的一個字都不變', snip.addSnip(text, { title: '新的', body: 'y' }), '新的\n\ty\n' + text);
    check('SN3 結尾好幾個空行收成一個換行', snip.addSnip('A\n\tx\n\n\n', { title: 'B', body: 'y' }), 'B\n\ty\nA\n\tx\n');
    check('SN3 開頭有沒標題的內文：放在它後面（不然會變成新那筆的內文）', snip.addSnip('\t孤兒\nA\n\tx\n', { title: 'B', body: 'y' }), '\t孤兒\nB\n\ty\nA\n\tx\n');
    const body3 = '  開頭兩個空白\n\t有 Tab\n\n[待回覆] ^3 -> 原樣';
    const back = snip.listSnips(snip.addSnip(text, { title: '原樣', body: body3 }))[0];
    check('SN3 寫進去再讀回來：內文一模一樣（開頭空白、Tab、中間空行、像標記的字）', [back.title, back.body.join('\n')], ['原樣', body3]);

    const e4 = snip.editSnip(text, 1, l[1].raw, { title: '測試帳號', body: 'cm8 / 5678\n第二行' });
    check('SN4 改一筆：只換那幾行', e4, text.replace('測試帳號 [待回覆] ^3\n\tcm8 / 1234\n', '測試帳號\n\tcm8 / 5678\n\t第二行\n'));
    check('SN4 刪一筆：只拿掉那幾行', snip.deleteSnip(text, 0, l[0].raw), text.replace(l[0].raw + '\n', ''));
    check('SN4 刪最後一筆：檔案變空的', snip.deleteSnip('A\n\tx\n', 0, 'A\n\tx'), '');
    ok('SN4 原文對不上、超出筆數 → 丟 Conflict 不寫', [() => snip.editSnip(text, 1, l[0].raw, { title: 'a', body: 'b' }), () => snip.deleteSnip(text, 9, l[0].raw), () => snip.deleteSnip(text, 2, l[3].raw)]
      .every(fn => { try { fn(); return false; } catch (e) { return e instanceof ent.Conflict; } }));
    ok('SN4 改的時候標題空白 → 報錯', throws(() => snip.editSnip(text, 1, l[1].raw, { title: '', body: 'x' })));
  }

  /* ---------- 剪貼簿的日期符號（見 開發筆記 D094） ---------- */
  {
    const now = new Date(2026, 0, 5, 9, 7, 3);   // 2026-01-05 09:07:03：月、日、時是一位數，看得出補不補零
    check('DF1 使用者的例子', fillDates('[{yyyy.MM.dd HH:mm} cm8]', now), '[2026.01.05 09:07 cm8]');
    check('DF1 每個符號：補零、不補零、兩碼年、秒', fillDates('{yyyy yy MM M dd d HH H mm ss}', now), '2026 26 01 1 05 5 09 9 07 03');
    check('DF1 中文、數字、標點照原樣；一行好幾個；好幾行', fillDates('{yyyy年M月d日}（{HH:mm}）\n第2行 {M/d}', now), '2026年1月5日（09:07）\n第2行 1/5');
    const keep = ['{0}', 'string.Format("{0} {1}", a, b)', 'public int Id { get; set; }', '{MMM}', '{yyy}', '{m}', '{s}', '{hh:mm}', '{ddd}', '{}', '{ }', '{yyyy', '{yyyy\nMM}', '{{0}}', '{yyyy.MM.dd x}'];
    check('DF2 不是日期符號的照原樣：數字、程式碼的大括號、不認得的（MMM、yyy、m、s、hh、ddd）、空的、沒關起來、跨行、混別的英文字', keep.map(t => fillDates(t, now)), keep);
    check('DF2 大括號包大括號：裡面那層是符號就換', fillDates('{{yyyy}}', now), '{2026}');
    check('DF3 切段：接起來就是原文，符號那段含大括號', dateSegments('[{yyyy.MM.dd HH:mm} cm8] {0}'),
      [{ text: '[', date: false }, { text: '{yyyy.MM.dd HH:mm}', date: true }, { text: ' cm8] {0}', date: false }]);
    check('DF3 沒有符號是一整段；空字串沒有段', [dateSegments('沒有'), dateSegments('')], [[{ text: '沒有', date: false }], []]);
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
  {
    // 標記清單（見 開發筆記 D072）：行尾有 [標記] 的，舊的在前；帶原文，拿來取消標記對得上
    const text12 = '雅琦問題：發票作廢 ^8 [標記]\n\t->又出現\nCWMM3030 先[標記]再說\n';
    const idx = srch.buildIndex([
      { src: '2026-01-12', text: text12 },
      { src: '2026-01-10', text: 'CWMM3030 備料調撥 [標記]\n\t撥出庫別要檢查\nCWIN301020 銷貨單\n' },
      { src: 'todo', text: '週報\n' },
    ]);
    const fl = srch.flaggedItems(idx);
    check('S6 標記清單：只列行尾有 [標記] 的、舊的在前', fl.map(x => [x.src, x.index, x.title, x.flagged]),
      [['2026-01-10', 0, 'CWMM3030 備料調撥', true], ['2026-01-12', 0, '雅琦問題：發票作廢', true]]);
    check('S6 帶的原文跟 listEntries 一樣（取消標記用）', fl[1].raw, ent.listEntries(text12)[0].raw);
    check('S6 搜尋結果也帶標記', srch.search(idx, '備料').map(x => x.flagged), [true]);
    check('S6 沒有標記的：空的', srch.flaggedItems(srch.buildIndex([{ src: 'todo', text: '週報\n' }])), []);
    // 分類（見 開發筆記 D076）：清單、搜尋結果都帶 flagCat，未分類是 null
    const idx7 = srch.buildIndex([{ src: '2026-01-12', text: '雅琦問題 [標記:等客戶]\nCWMM3030 備料 [標記]\nCWIN301020 銷貨單\n' }]);
    check('S7 標記清單帶分類、未分類是 null', srch.flaggedItems(idx7).map(x => [x.title, x.flagCat]), [['雅琦問題', '等客戶'], ['CWMM3030 備料', null]]);
    check('S7 搜尋結果也帶分類', srch.search(idx7, '雅琦').map(x => x.flagCat), ['等客戶']);
  }
  {
    // 回顧（見 開發筆記 D087）：from～to（含頭尾）每一天的已處理，舊的在前；範圍外、待辦區不算
    const idx = srch.buildIndex([
      { src: '2026-01-19', text: 'CWMM3030 備料調撥 ^7 [標記:等客戶]\n\t->改好了\n雅琦問題\n' },
      { src: '2026-01-12', text: 'CWIN301020 銷貨單\n' },
      { src: '2026-01-25', text: '週日加班\n' },
      { src: '2026-01-26', text: '下週一\n' },
      { src: '2026-01-11', text: '上週日\n' },
      { src: 'todo', text: '週報\n' },
    ]);
    const key = x => x.src + '#' + x.index;
    check('S8 回顧：含頭尾、舊的在前、同一天照順序；範圍外、待辦區不算', srch.rangeItems(idx, '2026-01-12', '2026-01-25').map(key),
      ['2026-01-12#0', '2026-01-19#0', '2026-01-19#1', '2026-01-25#0']);
    check('S8 回顧：起訖同一天', srch.rangeItems(idx, '2026-01-19', '2026-01-19').map(key), ['2026-01-19#0', '2026-01-19#1']);
    check('S8 回顧：每一筆跟搜尋結果一樣（標記分類、事件編號、內容）', srch.rangeItems(idx, '2026-01-19', '2026-01-19')[0], srch.search(idx, '備料')[0]);
    check('S8 回顧：那段沒有紀錄是空的', srch.rangeItems(idx, '2026-01-13', '2026-01-18'), []);
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
    check('F1 內建的匯入格式只有 daybook Markdown（其他都是擴充，D084）', fmts.FORMATS.map(f => f.label), ['daybook Markdown']);
    check('F1 匯出檔認成 daybook Markdown', fmts.pickFormat(md).label, 'daybook Markdown');
    ok('F1 舊記事本沒裝擴充 → 認不出（D084）', (() => { try { fmts.pickFormat('---2026---\n1/5\nA\n'); return false; } catch (e) { return e.unknownFormat === true; } })());
    ok('F1 認不出 → 報錯、列出能匯入的格式', (() => { try { fmts.pickFormat('隨便寫的\n'); return false; } catch (e) { return e.message.includes('daybook Markdown'); } })());
    ok('F1 每個格式都有名稱、說明、副檔名、detect、parse', fmts.FORMATS.every(f => f.label && f.hint && f.extensions.length && typeof f.detect === 'function' && typeof f.parse === 'function'));
  }
  /* 匯出格式拿到的資料（見 開發筆記 D078） */
  {
    const src = {
      title: 'T', from: '2026-01-21', to: '2026-01-23', all: true,
      days: [
        { date: '2026-01-21', text: 'CWIN301021 銷退單 BUG ^3 [標記:等客戶]\n\t參數未勾\n\t\t子項目\n    空白縮排\n雅琦問題：發票作廢 [待回覆]\n\t->問台應\n' },
        { date: '2026-01-22', text: '\n' },
        { date: '2026-01-23', text: 'TX_A\nTX_B\n\t共用內容\n' },
      ],
      todo: '週報 [隱藏] [待回覆]\n',
    };
    const d = fmts.exportData(src);
    check('EX1 title、from、to、all 照給的；沒寫東西的日子不列；每天帶星期、原文', [d.title, d.from, d.to, d.all, d.days.map(x => [x.date, x.weekday, x.text])],
      ['T', '2026-01-21', '2026-01-23', true, [['2026-01-21', '三', src.days[0].text], ['2026-01-23', '五', src.days[2].text]]]);
    const e0 = d.days[0].entries[0];
    check('EX1 每一筆：標題原文、標題（不含行尾標記和 ^編號）、內容（第一層縮排拿掉、更深的留 Tab、空白縮排也拿掉）、標記、分類、事件、代號、類型',
      [e0.heads, e0.title, e0.body, e0.status, e0.hidden, e0.flagged, e0.flagCat, e0.event, e0.codes, e0.types],
      [['CWIN301021 銷退單 BUG ^3 [標記:等客戶]'], 'CWIN301021 銷退單 BUG', ['參數未勾', '\t子項目', '空白縮排'], null, false, true, '等客戶', 3, ['CWIN301021'], ['BUG']]);
    check('EX1 狀態、人名；共用內容的標題是一筆、標題用 \\n 接', [d.days[0].entries[1].status, d.days[0].entries[1].people, d.days[1].entries.map(e => [e.heads, e.title, e.body])],
      ['待回覆', ['雅琦'], [[['TX_A', 'TX_B'], 'TX_A\nTX_B', ['共用內容']]]]);
    check('EX1 待處理：原文和拆好的（隱藏、狀態）', [d.todo.text, d.todo.entries.map(e => [e.title, e.hidden, e.status])], [src.todo, [['週報', true, '待回覆']]]);
    check('EX1 沒給待處理是 null、all 是 false', [fmts.exportData({ ...src, all: undefined, todo: null }).todo, fmts.exportData({ ...src, all: undefined, todo: null }).all], [null, false]);
    ok('EX1 每一筆只有說好的欄位（AI 的 prompt 照這個寫，D079）', d.days.flatMap(x => x.entries).every(e =>
      same(Object.keys(e), ['heads', 'title', 'body', 'status', 'hidden', 'flagged', 'flagCat', 'event', 'codes', 'types', 'people', 'tickets', 'topics'])), JSON.stringify(Object.keys(e0)));

    // X4：Markdown 改走匯出格式的介面，排出來跟原本的 toMarkdown 一字不差
    const md = fmts.EXPORT_FORMATS.find(f => f.id === 'daybook-md');
    check('X4 daybook Markdown 的 write＝toMarkdown（含空的日子、待處理）', md.write(d), exp.toMarkdown(src));
    check('X4 沒有待處理也一樣', md.write(fmts.exportData({ ...src, todo: null })), exp.toMarkdown({ ...src, todo: null }));
    ok('X4 每個匯出格式都有 id、名稱、說明、副檔名（不含「.」）、write', fmts.EXPORT_FORMATS.every(f => f.id && f.label && f.hint && /^[a-z0-9]+$/i.test(f.extension) && typeof f.write === 'function'));
    check('X4 第一個是 daybook Markdown（下拉選單沒選過時的預設）', fmts.EXPORT_FORMATS.map(f => f.id), ['daybook-md', 'xlsx']);

    // XL1：Excel。zip 自己拆（只存不壓縮），CRC 用 node 的 zlib.crc32 驗，不拿 xlsx.js 自己的算法
    const unzip = bytes => {
      const b = Buffer.from(bytes), out = {};
      let at = 0;
      while (b.readUInt32LE(at) === 0x04034b50) {
        const method = b.readUInt16LE(at + 8), crc = b.readUInt32LE(at + 14), size = b.readUInt32LE(at + 18), nl = b.readUInt16LE(at + 26), xl = b.readUInt16LE(at + 28);
        const name = b.toString('utf8', at + 30, at + 30 + nl), data = b.subarray(at + 30 + nl + xl, at + 30 + nl + xl + size);
        out[name] = { method, crcOk: require('zlib').crc32(data) === crc, text: data.toString('utf8') };
        at += 30 + nl + xl + size;
      }
      const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      return { files: out, count: eocd >= 0 ? b.readUInt16LE(eocd + 10) : -1, cdAt: eocd >= 0 ? b.readUInt32LE(eocd + 16) : -1, localEnd: at };
    };
    const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const cells = xml => Object.fromEntries([...xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>/g)].map(m => [m[1], m[2] != null ? Number(m[2]) : unxml(m[3])]));
    const xl = fmts.EXPORT_FORMATS.find(f => f.id === 'xlsx');
    const ctl = fmts.exportData({ ...src, days: [{ date: '2026-01-21', text: '標題 <a> & "b"\n\t控制\u0001字元\n' }], todo: null });
    const z = unzip(xl.write(d));
    const names = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'];
    check('XL1 zip：該有的檔都在、只存不壓縮、CRC 對、中央目錄筆數對、接在最後一個檔後面',
      [Object.keys(z.files).sort(), Object.values(z.files).every(f => f.method === 0 && f.crcOk), z.count, z.cdAt === z.localEnd], [names.slice().sort(), true, 7, true]);
    const c1 = cells(z.files['xl/worksheets/sheet1.xml'].text);
    check('XL1 工作紀錄：第一列欄名', ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1'].map(r => c1[r]), ['日期', '星期', '標題', '內容', '狀態', '標記', '事件', '代號']);
    check('XL1 一筆一列：日期是 Excel 的日期（2026-01-21＝46043）、星期、標題不含行尾標記、內容多行（更深一層兩個空白）、分類、事件編號是數字、代號',
      ['A2', 'B2', 'C2', 'D2', 'E2', 'F2', 'G2', 'H2'].map(r => c1[r]), [46043, '三', 'CWIN301021 銷退單 BUG', '參數未勾\n  子項目\n空白縮排', undefined, '等客戶', 3, 'CWIN301021']);
    check('XL1 狀態；空的日子不列；共用內容的標題放同一格', [c1.E3, c1.A4, c1.C4, c1.D4, c1.A5], ['待回覆', 46045, 'TX_A\nTX_B', '共用內容', undefined]);
    const sh1 = z.files['xl/worksheets/sheet1.xml'].text, sty = z.files['xl/styles.xml'].text;
    ok('XL1 日期那格套日期格式、內容那格自動換行；第一列凍結、可以篩選', sh1.includes('<c r="A2" s="3">') && sty.includes('<xf numFmtId="164"') && sty.includes('formatCode="yyyy-mm-dd"')
      && sh1.includes('<c r="D2" t="inlineStr" s="2">') && sty.includes('<alignment vertical="top" wrapText="1"/>') && sh1.includes('state="frozen"') && sh1.includes('<autoFilter ref="A1:H4"/>'));
    const c2 = cells(z.files['xl/worksheets/sheet2.xml'].text);
    check('XL1 待處理另一張：欄名、隱藏寫「是」、狀態', [['A1', 'B1', 'C1', 'D1'].map(r => c2[r]), c2.A2, c2.C2, c2.D2], [['標題', '內容', '狀態', '隱藏'], '週報', '待回覆', '是']);
    ok('XL1 工作表名稱照順序', /<sheet name="工作紀錄" sheetId="1" r:id="rId1"\/><sheet name="待處理" sheetId="2" r:id="rId2"\/>/.test(z.files['xl/workbook.xml'].text));
    const zc = unzip(xl.write(ctl));
    check('XL1 沒有待處理：只有一張工作表', [Object.keys(zc.files).includes('xl/worksheets/sheet2.xml'), (zc.files['xl/workbook.xml'].text.match(/<sheet /g) || []).length], [false, 1]);
    check('XL1 & < > " 照原字、XML 不能有的控制字元拿掉', [cells(zc.files['xl/worksheets/sheet1.xml'].text).C2, cells(zc.files['xl/worksheets/sheet1.xml'].text).D2], ['標題 <a> & "b"', '控制字元']);
    check('XL1 同樣的紀錄匯出兩次一個 byte 都不差', Buffer.from(xl.write(d)).equals(Buffer.from(xl.write(d))), true);

    // XL2：擴充回 { sheets }，用內建的 Excel 組（見 開發筆記 D086）——欄數不限、名稱有特殊字、一列可以比欄少
    const wide = Array.from({ length: 28 }, (_, i) => ['欄' + (i + 1), 8]);
    const zs = unzip(xl.fromSheets([
      { name: 'A&B "週" 它\'s', columns: wide, rows: [Array.from({ length: 28 }, (_, i) => i), [{ date: '2026-01-21' }, '短的一列', null, '']] },
      { name: '空的', columns: [['x', 5]], rows: [] },
    ]));
    const s1x = zs.files['xl/worksheets/sheet1.xml'].text, cs = cells(s1x), wb = zs.files['xl/workbook.xml'].text;
    check('XL2 28 欄：第 27、28 欄是 AA、AB；欄名、數字、日期、文字；空的格不寫；一列比欄少',
      [cs.Z1, cs.AA1, cs.AB1, cs.A2, cs.AB2, cs.A3, cs.B3, 'C3' in cs, 'D3' in cs, (s1x.match(/<col /g) || []).length], ['欄26', '欄27', '欄28', 0, 27, 46043, '短的一列', false, false, 28]);
    ok('XL2 篩選範圍到 AB、第一列粗體凍結、日期套日期格式', s1x.includes('<autoFilter ref="A1:AB3"/>') && s1x.includes('<c r="AA1" t="inlineStr" s="1">')
      && s1x.includes('state="frozen"') && s1x.includes('<c r="A3" s="3">'), s1x.slice(0, 300));
    ok('XL2 工作表名稱跳脫（& " 照原字、公式裡 \' 寫兩次）、沒有資料的工作表只有欄名',
      wb.includes('<sheet name="A&amp;B &quot;週&quot; 它\'s" sheetId="1"') && wb.includes("'A&amp;B &quot;週&quot; 它''s'!$A$1:$AB$3")
      && wb.includes("'空的'!$A$1:$A$1") && zs.files['xl/worksheets/sheet2.xml'].text.includes('<sheetData><row r="1"><c r="A1"'), wb);
    check('XL2 zip 一樣完整', [Object.values(zs.files).every(f => f.method === 0 && f.crcOk), zs.count], [true, 7]);
    const sh = (over, rows) => [{ name: 'S', columns: [['a', 5], ['b', 5]], rows: rows || [], ...over }];
    for (const [name, sheets, want] of [
      ['不是陣列', { name: 'S' }, 'sheets 要是陣列，至少一張工作表'],
      ['空陣列', [], 'sheets 要是陣列，至少一張工作表'],
      ['名稱有 /', sh({ name: '1/2' }), 'sheets 第 1 張工作表的 name "1/2" 不行'],
      ['名稱超過 31 字', sh({ name: 'x'.repeat(32) }), '要 1～31 個字'],
      ['名稱空的', sh({ name: '' }), 'sheets 第 1 張工作表的 name "" 不行'],
      ['名稱頭是 \'', sh({ name: "'S" }), "頭尾不能是 '"],
      ['名稱重複（大小寫不同）', [...sh({ name: 'Ab' }), ...sh({ name: 'aB' })], 'sheets 第 2 張工作表的 name「aB」跟前面重複'],
      ['沒有欄', sh({ columns: [] }), '工作表「S」的 columns 要是 [[欄名, 欄寬], …]'],
      ['欄寬不是數字', sh({ columns: [['a', '5']] }), '工作表「S」的 columns 要是'],
      ['欄寬 0', sh({ columns: [['a', 0]] }), '工作表「S」的 columns 要是'],
      ['rows 不是陣列', sh({ rows: 'x' }), '工作表「S」的 rows 要是陣列'],
      ['一列太多格', sh({}, [['1', '2', '3']]), '工作表「S」rows 的第 1 列要是陣列，最多 2 格'],
      ['一格是 true', sh({}, [['1'], [true]]), '工作表「S」rows 的第 2 列第 1 格是 true'],
      ['一格是 NaN', sh({}, [['1', NaN]]), '第 1 列第 2 格是 NaN'],
      ['一格是 {}', sh({}, [[{}]]), '第 1 列第 1 格是 {}'],
      ['不存在的日期', sh({}, [[{ date: '2026-02-30' }]]), '第 1 列第 1 格是 {"date":"2026-02-30"}'],
      ['一格是陣列', sh({}, [[['a']]]), '第 1 列第 1 格是 ["a"]'],
    ]) {
      let m = null;
      try { xl.fromSheets(sheets); } catch (e) { m = e.message; }
      ok('XL2 ' + name + ' → 丟錯', !!m && m.includes(want), m);
    }
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

  /* ---------- 視窗大小、位置、最大化（見 開發筆記 D082）：記的位置看不到就照預設 ---------- */
  {
    const { restore } = require(path.join(ROOT, 'src/main/window-state.js'));
    const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: -200, width: 1280, height: 984 }];   // 主螢幕＋右邊一個比較高的
    const b = { x: 100, y: 80, width: 1000, height: 700 };
    const at = (x, y) => restore({ x, y, width: 1000, height: 700 }, areas).bounds;
    check('W1 在主螢幕：照記的開', restore({ ...b, maximized: false }, areas), { bounds: b, maximized: false });
    check('W1 最大化：照記的大小位置開、要放大', restore({ ...b, maximized: true }, areas), { bounds: b, maximized: true });
    check('W1 在第二個螢幕（y 是負的）：照記的開', at(2000, -150), { x: 2000, y: -150, width: 1000, height: 700 });
    check('W1 那個螢幕拔掉了：照預設；最大化照記的', restore({ x: 3500, y: 100, width: 800, height: 600, maximized: true }, areas), { bounds: null, maximized: true });
    check('W1 大半在左邊外面、標題列還露 100 寬：照記的；露 99 寬：照預設', [!!at(-900, 80), at(-901, 80)], [true, null]);
    check('W1 貼齊上緣（邊框算進去，y 是 -7）：照記的', !!at(-7, -7), true);
    check('W1 標題列露一半在螢幕底下：照記的；不到一半：照預設', [!!at(100, 1025), at(100, 1026)], [true, null]);
    check('W1 標題列在螢幕上面外面：照預設', at(100, -300), null);
    check('W1 沒記過、不是物件、少欄位、不是數字、寬是 0：照預設、不放大',
      [undefined, 'x', { x: 1, y: 1, width: 500 }, { x: '1', y: 1, width: 500, height: 400 }, { x: 1, y: 1, width: 0, height: 400, maximized: 'true' }].map(s => restore(s, areas)),
      Array(5).fill({ bounds: null, maximized: false }));
  }

  /* ---------- 匯入層 ---------- */
  /* 畫面上的匯入要寫哪些（見 開發筆記 D044）：內建只剩 daybook Markdown（D084），用它測；擴充見 M2 */
  {
    const none = () => false;
    const md = exp.toMarkdown({ title: 'T', days: [{ date: '2026-01-05', text: 'A ^2\n\tx\n' }, { date: '2026-01-06', text: 'B\n' }], todo: '週報\n' });
    const p0 = await impUI.planImport('﻿' + md, none);
    check('M1 開頭的 BOM 不算內容：認成 daybook Markdown、每天和待處理都拆出來', [p0.format, p0.write.map(d => d.date), p0.todo, p0.todoExisting],
      ['daybook Markdown', ['2026-01-05', '2026-01-06'], '週報\n', false]);
    const p4 = await impUI.planImport('﻿' + md, rel => rel === dayPath('2026-01-05') || rel === TODO_FILE);
    check('M1 資料夾裡已經有的日子分出來（加進去還是略過由畫面問，D063）、待辦.md 已經有內容標出來，待處理照樣拆出來（加進去要用）',
      [p4.format, p4.write, p4.existing.map(d => d.date), p4.todo, p4.todoExisting],
      ['daybook Markdown', [{ date: '2026-01-06', text: 'B\n' }], ['2026-01-05'], '週報\n', true]);
    const p3 = await impUI.planImport(exp.toMarkdown({ title: 'T', days: [{ date: '2026-01-05', text: 'A\n' }], todo: '' }), rel => rel === TODO_FILE);
    check('M1 沒有待處理：待辦.md 有內容也不標', [p3.todo, p3.todoExisting], [null, false]);
    ok('M1 認不出格式 → 報錯', !!(await rejects(() => impUI.planImport('隨便寫的\n', none))));
  }
  /* 「加進去」：一筆一筆比，一模一樣的不再加（見 開發筆記 D063） */
  {
    const merge = impUI.mergeEntries;
    // 匯入的那天拆成 4 筆，第 3 筆是 TX_Cancel… 標題＋內容（第 3、4 行）；資料夾裡那天也有一模一樣的這筆
    const s15 = ['WBW6121 進項發票建立作業 進貨單彙總頁面，當進貨單是現金進貨、或有付款過、或有產生傳票時，將「本次開發票金額」「本次開發票稅額」灰階。',
      '更新26.02.SP2的WebPosBridge', 'TX_CancelEInvMailNotice TX_CancelSalesR_AMailNotice', '\t給中繼的參數調整 測試應該正常', 'Q1研發設計師職能測驗'];
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
    const exPkg = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'package.json'), 'utf8'));   // 範例的版本、格式照它的 package.json
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
    // 匯出格式（D078）：副檔名帶「.」、只有匯出、匯出的 id 重複
    mkExt('k-badout', { contributes: { exportFormats: [{ id: 'f', label: 'x', hint: 'h', extension: '.csv' }] } });
    mkExt('l-outonly', { contributes: { exportFormats: [{ id: 'f', label: '只匯出', hint: 'h', extension: 'csv' }] } });
    mkExt('m-outdup', { contributes: { exportFormats: [{ id: 'f', label: 'x', hint: 'h', extension: 'csv' }, { id: 'f', label: 'y', hint: 'h', extension: 'txt' }] } });
    fs.writeFileSync(path.join(root, '不是資料夾.txt'), 'x');
    const s0 = extMod.scan(root, appV, {});
    const st = (list, folder) => { const x = list.find(e => e.folder === folder); return x ? [x.state, x.reason] : null; };
    check('K2 照資料夾名稱排，檔案不算', s0.map(x => x.folder),
      ['a-example', 'b-new', 'c-badjson', 'd-nopkg', 'e-nofile', 'f-dup', 'g-noformats', 'h-range', 'i-bom', 'j-badfmt', 'k-badout', 'l-outonly', 'm-outdup']);
    const ex = s0[0];
    check('K2 範例：未啟用；名稱、版本、匯入和匯出格式、程式檔照 package.json',
      [ex.state, ex.reason, ex.name, ex.displayName, ex.version, ex.formats, ex.exportFormats, ex.file],
      ['disabled', '', 'daybook-example-dated', '範例：日期分隔純文字', exPkg.version,
        [{ id: 'dated-txt', label: '日期分隔純文字', hint: '一行 === 2026-10-27 === 隔開每一天', extensions: ['txt'] }],
        [{ id: 'dated-txt', label: '日期分隔純文字', hint: '一行 === 2026-10-27 === 隔開每一天，可以再匯回來', extension: 'txt' }], path.join(root, 'a-example', 'index.js')]);
    ok('K2 版本不合：寫要哪一版、現在哪一版', st(s0, 'b-new')[0] === 'incompatible' && st(s0, 'b-new')[1].includes(appV), JSON.stringify(st(s0, 'b-new')));
    check('K2 壞掉的：每一種寫原因',
      ['c-badjson', 'd-nopkg', 'e-nofile', 'f-dup', 'g-noformats', 'h-range', 'j-badfmt', 'k-badout', 'm-outdup'].map(f => st(s0, f)),
      [['broken', 'package.json 不是正確的 JSON'], ['broken', '沒有 package.json'], ['broken', '找不到程式檔 index.js'],
        ['broken', 'name 跟資料夾「a-example」的擴充重複'], ['broken', 'package.json 的 contributes 沒有列格式：要有 importFormats（匯入）或 exportFormats（匯出）'],
        ['broken', 'package.json 的 engines.daybook 要寫成 ^版本號，例如 ^1.10.0'], ['broken', 'contributes.importFormats 每一種格式都要有 id、label、hint、extensions'],
        ['broken', 'contributes.exportFormats 每一種格式都要有 id、label、hint、extension（副檔名，只寫英文、數字，不含「.」）'], ['broken', 'contributes.exportFormats 的 id 重複']]);
    check('K2 package.json 開頭有 BOM 也讀得到', st(s0, 'i-bom'), ['disabled', '']);
    const lo = s0.find(x => x.folder === 'l-outonly');
    check('K2 只有匯出格式也是好的擴充：未啟用、沒有匯入格式', [lo.state, lo.formats, lo.exportFormats], ['disabled', [], [{ id: 'f', label: '只匯出', hint: 'h', extension: 'csv' }]]);
    const s1 = extMod.scan(root, appV, { 'daybook-example-dated': exPkg.version });
    check('K2 啟用過、版本一樣：已啟用', st(s1, 'a-example'), ['enabled', '']);
    const s2 = extMod.scan(root, appV, { 'daybook-example-dated': '0.9.0' });
    check('K2 改版了：變回未啟用、寫要再啟用一次', st(s2, 'a-example'), ['disabled', '改版了（啟用的是 0.9.0），要再啟用一次']);
    check('K2 資料夾還沒有：空的', extMod.scan(path.join(root, '沒有'), appV, {}), []);
    check('K2 enabledFormats：只列已啟用的，帶擴充名稱、程式檔', extMod.enabledFormats(s1).map(f => [f.id, f.label, f.ext, f.file]),
      [['dated-txt', '日期分隔純文字', '範例：日期分隔純文字', path.join(root, 'a-example', 'index.js')]]);
    const s3 = extMod.scan(root, appV, { 'daybook-example-dated': exPkg.version, 'l-outonly': '1.0.0' });
    check('K2 enabledExportFormats：只列已啟用的匯出格式，key 是「擴充名稱/格式 id」；只有匯出的不進匯入的清單（D078）',
      [extMod.enabledExportFormats(s3).map(f => [f.key, f.id, f.label, f.extension, f.ext, f.file]), extMod.enabledFormats(s3).map(f => f.ext)],
      [[['daybook-example-dated/dated-txt', 'dated-txt', '日期分隔純文字', 'txt', '範例：日期分隔純文字', path.join(root, 'a-example', 'index.js')],
        ['l-outonly/f', 'f', '只匯出', 'csv', 'l-outonly', path.join(root, 'l-outonly', 'index.js')]], ['範例：日期分隔純文字']]);
    check('K2 enabledExportFormats：都沒啟用是空的', extMod.enabledExportFormats(s0), []);

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
      unk && unk.unknownFormat === true && unk.message.includes('日期分隔純文字（擴充「範例」，H）') && unk.message.includes('daybook Markdown'), unk && unk.message);
    const mdT = '# T\n## 2026-01-05\n### A\n';
    const both = msg(() => fmts.pickFormat(mdT, [{ ...e1, hit: true }]));
    ok('F2 內建和擴充都認得：報錯不猜，寫是哪個擴充、可以到「格式」頁停用（D078 改名）', both.includes('分不出') && both.includes('「日期分隔純文字」（擴充「範例」）')
      && both.includes('齒輪「設定」的「格式」停用擴充') && !both.includes('說明'), both);   // 「格式」搬進齒輪「設定」（D092）
    const bothE = (() => { try { fmts.pickFormat(mdT, [{ ...e1, hit: true }]); return null; } catch (e) { return e; } })();
    check('F2 兩種以上都認得：錯誤帶認得的那幾種（畫面上的匯入拿來問用哪一種，D058）', bothE && bothE.candidates.map(f => f.label), ['daybook Markdown', '日期分隔純文字']);

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

    // K5：擴充程序的匯出（write，D078）——文字照回、位元組轉回 Buffer、回錯的東西報錯
    const outFmt = (ext, code) => ({ ...fmt(ext, code), extension: 'txt' });
    const echo = outFmt('回資料', 'module.exports = { formats: { f: { write: d => JSON.stringify(d) } } };');
    const u8 = outFmt('回位元組', 'module.exports = { formats: { f: { write: () => new Uint8Array([0, 255, 80, 75]) } } };');
    const ab = outFmt('回 ArrayBuffer', 'module.exports = { formats: { f: { write: () => new Uint8Array([1, 2, 3]).buffer } } };');
    const kData = { title: 'T', days: [{ date: '2026-01-05', entries: [] }], todo: null };
    h = extMod.startHost(forkHost, [echo], 5000);
    check('K5 write 拿到的就是主程序給的資料、回的文字照傳', await h.write(echo, kData), JSON.stringify(kData));
    h.kill();
    h = extMod.startHost(forkHost, [u8, ab], 5000);
    const bu = await h.write(u8, kData), ba = await h.write(ab, kData);
    h.kill();
    check('K5 回 Uint8Array、ArrayBuffer：拿到一樣的位元組（Buffer）', [Buffer.isBuffer(bu), [...bu], Buffer.isBuffer(ba), [...ba]], [true, [0, 255, 80, 75], true, [1, 2, 3]]);
    // 回 { sheets }：擴充程序用內建的 Excel 組成 xlsx（D086），跟主程序直接組的一個 byte 都不差
    const kSheets = [{ name: '紀錄', columns: [['日期', 11], ['標題', 30]], rows: [[{ date: '2026-01-05' }, 'T']] }];
    const sx = outFmt('回表格', `module.exports = { formats: { f: { write: () => ({ sheets: ${JSON.stringify(kSheets)} }) } } };`);
    h = extMod.startHost(forkHost, [sx], 5000);
    const bx = await h.write(sx, kData);
    h.kill();
    check('K5 回 { sheets }：拿到內建 Excel 組的 xlsx（Buffer）', [Buffer.isBuffer(bx), bx.equals(Buffer.from(fmts.EXPORT_FORMATS.find(f => f.id === 'xlsx').fromSheets(kSheets)))], [true, true]);
    for (const [name, f, want] of [
      ['回數字', outFmt('回數字', 'module.exports = { formats: { f: { write: () => 5 } } };'), '擴充「回數字」出錯：write 要回文字（字串）、Uint8Array 或 { sheets }（Excel），回的是 number'],
      ['回 null', outFmt('回空', 'module.exports = { formats: { f: { write: () => null } } };'), '擴充「回空」出錯：write 要回文字（字串）、Uint8Array 或 { sheets }（Excel），回的是 null'],
      ['回的 sheets 不對', outFmt('表格不對', "module.exports = { formats: { f: { write: () => ({ sheets: [{ name: 'a', columns: [['x', 5]], rows: [[true]] }] }) } } };"),
        '擴充「表格不對」出錯：sheets 工作表「a」rows 的第 1 列第 1 格是 true：一格只能是文字、數字、{ date: "YYYY-MM-DD" }（要是真的日期）、null 或 ""'],
      ['沒給 write', outFmt('沒給', 'module.exports = { formats: { f: { detect: () => true, parse: () => null } } };'), '擴充「沒給」出錯：程式檔沒有給格式「f」的 write'],
      ['write 丟錯', outFmt('丟錯', "module.exports = { formats: { f: { write: () => { throw new Error('欄位不對'); } } } };"), '擴充「丟錯」出錯：欄位不對'],
    ]) {
      h = extMod.startHost(forkHost, [f], 5000);
      const m = await rejects(() => h.write(f, kData));
      h.kill();
      check('K5 ' + name + '：報錯、寫是哪個擴充', m, want);
    }
    const slowOut = outFmt('匯出卡住', 'module.exports = { formats: { f: { write: () => { for (;;) {} } } } };');
    h = extMod.startHost(forkHost, [slowOut], 800);
    check('K5 匯出卡住：超過時間就停掉', await rejects(() => h.write(slowOut, kData)), '擴充「匯出卡住」跑太久（超過 0.8 秒），已經停掉');

    // M5：範例的匯出（真的開擴充程序）：匯出再用範例自己的 parse 匯回，每天、待處理的原文一樣
    const exOut = extMod.enabledExportFormats(s1)[0];
    const exData = fmts.exportData({ title: 'T', from: '2026-03-02', to: '2026-03-03', all: true,
      days: [{ date: '2026-03-02', text: 'A\n\tx\n\t\ty\n' }, { date: '2026-03-03', text: 'B [待回覆]\nC\n\t->z\n' }], todo: '週報\n\t->10/28 還沒\n' });
    h = extMod.startHost(forkHost, [exOut], 5000);
    const exTxt = await h.write(exOut, exData);
    h.kill();
    const exBack = require(path.join(EXAMPLE, 'index.js')).formats['dated-txt'].parse(exTxt);
    check('M5 範例匯出再匯回：每天、待處理的原文一樣', exBack, { days: exData.days.map(x => ({ date: x.date, text: x.text })), todo: exData.todo.text });
    check('M5 範例匯出的開頭是「=== 日期 ===」', exTxt.split('\n')[0], '=== 2026-03-02 ===');

    // M2：畫面上的匯入加上擴充——真的開擴充程序跑範例
    const exFormats = extMod.enabledFormats(s1);
    const sampleTxt = fs.readFileSync(path.join(EXAMPLE, 'sample.txt'), 'utf8');
    const want = require(path.join(EXAMPLE, 'index.js')).formats['dated-txt'].parse(sampleTxt);
    ok('M2 前提：範例拆出來至少兩天、有待處理', want.days.length >= 2 && !!want.todo, JSON.stringify(want));
    h = extMod.startHost(forkHost, exFormats, 5000);
    const pe = await impUI.planImport(sampleTxt, rel => rel === dayPath(want.days[1].date), h);
    h.kill();
    check('M2 範例擴充：認成它的格式，名稱帶擴充', pe.format, '日期分隔純文字，擴充「範例：日期分隔純文字」');
    check('M2 範例擴充：照它拆的寫、已經有的日子分出來', [pe.write, pe.existing.map(d => d.date), pe.todo],
      [want.days.filter((_, i) => i !== 1), [want.days[1].date], want.todo]);
    h = extMod.startHost(forkHost, exFormats, 5000);
    check('M2 有啟用擴充時，內建格式照樣認得', (await impUI.planImport('# T\n## 2026-01-05\n### A\n', none, h)).format, 'daybook Markdown');
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
    const mustSay = [ai.PKG_MARK, ai.CODE_MARK, `"daybook": "^${appV}"`, '「# 」', ...ai.BANNED,
      '可以改結構，不能改內容', '先問我、我同意了才做', '「數字.」開頭的行', '問我從哪一年開始', '「12 月之後接 1 月」算跨年', '第 N 行：那行原文', '會問我這次要用哪一種'];
    ok('AI1 prompt：寫了兩行分隔線、engines 是現在的版本、內建格式怎麼分、每個禁用的字；轉換、年份、認不得的行、撞格式會問（D059）', mustSay.every(s => prompt.includes(s)),
      '少了：' + mustSay.filter(s => !prompt.includes(s)).join('、'));
    ok('AI1 prompt 不再提舊記事本（D084 改成擴充）', !prompt.includes('舊記事本') && !prompt.includes('週報'));
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
      ['少欄位', reply({ ...aiPkg, contributes: null }), 'contributes 要有 importFormats'],
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
    const t1 = await run4({ exists: rel => rel === dayPath(want.days[0].date) });
    const dates = want.days.map(d => d.date).sort();
    check('AI4 試跑範例的 sample.txt：裝到 name 的資料夾；天數、起訖、已經有幾天、待處理幾行、前幾天跟範例拆的一樣',
      t1.errors || [t1.folder, t1.preview.days, t1.preview.first, t1.preview.last, t1.preview.existing, t1.preview.todoLines, t1.preview.replaces, t1.preview.samples.map(s => s.date + '\n' + s.text + '\n')],
      ['ai-dated', want.days.length, dates[0], dates[dates.length - 1], 1, want.todo.replace(/\n$/, '').split('\n').length, null, want.days.slice(0, 3).map(d => d.date + '\n' + d.text)]);
    check('AI4 沒有別的格式認得：預覽不寫誰也認得', t1.preview && t1.preview.also, []);
    const t2 = await run4({ list: s1 });
    check('AI4 已啟用的範例也認得這個檔：試跑用 AI 寫的、照樣過，預覽寫範例也認得（匯入時會問，D058）',
      t2.errors || [t2.preview.days, t2.preview.also], [want.days.length, ['「日期分隔純文字」（擴充「範例：日期分隔純文字」）']]);
    const t3 = await run4({ check: ai.checkReply(reply({ ...aiPkg, name: 'daybook-example-dated' }), appV), list: s1 });
    check('AI4 跟已裝的同名：舊的不參加認格式、取代它、裝回它的資料夾', t3.errors || [t3.folder, t3.preview.replaces], ['a-example', { displayName: '範例：日期分隔純文字', version: exPkg.version }]);
    fs.mkdirSync(path.join(aiRoot, 'ai-dated'));
    const t4 = await run4({});
    fs.rmSync(path.join(aiRoot, 'ai-dated'), { recursive: true });
    ok('AI4 擴充資料夾已經有同名的資料夾（不是擴充）→ 不收', !!t4.errors && t4.errors[0].includes('「ai-dated」這個資料夾'), JSON.stringify(t4));
    const t5 = await run4({ text: mdT });
    ok('AI4 這個檔被認成 daybook Markdown → 不收', !!t5.errors && t5.errors[0].includes('被認成「daybook Markdown」'), JSON.stringify(t5));
    check('AI4 detect 不認得：附檔案開頭有字的行（行號＋原文）給 AI 看（D061）', t5.excerpt, ['第 1 行："# T"', '第 2 行："## 2026-01-05"', '第 3 行："### A"']);
    const t5c = await run4({ text: '隨便寫的\n' });
    check('AI4 沒有一種格式認得 → 不收，直接說 AI 的 detect 要認得，附檔案開頭（D061）', [t5c.errors, t5c.excerpt],
      [['AI 寫的 detect 不認得這個檔（別的格式也都不認得）：要認得這個檔'], ['第 1 行："隨便寫的"']]);
    const t5d = await run4({ text: '# T\n## 2026-01-05\n亂寫的一行\n' });
    ok('AI4 AI 寫的不認得、daybook Markdown 認得但拆不了（第 3 行認不得）→ 報 AI 的 detect 不認得，不拿 daybook Markdown 去拆（D061）',
      !!t5d.errors && t5d.errors[0].includes('被認成「daybook Markdown」') && !t5d.errors[0].includes('第 3 行') && !!t5d.excerpt, JSON.stringify(t5d));
    // 別的格式認得兩種：內建的 daybook Markdown＋一個什麼都認的擴充（已啟用）
    const yes = fmt('全都認', 'module.exports = { formats: { f: { detect: () => true, parse: () => ({ days: [], todo: null }) } } };');
    const yesExt = { name: 'all-yes', state: 'enabled', displayName: '全都認', file: yes.file, formats: [{ id: 'f', label: '全都認', hint: 'h', extensions: ['txt'] }] };
    const t5b = await run4({ text: mdT, list: [yesExt] });
    ok('AI4 別的兩種都認得、AI 寫的不認得 → 不收，寫被認成哪兩種', !!t5b.errors && t5b.errors[0].includes('被認成「daybook Markdown」和「全都認」'), JSON.stringify(t5b));
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
    const fbOut = ai.buildFeedback({ kind: 'export', stage: 'run', errors: ['擴充「X」出錯：write 要回文字'] });
    ok('AI5 匯出格式試跑沒通過：寫是拿我的紀錄試跑匯出（D079）、沒有檔案開頭', fbOut.startsWith('我把你寫的擴充貼進 daybook，拿我的紀錄試跑匯出沒通過')
      && fbOut.includes('\n- 擴充「X」出錯：write 要回文字\n') && !fbOut.includes('檔案開頭'), fbOut);

    // AI6：請 AI 寫匯出格式（見 開發筆記 D079）——prompt、一次只寫一種
    const outPrompt = ai.buildExportPrompt(appV);
    const mustSay6 = [ai.PKG_MARK, ai.CODE_MARK, `"daybook": "^${appV}"`, '"exportFormats"', '"extension"', 'write(data)', 'Uint8Array', '"\\uFEFF"', '.xlsx', ...ai.BANNED,
      // 要 Excel 回 { sheets }（D086）
      '{ sheets: [...] }', 'extension 寫 xlsx', '{ date: "YYYY-MM-DD" }', '不能有 \\ / ? * [ ] :',
      '"weekday"', '"entries"', '"heads"', '"body"', '"flagCat"', '"event"', '"codes"', '"todo"', '先問我、我同意了才做', '不要摘要、改字、調順序', '【我要的檔案長怎樣】',
      // 拿 subagent 扮外部 AI 實測後補的（D079）：沒標題的那筆、CSV 給 Excel 開時「->」不用處理
      'heads 是 []、title 是空字串', '「->」開頭的照字顯示'];
    ok('AI6 匯出的 prompt：分隔線、engines、exportFormats、write 回字串或 Uint8Array、CSV 的 BOM、Excel 回 { sheets }、禁用的字、data 每個欄位、取捨先問、沒標題的那筆、「->」不用處理', mustSay6.every(s => outPrompt.includes(s)),
      '少了：' + mustSay6.filter(s => !outPrompt.includes(s)).join('、'));
    const sampleJson = outPrompt.slice(outPrompt.indexOf('{\n  "title"'), outPrompt.indexOf('\n- title：'));
    const sj = JSON.parse(sampleJson);
    ok('AI6 prompt 裡的 data 例子就是 exportData 排出來的（欄位改了 prompt 跟著變）', same(sj, fmts.exportData({ title: sj.title, from: sj.from, to: sj.to, all: sj.all,
      days: sj.days.map(x => ({ date: x.date, text: x.text })), todo: sj.todo.text })) && sj.days.length === 2 && !!sj.todo, sampleJson.slice(0, 200));
    const outPkg = { ...exPkg, name: 'ai-out', displayName: 'AI：匯出', contributes: { exportFormats: [{ ...exPkg.contributes.exportFormats[0], label: 'AI 匯出' }] } };
    const outGood = ai.checkReply(reply(outPkg), appV, 'export');
    check('AI6 匯出格式（範例改名、只列 exportFormats）：檢查沒有錯', [outGood.errors, outGood.manifest && outGood.manifest.exportFormats.map(f => f.label)], [[], ['AI 匯出']]);
    for (const [name, r, kind, want6] of [
      ['寫匯入卻只列 exportFormats', reply(outPkg), 'import', '這次要寫的是匯入格式：package.json 的 contributes 要有 importFormats'],
      ['寫匯出卻只列 importFormats', reply(aiPkg), 'export', '這次要寫的是匯出格式：package.json 的 contributes 要有 exportFormats'],
      ['寫匯出卻兩種都列', reply({ ...outPkg, contributes: { ...outPkg.contributes, importFormats: aiPkg.contributes.importFormats } }), 'export', '這次要寫的是匯出格式：package.json 的 contributes 不要有 importFormats'],
      ['副檔名帶「.」', reply({ ...outPkg, contributes: { exportFormats: [{ ...outPkg.contributes.exportFormats[0], extension: '.csv' }] } }), 'export', '不含「.」'],
    ]) {
      const c = ai.checkReply(r, appV, kind);
      ok('AI6 ' + name + ' → 不收', c.errors.some(m => m.includes(want6)) && c.pkg === null, JSON.stringify(c.errors));
    }

    // AI7：匯出格式試跑——真的開擴充程序，拿 exportData 的資料跑 write
    const tmpBefore7 = tmpAi();
    const out7 = (body, over) => ai.tryExport({ check: ai.checkReply(reply(outPkg, `module.exports = { formats: { 'dated-txt': { write: ${body} } } };\n`), appV, 'export'),
      data: exData, list: [], extRoot: aiRoot, fork: forkHost, timeoutMs: 5000, ...over });
    const o1 = await ai.tryExport({ check: outGood, data: exData, list: [], extRoot: aiRoot, fork: forkHost, timeoutMs: 5000 });
    const lines7 = exTxt.replace(/\n$/, '').split('\n');
    check('AI7 試跑範例的匯出：裝到 name 的資料夾；結果跟範例自己寫的一樣；預覽寫幾天、有待處理、文字幾行、大小、開頭',
      o1.errors || [o1.folder, o1.outputs, o1.preview.kind, o1.preview.days, o1.preview.todo, o1.preview.replaces,
        o1.preview.outputs.map(o => [o.label, o.extension, o.text, o.lines, o.size, o.head, o.more])],
      ['ai-out', [exTxt], 'export', 2, true, null, [['AI 匯出', 'txt', true, lines7.length, Buffer.byteLength(exTxt), lines7.slice(0, 30).join('\n'), 0]]]);
    const o2 = await out7('() => new Uint8Array([80, 75, 3, 4])');
    check('AI7 回位元組：預覽寫是二進位檔、大小；結果是那幾個 byte', o2.errors || [o2.preview.outputs[0].text, o2.preview.outputs[0].size, [...o2.outputs[0]]], [false, 4, [80, 75, 3, 4]]);
    const sheets7 = [{ name: '紀錄', columns: [['日期', 11]], rows: [[{ date: '2026-03-02' }]] }];
    const o6 = await out7(`() => ({ sheets: ${JSON.stringify(sheets7)} })`);
    const want6 = Buffer.from(fmts.EXPORT_FORMATS.find(f => f.id === 'xlsx').fromSheets(sheets7));
    check('AI7 回 { sheets }（D086）：預覽寫是二進位檔、大小；結果是內建 Excel 組的', o6.errors || [o6.preview.outputs[0].text, o6.preview.outputs[0].size, o6.outputs[0].equals(want6)], [false, want6.length, true]);
    const o3 = await out7('() => Array.from({ length: 40 }, (_, i) => "第" + i).join("\\n") + "\\n"');
    check('AI7 文字很長：預覽只列開頭 30 行、寫還有幾行', o3.errors || [o3.preview.outputs[0].lines, o3.preview.outputs[0].head.split('\n').length, o3.preview.outputs[0].more], [40, 30, 10]);
    const o4 = await ai.tryExport({ check: ai.checkReply(reply({ ...outPkg, name: 'daybook-example-dated' }), appV, 'export'), data: exData, list: s1, extRoot: aiRoot, fork: forkHost, timeoutMs: 5000 });
    check('AI7 跟已裝的同名：取代它、裝回它的資料夾', o4.errors || [o4.folder, o4.preview.replaces], ['a-example', { displayName: '範例：日期分隔純文字', version: exPkg.version }]);
    for (const [name, body, want7] of [
      ['write 丟錯', "() => { throw new Error('少了欄位'); }", '擴充「AI：匯出」出錯：少了欄位'],
      ['回的不是文字也不是位元組', '() => ({ a: 1 })', '擴充「AI：匯出」出錯：write 要回文字（字串）、Uint8Array 或 { sheets }（Excel），回的是 object'],
    ]) {
      const e = await out7(body);
      check('AI7 ' + name + ' → 不收、寫是哪個擴充', e.errors, [want7]);
    }
    fs.mkdirSync(path.join(aiRoot, 'ai-out'));
    const o5 = await ai.tryExport({ check: outGood, data: exData, list: [], extRoot: aiRoot, fork: forkHost, timeoutMs: 5000 });
    fs.rmSync(path.join(aiRoot, 'ai-out'), { recursive: true });
    ok('AI7 擴充資料夾已經有同名的資料夾（不是擴充）→ 不收', !!o5.errors && o5.errors[0].includes('「ai-out」這個資料夾'), JSON.stringify(o5));
    check('AI7 試跑用的暫存程式跑完就刪', tmpAi(), tmpBefore7);
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
    mkSkin('p-place', { background: { image: 'bg.png', position: 'bottom-right', size: 40 } });   // 位置、大小（D066）
    mkSkin('q-pos', { background: { image: 'bg.png', position: 'middle' } });
    mkSkin('r-size', { background: { image: 'bg.png', position: 'top', size: 0 } });
    // 背景圖好幾張（D067）：陣列、陣列裡第二張不對、空的陣列
    mkSkin('s-many', { background: [{ image: 'bg.png', opacity: 0.4, position: 'top-left', size: 20 }, { image: 'e.png' }] });
    mkSkin('t-manybad', { background: [{ image: 'bg.png' }, { image: 'bg.png', position: 'middle' }] });
    mkSkin('u-emptyarr', { background: [] });
    fs.writeFileSync(path.join(root, '不是資料夾.txt'), 'x');
    const s0 = skins.scan(root, appV, null);
    const st = (list, folder) => { const x = list.find(e => e.folder === folder); return x ? [x.state, x.reason] : null; };
    check('S1 照資料夾名稱排，檔案不算', s0.map(x => x.folder),
      ['a-both', 'b-bg', 'c-empty', 'd-new', 'e-nopkg', 'f-none', 'g-missing', 'h-outside', 'i-type', 'j-opacity', 'k-dup', 'l-noimage', 'm-dir', 'n-mime', 'p-place', 'q-pos', 'r-size',
        's-many', 't-manybad', 'u-emptyarr']);
    const a = s0[0];
    check('S1 兩種都有：未啟用；名稱、版本、有哪些、圖檔、opacity 照 package.json，沒寫位置是鋪滿；一張寫物件讀進來也是陣列',
      [a.state, a.reason, a.name, a.displayName, a.version, a.parts, a.background, a.empty],
      ['disabled', '', 'a-both', '兩種都有', '1.0.0', ['背景圖', '空白時的插圖'], [{ file: path.join(root, 'a-both', 'bg.png'), opacity: 0.3, position: 'cover', size: 30 }], { file: path.join(root, 'a-both', 'e.png') }]);
    check('S1 只有背景圖：opacity 沒寫用預設；只有插圖：沒有背景圖',
      [s0[1].state, s0[1].parts, s0[1].background[0].opacity, s0[1].empty, s0[2].state, s0[2].parts, s0[2].background],
      ['disabled', ['背景圖'], 0.12, null, 'disabled', ['空白時的插圖'], null]);
    const pp = s0.find(x => x.folder === 'p-place');
    check('S1 背景圖的位置、大小照 package.json（D066）', [pp.state, pp.background[0].position, pp.background[0].size], ['disabled', 'bottom-right', 40]);
    const sm = s0.find(x => x.folder === 's-many');
    check('S1 背景圖好幾張：照順序、各自的欄位、有哪些寫幾張（D067）', [sm.state, sm.parts, sm.background.map(b => [path.basename(b.file), b.opacity, b.position, b.size])],
      ['disabled', ['背景圖 2 張'], [['bg.png', 0.4, 'top-left', 20], ['e.png', 0.12, 'cover', 30]]]);
    ok('S1 版本不合：寫要哪一版、現在哪一版', st(s0, 'd-new')[0] === 'incompatible' && st(s0, 'd-new')[1].includes(appV), JSON.stringify(st(s0, 'd-new')));
    check('S1 壞掉的：每一種寫原因',
      ['e-nopkg', 'f-none', 'g-missing', 'h-outside', 'i-type', 'j-opacity', 'k-dup', 'l-noimage', 'm-dir', 'q-pos', 'r-size', 't-manybad', 'u-emptyarr'].map(f => st(s0, f)),
      [['broken', '沒有 package.json'], ['broken', 'package.json 的 contributes.skin 沒有 background 也沒有 empty'], ['broken', '找不到圖檔 nothere.png'],
        ['broken', '圖檔要放在外觀包的資料夾裡：../a-both/e.png'], ['broken', '圖檔要是 png、jpg、gif、webp、svg：e.bmp'],
        ['broken', 'contributes.skin.background.opacity 要是 0～1 之間的數字，例如 0.12'], ['broken', 'name 跟資料夾「a-both」的外觀包重複'],
        ['broken', 'contributes.skin.empty.image 要寫圖檔名稱'], ['broken', '找不到圖檔 sub.png'],
        ['broken', 'contributes.skin.background.position 要是 cover、top-left、top、top-right、left、center、right、bottom-left、bottom、bottom-right 其中一個'],
        ['broken', 'contributes.skin.background.size 要是 1～100 之間的數字（佔畫面寬幾 %），例如 30'],
        ['broken', 'contributes.skin.background[1].position 要是 cover、top-left、top、top-right、left、center、right、bottom-left、bottom、bottom-right 其中一個'],
        ['broken', 'contributes.skin.background 是空的陣列，至少要一張']]);
    const s1 = skins.scan(root, appV, 'c-empty');
    check('S1 啟用的那個：只有它是已啟用', s1.filter(x => x.state === 'enabled').map(x => x.folder), ['c-empty']);
    check('S1 啟用的那個壞掉了：照樣是壞掉、沒有已啟用的', skins.scan(root, appV, 'g-missing').filter(x => x.state === 'enabled').length, 0);
    check('S1 資料夾還沒有：空的', skins.scan(path.join(root, '沒有'), appV, null), []);
    const b64 = 'base64,' + PNG.toString('base64');
    check('S2 讀圖：data: 網址、opacity、位置、大小，背景圖是陣列；沒有的那種是 null', [skins.load(a), skins.load(s0[2]), skins.load(pp).background[0].position],
      [{ background: [{ url: 'data:image/png;' + b64, opacity: 0.3, position: 'cover', size: 30 }], empty: { url: 'data:image/png;' + b64 } },
        { background: null, empty: { url: 'data:image/png;' + b64 } }, 'bottom-right']);
    check('S2 背景圖好幾張：照順序一張一個（D067）', skins.load(sm).background.map(b => [b.opacity, b.position, b.size]), [[0.4, 'top-left', 20], [0.12, 'cover', 30]]);
    const n = skins.load(s0.find(x => x.folder === 'n-mime'));
    check('S2 照副檔名給類型（大寫也認得）', [n.background[0].url.slice(0, 22), n.empty.url.slice(0, 26)], ['data:image/jpeg;base64', 'data:image/svg+xml;base64,']);

    // S4：「用圖檔做一個」（D066）——選圖讀成 data: 網址；建一個新的外觀包，跟手寫的一樣讀得到
    const errOf = fn => { try { fn(); return null; } catch (e) { return e.message; } };
    const pngUrl = 'data:image/png;' + b64;
    check('S4 選圖：檔名、data: 網址；不是圖報錯', [skins.readImage(path.join(root, 'a-both', 'bg.png')), errOf(() => skins.readImage(path.join(root, 'a-both', 'package.json')))],
      [{ name: 'bg.png', url: pngUrl }, '圖檔要是 png、jpg、gif、webp、svg：package.json']);
    const mkRoot = tmpDir();
    const n1 = skins.create(mkRoot, appV, { displayName: '  我的:外觀?  ', background: [{ url: pngUrl, opacity: 0.5, position: 'bottom-right', size: 40 }],
      empty: { url: 'data:image/jpeg;' + b64 } });
    const k1 = skins.scan(mkRoot, appV, null).find(x => x.name === n1);
    const b1 = k1.background[0];
    check('S4 建出來的：資料夾名稱拿掉不能用的字、照手寫的規則讀得到、未啟用；欄位照給的；jpeg 存成 .jpg；一張寫成物件',
      [n1, k1.folder, k1.state, k1.displayName, b1.opacity, b1.position, b1.size, path.basename(b1.file), path.basename(k1.empty.file),
        Array.isArray(JSON.parse(fs.readFileSync(path.join(mkRoot, n1, 'package.json'), 'utf8')).contributes.skin.background)],
      ['我的外觀', '我的外觀', 'disabled', '我的:外觀?', 0.5, 'bottom-right', 40, 'background.png', 'empty.jpg', false]);
    check('S4 圖照原樣存（不重新編碼）', [fs.readFileSync(b1.file).equals(PNG), fs.readFileSync(k1.empty.file).equals(PNG)], [true, true]);
    const n2 = skins.create(mkRoot, appV, { displayName: '我的外觀', empty: { url: pngUrl } });
    const n3 = skins.create(mkRoot, appV, { displayName: '', background: [{ url: pngUrl, opacity: 0.12, position: 'cover', size: 30 }] });
    check('S4 同名接 (2)、(3)；沒填名稱是「我的外觀」；鋪滿不寫 size',
      [n2, n3, JSON.parse(fs.readFileSync(path.join(mkRoot, n3, 'package.json'), 'utf8')).contributes.skin],
      ['我的外觀 (2)', '我的外觀 (3)', { background: { image: 'background.png', opacity: 0.12, position: 'cover' } }]);
    // 背景圖好幾張（D067）：寫成陣列、圖存成 background.*、background-2.*，讀回來照順序
    const n5 = skins.create(mkRoot, appV, { displayName: '好幾張', background: [{ url: pngUrl, opacity: 0.3, position: 'top-left', size: 20 },
      { url: 'data:image/jpeg;' + b64, opacity: 0.6, position: 'cover', size: 30 }] });
    const k5 = skins.scan(mkRoot, appV, null).find(x => x.name === n5);
    check('S4 背景圖好幾張：寫成陣列、檔名接 -2、讀回來照順序',
      [JSON.parse(fs.readFileSync(path.join(mkRoot, n5, 'package.json'), 'utf8')).contributes.skin, k5.state, k5.parts, k5.background.map(b => path.basename(b.file))],
      [{ background: [{ image: 'background.png', opacity: 0.3, position: 'top-left', size: 20 }, { image: 'background-2.jpg', opacity: 0.6, position: 'cover' }] },
        'disabled', ['背景圖 2 張'], ['background.png', 'background-2.jpg']]);
    fs.mkdirSync(path.join(mkRoot, 'zz'));
    fs.writeFileSync(path.join(mkRoot, 'zz', 'package.json'), JSON.stringify({ name: '樹懶', version: '1.0.0', engines: { daybook: '^' + appV }, contributes: { skin: { empty: { image: 'e.png' } } } }));
    fs.writeFileSync(path.join(mkRoot, 'zz', 'e.png'), PNG);
    check('S4 別的外觀包的 name 跟它一樣（資料夾名稱不同）也接 (2)', skins.create(mkRoot, appV, { displayName: '樹懶', empty: { url: pngUrl } }), '樹懶 (2)');
    const before4 = fs.readdirSync(mkRoot).length;
    check('S4 不對的：沒選圖、不是認得的圖、不是 data: 網址、位置不對、opacity 不對；都不開資料夾',
      [errOf(() => skins.create(mkRoot, appV, { displayName: 'x' })),
        errOf(() => skins.create(mkRoot, appV, { displayName: 'x', empty: { url: 'data:image/bmp;' + b64 } })),
        errOf(() => skins.create(mkRoot, appV, { displayName: 'x', empty: { url: 'C:\\a.png' } })),
        errOf(() => skins.create(mkRoot, appV, { displayName: 'x', background: [{ url: pngUrl, opacity: 0.1, position: 'middle', size: 30 }] })),
        errOf(() => skins.create(mkRoot, appV, { displayName: 'x', background: [{ url: pngUrl, opacity: 0, position: 'cover', size: 30 }] })),
        errOf(() => skins.create(mkRoot, appV, { displayName: 'x', background: [{ url: pngUrl, opacity: 0.1, position: 'cover', size: 30 }, { url: pngUrl, opacity: 0.1, position: 'top', size: 0 }] })),
        errOf(() => skins.create(mkRoot, appV, { displayName: 'x', background: [] })),
        fs.readdirSync(mkRoot).length - before4],
      ['至少要選一張圖：背景圖或空白時的插圖', '圖檔要是 png、jpg、gif、webp、svg', '圖檔要是 png、jpg、gif、webp、svg',
        'contributes.skin.background.position 要是 cover、top-left、top、top-right、left、center、right、bottom-left、bottom、bottom-right 其中一個',
        'contributes.skin.background.opacity 要是 0～1 之間的數字，例如 0.12',
        'contributes.skin.background[1].size 要是 1～100 之間的數字（佔畫面寬幾 %），例如 30', '至少要選一張圖：背景圖或空白時的插圖', 0]);
  }
  /* 去背（見 開發筆記 D066）：純函式，給 canvas ImageData 那樣的 { data, width, height } */
  {
    const { cutout } = require(path.join(ROOT, 'src/renderer/cutout.js'));
    const mkImg = (w, h, fill) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < w * h; p++) data.set(fill(p % w, Math.floor(p / w)), p * 4);
      return { data, width: w, height: h };
    };
    const alpha = (im, x, y) => im.data[(y * im.width + x) * 4 + 3];
    const W = [255, 255, 255, 255], RED = [200, 0, 0, 255], PINK = [255, 200, 200, 255], BLUE = [0, 0, 255, 255];
    const inBox = (x, y, a, b) => x >= a && x <= b && y >= a && y <= b;
    // 7×7 白底、中間 3×3 紅色，紅色正中間一格白（被紅色圍住、不跟邊緣連著）
    const i1 = cutout(mkImg(7, 7, (x, y) => (x === 3 && y === 3 ? W : inBox(x, y, 2, 4) ? RED : W)), 40);
    check('T1 跟邊緣連著的白底變透明；紅色、被紅色圍住的白照留', [alpha(i1, 0, 0), alpha(i1, 6, 6), alpha(i1, 1, 3), alpha(i1, 2, 2), alpha(i1, 4, 4), alpha(i1, 3, 3)], [0, 0, 0, 255, 255, 255]);
    // 挨著底色、差一點點的變半透明（粉紅跟白差 55，tol 40：255×(55−40)/40 ≈ 96）
    const i2 = cutout(mkImg(5, 3, (x, y) => (y === 1 && x === 1 ? PINK : y === 1 && x > 1 && x < 4 ? RED : W)), 40);
    check('T1 挨著底色、差一點點的半透明；差很多的不動', [alpha(i2, 1, 1), alpha(i2, 2, 1), alpha(i2, 0, 1)], [96, 255, 0]);
    // 半透明的那圈不能變成通道：粉紅圍一圈，裡面的白不跟邊緣連著
    const i3 = cutout(mkImg(7, 7, (x, y) => (x === 3 && y === 3 ? W : inBox(x, y, 2, 4) ? PINK : W)), 40);
    check('T1 半透明的那圈不會讓外面的透明穿進去', [alpha(i3, 2, 2), alpha(i3, 3, 3)], [96, 255]);
    // 底色是邊緣最多的那個顏色：藍底、四個角是白的
    const corner = (x, y) => (x === 0 || x === 4) && (y === 0 || y === 4);
    const i4 = cutout(mkImg(5, 5, (x, y) => (corner(x, y) ? W : inBox(x, y, 2, 2) ? RED : BLUE)), 40);
    check('T1 底色是邊緣最多的顏色（藍）；角落的白不是底色', [alpha(i4, 1, 0), alpha(i4, 1, 1), alpha(i4, 0, 0), alpha(i4, 2, 2)], [0, 0, 255, 255]);
    // tol 0：只去掉一模一樣的顏色，也沒有半透明
    const i5 = cutout(mkImg(3, 1, x => (x === 1 ? [254, 255, 255, 255] : W)), 0);
    check('T1 tol 0：只去掉一模一樣的', [alpha(i5, 0, 0), alpha(i5, 1, 0), alpha(i5, 2, 0)], [0, 255, 0]);
    // 邊緣本來就透明：不動
    const i6 = cutout(mkImg(3, 3, (x, y) => (x === 1 && y === 1 ? W : [255, 255, 255, 0])), 40);
    check('T1 邊緣本來就都透明：不動', [alpha(i6, 0, 0), alpha(i6, 1, 1)], [0, 255]);
  }
  /* ---------- R1：拿舊記事本擴充（test 資料夾那份，見 開發筆記 D084）拆真的舊檔（只讀） ---------- */
  if (!fs.existsSync(REAL) || !fs.existsSync(REAL_EXT)) { console.log('R1 跳過：找不到 ' + (fs.existsSync(REAL) ? REAL_EXT : REAL)); return; }
  const text = fs.readFileSync(REAL, 'utf8');
  const srcLines = text.split(/\r?\n/);
  // 擴充照使用者裝的路走：先過「格式」頁貼上時的檢查，程式寫到暫存區再載入
  const extChk = require(path.join(ROOT, 'src/main/ai-ext.js')).checkReply(fs.readFileSync(REAL_EXT, 'utf8'), require(path.join(ROOT, 'package.json')).version);
  check('R0 舊記事本擴充：貼進「格式」頁的檢查會過', extChk.errors, []);
  const extFile = path.join(tmpDir(), 'index.js');
  fs.writeFileSync(extFile, extChk.code);
  const parsed = Object.values(require(extFile).formats)[0].parse(text);
  const days = parsed.days.map(d => ({ date: d.date, text: d.text, lines: d.text.replace(/\n$/, '').split('\n') }));
  // 檔尾有「週報」那行，擴充從那行起切成待處理（見 開發筆記 D019）
  const todo = parsed.todo ? parsed.todo.replace(/\n$/, '').split('\n') : [];
  if (todo.length) console.log(`R1 待辦區 ${todo.length} 行（從「週報」那行起）`);
  const dateLines = srcLines.filter(l => /^\d{1,2}\/\d{1,2}\s*$/.test(l)).length;
  check('R1 每日檔數＝原檔日期行數', days.length, dateLines);
  const keep = l => l.trim() !== '' && !/^\d{1,2}\/\d{1,2}\s*$/.test(l) && !/^-{3,}(\s*\d{4}\s*-{3,})?\s*$/.test(l);
  const want = srcLines.filter(keep);
  const got = days.flatMap(d => d.lines).concat(todo).filter(keep);
  const firstDiff = want.findIndex((l, i) => l !== got[i]);
  ok('R1 原檔每一行有字的內容都在、順序不變', want.length === got.length && firstDiff < 0,
    `原檔 ${want.length} 行、輸出 ${got.length} 行` + (firstDiff >= 0 ? `，第 ${firstDiff + 1} 行起不同：${want[firstDiff]}` : ''));
  check('R5 真檔拆出來的過得了 daybook 對擴充的檢查（日期、重複、換行），原樣不變', impUI.checkParsed(parsed), { days: parsed.days, todo: parsed.todo });
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
        report.push(`${d.date} 第 ${i + 1} 行起  ${j - i + 1} 行，${n > 1 ? '後 ' + n + ' 行共用內容' : '只有最後一行拿內容'}`);
        for (let k = i; k <= j; k++) report.push(`    ${k > j - n ? '拿' : '　'}  ${d.lines[k].trim()}`);
      }
      i = j;
    }
  }
  console.log(`R1 連續標題 ${shared + lastOnly} 組：共用內容 ${shared} 組、只有最後一行拿內容 ${lastOnly} 組`);

  /* R2：真資料的搜尋、時間軸量級（見 開發筆記 D023）——只印時間，筆數跟直接 parse 的算法對 */
  {
    const sources = days.map(d => ({ src: d.date, text: d.text })).concat([{ src: 'todo', text: todo.join('\n') + '\n' }]);
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
    const md = exp.toMarkdown({ title: 'T', days: days.map(d => ({ date: d.date, text: d.text })), todo: todo.join('\n') + '\n' });
    const msExp = Number(process.hrtime.bigint() - t0) / 1e6;
    const lines = md.split('\n');
    const all = sources.map(s => parseDay(s.text));
    check('R4 日期標題數＝有內容的日子數', lines.filter(l => l.startsWith('## ') && l !== '## 待處理').length, all.slice(0, -1).filter(es => es.length).length);
    check('R4 小標題數＝標題行數', lines.filter(l => l.startsWith('### ')).length, all.flat().reduce((n, e) => n + e.heads.length, 0));
    check('R4 清單項數＝內容行數', lines.filter(l => /^\s*- /.test(l)).length, all.flat().reduce((n, e) => n + e.body.length, 0));
    console.log(`R4 匯出全部 ${lines.length} 行、${(Buffer.byteLength(md) / 1024).toFixed(0)}KB，${msExp.toFixed(1)}ms`);

    /* R8：真資料匯出全部成 Excel（見 開發筆記 D078）——一筆一列，列數＝每天的筆數、待處理的筆數 */
    t0 = process.hrtime.bigint();
    const xd = fmts.exportData({ title: 'T', from: null, to: null, all: true, days: days.map(d => ({ date: d.date, text: d.text })), todo: todo.join('\n') + '\n' });
    const xb = Buffer.from(fmts.EXPORT_FORMATS.find(f => f.id === 'xlsx').write(xd));
    const msXl = Number(process.hrtime.bigint() - t0) / 1e6;
    const sheetData = xb.toString('utf8').split('<sheetData>').slice(1).map(s => s.split('</sheetData>')[0]);   // 照工作表順序（只存不壓縮，XML 原樣在 zip 裡）
    check('R8 兩張工作表；工作紀錄的列數＝每天的筆數、待處理的列數＝待處理的筆數（扣掉欄名那列）',
      sheetData.map(s => s.match(/<row /g).length - 1), [all.slice(0, -1).flat().length, all[all.length - 1].length]);
    console.log(`R8 匯出全部成 Excel ${(xb.length / 1024).toFixed(0)}KB，${msXl.toFixed(1)}ms`);

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
