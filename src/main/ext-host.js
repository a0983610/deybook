/* ============================================================
   外部擴充的程式在這個獨立程序跑（見 開發筆記 D055）：主程序用 Electron 的 utilityProcess 開，
   一次匯入（或匯出，D078）開一個、用完就關；擴充丟錯、卡住、自己結束都只影響這個程序。
   收：{ op: 'detect'|'parse'|'write', jobs: [{ id, file }], input }（detect、parse 的 input 是檔案文字，write 是 exportData 組的資料）
   回：{ running: 第幾個 }（開始跑哪一個，跑太久時主程序才知道是誰）；
       做完 { ok: true, value }（detect 是每一個認不認得、parse 是拆出來的結果、write 是匯出的內容）或 { ok: false, at: 第幾個, error }
   ============================================================ */
'use strict';
const xlsx = require('../shared/formats/xlsx.js');

/* utilityProcess 用 process.parentPort；parser 測試用 child_process.fork 開，走 process.send */
const port = process.parentPort || {
  on: (_, fn) => process.on('message', data => fn({ data })),
  postMessage: m => process.send(m),
};

/* 擴充的程式檔 module.exports = { formats: { 格式 id: { detect, parse, write } } }：匯入要 detect 和 parse，匯出要 write（D078） */
function load({ id, file }, op) {
  const mod = require(file);
  const f = mod && mod.formats && mod.formats[id];
  if (op === 'write') {
    if (!f || typeof f.write !== 'function') throw new Error(`程式檔沒有給格式「${id}」的 write`);
  } else if (!f || typeof f.detect !== 'function' || typeof f.parse !== 'function') {
    throw new Error(`程式檔沒有給格式「${id}」的 detect 和 parse`);
  }
  return f;
}

/* write 回的：文字照傳；位元組（Uint8Array、ArrayBuffer）轉成 base64 傳——parser 測試走 child_process，IPC 是 JSON，傳不了位元組；
   { sheets } 用內建的 Excel 組成 xlsx 的位元組（見 開發筆記 D086） */
function packed(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'sheets' in v) v = xlsx.fromSheets(v.sheets);
  if (v instanceof ArrayBuffer) v = new Uint8Array(v);
  if (v instanceof Uint8Array) return { bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  throw new Error(`write 要回文字（字串）、Uint8Array 或 { sheets }（Excel），回的是 ${v === null ? 'null' : Array.isArray(v) ? '陣列' : typeof v}`);
}

port.on('message', async ({ data: { op, jobs, input } }) => {
  let at = 0;
  try {
    const out = [];
    for (; at < jobs.length; at++) {
      port.postMessage({ running: at });
      const f = load(jobs[at], op);
      out.push(op === 'detect' ? !!(await f.detect(input)) : op === 'parse' ? await f.parse(input) : packed(await f.write(input)));
    }
    at = jobs.length - 1;
    port.postMessage({ ok: true, value: op === 'detect' ? out : out[0] });
  } catch (e) {
    port.postMessage({ ok: false, at, error: String((e && e.message) || e) });   // 回傳的東西傳不回去（例如裡面有函式）也走這裡
  }
});
