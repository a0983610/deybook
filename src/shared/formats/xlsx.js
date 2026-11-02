/* ============================================================
   內建匯出格式：Excel（.xlsx）（見 開發筆記 D078）
   不裝套件，自己組最小的 xlsx：一個 zip（只存、不壓縮）裡放幾個 XML。純函式、不碰檔案。
   - 工作表「工作紀錄」：一筆一列，日期｜星期｜標題｜內容｜狀態｜標記｜事件｜代號
   - 工作表「待處理」：匯出全部才有，標題｜內容｜狀態｜隱藏
   日期存成 Excel 的日期（篩選、排序照日期），顯示 2026-01-21；內容多行放同一格、自動換行；第一列凍結、可以篩選
   擴充的 write 回 { sheets } 也用這裡組檔（fromSheets，見 開發筆記 D086）：工作表、欄、每一格擴充自己排，樣式照內建
   ============================================================ */
'use strict';
const { ISO_DATE_RE } = require('../paths.js');
const { L, LK } = require('../i18n.js');

const enc = new TextEncoder();

/* ---------- zip：只存、不壓縮（method 0） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* files：[[路徑, 文字]]。檔案時間一律寫 1980-01-01：同樣的紀錄匯出來一個 byte 都不差（測試才比得了） */
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nm = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true);   // 本地檔頭
    loc.setUint16(4, 20, true);           // 解開要的版本 2.0
    loc.setUint16(6, 0x0800, true);       // 檔名是 UTF-8
    loc.setUint16(12, 0x21, true);        // 日期 1980-01-01（方法 0＝不壓縮、時間 0 都是預設的 0）
    loc.setUint32(14, crc, true);
    loc.setUint32(18, data.length, true);
    loc.setUint32(22, data.length, true);
    loc.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(loc.buffer), nm, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);    // 中央目錄
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nm.length, true);
    cd.setUint32(42, offset, true);       // 本地檔頭在哪
    central.push(new Uint8Array(cd.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, central.reduce((s, p) => s + p.length, 0), true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/* ---------- 工作表 ---------- */
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/* 第幾欄（0 起算）的字母：A…Z、AA…（擴充的欄數不固定，見 開發筆記 D086） */
const col = i => (i >= 26 ? col(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
const S_HEAD = 1, S_TEXT = 2, S_DATE = 3;   // styles.xml 的 cellXfs 第幾個

/* XML 1.0 不能有的控制字元拿掉（Excel 會說檔案壞了），& < > 跳脫 */
const esc = s => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* 工作表名稱：寫在 "…" 裡；篩選範圍的公式裡 ' 要寫兩次（擴充取的名稱可能有，D086） */
const escName = s => esc(s).replace(/"/g, '&quot;');
/* Excel 的日期是 1899-12-30 起算第幾天 */
const serial = date => {
  const [y, m, d] = date.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
};
const str = (ref, v, s) => `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
/* 一格：{ date } 是日期、數字是數字、其他是文字；空的不寫 */
function cell(ref, v) {
  if (v == null || v === '') return '';
  if (v.date) return `<c r="${ref}" s="${S_DATE}"><v>${serial(v.date)}</v></c>`;
  if (typeof v === 'number') return `<c r="${ref}" s="${S_TEXT}"><v>${v}</v></c>`;
  return str(ref, v, S_TEXT);
}

/* cols：[[欄名, 寬]]；rows：每列一個陣列，照 cols 的順序 */
function sheetXml(cols, rows) {
  const xmlRows = [`<row r="1">${cols.map(([n], i) => str(col(i) + 1, n, S_HEAD)).join('')}</row>`]
    .concat(rows.map((r, j) => `<row r="${j + 2}">${r.map((v, i) => cell(col(i) + (j + 2), v)).join('')}</row>`));
  return XML + `<worksheet xmlns="${NS}">`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${cols.map(([, w], i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${xmlRows.join('')}</sheetData>`
    + `<autoFilter ref="${filterRef(cols, rows)}"/>`
    + '</worksheet>';
}
const filterRef = (cols, rows) => `A1:${col(cols.length - 1)}${rows.length + 1}`;

const STYLES = XML + `<styleSheet xmlns="${NS}">`
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

// 不翻開始：匯出檔的內容（欄名、工作表名稱、格子裡的字）
const DONE_COLS = [['日期', 11], ['星期', 5], ['標題', 36], ['內容', 60], ['狀態', 8], ['標記', 10], ['事件', 6], ['代號', 16]];
const TODO_COLS = [['標題', 36], ['內容', 60], ['狀態', 8], ['隱藏', 6]];

/* 內容：一行一行接起來；更深一層的 Tab 換成兩個空白（Excel 的格子裡 Tab 看不出來） */
const bodyText = e => e.body.map(l => l.replace(/^\t+/, t => '  '.repeat(t.length))).join('\n');

function write(data) {
  const sheets = [{ name: '工作紀錄', columns: DONE_COLS, rows: data.days.flatMap(d => d.entries.map(e => [
    { date: d.date }, d.weekday, e.title, bodyText(e), e.status, e.flagged ? e.flagCat || '未分類' : '', e.event, e.codes.join('、'),
  ])) }];
  if (data.todo) sheets.push({ name: '待處理', columns: TODO_COLS, rows: data.todo.entries.map(e => [e.title, bodyText(e), e.status, e.hidden ? '是' : '']) });
  return build(sheets);
}
// 不翻結束

/* 擴充回的 sheets 先檢查（見 開發筆記 D086）：不合 Excel 規矩的（名稱重複、不能有的字、NaN、不存在的日期）組出來的檔可能打不開，
   cell 不認得的（true、{}）會悄悄變成字，都丟錯讓擴充改。一列可以比欄少（後面空著） */
const BAD_NAME_RE = /[\\/?*[\]:]/;
const realDate = s => {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const okCell = v => v == null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
  || (!!v && typeof v === 'object' && !Array.isArray(v) && realDate(v.date));
/* 錯誤訊息裡寫回的是什麼：NaN 用 JSON 會寫成 null，看不出錯在哪 */
const show = v => { try { return typeof v === 'object' || typeof v === 'string' ? JSON.stringify(v) : typeof v === 'function' ? L('函式') : String(v); } catch (e) { return typeof v; } };
/* 錯誤訊息開頭都是「sheets 」（整句一個 L()，D131） */
function checkSheets(sheets) {
  const bad = msg => { throw new Error(msg); };
  if (!Array.isArray(sheets) || !sheets.length) bad(L('sheets 要是陣列，至少一張工作表：[{ name, columns, rows }]'));
  const seen = new Set();
  sheets.forEach((s, i) => {
    const n = i + 1;
    if (!s || typeof s !== 'object') bad(L('sheets 第 {n} 張工作表要是 { name, columns, rows }', { n }));
    const { name, columns, rows } = s;
    if (typeof name !== 'string' || !name || name.length > 31 || BAD_NAME_RE.test(name) || /^'|'$/.test(name)) {
      bad(L('sheets 第 {n} 張工作表的 name {name} 不行：要 1～31 個字，不能有 \\ / ? * [ ] :，頭尾不能是 \'', { n, name: show(name) }));
    }
    if (seen.has(name.toLowerCase())) bad(L('sheets 第 {n} 張工作表的 name「{name}」跟前面重複（大小寫不同也算）', { n, name }));
    seen.add(name.toLowerCase());
    if (!Array.isArray(columns) || !columns.length
      || !columns.every(c => Array.isArray(c) && typeof c[0] === 'string' && typeof c[1] === 'number' && c[1] > 0 && c[1] <= 255)) {
      bad(L('sheets 工作表「{name}」的 columns 要是 [[欄名, 欄寬], …]，至少一欄；欄名是文字，欄寬是 1～255 的數字', { name }));
    }
    if (!Array.isArray(rows)) bad(L('sheets 工作表「{name}」的 rows 要是陣列（沒有資料就給 []）', { name }));
    rows.forEach((r, j) => {
      if (!Array.isArray(r) || r.length > columns.length) bad(L('sheets 工作表「{name}」rows 的第 {row} 列要是陣列，最多 {max} 格（跟 columns 一樣多）', { name, row: j + 1, max: columns.length }));
      r.forEach((v, k) => {
        if (!okCell(v)) bad(L('sheets 工作表「{name}」rows 的第 {row} 列第 {col} 格是 {value}：一格只能是文字、數字、{ date: "YYYY-MM-DD" }（要是真的日期）、null 或 ""', { name, row: j + 1, col: k + 1, value: show(v) }));
      });
    });
  });
}
function fromSheets(sheets) {
  checkSheets(sheets);
  return build(sheets);
}

/* sheets：[{ name, columns: [[欄名, 寬]], rows }] → xlsx 的位元組 */
function build(sheets) {
  const n = sheets.length;
  return zip([
    ['[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'],
    ['_rels/.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', XML + `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>`
      + sheets.map(({ name }, i) => `<sheet name="${escName(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets><definedNames>'   // 篩選的範圍：Excel 自己存的檔也會寫這個
      + sheets.map(({ name, columns, rows }, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escName(name.replace(/'/g, "''"))}'!${filterRef(columns, rows).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>`).join('')
      + '</definedNames></workbook>'],
    ['xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map(({ columns, rows }, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(columns, rows)]),
  ]);
}

module.exports = {
  id: 'xlsx',
  label: 'Excel',
  hint: LK('一筆一列；匯出全部時待處理另一張工作表'),   // 顯示時才 L()（D131）
  extension: 'xlsx',
  write,
  fromSheets,   // 擴充程序用（ext-host.js，D086）
};
